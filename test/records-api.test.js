// End-to-end test of routes/records.js — the CRUD surface that replaces what
// Patrick was doing by hand in the Salesforce UI.
//
// Exercises the real HTTP responses, the validation messages a person would
// actually read, and the constraint translations. Writes data; point it at a
// scratch database.
//
//   DATABASE_URL=postgresql:///gigtest npm run test:records

const express = require('express');
const { Pool } = require('pg');

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error('\n  DATABASE_URL must point at a scratch database with the schema applied.\n');
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); fail++; }
};
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query(`
    insert into weekly_cash_flow (start_date) values ('2026-06-01') on conflict do nothing;
    insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in, clock_out, total_shift_miles)
      select id, '2026-06-02', '2026-06-02T14:00:00Z', '2026-06-02T19:00:00Z', 55
        from weekly_cash_flow where start_date = '2026-06-01';
  `);

  const app = express();
  app.use(express.json());
  app.use('/api/records', require('../routes/records'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/records`;

  const req = async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, body: await r.json() };
  };
  const GET = p => req('GET', p);
  const POST = (p, b) => req('POST', p, b);
  const PATCH = (p, b) => req('PATCH', p, b);
  const DEL = p => req('DELETE', p);

  console.log('--- meta ---');
  const meta = (await GET('/meta')).body;
  eq('sources listed', meta.sources, ['Uber', 'Uber Eats', 'Doordash', 'other']);
  eq('expense types listed', meta.expenseTypes,
     ['Food', 'Charging', 'Toll', 'Tires', 'Maintenance', 'Other']);
  check('today resolves in Central', /^\d{4}-\d{2}-\d{2}$/.test(meta.today), meta.today);

  console.log('\n--- income: create ---');
  const created = await POST('/income', {
    incomeDate: '2026-06-02', source: 'Uber Eats', store: 'Panera',
    amount: 9.25, tips: 4.75, surgeBonus: 1.5,
    milesDriven: 6.4, totalMiles: 9.1, timeTakenMinutes: 27.5, uberLevel: 'UberX'
  });
  eq('created', created.status, 201);
  eq('total_earnings computed', created.body.total_earnings, 15.5);
  eq('time kept in minutes', created.body.time_taken_minutes, 27.5);
  eq('time also offered in hours', created.body.time_taken_hours, 0.46);
  check('auto-linked to that day\'s shift', created.body.daily_cash_flow_id !== null,
        String(created.body.daily_cash_flow_id));
  const incId = created.body.id;

  console.log('\n--- income: validation a person can read ---');
  eq('unknown platform rejected',
     (await POST('/income', { incomeDate: '2026-06-02', source: 'Grubhub', amount: 5 })).body.error,
     'source must be one of: Uber, Uber Eats, Doordash, other');
  eq('Uber level on DoorDash rejected',
     (await POST('/income', { incomeDate: '2026-06-02', source: 'Doordash', amount: 5, uberLevel: 'UberX' })).body.error,
     'An Uber level only applies to Uber or Uber Eats.');
  eq('missing amount rejected',
     (await POST('/income', { incomeDate: '2026-06-02', source: 'Uber' })).body.error,
     'amount is required');
  eq('negative miles rejected',
     (await POST('/income', { incomeDate: '2026-06-02', source: 'Uber', amount: 5, milesDriven: -3 })).body.error,
     'milesDriven cannot be less than 0');
  eq('bad date rejected',
     (await POST('/income', { incomeDate: '06/02/2026', source: 'Uber', amount: 5 })).body.error,
     'incomeDate must be YYYY-MM-DD');

  const zero = await POST('/income', { incomeDate: '2026-06-02', source: 'Uber', amount: 0, tips: 3 });
  eq('zero base pay with a tip is allowed', zero.body.total_earnings, 3);

  console.log('\n--- income: edit and delete ---');
  const edited = await PATCH(`/income/${incId}`, {
    incomeDate: '2026-06-02', source: 'Uber Eats', store: 'Panera Bread',
    amount: 10.25, tips: 4.75, surgeBonus: 1.5, milesDriven: 6.4, totalMiles: 9.1,
    timeTakenMinutes: 27.5
  });
  eq('edit recomputes the total', edited.body.total_earnings, 16.5);
  eq('edit persisted the store', edited.body.store, 'Panera Bread');
  eq('editing a missing record 404s', (await PATCH('/income/9999999', {
    incomeDate: '2026-06-02', source: 'Uber', amount: 1 })).status, 404);
  eq('non-numeric id rejected', (await PATCH('/income/1;drop table income_record', {
    incomeDate: '2026-06-02', source: 'Uber', amount: 1 })).status, 400);

  console.log('\n--- income: filtering ---');
  const all = (await GET('/income?from=2026-06-01&to=2026-06-30')).body;
  check('date range returns the new records', all.total >= 2, String(all.total));
  check('sum is returned with the page', typeof all.sumEarnings === 'number', String(all.sumEarnings));
  const bySource = (await GET('/income?source=Uber%20Eats&from=2026-06-01&to=2026-06-30')).body;
  check('platform filter narrows', bySource.records.every(r => r.source === 'Uber Eats'),
        JSON.stringify(bySource.records.map(r => r.source)));
  const search = (await GET('/income?q=Panera&from=2026-06-01&to=2026-06-30')).body;
  check('search matches the store across all three columns', search.total === 1, String(search.total));
  // The same box read the way he types: a record number, an amount, a date.
  const panera = search.records[0];
  const has = body => body.records.some(r => r.id === panera.id);
  check('a bare number finds the record it names',
        has((await GET(`/income?q=${panera.record_no.replace(/^INC-0*/, '')}`)).body));
  const byNo = (await GET(`/income?q=${panera.record_no}`)).body;
  check('INC-number finds exactly that record', byNo.total === 1 && has(byNo), String(byNo.total));
  check('an exact amount finds it',
        has((await GET(`/income?q=${encodeURIComponent('$' + panera.total_earnings)}&from=2026-06-01&to=2026-06-30`)).body));
  const byDay = (await GET(`/income?q=${panera.income_date}`)).body;
  check('a date finds that day and only that day',
        has(byDay) && byDay.records.every(r => r.income_date === panera.income_date), String(byDay.total));
  check('a number nothing carries finds nothing', (await GET('/income?q=999999')).body.total === 0);

  // Uber level is its own filter, built from what the records hold.
  const levels = (await GET('/meta')).body.uberLevels;
  check('meta lists the Uber levels in use', Array.isArray(levels) && levels.includes('UberX'), JSON.stringify(levels));
  const first = levels[0];
  const everything = (await GET('/income?limit=1')).body.total;
  const one = (await GET(`/income?limit=500&level=${encodeURIComponent(first)}`)).body;
  check('level filter keeps only that level',
        one.total >= 1 && one.records.every(r => r.uber_level === first), `${first}: ${one.total}`);
  const noLevel = (await GET(`/income?limit=500&level=${encodeURIComponent('(none)')}`)).body;
  check('"Not recorded" keeps only records without one',
        noLevel.records.every(r => !r.uber_level) && noLevel.total + one.total <= everything, String(noLevel.total));
  const both = (await GET(`/income?limit=500&level=${encodeURIComponent(first)}&ride=regular`)).body;
  check('level and ride type combine', both.total <= one.total &&
        both.records.every(r => r.uber_level === first && !r.is_airport && !r.is_reservation), String(both.total));

  // Every record list searches the same way, and the find box searches them all.
  const shift = (await GET('/shifts?limit=1')).body.shifts[0];
  const byShiftNo = (await GET(`/shifts?q=${shift.record_no}`)).body.shifts;
  check('shifts: its number finds that shift', byShiftNo.length === 1 && byShiftNo[0].id === shift.id, String(byShiftNo.length));
  const byShiftDay = (await GET(`/shifts?q=${shift.shift_date}`)).body.shifts;
  check('shifts: a date finds that day', byShiftDay.some(s => s.id === shift.id) &&
        byShiftDay.every(s => s.shift_date === shift.shift_date), String(byShiftDay.length));
  if (panera.daily_cash_flow_id) {
    check('shifts: an income number finds the shift it was earned on',
          (await GET(`/shifts?q=${panera.record_no}`)).body.shifts.some(s => s.id === panera.daily_cash_flow_id));
  }
  const week = (await GET('/weeks?limit=1')).body.weeks[0];
  const byWeekNo = (await GET(`/weeks?q=${week.record_no}`)).body.weeks;
  check('weeks: its number finds that week', byWeekNo.length === 1 && byWeekNo[0].id === week.id, String(byWeekNo.length));
  const byWeekDay = (await GET(`/weeks?q=${week.end_date}`)).body.weeks;
  check('weeks: a date finds the week holding it', byWeekDay.length === 1 && byWeekDay[0].id === week.id, String(byWeekDay.length));
  const found = (await GET(`/find?q=${panera.record_no}`)).body;
  check('find: a record number comes back first, marked exact',
        found.hits[0] && found.hits[0].kind === 'income' && found.hits[0].id === panera.id && found.hits[0].exact,
        JSON.stringify(found.hits[0]));
  const foundShift = (await GET(`/find?q=${shift.record_no}`)).body;
  check('find: a shift number is that shift alone, not its records',
        foundShift.hits.length === 1 && foundShift.hits[0].kind === 'shift' && foundShift.hits[0].id === shift.id,
        JSON.stringify(foundShift.hits.map(h => h.record_no)));
  check('find: nothing typed finds nothing', (await GET('/find?q=')).body.hits.length === 0);
  eq('unknown sort falls back rather than injecting',
     (await GET('/income?sort=id;drop&limit=1')).status, 200);

  console.log('\n--- expenses ---');
  const exp = await POST('/expenses', {
    expenseDate: '2026-06-02', amount: 18.4, type: 'Charging', store: 'EVgo'
  });
  eq('expense created', exp.status, 201);
  check('expense auto-linked', exp.body.daily_cash_flow_id !== null, String(exp.body.daily_cash_flow_id));
  const expByNo = (await GET(`/expenses?q=${exp.body.record_no}`)).body;
  check('expenses: its number finds it', expByNo.total === 1 && expByNo.records[0].id === exp.body.id, String(expByNo.total));
  check('expenses: store text and an exact amount find it',
        (await GET('/expenses?q=evgo&from=2026-06-01&to=2026-06-30')).body.records.some(r => r.id === exp.body.id) &&
        (await GET('/expenses?q=18.40&from=2026-06-01&to=2026-06-30')).body.records.some(r => r.id === exp.body.id));
  eq('unknown type rejected',
     (await POST('/expenses', { expenseDate: '2026-06-02', amount: 5, type: 'Parking' })).body.error,
     'type must be one of: Food, Charging, Toll, Tires, Maintenance, Other');
  eq('negative expense rejected',
     (await POST('/expenses', { expenseDate: '2026-06-02', amount: -5 })).body.error,
     'amount cannot be less than 0');
  const expList = (await GET('/expenses?from=2026-06-01&to=2026-06-30')).body;
  eq('expense sum returned', expList.sumAmount, 18.4);
  eq('expense deleted', (await DEL(`/expenses/${exp.body.id}`)).body.deleted, exp.body.record_no);

  console.log('\n--- shifts: backfill adopts that day\'s loose records ---');
  const orphan = await POST('/income', {
    incomeDate: '2026-06-05', source: 'Doordash', amount: 14, tips: 6, dailyCashFlowId: null
  });
  eq('no shift that day, so it lands unlinked', orphan.body.daily_cash_flow_id, null);

  const backfilled = await POST('/shifts', {
    shiftDate: '2026-06-05', clockIn: '2026-06-05T15:00:00Z', clockOut: '2026-06-05T20:00:00Z',
    totalShiftMiles: 48
  });
  eq('shift backfilled', backfilled.status, 201);
  eq('it adopted the loose income record', backfilled.body.adopted.income, 1);
  eq('and the shift now shows that income', backfilled.body.total_income, 20);
  eq('shift hours from the times', backfilled.body.shift_hours, 5);

  console.log('\n--- shifts: correcting ---');
  const fixed = await PATCH(`/shifts/${backfilled.body.id}`, {
    shiftDate: '2026-06-05', clockIn: '2026-06-05T15:00:00Z', clockOut: '2026-06-05T21:30:00Z',
    totalShiftMiles: 61.5
  });
  eq('corrected hours', fixed.body.shift_hours, 6.5);
  eq('corrected miles', fixed.body.total_shift_miles, 61.5);
  eq('clock-out before clock-in rejected',
     (await PATCH(`/shifts/${backfilled.body.id}`, {
       shiftDate: '2026-06-05', clockIn: '2026-06-05T20:00:00Z', clockOut: '2026-06-05T09:00:00Z'
     })).body.error, 'Clock-out cannot be before clock-in.');
  eq('clock-out with no clock-in rejected',
     (await PATCH(`/shifts/${backfilled.body.id}`, {
       shiftDate: '2026-06-05', clockOut: '2026-06-05T21:00:00Z'
     })).body.error, 'A clock-out needs a clock-in.');

  console.log('\n--- shifts: deleting keeps the money ---');
  const before = (await GET('/income?from=2026-06-05&to=2026-06-05')).body.total;
  const gone = await DEL(`/shifts/${backfilled.body.id}`);
  eq('reports what it unlinked', gone.body.unlinked.income, 1);
  const after = (await GET('/income?from=2026-06-05&to=2026-06-05')).body;
  eq('the income record survived', after.total, before);
  eq('...now unlinked rather than deleted', after.records[0].daily_cash_flow_id, null);

  console.log('\n--- meta reflects the unlinked row ---');
  check('unlinked income counted', (await GET('/meta')).body.unlinked.income >= 1, '');

  // Deleting the shift above left this record unlinked on purpose, and leaving
  // it there made the suite pass only once: the next run's backfill adopted two
  // loose records instead of one, then three. A test that only works on a
  // virgin database is not testing the database anyone actually has.
  eq('the loose record is cleaned up, so this suite can run again',
     (await DEL(`/income/${orphan.body.id}`)).status, 200);

  eq('deleting the edited income record', (await DEL(`/income/${incId}`)).status, 200);
  eq('deleting it twice 404s', (await DEL(`/income/${incId}`)).status, 404);

  await pool.end();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
