# Patforce — security notes

A review of the surface this adds, done before it becomes the system of record.
The repository is public, the data is Patrick's income, and `/api/ingest` is
reachable from the internet, so the three of those together set the bar.

## Fixed

**The database password was in `ps` output.** `pg_dump` and `pg_restore` take
the connection string as a command-line argument, so the password was visible
to every user on the machine, every night at 3:15, unattended. Confirmed by
catching the running process — it was there in full. It now travels in
`PGPASSWORD`, and a process environment is readable only by the same user and
root. The host is not a bare box: on pimax agent-hub and Pixit ran beside this,
and on boss (since 2026-09-17) the fantasy advisor containers and a miner do.

**The JWT algorithm was not pinned.** `jwt.verify` was called without naming an
algorithm. The library rejects `none` by default, so this was not exploitable,
but the whole class of algorithm-confusion attack disappears for the cost of
naming `HS256` — and it stops depending on a library default staying what it is.

**`/api/ingest` had no rate limit.** It is the one route reachable without a
browser session. The key is 256 bits and not worth guessing, but a limit also
stops anyone who finds the URL from spending a Pi's CPU on it. 300 requests per
15 minutes — far above anything Pixit does, since a single request carries up
to 200 records.

**Pages and hidden files could be reached by spelling the path differently**
(fixed 2026-10-27). The login check on each page and the Patforce-only block
list compared the path as it arrived, while `express.static` decodes and
normalises it first. With no session, `/%69ndex.html`, `/./index.html`,
`//index.html` and `/x/../index.html` served the command centre, as did `/./`
through static's directory index. `dashboard.html` was served to anyone even
under its plain name. On the Patforce hostname the same spellings served every
file that instance hides, and the dashboard's own `sw.js`, favicon and pages
without their rewriting. Markup only: every figure comes from `/api`, which
checks the session itself. `canonicalPath()` in `server.js` now gives each path
one spelling for the guard in front of static and for the block list, and
static serves no directory index. `npm run test:paths` sends ten spellings of
every protected page and hidden file in both modes.

**The hub proxy put a conversation id into agent-hub's URL as it was.** Express
decodes route parameters, so an id sent as `..%2f..%2f..` reached any path on
agent-hub, carrying `AGENT_API_KEY`: on the full dashboard for any session, and
on the Patforce hostname past the block list, which then matched only the
normalised path. The id is now encoded the way `/claw/knowledge/:name` already
was, and the block list checks both spellings. Not checked: whether Vercel's
edge passes `/./` and `%2e` through to the function unchanged. The fix does not
depend on it either way.

## Checked, and sound

**SQL injection.** Values are parameterized throughout. The only identifiers
built by string interpolation are table and view names, which are literals in
the router, and column names, which come from `Object.keys()` of a
fixed-shape object built by `incomeFields`/`expenseFields` — user input never
reaches them. Sort order is a whitelist lookup with a safe default, and
direction is a ternary. Verified by pushing a key shaped like
`notes) values (1); drop table income_record; --` and a `store` value carrying
`'); drop table income_record; --`: the first was ignored, the second stored as
text, the table intact.

**CSRF.** The session cookie is `httpOnly`, `secure` outside development, and
`sameSite: 'strict'`, so a cross-site request never carries it. The mutating
endpoints need no separate token.

**The ingest key comparison** hashes both sides with SHA-256 and compares with
`timingSafeEqual`, so it leaks neither length nor content through timing.

**Secrets are not in the repository.** `.env*`, `sf-export` and `backups/` are
gitignored; no credential pattern appears in any tracked file. `install-crm.js`
writes `.env` mode 0600 and never echoes the key it generates, because that
output goes to a terminal log or gets pasted into a chat window.

**Request size and batch caps.** 2 MB body on ingest, 200 records per request,
500 rows per page on the record endpoints.

## Known, and accepted

**Error messages carry the database's own text.** A 500 returns `e.message`,
which can name a table or a constraint. The audience is an authenticated
session or a caller who already holds the ingest key, and the text is what
makes a failure diagnosable at 11pm. Left as is deliberately.

**The CSP allows `unsafe-inline` for scripts.** Every page in this dashboard is
a single file with its script inline. Removing it means nonces or hashes on all
of them; worth doing, not worth doing carelessly.

**Postgres is reached without TLS.** In the chosen arrangement the database and
the app are on the same machine and the connection never leaves it. If Patforce
and Postgres are ever split across hosts, this needs `sslmode=require` and a
certificate before that happens.
