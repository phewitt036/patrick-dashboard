-- ---------------------------------------------------------------------------
-- Keep the bulk import out of the per-service reporting
-- ---------------------------------------------------------------------------
-- DCF-0000 is the placeholder shift, and it holds 1,155 income records worth
-- $41,359 dated from 2024-10-21 to 2026-04-19: everything that existed before
-- shifts were being recorded, loaded in one go and hung off a single dated
-- placeholder. It carries 0.67 hours between all of it.
--
-- The daily, weekly and monthly views already exclude placeholders, which is why
-- a month reads $723.32 for April rather than tens of thousands. v_income_by_
-- source_day did not, so it alone reported $46,924 against everything else's
-- $5,565, and it is the view the per-service rates are drawn from. An hourly
-- rate built on eighteen months of untimed money is not a rate.
--
-- The records are not deleted or altered. Reconciliation still reads the _all
-- views and still sees them, because the Salesforce org has them too and a
-- faithful comparison has to. They are excluded from reporting, not from
-- history.
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
  -- Income with no shift at all is still real and stays; only the placeholder
  -- goes. `coalesce` because a null join is not a placeholder.
  where not coalesce(d.is_placeholder, false)
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
  'Income, deliveries and hours per day per service, EXCLUDING the DCF-0000 bulk import. income_timed is the subset the hours cover - an hourly rate must divide by that, not by total income.';

-- What was set aside, so it is excluded rather than silently missing. Anything
-- hanging off a placeholder shift lands here.
create or replace view v_excluded_bulk_import as
select
  i.source,
  count(*)::int              as records,
  round(sum(i.total_earnings), 2) as income,
  min(i.income_date)         as first_date,
  max(i.income_date)         as last_date
from income_record i
join daily_cash_flow d on d.id = i.daily_cash_flow_id
where d.is_placeholder
group by i.source;

comment on view v_excluded_bulk_import is
  'The pre-shift bulk import held on placeholder shifts. Excluded from reporting; shown so the gap between reported income and total income is explainable.';
