// The pages behind a login, and the files the Patforce-only instance refuses,
// must stay that way however the path is spelled.
//
// Both checks used to compare the path exactly as it arrived, while
// express.static decodes and normalises it before looking for the file. So
// /%69ndex.html served the command centre with no session, and on the
// Patforce hostname it served the very page that instance exists to hide.
//
// Starts server.js twice, once in each mode, and sends raw request paths:
// fetch() would tidy /./ and %2e away before they ever reached the server.
// Needs no database.
//
//   npm run test:paths

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');

const SECRET = 'paths-test-secret';
const TOKEN = jwt.sign({ u: 'paths-test' }, SECRET, { algorithm: 'HS256', expiresIn: '10m' });
const DASHBOARD_TITLE = "Patrick's Command Center";

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); fail++; }
};

const get = (port, rawPath, session) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port, path: rawPath, method: 'GET',
    headers: session ? { Cookie: `session=${TOKEN}` } : {}
  }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', c => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
  });
  req.on('error', reject);
  req.end();
});

async function start(port, patforceOnly) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), JWT_SECRET: SECRET, PATFORCE_ONLY: patforceOnly ? '1' : '' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try { await get(port, '/login.html'); return child; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  child.kill();
  throw new Error(`server on ${port} never answered`);
}

// Every way of writing one path that a decoding, normalising static server
// would still resolve to the same file.
const spellings = p => {
  const name = p.slice(1);
  return [
    p,
    '/%' + name.charCodeAt(0).toString(16) + name.slice(1),
    p.toUpperCase(),
    '/.' + p,
    '/%2e' + p,
    '/' + p,
    '/%2f' + name,
    '/%5c' + name,
    '/x/..' + p,
    '/x/%2e%2e' + p
  ];
};

const PROTECTED = ['/index.html', '/gig.html', '/claw.html', '/records.html', '/dashboard.html'];
const PATFORCE_BLOCKED = ['/index.html', '/gig.html', '/claw.html',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png',
  '/icon-maskable-192.png', '/icon-maskable-512.png'];
const ROOT_SPELLINGS = ['/%2f', '/%2F', '/%5c', '//', '/.'];

(async () => {
  const fullPort = 39000 + Math.floor(Math.random() * 500);
  const pfPort = fullPort + 500;
  const full = await start(fullPort, false);
  const pf = await start(pfPort, true);

  try {
    console.log('--- full dashboard: no session reaches a protected page ---');
    for (const page of PROTECTED) {
      for (const p of spellings(page)) {
        const r = await get(fullPort, p);
        check(`${p} without a session is not served`, r.status !== 200,
              `got ${r.status}`);
      }
    }
    for (const p of ROOT_SPELLINGS) {
      const r = await get(fullPort, p);
      check(`${p} without a session does not serve the dashboard`,
            !r.body.includes(DASHBOARD_TITLE), `got ${r.status}`);
    }

    console.log('\n--- full dashboard: what should still work ---');
    for (const p of ['/', '/index.html', '/gig', '/claw', '/records', '/dashboard.html']) {
      const r = await get(fullPort, p, true);
      check(`${p} with a session is served`, r.status === 200, `got ${r.status}`);
    }
    const bare = await get(fullPort, '/');
    check('/ without a session goes to the login page',
          bare.status === 302 && bare.location === '/login.html', `got ${bare.status} ${bare.location}`);
    for (const p of ['/login.html', '/setup.html', '/favicon.svg', '/manifest.webmanifest',
                     '/sw.js', '/icon-192.png', '/patforce/favicon.svg']) {
      const r = await get(fullPort, p);
      check(`${p} is public`, r.status === 200, `got ${r.status}`);
    }

    console.log('\n--- Patforce-only: the command centre stays hidden ---');
    for (const file of PATFORCE_BLOCKED) {
      for (const p of spellings(file)) {
        const r = await get(pfPort, p, true);
        check(`${p} is refused even with a session`,
              r.status !== 200 && !r.body.includes(DASHBOARD_TITLE), `got ${r.status}`);
      }
    }
    for (const p of ROOT_SPELLINGS) {
      const r = await get(pfPort, p, true);
      check(`${p} does not serve the command centre`,
            !r.body.includes(DASHBOARD_TITLE), `got ${r.status}`);
    }
    for (const p of ['/api/pimax/x', '/api/%70imax/x', '/API/PIXIT/x']) {
      const r = await get(pfPort, p, true);
      check(`${p} is refused`, r.status === 404, `got ${r.status}`);
    }
    // Express matches the mount on the raw path, so this would reach the pimax
    // proxy if an undecodable path were waved through.
    const bad = await get(pfPort, '/api/pimax/%zz', true);
    check('/api/pimax/%zz is refused', bad.status === 400, `got ${bad.status}`);

    console.log('\n--- an undecodable path serves nothing ---');
    for (const [port, mode] of [[fullPort, 'full'], [pfPort, 'Patforce-only']]) {
      const r = await get(port, '/%e0%a4%a', true);
      check(`${mode}: /%e0%a4%a is refused`, r.status >= 400 && r.status < 500, `got ${r.status}`);
    }

    console.log('\n--- Patforce-only: what should still work ---');
    for (const p of ['/', '/dashboard', '/records']) {
      const r = await get(pfPort, p, true);
      check(`${p} with a session is the Patforce page`,
            r.status === 200 && r.body.includes('<title>Patforce</title>'), `got ${r.status}`);
    }
    for (const p of ['/login.html', '/setup.html', '/sw.js', '/favicon.svg',
                     '/patforce/manifest.webmanifest', '/patforce/icon-192.png']) {
      const r = await get(pfPort, p);
      check(`${p} is public`, r.status === 200, `got ${r.status}`);
    }
    const sw = await get(pfPort, '/sw.js');
    check('/sw.js is the Patforce worker', sw.body.includes("startsWith('/patforce/')"));
  } finally {
    full.kill();
    pf.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
