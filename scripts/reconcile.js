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

    console.log('\n' + '='.repeat(70));
    if (ok) {
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
    process.exitCode = ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch(e => die(`${e.name || 'Error'}: ${e.message}`));
