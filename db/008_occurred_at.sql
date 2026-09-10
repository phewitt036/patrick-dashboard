-- ---------------------------------------------------------------------------
-- When the delivery actually happened
-- ---------------------------------------------------------------------------
-- An income record has only ever carried a DATE, so the only clock the app had
-- was created_at: when the row was written. That is the upload time, and it is
-- a poor stand-in for the delivery.
--
-- It broke shift assignment in a way no time-based rule could fix. Measured
-- against the real data: a genuinely new shift has started as little as 4
-- minutes after a clock-out (DCF-0091, 2026-08-24), while a straggler for the
-- shift just finished has arrived as late as 625 minutes after it. Those two
-- ranges overlap completely, so "how long since the clock-out" cannot tell a
-- late upload from a new shift. The delivery's own time can.
--
-- Nullable, and everything keeps working without it. Nothing historical has one,
-- and a screenshot showing no time still pushes fine - assignment simply falls
-- back to the older rules.
--
-- Deliberately NOT added to v_income_record. That view is `select r.*, ...`
-- followed by seven computed columns, and a new table column lands before them,
-- which create-or-replace cannot do - it can only append. Nothing needs it in
-- the view yet.

alter table income_record
  add column if not exists occurred_at timestamptz;

comment on column income_record.occurred_at is
  'When the delivery happened, read off the screenshot - not when the row was written (created_at). NULL when the screenshot showed no time. Used to attach a record to the shift whose clock-in/clock-out window contains it.';

-- Guards against a misread screenshot filing a delivery under the wrong day:
-- the moment has to fall on, or adjacent to, the date the record claims. A day
-- either side, because a shift can start before midnight and end after it, and
-- because the two are recorded in local time.
alter table income_record
  drop constraint if exists income_occurred_near_its_date;
alter table income_record
  add constraint income_occurred_near_its_date
  check (
    occurred_at is null
    or (occurred_at >= (income_date - 1)::timestamptz
        and occurred_at < (income_date + 2)::timestamptz)
  );

-- The lookup this exists for runs on every pushed record.
create index if not exists income_record_occurred_at_idx
  on income_record (occurred_at)
  where occurred_at is not null;
