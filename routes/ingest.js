/**
 * Machine-to-machine ingestion.
 *
 * Pixit reads a screenshot, works out what was earned, and pushes it here. In
 * Salesforce it pushed straight at the REST API with an OAuth session; the
 * replacement is this, an API key over the same JSON the record screens use.
 *
 * Two things this door has that the Salesforce one did not:
 *
 *   Idempotency. Screenshots get retried, and Salesforce would happily write
 *   the same $12.50 delivery twice. Every pushed record carries an externalId
 *   that is unique in the database, so a retry returns the record that already
 *   exists instead of a second copy of it. Duplicates answer 200, not an error:
 *   a client that gets an error retries, which is the opposite of what a
 *   duplicate should cause.
 *
 *   The same validation as the form. incomeFields and expenseFields come from
 *   routes/records.js rather than being restated, because a rule that holds
 *   when Patrick types it and not when Pixit sends it is not a rule.
 *
 * Auth is INGEST_KEY. If it is unset the whole router answers 503 - off by
 * default rather than open by default.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool, withTransaction, requireDatabase } = require('../lib/db');
const records = require('./records');

const { incomeFields, expenseFields, shiftForDate, weekForDate, explain,
        BadRequest, requiredDate, optionalNumber } = records;

const MAX_BATCH = 200;

/** Compare digests, not strings: === on secrets leaks their length in timing. */
function keyMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  const expected = process.env.INGEST_KEY;
  if (!expected) {
    return res.status(503).json({
      error: 'Ingestion is not enabled. Set INGEST_KEY in .env to turn it on.'
    });
  }
  const header = req.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-ingest-key');
  if (!given || !keyMatches(given, expected)) {
    return res.status(401).json({ error: 'Bad or missing ingest key.' });
  }
  next();
});

// After the key check, deliberately: whether this server has a database is not
// something an unauthenticated caller should be able to probe for.
router.use(requireDatabase);

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof BadRequest) return res.status(400).json({ error: e.message, field: e.field });
      const friendly = explain(e);
      if (friendly) return res.status(400).json({ error: friendly, constraint: e.constraint });
      console.error('[ingest]', e);
      res.status(500).json({ error: e.message });
    }
  };
}

/** One record, an array of them, or {records:[...]}. All three arrive in practice. */
function asBatch(body) {
  const list = Array.isArray(body) ? body
    : Array.isArray(body?.records) ? body.records
    : body && typeof body === 'object' ? [body]
    : null;
  if (!list) throw new BadRequest('Send a record object, an array of them, or {records: [...]}.');
  if (!list.length) throw new BadRequest('No records to ingest.');
  if (list.length > MAX_BATCH) throw new BadRequest(`At most ${MAX_BATCH} records per request.`);
  return list;
}

function externalId(row) {
  const v = row.externalId ?? row.external_id;
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (s.length > 255) throw new BadRequest('externalId is too long (max 255).', 'externalId');
  return s;
}

/**
 * Insert unless this externalId has been seen. The unique constraint is what
 * actually decides - checking first and inserting after would let two pushes
 * that arrive together both pass the check.
 */
async function insertOnce(client, table, fields, extId, shiftId) {
  const cols = Object.keys(fields).concat('daily_cash_flow_id', 'external_id');
  const vals = Object.values(fields).concat(shiftId, extId);
  const { rows } = await client.query(
    `insert into ${table} (${cols.join(', ')})
     values (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     on conflict (external_id) do nothing
     returning id`,
    vals
  );
  if (rows[0]) return { id: rows[0].id, duplicate: false };

  // do nothing fired, so a row with this externalId is already there.
  const existing = await client.query(
    `select id from ${table} where external_id = $1`, [extId]);
  return { id: existing.rows[0].id, duplicate: true };
}

async function ingestBatch(req, { table, view, fieldsOf, dateKey }) {
  const list = asBatch(req.body);
  const results = await withTransaction(async (client) => {
    const out = [];
    for (const [i, row] of list.entries()) {
      let fields, extId;
      try {
        fields = fieldsOf(row);
        extId = externalId(row);
      } catch (e) {
        if (e instanceof BadRequest) throw new BadRequest(`record ${i}: ${e.message}`, e.field);
        throw e;
      }
      const date = fields[dateKey];
      // A pushed record links to the shift on its date the same way a typed one
      // does, and does not invent a shift when there is none.
      const shiftId = await shiftForDate(client, date);
      const r = extId
        ? await insertOnce(client, table, fields, extId, shiftId)
        : await (async () => {
            const cols = Object.keys(fields).concat('daily_cash_flow_id');
            const vals = Object.values(fields).concat(shiftId);
            const { rows } = await client.query(
              `insert into ${table} (${cols.join(', ')})
               values (${cols.map((_, n) => `$${n + 1}`).join(', ')}) returning id`, vals);
            return { id: rows[0].id, duplicate: false };
          })();
      out.push(r);
    }
    return out;
  });

  const ids = results.map(r => r.id);
  const { rows } = await pool.query(`select * from ${view} where id = any($1::bigint[])`, [ids]);
  const byId = new Map(rows.map(r => [String(r.id), r]));
  return results.map(r => ({ ...byId.get(String(r.id)), duplicate: r.duplicate }));
}

// ---------------------------------------------------------------------------

/** Lets Pixit prove the key works before anything is written. */
router.get('/health', handle(async (_req, res) => {
  const { rows } = await pool.query(
    `select (select count(*) from income_record)::int  as income,
            (select count(*) from expense_record)::int as expenses,
            (select max(income_date) from income_record) as latest_income`);
  res.json({ ok: true, backend: 'postgres', ...rows[0] });
}));

router.post('/income', handle(async (req, res) => {
  const out = await ingestBatch(req, {
    table: 'income_record', view: 'v_income_record',
    fieldsOf: incomeFields, dateKey: 'income_date'
  });
  const created = out.filter(r => !r.duplicate).length;
  res.status(created ? 201 : 200).json({ created, duplicates: out.length - created, records: out });
}));

router.post('/expenses', handle(async (req, res) => {
  const out = await ingestBatch(req, {
    table: 'expense_record', view: 'expense_record',
    fieldsOf: expenseFields, dateKey: 'expense_date'
  });
  const created = out.filter(r => !r.duplicate).length;
  res.status(created ? 201 : 200).json({ created, duplicates: out.length - created, records: out });
}));

/**
 * DoorDash dash time, which Pixit used to PATCH onto the Daily Cash Flow record
 * directly. It is per-shift rather than per-delivery, so it sets rather than
 * adds - a second push for the same day corrects the first instead of doubling
 * it, which makes retries safe without needing an externalId.
 *
 * Refuses to invent a shift. A day with no shift is a day Patrick did not clock
 * in, and silently creating one produces exactly the kind of empty record the
 * Salesforce history is full of. Pass createShift to say you meant it.
 */
router.post('/dash-time', handle(async (req, res) => {
  const body = req.body || {};
  const date = requiredDate(body.date, 'date');
  const hours = optionalNumber(body.hours, 'hours', { min: 0 });
  if (hours === null) throw new BadRequest('hours is required.', 'hours');

  const result = await withTransaction(async (client) => {
    let shiftId = await shiftForDate(client, date);
    let createdShift = false;
    if (!shiftId) {
      if (!body.createShift) return null;
      const weekId = await weekForDate(client, date);
      const { rows } = await client.query(
        `insert into daily_cash_flow (weekly_cash_flow_id, shift_date, doordash_dash_time_hours)
         values ($1, $2, $3) returning id`, [weekId, date, hours]);
      shiftId = rows[0].id;
      createdShift = true;
    } else {
      await client.query(
        'update daily_cash_flow set doordash_dash_time_hours = $1 where id = $2', [hours, shiftId]);
    }
    return { shiftId, createdShift };
  });

  if (!result) {
    return res.status(404).json({
      error: `No shift on ${date}. Send createShift: true to record one anyway.`,
      field: 'date'
    });
  }
  const { rows } = await pool.query('select * from v_daily_cash_flow where id = $1', [result.shiftId]);
  res.status(result.createdShift ? 201 : 200).json({ ...rows[0], createdShift: result.createdShift });
}));

module.exports = router;
