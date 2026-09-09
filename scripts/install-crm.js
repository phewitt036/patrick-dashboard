#!/usr/bin/env node
/**
 * Stand Patforce up on a fresh machine, in one command.
 *
 * Everything here can already be done with four separate npm scripts. The point
 * of this one is that it runs them in the right order, checks the things that
 * actually go wrong first, and stops at the first real problem instead of
 * leaving a half-built database behind.
 *
 *   npm run crm:install -- <export-folder>            # look, change nothing
 *   npm run crm:install -- <export-folder> --repair    # do it
 *
 * The first form is a dry run: it reports what the export needs repaired and
 * writes nothing. The second applies exactly the repairs the first one named -
 * they are printed either way, so nothing is fixed silently.
 *
 * Add --cron to install the nightly backup line as well.
 *
 * Requires DATABASE_URL in .env or the environment.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const exportDir = args.find(a => !a.startsWith('--'));
const has = f => args.includes(`--${f}`);
const REPAIR = has('repair');
const CRON = has('cron');

const OBJECTS = ['Weekly_Cash_Flow__c', 'Daily_Cash_Flow__c', 'Income_Record__c', 'Expense_Record__c'];

let step = 0;
const heading = t => console.log(`\n${'-'.repeat(64)}\n${++step}. ${t}\n${'-'.repeat(64)}`);
const ok = m => console.log(`  ok    ${m}`);
const note = m => console.log(`  ...   ${m}`);
function die(msg) { console.error(`\n  STOPPED: ${msg}\n`); process.exit(1); }

function node(script, argv, { capture = false } = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...argv], {
    cwd: ROOT, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', env: process.env
  });
  if (r.error) die(`could not run ${script}: ${r.error.message}`);
  return r;
}

// ---------------------------------------------------------------------------

async function preflight() {
  heading('Checking what has to be true before anything is written');

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) die(`Node ${process.versions.node} is too old — this needs 18 or newer.`);
  ok(`Node ${process.versions.node}`);

  if (!process.env.DATABASE_URL) {
    die('DATABASE_URL is not set.\n\n' +
        '  Put it in a file called .env in this folder, on one line:\n\n' +
        '      DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/gig\n\n' +
        '  using the password set when PostgreSQL was installed.');
  }
  let url;
  try { url = new URL(process.env.DATABASE_URL); }
  catch { die(`DATABASE_URL is not a valid URL: ${process.env.DATABASE_URL}`); }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) die('DATABASE_URL has no database name — it should end with /gig');

  // Connect to the maintenance database, which exists before ours does.
  const admin = new URL(process.env.DATABASE_URL);
  admin.pathname = '/postgres';
  const c = new Client({ connectionString: admin.toString() });
  try { await c.connect(); }
  catch (e) {
    if (e.code === 'ECONNREFUSED') {
      die(`Nothing is listening at ${url.host}.\n\n` +
          '  On Raspberry Pi OS or Debian:  sudo apt install postgresql\n' +
          '                                 sudo systemctl enable --now postgresql');
    }
    if (e.code === '28P01' || /password authentication failed/i.test(e.message)) {
      die('PostgreSQL rejected the password in DATABASE_URL.');
    }
    die(`Could not reach PostgreSQL: ${e.message}`);
  }
  const version = (await c.query('show server_version')).rows[0].server_version;
  await c.end();
  ok(`PostgreSQL ${version} at ${url.host}, database "${database}"`);

  // pg_dump is not needed to install, but it is needed every night afterwards,
  // and finding that out at 3am in a log nobody reads is worse than now.
  for (const tool of ['pg_dump', 'pg_restore']) {
    const r = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (r.error) {
      die(`${tool} is not on PATH, so backups cannot run.\n\n` +
          '  sudo apt install postgresql-client\n\n' +
          '  Install it and run this again — a database with no backup is not finished.');
    }
    const toolMajor = Number((r.stdout.match(/(\d+)\./) || [])[1]);
    const serverMajor = Number(String(version).split('.')[0]);
    if (toolMajor < serverMajor) {
      die(`${tool} is version ${toolMajor} but the server is ${serverMajor}.\n` +
          '  pg_dump cannot dump a server newer than itself.');
    }
    ok(`${tool} ${toolMajor}`);
  }

  if (!exportDir) die('Give me the Salesforce export folder:\n\n' +
                      '      npm run crm:install -- /path/to/2026-09-08T18-55-15-881Z');
  if (!fs.existsSync(exportDir)) die(`No such folder: ${exportDir}`);
  const missing = OBJECTS.filter(o => !fs.existsSync(path.join(exportDir, `${o}.json`)));
  if (missing.length) {
    die(`${exportDir} does not look like a Salesforce export.\n` +
        `  Missing: ${missing.join(', ')}`);
  }
  const counts = OBJECTS.map(o => {
    const n = JSON.parse(fs.readFileSync(path.join(exportDir, `${o}.json`), 'utf8')).length;
    return `${o.replace('__c', '')} ${n}`;
  });
  ok(`export looks complete — ${counts.join(', ')}`);
}

function schema() {
  heading('Creating the database and applying the schema');
  const r = node('db-setup.js', [], { capture: true });
  process.stdout.write(r.stdout.split('\n').filter(l => !/injected env/.test(l)).join('\n'));
  if (r.status !== 0) die('schema setup failed — see above');
}

/**
 * The dry run names the repairs the data needs. They are applied only with
 * --repair, and printed either way: an import that silently "fixes" records is
 * how you end up not knowing what your own numbers mean.
 */
function importData() {
  heading('Reading the export');
  const dry = node('import-export.js', [exportDir], { capture: true });
  const text = dry.stdout + dry.stderr;
  process.stdout.write(text.split('\n').filter(l => !/injected env/.test(l)).join('\n'));

  const flags = [...new Set((text.match(/fix: (--[a-z-]+(?:=[a-z]+)?)/g) || [])
    .map(m => m.replace('fix: ', '')))];

  if (!REPAIR) {
    console.log('\n  Nothing was written.');
    if (flags.length) {
      console.log('  To apply the repairs listed above and continue:\n');
      console.log(`      npm run crm:install -- ${exportDir} --repair\n`);
    } else {
      console.log(`  To load it:\n\n      npm run crm:install -- ${exportDir} --repair\n`);
    }
    process.exit(0);
  }

  heading(`Loading it${flags.length ? `, repairing: ${flags.join(' ')}` : ''}`);
  const r = node('import-export.js', [exportDir, ...flags, '--apply'], { capture: true });
  process.stdout.write((r.stdout + r.stderr).split('\n').filter(l => !/injected env/.test(l)).join('\n'));
  if (r.status !== 0) die('import failed — see above');
}

function reconcile() {
  heading('Checking every number against Salesforce');
  const r = node('reconcile.js', [exportDir], { capture: true });
  const text = (r.stdout + r.stderr).split('\n').filter(l => !/injected env/.test(l));
  // The full report is long; the verdict and the faults are what matter here.
  const verdict = text.findIndex(l => /^RECONCILED|^NOT RECONCILED/.test(l));
  console.log(text.slice(Math.max(0, verdict - 12)).join('\n'));
  if (r.status !== 0) {
    die('reconciliation failed. The data is loaded but the numbers do not match —\n' +
        '  do not cut over until this is understood. db/MAPPING.md explains the\n' +
        '  differences that are expected.');
  }
}

/** Update keys in .env without disturbing anything already there. */
function writeEnv(updates) {
  const p = path.join(ROOT, '.env');
  const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n') : [];
  const added = [];
  for (const [key, value] of Object.entries(updates)) {
    const i = lines.findIndex(l => l.startsWith(`${key}=`));
    if (i >= 0) continue;               // never overwrite what is already set
    lines.push(`${key}=${value}`);
    added.push(key);
  }
  if (added.length) {
    fs.writeFileSync(p, lines.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
  }
  return added;
}

function configure() {
  heading('Configuration');
  const backupDir = process.env.BACKUP_DIR || path.join(require('os').homedir(), 'gig-backups');
  const added = writeEnv({
    CRM_BACKEND: 'postgres',
    BACKUP_DIR: backupDir,
    BACKUP_KEEP: '30',
    INGEST_KEY: crypto.randomBytes(32).toString('hex')
  });
  for (const k of added) {
    // The key itself is not printed. It is in .env, which is gitignored, and
    // this output may well end up in a log or pasted into a chat window.
    ok(k === 'INGEST_KEY' ? 'INGEST_KEY generated and written to .env' : `${k} set in .env`);
  }
  if (!added.length) note('.env already had everything — nothing changed');
  if (!process.env.BACKUP_MIRROR) {
    note('BACKUP_MIRROR is not set. Backups will exist only on this machine.');
    note('Set it to a directory on bee once that share is mounted — see db/BACKUP.md.');
  }
  return backupDir;
}

function firstBackup() {
  heading('Taking the first backup, and restoring it to prove it works');
  const r = node('backup.js', [], { capture: true });
  const text = (r.stdout + r.stderr).split('\n').filter(l => !/injected env/.test(l));
  console.log(text.filter(l => l.trim()).slice(-8).join('\n'));
  if (r.status !== 0) die('the first backup failed — see above');
}

function cron(backupDir) {
  const line = `15 3 * * * cd ${ROOT} && ${process.execPath} scripts/backup.js >> ${path.join(require('os').homedir(), 'gig-backup.log')} 2>&1`;
  heading('Nightly backup');
  if (!CRON) {
    console.log('  Not installed. Add it with:\n');
    console.log(`      npm run crm:install -- ${exportDir} --repair --cron\n`);
    console.log('  or by hand — crontab -e, then:\n');
    console.log(`      ${line}\n`);
    return;
  }
  const existing = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  const current = existing.status === 0 ? existing.stdout : '';
  if (current.includes('scripts/backup.js')) return ok('already in the crontab — left alone');
  const written = spawnSync('crontab', ['-'], { input: current.replace(/\n*$/, '\n') + line + '\n', encoding: 'utf8' });
  if (written.status !== 0) {
    note('could not write the crontab. Add this line by hand with crontab -e:');
    return console.log(`\n      ${line}\n`);
  }
  ok('installed, 3:15am nightly');
}

(async () => {
  console.log('\nPatforce — install\n');
  await preflight();
  schema();
  importData();
  reconcile();
  const backupDir = configure();
  firstBackup();
  cron(backupDir);

  console.log(`\n${'='.repeat(64)}`);
  console.log('Done. The database is loaded, reconciled and backed up.\n');
  console.log('  Start the dashboard:   node server.js');
  console.log('  It will report:        Income endpoints served by: postgres');
  console.log('  Records screens:       /records');
  console.log('\nStill to do by hand:');
  console.log('  - mount bee and set BACKUP_MIRROR, so backups leave this machine');
  console.log('  - point Pixit at /api/ingest — db/INGEST.md, using the INGEST_KEY in .env');
  console.log('  - leave Salesforce read-only for a month before deleting anything');
  console.log(`${'='.repeat(64)}\n`);
})().catch(e => { console.error(`\n  ${e.stack || e.message}\n`); process.exit(1); });
