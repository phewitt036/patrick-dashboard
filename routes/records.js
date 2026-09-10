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
const { pool, withTransaction, requireDatabase } = require('../lib/db');

router.use(requireDatabase);

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

/**
 * A moment, as read off a screenshot, resolved to an absolute instant.
 *
 * Accepts a full ISO string with an offset, and also a bare local wall-clock
 * "2026-09-10T13:07", which is what a screenshot actually shows. A bare one is
 * read in the SERVER's local timezone, which is the same America/Chicago the
 * rest of this app assumes and the one he was driving in. Anything sent from
 * another machine should carry its offset rather than rely on that.
 */
function optionalMoment(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) {
    throw new BadRequest(`${field} must look like 2026-09-10T13:07 or a full ISO timestamp.`, field);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new BadRequest(`${field} is not a real date and time.`, field);
  return d.toISOString();
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
      where shift_date = $1 and not is_placeholder
      order by (clock_out is null) desc, clock_in desc nulls last
      limit 1`,
    [date]
  );
  return rows[0]?.id ?? null;
}

/** Weeks are created on demand so a backfilled shift always has a parent. */
/**
 * The shift for a date, opening one if there is none.
 *
 * Until now a record landing on a day with no shift stayed unlinked, on the
 * principle that inventing a shift produces the empty records the Salesforce
 * history is full of. That principle held when shifts were typed by hand. It
 * stopped holding once Pixit became the way records arrive: the first delivery
 * of a day would land with nowhere to go, and its hours, miles and rates would
 * belong to nothing.
 *
 * Two rules keep it honest.
 *
 * A clock-in is only invented for TODAY, where "now" is a true statement about
 * when the shift started. For any other date the shift is created with no times
 * at all rather than a fabricated one - it exists, the record links to it, the
 * week rolls it up, and nothing claims to know hours nobody recorded. That is
 * the same shape the imported history already uses.
 *
 * The schema permits exactly one open shift, so opening today's means closing
 * anything left open on an earlier day. It is closed at its own last income
 * record, or at its clock-in if it has none - the same repair the installer
 * applies to abandoned shifts, and the caller is told it happened.
 */
/**
 * The shift whose clocked window contains a moment. This is the whole point of
 * recording when a delivery happened: a screenshot uploaded at 11pm for a
 * delivery made at 9:15am belongs to the 9am shift, and no rule based on when
 * the upload arrived can know that. Measured on the real data, a new shift has
 * begun 4 minutes after a clock-out and a straggler has landed 625 minutes
 * after one, so the two are indistinguishable by upload time alone.
 *
 * An open shift counts as running up to now, so a delivery on the shift he is
 * currently driving matches it.
 */
async function shiftContaining(client, moment) {
  const { rows } = await client.query(
    `select id from daily_cash_flow
      where not is_placeholder
        and clock_in is not null
        and clock_in <= $1::timestamptz
        and coalesce(clock_out, now()) >= $1::timestamptz
      order by clock_in desc
      limit 1`, [moment]);
  return rows[0]?.id ?? null;
}

async function shiftForDateOrOpen(client, date, occurredAt) {
  // A real delivery time beats every other rule here, including the open shift.
  if (occurredAt) {
    const containing = await shiftContaining(client, occurredAt);
    if (containing) {
      return { id: containing, createdShift: false, closedAbandoned: null, matchedByTime: true };
    }
  }

  const { rows: [today] } = await client.query(
    `select (now() at time zone $1)::date = $2::date as is_today`, [TZ, date]);
  const isToday = today.is_today;

  // What is running right now, and whether it belongs to this record's day.
  const { rows: openRows } = await client.query(
    `select id, record_no, shift_date = $1::date as same_day
       from daily_cash_flow
      where clock_in is not null and clock_out is null and not is_placeholder
      limit 1`, [date]);
  const open = openRows[0] || null;

  // A shift that is clocked in takes the record, always. This is the ordinary
  // case: the first delivery of a shift opens it and every one after joins it.
  if (open && open.same_day) {
    return { id: open.id, createdShift: false, closedAbandoned: null };
  }

  // Not today, so there is no "now" to clock in. Join a shift already on that
  // date if there is one, otherwise make an untimed one: the record needs
  // somewhere to live and the week needs to roll it up, but inventing a
  // clock-in for a day that has already happened would be a lie.
  if (!isToday) {
    const existing = await shiftForDate(client, date);
    if (existing) return { id: existing, createdShift: false, closedAbandoned: null };
    const weekId = await weekForDate(client, date);
    const { rows } = await client.query(
      `insert into daily_cash_flow (weekly_cash_flow_id, shift_date)
       values ($1, $2) returning id`, [weekId, date]);
    return { id: rows[0].id, createdShift: true, openedNow: false, closedAbandoned: null };
  }

  // Today, with nothing clocked in. A new shift starts, even when the day
  // already holds a finished one - two shifts in a day is normal, and the
  // alternative is what went wrong before: income from an afternoon shift
  // silently joining the morning's closed record, stretching its hours and
  // flattering its rate.
  //
  // The cost of this rule, deliberately accepted: uploading a straggler
  // screenshot after clocking out opens a shift rather than joining the one
  // just finished. That shows up immediately on the dashboard as "Still clocked
  // in", which is visible and fixable, where the old behaviour was silent.
  let closedAbandoned = null;
  if (open) {
    // Something is open from another day. Closed at its own clock-in, so it
    // records zero hours rather than a fabricated duration: the obvious
    // alternative, its last income record, is a row insert time rather than
    // when the delivery happened, and produced a 37-hour shift in testing.
    const { rows: closed } = await client.query(
      `update daily_cash_flow
          set clock_out = clock_in
        where id = $1
        returning record_no, clock_out`, [open.id]);
    closedAbandoned = closed[0] || null;
  }

  const weekId = await weekForDate(client, date);
  // Clocked in at the delivery when we know it. Opening at "now" put today's
  // 12:40 shift on the board at 14:46, because that is when its first record
  // happened to be pushed.
  const { rows } = await client.query(
    `insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in)
     values ($1, $2, coalesce($3::timestamptz, now())) returning id`,
    [weekId, date, occurredAt || null]);

  return {
    id: rows[0].id, createdShift: true, openedNow: true,
    openedAt: occurredAt || null, closedAbandoned
  };
}

/**
 * The shift an expense belongs to.
 *
 * An expense is bought during a shift, not on a date: the coffee at 11pm and the
 * charge at 1am belong to the shift that is running, whatever the calendar says.
 * So the open shift wins outright when there is one.
 *
 * With nothing open it falls to the most recently clocked-out shift, which is
 * the one just finished. That search is capped at the expense's own date so a
 * backdated receipt cannot attach itself to a shift worked afterwards - "most
 * recent" has to mean most recent as of the expense, not as of now.
 *
 * Unlike income this never creates a shift. Buying something is not evidence
 * that a shift was worked, and a shift invented from a receipt would carry
 * expenses against no earnings at all.
 */
async function shiftForExpense(client, date) {
  const { rows: open } = await client.query(
    `select id from daily_cash_flow
      where clock_in is not null and clock_out is null and not is_placeholder
      limit 1`);
  if (open.length) return open[0].id;

  const { rows } = await client.query(
    `select id from daily_cash_flow
      where not is_placeholder and shift_date <= $1
      order by clock_out desc nulls last, shift_date desc, id desc
      limit 1`, [date]);
  return rows[0]?.id ?? null;
}

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
    notes: optionalText(body.notes, 'notes', 4000),
    // When the delivery happened, if the screenshot showed it. Distinct from
    // created_at, which is only when the row was written.
    occurred_at: optionalMoment(body.occurredAt, 'occurredAt')
  };
}

router.post('/income', handle(async (req, res) => {
  const f = incomeFields(req.body || {});
  const record = await withTransaction(async (client) => {
    // An explicit dailyCashFlowId still wins, including an explicit null for
    // anyone who deliberately wants a loose record.
    const link = req.body.dailyCashFlowId !== undefined
      ? { id: id(req.body.dailyCashFlowId), createdShift: false, closedAbandoned: null }
      : await shiftForDateOrOpen(client, f.income_date, f.occurred_at);
    const shiftId = link.id;
    const cols = Object.keys(f).concat('daily_cash_flow_id');
    const vals = Object.values(f).concat(shiftId);
    const { rows } = await client.query(
      `insert into income_record (${cols.join(', ')})
       values (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       returning id`,
      vals
    );
    return { id: rows[0].id, link };
  });
  const { rows } = await pool.query('select * from v_income_record where id = $1', [record.id]);
  res.status(201).json({ ...rows[0], shift: record.link });
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
      : await shiftForExpense(client, f.expense_date);
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
  // Earned money, closed, and no recorded hours: a forgotten clock-out.
  // Deliberately not is_open - every one of these reads false, because a clock_out
  // exists and equals the clock_in, which is why nothing has ever surfaced them.
  if (req.query.needsClockOut === '1') {
    f.add('(not is_open and clock_out is not null and shift_hours = 0 and total_income > $)', 0);
  }
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

// ---------------------------------------------------------------------------
// Reading: weeks, months, drill-down and the per-service breakdown
// ---------------------------------------------------------------------------
// Everything below is read-only. The record screens can already create and
// correct; what was missing was any way to look at a record and the records
// underneath it without opening an edit form, and any month grain at all.

/** One week with the shifts inside it. */
router.get('/weeks', handle(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const { rows } = await pool.query(
    `select w.*,
            (select count(*)::int from daily_cash_flow d
              where d.weekly_cash_flow_id = w.id and not d.is_placeholder) as shift_count
       from v_weekly_cash_flow w
      order by start_date desc
      limit ${limit}`);
  res.json({ weeks: rows });
}));

router.get('/weeks/:id', handle(async (req, res) => {
  const weekId = id(req.params.id);
  const { rows } = await pool.query('select * from v_weekly_cash_flow where id = $1', [weekId]);
  if (!rows.length) return res.status(404).json({ error: 'No such week.' });

  const shifts = await pool.query(
    `select v.*,
            (select count(*)::int from income_record i where i.daily_cash_flow_id = v.id) as income_count,
            (select count(*)::int from expense_record e where e.daily_cash_flow_id = v.id) as expense_count
       from v_daily_cash_flow v
      where v.weekly_cash_flow_id = $1
      order by shift_date asc`, [weekId]);

  const bySource = await pool.query(
    `select source,
            round(sum(income), 2)        as income,
            sum(deliveries)::int         as deliveries,
            round(sum(hours), 2)         as hours,
            round(sum(income_timed), 2)  as income_timed,
            sum(deliveries_timed)::int   as deliveries_timed
       from v_income_by_source_day
      where day between $1 and $2
      group by source
      order by 2 desc`, [rows[0].start_date, rows[0].end_date]);

  res.json({ week: rows[0], shifts: shifts.rows, bySource: bySource.rows });
}));

/** One shift with every child record, which is the drill-down the org had. */
router.get('/shifts/:id', handle(async (req, res) => {
  const shiftId = id(req.params.id);
  const { rows } = await pool.query('select * from v_daily_cash_flow_all where id = $1', [shiftId]);
  if (!rows.length) return res.status(404).json({ error: 'No such shift.' });

  const income = await pool.query(
    `select * from v_income_record where daily_cash_flow_id = $1
      order by income_date asc, id asc`, [shiftId]);
  const expenses = await pool.query(
    `select * from expense_record where daily_cash_flow_id = $1
      order by expense_date asc, id asc`, [shiftId]);

  let week = null;
  if (rows[0].weekly_cash_flow_id) {
    const w = await pool.query('select * from v_weekly_cash_flow where id = $1', [rows[0].weekly_cash_flow_id]);
    week = w.rows[0] || null;
  }

  res.json({ shift: rows[0], week, income: income.rows, expenses: expenses.rows });
}));

/** One income record on its own, with the shift it belongs to. */
router.get('/income/:id', handle(async (req, res) => {
  const recordId = id(req.params.id);
  const { rows } = await pool.query('select * from v_income_record where id = $1', [recordId]);
  if (!rows.length) return res.status(404).json({ error: 'No such income record.' });
  let shift = null;
  if (rows[0].daily_cash_flow_id) {
    const d = await pool.query('select * from v_daily_cash_flow_all where id = $1', [rows[0].daily_cash_flow_id]);
    shift = d.rows[0] || null;
  }
  res.json({ income: rows[0], shift });
}));

/**
 * What the reporting deliberately leaves out. The pre-shift bulk import is real
 * money Patrick earned, but it hangs off one placeholder shift with no hours, so
 * including it made every rate meaningless. Reported here so the difference
 * between this and total income is explainable rather than a silent gap.
 */
router.get('/excluded', handle(async (_req, res) => {
  const { rows } = await pool.query('select * from v_excluded_bulk_import order by income desc');
  const total = rows.reduce((a, r) => a + Number(r.income), 0);
  res.json({
    bySource: rows,
    records: rows.reduce((a, r) => a + Number(r.records), 0),
    income: Number(total.toFixed(2)),
    first_date: rows.length ? rows.map(r => r.first_date).sort()[0] : null,
    last_date: rows.length ? rows.map(r => r.last_date).sort().slice(-1)[0] : null
  });
}));

/**
 * Everything the dashboard shows, in one request.
 *
 * One endpoint rather than ten, because this is the first thing loaded on a phone
 * on mobile data, and ten round trips is the difference between a glance and a wait.
 *
 * Four rules run through all of it, each one a figure this dataset would otherwise
 * get confidently wrong:
 *
 * 1. No rate is ever read from a view column. earnings_per_shift_hour and friends
 *    are CASE ... ELSE 0, so a missing denominator arrives as a confident zero -
 *    WCF-0010 serves 0 against a real $224.06 week. Every rate here is computed
 *    from its raw pair, and is null when the denominator is missing.
 *
 * 2. Comparisons are same-elapsed-days. A month that is nine days old is compared
 *    against the first nine days of last month, never against a finished one.
 *
 * 3. An hourly figure divides only income from shifts that actually have hours.
 *    Seven shifts carry earnings with no clock-out; counting their money in the
 *    numerator and not their hours in the denominator inflates the rate, and does
 *    so further every time one is missed.
 *
 * 4. Shifts and days are counted separately. Two shifts share 2026-08-25, so
 *    count(*) is shifts and count(distinct shift_date) is days. Calling either
 *    "days worked" reports 39 days in a 31-day May.
 */
router.get('/dashboard', handle(async (_req, res) => {
  const { rows: [d] } = await pool.query(
    `select (now() at time zone $1)::date                                        as today,
            date_trunc('week',  (now() at time zone $1)::date)::date            as week_start,
            date_trunc('week',  (now() at time zone $1)::date)::date - 7        as prev_week_start,
            date_trunc('month', (now() at time zone $1)::date)::date            as month_start,
            (date_trunc('month', (now() at time zone $1)::date) - interval '1 month')::date as prev_month_start,
            ((now() at time zone $1)::date - date_trunc('week',  (now() at time zone $1)::date)::date)::int  as into_week,
            ((now() at time zone $1)::date - date_trunc('month', (now() at time zone $1)::date)::date)::int  as into_month,
            extract(day from (date_trunc('month', (now() at time zone $1)::date) + interval '1 month - 1 day'))::int as days_in_month,
            to_char((now() at time zone $1)::date, 'FMMonth')                   as month_name`,
    [TZ]);

  const iso = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const shift = (isoDate, n) => {
    const x = new Date(isoDate + 'T00:00:00Z');
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };

  const today = iso(d.today);
  const weekStart = iso(d.week_start);
  const prevWeekStart = iso(d.prev_week_start);
  const monthStart = iso(d.month_start);
  const prevMonthStart = iso(d.prev_month_start);

  /** Money and counts for a date range. Rates are computed, never read. */
  const window = async (from, to) => {
    const { rows: [r] } = await pool.query(
      `select round(coalesce(sum(total_income), 0), 2)                          as income,
              round(coalesce(sum(total_expenses), 0), 2)                        as expenses,
              count(*)::int                                                     as shifts,
              count(distinct shift_date)::int                                   as days,
              round(coalesce(sum(shift_hours_exact), 0), 2)                     as hours,
              -- Only the money whose shift actually recorded hours. Rule 3.
              round(coalesce(sum(total_income) filter (where shift_hours_exact > 0), 0), 2) as income_with_hours,
              -- Named separately from the shift count because the hourly figure
              -- these only: calling 184.71 hours "across every shift" when seven of
              -- the 82 contributed none is the exact overstatement this page exists
              -- to avoid.
              count(*) filter (where shift_hours_exact > 0)::int              as shifts_with_hours
         from v_daily_cash_flow_raw
        where not is_placeholder and shift_date between $1 and $2`, [from, to]);
    return { ...r, from, to };
  };

  const [week, weekPrior, month, monthPrior, allTime] = await Promise.all([
    window(weekStart, today),
    window(prevWeekStart, shift(prevWeekStart, d.into_week)),
    window(monthStart, today),
    // least() so a 31st-of-the-month view cannot spill past the end of a short month.
    pool.query(`select least($1::date + $2::int, (date_trunc('month', $1::date) + interval '1 month - 1 day')::date)::date as e`,
      [prevMonthStart, d.into_month]).then(r => window(prevMonthStart, iso(r.rows[0].e))),
    window('2000-01-01', today)
  ]);

  // The hero. The shift row itself, not the day: DCF-0092 and DCF-0093 share
  // 2026-08-25, and summing them under the label "last shift" prints a day.
  // No income filter: a shift that genuinely earned nothing is a real shift, and
  // skipping it puts an older one under a label reading "last shift". The page
  // decides what to lead with; today with nothing on it yet is the one case it
  // steps past, because at 7am that is not a zero, it is a day not started.
  const { rows: lastShifts } = await pool.query(
    `select id, record_no, shift_date, day_of_week, is_open, clock_in, clock_out,
            shift_hours, total_income
       from v_daily_cash_flow
      order by shift_date desc, clock_in desc nulls last, id desc
      limit 4`);

  // Per service. Delivery count and income are measured identically for every
  // service; hours are not, so $ per delivery is the only fair cross-app rate.
  const { rows: bySource } = await pool.query(
    `select source,
            round(sum(income), 2) as income,
            sum(deliveries)::int  as deliveries
       from v_income_by_source_day
      group by source order by 2 desc`);
  const sourceTotal = bySource.reduce((a, b) => a + Number(b.income), 0);

  // Six months on a generated axis. Without generate_series, June 2026 - which has
  // no row at all - simply vanishes and May sits next to July, turning a nine-week
  // stop into a smooth decline.
  const { rows: months } = await pool.query(
    `select to_char(m, 'Mon') as label, m::date as month_start,
            v.total_income as income, v.days_worked as shifts,
            (m = date_trunc('month', $1::date)) as current
       from generate_series(date_trunc('month', $1::date) - interval '5 months',
                            date_trunc('month', $1::date), interval '1 month') m
       left join v_month_cash_flow v on v.month_start = m::date
      order by m`, [today]);

  // Costs read expense_record directly over the same range the tile names, so the
  // figure reconciles with the Expenses tab. v_month_cash_flow's month rows sum to
  // less than the expenses logged, because some fall on no month row at all.
  const { rows: costCats } = await pool.query(
    `select coalesce(type, 'uncategorised') as type, round(sum(amount), 2) as amount
       from expense_record where expense_date between $1 and $2
      group by 1 order by 2 desc`, [monthStart, today]);
  const { rows: [charging] } = await pool.query(
    `select max(expense_date) as last_date,
            ($1::date - max(expense_date))::int as days_ago
       from expense_record where type = 'Charging'`, [today]);

  // Things worth a minute. Each is a real state, and the wording of each depends on
  // which one it is: a shift still running is not a shift someone forgot to close.
  const { rows: needsClockOut } = await pool.query(
    `select record_no, shift_date, total_income
       from v_daily_cash_flow
      where not is_open and clock_out is not null
        and shift_hours = 0 and total_income > 0
      order by shift_date desc`);
  const { rows: neverClocked } = await pool.query(
    `select record_no, shift_date, total_income
       from v_daily_cash_flow
      where clock_in is null and clock_out is null and total_income > 0
      order by shift_date desc`);
  const { rows: [open] } = await pool.query(
    `select record_no, shift_date, clock_in, total_income
       from v_daily_cash_flow where is_open limit 1`);
  // The amount matters, not just the count. Income with no shift is counted by
  // v_income_by_source_day (which joins loosely) but invisible to every figure
  // derived from v_daily_cash_flow_raw, so an unlinked record makes two totals on
  // this page disagree. Surfacing the money is what makes that legible.
  const { rows: [unlinked] } = await pool.query(
    `select (select count(*)::int from income_record where daily_cash_flow_id is null)  as income,
            (select count(*)::int from expense_record where daily_cash_flow_id is null) as expenses,
            (select round(coalesce(sum(total_earnings), 0), 2) from income_record
              where daily_cash_flow_id is null)                                          as income_amount`);

  // Freshness. Without it, "last shift Tuesday" on a Thursday reads the same whether
  // he did not drive or the push pipeline is down.
  // Counted in weekdays, because he has never worked a weekend: measured in clock
  // hours, every Monday morning is 60 hours past Friday and the page would cry
  // "nothing new since" when nothing is wrong.
  const { rows: [fresh] } = await pool.query(
    `with last as (select max(created_at) as ts from income_record)
     select ts as last_record,
            round(extract(epoch from (now() - ts)) / 3600.0, 1) as hours_ago,
            (select count(*) from generate_series((ts at time zone $1)::date, $2::date, interval '1 day') d
              where extract(isodow from d) < 6)::int - 1 as weekdays_ago
       from last`, [TZ, today]);

  const { rows: excluded } = await pool.query('select * from v_excluded_bulk_import');
  const { rows: [firstDay] } = await pool.query(
    `select min(shift_date) as since from daily_cash_flow where not is_placeholder`);

  const rate = (num, den) => (Number(den) > 0 ? Number((Number(num) / Number(den)).toFixed(2)) : null);
  const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);

  // The hourly figure is gated, not caveated away. Below either floor it is not a
  // rate, and the page says so instead of printing one.
  const coverage = Number(allTime.income) > 0
    ? Math.round(100 * Number(allTime.income_with_hours) / Number(allTime.income)) : 0;
  const hourly = (Number(allTime.hours) >= 1 && coverage >= 60)
    ? rate(allTime.income_with_hours, allTime.hours) : null;

  res.json({
    today,
    monthName: d.month_name,
    freshness: {
      lastRecord: fresh.last_record,
      hoursAgo: fresh.hours_ago === null ? null : Number(fresh.hours_ago),
      weekdaysAgo: fresh.weekdays_ago === null ? null : Math.max(0, Number(fresh.weekdays_ago))
    },
    recentShifts: lastShifts,
    week: {
      ...week, dayOfWeek: d.into_week + 1, prior: weekPrior,
      delta: Number((Number(week.income) - Number(weekPrior.income)).toFixed(2))
    },
    month: {
      ...month, dayOfMonth: d.into_month + 1, daysInMonth: d.days_in_month, prior: monthPrior,
      delta: Number((Number(month.income) - Number(monthPrior.income)).toFixed(2))
    },
    perShift: {
      month: rate(month.income, month.shifts), monthShifts: month.shifts,
      allTime: rate(allTime.income, allTime.shifts), allShifts: allTime.shifts
    },
    perHour: {
      rate: hourly, coverage, hours: Number(allTime.hours),
      shiftsWithHours: allTime.shifts_with_hours, shifts: allTime.shifts,
      incomeWithHours: Number(allTime.income_with_hours), income: Number(allTime.income)
    },
    bySource: bySource.map(b => ({
      ...b,
      perDelivery: rate(b.income, b.deliveries),
      share: sourceTotal > 0 ? Math.round(100 * Number(b.income) / sourceTotal) : 0
    })),
    months: months.map(m => ({
      label: m.label, monthStart: iso(m.month_start), current: m.current,
      income: m.income === null ? null : Number(m.income),
      shifts: m.shifts === null ? null : Number(m.shifts)
    })),
    costs: {
      month: Number(sum(costCats, 'amount').toFixed(2)),
      categories: costCats,
      lastCharging: charging.last_date ? iso(charging.last_date) : null,
      chargingDaysAgo: charging.days_ago === null ? null : Number(charging.days_ago)
    },
    attention: {
      needsClockOut: needsClockOut.length ? {
        count: needsClockOut.length,
        income: Number(sum(needsClockOut, 'total_income').toFixed(2)),
        from: iso(needsClockOut[needsClockOut.length - 1].shift_date),
        to: iso(needsClockOut[0].shift_date)
      } : null,
      neverClocked: neverClocked.length ? {
        count: neverClocked.length,
        income: Number(sum(neverClocked, 'total_income').toFixed(2))
      } : null,
      openShift: open || null,
      unlinked: (unlinked.income || unlinked.expenses)
        ? { ...unlinked, income_amount: Number(unlinked.income_amount) } : null
    },
    scope: {
      since: firstDay.since ? iso(firstDay.since) : null,
      income: Number(allTime.income), shifts: allTime.shifts,
      excluded: excluded.length ? {
        income: Number(sum(excluded, 'income').toFixed(2)),
        records: excluded.reduce((a, r) => a + Number(r.records), 0),
        from: iso(excluded.map(r => iso(r.first_date)).sort()[0]),
        to: iso(excluded.map(r => iso(r.last_date)).sort().slice(-1)[0])
      } : null
    }
  });
}));

router.get('/months', handle(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 36, 120);
  const { rows } = await pool.query(
    `select * from v_month_cash_flow order by month_start desc limit ${limit}`);
  res.json({ months: rows });
}));

/**
 * Any day, week or month by date - the search behind "show me this week".
 *
 * The per-service rate divides income_timed rather than income, because most
 * historical records carry no Time_Taken and dividing all the money by the few
 * hours recorded reports a rate several times what was really earned. Coverage
 * is returned alongside so a thin figure can be shown as thin.
 */
router.get('/period', handle(async (req, res) => {
  const grain = String(req.query.grain || 'day').toLowerCase();
  if (!['day', 'week', 'month'].includes(grain)) {
    throw new BadRequest('grain must be day, week or month.', 'grain');
  }
  const date = requiredDate(req.query.date, 'date');

  let start, end, label;
  if (grain === 'day') {
    start = end = date;
    label = date;
  } else if (grain === 'week') {
    // Weeks start Monday here, as they do everywhere else in this schema.
    const r = await pool.query(
      `select (date_trunc('week', $1::date))::date as s,
              (date_trunc('week', $1::date) + interval '6 days')::date as e`, [date]);
    start = r.rows[0].s; end = r.rows[0].e;
    label = `Week of ${start}`;
  } else {
    const r = await pool.query(
      `select (date_trunc('month', $1::date))::date as s,
              (date_trunc('month', $1::date) + interval '1 month - 1 day')::date as e,
              to_char($1::date, 'FMMonth YYYY') as l`, [date]);
    start = r.rows[0].s; end = r.rows[0].e; label = r.rows[0].l;
  }

  const totals = await pool.query(
    `select round(coalesce(sum(total_income), 0), 2)            as total_income,
            round(coalesce(sum(total_expenses), 0), 2)          as total_expenses,
            round(coalesce(sum(total_income - total_expenses), 0), 2) as net_profit,
            round(coalesce(sum(shift_hours), 0), 2)             as shift_hours,
            round(coalesce(sum(total_active_time_hours), 0), 2) as active_hours,
            round(coalesce(sum(total_shift_miles), 0), 2)       as shift_miles,
            count(*)::int                                       as days_worked
       from v_daily_cash_flow_raw
      where not is_placeholder and shift_date between $1 and $2`, [start, end]);

  const bySource = await pool.query(
    `select source,
            round(sum(income), 2)       as income,
            sum(deliveries)::int        as deliveries,
            round(sum(hours), 2)        as hours,
            round(sum(income_timed), 2) as income_timed,
            sum(deliveries_timed)::int  as deliveries_timed
       from v_income_by_source_day
      where day between $1 and $2
      group by source
      order by 2 desc`, [start, end]);

  const shifts = await pool.query(
    `select v.*,
            (select count(*)::int from income_record i where i.daily_cash_flow_id = v.id) as income_count,
            (select count(*)::int from expense_record e where e.daily_cash_flow_id = v.id) as expense_count
       from v_daily_cash_flow v
      where shift_date between $1 and $2
      order by shift_date asc, clock_in asc nulls last`, [start, end]);

  const expenses = await pool.query(
    `select type, round(sum(amount), 2) as amount, count(*)::int as count
       from expense_record
      where expense_date between $1 and $2
      group by type order by 2 desc`, [start, end]);

  const t = totals.rows[0];
  res.json({
    grain, label, start, end,
    totals: {
      ...t,
      earnings_per_active_hour: Number(t.active_hours) > 0
        ? Number((Number(t.total_income) / Number(t.active_hours)).toFixed(2)) : null,
      earnings_per_shift_hour: Number(t.shift_hours) > 0
        ? Number((Number(t.total_income) / Number(t.shift_hours)).toFixed(2)) : null,
      earnings_per_mile: Number(t.shift_miles) > 0
        ? Number((Number(t.total_income) / Number(t.shift_miles)).toFixed(2)) : null
    },
    bySource: bySource.rows.map(r => ({
      ...r,
      per_hour: Number(r.hours) > 0
        ? Number((Number(r.income_timed) / Number(r.hours)).toFixed(2)) : null,
      coverage: Number(r.deliveries) > 0
        ? Math.round(100 * Number(r.deliveries_timed) / Number(r.deliveries)) : 0
    })),
    shifts: shifts.rows,
    expensesByType: expenses.rows
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
module.exports.shiftForDateOrOpen = shiftForDateOrOpen;
module.exports.shiftForExpense = shiftForExpense;
module.exports.weekForDate = weekForDate;
module.exports.explain = explain;
module.exports.BadRequest = BadRequest;
module.exports.requiredDate = requiredDate;
module.exports.optionalNumber = optionalNumber;
