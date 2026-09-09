-- Placeholder shifts: containers, not days worked.
--
-- DCF-0000 is dated 2026-04-19 with no clock-in, no clock-out and no miles, and
-- it holds 1,155 income records spanning 2024-10-21 to 2026-04-19 - the history
-- bulk-loaded when the Salesforce org was built. The income is real. The shift
-- is not: nobody worked an 18-month shift on one April afternoon.
--
-- Left alone it does three wrong things. It appears in the shift list as a day
-- worked. It earns $41,359.34 across zero shift hours, so any rate derived from
-- it is meaningless. And it drops all 18 months into the single week of
-- 2026-04-13, which is the number that made all-time and weekly totals
-- disagree with each other.
--
-- So the flag is on the *shift*. Every income record stays exactly where it is
-- and still counts: /weekly and /monthly bucket by income_date, not by shift, so
-- those earnings land in the months they were actually made.
--
-- Reconciliation still has to see it, because Salesforce does. The _all views
-- below are the Salesforce-faithful ones scripts/reconcile.js reads; the plain
-- names are what the application reads, and they leave placeholders out.

begin;

alter table daily_cash_flow add column if not exists is_placeholder boolean not null default false;

comment on column daily_cash_flow.is_placeholder is
  'A container for backfilled income rather than a day worked. Excluded from the shift list and from every shift-derived rate; the income records under it still count in income totals.';

-- Backfill for what is already here: a shift with neither a clock-in nor a
-- clock-out was never a day worked. Written as the rule rather than as a
-- record number, so it catches any other of the same shape.
--
-- This is a one-off, and deliberately not a generated column or a trigger.
-- Going forward the importer sets the flag, because a shift typed in by hand
-- with the times left blank is a different thing - that is a day Patrick means
-- to come back and fill in, and it has to stay visible rather than silently
-- disappearing from the list the moment it is created.
update daily_cash_flow
   set is_placeholder = true
 where clock_in is null and clock_out is null and not is_placeholder;

-- ---------------------------------------------------------------------------
-- Base: unchanged except that it now carries the flag.
-- ---------------------------------------------------------------------------
create or replace view v_daily_cash_flow_raw as
with income as (
  select
    daily_cash_flow_id,
    sum(total_earnings)                        as total_income,
    sum(coalesce(miles_driven, 0))             as active_miles,
    sum(coalesce(time_taken_minutes, 0)) / 60.0 as active_time_hours
  from income_record
  where daily_cash_flow_id is not null
  group by daily_cash_flow_id
),
expense as (
  select daily_cash_flow_id, sum(amount) as total_expenses
  from expense_record
  where daily_cash_flow_id is not null
  group by daily_cash_flow_id
)
select
  d.id, d.sf_id, d.record_no, d.weekly_cash_flow_id, d.shift_date, d.day_of_week,
  d.clock_in, d.clock_out,
  (d.clock_in is not null and d.clock_out is null) as is_open,
  d.shift_hours, d.total_shift_miles, d.doordash_dash_time_hours,
  case
    when d.clock_out is not null and d.clock_in is not null
      then (extract(epoch from (d.clock_out - d.clock_in)) / 3600.0)::numeric
    else 0
  end as shift_hours_exact,
  coalesce(i.total_income, 0)      as total_income,
  coalesce(e.total_expenses, 0)    as total_expenses,
  coalesce(i.active_miles, 0)      as active_miles,
  coalesce(i.active_time_hours, 0) as active_time_hours,
  coalesce(i.active_time_hours, 0) + d.doordash_dash_time_hours as total_active_time_hours,
  d.created_at, d.updated_at,
  d.is_placeholder
from daily_cash_flow d
left join income  i on i.daily_cash_flow_id = d.id
left join expense e on e.daily_cash_flow_id = d.id;

-- ---------------------------------------------------------------------------
-- v_daily_cash_flow_all — every shift, placeholders included. Reconciliation
-- reads this, because the Salesforce org it is being compared against has
-- DCF-0000 in it and a faithful comparison has to as well.
-- ---------------------------------------------------------------------------
create or replace view v_daily_cash_flow_all as
select
  b.id, b.sf_id, b.record_no, b.weekly_cash_flow_id, b.shift_date, b.day_of_week,
  b.clock_in, b.clock_out, b.is_open, b.shift_hours, b.total_shift_miles,
  b.doordash_dash_time_hours,
  round(b.total_income, 2)            as total_income,
  round(b.total_expenses, 2)          as total_expenses,
  round(b.active_miles, 2)            as active_miles,
  round(b.active_time_hours, 2)       as active_time_hours,
  round(b.total_active_time_hours, 2) as total_active_time_hours,
  round(b.total_income - b.total_expenses, 2) as net_profit,
  case when b.total_active_time_hours > 0
       then round(b.total_income / b.total_active_time_hours, 2) else 0 end as earnings_per_active_hour,
  case when b.shift_hours_exact > 0
       then round(b.total_income / b.shift_hours_exact, 2) else 0 end as earnings_per_shift_hour,
  case when b.total_shift_miles > 0
       then round(b.total_income / b.total_shift_miles, 2) else 0 end as true_earnings_per_mile,
  b.is_placeholder
from v_daily_cash_flow_raw b;

-- What the application reads: days actually worked.
create or replace view v_daily_cash_flow as
select * from v_daily_cash_flow_all where not is_placeholder;

comment on view v_daily_cash_flow is
  'One row per shift worked, all totals recomputed from children. Placeholders excluded - use v_daily_cash_flow_all to include them. Read this, never the table, for anything with a number in it.';

-- ---------------------------------------------------------------------------
-- Weekly. Two views over the same aggregation, differing only in whether
-- placeholder shifts are counted. A week holding DCF-0000 also holds real
-- shifts, so this filters the shifts, not the weeks.
-- ---------------------------------------------------------------------------
create or replace view v_weekly_cash_flow_all as
with daily as (
  select
    weekly_cash_flow_id,
    sum(total_income) as weekly_total_income, sum(total_expenses) as weekly_total_expenses,
    sum(total_shift_miles) as weekly_shift_miles, sum(active_miles) as weekly_active_miles,
    sum(shift_hours) as weekly_shift_hours, sum(active_time_hours) as weekly_uber_active_hours,
    sum(total_active_time_hours) as weekly_active_hours, count(*) as day_count
  from v_daily_cash_flow_raw
  group by weekly_cash_flow_id
),
base as (
  select w.id, w.sf_id, w.record_no, w.start_date, w.end_date,
    coalesce(d.weekly_total_income, 0) as weekly_total_income,
    coalesce(d.weekly_total_expenses, 0) as weekly_total_expenses,
    coalesce(d.weekly_shift_miles, 0) as weekly_shift_miles,
    coalesce(d.weekly_active_miles, 0) as weekly_active_miles,
    coalesce(d.weekly_shift_hours, 0) as weekly_shift_hours,
    coalesce(d.weekly_active_hours, 0) as weekly_active_hours,
    coalesce(d.weekly_uber_active_hours, 0) as weekly_uber_active_hours,
    coalesce(d.day_count, 0) as day_count, w.created_at, w.updated_at
  from weekly_cash_flow w left join daily d on d.weekly_cash_flow_id = w.id
)
select b.*,
  round(b.weekly_total_income - b.weekly_total_expenses, 2) as net_profit,
  case when b.weekly_active_hours > 0
       then round(b.weekly_total_income / b.weekly_active_hours, 2) else 0 end as earnings_per_active_hour,
  case when b.weekly_shift_hours > 0
       then round(b.weekly_total_income / b.weekly_shift_hours, 2) else 0 end as earnings_per_shift_hour,
  case when b.weekly_shift_miles > 0
       then round(b.weekly_total_income / b.weekly_shift_miles, 2) else 0 end as true_earnings_per_mile
from base b;

create or replace view v_weekly_cash_flow as
with daily as (
  select
    weekly_cash_flow_id,
    sum(total_income) as weekly_total_income, sum(total_expenses) as weekly_total_expenses,
    sum(total_shift_miles) as weekly_shift_miles, sum(active_miles) as weekly_active_miles,
    sum(shift_hours) as weekly_shift_hours, sum(active_time_hours) as weekly_uber_active_hours,
    sum(total_active_time_hours) as weekly_active_hours, count(*) as day_count
  from v_daily_cash_flow_raw
  where not is_placeholder
  group by weekly_cash_flow_id
),
base as (
  select w.id, w.sf_id, w.record_no, w.start_date, w.end_date,
    coalesce(d.weekly_total_income, 0) as weekly_total_income,
    coalesce(d.weekly_total_expenses, 0) as weekly_total_expenses,
    coalesce(d.weekly_shift_miles, 0) as weekly_shift_miles,
    coalesce(d.weekly_active_miles, 0) as weekly_active_miles,
    coalesce(d.weekly_shift_hours, 0) as weekly_shift_hours,
    coalesce(d.weekly_active_hours, 0) as weekly_active_hours,
    coalesce(d.weekly_uber_active_hours, 0) as weekly_uber_active_hours,
    coalesce(d.day_count, 0) as day_count, w.created_at, w.updated_at
  from weekly_cash_flow w left join daily d on d.weekly_cash_flow_id = w.id
)
select b.*,
  round(b.weekly_total_income - b.weekly_total_expenses, 2) as net_profit,
  case when b.weekly_active_hours > 0
       then round(b.weekly_total_income / b.weekly_active_hours, 2) else 0 end as earnings_per_active_hour,
  case when b.weekly_shift_hours > 0
       then round(b.weekly_total_income / b.weekly_shift_hours, 2) else 0 end as earnings_per_shift_hour,
  case when b.weekly_shift_miles > 0
       then round(b.weekly_total_income / b.weekly_shift_miles, 2) else 0 end as true_earnings_per_mile
from base b;

commit;
