# Patforce backups

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

`BACKUP_DIR` must not be the only copy — one dead disk would take the database
and its backups together. The script warns when it can tell they share a disk.

## This setup: boss holds it, bee holds the copy

Postgres and Patforce run on **boss** (Bosgame E5 mini PC, Ubuntu Server) since
2026-09-17; before that they ran on pimax (Pi 5). Backups are written locally on
boss and mirrored to **bee**, so losing boss entirely still leaves a verified dump
on another machine. The dumps from the pimax era are in the same bee folder.

In `/opt/patrick-dashboard/.env` on boss:

    DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/gig
    BACKUP_DIR=/home/patrick/gig-backups
    BACKUP_MIRROR=/mnt/bee/gig-backups
    BACKUP_KEEP=30

`BACKUP_MIRROR` needs bee mounted at that path — an NFS share from the Proxmox
box (`/srv/pimax-mirror`, exported to boss and pimax only), mounted in
`/etc/fstab` with `_netdev,nofail,soft` so it survives a reboot and a bee outage
cannot hang boss's boot. If the mount is
missing when the backup runs, the script says which directory is absent,
**keeps the verified local copy**, and exits 0 — a share that is down is not a
reason to have no backup.

It will not create the mount point for you. A missing parent directory means a
mount to fix, not a directory for a backup script to invent — and quietly
creating one would hide the fact that tonight's copy went to the SD card
instead of to bee.

30 days rather than the default 14: these dumps are tens of kilobytes, and a
month of them covers a full billing cycle.

## Nightly

On boss, `crontab -e` as `patrick`, then one line:

    15 3 * * * cd /opt/patrick-dashboard && /usr/bin/node scripts/backup.js >> /home/patrick/gig-backup.log 2>&1

Only one machine may run this against the mirror. pimax's old line is commented
out; if both ran, each would prune the other's dumps from bee.

3:15am, after any realistic end of a shift. Read the log occasionally; a failed
run says so loudly and exits non-zero.

Worth doing once, a week or so in: restore a dump from the bee copy into a
scratch database and look at it. Not because the script does not verify — it
verifies every run — but because that is the moment you find out whether the
mount, the cron user and the file permissions all line up in the direction you
will actually need them.

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
