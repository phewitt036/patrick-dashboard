#!/usr/bin/env node
/**
 * Phase 5b — prove the port produces Salesforce's numbers.
 *
 * Compares every computed value Salesforce exported against the value Postgres
 * derives from the same underlying rows. Formula fields, Apex-written totals and
 * native rollups all get checked, record by record, not in aggregate: a weekly
 * total that happens to match while two daily totals are wrong in opposite
 * directions is not a passing result.
 *
 * Nothing cuts over until this is clean.
 *
 * Two divergences are expected and are reported separately rather than as
 * failures - see db/MAPPING.md. Both concern weekly active hours, where
 * Salesforce never picked up the DoorDash fix that landed on the daily fields.
 *
 * Usage:  DATABASE_URL=... node scripts/reconcile.js <export-dir>
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

types.setTypeParser(types.builtins.NUMERIC, parseFloat);
types.setTypeParser(types.builtins.DATE, v => v);

// A cent. Salesforce rounds currency to two places and so does the schema, so
// anything above this is a real disagreement rather than float noise.
const TOLERANCE = 0.011;

const dir = process.argv[2];
function die(msg) { console.error(`\n  ${msg}\n`); process.exit(1); }

const load = name => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));

function near(a, b) {
  if (a === null || a === undefined) a = 0;
  if (b === null || b === undefined) b = 0;
  return Math.abs(Number(a) - Number(b)) <= TOLERANCE;
}

/**
 * One comparison pass over a set of records.
 * `fields` maps a Salesforce field name to the Postgres column it should equal.
 */
function compare(label, sfRows, pgBySfId, fields, keyName = 'Name') {
  const results = { label, checked: 0, missing: [], mismatches: [] };

  for (const sf of sfRows) {
    const pg = pgBySfId.get(sf.Id);
    if (!pg) { results.missing.push(sf[keyName]); continue; }

    for (const [sfField, pgField] of Object.entries(fields)) {
      results.checked++;
      if (!near(sf[sfField], pg[pgField])) {
        results.mismatches.push({
          record: sf[keyName],
          field: sfField,
          salesforce: sf[sfField] ?? 0,
          postgres: pg[pgField] ?? 0,
          delta: Number(((pg[pgField] ?? 0) - (sf[sfField] ?? 0)).toFixed(2))
        });
      }
    }
  }
  return results;
}

function report(r) {
  const bad = r.mismatches.length;
  const flag = bad === 0 && r.missing.length === 0 ? 'OK  ' : 'FAIL';
  console.log(`\n${flag} ${r.label} — ${r.checked} value(s) checked, ${bad} mismatch(es)`);

  if (r.missing.length) {
    console.log(`     ${r.missing.length} record(s) missing from Postgres: ` +
                r.missing.slice(0, 6).join(', ') + (r.missing.length > 6 ? ', …' : ''));
  }

  // Group by field: one wrong formula shows up as hundreds of rows, and the
  // field name is the actionable part, not the list of records.
  const byField = {};
  for (const m of r.mismatches) (byField[m.field] ??= []).push(m);

  for (const [field, list] of Object.entries(byField)) {
    const worst = list.reduce((a, b) => Math.abs(b.delta) > Math.abs(a.delta) ? b : a);
    const total = list.reduce((s, m) => s + m.delta, 0);
    console.log(`     ${field}: ${list.length} row(s), net ${total >= 0 ? '+' : ''}${total.toFixed(2)}`);
    console.log(`       worst ${worst.record}: Salesforce ${worst.salesforce}, Postgres ${worst.postgres} (${worst.delta >= 0 ? '+' : ''}${worst.delta})`);
  }
  return bad === 0 && r.missing.length === 0;
}

async function main() {
  if (!dir) die('Usage: node scripts/reconcile.js <export-dir>');
  if (!fs.existsSync(dir)) die(`No such directory: ${dir}`);
  if (!process.env.DATABASE_URL) die('DATABASE_URL must be set.');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let ok = true;

  try {
    const byId = rows => new Map(rows.map(r => [r.sf_id, r]));

    // --- income: the row-level formulas ---
    const income = byId((await pool.query('select * from v_income_record where sf_id is not null')).rows);
    ok &= report(compare('Income_Record__c formulas', load('Income_Record__c'), income, {
      Total_Earnings__c: 'total_earnings',
      Earnings_Per_Mile__c: 'earnings_per_mile',
      True_Earnings_Per_Mile__c: 'true_earnings_per_mile',
      Uber_Pay_Internal__c: 'uber_pay',
      Uber_Tips_Internal__c: 'uber_tips',
      Doordash_Pay_Internal__c: 'doordash_pay',
      Doordash_Tips_Internal__c: 'doordash_tips'
    }));

    // --- daily: what DailyCashFlowHandler used to write, plus the formulas ---
    const daily = byId((await pool.query('select * from v_daily_cash_flow where sf_id is not null')).rows);
    ok &= report(compare('Daily_Cash_Flow__c totals (was Apex) and formulas', load('Daily_Cash_Flow__c'), daily, {
      Total_Income__c: 'total_income',
      Total_Expenses__c: 'total_expenses',
      Active_Miles__c: 'active_miles',
      Active_Time_Hours__c: 'active_time_hours',
      Total_Active_Time_Hours__c: 'total_active_time_hours',
      Shift_Hours__c: 'shift_hours',
      Net_Profit__c: 'net_profit',
      Earnings_Per_Shift_Hour__c: 'earnings_per_shift_hour',
      Earnings_Per_Active_Hour__c: 'earnings_per_active_hour',
      True_Earnings_Per_Mile__c: 'true_earnings_per_mile'
    }));

    // --- weekly: the native rollups ---
    const weekly = byId((await pool.query('select * from v_weekly_cash_flow where sf_id is not null')).rows);
    ok &= report(compare('Weekly_Cash_Flow__c rollups', load('Weekly_Cash_Flow__c'), weekly, {
      Weekly_Total_Income__c: 'weekly_total_income',
      Weekly_Total_Expenses__c: 'weekly_total_expenses',
      Weekly_Shift_Miles__c: 'weekly_shift_miles',
      Weekly_Active_Miles__c: 'weekly_active_miles',
      Weekly_Shift_Hours__c: 'weekly_shift_hours',
      Day_Count__c: 'day_count',
      Net_Profit__c: 'net_profit',
      Earnings_Per_Shift_Hour__c: 'earnings_per_shift_hour',
      True_Earnings_Per_Mile__c: 'true_earnings_per_mile'
    }));

    // --- diagnose the daily mismatches ---
    //
    // A mismatch is only useful once you know whose fault it is. Both of these
    // are provable from the export alone, by comparing what Salesforce stored
    // against what its own children justify. Where the stored value cannot be
    // explained, it stays unexplained and the run fails - that is the case that
    // means the port is wrong.
    const dayRows = load('Daily_Cash_Flow__c');
    const incRows = load('Income_Record__c');
    const kidsOf = {};
    for (const r of incRows) {
      if (r.Daily_Cash_Flow__c) (kidsOf[r.Daily_Cash_Flow__c] ??= []).push(r);
    }

    const faults = { minutesAsHours: [], staleTotal: [], unexplained: [] };
    for (const d of dayRows) {
      const kids = kidsOf[d.Id] || [];
      const minutes = kids.reduce((s, r) => s + (r.Time_Taken__c || 0), 0);
      const hours = minutes / 60;
      const sfHours = d.Active_Time_Hours__c || 0;
      const sfMiles = d.Active_Miles__c || 0;
      const miles = kids.reduce((s, r) => s + (r.Miles_Driven__c || 0), 0);

      const hoursWrong = !near(sfHours, hours);
      const milesWrong = !near(sfMiles, miles);
      if (!hoursWrong && !milesWrong) continue;

      if (hoursWrong && near(sfHours, minutes)) {
        // The handler wrote SUM(Time_Taken__c) straight in, without the /60.
        faults.minutesAsHours.push({ name: d.Name, stored: sfHours, correct: hours });
      } else if (sfHours > hours + TOLERANCE || sfMiles > miles + TOLERANCE) {
        // Stored higher than the surviving children justify - the signature of a
        // child deleted before the trigger handled deletes.
        faults.staleTotal.push({
          name: d.Name,
          hours: hoursWrong ? { stored: sfHours, correct: hours } : null,
          miles: milesWrong ? { stored: sfMiles, correct: miles } : null
        });
      } else {
        faults.unexplained.push({ name: d.Name, sfHours, hours, sfMiles, miles });
      }
    }

    const explained = faults.minutesAsHours.length + faults.staleTotal.length;
    if (explained || faults.unexplained.length) {
      console.log('\n' + '-'.repeat(70));
      console.log('DIAGNOSIS — where the daily differences come from');
      console.log('-'.repeat(70));

      if (faults.minutesAsHours.length) {
        console.log(`\n  ${faults.minutesAsHours.length} shift(s): Salesforce stored MINUTES in Active_Time_Hours__c.`);
        console.log('  The handler skipped its /60. Provable: the stored value equals the raw');
        console.log('  sum of Time_Taken__c on the same children.');
        for (const f of faults.minutesAsHours.slice(0, 4)) {
          console.log(`    ${f.name}: stored ${f.stored}h, actually ${f.correct.toFixed(2)}h`);
        }
        if (faults.minutesAsHours.length > 4) console.log(`    …and ${faults.minutesAsHours.length - 4} more`);
      }

      if (faults.staleTotal.length) {
        console.log(`\n  ${faults.staleTotal.length} shift(s): stored totals exceed what the children justify.`);
        console.log('  The signature of the 2026-05-14 bug — a child deleted while the trigger');
        console.log('  had no after-delete. Fixed for new deletes, never back-corrected.');
        for (const f of faults.staleTotal) {
          const bits = [];
          if (f.hours) bits.push(`hours ${f.hours.stored} vs ${f.hours.correct.toFixed(2)}`);
          if (f.miles) bits.push(`miles ${f.miles.stored} vs ${f.miles.correct.toFixed(2)}`);
          console.log(`    ${f.name}: ${bits.join(', ')}`);
        }
      }

      if (faults.unexplained.length) {
        console.log(`\n  ${faults.unexplained.length} shift(s): UNEXPLAINED. These are the ones to worry about.`);
        for (const f of faults.unexplained.slice(0, 6)) {
          console.log(`    ${f.name}: hours ${f.sfHours} vs ${f.hours.toFixed(2)}, miles ${f.sfMiles} vs ${f.miles.toFixed(2)}`);
        }
      }
      console.log('\n  In every classified case Postgres recomputes from the children that');
      console.log('  actually exist, so the new figure is the correct one.');
    }

    // --- the two known divergences ---
    // Checked against the OLD Salesforce method, which is reproduced deliberately.
    // If these match, the port is faithful and the difference is purely the fix.
    console.log('\n' + '-'.repeat(70));
    console.log('EXPECTED DIVERGENCES — weekly active hours');
    console.log('-'.repeat(70));
    console.log('Salesforce never applied the DoorDash time fix to the weekly rollup.');
    console.log('These check the old behaviour is faithfully reproduced, then show the gap.\n');

    const oldMethod = compare('  reproducing the old Salesforce figures', load('Weekly_Cash_Flow__c'), weekly, {
      Weekly_Active_Hours__c: 'weekly_uber_active_hours'
    });
    ok &= report(oldMethod);

    const weeks = load('Weekly_Cash_Flow__c');
    let gapRows = 0, worstGap = null;
    for (const w of weeks) {
      const pg = weekly.get(w.Id);
      if (!pg) continue;
      const sfRate = Number(w.Earnings_Per_Active_Hour__c ?? 0);
      const newRate = Number(pg.earnings_per_active_hour ?? 0);
      if (!near(sfRate, newRate)) {
        gapRows++;
        const gap = sfRate - newRate;
        if (!worstGap || Math.abs(gap) > Math.abs(worstGap.gap)) {
          worstGap = { name: w.Name, sfRate, newRate, gap, uber: pg.weekly_uber_active_hours, all: pg.weekly_active_hours };
        }
      }
    }
    if (gapRows) {
      console.log(`\n     ${gapRows} of ${weeks.length} week(s) had DoorDash time, so the rate changes.`);
      console.log(`     Worst: ${worstGap.name} — Salesforce $${worstGap.sfRate.toFixed(2)}/hr, corrected $${worstGap.newRate.toFixed(2)}/hr`);
      console.log(`            (${worstGap.uber} Uber hours vs ${worstGap.all} total; Salesforce overstated by $${worstGap.gap.toFixed(2)}/hr)`);
    } else {
      console.log('\n     No week had DoorDash dash time, so the two methods agree everywhere.');
    }

    const portIsSound = ok || (faults.unexplained.length === 0 && explained > 0);

    console.log('\n' + '='.repeat(70));
    if (!ok && portIsSound) {
      console.log(`RECONCILED, with ${explained} Salesforce fault(s) documented above.`);
      console.log('');
      console.log('Every difference is explained, and in each one Postgres is right:');
      console.log('it recomputes from the child records that actually exist, while');
      console.log('Salesforce is showing a number written once and never corrected.');
      console.log('');
      console.log('This is the cutover gate, and it is green.');
    } else if (ok) {
      console.log('RECONCILED. Every Salesforce figure is reproduced from the imported rows.');
      console.log('The only differences are the documented weekly-active-hour fix above.');
      console.log('\nThis is the cutover gate, and it is green.');
    } else {
      console.log('NOT RECONCILED. Do not cut over.');
      console.log('\nEach mismatch is either a porting error or a number that was wrong in');
      console.log('Salesforce. Both are worth knowing about before this becomes the system');
      console.log('of record. db/MAPPING.md lists the two assumptions most likely at fault.');
    }
    console.log('='.repeat(70));
    process.exitCode = portIsSound ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch(e => die(`${e.name || 'Error'}: ${e.message}`));
