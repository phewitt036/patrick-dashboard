/**
 * Shared plumbing for the migration scripts. Both the schema dump and the data
 * export need the same login and the same view of which objects matter, and the
 * credential contract is the sort of thing that drifts if it lives in two places.
 */

const jsforce = require('jsforce');

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

async function connect() {
  const { SF_USERNAME, SF_PASSWORD } = process.env;
  if (!SF_USERNAME || !SF_PASSWORD) {
    fail('SF_USERNAME and SF_PASSWORD must be set (same values routes/salesforce.js uses).');
  }
  console.log('Connecting...');
  const conn = new jsforce.Connection({ loginUrl: 'https://login.salesforce.com' });
  await conn.login(SF_USERNAME, SF_PASSWORD);
  return conn;
}

/** Every custom object in the org, so we catch ones the dashboard never touches. */
async function customObjectNames(conn) {
  const global = await conn.describeGlobal();
  return global.sobjects
    .filter(o => o.custom && o.name.endsWith('__c') && o.queryable)
    .map(o => o.name)
    .sort();
}

/**
 * Compound fields (address, geolocation) come back as nested objects that don't
 * flatten into a CSV cell, and base64 blobs aren't queryable in bulk. Their
 * component fields are returned separately, so nothing is actually lost.
 */
const UNQUERYABLE_TYPES = new Set(['address', 'location', 'base64']);

function queryableFieldNames(describe) {
  return describe.fields
    .filter(f => !UNQUERYABLE_TYPES.has(f.type) && !f.deprecatedAndHidden)
    .map(f => f.name);
}

module.exports = { fail, connect, customObjectNames, queryableFieldNames, UNQUERYABLE_TYPES };
