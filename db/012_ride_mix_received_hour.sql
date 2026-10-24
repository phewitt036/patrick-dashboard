-- ---------------------------------------------------------------------------
-- Ride mix: an approximate hour for rides the screen gave no time
-- ---------------------------------------------------------------------------
-- Uber's Trip Details screen prints no clock time at all - duration, distance,
-- the two addresses and the pay, and nothing else - so Pixit rightly leaves
-- occurred_at empty, and 011's hour-of-day chart had 2 rides of 614 to draw.
--
-- Patrick sends each screenshot as the trip ends. On the six rides that do carry
-- a time off the screen, the record reached Patforce 1 to 4 minutes after it. So
-- for the hour chart, and nothing else, the time a record arrived stands in for
-- the time of the ride, and is marked approximate wherever it is shown.
--
-- Only when it can be trusted that far:
--   - It came from Pixit (external_id set). The Salesforce import's created_at
--     is the night of the install, and a hand-typed record can be typed any time.
--   - It arrived on the ride's own date, in Central time. A tip screenshot sent
--     the next morning says nothing about when the ride was.
--
-- REPORT ONLY. occurred_at is untouched and still the only time that decides
-- which shift a record joins - that rule (008) is why arrival time is never
-- written back: a shift begun 4 minutes after a clock-out and a straggler 625
-- minutes after one cannot be told apart by when they arrived.
--
-- create or replace keeps every column of 011 in place, in order; local_hour now
-- falls back to the arrival hour, and hour_approx, added at the end, says when.

create or replace view v_uber_ride as
select
  r.id,
  r.record_no,
  r.income_date,
  date_trunc('week', r.income_date)::date as week_start,
  nullif(r.uber_level, '')                as uber_level,
  r.is_airport,
  r.is_reservation,
  not r.is_airport and not r.is_reservation as is_regular,
  r.total_earnings,
  coalesce(r.tips, 0)                     as tips,
  coalesce(r.surge_bonus, 0) > 0          as has_surge,
  nullif(r.time_taken_minutes, 0)         as trip_minutes,
  coalesce(nullif(r.total_miles, 0), nullif(r.miles_driven, 0)) as trip_miles,
  r.occurred_at,
  (r.occurred_at at time zone 'America/Chicago')                   as occurred_local,
  extract(hour from coalesce(r.occurred_at, a.arrived_at) at time zone 'America/Chicago')::int as local_hour,
  extract(isodow from r.occurred_at at time zone 'America/Chicago')::int as local_isodow,
  r.occurred_at is null and a.arrived_at is not null               as hour_approx
from income_record r
left join daily_cash_flow d on d.id = r.daily_cash_flow_id
-- One value per ride, null when the arrival time cannot stand in (see above).
cross join lateral (
  select case when r.external_id is not null
               and (r.created_at at time zone 'America/Chicago')::date = r.income_date
              then r.created_at end as arrived_at
) a
where r.source = 'Uber'
  and not coalesce(d.is_placeholder, false);

comment on view v_uber_ride is
  'Every Uber ride, EXCLUDING the DCF-0000 bulk import. No rate columns: trip_minutes and trip_miles are NULL when not recorded, and a rate must divide the sum over only the rides that have them. local_hour is America/Chicago, from occurred_at, else (hour_approx) from when a Pixit record arrived on the ride''s own date - report only, never for shift assignment. local_isodow is from occurred_at only.';
