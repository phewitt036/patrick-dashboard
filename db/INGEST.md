# Pushing records in from Pixit

Pixit reads a screenshot, works out what was earned, and pushes it. Today it
pushes into Salesforce. This is what it pushes into instead.

## Turning it on

Add a key to `.env` on whichever machine runs the dashboard:

    INGEST_KEY=<a long random string>

Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Until that line exists, every ingest request answers **503** — off by default,
not open by default.

Then check it from wherever Pixit runs:

    curl -H "Authorization: Bearer $INGEST_KEY" https://<host>/api/ingest/health

Answers `{"ok":true,"backend":"postgres","income":1586,...}`. Nothing is
written, so this is safe to call as often as you like.

## What changes on the Pixit side

Three things, and the body stays as it is:

| | Salesforce | Here |
|---|---|---|
| URL | `.../services/data/vXX.X/sobjects/Income_Record__c` | `https://<host>/api/ingest/income` |
| Auth | OAuth session | `Authorization: Bearer <INGEST_KEY>` |
| Fields | `Amount__c`, `Tips__c`, … | `amount`, `tips`, … (below) |

## POST /api/ingest/income

Send one record, an array of them, or `{"records": [...]}`. Up to 200 at once.

```json
{
  "externalId": "pixit-shot-8842",
  "incomeDate": "2026-09-08",
  "source": "Doordash",
  "store": "McDonald's",
  "amount": 7.25,
  "tips": 3.50,
  "surgeBonus": 0,
  "milesDriven": 4.2,
  "totalMiles": 6.8,
  "timeTakenMinutes": 18,
  "notes": "left at door"
}
```

Required: `incomeDate`, `source` (`Uber`, `Uber Eats`, `Doordash`, `other`) and
`amount`. `amount` may be `0` — a cancellation can pay nothing and still tip.
`uberLevel` only goes on an Uber or Uber Eats record. Times are **minutes**,
whatever Salesforce's field label said.

The old field names map straight across: `Amount__c` → `amount`,
`Surge_Bonus__c` → `surgeBonus`, `Tips__c` → `tips`, `Store__c` → `store`,
`Notes__c` → `notes`, `Miles_Driven__c` → `milesDriven`,
`Time_Taken__c` → `timeTakenMinutes`.

### externalId is the important one

Give every pushed record a **stable id of Pixit's own** — the extraction id, the
screenshot hash, anything that will be the same if the push is retried. It is
unique in the database, so:

* a retried push returns the record that already exists, and writes nothing;
* a duplicate answers **200**, not an error, so a client that retries on error
  does not retry forever;
* two genuinely identical $7.25 orders on the same day are still two records,
  because the id is what differs, not the contents.

Salesforce had none of this, which is why a timeout could double an evening's
income and nothing would notice.

Leave `externalId` out and every push is a new record, exactly as typing one in
would be.

The reply says what happened:

```json
{ "created": 1, "duplicates": 0, "records": [ { "id": 1587, "record_no": "INC-1587", ... } ] }
```

Each record carries `duplicate: true|false`. A batch is all-or-nothing: one bad
record rejects the whole request with `record 3: amount is required`, and
nothing in it is written.

Records link themselves to that day's shift the same way a typed one does, and
do not invent a shift when there is none.

## POST /api/ingest/expenses

Same shape and the same `externalId` behaviour.

```json
{ "externalId": "pixit-charge-91", "expenseDate": "2026-09-08",
  "amount": 14.20, "type": "Charging", "store": "EVgo" }
```

`type` is one of Food, Charging, Toll, Tires, Maintenance, Other.

## POST /api/ingest/dash-time

Replaces the PATCH onto `Doordash_Dash_Time__c`.

```json
{ "date": "2026-09-08", "hours": 3.25 }
```

It **sets** rather than adds, so pushing it again corrects the day instead of
doubling it — retries are safe here without an `externalId`.

A day with no shift answers **404** rather than creating an empty one; the
Salesforce history is full of shift records that exist only because something
needed somewhere to write. Send `"createShift": true` when you mean it.

## Errors

| Status | Meaning |
|---|---|
| 200 | accepted, everything in it was already there |
| 201 | created |
| 400 | validation — `error` says what and `field` says where |
| 401 | bad or missing key |
| 404 | dash time for a day with no shift |
| 503 | `INGEST_KEY` is not set |

Validation is the same code the record screens use, so a rule that holds when
Patrick types a record holds when Pixit sends one.
