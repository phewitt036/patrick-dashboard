// Covers the 2026-09-17 change: with nothing clocked in, a record for today joins
// the day's finished shift instead of opening a second one. Scratch database only.
const express = require('express');
const { Pool } = require('pg');

const DB = process.env.DATABASE_URL;
if (!DB) { console.error('DATABASE_URL must point at a scratch database.'); process.exit(1); }
const KEY = 'test-ingest-key-9f3a';
process.env.INGEST_KEY = KEY;

let pass = 0, fail = 0;
const check = (l, ok, d) => { if (ok) { console.log(`PASS  ${l}`); pass++; } else { console.log(`FAIL  ${l}${d?`\n        ${d}`:''}`); fail++; } };
const eq = (l, got, want) => check(l, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const uniq = () => `px-join-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ingest', require('../routes/ingest'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/ingest`;
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const p = new Pool({ connectionString: DB });

  // A clean slate for today, so the scenario is the one being tested.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  await p.query(`delete from income_record where income_date = $1`, [today]);
  await p.query(`delete from daily_cash_flow where shift_date = $1`, [today]);
  await p.query(`update daily_cash_flow set clock_out = clock_in where clock_out is null`);

  // --- no shift at all: still opens one -------------------------------------
  let r = await call('/income', { externalId: uniq(), incomeDate: today, source: 'Uber Eats', amount: 3.11 });
  eq('with no shift for the day, one is opened', r.body.shifts?.[0]?.createdShift, true);
  const openedId = r.body.records[0].daily_cash_flow_id;

  // --- finished shift, nothing running: joins it ----------------------------
  await p.query(`update daily_cash_flow set clock_out = clock_in + interval '5 hours' where id = $1`, [openedId]);
  r = await call('/income', { externalId: uniq(), incomeDate: today, source: 'Uber Eats', amount: 6.38 });
  eq('a later record joins the finished shift', String(r.body.records[0].daily_cash_flow_id), String(openedId));
  check('  and says so rather than doing it silently', !!r.body.shifts?.[0]?.joinedClosed, JSON.stringify(r.body.shifts));
  const { rows: count } = await p.query(`select count(*)::int n from daily_cash_flow where shift_date = $1`, [today]);
  eq('  without opening a second shift', count[0].n, 1);

  // --- a known delivery time still wins -------------------------------------
  const { rows: sh } = await p.query(`select clock_in, clock_out from daily_cash_flow where id = $1`, [openedId]);
  const inside = new Date(new Date(sh[0].clock_in).getTime() + 60 * 60 * 1000).toISOString();
  r = await call('/income', { externalId: uniq(), incomeDate: today, source: 'Uber Eats', amount: 4.25, occurredAt: inside });
  eq('a delivery with a real time still matches by time', String(r.body.records[0].daily_cash_flow_id), String(openedId));

  // --- an open shift still takes precedence ---------------------------------
  await p.query(`update daily_cash_flow set clock_out = null where id = $1`, [openedId]);
  r = await call('/income', { externalId: uniq(), incomeDate: today, source: 'Uber Eats', amount: 9.99 });
  eq('a running shift still takes the record', String(r.body.records[0].daily_cash_flow_id), String(openedId));
  check('  and is not reported as a join', !r.body.shifts?.[0]?.joinedClosed, JSON.stringify(r.body.shifts));

  await p.end(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
