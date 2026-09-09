#!/usr/bin/env node
/**
 * Back up the gig database, and prove the backup restores.
 *
 * A dump nobody has ever restored is not a backup, it is a cron job with good
 * intentions. So every run here restores what it just wrote into a throwaway
 * database and compares it against the source — row counts per table, and the
 * money. If that comparison fails the dump is deleted and the script exits
 * non-zero, because a corrupt file in the backup directory is worse than no
 * file: it looks like protection.
 *
 * Usage:
 *   npm run db:backup                 # dump, verify, prune old ones
 *   npm run db:backup -- --list       # what is in the backup directory
 *   npm run db:backup -- --restore <file> --into <dbname>
 *
 * Environment (from .env or the shell):
 *   DATABASE_URL   required, the database to back up
 *   BACKUP_DIR     where dumps go. Default ./backups — override it, see below.
 *   BACKUP_MIRROR  optional second directory each verified dump is copied to
 *   BACKUP_KEEP    how many dumps to retain. Default 14.
 *
 * BACKUP_DIR must not be on the same disk as the database. A disk that dies
 * takes both with it, and that is the failure this is for. Point it at a
 * mounted share, or set BACKUP_MIRROR to one — the script checks and complains
 * when it can tell they are the same device.
 *
 * Nightly, on the machine running Postgres:
 *   crontab -e
 *   15 3 * * * cd /path/to/patrick-dashboard && /usr/bin/node scripts/backup.js >> /var/log/gig-backup.log 2>&1
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const valueOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const MIRROR = process.env.BACKUP_MIRROR || null;
const KEEP = Number(process.env.BACKUP_KEEP || 14);

function die(msg) { console.error(`\n  ${msg}\n`); process.exit(1); }
const bytes = n => n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function parseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) die('DATABASE_URL is not set. Put it in .env — see scripts/db-setup.js.');
  let url;
  try { url = new URL(raw); } catch { die(`DATABASE_URL is not a valid URL: ${raw}`); }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) die('DATABASE_URL has no database name — it should end with /gig');
  return { raw, database };
}

/** Same server, different database. Used for the maintenance connection and the verify copy. */
function urlFor(raw, database) {
  const url = new URL(raw);
  url.pathname = '/' + encodeURIComponent(database);
  return url.toString();
}

/**
 * pg_dump refuses to dump a server newer than itself, and the message it gives
 * ("server version 17; pg_dump version 16") is only obvious once you have seen
 * it. Catch it before spending time on a dump that cannot work.
 */
function checkTools(serverVersion) {
  for (const tool of ['pg_dump', 'pg_restore']) {
    const r = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (r.error) {
      die(`${tool} is not on PATH.\n\n` +
          '  It ships with the PostgreSQL client tools:\n' +
          '    Debian/Ubuntu/Raspberry Pi OS:  sudo apt install postgresql-client\n' +
          '    macOS (Homebrew):               brew install libpq && brew link --force libpq');
    }
    const major = Number((r.stdout.match(/(\d+)\./) || [])[1]);
    const server = Number(String(serverVersion).split('.')[0]);
    if (major < server) {
      die(`${tool} is version ${major} but the server is version ${server}.\n\n` +
          `  pg_dump cannot dump a server newer than itself. Install the version ${server}\n` +
          '  client tools, or run this script on the machine hosting the database.');
    }
  }
}

/**
 * What the verification compares. Row counts catch a truncated restore; the
 * money catches a subtler one, where rows arrive but values do not survive the
 * round trip. Ordered by name so the two sides line up.
 */
const FINGERPRINT = `
  select 'weekly_cash_flow' as t, count(*)::text as n, coalesce(sum(extract(epoch from created_at)),0)::numeric(20,0)::text as v from weekly_cash_flow
  union all select 'daily_cash_flow', count(*)::text, coalesce(sum(shift_hours),0)::text from daily_cash_flow
  union all select 'income_record', count(*)::text, coalesce(sum(total_earnings),0)::text from income_record
  union all select 'expense_record', count(*)::text, coalesce(sum(amount),0)::text from expense_record
  order by 1`;

async function fingerprint(connectionString) {
  const c = new Client({ connectionString });
  await c.connect();
  try {
    const { rows } = await c.query(FINGERPRINT);
    return rows.map(r => `${r.t}: ${r.n} rows, total ${r.v}`);
  } finally { await c.end(); }
}

/**
 * Throws rather than exiting. A failure part way through a backup has to unwind
 * through the finally blocks that delete the half-written dump and drop the
 * verification database - process.exit() skipped both, so every failed night
 * left a .partial file that looked like a backup and an orphaned database that
 * never went away.
 */
function run(cmd, argv, label) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 });
  if (r.error) throw new Error(`${label} failed to start: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${label} failed (exit ${r.status}):\n\n  ${(r.stderr || '').trim().split('\n').join('\n  ')}`);
  }
  return r;
}

/**
 * Drop verification databases left behind by a run that was killed outright -
 * power loss, OOM, kill -9 - where no finally block got to run. The name prefix
 * is only ever created by this script, and anything still around from an hour
 * ago is not an in-flight verify.
 */
async function sweepOrphans(admin) {
  // The age comes out of the name rather than the filesystem: pg_stat_file needs
  // superuser, and this must work on a database where we are an ordinary owner.
  // Anything older than an hour is not a verify still in flight.
  const cutoff = Date.now() - 60 * 60 * 1000;
  try {
    const { rows } = await admin.query(
      `select datname from pg_database where datname like 'gig\\_verify\\_%'`);
    for (const { datname } of rows) {
      const started = parseInt((datname.split('_')[3] || ''), 36);
      if (!Number.isFinite(started) || started >= cutoff) continue;
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [datname]);
      await admin.query(`drop database if exists "${datname}"`);
      console.log(`Cleaned up orphaned ${datname} from an interrupted run`);
    }
  } catch (e) {
    // Tidying is not the job. If it cannot be done, say so and take the backup.
    console.warn(`  note: could not sweep old verification databases: ${e.message}`);
  }
}

/**
 * Make a backup directory without ever calling recursive mkdir on a path this
 * script does not control.
 *
 * fs.mkdirSync(dir, {recursive:true}) does not fail when a parent cannot be
 * created — it spins at 100% CPU and never returns. A BACKUP_MIRROR pointing at
 * a share that is not mounted is exactly that case, and on a nightly cron it
 * means a job that never finishes, another one stacked on top of it tomorrow,
 * and a Pi running hot for no reason. Failing in two seconds is worth a great
 * deal more than succeeding eventually.
 *
 * The parent is the mount point. If it is missing, that is a mount to fix, not
 * a directory for a backup script to invent.
 */
function ensureDir(dir, label) {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  if (parent !== resolved && !fs.existsSync(parent)) {
    throw new Error(
      `${label} ${dir} cannot be created because ${parent} does not exist.\n` +
      '  If that is a mounted share, it is not mounted.');
  }
  try { fs.mkdirSync(resolved); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}

/** Same device means one disk failure loses both copies. Best effort — not every path can be stat'd. */
function warnIfSameDisk(dir, dataDirectory) {
  if (!dataDirectory) return;
  try {
    if (fs.statSync(dir).dev === fs.statSync(dataDirectory).dev) {
      console.warn(
        `\n  WARNING: ${dir} is on the same disk as the database (${dataDirectory}).\n` +
        '  That disk failing loses the database and its backups together. Set\n' +
        '  BACKUP_DIR or BACKUP_MIRROR to a mounted share on another machine.\n');
    }
  } catch { /* different filesystem, no permission, or a path we cannot see — say nothing */ }
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => /^gig-\d{4}-\d{2}-\d{2}T\d{6}Z(_\d+)?\.dump$/.test(f))
    .sort()
    .map(f => ({ name: f, full: path.join(BACKUP_DIR, f), size: fs.statSync(path.join(BACKUP_DIR, f)).size }));
}

async function serverInfo(raw) {
  const c = new Client({ connectionString: raw });
  try { await c.connect(); } catch (e) {
    if (e.code === 'ECONNREFUSED') die(`Could not reach PostgreSQL. Is the server running?`);
    if (e.code === '3D000') die(`The database in DATABASE_URL does not exist yet. Run: npm run db:setup`);
    throw e;
  }
  try {
    const v = (await c.query('show server_version')).rows[0].server_version;
    // data_directory needs superuser; on a managed server it simply is not
    // readable, and the same-disk warning is skipped rather than fatal.
    let dataDirectory = null;
    try { dataDirectory = (await c.query('show data_directory')).rows[0].data_directory; } catch { }
    return { version: v, dataDirectory };
  } finally { await c.end(); }
}

// ---------------------------------------------------------------------------

async function backup() {
  const { raw, database } = parseUrl();
  const { version, dataDirectory } = await serverInfo(raw);
  checkTools(version);

  ensureDir(BACKUP_DIR, 'BACKUP_DIR');
  warnIfSameDisk(BACKUP_DIR, dataDirectory);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    .replace(/^(\d{4})(\d{2})(\d{2})T(\d{6})Z$/, '$1-$2-$3T$4Z');
  // Second resolution reads well in a directory listing, but two runs in the
  // same second would have the later one silently overwrite the earlier. A
  // backup quietly replacing another backup is the exact failure this script
  // exists to prevent, so take the next free name instead.
  let file = path.join(BACKUP_DIR, `gig-${stamp}.dump`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(BACKUP_DIR, `gig-${stamp}_${n}.dump`);
  // '_' rather than '-' as the separator: pruning sorts by filename, and '-'
  // sorts before '.', which would have put the second dump of a given second
  // ahead of the first and pruned the newer one.
  const partial = `${file}.${process.pid}.partial`;

  let verified = false;
  try {
    // Written under .partial and renamed only once verified, so a dump killed
    // half way through never sits in the directory looking like a good backup.
    console.log(`Dumping ${database} ...`);
    run('pg_dump', ['-Fc', '--no-owner', '--no-privileges', '-f', partial, '-d', raw], 'pg_dump');
    console.log(`  wrote ${bytes(fs.statSync(partial).size)}`);

    // --- verify by restoring it ---
    const verifyDb = `gig_verify_${process.pid}_${Date.now().toString(36)}`;
    const admin = new Client({ connectionString: urlFor(raw, 'postgres') });
    await admin.connect();
    try {
      await sweepOrphans(admin);
      await admin.query(`create database "${verifyDb}"`);
      try {
        console.log(`Verifying: restoring into ${verifyDb} ...`);
        run('pg_restore', ['--no-owner', '--no-privileges', '-d', urlFor(raw, verifyDb), partial], 'pg_restore');

        const [source, restored] = await Promise.all([fingerprint(raw), fingerprint(urlFor(raw, verifyDb))]);
        for (const line of restored) console.log(`  ${line}`);
        if (JSON.stringify(source) !== JSON.stringify(restored)) {
          console.error('\n  Source:');
          for (const l of source) console.error(`    ${l}`);
          console.error('  Restored:');
          for (const l of restored) console.error(`    ${l}`);
          throw new Error('the restored copy does not match the source');
        }
        verified = true;
      } finally {
        await admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
          [verifyDb]);
        await admin.query(`drop database if exists "${verifyDb}"`);
      }
    } finally { await admin.end(); }
  } catch (e) {
    // Whatever went wrong, the file that did not pass verification does not stay
    // in the backup directory. A dump that cannot be restored is worse than no
    // dump at all, because it looks like protection.
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    throw new Error(
      `${e.message}\n\n  Backup FAILED verification and was deleted. The database itself is\n` +
      '  fine — only the dump was untrustworthy. Check free disk space and rerun.');
  }
  if (!verified) throw new Error('backup did not verify');

  // rename() would overwrite a dump another run created in the same second
  // between the name check above and here. link() refuses to clobber, so the
  // loser of that race takes the next name instead of replacing a good backup.
  for (let n = 1; ; n++) {
    try { fs.linkSync(partial, file); fs.unlinkSync(partial); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      file = path.join(BACKUP_DIR, `gig-${stamp}_${n + 1}.dump`);
    }
  }
  console.log(`\nVerified: ${file}`);

  if (MIRROR) {
    try {
      ensureDir(MIRROR, 'BACKUP_MIRROR');
      warnIfSameDisk(MIRROR, dataDirectory);
      fs.copyFileSync(file, path.join(MIRROR, path.basename(file)));
      console.log(`Mirrored to ${path.join(MIRROR, path.basename(file))}`);
    } catch (e) {
      // A mirror that is offline should not lose the verified local copy.
      console.error(`  WARNING: could not mirror to ${MIRROR}: ${e.message}`);
    }
  }

  // Prune only after a good backup exists, so a run that fails never reduces
  // the number of copies on disk.
  const all = listBackups();
  for (const b of all.slice(0, Math.max(0, all.length - KEEP))) {
    fs.unlinkSync(b.full);
    console.log(`Pruned ${b.name}`);
  }
  console.log(`${Math.min(all.length, KEEP)} backup(s) retained in ${BACKUP_DIR}`);
}

async function restore() {
  const file = valueOf('--restore');
  const into = valueOf('--into');
  if (!file || !into) die('usage: npm run db:backup -- --restore <file> --into <dbname>');
  if (!fs.existsSync(file)) die(`No such file: ${file}`);

  const { raw, database } = parseUrl();
  if (into === database) {
    die(`--into ${into} is the live database.\n\n` +
        '  Restore into a new name, check it, then switch DATABASE_URL over. This\n' +
        '  script will not overwrite the database you are currently running on.');
  }
  const { version } = await serverInfo(raw);
  checkTools(version);

  const admin = new Client({ connectionString: urlFor(raw, 'postgres') });
  await admin.connect();
  try {
    const { rows } = await admin.query('select 1 from pg_database where datname = $1', [into]);
    if (rows.length) die(`Database "${into}" already exists. Choose a name that does not.`);
    await admin.query(`create database "${into}"`);
  } finally { await admin.end(); }

  console.log(`Restoring ${path.basename(file)} into ${into} ...`);
  run('pg_restore', ['--no-owner', '--no-privileges', '-d', urlFor(raw, into), file], 'pg_restore');
  for (const line of await fingerprint(urlFor(raw, into))) console.log(`  ${line}`);
  console.log(`\nRestored. Point DATABASE_URL at ${into} when you have checked it.`);
}

function list() {
  const all = listBackups();
  if (!all.length) return console.log(`No backups in ${BACKUP_DIR}`);
  console.log(`${BACKUP_DIR}\n`);
  for (const b of all) console.log(`  ${b.name}  ${bytes(b.size).padStart(9)}`);
  console.log(`\n${all.length} backup(s), keeping ${KEEP}`);
}

(async () => {
  if (has('--list')) return list();
  if (has('--restore')) return restore();
  await backup();
})().catch(e => { console.error(`\n  ${e.message}\n`); process.exit(1); });
