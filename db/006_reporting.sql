-- ---------------------------------------------------------------------------
-- Reporting: months, and a per-service breakdown
-- ---------------------------------------------------------------------------
-- The Salesforce org reported on months (Income by Month, Monthly Income,
-- Monthly Expense, Current Month Income) and on a Profit and Loss built from
-- income and expense summaries. Postgres had days and weeks but no month grain
-- at all, and no way to answer "what does Uber pay per hour versus DoorDash".
--
-- Both are views over what already exists. Nothing here stores a new figure, so
-- none of it can drift from the records it describes.

-- Time is sparse in the history: roughly a third of Uber records carry a
-- Time_Taken, and fewer for the others. Dividing ALL the income by that sliver
-- of hours reported Uber at $456/hr, which is nonsense that looks authoritative.
--
-- DoorDash is different again and better covered: its hours describe the whole
-- dash, so every DoorDash dollar on a day with dash time is genuinely earned
-- inside those hours.
create or replace view v_income_by_source_day as
with per_source as (
  select
    coalesce(d.shift_date, i.income_date) as day,
    i.source,
    sum(i.total_earnings)                        as income,
    count(*)                                     as deliveries,
    sum(coalesce(i.time_taken_minutes, 0)) / 60.0 as delivery_hours,
    sum(i.total_earnings) filter (where i.time_taken_minutes is not null) as delivery_income_timed,
    count(*) filter (where i.time_taken_minutes is not null)              as deliveries_timed
  from income_record i
  left join daily_cash_flow d on d.id = i.daily_cash_flow_id
  group by 1, 2
),
doordash_hours as (
  select shift_date as day,
         sum(coalesce(doordash_active_time_hours, doordash_dash_time_hours)) as hours
  from daily_cash_flow
  where not is_placeholder
  group by 1
)
select
  p.day,
  p.source,
  p.income,
  p.deliveries,
  case when p.source = 'Doordash'
       then coalesce(h.hours, 0)
       else p.delivery_hours
  end as hours,
  -- The money the hours above actually cover.
  case when p.source = 'Doordash'
       then case when coalesce(h.hours, 0) > 0 then p.income else 0 end
       else coalesce(p.delivery_income_timed, 0)
  end as income_timed,
  case when p.source = 'Doordash'
       then case when coalesce(h.hours, 0) > 0 then p.deliveries else 0 end
       else p.deliveries_timed
  end as deliveries_timed
from per_source p
left join doordash_hours h on h.day = p.day;

comment on view v_income_by_source_day is
  'Income, deliveries and hours per day per service. income_timed is the subset the hours cover - an hourly rate must divide by that, not by total income, because Time_Taken is missing on most historical records.';


-- One row per calendar month, built from the same daily view every other figure
-- comes from, so a month can never disagree with the days inside it.
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
    count(*)                     as days_worked
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
  case when shift_miles  > 0 then round(total_income / shift_miles,  2) else 0 end as true_earnings_per_mile
from months;

comment on view v_month_cash_flow is
  'One row per calendar month, aggregated from v_daily_cash_flow_raw so months and days can never disagree.';
