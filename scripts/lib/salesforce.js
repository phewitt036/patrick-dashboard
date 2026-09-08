/**
 * Shared plumbing for the migration scripts. Both the schema dump and the data
 * export need the same login and the same view of which objects matter, and the
 * credential contract is the sort of thing that drifts if it lives in two places.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
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

/**
 * Borrow the Salesforce CLI's existing session.
 *
 * This is how the org is actually reached in practice — the vault records
 * `sf org display --target-org pat@patsdelivery.com --json` as the auth method,
 * and Pixit pushes with a CLI token too. Preferred over a password because it
 * needs no secret typed anywhere, survives MFA, and does not care whether the
 * machine sits in a trusted IP range — which a password plus security token
 * very much does.
 *
 * Windows installs the CLI as sf.cmd, which execFileSync will not find under
 * the bare name, hence the list.
 */
function sfCliSession(username) {
  const args = ['org', 'display', '--json'];
  if (username) args.push('--target-org', username);

  for (const bin of ['sf', 'sf.cmd', 'sfdx', 'sfdx.cmd']) {
    try {
      const out = execFileSync(bin, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 60_000
      });
      const result = (JSON.parse(out) || {}).result || {};
      if (result.accessToken && result.instanceUrl) {
        return {
          accessToken: result.accessToken,
          instanceUrl: result.instanceUrl,
          username: result.username || username || 'unknown',
          via: bin
        };
      }
    } catch {
      // Not installed under this name, no authenticated org, or expired.
      // Try the next candidate and fall back to a password if none work.
    }
  }
  return null;
}

async function connect() {
  // An explicit token wins: it is the only way to point these scripts at an org
  // the CLI does not know about.
  if (process.env.SF_ACCESS_TOKEN && process.env.SF_INSTANCE_URL) {
    console.log('\nConnecting with SF_ACCESS_TOKEN...');
    return new jsforce.Connection({
      accessToken: process.env.SF_ACCESS_TOKEN,
      instanceUrl: process.env.SF_INSTANCE_URL
    });
  }

  const cli = sfCliSession(process.env.SF_USERNAME);
  if (cli) {
    console.log(`\nConnecting as ${cli.username} using the ${cli.via} CLI session.`);
    return new jsforce.Connection({
      accessToken: cli.accessToken,
      instanceUrl: cli.instanceUrl
    });
  }

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
    if (/INVALID_LOGIN/i.test(e.message || '')) {
      fail(
        'Salesforce rejected that username and password.\n\n' +
        '  Three things cause this, in rough order of likelihood:\n\n' +
        '  1. The password needs your security token appended directly to it,\n' +
        '     with no space between them. A password that works in the browser\n' +
        '     is not enough on its own.\n\n' +
        '  2. The value works from a trusted IP range and not from here. If the\n' +
        '     profile trusts the range your server deploys from, Salesforce never\n' +
        '     asks it for a token, so the stored value may not contain one.\n\n' +
        '  3. Multi-factor auth is enforced, which blocks this kind of login\n' +
        '     outright however the password is assembled.\n\n' +
        (process.env.SF_PASSWORD
          ? '  The value being used came from .env or the environment, not from a\n' +
            '  prompt — so re-running will keep failing the same way until that\n' +
            '  file is corrected or deleted.\n\n'
          : '') +
        '  All three go away with the Salesforce CLI, which is how this org is\n' +
        '  reached everywhere else:\n\n' +
        '      sf org login web --alias patsdelivery\n\n' +
        '  Then re-run this command. It picks the CLI session up automatically —\n' +
        '  no password, no token.'
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
