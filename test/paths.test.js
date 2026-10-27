// The pages behind a login, and the files the Patforce-only instance refuses,
// must stay that way however the path is spelled.
//
// Both checks used to compare the path exactly as it arrived, while
// express.static decodes and normalises it before looking for the file. So
// /%69ndex.html and /./ served the command centre with no session, and on the
// Patforce hostname they served the very page that instance exists to hide.
// The hub proxy had the same flaw one level down: a conversation id of
// ..%2f..%2f.. walked out of /chat/conversations to any path on agent-hub.
//
// Starts server.js twice, once in each mode, against a stub agent-hub that
// records what reaches it, and sends raw request paths: fetch() would tidy /./
// and %2e away before they ever reached the server. Needs no database.
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

const send = (port, rawPath, { session, method = 'GET' } = {}) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port, path: rawPath, method,
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

// Follows 301s, which static uses to add a slash to a folder, so a redirect is
// judged by where it lands rather than passing because it is not a 200. The
// 302 to the login page is the answer being tested for, so it is not followed.
async function land(port, rawPath, opts) {
  let r = await send(port, rawPath, opts);
  for (let i = 0; i < 3 && r.status === 301 && r.location && r.location.startsWith('/'); i++) {
    r = await send(port, r.location, opts);
  }
  return r;
}

const toLogin = r => r.status === 302 && r.location === '/login.html';
// 401 is requireAuth's answer when the URL as sent begins /api, as
// /api/../index.html does, in place of the login redirect a page gets.
const refused = r => r.status === 400 || r.status === 401 || r.status === 404;
const show = r => `got ${r.status}${r.location ? ' -> ' + r.location : ''}`;

async function start(port, env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), JWT_SECRET: SECRET, ...env },
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try { await send(port, '/login.html'); return child; }
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
    '/x/%2e%2e' + p,
    // Under the prefixes the Patforce spelling rule leaves alone.
    '/api/..' + p,
    '/api/%2e%2e' + p,
    '/api/%2e%2e%2f' + name,
    '/auth/..' + p,
    '/auth/%2e%2e' + p
  ];
};

const PROTECTED = ['/index.html', '/gig.html', '/claw.html', '/records.html', '/dashboard.html'];
const PATFORCE_BLOCKED = ['/index.html', '/gig.html', '/claw.html',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png',
  '/icon-maskable-192.png', '/icon-maskable-512.png'];
// The pages and assets the Patforce instance rewrites or swaps. Under any
// other spelling they would come from static as the dashboard's own files.
const PATFORCE_REWRITTEN = ['/sw.js', '/favicon.svg', '/login.html', '/setup.html',
  '/records.html', '/dashboard.html'];
const ROOT_SPELLINGS = ['/.', '/./', '/%2e/', '/x/../', '/x/%2e%2e/', '/%2f', '/%2F', '/%5c', '//'];
// Parameters that would step out of their folder on the hub. '..' survives
// encodeURIComponent, so the one-level ones matter as much as the deep ones.
const TRAVERSAL = [
  ['GET', '/api/pimax/claw/conversations/..%2f..%2f..%2f../messages'],
  ['DELETE', '/api/pimax/claw/conversations/..%2f..%2f..%2f..'],
  ['GET', '/api/pimax/claw/conversations/%2e%2e/messages'],
  ['DELETE', '/api/pimax/claw/conversations/%2e%2e'],
  ['DELETE', '/api/pimax/claw/conversations/1%2f..'],
  ['DELETE', '/api/pimax/claw/knowledge/%2e%2e'],
  ['DELETE', '/api/pimax/claw/knowledge/.']
];

(async () => {
  const hubSeen = [];
  const hub = http.createServer((req, res) => {
    hubSeen.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  }).listen(0);
  await new Promise(r => hub.once('listening', r));
  const hubEnv = { AGENT_HUB_URL: `http://127.0.0.1:${hub.address().port}`, AGENT_API_KEY: 'paths-test-key' };

  const fullPort = 39000 + Math.floor(Math.random() * 500);
  const pfPort = fullPort + 500;
  const full = await start(fullPort, { ...hubEnv, PATFORCE_ONLY: '' });
  const pf = await start(pfPort, { ...hubEnv, PATFORCE_ONLY: '1' });

  try {
    console.log('--- full dashboard: no session reaches a protected page ---');
    for (const page of PROTECTED) {
      for (const p of spellings(page)) {
        const r = await land(fullPort, p);
        check(`${p} without a session goes to login or is refused`,
              toLogin(r) || refused(r), show(r));
      }
    }
    for (const p of ROOT_SPELLINGS) {
      const r = await land(fullPort, p);
      check(`${p} without a session goes to login or is refused`,
            toLogin(r) || refused(r), show(r));
    }

    console.log('\n--- full dashboard: what should still work ---');
    for (const p of ['/', '/index.html', '/gig', '/claw', '/records', '/dashboard.html']) {
      const r = await send(fullPort, p, { session: true });
      check(`${p} with a session is served`, r.status === 200, show(r));
    }
    const front = await send(fullPort, '/', { session: true });
    check('/ with a session is the command centre', front.body.includes(DASHBOARD_TITLE));
    const bare = await send(fullPort, '/');
    check('/ without a session goes to the login page', toLogin(bare), show(bare));
    for (const p of ['/login.html', '/setup.html', '/favicon.svg', '/manifest.webmanifest',
                     '/sw.js', '/icon-192.png', '/patforce/favicon.svg']) {
      const r = await send(fullPort, p);
      check(`${p} is public`, r.status === 200, show(r));
    }

    console.log('\n--- full dashboard: the hub proxy stays inside its own paths ---');
    for (const [method, p] of TRAVERSAL) {
      hubSeen.length = 0;
      const r = await send(fullPort, p, { session: true, method });
      check(`${method} ${p} is refused before the hub`,
            r.status === 400 && hubSeen.length === 0, `${show(r)}, hub saw ${JSON.stringify(hubSeen)}`);
    }
    for (const [method, p, upstream] of [
      ['GET', '/api/pimax/claw/conversations/42/messages', 'GET /chat/conversations/42/messages'],
      ['DELETE', '/api/pimax/claw/conversations/42', 'DELETE /chat/conversations/42'],
      ['DELETE', '/api/pimax/claw/knowledge/notes.v2.md', 'DELETE /chat/knowledge/notes.v2.md'],
      ['DELETE', '/api/pimax/claw/knowledge/my%20file.txt', 'DELETE /chat/knowledge/my%20file.txt']
    ]) {
      hubSeen.length = 0;
      await send(fullPort, p, { session: true, method });
      check(`${method} ${p} still reaches the hub as ${upstream}`,
            hubSeen.length === 1 && hubSeen[0] === upstream, `hub saw ${JSON.stringify(hubSeen)}`);
    }

    console.log('\n--- Patforce-only: the command centre stays hidden ---');
    for (const file of PATFORCE_BLOCKED) {
      for (const p of spellings(file)) {
        const r = await land(pfPort, p, { session: true });
        check(`${p} is refused even with a session`, refused(r), show(r));
      }
    }
    for (const p of ROOT_SPELLINGS) {
      const r = await land(pfPort, p, { session: true });
      check(`${p} is refused`, refused(r) && !r.body.includes(DASHBOARD_TITLE), show(r));
    }
    for (const file of PATFORCE_REWRITTEN) {
      for (const p of spellings(file).slice(3)) {
        const r = await land(pfPort, p, { session: true });
        check(`${p} is refused rather than served unrewritten`, refused(r), show(r));
      }
    }
    for (const p of ['/api/pimax/x', '/api/%70imax/x', '/API/PIXIT/x', '/api/pimax/%zz']) {
      const r = await send(pfPort, p, { session: true });
      check(`${p} is refused`, refused(r), show(r));
    }
    hubSeen.length = 0;
    for (const [method, p] of TRAVERSAL) {
      const r = await send(pfPort, p, { session: true, method });
      check(`${method} ${p} is refused`, refused(r), show(r));
    }
    check('nothing from the Patforce instance reached the hub', hubSeen.length === 0,
          `hub saw ${JSON.stringify(hubSeen)}`);

    console.log('\n--- Patforce-only: what should still work ---');
    for (const p of ['/', '/dashboard', '/records', '/LOGIN.HTML']) {
      const r = await send(pfPort, p, { session: true });
      check(`${p} is the Patforce page`,
            r.status === 200 && r.body.includes('<title>Patforce</title>'), show(r));
    }
    for (const p of ['/login.html', '/setup.html', '/sw.js', '/favicon.svg',
                     '/patforce/manifest.webmanifest', '/patforce/icon-192.png']) {
      const r = await send(pfPort, p);
      check(`${p} is public`, r.status === 200, show(r));
    }
    const sw = await send(pfPort, '/sw.js');
    check('/sw.js is the Patforce worker', sw.body.includes("startsWith('/patforce/')"));
    const records = await send(pfPort, '/api/records/meta', { session: true });
    check('/api/records is not caught by the spelling rule', !refused(records), show(records));

    console.log('\n--- an undecodable path serves nothing ---');
    for (const [port, mode] of [[fullPort, 'full'], [pfPort, 'Patforce-only']]) {
      const r = await send(port, '/%e0%a4%a', { session: true });
      check(`${mode}: /%e0%a4%a is refused`, refused(r), show(r));
    }
  } finally {
    full.kill();
    pf.kill();
    hub.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
