# Running the tests

Five suites. They need different databases, and pointing one at the wrong
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

## 4. Records browser — needs the IMPORTED data

15 Playwright assertions against `public/records.html`. It asserts on real
totals (a four-figure record count, a single open shift), so it needs the
database the Salesforce export was imported into.

    npx playwright install chromium
    npm run test:browser

If Playwright's bundled browser does not match what is installed, point at
one explicitly rather than reinstalling:

    CHROME_PATH=/path/to/chrome npm run test:browser

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
