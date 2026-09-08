#!/usr/bin/env node
/**
 * Phase 1 of the Salesforce migration — dump what the org actually *is*, not what
 * the dashboard code implies it is.
 *
 * Roughly half the fields routes/salesforce.js reads are computed by Salesforce
 * rather than stored: Net_Profit__c, Earnings_Per_Shift_Hour__c, Shift_Hours__c,
 * every Weekly_* total. That arithmetic exists nowhere in this repo. Export the
 * data without it and you get numbers with no way to recompute them, so the
 * schema comes out before the records do.
 *
 * Two sources, because neither is sufficient alone:
 *   describe()      — runtime truth: real types, precision, what's queryable.
 *   metadata.read() — the definitions: formula text, roll-up operations,
 *                     validation rules. describe() reports *that* a field is
 *                     calculated but usually not *how*.
 *
 * Usage:  node scripts/sf-schema-dump.js
 * Needs:  SF_USERNAME and SF_PASSWORD (password + security token, as in routes/salesforce.js)
 * Writes: sf-export/schema/  — gitignored; this repo is public.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fail, connect, customObjectNames } = require('./lib/salesforce');

const OUT_DIR = path.join(__dirname, '..', 'sf-export', 'schema');

// Metadata API caps CustomObject reads at 10 per call.
const METADATA_BATCH = 10;

async function readMetadata(conn, names) {
  const byName = {};
  for (let i = 0; i < names.length; i += METADATA_BATCH) {
    const batch = names.slice(i, i + METADATA_BATCH);
    const result = await conn.metadata.read('CustomObject', batch);
    // jsforce returns a bare object for a single name, an array for several.
    for (const meta of [].concat(result)) {
      if (meta && meta.fullName) byName[meta.fullName] = meta;
    }
  }
  return byName;
}

/**
 * How much data is in here, and how far back does it go — the two facts that
 * decide how long reconciliation takes and how bad a botched import would be.
 * Each aggregate is guarded: one unfilterable field shouldn't sink the run.
 */
async function profileRecords(conn, objectName, describe) {
  const profile = { count: null, ranges: {}, errors: [] };

  try {
    profile.count = (await conn.query(`SELECT COUNT() FROM ${objectName}`)).totalSize;
  } catch (e) {
    profile.errors.push(`count: ${e.message}`);
  }

  const dateFields = ['CreatedDate'].concat(
    describe.fields
      .filter(f => f.custom && (f.type === 'date' || f.type === 'datetime'))
      .map(f => f.name)
  );

  for (const field of dateFields) {
    try {
      const r = await conn.query(`SELECT MIN(${field}) lo, MAX(${field}) hi FROM ${objectName}`);
      const row = r.records[0] || {};
      if (row.lo || row.hi) profile.ranges[field] = { first: row.lo, last: row.hi };
    } catch (e) {
      profile.errors.push(`${field}: ${e.message}`);
    }
  }

  return profile;
}

/**
 * Sort every field into the three buckets the migration actually cares about:
 * stored values need columns, formulas need porting to generated columns, and
 * roll-ups need porting to views.
 */
function classifyFields(describe, meta) {
  const metaByName = {};
  for (const f of (meta && meta.fields) || []) metaByName[f.fullName] = f;

  const stored = [], formula = [], rollup = [], relationship = [];

  for (const f of describe.fields) {
    const m = metaByName[f.name] || {};
    const row = {
      name: f.name,
      label: f.label,
      type: f.type,
      soapType: f.soapType,
      custom: f.custom,
      precision: f.precision,
      scale: f.scale,
      length: f.length,
      required: !f.nillable && !f.defaultedOnCreate,
      unique: f.unique,
      defaultValue: f.defaultValue,
      picklistValues: (f.picklistValues || []).map(p => p.value)
    };

    if (m.summaryOperation) {
      rollup.push({
        ...row,
        operation: m.summaryOperation,
        summarizedField: m.summarizedField || null,
        summaryForeignKey: m.summaryForeignKey || null,
        filters: (m.summaryFilterItems || []).map(
          i => `${i.field} ${i.operation} ${i.value === undefined ? '' : i.value}`.trim()
        )
      });
    } else if (m.formula || f.calculatedFormula) {
      formula.push({
        ...row,
        formula: m.formula || f.calculatedFormula,
        blanksAs: m.formulaTreatBlanksAs || null
      });
    } else if (f.type === 'reference' && (f.referenceTo || []).length) {
      relationship.push({
        ...row,
        referenceTo: f.referenceTo,
        relationshipName: f.relationshipName,
        kind: m.type === 'MasterDetail' ? 'master-detail' : 'lookup',
        cascadeDelete: !!f.cascadeDelete
      });
    } else if (f.custom) {
      stored.push(row);
    }
  }

  return { stored, formula, rollup, relationship };
}

const fence = s => '```\n' + String(s).trim() + '\n```';

function renderMarkdown(report) {
  const L = [];
  L.push('# Salesforce schema dump');
  L.push('');
  L.push(`Org: \`${report.org.username}\` · ${report.org.instanceUrl}`);
  L.push(`Generated: ${report.generatedAt}`);
  L.push('');
  L.push('Ground truth for the CRM migration. Formula and roll-up definitions below are');
  L.push('what the new Postgres schema has to reproduce — port them deliberately, one at a');
  L.push('time, rather than re-deriving them from how the numbers look.');
  L.push('');

  L.push('## Objects');
  L.push('');
  L.push('| Object | Records | Stored | Formula | Roll-up | Relationships |');
  L.push('|---|--:|--:|--:|--:|--:|');
  for (const o of report.objects) {
    const c = o.counts;
    L.push(
      `| \`${o.name}\` | ${o.profile.count ?? '—'} | ${c.stored} | ${c.formula} | ${c.rollup} | ${c.relationship} |`
    );
  }
  L.push('');

  for (const o of report.objects) {
    L.push('---');
    L.push('');
    L.push(`## \`${o.name}\``);
    L.push('');
    L.push(`**${o.label}** · ${o.profile.count ?? 'unknown'} records`);
    if (!o.metadataAvailable) {
      L.push('');
      L.push('> Metadata API returned nothing for this object, so formulas and roll-up');
      L.push('> definitions are missing below. Check the user\'s Metadata API permission.');
    }
    L.push('');

    const ranges = Object.entries(o.profile.ranges);
    if (ranges.length) {
      L.push('### Date coverage');
      L.push('');
      L.push('| Field | First | Last |');
      L.push('|---|---|---|');
      for (const [f, r] of ranges) L.push(`| \`${f}\` | ${r.first ?? '—'} | ${r.last ?? '—'} |`);
      L.push('');
    }

    if (o.fields.stored.length) {
      L.push('### Stored fields');
      L.push('');
      L.push('These become real columns.');
      L.push('');
      L.push('| Field | Label | Type | Required | Notes |');
      L.push('|---|---|---|---|---|');
      for (const f of o.fields.stored) {
        const notes = [];
        if (f.precision) notes.push(`precision ${f.precision},${f.scale}`);
        if (f.unique) notes.push('unique');
        if (f.picklistValues.length) notes.push(`picklist: ${f.picklistValues.join(' / ')}`);
        if (f.defaultValue !== null && f.defaultValue !== undefined) notes.push(`default ${f.defaultValue}`);
        L.push(`| \`${f.name}\` | ${f.label} | ${f.type} | ${f.required ? 'yes' : ''} | ${notes.join('; ')} |`);
      }
      L.push('');
    }

    if (o.fields.formula.length) {
      L.push('### Formula fields');
      L.push('');
      L.push('Port each to a generated column, or a view where it crosses tables.');
      L.push('');
      for (const f of o.fields.formula) {
        L.push(`**\`${f.name}\`** — ${f.label} · returns ${f.type}`);
        L.push('');
        if (f.blanksAs) {
          L.push(`Blanks treated as: ${f.blanksAs}`);
          L.push('');
        }
        L.push(fence(f.formula));
        L.push('');
      }
    }

    if (o.fields.rollup.length) {
      L.push('### Roll-up summary fields');
      L.push('');
      L.push('Computed from child records — these become views, not columns.');
      L.push('');
      for (const f of o.fields.rollup) {
        L.push(`**\`${f.name}\`** — ${f.label}`);
        L.push('');
        L.push(`- Operation: \`${f.operation}\``);
        if (f.summarizedField) L.push(`- Summarized field: \`${f.summarizedField}\``);
        if (f.summaryForeignKey) L.push(`- Child relationship: \`${f.summaryForeignKey}\``);
        if (f.filters.length) L.push(`- Only counting rows where: ${f.filters.map(x => `\`${x}\``).join(', ')}`);
        L.push('');
      }
    }

    if (o.fields.relationship.length) {
      L.push('### Relationships');
      L.push('');
      L.push('| Field | Kind | Points at | Cascade delete |');
      L.push('|---|---|---|---|');
      for (const f of o.fields.relationship) {
        L.push(`| \`${f.name}\` | ${f.kind} | ${f.referenceTo.join(', ')} | ${f.cascadeDelete ? 'yes' : ''} |`);
      }
      L.push('');
    }

    if (o.validationRules.length) {
      L.push('### Validation rules');
      L.push('');
      L.push('Constraints the org enforces that Postgres will not, unless you add them.');
      L.push('');
      for (const v of o.validationRules) {
        L.push(`**${v.fullName}**${v.active ? '' : ' _(inactive)_'} — rejects with: "${v.errorMessage}"`);
        L.push('');
        L.push(fence(v.errorConditionFormula));
        L.push('');
      }
    }

    if (o.profile.errors.length) {
      L.push('### Queries that failed');
      L.push('');
      for (const e of o.profile.errors) L.push(`- ${e}`);
      L.push('');
    }
  }

  return L.join('\n');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const conn = await connect();
  const identity = await conn.identity();
  console.log(`  ${identity.username} · ${conn.instanceUrl}`);

  const names = await customObjectNames(conn);
  console.log(`\nFound ${names.length} custom object(s): ${names.join(', ')}\n`);
  if (!names.length) fail('No custom objects found — is this the right org?');

  console.log('Reading metadata definitions...');
  let metadata = {};
  try {
    metadata = await readMetadata(conn, names);
  } catch (e) {
    console.warn(`  Metadata API failed (${e.message})`);
    console.warn('  Continuing with describe() only — formula text will be missing.');
  }

  const objects = [];
  for (const name of names) {
    process.stdout.write(`  ${name} ... `);
    const describe = await conn.describe(name);
    const meta = metadata[name] || null;
    const fields = classifyFields(describe, meta);
    const profile = await profileRecords(conn, name, describe);

    objects.push({
      name,
      label: describe.label,
      metadataAvailable: !!meta,
      profile,
      fields,
      counts: {
        stored: fields.stored.length,
        formula: fields.formula.length,
        rollup: fields.rollup.length,
        relationship: fields.relationship.length
      },
      validationRules: [].concat((meta && meta.validationRules) || []).filter(Boolean)
    });

    fs.writeFileSync(path.join(OUT_DIR, `describe-${name}.json`), JSON.stringify(describe, null, 2));
    if (meta) fs.writeFileSync(path.join(OUT_DIR, `metadata-${name}.json`), JSON.stringify(meta, null, 2));

    const c = objects[objects.length - 1].counts;
    console.log(`${profile.count ?? '?'} records, ${c.formula} formula, ${c.rollup} roll-up`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    org: { username: identity.username, instanceUrl: conn.instanceUrl, apiVersion: conn.version },
    objects
  };

  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'SCHEMA.md'), renderMarkdown(report));

  const derived = objects.reduce((n, o) => n + o.counts.formula + o.counts.rollup, 0);
  console.log(`\nWrote ${path.relative(process.cwd(), OUT_DIR)}/`);
  console.log(`  SCHEMA.md     — start here`);
  console.log(`  summary.json  — same thing, machine-readable`);
  console.log(`  describe-*.json / metadata-*.json — raw responses`);
  console.log(`\n${derived} field(s) are computed by Salesforce and need porting by hand.`);
  console.log('Output is gitignored — this repo is public.');
}

// Only dump when run directly, so the classification and rendering can be
// exercised against fixtures without needing an org to connect to.
if (require.main === module) {
  main().catch(e => fail(`${e.name || 'Error'}: ${e.message}`));
}

module.exports = { classifyFields, renderMarkdown };
