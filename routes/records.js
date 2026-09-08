/**
 * Record management — the part Salesforce was doing that no code replaced.
 *
 * routes/income.js keeps the eight read endpoints the dashboard already calls,
 * deliberately still shaped like Salesforce. This is new surface with no legacy
 * consumer, so it uses plain names: `totalEarnings`, not `Total_Earnings__c`.
 *
 * Every total still comes from the views. Nothing here writes a computed value.
 */

const express = require('express');
const router = express.Router();
const { pool, withTransaction } = require('../lib/db');

const TZ = 'America/Chicago';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

const SOURCES = ['Uber', 'Uber Eats', 'Doordash', 'other'];
const EXPENSE_TYPES = ['Food', 'Charging', 'Toll', 'Tires', 'Maintenance', 'Other'];

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

/**
 * Collects WHERE fragments and their parameters. Every bare `$` in a fragment
 * becomes the same numbered placeholder, so one value can be matched against
 * several columns without hand-counting indexes.
 */
function filters() {
  const where = [];
  const params = [];
  return {
    add(sql, value) {
      params.push(value);
      where.push(sql.replaceAll('$', `$${params.length}`));
    },
    get clause() { return where.length ? `where ${where.join(' and ')}` : ''; },
    get params() { return params; }
  };
}

class BadRequest extends Error {
  constructor(message, field) { super(message); this.field = field; }
}

/** Money and distances: absent stays absent, a blank string is absent too. */
function optionalNumber(value, field, { min = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new BadRequest(`${field} must be a number`, field);
  if (min !== null && n < min) throw new BadRequest(`${field} cannot be less than ${min}`, field);
  return n;
}

function requiredNumber(value, field, opts) {
  const n = optionalNumber(value, field, opts);
  if (n === null) throw new BadRequest(`${field} is required`, field);
  return n;
}

function requiredDate(value, field) {
  if (!value || !ISO_DATE.test(value)) throw new BadRequest(`${field} must be YYYY-MM-DD`, field);
  return value;
}

function optionalText(value, field, max) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new BadRequest(`${field} is longer than ${max} characters`, field);
  return s;
}

function oneOf(value, allowed, field, { required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new BadRequest(`${field} is required`, field);
    return null;
  }
  if (!allowed.includes(value)) {
    throw new BadRequest(`${field} must be one of: ${allowed.join(', ')}`, field);
  }
  return value;
}

const id = v => (/^\d+$/.test(String(v)) ? Number(v) : null);

/** Turn a constraint violation back into the sentence a person can act on. */
function explain(e) {
  const byConstraint = {
    income_source_valid: 'That platform is not one of the allowed values.',
    income_uber_level_requires_uber: 'An Uber level can only go on an Uber or Uber Eats record.',
    income_miles_not_negative: 'Miles cannot be negative.',
    income_time_not_negative: 'Time cannot be negative.',
    expense_type_valid: 'That expense type is not one of the allowed values.',
    expense_amount_not_negative: 'An expense cannot be negative.',
    dcf_clock_out_after_in: 'Clock-out cannot be before clock-in.',
    dcf_clock_out_needs_in: 'A shift cannot have a clock-out without a clock-in.',
    dcf_miles_not_negative: 'Shift miles cannot be negative.',
    daily_cash_flow_one_open_shift: 'Another shift is already open. Close it first.',
    weekly_starts_monday: 'Weeks run Monday to Sunday.'
  };
  return byConstraint[e.constraint] || null;
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof BadRequest) return res.status(400).json({ error: e.message, field: e.field });
      const friendly = explain(e);
      if (friendly) return res.status(400).json({ error: friendly, constraint: e.constraint });
      console.error('[records]', e);
      res.status(500).json({ error: e.message });
    }
  };
}

// ---------------------------------------------------------------------------
// Shift linking
// ---------------------------------------------------------------------------

/**
 * Which shift does a record on this date belong to?
 *
 * Salesforce reused only an *open* shift and minted a new one otherwise, so
 * backfilling a day that was already clocked out always created a second shift
 * and the history is full of them. Here: one shift on that date wins outright,
 * several resolve to the open one or the latest, and none leaves the record
 * unlinked rather than inventing a shift that never happened.
 */
async function shiftForDate(client, date) {
  const { rows } = await client.query(
    `select id from daily_cash_flow
      where shift_date = $1
      order by (clock_out is null) desc, clock_in desc nulls last
      limit 1`,
    [date]
  );
  return rows[0]?.id ?? null;
}

/** Weeks are created on demand so a backfilled shift always has a parent. */
async function weekForDate(client, date) {
  const { rows } = await client.query(
    `insert into weekly_cash_flow (start_date)
     values (date_trunc('week', $1::date)::date)
     on conflict (start_date) do update set start_date = excluded.start_date
     returning id`,
    [date]
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

const INCOME_SORTS = {
  date: 'income_date', amount: 'total_earnings', source: 'source',
  store: 'store', miles: 'miles_driven', record: 'record_no'
};

router.get('/income', handle(async (req, res) => {
  const { from, to, source, q } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const sort = INCOME_SORTS[req.query.sort] || 'income_date';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';

  const f = filters();
  if (from) f.add('r.income_date >= $', requiredDate(from, 'from'));
  if (to) f.add('r.income_date <= $', requiredDate(to, 'to'));
  if (source) f.add('r.source = $', oneOf(source, SOURCES, 'source'));
  // One search box over the three fields worth searching.
  if (q) f.add('(r.store ilike $ or r.notes ilike $ or r.record_no ilike $)', `%${q}%`);

  const { clause, params } = f;

  const [rows, count] = await Promise.all([
    pool.query(
      `select r.*, d.record_no as shift_record_no, d.shift_date
         from v_income_record r
         left join daily_cash_flow d on d.id = r.daily_cash_flow_id
         ${clause}
        order by ${sort} ${dir} nulls last, r.id ${dir}
        limit ${limit} offset ${offset}`,
      params
    ),
    pool.query(`select count(*)::int as n, coalesce(sum(total_earnings),0) as total
                  from v_income_record r ${clause}`, params)
  ]);

  res.json({
    records: rows.rows,
    total: count.rows[0].n,
    sumEarnings: count.rows[0].total,
    limit, offset
  });
}));

function incomeFields(body) {
  const source = oneOf(body.source, SOURCES, 'source');
  const uberLevel = optionalText(body.uberLevel, 'uberLevel', 255);
  if (uberLevel && !['Uber', 'Uber Eats'].includes(source)) {
    throw new BadRequest('An Uber level only applies to Uber or Uber Eats.', 'uberLevel');
  }
  return {
    income_date: requiredDate(body.incomeDate, 'incomeDate'),
    source,
    store: optionalText(body.store, 'store', 255),
    // Zero is a real value: a cancellation can pay nothing but still tip.
    amount: requiredNumber(body.amount, 'amount', { min: 0 }),
    tips: optionalNumber(body.tips, 'tips', { min: 0 }),
    surge_bonus: optionalNumber(body.surgeBonus, 'surgeBonus', { min: 0 }),
    uber_level: uberLevel,
    miles_driven: optionalNumber(body.milesDriven, 'milesDriven', { min: 0 }),
    total_miles: optionalNumber(body.totalMiles, 'totalMiles', { min: 0 }),
    // Minutes, as the column name says. The UI collects minutes too.
    time_taken_minutes: optionalNumber(body.timeTakenMinutes, 'timeTakenMinutes', { min: 0 }),
    notes: optionalText(body.notes, 'notes', 4000)
  };
}

router.post('/income', handle(async (req, res) => {
  const f = incomeFields(req.body || {});
  const record = await withTransaction(async (client) => {
    const shiftId = req.body.dailyCashFlowId !== undefined
      ? id(req.body.dailyCashFlowId)
      : await shiftForDate(client, f.income_date);
    const cols = Object.keys(f).concat('daily_cash_flow_id');
    const vals = Object.values(f).concat(shiftId);
    const { rows } = await client.query(
      `insert into income_record (${cols.join(', ')})
       values (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       returning id`,
      vals
    );
    return rows[0].id;
  });
  const { rows } = await pool.query('select * from v_income_record where id = $1', [record]);
  res.status(201).json(rows[0]);
}));

router.patch('/income/:id', handle(async (req, res) => {
  const rid = id(req.params.id);
  if (!rid) throw new BadRequest('Invalid id');
  const f = incomeFields(req.body || {});
  if (req.body.dailyCashFlowId !== undefined) f.daily_cash_flow_id = id(req.body.dailyCashFlowId);

  const cols = Object.keys(f);
  const { rows } = await pool.query(
    `update income_record set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
      where id = $1 returning id`,
    [rid, ...Object.values(f)]
  );
  if (!rows.length) return res.status(404).json({ error: 'No income record with that id' });
  const out = await pool.query('select * from v_income_record where id = $1', [rid]);
  res.json(out.rows[0]);
}));

router.delete('/income/:id', handle(async (req, res) => {
  const rid = id(req.params.id);
  if (!rid) throw new BadRequest('Invalid id');
  const { rows } = await pool.query(
    'delete from income_record where id = $1 returning record_no, total_earnings', [rid]);
  if (!rows.length) return res.status(404).json({ error: 'No income record with that id' });
  res.json({ deleted: rows[0].record_no, amount: rows[0].total_earnings });
}));

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

router.get('/expenses', handle(async (req, res) => {
  const { from, to, type } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const f = filters();
  if (from) f.add('e.expense_date >= $', requiredDate(from, 'from'));
  if (to) f.add('e.expense_date <= $', requiredDate(to, 'to'));
  if (type) f.add('e.type = $', oneOf(type, EXPENSE_TYPES, 'type'));
  const { clause, params } = f;

  const [rows, count] = await Promise.all([
    pool.query(
      `select e.*, d.record_no as shift_record_no
         from expense_record e
         left join daily_cash_flow d on d.id = e.daily_cash_flow_id
         ${clause}
        order by e.expense_date desc, e.id desc
        limit ${limit} offset ${offset}`, params),
    pool.query(`select count(*)::int as n, coalesce(sum(amount),0) as total
                  from expense_record e ${clause}`, params)
  ]);

  res.json({ records: rows.rows, total: count.rows[0].n, sumAmount: count.rows[0].total, limit, offset });
}));

function expenseFields(body) {
  return {
    expense_date: requiredDate(body.expenseDate, 'expenseDate'),
    amount: requiredNumber(body.amount, 'amount', { min: 0 }),
    type: oneOf(body.type, EXPENSE_TYPES, 'type', { required: false }),
    type_explanation: optionalText(body.typeExplanation, 'typeExplanation', 4000),
    store: optionalText(body.store, 'store', 255)
  };
}

router.post('/expenses', handle(async (req, res) => {
  const f = expenseFields(req.body || {});
  const rid = await withTransaction(async (client) => {
    const shiftId = req.body.dailyCashFlowId !== undefined
      ? id(req.body.dailyCashFlowId)
      : await shiftForDate(client, f.expense_date);
    const cols = Object.keys(f).concat('daily_cash_flow_id');
    const { rows } = await client.query(
      `insert into expense_record (${cols.join(', ')})
       values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      Object.values(f).concat(shiftId)
    );
    return rows[0].id;
  });
  const { rows } = await pool.query('select * from expense_record where id = $1', [rid]);
  res.status(201).json(rows[0]);
}));

router.patch('/expenses/:id', handle(async (req, res) => {
  const rid = id(req.params.id);
  if (!rid) throw new BadRequest('Invalid id');
  const f = expenseFields(req.body || {});
  if (req.body.dailyCashFlowId !== undefined) f.daily_cash_flow_id = id(req.body.dailyCashFlowId);
  const cols = Object.keys(f);
  const { rows } = await pool.query(
    `update expense_record set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
      where id = $1 returning id`,
    [rid, ...Object.values(f)]);
  if (!rows.length) return res.status(404).json({ error: 'No expense with that id' });
  const out = await pool.query('select * from expense_record where id = $1', [rid]);
  res.json(out.rows[0]);
}));

router.delete('/expenses/:id', handle(async (req, res) => {
  const rid = id(req.params.id);
  if (!rid) throw new BadRequest('Invalid id');
  const { rows } = await pool.query('delete from expense_record where id = $1 returning record_no, amount', [rid]);
  if (!rows.length) return res.status(404).json({ error: 'No expense with that id' });
  res.json({ deleted: rows[0].record_no, amount: rows[0].amount });
}));

// ---------------------------------------------------------------------------
// Shifts — correcting and backfilling
// ---------------------------------------------------------------------------

router.get('/shifts', handle(async (req, res) => {
  const { from, to } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const f = filters();
  if (from) f.add('shift_date >= $', requiredDate(from, 'from'));
  if (to) f.add('shift_date <= $', requiredDate(to, 'to'));
  const { clause, params } = f;

  const { rows } = await pool.query(
    `select v.*,
            (select count(*)::int from income_record i where i.daily_cash_flow_id = v.id) as income_count,
            (select count(*)::int from expense_record e where e.daily_cash_flow_id = v.id) as expense_count
       from v_daily_cash_flow v ${clause}
      order by shift_date desc, clock_in desc nulls last
      limit ${limit}`, params);
  res.json({ shifts: rows });
}));

function shiftTimes(body) {
  const check = (v, field) => {
    if (v === null || v === undefined || v === '') return null;
    if (!ISO_DATETIME.test(v)) throw new BadRequest(`${field} must be an ISO date-time`, field);
    return v;
  };
  const clockIn = check(body.clockIn, 'clockIn');
  const clockOut = check(body.clockOut, 'clockOut');
  if (clockOut && !clockIn) throw new BadRequest('A clock-out needs a clock-in.', 'clockIn');
  if (clockIn && clockOut && new Date(clockOut) < new Date(clockIn)) {
    throw new BadRequest('Clock-out cannot be before clock-in.', 'clockOut');
  }
  return { clock_in: clockIn, clock_out: clockOut };
}

/** Backfill a shift that was never clocked, then adopt that day's loose records. */
router.post('/shifts', handle(async (req, res) => {
  const body = req.body || {};
  const shiftDate = requiredDate(body.shiftDate, 'shiftDate');
  const times = shiftTimes(body);
  const miles = optionalNumber(body.totalShiftMiles, 'totalShiftMiles', { min: 0 }) ?? 0;
  const dash = optionalNumber(body.doordashDashTimeHours, 'doordashDashTimeHours', { min: 0 }) ?? 0;
  const adopt = body.adoptOrphans !== false;

  const result = await withTransaction(async (client) => {
    const weekId = await weekForDate(client, shiftDate);
    const { rows } = await client.query(
      `insert into daily_cash_flow
         (weekly_cash_flow_id, shift_date, clock_in, clock_out, total_shift_miles, doordash_dash_time_hours)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [weekId, shiftDate, times.clock_in, times.clock_out, miles, dash]);
    const shiftId = rows[0].id;

    let adopted = { income: 0, expenses: 0 };
    if (adopt) {
      const i = await client.query(
        `update income_record set daily_cash_flow_id = $1
          where income_date = $2 and daily_cash_flow_id is null returning id`, [shiftId, shiftDate]);
      const e = await client.query(
        `update expense_record set daily_cash_flow_id = $1
          where expense_date = $2 and daily_cash_flow_id is null returning id`, [shiftId, shiftDate]);
      adopted = { income: i.rowCount, expenses: e.rowCount };
    }
    return { shiftId, adopted };
  });

  const { rows } = await pool.query('select * from v_daily_cash_flow where id = $1', [result.shiftId]);
  res.status(201).json({ ...rows[0], adopted: result.adopted });
}));

router.patch('/shifts/:id', handle(async (req, res) => {
  const sid = id(req.params.id);
  if (!sid) throw new BadRequest('Invalid id');
  const body = req.body || {};
  const times = shiftTimes(body);
  const shiftDate = body.shiftDate ? requiredDate(body.shiftDate, 'shiftDate') : null;

  const updated = await withTransaction(async (client) => {
    const sets = ['clock_in = $2', 'clock_out = $3', 'total_shift_miles = $4', 'doordash_dash_time_hours = $5'];
    const vals = [
      sid, times.clock_in, times.clock_out,
      optionalNumber(body.totalShiftMiles, 'totalShiftMiles', { min: 0 }) ?? 0,
      optionalNumber(body.doordashDashTimeHours, 'doordashDashTimeHours', { min: 0 }) ?? 0
    ];
    // Moving a shift to another date moves it to that date's week too.
    if (shiftDate) {
      const weekId = await weekForDate(client, shiftDate);
      sets.push(`shift_date = $${vals.length + 1}`); vals.push(shiftDate);
      sets.push(`weekly_cash_flow_id = $${vals.length + 1}`); vals.push(weekId);
    }
    const { rows } = await client.query(
      `update daily_cash_flow set ${sets.join(', ')} where id = $1 returning id`, vals);
    return rows.length > 0;
  });

  if (!updated) return res.status(404).json({ error: 'No shift with that id' });
  const { rows } = await pool.query('select * from v_daily_cash_flow where id = $1', [sid]);
  res.json(rows[0]);
}));

/**
 * Delete a shift. Its income and expenses are kept and unlinked, never removed —
 * losing a delivery because a shift record was tidied up is not a trade anyone
 * would make knowingly, and the schema's ON DELETE SET NULL says the same.
 */
router.delete('/shifts/:id', handle(async (req, res) => {
  const sid = id(req.params.id);
  if (!sid) throw new BadRequest('Invalid id');
  const result = await withTransaction(async (client) => {
    const counts = await client.query(
      `select (select count(*)::int from income_record where daily_cash_flow_id = $1) as income,
              (select count(*)::int from expense_record where daily_cash_flow_id = $1) as expenses`, [sid]);
    const { rows } = await client.query(
      'delete from daily_cash_flow where id = $1 returning record_no', [sid]);
    return rows.length ? { deleted: rows[0].record_no, unlinked: counts.rows[0] } : null;
  });
  if (!result) return res.status(404).json({ error: 'No shift with that id' });
  res.json(result);
}));

// ---------------------------------------------------------------------------
// What the filters need to render
// ---------------------------------------------------------------------------

router.get('/meta', handle(async (req, res) => {
  const [bounds, unlinked, open] = await Promise.all([
    pool.query(`select min(income_date) as first, max(income_date) as last,
                       count(*)::int as income_count from income_record`),
    pool.query(`select (select count(*)::int from income_record where daily_cash_flow_id is null) as income,
                       (select count(*)::int from expense_record where daily_cash_flow_id is null) as expenses`),
    pool.query(`select id, record_no, shift_date, clock_in from v_daily_cash_flow where is_open limit 1`)
  ]);
  res.json({
    sources: SOURCES,
    expenseTypes: EXPENSE_TYPES,
    dateRange: bounds.rows[0],
    unlinked: unlinked.rows[0],
    openShift: open.rows[0] || null,
    today: (await pool.query(`select (now() at time zone $1)::date as d`, [TZ])).rows[0].d
  });
}));

module.exports = router;

// Shared with routes/ingest.js, which accepts the same records over a different
// door: an API key instead of a browser session. Exported rather than copied so
// the two can never disagree about what a valid income record is - a validation
// rule that holds on the form but not on the machine-to-machine path is a rule
// that does not hold.
module.exports.incomeFields = incomeFields;
module.exports.expenseFields = expenseFields;
module.exports.shiftForDate = shiftForDate;
module.exports.weekForDate = weekForDate;
module.exports.explain = explain;
module.exports.BadRequest = BadRequest;
module.exports.requiredDate = requiredDate;
module.exports.optionalNumber = optionalNumber;
