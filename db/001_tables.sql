-- Gig income tracker — base tables
--
-- Ported from the Salesforce dev org (patsdelivery-dev-ed), following
-- patrick-vault/Salesforce/salesforce-data-model.md.
--
-- ONE RULE RUNS THROUGH THIS FILE: tables hold only what somebody typed in or a
-- device measured. Everything derived lives in 002_views.sql. In Salesforce the
-- daily totals were plain fields kept in step by Apex, and on 2026-05-14 they
-- drifted — a deleted income record left DCF-0040 holding $10.75 with no
-- children, and the weekly rollup inherited it. A number that cannot be written
-- cannot go stale, so none of the totals are stored here.
--
-- The exception is row-level arithmetic over a row's own stored columns, which
-- is a GENERATED column: still unwritable, but indexable and cheap.

begin;

-- Auto-number replacements. Salesforce minted WCF-0001, DCF-0040, INC-1343;
-- keeping the format means old record numbers in notes still mean something.
-- Import sets these from Salesforce, then setval() moves the sequence past the
-- highest imported number so new rows carry on where the org left off.
create sequence weekly_cash_flow_no_seq;
create sequence daily_cash_flow_no_seq;
create sequence income_record_no_seq;
create sequence expense_record_no_seq;

-- Restricted picklists, as CHECKs rather than enums: adding a value later is a
-- one-line ALTER instead of a type migration.
-- Source and Expense Type values are from the vault, verbatim, including the
-- lowercase 'other' on Source.


-- ---------------------------------------------------------------------------
-- Weekly Cash Flow
-- ---------------------------------------------------------------------------
create table weekly_cash_flow (
  id          bigint generated always as identity primary key,

  -- Salesforce Id, kept so the import is idempotent and Phase 5 can reconcile
  -- row-for-row. Null for anything created after cutover.
  sf_id       text unique,

  record_no   text not null unique
                default ('WCF-' || lpad(nextval('weekly_cash_flow_no_seq')::text, 4, '0')),

  start_date  date not null unique,

  -- Salesforce: End_Date__c = Start_Date__c + 6
  end_date    date generated always as (start_date + 6) stored,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Weeks run Monday to Sunday. This is the ruling on the disagreement that
  -- caused the $901.92 / $912.67 split: the /weekly endpoint used Salesforce's
  -- THIS_WEEK (Sunday-start in a US-locale org) while /weekly-report computed
  -- Monday in America/Chicago. Monday wins, and the constraint makes a
  -- Sunday-start week unrepresentable rather than merely discouraged.
  constraint weekly_starts_monday check (extract(isodow from start_date) = 1)
);

comment on table weekly_cash_flow is
  'Mon-Sun week. Totals are not stored here - see v_weekly_cash_flow.';


-- ---------------------------------------------------------------------------
-- Daily Cash Flow — one shift, not one day. Multiple per date is normal.
-- ---------------------------------------------------------------------------
create table daily_cash_flow (
  id                  bigint generated always as identity primary key,
  sf_id               text unique,
  record_no           text not null unique
                        default ('DCF-' || lpad(nextval('daily_cash_flow_no_seq')::text, 4, '0')),

  weekly_cash_flow_id bigint not null
                        references weekly_cash_flow(id) on delete restrict,

  -- Salesforce Date__c. Named shift_date because a row is a shift: the /score
  -- endpoint already sums several rows for one calendar date.
  shift_date          date not null,

  clock_in            timestamptz,
  clock_out           timestamptz,

  -- Entered by hand at clock-out (routes/salesforce.js POST /shift/end), so it
  -- is stored, unlike active_miles which is summed from income rows.
  total_shift_miles   numeric(16,2) not null default 0,

  -- Written directly by Pixit off the DoorDash dash summary (REST PATCH on the
  -- DCF), because a dash reports one figure for the whole window. Putting it on
  -- each income row would multiply the day: three offers from a 1h17m dash
  -- would total 3h51m.
  doordash_dash_time_hours numeric(6,2) not null default 0,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Salesforce: IF(NOT(ISBLANK(Clock_Out__c)), (Clock_Out__c - Clock_In__c) * 24, 0)
  -- Salesforce datetime subtraction yields days, hence the * 24.
  shift_hours numeric(16,2) generated always as (
    case
      when clock_out is not null and clock_in is not null
        then round((extract(epoch from (clock_out - clock_in)) / 3600.0)::numeric, 2)
      else 0
    end
  ) stored,

  -- Salesforce: CASE(MOD(Date__c - DATE(1900,1,7), 7), ...) producing "1. Monday".
  -- The numeric prefix exists to sort correctly as text; ISO day-of-week
  -- happens to give the identical numbering. to_char is not immutable (it reads
  -- lc_time), so this is a CASE rather than a format string.
  day_of_week text generated always as (
    case extract(isodow from shift_date)
      when 1 then '1. Monday'   when 2 then '2. Tuesday' when 3 then '3. Wednesday'
      when 4 then '4. Thursday' when 5 then '5. Friday'  when 6 then '6. Saturday'
      when 7 then '7. Sunday'   else 'Error'
    end
  ) stored,

  -- Constraints Salesforce never enforced.
  --
  -- >= rather than >, so a shift that was never clocked out can be closed at its
  -- own clock-in during import. That records the truth - it happened, no
  -- duration was ever measured - and reproduces Salesforce's Shift_Hours__c of
  -- 0 for those rows, instead of inventing an end time from a child record's
  -- timestamp. A real shift is always longer than an instant, so nothing
  -- legitimate is admitted by the looser bound.
  constraint dcf_clock_out_after_in check (clock_out is null or clock_in is null or clock_out >= clock_in),
  constraint dcf_clock_out_needs_in check (clock_out is null or clock_in is not null),
  constraint dcf_miles_not_negative check (total_shift_miles >= 0),
  constraint dcf_dash_time_not_negative check (doordash_dash_time_hours >= 0)
);

-- At most one shift open at a time. Salesforce allowed several, and
-- GET /shift/active silently took the newest by CreatedDate.
create unique index daily_cash_flow_one_open_shift
  on daily_cash_flow ((clock_out is null))
  where clock_out is null;

create index daily_cash_flow_shift_date_idx on daily_cash_flow (shift_date);
create index daily_cash_flow_week_idx on daily_cash_flow (weekly_cash_flow_id);

comment on column daily_cash_flow.shift_date is
  'Calendar date of the shift in America/Chicago. Several rows may share one date.';


-- ---------------------------------------------------------------------------
-- Income Record — one delivery or trip
-- ---------------------------------------------------------------------------
create table income_record (
  id                  bigint generated always as identity primary key,
  sf_id               text unique,
  record_no           text not null unique
                        default ('INC-' || lpad(nextval('income_record_no_seq')::text, 4, '0')),

  -- Salesforce had this as an optional Lookup filled in by IncomeRecordTrigger.
  -- Kept nullable for the same reason: Pixit can land a row before anything has
  -- decided which shift it belongs to.
  daily_cash_flow_id  bigint references daily_cash_flow(id) on delete set null,

  income_date         date not null,
  source              text not null,
  store               text,

  -- Base Pay. Required in Salesforce, and coercing a legitimate 0 to null fails
  -- the insert - a real cancellation can pay 0 base plus a tip.
  amount              numeric(14,2) not null,
  tips                numeric(14,2),
  surge_bonus         numeric(14,2),

  uber_level          text,
  miles_driven        numeric(16,2),
  total_miles         numeric(18,2),

  -- Salesforce called this Time_Taken__c and labelled it "Time Taken (Hours)"
  -- while storing MINUTES. The handler divided by 60, its test asserted
  -- 30 -> 0.50, and Pixit wrote minutes into it. The data was consistent; only
  -- the label lied. Renamed so the units are in the name and the lie does not
  -- survive the migration.
  time_taken_minutes  numeric(6,1),

  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Salesforce: BLANKVALUE(Amount__c,0) + BLANKVALUE(Tips__c,0) + BLANKVALUE(Surge_Bonus__c,0)
  total_earnings numeric(14,2) generated always as (
    coalesce(amount, 0) + coalesce(tips, 0) + coalesce(surge_bonus, 0)
  ) stored,

  constraint income_source_valid
    check (source in ('Uber', 'Uber Eats', 'Doordash', 'other')),

  -- Salesforce enforced this through a dependent restricted picklist, at the API
  -- and not merely in the UI: Source=Doordash with Uber_Level=UberX failed with
  -- "bad value for restricted picklist field".
  constraint income_uber_level_requires_uber
    check (uber_level is null or source in ('Uber', 'Uber Eats')),

  constraint income_miles_not_negative
    check (coalesce(miles_driven, 0) >= 0 and coalesce(total_miles, 0) >= 0),
  constraint income_time_not_negative
    check (coalesce(time_taken_minutes, 0) >= 0)
);

create index income_record_dcf_idx on income_record (daily_cash_flow_id);
create index income_record_date_idx on income_record (income_date);
create index income_record_source_idx on income_record (source);

comment on column income_record.time_taken_minutes is
  'MINUTES. Salesforce stored the same values under a field labelled "(Hours)".';
comment on column income_record.miles_driven is
  'Miles on an active delivery. Summed into the daily active_miles figure.';
comment on column income_record.total_miles is
  'Miles including the drive to pickup. Denominator for true earnings per mile.';


-- ---------------------------------------------------------------------------
-- Expense Record
-- ---------------------------------------------------------------------------
create table expense_record (
  id                  bigint generated always as identity primary key,
  sf_id               text unique,
  record_no           text not null unique
                        default ('EXP-' || lpad(nextval('expense_record_no_seq')::text, 4, '0')),

  daily_cash_flow_id  bigint references daily_cash_flow(id) on delete set null,

  expense_date        date not null,
  amount              numeric(14,2) not null,
  type                text,
  type_explanation    text,

  store               text,

  -- Salesforce Address is a compound field and Geolocation a second one; neither
  -- survives a flat export intact, so both are unpacked. The export manifest
  -- names the component each column comes from.
  store_street        text,   -- Store_Address__Street__s
  store_city          text,   -- Store_Address__City__s
  store_state         text,   -- Store_Address__StateCode__s
  store_postal_code   text,   -- Store_Address__PostalCode__s
  store_country       text,   -- Store_Address__CountryCode__s

  -- The Address field carries its own geocode, which Salesforce fills in, and
  -- it is not the same thing as Location__c below — that one was set by hand or
  -- by Pixit. Keeping both means an address that was never geocoded stays
  -- distinguishable from one that has no location at all.
  store_address_latitude        numeric(9,6),  -- Store_Address__Latitude__s
  store_address_longitude       numeric(9,6),  -- Store_Address__Longitude__s
  store_address_geocode_accuracy text,         -- Store_Address__GeocodeAccuracy__s

  location_latitude   numeric(9,6),  -- Location__Latitude__s
  location_longitude  numeric(9,6),  -- Location__Longitude__s

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint expense_type_valid
    check (type is null or type in ('Food', 'Charging', 'Toll', 'Tires', 'Maintenance', 'Other')),
  constraint expense_amount_not_negative check (amount >= 0),
  constraint expense_latitude_valid
    check (location_latitude is null or location_latitude between -90 and 90),
  constraint expense_longitude_valid
    check (location_longitude is null or location_longitude between -180 and 180),
  constraint expense_address_latitude_valid
    check (store_address_latitude is null or store_address_latitude between -90 and 90),
  constraint expense_address_longitude_valid
    check (store_address_longitude is null or store_address_longitude between -180 and 180)
);

create index expense_record_dcf_idx on expense_record (daily_cash_flow_id);
create index expense_record_date_idx on expense_record (expense_date);


-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger weekly_cash_flow_touch before update on weekly_cash_flow
  for each row execute function touch_updated_at();
create trigger daily_cash_flow_touch before update on daily_cash_flow
  for each row execute function touch_updated_at();
create trigger income_record_touch before update on income_record
  for each row execute function touch_updated_at();
create trigger expense_record_touch before update on expense_record
  for each row execute function touch_updated_at();

commit;
