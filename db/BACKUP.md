# Backups

`npm run db:backup` dumps the database, **restores that dump into a throwaway
database, and compares it against the source** — row counts per table and the
money. If the comparison fails the dump is deleted and the command exits
non-zero, because a corrupt file in the backup directory is worse than an empty
one: it looks like protection.

A dump nobody has ever restored is not a backup. This one is restored every
time it is taken.

## Settings

All optional except `DATABASE_URL`, all read from `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | the database to back up |
| `BACKUP_DIR` | `./backups` | where dumps are written |
| `BACKUP_MIRROR` | none | a second directory each verified dump is copied to |
| `BACKUP_KEEP` | 14 | how many dumps to retain |

`BACKUP_DIR` must not be on the same disk as the database — one dead disk
would take both. The script checks and warns when it can tell. Point it at a
mounted share, or leave it local and set `BACKUP_MIRROR` to the share.

## Nightly

On whichever machine runs Postgres, `crontab -e`, then one line:

    15 3 * * * cd /home/patrick/patrick-dashboard && /usr/bin/node scripts/backup.js >> /home/patrick/gig-backup.log 2>&1

3:15am, after any realistic end of a shift. Read the log occasionally; a failed
run says so loudly and exits non-zero.

## Restoring

    npm run db:backup -- --list
    npm run db:backup -- --restore backups/gig-2026-09-08T031500Z.dump --into gigcheck

It restores to a **new** database and refuses to overwrite the one you are
running on. Look at `gigcheck`, and only then point `DATABASE_URL` at it.

## What is not covered

The dump holds the four tables, the views, and the sequences — everything the
CRM is. It does not hold `.env`, so keep `JWT_SECRET` and the passkey
credentials somewhere separate, or a restored database will come up with
nobody able to log in.
