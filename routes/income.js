/**
 * Gig income API, backed by Postgres.
 *
 * A drop-in replacement for routes/salesforce.js: same eight paths, same JSON
 * shapes, same `__c` field names. That is deliberate and temporary. Keeping the
 * contract byte-identical means public/gig.html does not change at all, so when
 * a number looks wrong during cutover the fault is in the data layer and
 * nowhere else. Renaming comes after the figures are trusted, not before.
 *
 * All reads go through the views. The tables hold no totals — see db/MAPPING.md.
 */

const express = require('express');
const router = express.Router();
const { pool, withTransaction } = require('../lib/db');

// Which system answered. gig.html used to print "live from salesforce" no
// matter what was actually serving it, which would have been a lie on screen
// the moment CRM_BACKEND flipped - and during the month both are alive, that
// label is the only way to tell at a glance.
const BACKEND = 'postgres';

// The business runs on Central time while the server runs on UTC. Every
// "this week" and "this month" boundary is resolved in this zone, not the
// server's, or a shift worked at 7pm Sunday lands in the wrong week.
const TZ = 'America/Chicago';

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(res, err, label) {
  console.error(`[${label}]`, err);
  res.status(500).json({ error: err.message });
}

// ---------------------------------------------------------------------------
// Headline totals
// ---------------------------------------------------------------------------

/**
 * This week's gross.
 *
 * Salesforce used THIS_WEEK on Income_Record__c, which starts Sunday in a
 * US-locale org and silently drops rows with a null date. /weekly-report
 * meanwhile computed Monday in Central off the weekly rollup. On 2026-05-14
 * the two reported $901.92 and $912.67 for the same week.
 *
 * v_income_by_week is the single answer: Monday-start, counting income by its
 * own date so rows never linked to a shift are still yours.
 */
router.get('/weekly', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `select coalesce(total_income, 0) as total
         from v_income_by_week
        where week_start = date_trunc('week', (now() at time zone $1)::date)::date`,
      [TZ]
    );
    res.json({ total: rows[0]?.total ?? 0, backend: BACKEND });
  } catch (e) { fail(res, e, 'Weekly'); }
});

router.get('/monthly', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `select coalesce(sum(total_earnings), 0) as total
         from income_record
        where date_trunc('month', income_date)
            = date_trunc('month', (now() at time zone $1)::date)`,
      [TZ]
    );
    res.json({ total: rows[0]?.total ?? 0, backend: BACKEND });
  } catch (e) { fail(res, e, 'Monthly'); }
});

/** Six months of totals. `mo` is 1-12 — gig.html indexes a month-name array with it. */
router.get('/trend', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `select extract(month from income_date)::int as mo,
              extract(year  from income_date)::int as yr,
              sum(total_earnings) as total
         from income_record
        where income_date >= date_trunc('month', (now() at time zone $1)::date)
                             - interval '5 months'
        group by yr, mo
        order by yr, mo`,
      [TZ]
    );
    res.json({ trend: rows });
  } catch (e) { fail(res, e, 'Trend'); }
});

// ---------------------------------------------------------------------------
// Shift clock
// ---------------------------------------------------------------------------

router.get('/shift/active', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `select id, clock_in, shift_date
         from daily_cash_flow
        where clock_in is not null and clock_out is null
        order by clock_in desc
        limit 1`
    );
    if (!rows.length) return res.json({ active: false });
    res.json({ active: true, recordId: String(rows[0].id), clockIn: rows[0].clock_in });
  } catch (e) { fail(res, e, 'Shift/Active'); }
});

/**
 * Open a shift.
 *
 * The date comes from the client's own ISO string rather than being re-derived
 * server-side, matching what routes/salesforce.js did: the phone knows which
 * day it is where Patrick is standing, and a shift started at 11pm belongs to
 * that day even when UTC has already rolled over.
 *
 * The week is created on demand. Salesforce fell back to "most recent WCF" when
 * no week covered the date, which silently filed shifts under the wrong week
 * whenever a new week hadn't been made yet.
 */
router.post('/shift/start', async (req, res) => {
  const { clockIn } = req.body || {};
  if (!clockIn) return res.status(400).json({ error: 'clockIn required' });
  if (!ISO_DATETIME.test(clockIn)) return res.status(400).json({ error: 'Invalid datetime format' });

  const shiftDate = clockIn.slice(0, 10);

  try {
    const recordId = await withTransaction(async (client) => {
      const { rows: week } = await client.query(
        `insert into weekly_cash_flow (start_date)
         values (date_trunc('week', $1::date)::date)
         on conflict (start_date) do update set start_date = excluded.start_date
         returning id`,
        [shiftDate]
      );

      const { rows } = await client.query(
        `insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in)
         values ($1, $2, $3)
         returning id`,
        [week[0].id, shiftDate, clockIn]
      );
      return rows[0].id;
    });

    res.json({ success: true, recordId: String(recordId) });
  } catch (e) {
    // The schema allows one open shift at a time; Salesforce allowed several and
    // GET /shift/active quietly returned the newest.
    if (e.constraint === 'daily_cash_flow_one_open_shift') {
      return res.status(409).json({ error: 'A shift is already open. Clock out of it first.' });
    }
    fail(res, e, 'Shift/Start');
  }
});

router.post('/shift/end', async (req, res) => {
  const { recordId, clockOut, miles } = req.body || {};
  if (!recordId || !clockOut) return res.status(400).json({ error: 'recordId and clockOut required' });
  if (!ISO_DATETIME.test(clockOut)) return res.status(400).json({ error: 'Invalid datetime format' });
  if (!/^\d+$/.test(String(recordId))) return res.status(400).json({ error: 'Invalid recordId' });

  try {
    const { rows } = await pool.query(
      `update daily_cash_flow
          set clock_out = $2, total_shift_miles = $3
        where id = $1 and clock_out is null
        returning id`,
      [recordId, clockOut, parseFloat(miles) || 0]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'No open shift with that id' });
    }
    res.json({ success: true, recordId: String(rows[0].id) });
  } catch (e) {
    if (e.constraint === 'dcf_clock_out_after_in') {
      return res.status(400).json({ error: 'Clock-out must be after clock-in' });
    }
    fail(res, e, 'Shift/End');
  }
});

// ---------------------------------------------------------------------------
// Weekly report
// ---------------------------------------------------------------------------

router.get('/weekly-report', async (req, res) => {
  try {
    const [weekRes, daysRes, lastRes] = await Promise.all([
      pool.query(
        `select start_date          as "Start_Date__c",
                end_date            as "End_Date__c",
                weekly_total_income as "Weekly_Total_Income__c",
                weekly_total_expenses as "Weekly_Total_Expenses__c",
                net_profit          as "Net_Profit__c",
                weekly_shift_hours  as "Weekly_Shift_Hours__c",
                weekly_active_hours as "Weekly_Active_Hours__c",
                earnings_per_shift_hour  as "Earnings_Per_Shift_Hour__c",
                earnings_per_active_hour as "Earnings_Per_Active_Hour__c",
                weekly_shift_miles  as "Weekly_Shift_Miles__c"
           from v_weekly_cash_flow
          where start_date = date_trunc('week', (now() at time zone $1)::date)::date`,
        [TZ]
      ),
      // Several shifts can share a date, so the day rows are grouped by date and
      // the rate recomputed from the sums — a 30-minute shift must not weigh the
      // same as a six-hour one.
      pool.query(
        `select shift_date,
                max(day_of_week)      as day_of_week,
                sum(total_income)     as income,
                sum(total_expenses)   as expenses,
                sum(shift_hours)      as shift_hours,
                sum(total_active_time_hours) as active_hours
           from v_daily_cash_flow
          where weekly_cash_flow_id = (
                  select id from weekly_cash_flow
                   where start_date = date_trunc('week', (now() at time zone $1)::date)::date)
          group by shift_date
          order by shift_date`,
        [TZ]
      ),
      pool.query(
        `select weekly_total_income     as "Weekly_Total_Income__c",
                net_profit              as "Net_Profit__c",
                earnings_per_shift_hour as "Earnings_Per_Shift_Hour__c",
                weekly_shift_hours      as "Weekly_Shift_Hours__c"
           from v_weekly_cash_flow
          where start_date = date_trunc('week', (now() at time zone $1)::date)::date
                             - interval '7 days'`,
        [TZ]
      )
    ]);

    const days = daysRes.rows.map(d => {
      const income = d.income || 0;
      const expenses = d.expenses || 0;
      const hours = d.shift_hours || 0;
      return {
        date: d.shift_date,
        // Salesforce's Day_of_Week__c carries a sort prefix ("2. Tuesday");
        // gig.html slices the first three characters for the bar labels.
        dayName: (d.day_of_week || '').replace(/^\d+\.\s*/, ''),
        income,
        expenses,
        netProfit: income - expenses,
        shiftHours: hours,
        activeHours: d.active_hours || 0,
        ratePerShiftHour: hours > 0 ? Math.round((income / hours) * 100) / 100 : 0
      };
    });

    const bestDay = days.reduce((best, d) => (!best || d.income > best.income) ? d : best, null);

    res.json({
      week: weekRes.rows[0] || null,
      days,
      bestDay,
      lastWeek: lastRes.rows[0] || null
    });
  } catch (e) { fail(res, e, 'WeeklyReport'); }
});

// ---------------------------------------------------------------------------
// Daily Production Score
//
// Carried over from routes/salesforce.js unchanged. Each metric defines `worst`
// (score 1) and `best` (score 10); direction falls out of those two values, so
// a low expense number would score high without any special casing. Score is
// linear between the bounds and clamped to [1, 10].
//
// Fixed thresholds, not percentiles: the midpoint of each should match what
// Patrick considers an average day, so the score reads as "how good was this
// day" rather than "how did it compare to recent ones".
// ---------------------------------------------------------------------------

const SCORE_METRICS = [
  { field: 'Total_Income__c',            label: 'Total Income',        worst: 100,  best: 300,  format: 'money' },
  { field: 'Net_Profit__c',              label: 'Net Profit',          worst: 80,   best: 240,  format: 'money' },
  { field: 'Earnings_Per_Shift_Hour__c', label: 'Earnings / Shift Hr', worst: 15,   best: 35,   format: 'rate'  },
  { field: 'True_Earnings_Per_Mile__c',  label: 'True $ / Mile',       worst: 0.50, best: 1.20, format: 'rate'  }
];

function scoreMetric(v, worst, best) {
  if (v === null || v === undefined || isNaN(v)) return 1;
  if (best === worst) return 5;
  const s = 1 + ((v - worst) / (best - worst)) * 9;
  return Math.max(1, Math.min(10, Math.round(s)));
}

router.get('/score', async (req, res) => {
  const date = req.query.date;
  if (!date || !ISO_DATE.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  try {
    // Every shift on the date. The additive figures are summed and the rate
    // metrics recomputed from those sums rather than averaged.
    const { rows } = await pool.query(
      `select string_agg(record_no, ' + ' order by clock_in)      as name,
              min(shift_date)                                     as date,
              min(day_of_week)                                    as day_of_week,
              min(clock_in)                                       as clock_in,
              max(clock_out)                                      as clock_out,
              count(*)::int                                       as shift_count,
              bool_or(is_open)                                    as in_progress,
              sum(total_income)                                   as total_income,
              sum(total_expenses)                                 as total_expenses,
              sum(shift_hours)                                    as shift_hours,
              sum(total_active_time_hours)                        as active_hours,
              sum(total_shift_miles)                              as shift_miles
         from v_daily_cash_flow
        where shift_date = $1`,
      [date]
    );

    const r = rows[0];
    if (!r || r.shift_count === 0) return res.json({ found: false });

    // max(clock_out) is null when any shift is still open, which is the correct
    // reading: the day has not finished.
    const totalIncome = r.total_income || 0;
    const totalExpenses = r.total_expenses || 0;
    const shiftHours = r.shift_hours || 0;
    const shiftMiles = r.shift_miles || 0;

    const dcf = {
      Name: r.name,
      Date__c: r.date,
      Day_of_Week__c: r.day_of_week,
      Clock_In__c: r.clock_in,
      Clock_Out__c: r.in_progress ? null : r.clock_out,
      shiftCount: r.shift_count,
      Total_Income__c: totalIncome,
      Total_Expenses__c: totalExpenses,
      Shift_Hours__c: shiftHours,
      Active_Time_Hours__c: r.active_hours || 0,
      Total_Shift_Miles__c: shiftMiles,
      Net_Profit__c: totalIncome - totalExpenses,
      Earnings_Per_Shift_Hour__c: shiftHours > 0 ? totalIncome / shiftHours : 0,
      True_Earnings_Per_Mile__c: shiftMiles > 0 ? totalIncome / shiftMiles : 0
    };

    const scores = {};
    let sum = 0;
    for (const m of SCORE_METRICS) {
      const s = scoreMetric(dcf[m.field], m.worst, m.best);
      scores[m.field] = s;
      sum += s;
    }

    res.json({
      found: true,
      inProgress: r.in_progress,
      dcf,
      metrics: SCORE_METRICS,
      scores,
      composite: Math.round((sum / SCORE_METRICS.length) * 10) / 10
    });
  } catch (e) { fail(res, e, 'Score'); }
});

module.exports = router;
module.exports.SCORE_METRICS = SCORE_METRICS;
module.exports.scoreMetric = scoreMetric;
