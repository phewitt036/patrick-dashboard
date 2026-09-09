# Standing the CRM up on pimax

Everything below happens on **pimax**, over SSH from x8. One command does the
work; the rest is getting the pieces onto the box.

## Why this cannot be done from a Claude Code web session

A web session runs in an ephemeral container in Anthropic's cloud. It has no
SSH client, no outbound port 22, and no route to a private address — so it can
reach GitHub and Vercel but not pimax, x8, or anything else on the LAN. That is
the boundary, not a setting to change.

**Claude Code running on x8** does have the LAN, and can SSH into pimax and do
all of this. That is the session to use for this part.

## 1. Get the pieces onto pimax

    ssh pimax

    sudo apt install postgresql postgresql-client
    sudo systemctl enable --now postgresql

    git clone https://github.com/phewitt036/patrick-dashboard.git
    cd patrick-dashboard
    npm install

The Salesforce export folder — `2026-09-08T18-55-15-881Z`, the one holding
`Income_Record__c.json` and its three siblings — has to be on pimax too. From
x8:

    scp -r <path-to-export> pimax:~/sf-export

## 2. Set the database password

Give the `postgres` user a password, then put it in `.env`:

    sudo -u postgres psql -c "alter user postgres password 'something-long'"

    cd ~/patrick-dashboard
    echo "DATABASE_URL=postgresql://postgres:something-long@localhost:5432/gig" > .env
    chmod 600 .env

`.env` is gitignored. Nothing else needs to go in it — the installer writes the
rest.

## 3. One command

    npm run crm:install -- ~/sf-export

That is a **dry run**: it checks Postgres, the client tools, and the export,
reports what the data needs repaired, and writes nothing. Read what it says.
For the 2026-09-08 export it will name three repairs — seven abandoned open
shifts, three income records with no date, one with no platform.

Then, to do it:

    npm run crm:install -- ~/sf-export --repair --cron

Which, in order:

1. creates the database and applies all four migrations
2. imports 1,743 records, applying exactly the repairs the dry run named
3. **reconciles every figure against Salesforce** and refuses to continue if
   they do not match
4. writes `CRM_BACKEND=postgres`, `BACKUP_DIR`, `BACKUP_KEEP` and a generated
   `INGEST_KEY` into `.env`, without touching anything already there
5. takes a backup and restores it into a throwaway database to prove it works
6. installs the 3:15am cron line

Re-running it is safe. The schema, the import and the `.env` writes are all
idempotent, and an existing `INGEST_KEY` is never regenerated.

## 4. Then

    node server.js

It prints `Income endpoints served by: postgres`. The record screens are at
`/records`.

Three things the installer deliberately leaves to you:

**Mount bee and set `BACKUP_MIRROR`.** Until then every backup lives only on
pimax, and the script says so on every run. `db/BACKUP.md` has the detail. The
mount needs to be in `/etc/fstab` so it survives a reboot — the backup script
will not create a mount point, because inventing one would hide the fact that
tonight's copy never left the machine.

**Point Pixit at `/api/ingest`.** `db/INGEST.md` is the whole change: a URL, an
auth header, and camelCase field names. The key is the `INGEST_KEY` in `.env`.

**Leave Salesforce alone for a month.** Read-only, logged in, untouched. Long
enough to cover a full billing and reporting cycle, so anything missing turns
up while the old system can still answer.

## If it stops

The installer stops at the first real problem rather than leaving a half-built
database. Each stop names what to do:

| It says | Do |
|---|---|
| `Nothing is listening at localhost:5432` | Postgres is not installed or not started |
| `PostgreSQL rejected the password` | the password in `.env` is not the one set in step 2 |
| `pg_dump is not on PATH` | `sudo apt install postgresql-client` |
| `does not look like a Salesforce export` | wrong folder — it needs the four `*__c.json` files |
| `reconciliation failed` | stop. The data loaded but the numbers disagree; `db/MAPPING.md` explains which differences are expected |
