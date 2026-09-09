-- ---------------------------------------------------------------------------
-- DoorDash active time, kept apart from dash time
-- ---------------------------------------------------------------------------
-- DoorDash reports two figures for a dash. "Dash time" is the whole window you
-- were logged on, including sitting waiting for the next offer. "Active time"
-- is the part spent driving to a pickup and delivering it.
--
-- Only dash time was captured, and it was added to Uber's active time to make
-- Total_Active_Time_Hours__c. Those two are not the same measurement: Uber's
-- figure is the sum of Time_Taken__c across deliveries, which counts only time
-- on a delivery. So the DoorDash side carried waiting time the Uber side never
-- did, inflating the denominator and understating every DoorDash day's rate.
--
-- On 2026-08-27: $44.55 over a reported 3.00 hours reads $14.85/hr, when 1h30
-- of the first dash's 2h was actually driving.
--
-- Dash time stays. It is the honest answer to how long he was out, and it is
-- what Salesforce holds, so reconciliation still has something to compare.
--
-- NULL means not known, which is different from zero. Every imported row is
-- NULL, so the rate below falls back to dash time and reproduces the old
-- number exactly. Only records pushed after this migration carry active time,
-- which is why the cutover reconciliation is unaffected.

alter table daily_cash_flow
  add column if not exists doordash_active_time_hours numeric(6,2);

alter table daily_cash_flow
  drop constraint if exists dcf_active_time_not_negative;
alter table daily_cash_flow
  add constraint dcf_active_time_not_negative
  check (doordash_active_time_hours is null or doordash_active_time_hours >= 0);

-- Active time can never exceed the window it is measured inside. A screenshot
-- reporting otherwise has been misread, and that is worth failing on.
alter table daily_cash_flow
  drop constraint if exists dcf_active_time_within_dash_time;
alter table daily_cash_flow
  add constraint dcf_active_time_within_dash_time
  check (doordash_active_time_hours is null
         or doordash_dash_time_hours = 0
         or doordash_active_time_hours <= doordash_dash_time_hours);

comment on column daily_cash_flow.doordash_active_time_hours is
  'DoorDash active time in hours - driving to pickup and delivering, excluding waiting. NULL means not captured; the rate views fall back to doordash_dash_time_hours.';

-- Replaced, not edited in place: the raw view's total_active_time_hours now
-- prefers active time and falls back to dash time. Column names, types and
-- order are unchanged except for the new column appended at the end, so every
-- dependent view keeps working and picks the new figure up automatically.
create or replace view v_daily_cash_flow_raw as
with income as (
  select daily_cash_flow_id,
         sum(total_earnings)                     as total_income,
         sum(coalesce(miles_driven, 0))          as active_miles,
         sum(coalesce(time_taken_minutes, 0)) / 60.0 as active_time_hours
  from income_record
  where daily_cash_flow_id is not null
  group by daily_cash_flow_id
), expense as (
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
  -- The one line this migration exists for.
  coalesce(i.active_time_hours, 0)
    + coalesce(d.doordash_active_time_hours, d.doordash_dash_time_hours)
                                   as total_active_time_hours,
  d.created_at, d.updated_at,
  d.is_placeholder,
  d.doordash_active_time_hours
from daily_cash_flow d
left join income  i on i.daily_cash_flow_id = d.id
left join expense e on e.daily_cash_flow_id = d.id;

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
  b.is_placeholder,
  b.doordash_active_time_hours
from v_daily_cash_flow_raw b;

create or replace view v_daily_cash_flow as
select * from v_daily_cash_flow_all where not is_placeholder;
