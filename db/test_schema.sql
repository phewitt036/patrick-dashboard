-- Schema regression tests.
--
-- These check the port against what the Salesforce org actually did, using the
-- worked examples recorded in patrick-vault/Salesforce/ — the 1.00h + 1.28h
-- combined-time example, the handler test's 30 minutes -> 0.50 hours, and the
-- 2026-05-14 stale-total incident that this schema is shaped to prevent.
--
-- Run against a scratch database:
--   psql -d gig -f db/001_tables.sql -f db/002_views.sql -f db/test_schema.sql

-- Records are looked up by date, never by record_no: sequences are not
-- transactional, so the rollback at the end leaves them advanced and a second
-- run would mint DCF-0003 where the first minted DCF-0001. Gaps in record
-- numbers are normal and expected in production for the same reason.

\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages to notice;

create or replace function assert_eq(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is not distinct from want then
    raise notice 'PASS  %', label;
  else
    raise exception 'FAIL  % — got %, want %', label, got, want;
  end if;
end;
$$;

create or replace function assert_rejects(label text, stmt text)
returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'PASS  % (rejected: %)', label, replace(split_part(SQLERRM, E'\n', 1), 'new row for relation ', '');
    return;
  end;
  raise exception 'FAIL  % — statement was accepted but should have been rejected', label;
end;
$$;

begin;

-- These assertions read the views unqualified in places, so a database with
-- other rows in it produces "more than one row returned by a subquery" rather
-- than a useful failure. Say so plainly instead.
do $$
begin
  if exists (select 1 from daily_cash_flow) or exists (select 1 from income_record) then
    raise exception 'test_schema.sql needs an empty database. Create a scratch one: createdb gigtest && psql -d gigtest -f db/001_tables.sql -f db/002_views.sql';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixture: one Monday week, one shift, Uber + DoorDash income, one expense.
-- Mirrors the vault's worked example: 1.00h Uber + 1.28h DoorDash = 2.28h.
-- ---------------------------------------------------------------------------
insert into weekly_cash_flow (start_date) values ('2026-05-11');  -- a Monday

insert into daily_cash_flow
  (weekly_cash_flow_id, shift_date, clock_in, clock_out, total_shift_miles, doordash_dash_time_hours)
values
  ((select id from weekly_cash_flow where start_date = '2026-05-11'),
   '2026-05-12',
   '2026-05-12 10:00:00-05', '2026-05-12 16:00:00-05',   -- 6.00 shift hours
   120.00,
   1.28);                                                 -- DoorDash dash time

-- Uber: 30 + 30 minutes = 60 minutes = 1.00 active hour
insert into income_record
  (daily_cash_flow_id, income_date, source, amount, tips, surge_bonus, miles_driven, total_miles, time_taken_minutes)
values
  ((select id from daily_cash_flow where shift_date = '2026-05-12'),
   '2026-05-12', 'Uber Eats', 10.00, 5.00, 2.50, 8.00, 12.00, 30.0),
  ((select id from daily_cash_flow where shift_date = '2026-05-12'),
   '2026-05-12', 'Uber', 12.00, 3.00, null, 6.00, 9.00, 30.0),
  -- DoorDash carries no per-delivery time; its hours arrive on the shift instead
  ((select id from daily_cash_flow where shift_date = '2026-05-12'),
   '2026-05-12', 'Doordash', 7.25, 3.50, null, 5.00, 7.50, null);

insert into expense_record (daily_cash_flow_id, expense_date, amount, type)
values ((select id from daily_cash_flow where shift_date = '2026-05-12'),
        '2026-05-12', 8.25, 'Charging');

-- ---------------------------------------------------------------------------
-- Formula fidelity
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- formulas ---'

-- Total_Earnings__c = base + tips + surge
select assert_eq('income total_earnings sums base+tips+surge',
  (select total_earnings from income_record where amount = 10.00), 17.50::numeric);

-- The handler test asserted 30 minutes -> 0.50 hours
select assert_eq('30 minutes reads as 0.50 hours',
  (select time_taken_hours from v_income_record where amount = 10.00), 0.50::numeric);

-- Apex recalculateTotals equivalent
select assert_eq('daily total_income sums its income rows',
  (select total_income from v_daily_cash_flow), 43.25::numeric);
select assert_eq('daily total_expenses sums its expense rows',
  (select total_expenses from v_daily_cash_flow), 8.25::numeric);
select assert_eq('daily active_miles sums miles_driven',
  (select active_miles from v_daily_cash_flow), 19.00::numeric);

-- Active_Time_Hours__c = SUM(Time_Taken__c)/60 — Uber time in practice
select assert_eq('active_time_hours is Uber minutes over 60',
  (select active_time_hours from v_daily_cash_flow), 1.00::numeric);

-- The vault's worked example, exactly
select assert_eq('total_active_time_hours = 1.00 Uber + 1.28 DoorDash',
  (select total_active_time_hours from v_daily_cash_flow), 2.28::numeric);

select assert_eq('shift_hours from clock in/out',
  (select shift_hours from v_daily_cash_flow), 6.00::numeric);
select assert_eq('net_profit = income - expenses',
  (select net_profit from v_daily_cash_flow), 35.00::numeric);
select assert_eq('earnings_per_active_hour divides by COMBINED hours',
  (select earnings_per_active_hour from v_daily_cash_flow), round(43.25/2.28, 2));
select assert_eq('earnings_per_shift_hour',
  (select earnings_per_shift_hour from v_daily_cash_flow), round(43.25/6.00, 2));
select assert_eq('true_earnings_per_mile',
  (select true_earnings_per_mile from v_daily_cash_flow), round(43.25/120.00, 2));

-- Day_of_Week__c reproduced, prefix and all. 2026-05-12 is a Tuesday.
select assert_eq('day_of_week matches the Salesforce CASE output',
  (select day_of_week from v_daily_cash_flow), '2. Tuesday');

-- End_Date__c = Start_Date__c + 6
select assert_eq('week end date is start + 6',
  (select end_date from weekly_cash_flow), '2026-05-17'::date);

-- Platform split (the four *_Internal__c formulas)
select assert_eq('uber_pay excludes DoorDash rows',
  (select sum(uber_pay) from v_income_record), 22.00::numeric);
select assert_eq('doordash_pay excludes Uber rows',
  (select sum(doordash_pay) from v_income_record), 7.25::numeric);

-- ---------------------------------------------------------------------------
-- The DoorDash-only day that used to report $0.00/hr
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- DoorDash-only day ---'

insert into daily_cash_flow
  (weekly_cash_flow_id, shift_date, clock_in, clock_out, total_shift_miles, doordash_dash_time_hours)
values
  ((select id from weekly_cash_flow where start_date = '2026-05-11'),
   '2026-05-13', '2026-05-13 11:00:00-05', '2026-05-13 13:00:00-05', 30.00, 2.00);

insert into income_record
  (daily_cash_flow_id, income_date, source, amount, tips, miles_driven, total_miles)
values
  ((select id from daily_cash_flow where shift_date = '2026-05-13'),
   '2026-05-13', 'Doordash', 20.00, 10.00, 15.00, 22.00);

select assert_eq('DoorDash-only day has zero Uber hours',
  (select active_time_hours from v_daily_cash_flow where shift_date = '2026-05-13'), 0.00::numeric);
select assert_eq('...but still reports a real hourly rate, not $0.00',
  (select earnings_per_active_hour from v_daily_cash_flow where shift_date = '2026-05-13'), 15.00::numeric);

-- ---------------------------------------------------------------------------
-- The 2026-05-14 incident: a deleted child left a stale parent total
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- stale totals after delete (DCF-0040 / $10.75) ---'

select assert_eq('weekly total before the delete',
  (select weekly_total_income from v_weekly_cash_flow), 73.25::numeric);

-- 7.25 base + 3.50 tips = $10.75, the same figure as INC-1343 in the incident.
delete from income_record where amount = 7.25 and source = 'Doordash';

select assert_eq('daily total drops the moment the child goes',
  (select total_income from v_daily_cash_flow where shift_date = '2026-05-12'), 32.50::numeric);
select assert_eq('weekly total follows, with no trigger to forget',
  (select weekly_total_income from v_weekly_cash_flow), 62.50::numeric);

-- ---------------------------------------------------------------------------
-- The weekly earnings-per-active-hour divergence
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- weekly active hours ---'

select assert_eq('weekly_active_hours counts DoorDash dash time',
  (select weekly_active_hours from v_weekly_cash_flow), 4.28::numeric);
select assert_eq('weekly_uber_active_hours preserves the old Salesforce figure',
  (select weekly_uber_active_hours from v_weekly_cash_flow), 1.00::numeric);
select assert_eq('the old rollup would have overstated the rate this much',
  (select round(62.50/1.00 - 62.50/4.28, 2)), 47.90::numeric);

-- ---------------------------------------------------------------------------
-- Constraints Salesforce did not enforce
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- constraints ---'

select assert_rejects('a Sunday-start week is unrepresentable',
  $$insert into weekly_cash_flow (start_date) values ('2026-05-10')$$);

select assert_rejects('clock out before clock in',
  $$insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in, clock_out)
    values ((select id from weekly_cash_flow limit 1), '2026-05-14',
            '2026-05-14 18:00:00-05', '2026-05-14 09:00:00-05')$$);

select assert_rejects('an unknown income source',
  $$insert into income_record (income_date, source, amount)
    values ('2026-05-14', 'Grubhub', 10.00)$$);

select assert_rejects('an Uber level on a DoorDash row',
  $$insert into income_record (income_date, source, amount, uber_level)
    values ('2026-05-14', 'Doordash', 10.00, 'UberX')$$);

select assert_rejects('an unknown expense type',
  $$insert into expense_record (expense_date, amount, type)
    values ('2026-05-14', 5.00, 'Parking')$$);

-- Two open shifts at once. The first insert must succeed, the second must not.
insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in)
values ((select id from weekly_cash_flow limit 1), '2026-05-14', '2026-05-14 09:00:00-05');

select assert_rejects('a second shift open at the same time',
  $$insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in)
    values ((select id from weekly_cash_flow limit 1), '2026-05-14', '2026-05-14 10:00:00-05')$$);

-- A legitimate zero base pay must still insert: a cancellation can pay 0 + tip.
insert into income_record (income_date, source, amount, tips)
values ('2026-05-14', 'Uber Eats', 0.00, 3.00);
select assert_eq('zero base pay with a tip is allowed',
  (select total_earnings from income_record where amount = 0.00), 3.00::numeric);

-- ---------------------------------------------------------------------------
-- The two-answers problem
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- one week, one answer ---'

-- An income row that was never linked to a shift. Salesforce's THIS_WEEK query
-- would have dropped it if its date were null; the weekly rollup would have
-- missed it either way because it has no parent.
insert into income_record (income_date, source, amount, tips)
values ('2026-05-12', 'Uber', 4.00, 1.00);

select assert_eq('unlinked income still lands in the right week',
  (select total_income from v_income_by_week where week_start = '2026-05-11'), 70.50::numeric);
select assert_eq('...and the weekly rollup, which walks shifts, does not see it',
  (select weekly_total_income from v_weekly_cash_flow), 62.50::numeric);

-- ---------------------------------------------------------------------------
-- Placeholder shifts
-- ---------------------------------------------------------------------------
\echo ''
\echo '--- a container is not a day worked ---'

-- The shape of DCF-0000: dated, but never clocked into, holding backfilled
-- income from months that have nothing to do with that date.
-- Set explicitly, the way scripts/import-export.js sets it. Not derived from
-- the missing times: a shift typed in by hand with the times left blank is a
-- day still to be filled in, and the assertion below holds it visible.
insert into daily_cash_flow (weekly_cash_flow_id, shift_date, is_placeholder)
  select id, '2026-05-15', true from weekly_cash_flow where start_date = '2026-05-11';

insert into income_record (daily_cash_flow_id, income_date, source, amount)
  select id, '2024-11-02', 'Uber', 500.00 from daily_cash_flow where shift_date = '2026-05-15';

select assert_eq('the application does not see it as a shift',
  (select count(*) from v_daily_cash_flow where shift_date = '2026-05-15'), 0::bigint);
select assert_eq('...but reconciliation still does',
  (select count(*) from v_daily_cash_flow_all where shift_date = '2026-05-15'), 1::bigint);

select assert_eq('its income stays out of the weekly rollup the app reads',
  (select weekly_total_income from v_weekly_cash_flow), 62.50::numeric);
select assert_eq('...and stays in the one reconciliation reads',
  (select weekly_total_income from v_weekly_cash_flow_all), 562.50::numeric);

-- The point of keeping the rows: the money is still counted, in the month it
-- was actually earned rather than the month the placeholder is dated.
select assert_eq('the income still counts, in its own week',
  (select total_income from v_income_by_week where week_start = '2024-10-28'), 500.00::numeric);

-- The other half of the rule. A day with no times that nobody flagged is a
-- shift waiting to be filled in, not a container, and it must not vanish.
insert into daily_cash_flow (weekly_cash_flow_id, shift_date)
  select id, '2026-05-16' from weekly_cash_flow where start_date = '2026-05-11';
select assert_eq('a hand-made shift with blank times stays visible',
  (select count(*) from v_daily_cash_flow where shift_date = '2026-05-16'), 1::bigint);

\echo ''
\echo 'All schema tests passed.'

rollback;
