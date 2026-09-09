#!/usr/bin/env node
/**
 * Phase 5a — load a Salesforce export into Postgres.
 *
 * Validates before it writes, and by default only validates. The new schema
 * enforces things the org never did, so a first run is expected to surface real
 * problems in fifteen months of data rather than sail through: a shift with no
 * clock-out, a delivery with no date, a week that starts on the wrong day. Those
 * are findings, not obstacles, and each one is a number that was quietly wrong
 * in Salesforce.
 *
 * Nothing is repaired silently. Each repair is a flag you pass deliberately, and
 * the report says exactly how many rows it would touch.
 *
 * Usage:
 *   node scripts/import-export.js <export-dir>              # validate only
 *   node scripts/import-export.js <export-dir> --apply      # validate, then write
 *
 * Repairs, each opt-in:
 *   --infer-dates       fill a null income/expense date from its shift's date
 *   --close-abandoned   clock out every open shift but the most recent, at its
 *                       own clock-in — zero duration, which is what Salesforce
 *                       already reported for them
 *   --drop-uber-level   clear Uber_Level__c where Source is not an Uber variant
 *   --default-source=X  set Source on rows that have none. 'other' is already a
 *                       real value in the org, so it keeps the money rather than
 *                       dropping the row
 *
 * Needs DATABASE_URL. Import is idempotent on the Salesforce Id, so re-running
 * updates rather than duplicating.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const GIG_OBJECTS = ['Weekly_Cash_Flow__c', 'Daily_Cash_Flow__c', 'Income_Record__c', 'Expense_Record__c'];

// Deliberately not migrated. Job__c is a job-costing model for client work -
// quotes, service types, profit margins - with Income__c and Expense__c hanging
// off it. Different business; the export keeps them safe.
const OUT_OF_SCOPE = ['Job__c', 'Income__c', 'Expense__c', 'Shift__c'];

const SOURCES = new Set(['Uber', 'Uber Eats', 'Doordash', 'other']);
const UBER_SOURCES = new Set(['Uber', 'Uber Eats']);
const EXPENSE_TYPES = new Set(['Food', 'Charging', 'Toll', 'Tires', 'Maintenance', 'Other']);

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--'));
const flag = f => args.includes(`--${f}`);
const APPLY = flag('apply');
const INFER_DATES = flag('infer-dates');
const CLOSE_ABANDONED = flag('close-abandoned');
const DROP_UBER_LEVEL = flag('drop-uber-level');
const DEFAULT_SOURCE = (args.find(a => a.startsWith('--default-source=')) || '').split('=')[1] || null;

function die(msg) { console.error(`\n  ${msg}\n`); process.exit(1); }

function load(name) {
  const p = path.join(dir, `${name}.json`);
  if (!fs.existsSync(p)) die(`Missing ${name}.json in ${dir}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const str = v => (v === null || v === undefined || v === '' ? null : String(v));
/** Salesforce dates arrive as 'YYYY-MM-DD'; datetimes as ISO with an offset. */
const isMonday = d => new Date(`${d}T12:00:00Z`).getUTCDay() === 1;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(data) {
  const problems = [];
  const note = (severity, what, rows, repair) =>
    problems.push({ severity, what, rows, repair });

  const weeks = data.Weekly_Cash_Flow__c;
  const days = data.Daily_Cash_Flow__c;
  const income = data.Income_Record__c;
  const expense = data.Expense_Record__c;

  // --- weeks ---
  const badMonday = weeks.filter(w => w.Start_Date__c && !isMonday(w.Start_Date__c));
  if (badMonday.length) {
    note('blocking', 'weeks whose Start_Date__c is not a Monday', badMonday.map(w => w.Name),
         'no repair — the week boundary has to be decided by hand');
  }
  const noStart = weeks.filter(w => !w.Start_Date__c);
  if (noStart.length) note('blocking', 'weeks with no Start_Date__c', noStart.map(w => w.Name), 'no repair');

  // --- days ---
  const weekIds = new Set(weeks.map(w => w.Id));
  const orphanDays = days.filter(d => !d.Weekly_Cash_Flow__c || !weekIds.has(d.Weekly_Cash_Flow__c));
  if (orphanDays.length) {
    note('blocking', 'shifts with no week, or pointing at a week not in the export',
         orphanDays.map(d => d.Name), 'no repair — needs a week to belong to');
  }
  const noDate = days.filter(d => !d.Date__c);
  if (noDate.length) note('blocking', 'shifts with no Date__c', noDate.map(d => d.Name), 'no repair');

  const openShifts = days.filter(d => d.Clock_In__c && !d.Clock_Out__c);
  if (openShifts.length > 1) {
    note('repairable', 'shifts left open — the new schema allows only one at a time',
         openShifts.map(d => d.Name), '--close-abandoned');
  }
  // Strictly before, not before-or-equal: --close-abandoned deliberately closes
  // a never-ended shift at its own clock-in, and that zero-length result is
  // valid - it matches the schema's >= and Salesforce's Shift_Hours__c of 0.
  const outBeforeIn = days.filter(d => d.Clock_In__c && d.Clock_Out__c &&
                                       new Date(d.Clock_Out__c) < new Date(d.Clock_In__c));
  if (outBeforeIn.length) {
    note('blocking', 'shifts clocked out before they were clocked in', outBeforeIn.map(d => d.Name), 'no repair');
  }
  const outNoIn = days.filter(d => !d.Clock_In__c && d.Clock_Out__c);
  if (outNoIn.length) note('blocking', 'shifts with a clock-out but no clock-in', outNoIn.map(d => d.Name), 'no repair');

  // --- income ---
  // The vault records INC-1343 as having had a null Income_Date__c, so these are
  // expected to exist. A delivery with no date cannot be counted in any week.
  const noIncomeDate = income.filter(r => !r.Income_Date__c);
  if (noIncomeDate.length) {
    note('repairable', 'income records with no Income_Date__c', noIncomeDate.map(r => r.Name), '--infer-dates');
  }
  const noAmount = income.filter(r => r.Amount__c === null || r.Amount__c === undefined);
  if (noAmount.length) note('blocking', 'income records with no Amount__c', noAmount.map(r => r.Name), 'no repair');

  const badSource = income.filter(r => r.Source__c && !SOURCES.has(r.Source__c));
  if (badSource.length) {
    note('blocking', `income records whose Source__c is outside {${[...SOURCES].join(', ')}}`,
         [...new Set(badSource.map(r => r.Source__c))], 'no repair — decide whether to widen the CHECK');
  }
  const noSource = income.filter(r => !r.Source__c);
  if (noSource.length) {
    note('repairable', 'income records with no Source__c', noSource.map(r => r.Name),
         `--default-source=other`);
  }

  const strayLevel = income.filter(r => r.Uber_Level__c && !UBER_SOURCES.has(r.Source__c));
  if (strayLevel.length) {
    note('repairable', 'non-Uber income records carrying an Uber_Level__c',
         strayLevel.map(r => r.Name), '--drop-uber-level');
  }

  // --- expenses ---
  const noExpDate = expense.filter(r => !r.Expense_Date__c);
  if (noExpDate.length) {
    note('repairable', 'expense records with no Expense_Date__c', noExpDate.map(r => r.Name), '--infer-dates');
  }
  const noExpAmount = expense.filter(r => r.Amount__c === null || r.Amount__c === undefined);
  if (noExpAmount.length) note('blocking', 'expense records with no Amount__c', noExpAmount.map(r => r.Name), 'no repair');
  const badType = expense.filter(r => r.Type__c && !EXPENSE_TYPES.has(r.Type__c));
  if (badType.length) {
    note('blocking', `expense records whose Type__c is outside {${[...EXPENSE_TYPES].join(', ')}}`,
         [...new Set(badType.map(r => r.Type__c))], 'no repair — decide whether to widen the CHECK');
  }

  // Orphans are allowed: both lookups are nullable, as they were in Salesforce.
  const dayIds = new Set(days.map(d => d.Id));
  const unlinkedIncome = income.filter(r => !r.Daily_Cash_Flow__c || !dayIds.has(r.Daily_Cash_Flow__c));
  const unlinkedExpense = expense.filter(r => !r.Daily_Cash_Flow__c || !dayIds.has(r.Daily_Cash_Flow__c));

  return { problems, openShifts, unlinkedIncome, unlinkedExpense };
}

// ---------------------------------------------------------------------------
// Repairs — applied to the in-memory rows, never to the export files
// ---------------------------------------------------------------------------

function repair(data, openShifts) {
  const applied = [];
  const dayById = new Map(data.Daily_Cash_Flow__c.map(d => [d.Id, d]));

  if (INFER_DATES) {
    let n = 0;
    for (const r of data.Income_Record__c) {
      if (!r.Income_Date__c) {
        const day = dayById.get(r.Daily_Cash_Flow__c);
        if (day?.Date__c) { r.Income_Date__c = day.Date__c; n++; }
      }
    }
    for (const r of data.Expense_Record__c) {
      if (!r.Expense_Date__c) {
        const day = dayById.get(r.Daily_Cash_Flow__c);
        if (day?.Date__c) { r.Expense_Date__c = day.Date__c; n++; }
      }
    }
    applied.push(`--infer-dates: filled ${n} date(s) from the parent shift`);
  }

  if (CLOSE_ABANDONED && openShifts.length > 1) {
    // Keep the newest open, close the rest at their own clock-in.
    //
    // Deliberately not guessed from the last child record's timestamp. Doing
    // that would invent a duration Salesforce never had, and Shift_Hours__c -
    // IF(NOT(ISBLANK(Clock_Out__c)), ..., 0) - reads 0 for every one of these
    // today. Every figure derived from it would then disagree at reconciliation
    // for a reason that is my repair rather than a porting error.
    //
    // A zero-length shift says exactly what is true: it was never clocked out,
    // and no duration was ever measured.
    const sorted = [...openShifts].sort((a, b) => new Date(b.Clock_In__c) - new Date(a.Clock_In__c));
    const toClose = sorted.slice(1);
    for (const d of toClose) d.Clock_Out__c = d.Clock_In__c;
    applied.push(
      `--close-abandoned: closed ${toClose.length} shift(s) at their clock-in ` +
      `(zero duration, matching Salesforce's Shift_Hours__c of 0), left ${sorted[0].Name} open`
    );
    // Say what that costs, not just what was done. These shifts earned money
    // across no recorded hours, so their income counts toward the weekly
    // $/shift-hour while their hours do not, and that rate reads high until a
    // real clock-out is entered. Salesforce has exactly the same problem today;
    // the difference is that this says so.
    const earners = toClose.filter(d => d.Name);
    if (earners.length) {
      applied.push(
        `  note: those ${earners.length} shift(s) — ${earners.map(d => d.Name).join(', ')} — ` +
        'have no measured hours, so any week containing one reports $/shift-hour ' +
        'higher than it really was. They are flagged "no hours" on the Shifts ' +
        'tab; entering the real clock-out corrects the week.'
      );
    }
  }

  if (DEFAULT_SOURCE) {
    if (!SOURCES.has(DEFAULT_SOURCE)) {
      fail(`--default-source must be one of: ${[...SOURCES].join(', ')}`);
    }
    let n = 0;
    for (const r of data.Income_Record__c) {
      if (!r.Source__c) { r.Source__c = DEFAULT_SOURCE; n++; }
    }
    applied.push(`--default-source=${DEFAULT_SOURCE}: set on ${n} record(s)`);
  }

  if (DROP_UBER_LEVEL) {
    let n = 0;
    for (const r of data.Income_Record__c) {
      if (r.Uber_Level__c && !UBER_SOURCES.has(r.Source__c)) { r.Uber_Level__c = null; n++; }
    }
    applied.push(`--drop-uber-level: cleared ${n} stray Uber level(s)`);
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/** Insert in chunks; a 1500-row multi-values statement is well within limits. */
async function insertRows(client, table, columns, rows, chunk = 500) {
  let written = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values = [];
    const tuples = slice.map((r, n) => {
      const base = n * columns.length;
      values.push(...r);
      return `(${columns.map((_, c) => `$${base + c + 1}`).join(', ')})`;
    });
    const updates = columns.filter(c => c !== 'sf_id').map(c => `${c} = excluded.${c}`).join(', ');
    const { rowCount } = await client.query(
      `insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')}
       on conflict (sf_id) do update set ${updates}`,
      values
    );
    written += rowCount;
  }
  return written;
}

async function importAll(pool, data) {
  const client = await pool.connect();
  const counts = {};
  try {
    await client.query('begin');

    // --- weeks ---
    await insertRows(client, 'weekly_cash_flow', ['sf_id', 'record_no', 'start_date'],
      data.Weekly_Cash_Flow__c.map(w => [w.Id, w.Name, w.Start_Date__c]));
    const weekMap = new Map((await client.query('select id, sf_id from weekly_cash_flow where sf_id is not null'))
      .rows.map(r => [r.sf_id, r.id]));
    counts.weekly_cash_flow = data.Weekly_Cash_Flow__c.length;

    // --- shifts ---
    // An imported shift with neither a clock-in nor a clock-out was never a day
    // worked - it is the container the bulk history was hung on, the way
    // DCF-0000 holds 18 months of backfilled earnings under one April date.
    // Flagged here rather than derived by the database, because a shift typed
    // in by hand with the times left blank is a different thing: that one is a
    // day Patrick means to fill in, and it stays visible.
    await insertRows(client, 'daily_cash_flow',
      ['sf_id', 'record_no', 'weekly_cash_flow_id', 'shift_date', 'clock_in', 'clock_out',
       'total_shift_miles', 'doordash_dash_time_hours', 'is_placeholder'],
      data.Daily_Cash_Flow__c.map(d => [
        d.Id, d.Name, weekMap.get(d.Weekly_Cash_Flow__c), d.Date__c,
        d.Clock_In__c || null, d.Clock_Out__c || null,
        num(d.Total_Shift_Miles__c) ?? 0, num(d.Doordash_Dash_Time__c) ?? 0,
        !d.Clock_In__c && !d.Clock_Out__c
      ]));
    const dayMap = new Map((await client.query('select id, sf_id from daily_cash_flow where sf_id is not null'))
      .rows.map(r => [r.sf_id, r.id]));
    counts.daily_cash_flow = data.Daily_Cash_Flow__c.length;

    // --- income ---
    // Time_Taken__c goes across unchanged: it always held minutes, whatever its
    // label said, so converting here would silently multiply every duration.
    await insertRows(client, 'income_record',
      ['sf_id', 'record_no', 'daily_cash_flow_id', 'income_date', 'source', 'store',
       'amount', 'tips', 'surge_bonus', 'uber_level', 'miles_driven', 'total_miles',
       'time_taken_minutes', 'notes'],
      data.Income_Record__c.map(r => [
        r.Id, r.Name, dayMap.get(r.Daily_Cash_Flow__c) ?? null, r.Income_Date__c,
        str(r.Source__c), str(r.Store__c), num(r.Amount__c), num(r.Tips__c),
        num(r.Surge_Bonus__c), str(r.Uber_Level__c), num(r.Miles_Driven__c),
        num(r.Total_Miles__c), num(r.Time_Taken__c), str(r.Notes__c)
      ]));
    counts.income_record = data.Income_Record__c.length;

    // --- expenses ---
    await insertRows(client, 'expense_record',
      ['sf_id', 'record_no', 'daily_cash_flow_id', 'expense_date', 'amount', 'type',
       'type_explanation', 'store', 'store_street', 'store_city', 'store_state',
       'store_postal_code', 'store_country', 'store_address_latitude',
       'store_address_longitude', 'store_address_geocode_accuracy',
       'location_latitude', 'location_longitude'],
      data.Expense_Record__c.map(r => [
        r.Id, r.Name, dayMap.get(r.Daily_Cash_Flow__c) ?? null, r.Expense_Date__c,
        num(r.Amount__c), str(r.Type__c), str(r.Type_Explanation__c), str(r.Store__c),
        str(r.Store_Address__Street__s), str(r.Store_Address__City__s),
        str(r.Store_Address__StateCode__s), str(r.Store_Address__PostalCode__s),
        str(r.Store_Address__CountryCode__s), num(r.Store_Address__Latitude__s),
        num(r.Store_Address__Longitude__s), str(r.Store_Address__GeocodeAccuracy__s),
        num(r.Location__Latitude__s), num(r.Location__Longitude__s)
      ]));
    counts.expense_record = data.Expense_Record__c.length;

    // Move each sequence past the highest imported number, so new records carry
    // on from where Salesforce left off instead of colliding with history.
    for (const [table, seq] of [
      ['weekly_cash_flow', 'weekly_cash_flow_no_seq'],
      ['daily_cash_flow', 'daily_cash_flow_no_seq'],
      ['income_record', 'income_record_no_seq'],
      ['expense_record', 'expense_record_no_seq']
    ]) {
      await client.query(
        `select setval($1, greatest(coalesce(max(nullif(regexp_replace(record_no, '\\D', '', 'g'), ''))::bigint, 0), 1))
           from ${table}`,
        [seq]
      );
    }

    await client.query('commit');
    return counts;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  if (!dir) die('Usage: node scripts/import-export.js <export-dir> [--apply]');
  if (!fs.existsSync(dir)) die(`No such directory: ${dir}`);
  if (APPLY && !process.env.DATABASE_URL) die('DATABASE_URL must be set to --apply.');

  const manifest = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifest)) {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    console.log(`Export from ${m.org?.username} taken ${m.exportedAt}`);
    if (m.complete === false) die('That export is marked INCOMPLETE. Re-run the export before importing it.');
  }

  const data = Object.fromEntries(GIG_OBJECTS.map(o => [o, load(o)]));
  console.log('\nIn scope:');
  for (const o of GIG_OBJECTS) console.log(`  ${o.padEnd(22)} ${String(data[o].length).padStart(5)} record(s)`);
  console.log(`\nSkipping: ${OUT_OF_SCOPE.join(', ')}`);

  const { problems, openShifts, unlinkedIncome, unlinkedExpense } = validate(data);

  if (unlinkedIncome.length || unlinkedExpense.length) {
    console.log(`\nNot linked to a shift (allowed, and preserved):`);
    console.log(`  ${unlinkedIncome.length} income, ${unlinkedExpense.length} expense`);
    console.log('  These are invisible to the weekly rollup but counted by v_income_by_week.');
  }

  if (problems.length) {
    console.log('\n' + '-'.repeat(70));
    console.log('PROBLEMS');
    console.log('-'.repeat(70));
    for (const p of problems) {
      const shown = p.rows.slice(0, 8).join(', ');
      const more = p.rows.length > 8 ? `, +${p.rows.length - 8} more` : '';
      console.log(`\n  [${p.severity}] ${p.rows.length} ${p.what}`);
      console.log(`      ${shown}${more}`);
      console.log(`      fix: ${p.repair}`);
    }
  } else {
    console.log('\nNo problems found.');
  }

  const applied = repair(data, openShifts);
  if (applied.length) {
    console.log('\nRepairs applied to this run (the export files are not modified):');
    for (const a of applied) console.log(`  ${a}`);
  }

  const stillBlocking = validate(data).problems.filter(p => p.severity === 'blocking' ||
    (p.severity === 'repairable' && !applied.some(a => a.startsWith(p.repair))));

  if (!APPLY) {
    console.log('\nDry run — nothing written. Add --apply to load it.');
    if (stillBlocking.length) console.log('Resolve the problems above first, or pass the repair flags they name.');
    return;
  }

  if (stillBlocking.length) {
    die(`${stillBlocking.length} unresolved problem(s). Nothing was written.\n` +
        '  Pass the repair flags named above, or fix the data in Salesforce and re-export.');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const counts = await importAll(pool, data);
    console.log('\nImported:');
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(20)} ${String(n).padStart(5)}`);
    console.log('\nRe-runnable: rows are keyed on the Salesforce Id, so a second run updates rather than duplicates.');
    console.log('Next: node scripts/reconcile.js ' + dir);
  } finally {
    await pool.end();
  }
}

main().catch(e => die(`${e.name || 'Error'}: ${e.message}`));
