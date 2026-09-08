// Drive public/gig.html in a real browser against the Postgres backend.
//
// This is the cutover test. The 45 assertions in income-api.test.js prove the
// JSON is the right shape; this proves the page Patrick actually uses every day
// renders that JSON without a single line of it changing. Flipping
// CRM_BACKEND=postgres is only safe if this passes.
//
// Chart.js is stubbed. The page loads it from a CDN, and what matters here is
// whether the page hands it real numbers, not whether Chart.js can draw them.
//
//   DATABASE_URL=postgresql:///gig npm run test:gig
//   CHROME_PATH=/path/to/chrome npm run test:gig   (if the bundled browser is missing)

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error('\n  DATABASE_URL must point at a database with the schema and some data.\n');
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (l, ok, d) => {
  if (ok) { console.log(`PASS  ${l}`); pass++; }
  else { console.log(`FAIL  ${l}${d ? `\n        ${d}` : ''}`); fail++; }
};
const money = s => /^\$[\d,]+\.\d\d$/.test((s || '').trim());

(async () => {
  // Seed a shift for today with income on it, so every panel has something to
  // show whenever this runs. Cleaned up at the end.
  const p = new Pool({ connectionString: DB });
  const today = (await p.query(`select to_char(current_date, 'YYYY-MM-DD') as d`)).rows[0].d;
  const week = (await p.query(
    `insert into weekly_cash_flow (start_date) values (date_trunc('week', current_date)::date)
     on conflict (start_date) do update set start_date = excluded.start_date returning id`)).rows[0].id;
  const shift = (await p.query(
    `insert into daily_cash_flow (weekly_cash_flow_id, shift_date, clock_in, clock_out, total_shift_miles)
     values ($1, current_date, current_date + interval '10 hours', current_date + interval '15 hours', 42)
     returning id`, [week])).rows[0].id;
  const seeded = [];
  for (const [amount, tips, mins] of [[12.5, 4, 22], [8.75, 2.5, 15], [19.2, 0, 31]]) {
    const { rows } = await p.query(
      `insert into income_record (daily_cash_flow_id, income_date, source, store, amount, tips,
                                  miles_driven, total_miles, time_taken_minutes)
       values ($1, current_date, 'Doordash', 'Gig Browser Test', $2, $3, 5.5, 7.2, $4) returning id`,
      [shift, amount, tips, mins]);
    seeded.push(rows[0].id);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/income', require('../routes/income'));
  // Pixit is a separate integration and unrelated to the backend swap; stubbed
  // so its panel does not log failures that look like page defects.
  app.get('/api/pixit/trackers', (_, res) => res.json({ success: true, trackers: [] }));
  app.get('/gig', (_, res) => res.sendFile(path.join(ROOT, 'public/gig.html')));
  // Mounted so the Records link can actually be followed, not just found.
  app.use('/api/records', require('../routes/records'));
  app.get('/records', (_, res) => res.sendFile(path.join(ROOT, 'public/records.html')));
  app.use(express.static(path.join(ROOT, 'public')));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() !== 'error') return;
    if (/status of 4\d\d|ERR_CONNECTION_RESET|favicon/.test(t)) return;
    errors.push('console: ' + t);
  });

  // Stand in for the CDN, and record what the page asks it to draw.
  await page.route('**/chart.umd.min.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.__charts = [];
           window.Chart = class { constructor(ctx, config) { window.__charts.push(config); } destroy() {} };`
  }));

  await page.goto(base + '/gig', { waitUntil: 'networkidle' });

  // --- the income panel ------------------------------------------------------
  await page.waitForFunction(() =>
    document.getElementById('weekly-display')?.textContent.trim() !== '--', null, { timeout: 15000 });

  const weekly = (await page.textContent('#weekly-display')).trim();
  check('weekly income renders a real figure', money(weekly), weekly);
  const monthly = (await page.textContent('#monthly-display')).trim();
  check('monthly income renders a real figure', money(monthly), monthly);

  const sub = (await page.textContent('#weekly-sub')).trim();
  check('the panel is not reporting the backend as unavailable', sub !== 'unavailable', sub);
  check('and it names the backend it actually read', /postgres/i.test(sub), sub);

  // --- the trend chart -------------------------------------------------------
  const charts = await page.evaluate(() => window.__charts || []);
  check('a trend chart was built', charts.length >= 1, `${charts.length} charts`);
  const labels = charts[0]?.data?.labels || [];
  const values = charts[0]?.data?.datasets?.[0]?.data || [];
  check('with real months, not the empty-state placeholder',
        labels.length > 1 && !labels.includes('No data') && !labels.includes('No data yet'),
        JSON.stringify(labels).slice(0, 120));
  check('and non-zero totals', values.some(v => Number(v) > 0), JSON.stringify(values).slice(0, 120));

  // --- the weekly report card ------------------------------------------------
  await page.waitForFunction(() =>
    document.getElementById('wr-range')?.textContent.trim() !== '', null, { timeout: 15000 });
  const range = (await page.textContent('#wr-range')).trim();
  check('the weekly report card fills in', !/error loading/.test(range), range);
  check('  with a date range', /[A-Z][a-z]{2} \d+ – [A-Z][a-z]{2} \d+/.test(range), range);
  const wrIncome = (await page.textContent('#wr-income')).trim();
  check('  weekly gross', money(wrIncome), wrIncome);
  const wrNet = (await page.textContent('#wr-net')).trim();
  check('  weekly net', money(wrNet), wrNet);
  check('  a per-shift-hour rate', /^\$\d+\.\d\d$/.test((await page.textContent('#wr-shift-rate')).trim()),
        await page.textContent('#wr-shift-rate'));
  const bars = await page.locator('#wr-days > *').count();
  check('  and a bar per day worked', bars >= 1, `${bars} bars`);

  // The two numbers that disagreed in Salesforce now come from one definition.
  const weeklyNum = Number(weekly.replace(/[$,]/g, ''));
  const wrNum = Number(wrIncome.replace(/[$,]/g, ''));
  check('the two weekly totals on this page agree', Math.abs(weeklyNum - wrNum) < 0.005,
        `panel ${weekly} vs report ${wrIncome}`);

  // --- the day score ---------------------------------------------------------
  await page.fill('#score-date', today);
  await page.click('#score-load-btn');
  await page.waitForFunction(() =>
    document.getElementById('score-composite')?.textContent.trim() !== '—', null, { timeout: 15000 });
  const composite = (await page.textContent('#score-composite')).trim();
  check('the day score computes', /^\d+(\.\d+)?$/.test(composite), composite);
  const metrics = await page.locator('#score-grid > *').count();
  check('  with the metric breakdown', metrics >= 1, `${metrics} metrics`);
  const scoreStatus = (await page.textContent('#score-status')).trim();
  check('  and no error beside it', !/error|unavailable|fail/i.test(scoreStatus), scoreStatus);

  // --- shift status ----------------------------------------------------------
  const idle = await page.locator('#shift-idle').isVisible();
  const active = await page.locator('#shift-active').isVisible();
  check('exactly one of the shift panels is showing', idle !== active, `idle=${idle} active=${active}`);

  // What the page shows has to match what is actually in the database, rather
  // than what this test assumed: the imported history really does contain an
  // open shift, so hard-coding "idle" here failed against real data and the
  // page was right. Open means clocked in and not yet out - the same test the
  // one-open-shift index uses.
  const openShifts = Number((await p.query(
    `select count(*) as n from daily_cash_flow
      where clock_in is not null and clock_out is null`)).rows[0].n);
  check(`the shift panel agrees with the database (${openShifts} open)`,
        active === (openShifts > 0), `active=${active}, open shifts=${openShifts}`);
  if (openShifts > 0) {
    const info = (await page.textContent('#shift-info')).trim();
    check('  and the open shift shows its details', info.length > 0, info);
  }

  // --- the record screens are reachable ---------------------------------------
  // They were built and then linked from nowhere, so the only way in was typing
  // the URL. Finding the link in the markup is not the test; following it is.
  const recordsLink = page.locator('a[href="/records"]');
  check('gig.html links to the record screens', await recordsLink.count() > 0, '');
  await Promise.all([
    page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
    recordsLink.first().click()
  ]);
  check('  and following it lands on /records', /\/records$/.test(page.url()), page.url());
  await page.waitForFunction(
    () => !/Loading/.test(document.querySelector('#tbody')?.textContent || 'Loading'),
    null, { timeout: 15000 });
  const firstRow = await page.textContent('#tbody tr:first-child');
  check('  and the page they lead to loads real rows',
        !/Nothing here|Cannot reach/.test(firstRow), firstRow.slice(0, 80));
  await page.goBack();
  await page.waitForFunction(() =>
    document.getElementById('weekly-display')?.textContent.trim() !== '--', null, { timeout: 15000 });

  // --- responsive ------------------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal page scroll on a phone', overflow <= 1, `overflow ${overflow}px`);

  await page.screenshot({ path: path.join(require('os').tmpdir(), 'gig-postgres.png'), fullPage: false });

  check('no uncaught JS errors', errors.length === 0, errors.slice(0, 3).join('\n        '));

  await browser.close();
  server.close();

  // Clean up, so this suite can be run repeatedly against the same database.
  await p.query('delete from income_record where id = any($1::bigint[])', [seeded]);
  await p.query('delete from daily_cash_flow where id = $1', [shift]);
  await p.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
