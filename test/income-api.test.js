// End-to-end test of routes/income.js against a real Postgres.
//
// Checks the JSON contract public/gig.html actually depends on - field names,
// date formats, aggregation across several shifts in a day - rather than just
// that the queries run. The whole point of keeping the Salesforce response
// shapes is that the front end does not change at cutover, so the shapes are
// what get asserted.
//
//   createdb gigtest
//   psql -d gigtest -f db/001_tables.sql -f db/002_views.sql
//   DATABASE_URL=postgresql:///gigtest npm run test:api
//
// Writes data and does not clean up - point it at a scratch database.

const express = require('express');
const { Pool } = require('pg');

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error('\n  DATABASE_URL must point at a scratch database with db/001_tables.sql\n' +
                '  and db/002_views.sql already applied. This test writes data.\n');
  process.exit(1);
}
let pass = 0, fail = 0;

function check(label, ok, detail) {
  if (ok) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); fail++; }
}
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

async function seed() {
  const p = new Pool({ connectionString: DB });
  // Everything is anchored to the current week so the "this week" endpoints have
  // something to find whenever this runs.
  await p.query(`
    insert into weekly_cash_flow (start_date)
      values (date_trunc('week', current_date)::date),
             (date_trunc('week', current_date)::date - 7);

    -- last week: one closed shift
    insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in, clock_out, total_shift_miles)
      select id, start_date + 1, (start_date + 1)::timestamptz + interval '10 hours',
             (start_date + 1)::timestamptz + interval '15 hours', 80
        from weekly_cash_flow where start_date = date_trunc('week', current_date)::date - 7;

    insert into income_record (daily_cash_flow_id, income_date, source, amount, tips, miles_driven, total_miles, time_taken_minutes)
      select d.id, d.shift_date, 'Uber', 40.00, 10.00, 20, 30, 60
        from daily_cash_flow d join weekly_cash_flow w on w.id = d.weekly_cash_flow_id
       where w.start_date = date_trunc('week', current_date)::date - 7;

    -- this week: two shifts on the SAME day, to prove they aggregate
    insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in, clock_out, total_shift_miles, doordash_dash_time_hours)
      select id, start_date + 1, (start_date + 1)::timestamptz + interval '9 hours',
             (start_date + 1)::timestamptz + interval '11 hours', 40, 0
        from weekly_cash_flow where start_date = date_trunc('week', current_date)::date;
    insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in, clock_out, total_shift_miles, doordash_dash_time_hours)
      select id, start_date + 1, (start_date + 1)::timestamptz + interval '17 hours',
             (start_date + 1)::timestamptz + interval '21 hours', 60, 1.5
        from weekly_cash_flow where start_date = date_trunc('week', current_date)::date;

    insert into income_record (daily_cash_flow_id, income_date, source, amount, tips, miles_driven, total_miles, time_taken_minutes)
      select d.id, d.shift_date, 'Uber Eats', 30.00, 12.00, 15, 22, 90
        from daily_cash_flow d join weekly_cash_flow w on w.id = d.weekly_cash_flow_id
       where w.start_date = date_trunc('week', current_date)::date
       order by d.clock_in limit 1;
    insert into income_record (daily_cash_flow_id, income_date, source, amount, tips, miles_driven, total_miles)
      select d.id, d.shift_date, 'Doordash', 50.00, 20.00, 25, 35
        from daily_cash_flow d join weekly_cash_flow w on w.id = d.weekly_cash_flow_id
       where w.start_date = date_trunc('week', current_date)::date
       order by d.clock_in desc limit 1;

    insert into expense_record (daily_cash_flow_id, expense_date, amount, type)
      select d.id, d.shift_date, 12.00, 'Charging'
        from daily_cash_flow d join weekly_cash_flow w on w.id = d.weekly_cash_flow_id
       where w.start_date = date_trunc('week', current_date)::date
       order by d.clock_in limit 1;
  `);
  const { rows } = await p.query(`select to_char(date_trunc('week', current_date)::date + 1, 'YYYY-MM-DD') as day`);
  await p.end();
  return rows[0].day;
}

(async () => {
  const shiftDay = await seed();

  const app = express();
  app.use(express.json());
  app.use('/api/income', require('../routes/income'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/income`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => {
    const r = await fetch(base + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
  };

  console.log('--- totals ---');
  // this week: (30+12) + (50+20) = 112
  eq('GET /weekly total', (await get('/weekly')).total, 112);
  const monthly = await get('/monthly');
  check('GET /monthly returns a number', typeof monthly.total === 'number', `got ${typeof monthly.total}`);
  const trend = await get('/trend');
  check('GET /trend is an array', Array.isArray(trend.trend), JSON.stringify(trend).slice(0, 80));
  check('GET /trend months are 1-12', trend.trend.every(t => t.mo >= 1 && t.mo <= 12),
        JSON.stringify(trend.trend));
  check('GET /trend has numeric totals', trend.trend.every(t => typeof t.total === 'number'), '');

  console.log('\n--- weekly report ---');
  const wr = await get('/weekly-report');
  check('week object present', wr.week !== null, JSON.stringify(wr).slice(0, 120));
  eq('Weekly_Total_Income__c', wr.week.Weekly_Total_Income__c, 112);
  eq('Weekly_Total_Expenses__c', wr.week.Weekly_Total_Expenses__c, 12);
  eq('Net_Profit__c', wr.week.Net_Profit__c, 100);
  eq('Weekly_Shift_Miles__c', wr.week.Weekly_Shift_Miles__c, 100);
  eq('Weekly_Shift_Hours__c (2h + 4h)', wr.week.Weekly_Shift_Hours__c, 6);
  check('Start_Date__c is a bare date string',
        /^\d{4}-\d{2}-\d{2}$/.test(wr.week.Start_Date__c), wr.week.Start_Date__c);
  check('End_Date__c is a bare date string',
        /^\d{4}-\d{2}-\d{2}$/.test(wr.week.End_Date__c), wr.week.End_Date__c);
  eq('two shifts collapse into one day row', wr.days.length, 1);
  eq('day income is both shifts', wr.days[0].income, 112);
  check('dayName has no sort prefix', !/^\d/.test(wr.days[0].dayName), wr.days[0].dayName);
  eq('ratePerShiftHour from summed totals', wr.days[0].ratePerShiftHour, Math.round((112 / 6) * 100) / 100);
  check('bestDay present', wr.bestDay && wr.bestDay.income === 112, JSON.stringify(wr.bestDay));
  check('lastWeek present', wr.lastWeek && wr.lastWeek.Weekly_Total_Income__c === 50,
        JSON.stringify(wr.lastWeek));

  console.log('\n--- score ---');
  const sc = await get('/score?date=' + shiftDay);
  eq('found', sc.found, true);
  eq('shiftCount aggregates both shifts', sc.dcf.shiftCount, 2);
  eq('Total_Income__c', sc.dcf.Total_Income__c, 112);
  eq('Net_Profit__c', sc.dcf.Net_Profit__c, 100);
  eq('Total_Shift_Miles__c', sc.dcf.Total_Shift_Miles__c, 100);
  eq('Earnings_Per_Shift_Hour__c recomputed from sums', sc.dcf.Earnings_Per_Shift_Hour__c, 112 / 6);
  check('Name joins both record numbers', /\+/.test(sc.dcf.Name), sc.dcf.Name);
  check('Day_of_Week__c keeps the sort prefix', /^\d\. /.test(sc.dcf.Day_of_Week__c), sc.dcf.Day_of_Week__c);
  eq('metrics list unchanged', sc.metrics.map(m => m.field),
     ['Total_Income__c', 'Net_Profit__c', 'Earnings_Per_Shift_Hour__c', 'True_Earnings_Per_Mile__c']);
  check('composite is 1-10', sc.composite >= 1 && sc.composite <= 10, String(sc.composite));
  eq('inProgress false when all shifts closed', sc.inProgress, false);
  eq('missing date returns found:false', (await get('/score?date=1999-01-01')).found, false);
  check('bad date rejected', (await (await fetch(base + '/score?date=nope')).json()).error !== undefined, '');

  console.log('\n--- shift clock ---');
  eq('no shift open initially', (await get('/shift/active')).active, false);

  const start = await post('/shift/start', { clockIn: '2026-09-08T09:00:00-05:00' });
  check('start succeeds', start.body.success === true, JSON.stringify(start));
  const active = await get('/shift/active');
  eq('shift now reads as active', active.active, true);
  eq('active recordId matches', active.recordId, start.body.recordId);

  const dup = await post('/shift/start', { clockIn: '2026-09-08T10:00:00-05:00' });
  eq('second concurrent shift is refused', dup.status, 409);

  eq('bad datetime rejected', (await post('/shift/start', { clockIn: 'today' })).status, 400);
  eq('missing clockIn rejected', (await post('/shift/start', {})).status, 400);

  const end = await post('/shift/end', {
    recordId: start.body.recordId, clockOut: '2026-09-08T17:30:00-05:00', miles: '42.5'
  });
  check('end succeeds', end.body.success === true, JSON.stringify(end));
  eq('shift closed', (await get('/shift/active')).active, false);
  eq('ending an already-closed shift 404s',
     (await post('/shift/end', { recordId: start.body.recordId, clockOut: '2026-09-08T18:00:00-05:00' })).status, 404);
  eq('clock-out before clock-in rejected',
     (await post('/shift/end', { recordId: '999999', clockOut: '2026-09-08T18:00:00-05:00' })).status, 404);
  eq('non-numeric recordId rejected',
     (await post('/shift/end', { recordId: "1; drop table income_record", clockOut: '2026-09-08T18:00:00-05:00' })).status, 400);

  // The new shift created a week if none existed; income tables must be intact.
  const p = new Pool({ connectionString: DB });
  const { rows } = await p.query('select count(*)::int as n from income_record');
  check('income_record survived the injection attempt', rows[0].n === 3, `n=${rows[0].n}`);
  await p.end();

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
