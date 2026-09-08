# Salesforce → Postgres field mapping

Source of truth for the import and for Phase 5 reconciliation. Built from
`patrick-vault/Salesforce/salesforce-data-model.md` and
`salesforce-formulas-and-logic.md` (2026-08-11), not from a live describe.

Conventions: `__c` dropped, `snake_case`, Salesforce `Id` preserved as `sf_id`,
auto-numbers preserved as `record_no`.

**Where numbers live now.** Tables hold only entered or measured values.
Everything Salesforce derived — formula fields, weekly rollups, and the Apex in
`DailyCashFlowHandler` — is a view. Read `v_daily_cash_flow` and
`v_weekly_cash_flow`, never the tables, for anything with a total in it.

---

## Weekly_Cash_Flow__c → `weekly_cash_flow` / `v_weekly_cash_flow`

| Salesforce | Postgres | Where | Note |
|---|---|---|---|
| `Name` (WCF-{0000}) | `record_no` | table | Sequence keeps the format going |
| `Start_Date__c` | `start_date` | table | Must be a Monday — enforced |
| `End_Date__c` | `end_date` | generated | `start_date + 6` |
| `Weekly_Total_Income__c` | `weekly_total_income` | view | Was a native SUM rollup |
| `Weekly_Total_Expenses__c` | `weekly_total_expenses` | view | " |
| `Weekly_Shift_Miles__c` | `weekly_shift_miles` | view | " |
| `Weekly_Active_Miles__c` | `weekly_active_miles` | view | " |
| `Weekly_Shift_Hours__c` | `weekly_shift_hours` | view | " |
| `Weekly_Active_Hours__c` | `weekly_active_hours` | view | **Changed — see below** |
| — | `weekly_uber_active_hours` | view | New: the old Salesforce figure, for reconciliation |
| `Day_Count__c` | `day_count` | view | Was a COUNT rollup |
| `Net_Profit__c` | `net_profit` | view | |
| `Earnings_Per_Active_Hour__c` | `earnings_per_active_hour` | view | **Changed — see below** |
| `Earnings_Per_Shift_Hour__c` | `earnings_per_shift_hour` | view | |
| `True_Earnings_Per_Mile__c` | `true_earnings_per_mile` | view | |

## Daily_Cash_Flow__c → `daily_cash_flow` / `v_daily_cash_flow`

| Salesforce | Postgres | Where | Note |
|---|---|---|---|
| `Name` (DCF-{0000}) | `record_no` | table | |
| `Date__c` | `shift_date` | table | Renamed: a row is a shift, and several can share a date |
| `Clock_In__c` / `Clock_Out__c` | `clock_in` / `clock_out` | table | `timestamptz` |
| `Total_Shift_Miles__c` | `total_shift_miles` | table | Entered at clock-out |
| `Doordash_Dash_Time__c` | `doordash_dash_time_hours` | table | Written by Pixit; units in the name |
| `Shift_Hours__c` | `shift_hours` | generated | |
| `Day_of_Week__c` | `day_of_week` | generated | `"2. Tuesday"` format preserved |
| `Total_Income__c` | `total_income` | view | **Was Apex-written** |
| `Total_Expenses__c` | `total_expenses` | view | **Was Apex-written** |
| `Active_Miles__c` | `active_miles` | view | **Was Apex-written** |
| `Active_Time_Hours__c` | `active_time_hours` | view | **Was Apex-written** |
| `Total_Active_Time_Hours__c` | `total_active_time_hours` | view | |
| `Net_Profit__c` | `net_profit` | view | |
| `Earnings_Per_Active_Hour__c` | `earnings_per_active_hour` | view | |
| `Earnings_Per_Shift_Hour__c` | `earnings_per_shift_hour` | view | |
| `True_Earnings_Per_Mile__c` | `true_earnings_per_mile` | view | |
| — | `is_open` | view | `clock_out is null`, for the active-shift lookup |

## Income_Record__c → `income_record` / `v_income_record`

| Salesforce | Postgres | Where | Note |
|---|---|---|---|
| `Name` (INC-{0000}) | `record_no` | table | |
| `Daily_Cash_Flow__c` | `daily_cash_flow_id` | table | Nullable, as it was |
| `Income_Date__c` | `income_date` | table | |
| `Source__c` | `source` | table | CHECK: Uber, Uber Eats, Doordash, other |
| `Store__c` | `store` | table | |
| `Amount__c` | `amount` | table | NOT NULL; `0` is legal |
| `Tips__c` / `Surge_Bonus__c` | `tips` / `surge_bonus` | table | |
| `Uber_Level__c` | `uber_level` | table | CHECK: only on Uber / Uber Eats |
| `Miles_Driven__c` / `Total_Miles__c` | `miles_driven` / `total_miles` | table | |
| `Time_Taken__c` | **`time_taken_minutes`** | table | **Renamed — see below** |
| `Notes__c` | `notes` | table | |
| `Total_Earnings__c` | `total_earnings` | generated | |
| `Earnings_Per_Mile__c` | `earnings_per_mile` | view | |
| `True_Earnings_Per_Mile__c` | `true_earnings_per_mile` | view | |
| `Uber_Pay_Internal__c` | `uber_pay` | view | |
| `Uber_Tips_Internal__c` | `uber_tips` | view | |
| `Doordash_Pay_Internal__c` | `doordash_pay` | view | |
| `Doordash_Tips_Internal__c` | `doordash_tips` | view | |
| — | `time_taken_hours` | view | Convenience; nothing should divide by 60 again |
| ~~`Shift__c`~~ | — | — | **Dropped.** Not present in the org — see below |

## Expense_Record__c → `expense_record`

| Salesforce | Postgres | Note |
|---|---|---|
| `Name` (EXP-{0000}) | `record_no` | |
| `Daily_Cash_Flow__c` | `daily_cash_flow_id` | |
| `Expense_Date__c` | `expense_date` | |
| `Amount__c` | `amount` | |
| `Type__c` | `type` | CHECK: Food, Charging, Toll, Tires, Maintenance, Other |
| `Type_Explanation__c` | `type_explanation` | |
| `Store__c` | `store` | |
| `Store_Address__Street__s` | `store_street` | Compound Address, unpacked |
| `Store_Address__City__s` | `store_city` | " |
| `Store_Address__StateCode__s` | `store_state` | " |
| `Store_Address__PostalCode__s` | `store_postal_code` | " |
| `Store_Address__CountryCode__s` | `store_country` | " |
| `Store_Address__Latitude__s` | `store_address_latitude` | Salesforce's geocode of the address |
| `Store_Address__Longitude__s` | `store_address_longitude` | " |
| `Store_Address__GeocodeAccuracy__s` | `store_address_geocode_accuracy` | " |
| `Location__Latitude__s` | `location_latitude` | Separate Geolocation field, set by hand or Pixit |
| `Location__Longitude__s` | `location_longitude` | " |

---

## Three deliberate divergences

Everything else is a faithful port. These three are not, and each is a decision
you can overrule.

### 1. `time_taken_minutes` — the renamed field

`Time_Taken__c` was labelled *"Time Taken (Hours)"* and stored **minutes**.
`DailyCashFlowHandler` divided by 60, its test asserted 30 → 0.50, and Pixit
wrote minutes into it. The data was always consistent; only the label lied.
Renaming kills the trap rather than importing it. **Import must copy the value
unchanged — no conversion.**

### 2. Weekly active hours now include DoorDash

On 2026-08-11 `Doordash_Dash_Time__c` was added and the *daily*
`Earnings_Per_Active_Hour__c` was switched to divide by Uber + DoorDash,
because a DoorDash-only day divided by zero Uber hours and reported $0.00/hr
against real earnings.

**The weekly rollup was never changed to match.** `Weekly_Active_Hours__c` still
sums `Active_Time_Hours__c`, which is Uber time alone, so the weekly
$/active-hour has been dividing by too few hours and overstating the rate on any
week containing DoorDash work — the same bug, fixed daily, still live weekly.

`v_weekly_cash_flow` divides by the combined figure. `weekly_uber_active_hours`
is kept beside it so Phase 5 can reproduce the old number and measure the gap.
On the test fixture the old method overstated the rate by **$47.90/hr**.

*If you'd rather match Salesforce exactly for reconciliation and fix it after,
that's a one-line change to the view.*

### 3. One definition of "this week"

`/api/income/weekly` summed `Income_Record__c` with Salesforce's `THIS_WEEK`
(Sunday-start in a US-locale org, and it silently drops null dates).
`/api/income/weekly-report` read the WCF rollup. On 2026-05-14 they reported
**$901.92 and $912.67 for the same week.**

Monday-start wins — it matches `Weekly_Cash_Flow__c`, the backfill script's
`toStartOfWeek() + 1`, and the JS in `/weekly-report`. `weekly_cash_flow` will
not accept a Sunday-start row.

`v_income_by_week` buckets by income date itself, so it counts rows that were
never linked to a shift. That is the number `/weekly` should serve.
`v_weekly_cash_flow.weekly_total_income` walks shifts and will differ when rows
are unlinked — **that difference is now a report you can run, not a mystery.**

---

## What the export found that the vault did not

The 2026-09-08 export enumerated **eight** custom objects. Four are the gig
income model above. The rest:

**`Job__c`, `Income__c`, `Expense__c`** — 5, 8 and 10 records. A separate
job-costing model: `Job__c` holds `Client__c`, `Service_Type__c`,
`Quoted_Amount__c` and `Profit_Margin_Percent__c`, with `Income__c` and
`Expense__c` hanging off it by lookup, both carrying `Locked__c` and
`Job_Import_Key__c`. Client work with quotes and margins, not deliveries.
**Out of scope for this migration** — but they are in the export, so nothing is
lost by leaving them where they are.

**`Shift__c`** — 0 records, and no custom fields at all: only `Id`, `Name`,
`OwnerId` and the usual system columns. The vault concluded the object had been
deleted, because `SELECT Shift__c FROM Income_Record__c` failed with "No such
column". The object is actually still there and queryable; it is the *lookup
field* pointing at it that no longer exists — on `Income_Record__c` and on
`Expense_Record__c` alike, neither of which lists it in the export. An empty
shell either way, and nothing references it.

## Two things to verify against the org

Neither blocks the build; both should be checked during Phase 5.

1. **`Active_Miles__c` is assumed to be `SUM(Miles_Driven__c)`.** The vault says
   the handler aggregates "miles" without naming the field, and income has both
   `Miles_Driven__c` and `Total_Miles__c`. If it was actually `Total_Miles__c`,
   change the one `sum()` in `v_daily_cash_flow`.

2. **Weekly formula bodies.** The vault lists WCF's four formula fields but not
   their expressions. They're implemented as the obvious analogues of the daily
   ones. Reconciliation will confirm or contradict that.

---

## Running it

```bash
createdb gig
psql -d gig -f db/001_tables.sql -f db/002_views.sql

# 33 assertions covering the formulas, the ported Apex behaviour and the constraints
psql -d gig -f db/test_schema.sql
```

`test_schema.sql` rolls back — it leaves nothing behind.
