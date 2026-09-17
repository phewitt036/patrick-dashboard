# Standing Patforce up

Patforce — the CRM replacing the Salesforce org. It was first installed on
**pimax** (Raspberry Pi 5) on 2026-09-09 and **moved to boss** (Bosgame E5 mini PC,
Ubuntu Server) on 2026-09-17. The first-install procedure further down is written
for pimax, as it was done; the two sections below describe what runs now and how
the move was made.

## Where it runs now: boss

| | |
|---|---|
| App | `/opt/patrick-dashboard`, a clone of this repo, `npm ci --omit=dev` |
| Process | systemd `patforce.service` as user `patrick`, `PORT=3006`, `Restart=on-failure`. The unit lives in the homelab repo (`boss/patforce/patforce.service`) |
| Config | `/opt/patrick-dashboard/.env` (mode 600) — `PATFORCE_ONLY=1`, `CRM_BACKEND=postgres`, `DATABASE_URL`, `INGEST_KEY`, `JWT_SECRET`, `RP_ID`/`ORIGIN`, `CREDENTIALS_FILE=/home/patrick/.config/patforce-credentials.json`, `BACKUP_*` |
| Database | PostgreSQL 18 from Ubuntu, localhost only, database `gig` |
| Public URL | `https://patforce.storystash.app`, through the storystash Cloudflare tunnel. That tunnel has connectors on pimax **and** bee, and both ingress rules point at boss — change one without the other and half of all requests fail |
| Pixit | `PATFORCE_URL` in Pixit's `ecosystem.config.js` on pimax points at boss over the wired fleet link. Pixit reads dash time from, and pushes records to, `/api/ingest` there |
| Backups | boss's crontab, 3:15am — see `db/BACKUP.md` |

Logs: `journalctl -u patforce`. Restart: `sudo systemctl restart patforce`.
Update: `git pull && npm ci --omit=dev && sudo systemctl restart patforce`, in
`/opt/patrick-dashboard`, after testing against a scratch database.

## Moving it to another machine

What the pimax → boss move was, in order. The database is the only state that
matters; everything else is config.

1. On the new machine: install Node 22 and PostgreSQL, clone the repo, `npm ci --omit=dev`.
2. Copy `.env` and the passkey credentials file across **directly between the two
   machines** (never via a laptop's disk), mode 600. Fix any paths in `.env` that name
   the old home directory (`BACKUP_DIR`, `CREDENTIALS_FILE`).
3. Set the new Postgres's `postgres` password to the one in `DATABASE_URL`, and
   `createdb gig`. Prove the app's own connection string works before going further.
4. **Stop the old instance first**, so Pixit cannot write to it mid-copy.
5. `pg_dump -Fc gig` on the old machine piped into `pg_restore -d gig --no-owner
   --exit-on-error` on the new one. A 17 → 18 major-version jump restored cleanly.
6. **Compare every table's row count** between the two before starting anything.
7. Start the new instance, then repoint, in this order: Pixit's `PATFORCE_URL`, the
   tunnel ingress on **both** connectors (restart them one at a time so the other keeps
   serving), and the backup cron (comment the old machine's line out — two machines
   pruning one mirror would delete each other's dumps).
8. Test: Pixit's `GET /api/ingest/dash-time?date=<a day with a shift>` returns that
   shift; the public URL answers; a manual `node scripts/backup.js` verifies and mirrors.
9. Reboot the new machine once and check it all comes back unattended.

Leave the old instance stopped but installed until the new one has run for a while.
Rolling back means copying the *new* database back first — the data moves on from
the moment the new instance takes its first write.

---

# First install (pimax, 2026-09-09)

## Why this cannot be done from a Claude Code web session

A web session runs in an ephemeral container in Anthropic's cloud. It has no
SSH client, no outbound port 22, and no route to a private address — so it can
reach GitHub and Vercel but not pimax, x8, or anything else on the LAN. That is
the boundary, not a setting to change.

**Claude Code running on x8** does have the LAN, and can SSH into pimax and do
all of this. That is the session to use for this part.

## 0. Take a fresh export first — on x8

Everything entered in Salesforce since the last export is only in Salesforce.
Export now, so the cutover carries today's data rather than a snapshot from
whenever the last one was taken:

    cd patrick-dashboard
    git pull
    npm run data:export

It writes `sf-export/data/<timestamp>/`. That newest folder is the one to copy
across — not an older one. `sf-export/` is gitignored, so it stays on the
machine.

## 1. Get the pieces onto pimax

**The account on pimax is `pi`,** not the Windows username x8 will default to and
not `patrick`. `DASHBOARD-DEVLOG.md` records the real path there —
`/home/pi/scripts/dashboard-update.sh` — from when the agent-hub scripts were
set up.

If `ssh pi@pimax` asks for a password, x8's key is not installed on that account
yet. Install it once and everything after this is passwordless.

Windows' bundled OpenSSH has no `ssh-copy-id`, so in PowerShell pipe the key
across instead — one password prompt, the last one:

    type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh pi@pimax "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

From Git Bash or a Mac, the short form works:

    ssh-copy-id pi@pimax

Then:

    ssh pi@pimax

    sudo apt install postgresql postgresql-client
    sudo systemctl enable --now postgresql

    git clone https://github.com/phewitt036/patrick-dashboard.git
    cd patrick-dashboard
    npm install

The export folder from step 0 has to be on pimax too. From x8, copying the
newest one:

    scp -r sf-export/data/<the-newest-timestamp> pimax:~/sf-export

It is the folder holding `Income_Record__c.json` and its three siblings. The
installer checks that before it writes anything, and says so if you point it at
the wrong directory.

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
