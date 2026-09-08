#!/usr/bin/env node
/**
 * Create the database and apply the schema, without needing psql or createdb.
 *
 * Those ship with a full PostgreSQL client install and land on PATH on Linux and
 * macOS, but not reliably on Windows — and this project needs a Postgres server,
 * not a set of command-line tools. Everything here goes through the same `pg`
 * driver the application already uses, so if `npm run db:import` can connect,
 * so can this.
 *
 * Usage:
 *   npm run db:setup            # create the database if missing, apply the schema
 *   npm run db:setup -- --reset # drop it first — destroys everything in it
 *
 * Reads DATABASE_URL, from the environment or from .env, e.g.
 *   DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/gig
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const FILES = ['001_tables.sql', '002_views.sql'];
const RESET = process.argv.includes('--reset');

function die(msg) { console.error(`\n  ${msg}\n`); process.exit(1); }

/**
 * Identifiers cannot be parameterised. This one comes from DATABASE_URL rather
 * than anywhere untrusted, but SQL escapes a quote by doubling it, not with a
 * backslash, so JSON.stringify is the wrong tool for the job.
 */
const quoteIdent = name => `"${name.replace(/"/g, '""')}"`;

function parseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    die('DATABASE_URL is not set.\n\n' +
        '  Put it in a file called .env in this folder, on one line:\n\n' +
        '      DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/gig\n\n' +
        '  using the password you set when you installed PostgreSQL.\n' +
        '  .env is gitignored, so it stays on this machine.');
  }
  let url;
  try { url = new URL(raw); } catch { die(`DATABASE_URL is not a valid URL: ${raw}`); }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) die('DATABASE_URL has no database name — it should end with /gig');
  return { raw, database };
}

/** Connect to the maintenance database, which always exists, to manage ours. */
function maintenanceUrl(raw) {
  const url = new URL(raw);
  url.pathname = '/postgres';
  return url.toString();
}

async function connect(connectionString, label) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
  } catch (e) {
    if (e.code === 'ECONNREFUSED') {
      die(`Could not reach PostgreSQL at ${label}.\n\n` +
          '  Is the server running? On Windows it installs as a service called\n' +
          '  something like "postgresql-x64-17" — check Services, or restart the machine\n' +
          '  if you have only just installed it.');
    }
    if (e.code === '28P01' || /password authentication failed/i.test(e.message)) {
      die('PostgreSQL rejected the password in DATABASE_URL.\n\n' +
          '  It is the one you chose during installation, for the "postgres" user.');
    }
    throw e;
  }
  return client;
}

async function main() {
  const { raw, database } = parseUrl();
  const admin = await connect(maintenanceUrl(raw), 'localhost');

  try {
    const { rows } = await admin.query('select 1 from pg_database where datname = $1', [database]);

    if (rows.length && RESET) {
      // Existing sessions would block the drop; this is a local scratch database.
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()`, [database]);
      await admin.query(`drop database ${quoteIdent(database)}`);
      console.log(`Dropped database "${database}".`);
      rows.length = 0;
    }

    if (!rows.length) {
      await admin.query(`create database ${quoteIdent(database)}`);
      console.log(`Created database "${database}".`);
    } else {
      console.log(`Database "${database}" already exists.`);
    }
  } finally {
    await admin.end();
  }

  const db = await connect(raw, database);
  try {
    const existing = await db.query(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_name = 'income_record'`);
    if (existing.rows[0].n && !RESET) {
      console.log('\nSchema is already applied. Nothing to do.');
      console.log('To start over: npm run db:setup -- --reset');
      return;
    }

    for (const file of FILES) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');
      // Sent whole rather than split on semicolons: the files contain
      // dollar-quoted function bodies that any naive splitter would cut in half.
      await db.query(sql);
      console.log(`Applied db/${file}`);
    }

    const tables = await db.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_type, table_name`);
    console.log(`\n${tables.rows.length} table(s) and view(s) created:`);
    console.log('  ' + tables.rows.map(r => r.table_name).join(', '));

    console.log('\nNext:');
    console.log('  npm run db:import -- <your export folder>          (looks, writes nothing)');
    console.log('  npm run db:import -- <your export folder> --apply');
    console.log('  npm run db:reconcile -- <your export folder>');
  } finally {
    await db.end();
  }
}

main().catch(e => die(`${e.name || 'Error'}: ${e.message}`));
