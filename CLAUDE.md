# patrick-dashboard

Patrick's personal command centre — an Express app on Vercel, passkey-only auth,
with panels for his homelab and his gig-delivery income. **Patforce** is the
Postgres CRM inside it that replaces a Salesforce Developer Edition org.

## Read this before changing anything

**The repository is public.** Income figures, exports, dumps, `.env` and keys
must never be committed. `.gitignore` covers `.env*`, `sf-export`, `backups/`;
keep it that way.

**Salesforce is still the system of record.** Patforce is built, tested and
deployed but not yet installed on the Pi, so Patrick keeps entering records in
Salesforce and a fresh export carries them across at cutover. Do not tell him to
stop.

**Everything new is off by default.** `CRM_BACKEND` unset ⇒ income endpoints
stay on Salesforce; `DATABASE_URL` unset ⇒ `/api/records` and `/api/income`
answer 503 with the reason; `INGEST_KEY` unset ⇒ `/api/ingest` answers 503.

## Where Patforce runs

Installed on pimax 2026-09-09, **moved to boss** (Bosgame E5, Ubuntu Server) on
2026-09-17: systemd `patforce.service`, app in `/opt/patrick-dashboard`, Postgres 18,
backups mirrored to bee. `db/DEPLOY.md` covers what runs where, how the move was
made, and the original install (`npm run crm:install -- <export-dir> --repair --cron`).

Still open: retrieving `DailyCashFlowHandler` and its nine-test Apex suite,
which exist only inside the dev org and nowhere else.

## Where the reasoning lives

| Doc | Answers |
|---|---|
| `db/DEPLOY.md` | where Patforce runs (boss), moving it, and the first install |
| `db/MAPPING.md` | every Salesforce field → Postgres, and every deliberate divergence |
| `db/INGEST.md` | pointing Pixit at `/api/ingest` instead of Salesforce |
| `db/BACKUP.md` | nightly backups, the boss/bee arrangement, restoring |
| `db/SECURITY.md` | what was fixed, what was checked, what is knowingly accepted |
| `test/README.md` | which database each of the six suites expects |

Commit messages carry the why for individual decisions. They are long on
purpose.

## Things that will bite you

**Reconciliation is the cutover gate.** `scripts/reconcile.js` diffs every
computed figure against the Salesforce export. Changing a view or a formula
without re-running it is how fidelity gets lost silently. It currently reports
`RECONCILED, with 15 Salesforce fault(s)` — those fifteen are wrong in the org,
documented in `db/MAPPING.md`, and Postgres is right.

**The divergences in `db/MAPPING.md` are deliberate.** Weekly active hours
include DoorDash time; weeks start Monday; `time_taken_minutes` is honestly
named where Salesforce said hours; placeholder shifts are excluded from the app
views but not the `_all` views reconciliation reads. Do not "fix" these.

**`v_daily_cash_flow_raw` is unrounded on purpose.** Salesforce keeps full float
precision in aggregates and divides by that. Rounding before dividing shifts
every derived rate and breaks reconciliation.

**Schema changes go in a new numbered file** in `db/`. `npm run db:setup` keeps
a `schema_migration` ledger and applies what has not run, so an existing
database picks up new files without anyone remembering to run psql.

## Running the tests

Six suites, and they want different databases — `test/README.md` is the table.
The two Playwright suites take `CHROME_PATH` if the bundled browser is missing.

    npm run test:api        npm run test:records     npm run test:ingest
    npm run test:browser    npm run test:gig
    psql -d <empty-scratch> -f db/test_schema.sql

Green as of the last change: schema 38, income 45, records 45, ingest 46,
records browser 16, gig browser 25, both reconciliations.
