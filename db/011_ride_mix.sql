-- ---------------------------------------------------------------------------
-- Ride mix: one row per Uber ride, ready to be grouped
-- ---------------------------------------------------------------------------
-- Patrick wants to see which products (UberX, Comfort, XL...) actually pay best,
-- how that moves week to week, and which hours and weekdays pay most. Every one
-- of those is a GROUP BY over the same set of rides, so the set is defined once,
-- here, and the three groupings are written in routes/records.js.
--
-- Which rides. Uber only, the same set /ride-types compares: an Uber Eats order
-- can carry a level (the export has UberX on a few), but a delivery is not a
-- ride, and mixing them in would make "UberX" mean two different jobs. The bulk
-- import is left out exactly as 007 leaves it out of v_income_by_source_day -
-- a left join, so a ride never linked to a shift stays in, and only rows on a
-- placeholder go.
--
-- What it does NOT carry is a rate. The views before this one compute rates as
-- `case when den > 0 then num / den else 0 end`, so a ride with no trip time
-- reads as $0.00/hr - a confident figure for something that was never measured.
-- Here a missing denominator is NULL, never 0, and the route divides sums of
-- these columns itself, over only the rides that have the denominator.
--
-- Read-only: a view, nothing stored, and nothing about which shift a ride
-- belongs to is touched.

create or replace view v_uber_ride as
select
  r.id,
  r.record_no,
  r.income_date,
  -- Monday-start, as every week in this schema is.
  date_trunc('week', r.income_date)::date as week_start,
  -- As stored, so a row here and the Income tab's level filter (an exact match)
  -- always agree about which rides are "Comfort". Blank is no level at all.
  nullif(r.uber_level, '')                as uber_level,
  r.is_airport,
  r.is_reservation,
  not r.is_airport and not r.is_reservation as is_regular,
  r.total_earnings,
  coalesce(r.tips, 0)                     as tips,
  coalesce(r.surge_bonus, 0) > 0          as has_surge,
  -- Trip time off the receipt. 0 is how an untimed ride was often written in
  -- Salesforce, and no ride takes no time, so it is unmeasured like null.
  nullif(r.time_taken_minutes, 0)         as trip_minutes,
  -- The whole trip including the drive to the pickup when the receipt shows it,
  -- the paid leg alone when that is all there is.
  coalesce(nullif(r.total_miles, 0), nullif(r.miles_driven, 0)) as trip_miles,
  -- Only since about 2026-09-10 (migration 008); NULL on everything before.
  -- Local wall-clock time, because "6pm" means 6pm where he drives.
  r.occurred_at,
  (r.occurred_at at time zone 'America/Chicago')                   as occurred_local,
  extract(hour   from r.occurred_at at time zone 'America/Chicago')::int as local_hour,
  extract(isodow from r.occurred_at at time zone 'America/Chicago')::int as local_isodow
from income_record r
left join daily_cash_flow d on d.id = r.daily_cash_flow_id
where r.source = 'Uber'
  and not coalesce(d.is_placeholder, false);

comment on view v_uber_ride is
  'Every Uber ride, EXCLUDING the DCF-0000 bulk import. No rate columns: trip_minutes and trip_miles are NULL when not recorded, and a rate must divide the sum over only the rides that have them. local_hour/local_isodow are America/Chicago and NULL before occurred_at existed (about 2026-09-10).';
