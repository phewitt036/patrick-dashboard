-- ---------------------------------------------------------------------------
-- A day worked is a day, not a shift
-- ---------------------------------------------------------------------------
-- Two shifts on one date counted as two days worked. May 2026 reported 39 days
-- in a 31-day month; September reported 9 where 6 dates were actually driven.
-- Anything divided by that count - and any sentence reading "N days worked" -
-- was wrong by however many double shifts the period held.
--
-- Both numbers are real and both are wanted, so both are published rather than
-- one replacing the other:
--   days_worked   - distinct dates driven. What "days worked" has always meant.
--   shifts_worked - one per clock-in. What was being printed under that name.
--
-- day_count on the weekly views is deliberately left alone. It mirrors
-- Salesforce's Day_Count__c, which was a COUNT rollup of child DCFs, and
-- reconcile.js compares the two field for field. Changing it would turn a
-- correct reconciliation red on every week holding a double shift. It is a
-- shift count that has always been misnamed; days_worked is the new, honest one.

begin;

-- Monthly. days_worked keeps its name and its position, and only its meaning is
-- corrected; shifts_worked is appended, which is all create-or-replace allows.
create or replace view v_month_cash_flow as
with months as (
  select
    date_trunc('month', shift_date)::date                              as month_start,
    (date_trunc('month', shift_date) + interval '1 month - 1 day')::date as month_end,
    sum(total_income)            as total_income,
    sum(total_expenses)          as total_expenses,
    sum(shift_hours)             as shift_hours,
    sum(total_active_time_hours) as active_hours,
    sum(total_shift_miles)       as shift_miles,
    sum(active_miles)            as active_miles,
    count(distinct shift_date)   as days_worked,
    count(*)                     as shifts_worked
  from v_daily_cash_flow_raw
  where not is_placeholder
  group by 1, 2
)
select
  month_start,
  month_end,
  to_char(month_start, 'FMMonth YYYY')      as month_label,
  round(total_income, 2)                    as total_income,
  round(total_expenses, 2)                  as total_expenses,
  round(total_income - total_expenses, 2)   as net_profit,
  round(shift_hours, 2)                     as shift_hours,
  round(active_hours, 2)                    as active_hours,
  round(shift_miles, 2)                     as shift_miles,
  round(active_miles, 2)                    as active_miles,
  days_worked,
  case when active_hours > 0 then round(total_income / active_hours, 2) else 0 end as earnings_per_active_hour,
  case when shift_hours  > 0 then round(total_income / shift_hours,  2) else 0 end as earnings_per_shift_hour,
  case when shift_miles  > 0 then round(total_income / shift_miles,  2) else 0 end as true_earnings_per_mile,
  shifts_worked
from months;

comment on view v_month_cash_flow is
  'One row per calendar month, aggregated from v_daily_cash_flow_raw so months and days can never disagree. days_worked counts dates driven; shifts_worked counts clock-ins, and the two differ on any month holding a double shift.';

-- Weekly. Appended as a subquery rather than folded into the CTE: the final
-- select is `select b.*, <computed>`, so widening base would shift every
-- computed column one place along and create-or-replace refuses that.
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
       then round(b.weekly_total_income / b.weekly_shift_miles, 2) else 0 end as true_earnings_per_mile,
  (select count(distinct r.shift_date)::int from v_daily_cash_flow_raw r
    where r.weekly_cash_flow_id = b.id) as days_worked,
  (select count(*)::int from v_daily_cash_flow_raw r
    where r.weekly_cash_flow_id = b.id) as shifts_worked
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
       then round(b.weekly_total_income / b.weekly_shift_miles, 2) else 0 end as true_earnings_per_mile,
  (select count(distinct r.shift_date)::int from v_daily_cash_flow_raw r
    where r.weekly_cash_flow_id = b.id and not r.is_placeholder) as days_worked,
  (select count(*)::int from v_daily_cash_flow_raw r
    where r.weekly_cash_flow_id = b.id and not r.is_placeholder) as shifts_worked
from base b;

comment on view v_weekly_cash_flow is
  'One row per week. day_count is the Salesforce rollup and counts child shifts - reconcile.js compares it. days_worked counts distinct dates driven; shifts_worked counts clock-ins.';

commit;
