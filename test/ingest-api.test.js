// End-to-end test of routes/ingest.js against a real Postgres.
//
// The point of this endpoint is that pushing the same thing twice does not
// count it twice, so most of what is below is about retries: the same
// externalId sent again, sent in the same batch, and sent concurrently.
//
//   createdb gigingest
//   psql -d gigingest -f db/001_tables.sql -f db/002_views.sql -f db/003_ingest.sql
//   DATABASE_URL=postgresql:///gigingest npm run test:ingest
//
// Writes data and does not clean up - point it at a scratch database.

const express = require('express');
const { Pool } = require('pg');

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error('\n  DATABASE_URL must point at a scratch database with the schema applied.\n');
  process.exit(1);
}

const KEY = 'test-ingest-key-9f3a';
process.env.INGEST_KEY = KEY;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); fail++; }
}
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const today = new Date().toISOString().slice(0, 10);
const uniq = () => `px-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ingest', require('../routes/ingest'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/ingest`;

  const call = async (path, body, { key = KEY, header = 'Bearer' } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (key !== null) {
      if (header === 'Bearer') headers.authorization = `Bearer ${key}`;
      else headers['x-ingest-key'] = key;
    }
    const r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
  };

  // --- auth -----------------------------------------------------------------
  let r = await call('/health', undefined, { key: null });
  eq('no key is rejected', r.status, 401);

  r = await call('/health', undefined, { key: 'wrong-key-entirely' });
  eq('a wrong key is rejected', r.status, 401);

  r = await call('/health', undefined, { key: KEY.slice(0, -1) });
  eq('a truncated key is rejected', r.status, 401);

  r = await call('/health');
  eq('a good bearer key is accepted', r.status, 200);
  check('health reports the backend', r.body.backend === 'postgres', JSON.stringify(r.body));

  r = await call('/health', undefined, { header: 'x-ingest-key' });
  eq('x-ingest-key works too', r.status, 200);

  // Off by default: with no INGEST_KEY set, the whole router refuses.
  delete process.env.INGEST_KEY;
  r = await call('/health');
  eq('unset INGEST_KEY means 503, not open', r.status, 503);
  process.env.INGEST_KEY = KEY;

  // --- income ---------------------------------------------------------------
  const ext1 = uniq();
  r = await call('/income', {
    externalId: ext1, incomeDate: today, source: 'Doordash',
    store: 'Ingest Diner', amount: 7.25, tips: 3.5, milesDriven: 4.2, timeTakenMinutes: 18
  });
  eq('a pushed income record is created', r.status, 201);
  eq('  created count', r.body.created, 1);
  eq('  total_earnings is computed', r.body.records[0].total_earnings, 10.75);
  check('  it gets a record number', /^INC-\d+$/.test(r.body.records[0].record_no), r.body.records[0].record_no);
  const firstId = r.body.records[0].id;

  // The whole reason this endpoint exists.
  r = await call('/income', {
    externalId: ext1, incomeDate: today, source: 'Doordash',
    store: 'Ingest Diner', amount: 7.25, tips: 3.5
  });
  eq('the same externalId again is not a second record', r.status, 200);
  eq('  reported as a duplicate', r.body.duplicates, 1);
  eq('  and returns the original row', r.body.records[0].id, firstId);

  // Two genuinely identical deliveries are not duplicates - only the id is.
  r = await call('/income', [
    { externalId: uniq(), incomeDate: today, source: 'Doordash', store: 'Twice', amount: 7.25 },
    { externalId: uniq(), incomeDate: today, source: 'Doordash', store: 'Twice', amount: 7.25 }
  ]);
  eq('identical rows with different ids both count', r.body.created, 2);

  // A batch that repeats an id within itself.
  const ext2 = uniq();
  r = await call('/income', { records: [
    { externalId: ext2, incomeDate: today, source: 'Uber Eats', amount: 5 },
    { externalId: ext2, incomeDate: today, source: 'Uber Eats', amount: 5 }
  ] });
  eq('a repeat inside one batch is caught', r.body.created, 1);
  eq('  and reported', r.body.duplicates, 1);

  // No externalId at all: behaves like the form, every push is a new row.
  r = await call('/income', { incomeDate: today, source: 'Uber', amount: 3.33 });
  eq('a record with no externalId is still accepted', r.status, 201);
  const before = r.body.records[0].id;
  r = await call('/income', { incomeDate: today, source: 'Uber', amount: 3.33 });
  check('  and is not deduplicated', r.body.records[0].id !== before, 'same id came back');

  // --- validation is the same as the form ------------------------------------
  r = await call('/income', { externalId: uniq(), incomeDate: today, source: 'Doordash' });
  eq('a missing amount is rejected', r.status, 400);
  check('  with the form’s wording', /amount is required/i.test(r.body.error), r.body.error);

  r = await call('/income', { externalId: uniq(), incomeDate: today, source: 'Deliveroo', amount: 5 });
  eq('an unknown platform is rejected', r.status, 400);

  r = await call('/income', { externalId: uniq(), incomeDate: today, source: 'Doordash', amount: 5, uberLevel: 'Gold' });
  eq('an Uber level on a DoorDash row is rejected', r.status, 400);

  r = await call('/income', { externalId: uniq(), incomeDate: 'yesterday', source: 'Uber', amount: 5 });
  eq('a bad date is rejected', r.status, 400);

  r = await call('/income', { externalId: uniq(), incomeDate: today, source: 'Uber', amount: -5 });
  eq('a negative amount is rejected', r.status, 400);

  // A bad record names its position, and takes nothing with it.
  const survivor = uniq();
  r = await call('/income', [
    { externalId: survivor, incomeDate: today, source: 'Uber', amount: 9.99 },
    { externalId: uniq(), incomeDate: today, source: 'Uber' }
  ]);
  eq('a batch with one bad record is rejected whole', r.status, 400);
  check('  naming which one', /record 1/.test(r.body.error), r.body.error);
  const p = new Pool({ connectionString: DB });
  const { rows: leaked } = await p.query('select id from income_record where external_id = $1', [survivor]);
  eq('  and the good record in it was rolled back', leaked.length, 0);

  r = await call('/income', {});
  eq('an empty object is a validation error', r.status, 400);
  r = await call('/income', []);
  eq('an empty array is rejected', r.status, 400);
  r = await call('/income', Array.from({ length: 201 }, () => ({ incomeDate: today, source: 'Uber', amount: 1 })));
  eq('an oversized batch is rejected', r.status, 400);

  // --- concurrent retries ----------------------------------------------------
  // Two pushes of the same id at the same moment. Checking first and inserting
  // after would let both through; the unique constraint is what decides.
  const race = uniq();
  const both = await Promise.all([
    call('/income', { externalId: race, incomeDate: today, source: 'Uber', amount: 12.5 }),
    call('/income', { externalId: race, incomeDate: today, source: 'Uber', amount: 12.5 })
  ]);
  const { rows: raced } = await p.query('select id from income_record where external_id = $1', [race]);
  eq('two simultaneous pushes of one id write one row', raced.length, 1);
  check('  and both callers got a success', both.every(x => x.status < 400),
        both.map(x => x.status).join(', '));

  // --- shift linking ---------------------------------------------------------
  const week = (await p.query(
    `insert into weekly_cash_flow (start_date) values (date_trunc('week', $1::date)::date)
     on conflict (start_date) do update set start_date = excluded.start_date returning id`, [today])).rows[0].id;
  const shift = (await p.query(
    `insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in)
     values ($1, $2::date, $2::date + interval '9 hours') returning id`, [week, today])).rows[0].id;

  r = await call('/income', { externalId: uniq(), incomeDate: today, source: 'Doordash', amount: 8.4 });
  eq('a pushed record links to that day’s shift', String(r.body.records[0].daily_cash_flow_id), String(shift));

  // --- dash time -------------------------------------------------------------
  r = await call('/dash-time', { date: today, hours: 3.25 });
  eq('dash time lands on the shift', r.status, 200);
  eq('  and is stored', Number(r.body.doordash_dash_time_hours), 3.25);

  r = await call('/dash-time', { date: today, hours: 4.5 });
  eq('pushing it again corrects rather than adds', Number(r.body.doordash_dash_time_hours), 4.5);

  r = await call('/dash-time', { date: '2019-01-02', hours: 2 });
  eq('a day with no shift is refused', r.status, 404);
  check('  and says how to mean it', /createShift/.test(r.body.error), r.body.error);

  r = await call('/dash-time', { date: '2019-01-02', hours: 2, createShift: true });
  eq('createShift records one anyway', r.status, 201);
  eq('  flagged as created', r.body.createdShift, true);

  r = await call('/dash-time', { date: today });
  eq('dash time with no hours is rejected', r.status, 400);
  r = await call('/dash-time', { date: today, hours: -1 });
  eq('negative dash time is rejected', r.status, 400);

  // --- expenses --------------------------------------------------------------
  const extE = uniq();
  r = await call('/expenses', { externalId: extE, expenseDate: today, amount: 14.2, type: 'Charging', store: 'EVgo' });
  eq('a pushed expense is created', r.status, 201);
  r = await call('/expenses', { externalId: extE, expenseDate: today, amount: 14.2, type: 'Charging' });
  eq('and is deduplicated the same way', r.body.duplicates, 1);
  r = await call('/expenses', { externalId: uniq(), expenseDate: today, amount: 5, type: 'Spaceship' });
  eq('an unknown expense type is rejected', r.status, 400);

  await p.end();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
