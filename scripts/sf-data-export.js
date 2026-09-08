#!/usr/bin/env node
/**
 * Phase 2 of the Salesforce migration — get every record onto disk you control.
 *
 * This is the insurance policy, not the migration itself. The whole reason this
 * project exists is that logging into the Developer Edition org has been
 * unreliable, and until an export exists locally that unreliability is an
 * unbounded risk. Run it now, run it again whenever the org has been quiet for a
 * while, and keep the output somewhere that isn't one machine.
 *
 * Every field is exported, not just the ones the dashboard reads — including Id,
 * CreatedDate and LastModifiedDate. Id in particular is what makes the eventual
 * import idempotent and lets Phase 5 reconcile row-for-row against the org.
 *
 * Both JSON and CSV, because they fail differently: JSON preserves nulls and
 * types for the import, CSV opens in anything if you ever need to read this by
 * hand with no tooling around.
 *
 * Usage:  node scripts/sf-data-export.js [Object__c ...]
 *         (no arguments exports every custom object)
 * Needs:  SF_USERNAME and SF_PASSWORD
 * Writes: sf-export/data/<timestamp>/  — gitignored; this repo is public and
 *         these files are months of income and expense data.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fail, connect, customObjectNames, queryableFieldNames } = require('./lib/salesforce');

const OUT_ROOT = path.join(__dirname, '..', 'sf-export', 'data');

/** Salesforce returns this on every record; it's routing metadata, not data. */
function stripAttributes(record) {
  const { attributes, ...rest } = record;
  return rest;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(fields, records) {
  const lines = [fields.map(csvCell).join(',')];
  for (const r of records) lines.push(fields.map(f => csvCell(r[f])).join(','));
  return lines.join('\n') + '\n';
}

/**
 * Page through the whole result set. queryMore rather than a single large query
 * because Salesforce caps a query response at 2000 records regardless of how
 * many matched — taking the first page as the answer is the classic way to
 * silently export a fraction of the data.
 */
async function fetchAll(conn, soql, onPage) {
  const records = [];
  let result = await conn.query(soql);
  const expected = result.totalSize;

  records.push(...result.records.map(stripAttributes));
  onPage(records.length, expected);

  while (!result.done && result.nextRecordsUrl) {
    result = await conn.queryMore(result.nextRecordsUrl);
    records.push(...result.records.map(stripAttributes));
    onPage(records.length, expected);
  }

  return { records, expected };
}

async function exportObject(conn, name, outDir) {
  const describe = await conn.describe(name);
  const fields = queryableFieldNames(describe);
  const soql = `SELECT ${fields.join(', ')} FROM ${name}`;

  process.stdout.write(`  ${name} ... `);

  const { records, expected } = await fetchAll(conn, soql, (got, total) => {
    process.stdout.write(`\r  ${name} ... ${got}/${total}   `);
  });

  const jsonPath = path.join(outDir, `${name}.json`);
  const csvPath = path.join(outDir, `${name}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify(records, null, 2));
  fs.writeFileSync(csvPath, toCsv(fields, records));

  // If these disagree, pagination dropped rows and the export is not a backup.
  const complete = records.length === expected;
  process.stdout.write(
    `\r  ${name} ... ${records.length} record(s), ${fields.length} field(s)` +
    `${complete ? '' : `  ** INCOMPLETE: org reported ${expected} **`}\n`
  );

  return {
    object: name,
    records: records.length,
    expectedRecords: expected,
    complete,
    fields,
    files: {
      json: path.basename(jsonPath),
      csv: path.basename(csvPath)
    },
    bytes: {
      json: fs.statSync(jsonPath).size,
      csv: fs.statSync(csvPath).size
    }
  };
}

const README = (org, when) => `Salesforce data export
======================

Org:        ${org}
Exported:   ${when}

Every record of every custom object, all fields, as of the timestamp above.
JSON preserves nulls and types and is what the CRM import should read.
CSV is the same data, readable without any tooling.

This is a restore point. Keep a copy somewhere that is not the machine that
made it. manifest.json lists per-object record counts — check "complete" is
true for every object before trusting this as a backup.
`;

async function main() {
  const requested = process.argv.slice(2);

  const conn = await connect();
  const identity = await conn.identity();
  console.log(`  ${identity.username} · ${conn.instanceUrl}`);

  const all = await customObjectNames(conn);
  const names = requested.length ? requested : all;

  const unknown = names.filter(n => !all.includes(n));
  if (unknown.length) {
    fail(`Not a custom object in this org: ${unknown.join(', ')}\n  Available: ${all.join(', ')}`);
  }
  if (!names.length) fail('No custom objects found — is this the right org?');

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(OUT_ROOT, stamp);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\nExporting ${names.length} object(s):\n`);

  const results = [];
  for (const name of names) {
    results.push(await exportObject(conn, name, outDir));
  }

  const manifest = {
    exportedAt: startedAt.toISOString(),
    org: { username: identity.username, instanceUrl: conn.instanceUrl, apiVersion: conn.version },
    complete: results.every(r => r.complete),
    totalRecords: results.reduce((n, r) => n + r.records, 0),
    objects: results
  };

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'README.txt'), README(identity.username, startedAt.toISOString()));

  console.log(`\nWrote ${path.relative(process.cwd(), outDir)}/`);
  console.log(`  ${manifest.totalRecords} record(s) across ${results.length} object(s)`);

  if (!manifest.complete) {
    const bad = results.filter(r => !r.complete).map(r => r.object).join(', ');
    fail(`Export is INCOMPLETE for: ${bad}\n  Do not treat this as a backup. Re-run it.`);
  }

  console.log('\nAll objects complete. Copy this directory somewhere off this machine.');
}

if (require.main === module) {
  main().catch(e => fail(`${e.name || 'Error'}: ${e.message}`));
}

module.exports = { csvCell, toCsv, stripAttributes, fetchAll };
