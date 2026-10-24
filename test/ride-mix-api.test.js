// /api/records/ride-mix against figures worked out by hand.
//
// Seeds eight records in March 2019 - years before any real record - so it can
// run against any database with the schema, imported data included, and deletes
// them again at the end. Every expected number below is written out from the
// rows, not read back from the code under test.
//
//   DATABASE_URL=postgresql:///gigtest npm run test:mix

const express = require('express');
const { Pool } = require('pg');

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error('\n  DATABASE_URL must point at a database with the schema applied.\n');
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
  const ids = [];
  let shiftId = null, weekId = null;

  try {
    // A placeholder shift of its own, the shape of DCF-0000, to hold the one ride
    // that must not be counted. 2019-03-04 is a Monday.
    const { rows: [w] } = await pool.query(
      `insert into weekly_cash_flow (start_date) values ('2019-03-04') returning id`);
    weekId = w.id;
    const { rows: [ph] } = await pool.query(
      `insert into daily_cash_flow (weekly_cash_flow_id, shift_date, is_placeholder)
       values ($1, '2019-03-06', true) returning id`, [weekId]);
    shiftId = ph.id;

    const seed = [
      // A: UberX, timed, both distances (total_miles wins), clock time Mon 6:10pm CST
      { level: 'UberX', amount: 10, tips: 2, surge: null, driven: 4, total: 5, mins: 15,
        date: '2019-03-04', at: '2019-03-04T18:10:00-06:00' },
      // B: UberX airport, surge, only miles_driven (the fallback)
      { level: 'UberX', amount: 20, tips: 0, surge: 3, driven: 8, total: null, mins: 30,
        date: '2019-03-05', airport: true },
      // C: Comfort reservation with nothing measured: no time, no distance
      { level: 'Comfort', amount: 15, tips: null, surge: null, driven: null, total: null, mins: null,
        date: '2019-03-06', reservation: true },
      // D: no level; total_miles 0 falls back to driven; 0 minutes is unmeasured
      { level: null, amount: 9, tips: 1.6, surge: null, driven: 3, total: 0, mins: 0, date: '2019-03-07' },
      // E: on the placeholder shift - excluded from everything
      { level: 'UberX', amount: 999, tips: 0, surge: 5, driven: 1, total: 1, mins: 1, date: '2019-03-06', placeholder: true },
      // F: an Uber Eats order carrying a level - a delivery, not a ride
      { level: 'UberX', amount: 50, tips: 0, surge: null, driven: 2, total: 2, mins: 10, date: '2019-03-06', source: 'Uber Eats' },
      // G: UberX the next week, clock time Tue 8:30am CDT (after the 2019-03-10 change)
      { level: 'UberX', amount: 12, tips: 3, surge: 1, driven: 6, total: 7, mins: 20,
        date: '2019-03-12', at: '2019-03-12T08:30:00-05:00' },
      // H: a blank-string level, which is no level
      { level: '', amount: 6, tips: null, surge: null, driven: 2, total: 2.5, mins: 10, date: '2019-03-13' }
    ];
    for (const r of seed) {
      const { rows: [x] } = await pool.query(
        `insert into income_record (daily_cash_flow_id, income_date, source, amount, tips, surge_bonus, uber_level,
            miles_driven, total_miles, time_taken_minutes, occurred_at, is_airport, is_reservation)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [r.placeholder ? shiftId : null, r.date, r.source || 'Uber', r.amount, r.tips, r.surge, r.level,
         r.driven, r.total, r.mins, r.at || null, !!r.airport, !!r.reservation]);
      ids.push(x.id);
    }

    const app = express();
    app.use('/api/records', require('../routes/records'));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/records`;
    const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

    const { body: m } = await get('/ride-mix?from=2019-03-04&to=2019-03-17');

    console.log('--- what counts ---');
    // A B C D G H. Not E (placeholder), not F (Uber Eats).
    eq('six rides: the placeholder and the delivery are left out', m.total.rides, 6);
    eq('total is 12 + 23 + 15 + 10.60 + 16 + 6', m.total.earnings, 82.6);
    eq('levels partition the rides', m.levels.reduce((a, l) => a + l.rides, 0) + m.noLevel.rides, 6);
    eq('most-driven level first, no level kept apart', m.levels.map(l => l.level), ['UberX', 'Comfort']);

    console.log('\n--- UberX: A, B, G ---');
    const x = m.levels.find(l => l.level === 'UberX');
    eq('rides', x.rides, 3);
    eq('total 12 + 23 + 16', x.earnings, 51);
    eq('per ride 51 / 3', x.perRide, 17);
    eq('per hour 51 over 65 minutes', x.perHour, 47.08);
    eq('per mile 51 over 5 + 8 + 7 (driven when total is missing)', x.perMile, 2.55);
    eq('tip share 5 of 51', x.tipShare, 9.8);
    eq('surge on 2 of 3', x.surgeShare, 66.7);

    console.log('\n--- a rate with no denominator is null, not 0 ---');
    const c = m.levels.find(l => l.level === 'Comfort');
    eq('Comfort per ride still exists', c.perRide, 15);
    eq('Comfort per hour is null: no trip time', c.perHour, null);
    eq('Comfort per mile is null: no distance', c.perMile, null);
    eq('...and says none of its rides were timed', c.ridesTimed, 0);

    console.log('\n--- no level: D and the blank-string H ---');
    eq('blank and null are the same gap', m.noLevel.rides, 2);
    eq('per ride 16.60 / 2', m.noLevel.perRide, 8.3);
    eq('0 minutes is unmeasured: per hour is H alone, 6 over 10 minutes', m.noLevel.perHour, 36);
    eq('...from one timed ride', m.noLevel.ridesTimed, 1);
    eq('total_miles 0 falls back to driven: 16.60 over 3 + 2.5', m.noLevel.perMile, 3.02);
    eq('tip share 1.60 of 16.60', m.noLevel.tipShare, 9.6);

    console.log('\n--- ride types ---');
    const kind = k => m.rideTypes.find(t => t.kind === k);
    eq('regular is A, D, G, H', kind('regular').rides, 4);
    eq('regular total 12 + 10.60 + 16 + 6', kind('regular').earnings, 44.6);
    eq('regular per hour: 34 over 45 timed minutes (D is untimed)', kind('regular').perHour, 45.33);
    eq('airport is B', [kind('airport').rides, kind('airport').earnings], [1, 23]);
    eq('reservation is C, with no hourly figure', [kind('reservation').rides, kind('reservation').perHour], [1, null]);

    console.log('\n--- week by week ---');
    eq('trend is at least twelve weeks, ending in the range\'s last week',
       [m.trend.weeks.length, m.trend.weeks[m.trend.weeks.length - 1]], [12, '2019-03-11']);
    eq('series in table order, no level last', m.trend.series.map(s => s.level), ['UberX', 'Comfort', null]);
    const ux = m.trend.series[0].points;
    eq('UberX week of 03-04: A and B, 35 over 45 minutes',
       ux.find(p => p.week === '2019-03-04'), { week: '2019-03-04', rides: 2, perRide: 17.5, perHour: 46.67, ridesTimed: 2 });
    eq('UberX week of 03-11: G alone',
       ux.find(p => p.week === '2019-03-11'), { week: '2019-03-11', rides: 1, perRide: 16, perHour: 48, ridesTimed: 1 });
    eq('a week without rides is a gap, not a zero',
       ux.find(p => p.week === '2019-02-25'), { week: '2019-02-25', rides: 0, perRide: null, perHour: null, ridesTimed: 0 });

    console.log('\n--- when ---');
    eq('only A and G carry a clock time', [m.when.timed, m.when.rides], [2, 6]);
    eq('24 hours and 7 days, empty ones included', [m.when.hours.length, m.when.weekdays.length], [24, 7]);
    eq('A lands at 6pm Central, not midnight UTC', m.when.hours[18].rides, 1);
    eq('G lands at 8am Central across the DST change', m.when.hours[8].rides, 1);
    eq('Monday holds A, at 12 a ride', [m.when.weekdays[0].rides, m.when.weekdays[0].perRide], [1, 12]);
    eq('Tuesday holds G', m.when.weekdays[1].rides, 1);
    eq('an hour he never drove has no rate', m.when.hours[3].perRide, null);

    console.log('\n--- input ---');
    eq('a bad date is refused', (await get('/ride-mix?from=03/04/2019')).status, 400);
    const none = (await get('/ride-mix?from=2019-01-01&to=2019-01-02')).body;
    eq('a range with no rides answers, with nulls', [none.total.rides, none.total.perRide, none.levels.length], [0, null, 0]);

    server.close();
  } finally {
    if (ids.length) await pool.query('delete from income_record where id = any($1)', [ids]);
    if (shiftId) await pool.query('delete from daily_cash_flow where id = $1', [shiftId]);
    if (weekId) await pool.query('delete from weekly_cash_flow where id = $1', [weekId]);
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
