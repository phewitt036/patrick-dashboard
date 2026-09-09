// Drive public/records.html in a real browser against imported data.
// A page that "should work" is not a page that works.
//
//   DATABASE_URL=postgresql:///gig npx playwright install chromium
//   DATABASE_URL=postgresql:///gig npm run test:browser
//
// Needs a database with records already in it - point it at the imported copy,
// not an empty one. Writes a couple of income records.

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { chromium } = require('playwright');

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error('\n  DATABASE_URL must point at a database with imported records.\n');
  process.exit(1);
}

const ROOT = require('path').join(__dirname, '..');
let pass = 0, fail = 0;
const check = (l, ok, d) => {
  if (ok) { console.log(`PASS  ${l}`); pass++; }
  else { console.log(`FAIL  ${l}${d ? `\n        ${d}` : ''}`); fail++; }
};

// The loading placeholder is itself a <td>, so waiting for a cell can match it.
const loaded = page => page.waitForFunction(
  () => !/Loading/.test(document.querySelector('#tbody')?.textContent || 'Loading'),
  null, { timeout: 10000 });

(async () => {
  const pool = new Pool({ connectionString: DB });
  const app = express();
  app.use(express.json());
  app.use('/api/records', require(path.join(ROOT, 'routes/records')));
  app.get('/records', (_, res) => res.sendFile(path.join(ROOT, 'public/records.html')));
  app.use(express.static(path.join(ROOT, 'public')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  // CHROME_PATH lets this run where the bundled browser build differs from the
  // one installed - which is the normal case in a container.
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // A deliberate 400 from the validation test, and the socket reset when the
  // test server closes, both surface here. Neither is a page defect - only
  // uncaught exceptions and genuine load failures are.
  page.on('console', m => {
    const t = m.text();
    if (m.type() !== 'error') return;
    if (/status of 4\d\d|ERR_CONNECTION_RESET|favicon/.test(t)) return;
    errors.push('console: ' + t);
  });

  await page.goto(base + '/records', { waitUntil: 'networkidle' });

  // --- income tab loads real rows ---
  await loaded(page);
  const firstCell = await page.textContent('#tbody tr:first-child td:first-child');
  check('income rows render', !/Loading|Nothing here|Cannot reach/.test(firstCell), firstCell);

  const rowCount = await page.locator('#tbody tr').count();
  check('a full page of rows', rowCount === 50, `got ${rowCount}`);

  const summary = await page.textContent('#summary');
  const expected = Number((await pool.query('select count(*) as n from income_record')).rows[0].n);
  const shown = Number((summary.replace(/\s+/g, ' ').match(/([\d,]+) record/) || [])[1]?.replace(/,/g, ''));
  // Counted from the database, not hard-coded. A literal range read "1,5xx"
  // and went stale the first time anything added a row.
  check(`summary shows the real record count (${expected})`, shown === expected, summary);
  check('summary shows earnings', /\$[\d,]+\.\d\d earned/.test(summary), summary);

  // --- filtering ---
  await page.selectOption('#f-source', 'Doordash');
  // Wait on the summary, not the rows: load() replaces the table first, so a
  // row-only wait can pass while the previous total is still on screen.
  await page.waitForFunction(() =>
    /^\s*24\d record/.test(document.querySelector('#summary').textContent), null, { timeout: 8000 });
  const ddSummary = await page.textContent('#summary');
  check('platform filter narrows the list and the total', /24[0-9] record/.test(ddSummary.replace(/\s+/g, ' ')), ddSummary);

  await page.click('#filters button');            // Clear
  await page.waitForFunction(() => document.querySelector('#summary').textContent.includes('1'), null, { timeout: 8000 });

  // --- paging ---
  const firstBefore = await page.textContent('#tbody tr:first-child .rec');
  await page.click('#pager button:nth-of-type(2)');   // Older →
  await page.waitForFunction(prev => document.querySelector('#tbody tr:first-child .rec')?.textContent !== prev,
                             firstBefore, { timeout: 8000 });
  const firstAfter = await page.textContent('#tbody tr:first-child .rec');
  check('paging moves to different records', firstBefore !== firstAfter, `${firstBefore} -> ${firstAfter}`);

  // --- add an income record through the form ---
  await page.click('#add-btn');
  await page.waitForSelector('dialog[open]');
  check('date defaults to today', !!(await page.inputValue('#i-incomeDate')), '');
  await page.fill('#i-amount', '11.25');
  await page.fill('#i-tips', '4.00');
  await page.fill('#i-store', 'Playwright Diner');
  await page.selectOption('#i-source', 'Uber Eats');
  await page.click('#save');
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('show'), null, { timeout: 8000 });
  const added = await page.textContent('#toast');
  check('save confirms with the new record number', /Added INC-/.test(added), added);

  // --- validation surfaces in the dialog, not the console ---
  await page.click('#add-btn');
  await page.waitForSelector('dialog[open]');
  await page.fill('#i-amount', '');
  await page.click('#save');
  await page.waitForSelector('.err', { timeout: 8000 });
  const err = await page.textContent('.err');
  check('missing amount explains itself in the form', /amount is required/.test(err), err);
  await page.click('#cancel');

  // --- shifts tab ---
  await page.click('.tab[data-tab="shifts"]');
  await page.waitForFunction(() =>
    document.querySelector('#thead')?.textContent.includes('$/hr'), null, { timeout: 8000 });
  await loaded(page);
  const shiftRow = await page.textContent('#tbody tr:first-child');
  check('shifts render with a day name', /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/.test(shiftRow), shiftRow.slice(0, 120));
  const openPill = await page.locator('.pill.open').count();
  check('the one open shift is flagged', openPill === 1, `found ${openPill}`);

  // --- expenses tab ---
  await page.click('.tab[data-tab="expenses"]');
  await page.waitForFunction(() =>
    document.querySelector('#thead')?.textContent.includes('Amount'), null, { timeout: 8000 });
  await loaded(page);
  const expSummary = await page.textContent('#summary');
  check('expenses summarise spend', /7\d expense/.test(expSummary.replace(/\s+/g, ' ')) && /\$/.test(expSummary), expSummary);

  // --- responsive ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.tab[data-tab="income"]');
  await loaded(page);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal page scroll on a phone', overflow <= 1, `overflow ${overflow}px`);
  // The invariant is that the page itself never scrolls sideways, asserted
  // above. Whether the table needs to scroll is a consequence of how many
  // columns survive the mobile breakpoint - it used to have to, and now it
  // fits, which is better. Either is fine; the table spilling onto the page is
  // not.
  const wrap = await page.evaluate(() => {
    const w = document.querySelector('.table-wrap');
    return { scrolls: w.scrollWidth > w.clientWidth, contained: w.clientWidth <= document.documentElement.clientWidth };
  });
  check('the table is contained by its own box, scrolling or not',
        wrap.contained, JSON.stringify(wrap));

  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/records-mobile.png' : '/tmp/records-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/records-desktop.png' : '/tmp/records-desktop.png' });

  check('no uncaught JS errors', errors.length === 0, errors.slice(0, 3).join('\n        '));

  await browser.close();
  server.close();

  // The record added through the form above is this suite's own litter. Left
  // behind, every run added another and the counts drifted.
  const cleaned = await pool.query(
    `delete from income_record where store = 'Playwright Diner'`);
  check('the record added through the form is cleaned up', cleaned.rowCount >= 1,
        `deleted ${cleaned.rowCount}`);
  await pool.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
