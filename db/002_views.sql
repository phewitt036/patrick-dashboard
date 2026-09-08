-- Gig income tracker — the derived layer
--
-- Everything Salesforce computed lives here: formula fields, native rollups on
-- the weekly object, and the Apex aggregation in DailyCashFlowHandler.
--
-- The Apex existed because of a Salesforce constraint, not a business rule.
-- Income and Expense reach Daily Cash Flow through a Lookup, and native rollup
-- summaries need Master-Detail, so the totals had to be hand-maintained by a
-- trigger, a handler class and a nine-test suite. Postgres has no such
-- restriction: the whole of recalculateTotals() is a SUM in a GROUP BY below.
--
-- Formula bodies are quoted from
-- patrick-vault/Salesforce/salesforce-formulas-and-logic.md so the port can be
-- checked line by line rather than trusted.

begin;

-- ---------------------------------------------------------------------------
-- v_daily_cash_flow — replaces DailyCashFlowHandler.recalculateTotals()
--                     plus the DCF formula fields
-- ---------------------------------------------------------------------------
create or replace view v_daily_cash_flow as
with income as (
  select
    daily_cash_flow_id,
    sum(total_earnings)                        as total_income,
    sum(coalesce(miles_driven, 0))             as active_miles,
    -- Salesforce: Active_Time_Hours__c = SUM(Income_Record__c.Time_Taken__c) / 60
    sum(coalesce(time_taken_minutes, 0)) / 60.0 as active_time_hours
  from income_record
  where daily_cash_flow_id is not null
  group by daily_cash_flow_id
),
expense as (
  select
    daily_cash_flow_id,
    sum(amount) as total_expenses
  from expense_record
  where daily_cash_flow_id is not null
  group by daily_cash_flow_id
),
base as (
  select
    d.id,
    d.sf_id,
    d.record_no,
    d.weekly_cash_flow_id,
    d.shift_date,
    d.day_of_week,
    d.clock_in,
    d.clock_out,
    d.clock_out is null                                     as is_open,
    d.shift_hours,
    d.total_shift_miles,
    d.doordash_dash_time_hours,
    round(coalesce(i.total_income, 0), 2)                   as total_income,
    round(coalesce(e.total_expenses, 0), 2)                 as total_expenses,
    round(coalesce(i.active_miles, 0), 2)                   as active_miles,
    round(coalesce(i.active_time_hours, 0), 2)              as active_time_hours,
    d.created_at,
    d.updated_at
  from daily_cash_flow d
  left join income  i on i.daily_cash_flow_id = d.id
  left join expense e on e.daily_cash_flow_id = d.id
)
select
  b.*,

  -- Salesforce: BLANKVALUE(Active_Time_Hours__c,0) + BLANKVALUE(Doordash_Dash_Time__c,0)
  -- Added 2026-08-11. DoorDash reports no per-delivery time, so active_time_hours
  -- is in practice Uber time; DoorDash arrives as a per-dash figure instead.
  round(b.active_time_hours + b.doordash_dash_time_hours, 2) as total_active_time_hours,

  -- Salesforce: Total_Income__c - Total_Expenses__c
  round(b.total_income - b.total_expenses, 2)               as net_profit,

  -- Salesforce: IF(BLANKVALUE(Total_Active_Time_Hours__c,0) > 0, Total_Income__c / Total_Active_Time_Hours__c, 0)
  -- Divides by the COMBINED figure. Before that fix a DoorDash-only day divided
  -- by zero Uber hours and reported $0.00/hr against real earnings.
  case when (b.active_time_hours + b.doordash_dash_time_hours) > 0
       then round(b.total_income / (b.active_time_hours + b.doordash_dash_time_hours), 2)
       else 0 end                                           as earnings_per_active_hour,

  -- Salesforce: IF(BLANKVALUE(Shift_Hours__c,0) > 0, Total_Income__c / Shift_Hours__c, 0)
  case when b.shift_hours > 0
       then round(b.total_income / b.shift_hours, 2)
       else 0 end                                           as earnings_per_shift_hour,

  -- Salesforce: IF(BLANKVALUE(Total_Shift_Miles__c,0) > 0, Total_Income__c / Total_Shift_Miles__c, 0)
  case when b.total_shift_miles > 0
       then round(b.total_income / b.total_shift_miles, 2)
       else 0 end                                           as true_earnings_per_mile
from base b;

comment on view v_daily_cash_flow is
  'One row per shift with all totals recomputed from children. Read this, never the table, for anything with a number in it.';


-- ---------------------------------------------------------------------------
-- v_weekly_cash_flow — replaces the native rollups and the WCF formula fields
-- ---------------------------------------------------------------------------
create or replace view v_weekly_cash_flow as
with daily as (
  select
    weekly_cash_flow_id,
    sum(total_income)             as weekly_total_income,
    sum(total_expenses)           as weekly_total_expenses,
    sum(total_shift_miles)        as weekly_shift_miles,
    sum(active_miles)             as weekly_active_miles,
    sum(shift_hours)              as weekly_shift_hours,
    sum(active_time_hours)        as weekly_uber_active_hours,
    sum(total_active_time_hours)  as weekly_active_hours,
    count(*)                      as day_count
  from v_daily_cash_flow
  group by weekly_cash_flow_id
),
base as (
  select
    w.id,
    w.sf_id,
    w.record_no,
    w.start_date,
    w.end_date,
    coalesce(d.weekly_total_income, 0)      as weekly_total_income,
    coalesce(d.weekly_total_expenses, 0)    as weekly_total_expenses,
    coalesce(d.weekly_shift_miles, 0)       as weekly_shift_miles,
    coalesce(d.weekly_active_miles, 0)      as weekly_active_miles,
    coalesce(d.weekly_shift_hours, 0)       as weekly_shift_hours,
    coalesce(d.weekly_active_hours, 0)      as weekly_active_hours,
    coalesce(d.weekly_uber_active_hours, 0) as weekly_uber_active_hours,
    coalesce(d.day_count, 0)                as day_count,
    w.created_at,
    w.updated_at
  from weekly_cash_flow w
  left join daily d on d.weekly_cash_flow_id = w.id
)
select
  b.*,
  round(b.weekly_total_income - b.weekly_total_expenses, 2) as net_profit,

  -- DELIBERATE DIVERGENCE FROM SALESFORCE.
  -- Weekly_Active_Hours__c rolled up Active_Time_Hours__c, which is Uber time
  -- only. When Doordash_Dash_Time__c was added on 2026-08-11 the daily
  -- earnings-per-active-hour was switched to the combined figure, but the
  -- weekly rollup was never changed to match. So the weekly rate has been
  -- dividing by Uber hours alone and overstating $/active hour on any week
  -- containing DoorDash work — the same bug that was fixed daily, still live
  -- weekly. This divides by the combined figure.
  -- weekly_uber_active_hours is kept alongside so Phase 5 can reproduce the old
  -- number and measure how far off it was.
  case when b.weekly_active_hours > 0
       then round(b.weekly_total_income / b.weekly_active_hours, 2)
       else 0 end                                           as earnings_per_active_hour,

  case when b.weekly_shift_hours > 0
       then round(b.weekly_total_income / b.weekly_shift_hours, 2)
       else 0 end                                           as earnings_per_shift_hour,

  case when b.weekly_shift_miles > 0
       then round(b.weekly_total_income / b.weekly_shift_miles, 2)
       else 0 end                                           as true_earnings_per_mile
from base b;


-- ---------------------------------------------------------------------------
-- v_income_record — the per-row ratio formulas
-- Postgres will not let a generated column read another generated column, so
-- anything built on total_earnings lives here rather than on the table.
-- ---------------------------------------------------------------------------
create or replace view v_income_record as
select
  r.*,

  -- Salesforce: IF(BLANKVALUE(Miles_Driven__c,0) > 0, Total_Earnings__c / Miles_Driven__c, 0)
  case when coalesce(r.miles_driven, 0) > 0
       then round(r.total_earnings / r.miles_driven, 2) else 0 end as earnings_per_mile,

  -- Salesforce: IF(BLANKVALUE(Total_Miles__c,0) > 0, Total_Earnings__c / Total_Miles__c, 0)
  case when coalesce(r.total_miles, 0) > 0
       then round(r.total_earnings / r.total_miles, 2) else 0 end  as true_earnings_per_mile,

  -- The four *_Internal__c formulas. They exist so Uber and DoorDash earnings
  -- can be compared without filtering rows.
  case when r.source in ('Uber', 'Uber Eats') then coalesce(r.amount, 0) else 0 end as uber_pay,
  case when r.source in ('Uber', 'Uber Eats') then coalesce(r.tips, 0)   else 0 end as uber_tips,
  case when r.source = 'Doordash' then coalesce(r.amount, 0) else 0 end             as doordash_pay,
  case when r.source = 'Doordash' then coalesce(r.tips, 0)   else 0 end             as doordash_tips,

  -- Not a Salesforce field. The org stored minutes under an "(Hours)" label;
  -- this is the honest conversion, offered so callers never divide by 60 again.
  round(coalesce(r.time_taken_minutes, 0) / 60.0, 2) as time_taken_hours
from income_record r;


-- ---------------------------------------------------------------------------
-- v_income_by_week — the one number that had two answers
--
-- /api/income/weekly summed Income_Record__c with Salesforce's THIS_WEEK, which
-- starts Sunday in a US-locale org and silently drops rows with a null date.
-- /api/income/weekly-report read the WCF rollup, which counts everything linked
-- to the week. On 2026-05-14 they read $901.92 and $912.67 for the same week.
--
-- Both endpoints should read this. It buckets by the income date itself, so it
-- does not depend on a row having been linked to a shift, and Monday-start is
-- the same definition weekly_cash_flow enforces.
-- ---------------------------------------------------------------------------
create or replace view v_income_by_week as
select
  date_trunc('week', income_date)::date              as week_start,
  (date_trunc('week', income_date)::date + 6)        as week_end,
  count(*)                                           as record_count,
  round(sum(total_earnings), 2)                      as total_income,
  round(sum(case when source in ('Uber', 'Uber Eats') then total_earnings else 0 end), 2) as uber_income,
  round(sum(case when source = 'Doordash' then total_earnings else 0 end), 2)             as doordash_income
from income_record
group by 1;

commit;
