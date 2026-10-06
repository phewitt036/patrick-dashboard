-- ---------------------------------------------------------------------------
-- Airport and reservation rides
-- ---------------------------------------------------------------------------
-- Patrick wants to know, for certain, whether an airport ride or a reserved one
-- pays more than the ordinary ride that pops up while he drives. Nothing on a
-- record could say which kind it was, so these two flags are the whole of it.
--
-- Pixit sets is_airport when the pickup or dropoff line on the screenshot names
-- an airport, and both can be ticked by hand - on Pixit's review screen or on
-- the record here - for whatever the screenshot did not show. A reserved ride
-- to the airport is both, and the report counts it in both.
--
-- Not null, default false: every record before this existed is an ordinary ride
-- until someone says otherwise, and "unknown" would only add a third bucket that
-- the comparison has no use for.

alter table income_record
  add column if not exists is_airport boolean not null default false,
  add column if not exists is_reservation boolean not null default false;

comment on column income_record.is_airport is
  'The ride started or ended at an airport. Set by Pixit from the pickup/dropoff lines, or ticked by hand.';
comment on column income_record.is_reservation is
  'A ride booked ahead through Uber Reserve rather than one dispatched while driving. Ticked by hand.';

-- v_income_record is `select r.*` plus seven computed columns, and r.* is frozen
-- when the view is created, so new table columns never appear in it on their own
-- (008 hit this and left occurred_at out). Nothing depends on the view, so it is
-- rebuilt rather than worked around - the body is 002's, unchanged.
drop view if exists v_income_record;
create view v_income_record as
select
  r.*,
  case when coalesce(r.miles_driven, 0) > 0
       then round(r.total_earnings / r.miles_driven, 2) else 0 end as earnings_per_mile,
  case when coalesce(r.total_miles, 0) > 0
       then round(r.total_earnings / r.total_miles, 2) else 0 end  as true_earnings_per_mile,
  case when r.source in ('Uber', 'Uber Eats') then coalesce(r.amount, 0) else 0 end as uber_pay,
  case when r.source in ('Uber', 'Uber Eats') then coalesce(r.tips, 0)   else 0 end as uber_tips,
  case when r.source = 'Doordash' then coalesce(r.amount, 0) else 0 end             as doordash_pay,
  case when r.source = 'Doordash' then coalesce(r.tips, 0)   else 0 end             as doordash_tips,
  round(coalesce(r.time_taken_minutes, 0) / 60.0, 2) as time_taken_hours
from income_record r;
