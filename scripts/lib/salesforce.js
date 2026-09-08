/**
 * Shared plumbing for the migration scripts. Both the schema dump and the data
 * export need the same login and the same view of which objects matter, and the
 * credential contract is the sort of thing that drifts if it lives in two places.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const jsforce = require('jsforce');

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

/**
 * One readline interface for a whole run of questions. Opening and closing one
 * per question tears down stdin with it, so the second question reads EOF and
 * never returns — the sequence just stops half-answered.
 *
 * Hiding the typed answer relies on question() writing its prompt synchronously:
 * mute immediately after that call and the question is visible while the reply
 * is not.
 */
function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let muted = false;
  let pending = null;

  rl._writeToOutput = s => { if (!muted) rl.output.write(s); };

  // If stdin ends mid-sequence, unblock the waiting question instead of hanging.
  rl.on('close', () => {
    if (pending) { const resolve = pending; pending = null; resolve(''); }
  });

  return {
    ask(question, { hidden = false } = {}) {
      return new Promise(resolve => {
        pending = resolve;
        rl.question(question, answer => {
          if (muted) { muted = false; rl.output.write('\n'); }
          pending = null;
          resolve(answer.trim());
        });
        muted = hidden;
      });
    },
    close() { rl.close(); }
  };
}

/**
 * Credentials come from .env when it exists, and otherwise from a prompt —
 * setting up a .env on every machine you happen to be sitting at is friction
 * these scripts don't need to impose. Offers to save afterwards so the second
 * script of the pair doesn't ask again; .env is gitignored, which is exactly
 * where a credential belongs.
 */
async function promptForCredentials() {
  if (!process.stdin.isTTY) {
    fail('SF_USERNAME and SF_PASSWORD must be set (same values routes/salesforce.js uses).');
  }

  console.log('\nNo Salesforce credentials found. They are the same two values');
  console.log('routes/salesforce.js already uses in production.\n');

  const prompt = makePrompter();
  try {
    const username = await prompt.ask('  Salesforce username: ');
    const password = await prompt.ask('  Password + security token (hidden): ', { hidden: true });

    if (!username || !password) fail('Both a username and a password are required.');

    const save = await prompt.ask('\n  Save to .env so the next script does not ask? [y/N] ');
    if (/^y(es)?$/i.test(save)) {
      const envPath = path.join(__dirname, '..', '..', '.env');
      const line = `SF_USERNAME=${username}\nSF_PASSWORD=${password}\n`;
      fs.appendFileSync(envPath, (fs.existsSync(envPath) ? '\n' : '') + line, { mode: 0o600 });
      console.log(`  Written to ${envPath} (gitignored).`);
    }

    return { username, password };
  } finally {
    prompt.close();
  }
}

async function connect() {
  let username = process.env.SF_USERNAME;
  let password = process.env.SF_PASSWORD;

  if (!username || !password) {
    ({ username, password } = await promptForCredentials());
  }

  console.log('\nConnecting...');
  const conn = new jsforce.Connection({ loginUrl: 'https://login.salesforce.com' });
  try {
    await conn.login(username, password);
  } catch (e) {
    // By far the most common cause, and the error text alone doesn't say so.
    if (/INVALID_LOGIN/i.test(e.message || '')) {
      fail(
        'Salesforce rejected the login.\n' +
        '  The password must have your security token appended directly to it,\n' +
        '  with no space or separator between them.'
      );
    }
    throw e;
  }
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

module.exports = {
  fail, connect, customObjectNames, queryableFieldNames, UNQUERYABLE_TYPES,
  makePrompter, promptForCredentials
};
