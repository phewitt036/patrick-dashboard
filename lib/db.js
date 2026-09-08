/**
 * Postgres pool for the gig CRM.
 *
 * Two type parsers are overridden, both so the API can return exactly what the
 * Salesforce one did. node-postgres is being cautious by default; the dashboard
 * needs the older, looser shapes.
 */

const { Pool, types } = require('pg');

// NUMERIC arrives as a string, because it can hold values no JS number can.
// Everything here is money at two decimals or hours at two, all far inside
// float64's exact-integer range once scaled, and gig.html calls .toFixed() on
// these directly — a string would render as "43.25.00" or throw.
types.setTypeParser(types.builtins.NUMERIC, parseFloat);

// DATE arrives as a JS Date, which JSON-serialises to a full timestamp and
// shifts across midnight depending on the server's zone. Salesforce sent bare
// 'YYYY-MM-DD' and gig.html splits on '-', so hand back the string unchanged.
types.setTypeParser(types.builtins.DATE, v => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000
});

/** Run fn inside a transaction, rolling back on any throw. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
