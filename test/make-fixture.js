// Build a Salesforce export in the exact shape of the real 2026-09-08 one,
// with Salesforce's own derived values computed the way its formulas do, so a
// faithful port must reconcile to zero.
//
// Deliberately seeded with the three problems the importer has to catch:
// a null Income_Date__c, two shifts left open, and an Uber level on a DoorDash row.

const fs = require('fs');
const path = require('path');
const out = process.argv[2];
if (!out) {
  console.error('\n  usage: node test/make-fixture.js <output-dir>\n\n' +
                '  Writes a synthetic Salesforce export there. Then:\n' +
                '    node scripts/import-export.js <output-dir> --close-abandoned --infer-dates --drop-uber-level --apply\n' +
                '    node scripts/reconcile.js <output-dir>\n');
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

const r2 = n => Math.round(n * 100) / 100;
const sfId = (p, n) => `${p}${String(n).padStart(15, '0')}`;

// --- weeks (Mondays) ---
const weeks = [
  { Id: sfId('a01', 1), Name: 'WCF-0001', Start_Date__c: '2026-08-03' },
  { Id: sfId('a01', 2), Name: 'WCF-0002', Start_Date__c: '2026-08-10' }
];

// --- shifts ---
const days = [
  { Id: sfId('a02', 1), Name: 'DCF-0001', w: 0, Date__c: '2026-08-04',
    Clock_In__c: '2026-08-04T14:00:00.000+0000', Clock_Out__c: '2026-08-04T20:00:00.000+0000',
    Total_Shift_Miles__c: 95.5, Doordash_Dash_Time__c: 1.28 },
  { Id: sfId('a02', 2), Name: 'DCF-0002', w: 0, Date__c: '2026-08-05',
    Clock_In__c: '2026-08-05T16:00:00.000+0000', Clock_Out__c: '2026-08-05T21:30:00.000+0000',
    Total_Shift_Miles__c: 60.0, Doordash_Dash_Time__c: 0 },
  // never clocked out
  { Id: sfId('a02', 3), Name: 'DCF-0003', w: 1, Date__c: '2026-08-11',
    Clock_In__c: '2026-08-11T15:00:00.000+0000', Clock_Out__c: null,
    Total_Shift_Miles__c: 30.0, Doordash_Dash_Time__c: 2.0 },
  // also never clocked out - only one may stay open
  { Id: sfId('a02', 4), Name: 'DCF-0004', w: 1, Date__c: '2026-08-12',
    Clock_In__c: '2026-08-12T15:00:00.000+0000', Clock_Out__c: null,
    Total_Shift_Miles__c: 12.0, Doordash_Dash_Time__c: 0 }
];

// --- income ---
const rawIncome = [
  { d: 0, Source__c: 'Uber Eats', Amount__c: 8.50,  Tips__c: 4.00, Surge_Bonus__c: 1.50, Miles_Driven__c: 6.2,  Total_Miles__c: 9.1,  Time_Taken__c: 24, Uber_Level__c: 'UberX', Store__c: 'Chipotle' },
  { d: 0, Source__c: 'Uber',      Amount__c: 12.75, Tips__c: 6.25, Surge_Bonus__c: null, Miles_Driven__c: 9.4,  Total_Miles__c: 13.0, Time_Taken__c: 36, Uber_Level__c: 'UberX', Store__c: null },
  { d: 0, Source__c: 'Doordash',  Amount__c: 7.25,  Tips__c: 3.50, Surge_Bonus__c: null, Miles_Driven__c: 5.0,  Total_Miles__c: 7.5,  Time_Taken__c: null, Uber_Level__c: null, Store__c: 'Wendys' },
  // stray Uber level on a DoorDash row
  { d: 1, Source__c: 'Doordash',  Amount__c: 9.00,  Tips__c: 5.00, Surge_Bonus__c: null, Miles_Driven__c: 7.0,  Total_Miles__c: 10.2, Time_Taken__c: null, Uber_Level__c: 'UberX', Store__c: 'Taco Bell' },
  { d: 1, Source__c: 'Uber Eats', Amount__c: 6.00,  Tips__c: 2.00, Surge_Bonus__c: 0.75, Miles_Driven__c: 3.1,  Total_Miles__c: 5.0,  Time_Taken__c: 18, Uber_Level__c: null, Store__c: 'McDonalds' },
  // zero base pay plus a tip - a cancellation. Must survive.
  { d: 1, Source__c: 'Uber',      Amount__c: 0,     Tips__c: 3.00, Surge_Bonus__c: null, Miles_Driven__c: 0,    Total_Miles__c: 2.0,  Time_Taken__c: 5,  Uber_Level__c: null, Store__c: null },
  { d: 2, Source__c: 'Doordash',  Amount__c: 15.00, Tips__c: 8.00, Surge_Bonus__c: null, Miles_Driven__c: 11.0, Total_Miles__c: 15.5, Time_Taken__c: null, Uber_Level__c: null, Store__c: 'Panda Express' },
  // null Income_Date__c - the INC-1343 case from the vault
  { d: 2, Source__c: 'Doordash',  Amount__c: 10.75, Tips__c: 0,    Surge_Bonus__c: null, Miles_Driven__c: 4.0,  Total_Miles__c: 6.0,  Time_Taken__c: null, Uber_Level__c: null, Store__c: null, nullDate: true },
  { d: 3, Source__c: 'Uber',      Amount__c: 5.50,  Tips__c: 1.00, Surge_Bonus__c: null, Miles_Driven__c: 2.5,  Total_Miles__c: 4.0,  Time_Taken__c: 12, Uber_Level__c: 'UberXL', Store__c: null },
  // never linked to a shift
  { d: null, Source__c: 'Uber Eats', Amount__c: 4.25, Tips__c: 1.75, Surge_Bonus__c: null, Miles_Driven__c: 2.0, Total_Miles__c: 3.0, Time_Taken__c: 9, Uber_Level__c: null, Store__c: 'Subway' }
];

const income = rawIncome.map((r, i) => {
  const total = r2((r.Amount__c ?? 0) + (r.Tips__c ?? 0) + (r.Surge_Bonus__c ?? 0));
  const isUber = r.Source__c === 'Uber' || r.Source__c === 'Uber Eats';
  const isDD = r.Source__c === 'Doordash';
  return {
    Id: sfId('a03', i + 1),
    Name: `INC-${String(1300 + i).padStart(4, '0')}`,
    Daily_Cash_Flow__c: r.d === null ? null : days[r.d].Id,
    Income_Date__c: r.nullDate ? null : (r.d === null ? '2026-08-06' : days[r.d].Date__c),
    Source__c: r.Source__c,
    Store__c: r.Store__c,
    Amount__c: r.Amount__c,
    Tips__c: r.Tips__c,
    Surge_Bonus__c: r.Surge_Bonus__c,
    Uber_Level__c: r.Uber_Level__c,
    Miles_Driven__c: r.Miles_Driven__c,
    Total_Miles__c: r.Total_Miles__c,
    Time_Taken__c: r.Time_Taken__c,
    Notes__c: null,
    Total_Earnings__c: total,
    Earnings_Per_Mile__c: (r.Miles_Driven__c ?? 0) > 0 ? r2(total / r.Miles_Driven__c) : 0,
    True_Earnings_Per_Mile__c: (r.Total_Miles__c ?? 0) > 0 ? r2(total / r.Total_Miles__c) : 0,
    Uber_Pay_Internal__c: isUber ? (r.Amount__c ?? 0) : 0,
    Uber_Tips_Internal__c: isUber ? (r.Tips__c ?? 0) : 0,
    Doordash_Pay_Internal__c: isDD ? (r.Amount__c ?? 0) : 0,
    Doordash_Tips_Internal__c: isDD ? (r.Tips__c ?? 0) : 0,
    CreatedDate: '2026-08-04T14:30:00.000+0000',
    LastModifiedDate: '2026-08-04T14:30:00.000+0000'
  };
});

// --- expenses ---
const rawExpense = [
  { d: 0, Amount__c: 14.50, Type__c: 'Charging', Store__c: 'EVgo' },
  { d: 1, Amount__c: 6.75,  Type__c: 'Food',     Store__c: 'QuikTrip' },
  { d: 2, Amount__c: 22.00, Type__c: 'Maintenance', Store__c: 'Discount Tire' }
];
const expense = rawExpense.map((r, i) => ({
  Id: sfId('a04', i + 1),
  Name: `EXP-${String(i + 1).padStart(4, '0')}`,
  Daily_Cash_Flow__c: days[r.d].Id,
  Expense_Date__c: days[r.d].Date__c,
  Amount__c: r.Amount__c,
  Type__c: r.Type__c,
  Type_Explanation__c: null,
  Store__c: r.Store__c,
  Store_Address__Street__s: '123 Main St',
  Store_Address__City__s: 'Norman',
  Store_Address__StateCode__s: 'OK',
  Store_Address__PostalCode__s: '73069',
  Store_Address__CountryCode__s: 'US',
  Store_Address__Latitude__s: 35.220833,
  Store_Address__Longitude__s: -97.443611,
  Store_Address__GeocodeAccuracy__s: 'Address',
  Location__Latitude__s: 35.22,
  Location__Longitude__s: -97.44,
  CreatedDate: '2026-08-04T18:00:00.000+0000',
  LastModifiedDate: '2026-08-04T18:00:00.000+0000'
}));

// --- derive the shift totals the way DailyCashFlowHandler did ---
const dayOut = days.map(d => {
  const kids = income.filter(r => r.Daily_Cash_Flow__c === d.Id);
  const exps = expense.filter(r => r.Daily_Cash_Flow__c === d.Id);
  const totalIncome = r2(kids.reduce((s, r) => s + r.Total_Earnings__c, 0));
  const totalExp = r2(exps.reduce((s, r) => s + r.Amount__c, 0));
  const activeMiles = r2(kids.reduce((s, r) => s + (r.Miles_Driven__c ?? 0), 0));
  // Deliberately NOT rounded. The real export carries Active_Time_Hours__c to
  // full float precision (0.31616666666666665) and Salesforce divides by that,
  // so rounding here would make the fixture easier to satisfy than the org.
  const activeHours = kids.reduce((s, r) => s + (r.Time_Taken__c ?? 0), 0) / 60;
  const totalActive = activeHours + d.Doordash_Dash_Time__c;
  const shiftHoursExact = d.Clock_Out__c
    ? (new Date(d.Clock_Out__c) - new Date(d.Clock_In__c)) / 3600000 : 0;
  // Salesforce stores this rounded to two places but computes rates from the
  // exact duration - DCF-0035 in the real export shows 0.59 stored against a
  // $12.50/0.585 rate of $21.37.
  const shiftHours = r2(shiftHoursExact);
  const dows = ['7. Sunday','1. Monday','2. Tuesday','3. Wednesday','4. Thursday','5. Friday','6. Saturday'];
  return {
    Id: d.Id, Name: d.Name, Weekly_Cash_Flow__c: weeks[d.w].Id,
    Date__c: d.Date__c, Clock_In__c: d.Clock_In__c, Clock_Out__c: d.Clock_Out__c,
    Total_Shift_Miles__c: d.Total_Shift_Miles__c,
    Doordash_Dash_Time__c: d.Doordash_Dash_Time__c,
    Total_Income__c: totalIncome, Total_Expenses__c: totalExp,
    Active_Miles__c: activeMiles, Active_Time_Hours__c: activeHours,
    Total_Active_Time_Hours__c: totalActive,
    Shift_Hours__c: shiftHours,
    Net_Profit__c: r2(totalIncome - totalExp),
    Earnings_Per_Shift_Hour__c: shiftHoursExact > 0 ? r2(totalIncome / shiftHoursExact) : 0,
    Earnings_Per_Active_Hour__c: totalActive > 0 ? r2(totalIncome / totalActive) : 0,
    True_Earnings_Per_Mile__c: d.Total_Shift_Miles__c > 0 ? r2(totalIncome / d.Total_Shift_Miles__c) : 0,
    Day_of_Week__c: dows[new Date(d.Date__c + 'T12:00:00Z').getUTCDay()],
    CreatedDate: d.Clock_In__c, LastModifiedDate: d.Clock_In__c
  };
});

// --- weekly rollups. Weekly_Active_Hours__c sums the UBER-only field, which is
// the behaviour Salesforce still has: the DoorDash fix never reached it.
const weekOut = weeks.map(w => {
  const kids = dayOut.filter(d => d.Weekly_Cash_Flow__c === w.Id);
  const inc = r2(kids.reduce((s, d) => s + d.Total_Income__c, 0));
  const exp = r2(kids.reduce((s, d) => s + d.Total_Expenses__c, 0));
  const shiftMiles = r2(kids.reduce((s, d) => s + d.Total_Shift_Miles__c, 0));
  const activeMiles = r2(kids.reduce((s, d) => s + d.Active_Miles__c, 0));
  const shiftHours = r2(kids.reduce((s, d) => s + d.Shift_Hours__c, 0));
  const activeHours = kids.reduce((s, d) => s + d.Active_Time_Hours__c, 0);
  const end = new Date(w.Start_Date__c + 'T12:00:00Z'); end.setUTCDate(end.getUTCDate() + 6);
  return {
    Id: w.Id, Name: w.Name, Start_Date__c: w.Start_Date__c,
    End_Date__c: end.toISOString().slice(0, 10),
    Day_Count__c: kids.length,
    Weekly_Total_Income__c: inc, Weekly_Total_Expenses__c: exp,
    Weekly_Shift_Miles__c: shiftMiles, Weekly_Active_Miles__c: activeMiles,
    Weekly_Shift_Hours__c: shiftHours, Weekly_Active_Hours__c: activeHours,
    Net_Profit__c: r2(inc - exp),
    Earnings_Per_Shift_Hour__c: shiftHours > 0 ? r2(inc / shiftHours) : 0,
    Earnings_Per_Active_Hour__c: activeHours > 0 ? r2(inc / activeHours) : 0,
    True_Earnings_Per_Mile__c: shiftMiles > 0 ? r2(inc / shiftMiles) : 0,
    CreatedDate: w.Start_Date__c + 'T00:00:00.000+0000',
    LastModifiedDate: w.Start_Date__c + 'T00:00:00.000+0000'
  };
});

const write = (n, rows) => fs.writeFileSync(path.join(out, `${n}.json`), JSON.stringify(rows, null, 2));
write('Weekly_Cash_Flow__c', weekOut);
write('Daily_Cash_Flow__c', dayOut);
write('Income_Record__c', income);
write('Expense_Record__c', expense);
write('Job__c', []); write('Income__c', []); write('Expense__c', []); write('Shift__c', []);
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
  exportedAt: '2026-09-08T18:55:15.881Z',
  org: { username: 'pat@patsdelivery.com', instanceUrl: 'https://patsdelivery-dev-ed.develop.my.salesforce.com' },
  complete: true, totalRecords: weekOut.length + dayOut.length + income.length + expense.length,
  objects: []
}, null, 2));

console.log(`fixture written to ${out}`);
console.log(`  ${weekOut.length} weeks, ${dayOut.length} shifts, ${income.length} income, ${expense.length} expenses`);
console.log(`  seeded problems: 1 null income date, 2 open shifts, 1 stray Uber level, 1 unlinked income row`);
