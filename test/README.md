# Running the tests

Eight suites. Most need different databases, and pointing one at the wrong
database produces a confusing failure rather than a clear one — so each is
listed here with the state it expects.

`DATABASE_URL` is read from the environment or from `.env`.

## 1. Schema assertions — needs an EMPTY database

33 assertions on constraints, generated columns and view arithmetic. It
refuses to run against a database with rows in it, because it looks records
up by date and would otherwise be asserting against your data.

    npm run db:setup            # against a scratch DATABASE_URL
    psql -d <scratch> -f db/test_schema.sql

## 2. Income API — needs a SCRATCH database with the schema applied

Writes data and does not clean up. Asserts the JSON contract `public/gig.html`
depends on: field names, date formats, aggregation across shifts in a day.

    DATABASE_URL=postgresql:///gigtest npm run test:api

## 3. Records API — runs against ANY database with the schema

45 assertions on the CRUD endpoints. Creates and deletes its own rows, including
the deliberately-unlinked one, so it is safe against the imported data and safe
to run repeatedly.

    npm run test:records

## 3b. Ingest API — needs a SCRATCH database with the schema

46 assertions on the machine-to-machine endpoints Pixit pushes to. Mostly about
retries: the same externalId sent twice, twice in one batch, and twice at the
same moment. Sets its own INGEST_KEY, writes data, does not clean up.

    DATABASE_URL=postgresql:///gigingest npm run test:ingest

## 3c. Ride mix API — runs against ANY database with the schema

51 assertions on `/api/records/ride-mix`, every expected figure worked out by
hand from eight seeded records: the placeholder ride and the Uber Eats order
left out, a missing trip time or distance giving a null rate rather than $0,
`total_miles` falling back to `miles_driven`, the weekly gaps, and clock times
landing in the right Central hour either side of a DST change, and the approximate
hour from a Pixit record's arrival (same day only, never over a time on the
screen), and the on-the-clock rate with the placeholder shift's hour left out.
Seeds March 2019, years before any real record, and deletes what it
wrote.

**Scratch databases only — never the live one.** It writes a placeholder shift
and a $999 ride, uses up WCF/DCF/INC record numbers for good, and if it is killed
before it cleans up, that ride stays in the `_all` views reconciliation reads.

    DATABASE_URL=postgresql:///<scratch> npm run test:mix

## 4. Records browser — needs the IMPORTED data

15 Playwright assertions against `public/records.html`. It asserts on real
totals (a four-figure record count, a single open shift), so it needs the
database the Salesforce export was imported into.

    npx playwright install chromium
    npm run test:browser

If Playwright's bundled browser does not match what is installed, point at
one explicitly rather than reinstalling:

    CHROME_PATH=/path/to/chrome npm run test:browser

## 4b. Gig page browser — the cutover test, needs the IMPORTED data

25 Playwright assertions driving `public/gig.html` — the page used every day —
against the **Postgres** backend. The API suites prove the JSON is the right
shape; this proves the page renders it without a line of the page changing,
which is the thing that would bite on the night `CRM_BACKEND` is flipped.

Chart.js is stubbed: the page loads it from a CDN, and what matters is whether
the page hands it real numbers, not whether Chart.js can draw them.

    npm run test:gig

## 4c. Paths — needs NO database

337 assertions that a page behind the login, and a file the Patforce-only
instance hides, stay that way however the path is spelled: percent-encoded,
upper-cased, with `/./`, `//`, `%2f`, `%5c`, `/x/../` or `/api/../` in front. Starts
`server.js` twice, once with `PATFORCE_ONLY=1`, on spare ports, with its own
`JWT_SECRET`, and sends raw request paths — `fetch()` would tidy the dot
segments away before they reached the server. A stub agent-hub records what
the pimax proxy sends upstream, so a conversation id cannot walk out of its
path unseen. Safe to run anywhere.

    npm run test:paths

## 5. Fixture round trip — the cutover gate, needs a SCRATCH database

Builds a synthetic Salesforce export in the exact shape of a real one, with
Salesforce's own derived values computed the way its formulas do, then imports
and reconciles it. A faithful port reconciles to zero.

The fixture deliberately contains a null income date, two abandoned open
shifts and an Uber level on a DoorDash row, so the import refuses until it is
told what to do about each. That refusal is the test.

    node test/make-fixture.js /tmp/fixture
    node scripts/import-export.js /tmp/fixture \
      --close-abandoned --infer-dates --drop-uber-level --apply
    node scripts/reconcile.js /tmp/fixture

Expected last line: `RECONCILED. Every Salesforce figure is reproduced from
the imported rows.`

## Against the real export

Same two commands, pointed at the export directory and the database it was
imported into. Expected: `RECONCILED`, with the documented Salesforce faults
listed above it. Those faults are numbers that were wrong in Salesforce, not
porting errors — `db/MAPPING.md` explains each.
