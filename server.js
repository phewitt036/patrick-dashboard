require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"]
    }
  }
}));

app.use(cookieParser());

// One spelling per path, for the checks that decide what is hidden or behind a
// login. express.static decodes and normalises a path before it looks for the
// file, so a check on the path as it arrived could be stepped round:
// /%69ndex.html, /./index.html, //index.html and /x/../index.html all reached
// the command centre with no session. Lower-cased too, because a Windows disk
// answers /INDEX.HTML as readily as /index.html. null means it will not decode,
// and nothing should be served for it.
function canonicalPath(p) {
  let decoded;
  try { decoded = decodeURIComponent(p); } catch { return null; }
  return path.posix.normalize(decoded.split('\\').join('/')).toLowerCase();
}

// ---------------------------------------------------------------------------
// Patforce-only front door
// ---------------------------------------------------------------------------
// Patforce lives inside this repo, but a hostname published for the gig records
// must not double as a way into the command centre. The panels and their
// upstream proxies are nothing to do with income, and reaching them needs only
// the same session, so leaving them served would make one passkey open both.
//
// Off by default. The Vercel deployment sets nothing and stays the full
// dashboard; the boss instance sets PATFORCE_ONLY=1 and is the CRM alone.
const PATFORCE_ONLY = process.env.PATFORCE_ONLY === '1';
if (PATFORCE_ONLY) {
  // The command centre's manifest and icons name it and wear its mark, so they
  // go with it rather than tell this hostname what else the repo serves.
  const BLOCKED_PAGES = new Set(['/index.html', '/gig', '/gig.html', '/claw', '/claw.html',
    '/manifest.webmanifest', '/icon-192.png', '/icon-512.png',
    '/icon-maskable-192.png', '/icon-maskable-512.png']);
  const BLOCKED_APIS = ['/api/pimax', '/api/pixit'];
  app.use((req, res, next) => {
    // The records screen is the front page here, not a link buried in a menu.
    // The dashboard is the front page. Registered further down with the other
    // rewritten pages so it picks up the icon, manifest and service worker too.
    const raw = req.path.toLowerCase();
    const p = canonicalPath(req.path);
    if (p === null) return res.status(400).send('Bad request');
    if (BLOCKED_PAGES.has(p)) return res.status(404).send('Not found');
    // Both spellings. Express mounts on the raw path, so a request that starts
    // /api/pimax/ reaches that router even when its encoded slashes and dots
    // canonicalise to somewhere else entirely.
    if ([raw, p].some(x => BLOCKED_APIS.some(a => x === a || x.startsWith(a + '/')))) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Outside the APIs, a page or asset is only served under the one spelling
    // its route expects. Any other spelling skipped the rewriting below and
    // reached express.static, which handed out the dashboard's own sw.js,
    // favicon and pages untouched.
    if (raw !== p && !raw.startsWith('/api/') && !raw.startsWith('/auth/')) {
      return res.status(404).send('Not found');
    }
    next();
  });

  // Every page served here is rewritten on the way out: title, wordmark and
  // icon all say Patforce, and the head gains what Android needs before it will
  // offer to install the site to the home screen. Rewritten rather than forked,
  // so the same files still serve the real dashboard untouched.
  const PWA_HEAD = [
    '<link rel="icon" href="/patforce/favicon.svg">',
    '<link rel="apple-touch-icon" href="/patforce/apple-touch-icon.png">',
    '<link rel="manifest" href="/patforce/manifest.webmanifest">',
    '<meta name="theme-color" content="#d97706">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Patforce">',
    '<script>if ("serviceWorker" in navigator) { addEventListener("load", function () { navigator.serviceWorker.register("/sw.js"); }); }</' + 'script>'
  ].join(String.fromCharCode(10));

  // Plain string surgery rather than regular expressions: these files are ours,
  // the markers are exact, and a bad pattern here would serve a broken page.
  function replaceBetween(html, open, close, replacement) {
    const a = html.toLowerCase().indexOf(open);
    if (a < 0) return html;
    const b = html.toLowerCase().indexOf(close, a);
    if (b < 0) return html;
    return html.slice(0, a) + replacement + html.slice(b + close.length);
  }

  const DASHBOARD_WORDMARK = 'Patrick Hewitt · ';

  const patforcePage = (file, title, mark) => (req, res) => {
    fs.readFile(path.join(__dirname, 'public', file), 'utf8', (err, html) => {
      if (err) return res.status(500).send('Not available');
      let out = replaceBetween(html, '<title>', '</title>', '<title>' + title + '</title>');

      const i = out.indexOf(DASHBOARD_WORDMARK);
      if (i >= 0) {
        const j = out.indexOf('<', i);
        out = out.slice(0, i) + mark + out.slice(j);
      }

      // The command glyph is the dashboard’s own mark. Swapped for the
      // Patforce bars so nothing on the page points back at it.
      out = out.split("<span class=\"icon\">⌘</span>").join(
        "<span class=\"icon\"><img src=\"/patforce/favicon.svg\" alt=\"\" width=\"56\" height=\"56\" style=\"vertical-align:middle\"></span>");

      // '/' used to mean the command centre, so this link was stripped. It now
      // means the Patforce dashboard, so it is relabelled and kept: the records
      // page otherwise has no way back to the morning view.
      const backAt = out.indexOf('<a class="back"');
      if (backAt >= 0) {
        const closeAt = out.indexOf('</a>', backAt);
        if (closeAt >= 0) {
          out = out.slice(0, backAt) +
                '<a class="back" href="/">&larr; Dashboard</a>' +
                out.slice(closeAt + 4);
        }
      }

      // Drop the dashboard icon rather than leave two competing ones.
      out = out.split('<link rel="icon" href="/favicon.svg">').join('');

      out = out.indexOf('</head>') >= 0
        ? out.replace('</head>', PWA_HEAD + '</head>')
        : PWA_HEAD + out;

      res.type('html').send(out);
    });
  };

  // The morning view, and the front page. Served through the same rewriter as
  // everything else so it carries the manifest, the icon and the worker.
  app.get(['/', '/dashboard', '/dashboard.html'], requireAuth,
    patforcePage('dashboard.html', 'Patforce', 'Patforce'));

  app.get(['/records', '/records.html'], requireAuth,
    patforcePage('records.html', 'Patforce', 'Patforce · Gig Records'));
  app.get(['/login.html', '/login'],
    patforcePage('login.html', 'Patforce', 'Patforce · Gig Records'));
  app.get(['/setup.html', '/setup'],
    patforcePage('setup.html', 'Patforce Setup', 'Patforce · Passkey Setup'));

  // A service worker may only control paths at or below its own, so it has to be
  // served from the root even though it lives with the other Patforce assets.
  app.get('/sw.js', (req, res) => {
    res.type('application/javascript')
       .sendFile(path.join(__dirname, 'public', 'patforce', 'sw.js'));
  });

  // The last visual tie to the dashboard: anything still asking for the old
  // icon path gets the new mark instead.
  app.get('/favicon.svg', (req, res) => {
    res.type('image/svg+xml')
       .sendFile(path.join(__dirname, 'public', 'patforce', 'favicon.svg'));
  });
}

// Screenshot uploads are base64 in the JSON body, so this route needs a much larger
// limit than the rest of the app. Mounted ahead of the global parser so raising it
// here does not raise it everywhere.
app.use('/api/pixit', requireAuth, express.json({ limit: '15mb' }), require('./routes/pixit'));

app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

function requireAuth(req, res, next) {
  // originalUrl, not path. Express strips the mount prefix off req.url before
  // calling middleware mounted with app.use('/api/income', ...), so req.path is
  // '/score' there and this test read false for every API route. An expired
  // session then answered fetch() with a 302 to login.html, which the browser
  // followed, and the page died on res.json() parsing HTML instead of saying
  // the session had expired.
  const isApi = req.originalUrl.startsWith('/api');
  const token = req.cookies?.session;
  if (!token) {
    if (!isApi) return res.redirect('/login.html');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.clearCookie('session');
    if (!isApi) return res.redirect('/login.html');
    return res.status(401).json({ error: 'Session expired' });
  }
}

// Public auth routes
app.use('/auth', authLimiter, require('./routes/auth'));

// Protected dashboard
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/gig', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'gig.html')));
app.get('/gig.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'gig.html')));
app.get('/claw', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'claw.html')));
app.get('/records', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'records.html')));
app.get('/records.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'records.html')));
app.get('/claw.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'claw.html')));

// The routes above guard each page by its exact name, but express.static below
// will serve the same file under any spelling that decodes to it. So every
// request that would land on a protected page is checked again here, by what
// it means rather than how it was written. dashboard.html had no route of its
// own on the full dashboard and was served to anyone.
const PROTECTED_FILES = new Set(['/index.html', '/gig.html', '/claw.html',
  '/records.html', '/dashboard.html']);
// A path that will not decode is passed on: express.static cannot decode it
// either and answers 400, and the API routes after it keep their own handling.
app.use((req, res, next) => {
  const p = canonicalPath(req.path);
  return p !== null && PROTECTED_FILES.has(p) ? requireAuth(req, res, next) : next();
});

// Static files (login.html, setup.html, assets — no auth). No directory index:
// the front page is the guarded '/' route, and with an index /./ and /x/../
// were folders that static answered with index.html and no session.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Protected API routes
// Cutover is a config change, not a code change. CRM_BACKEND=postgres serves
// the income endpoints from the local database; anything else keeps Salesforce.
// Both implement the same eight paths with the same JSON, so flipping it back is
// the rollback - no deploy, no edit, no thinking required at the point where
// thinking is hardest.
const CRM_BACKEND = process.env.CRM_BACKEND === 'postgres' ? 'postgres' : 'salesforce';
app.use('/api/income', requireAuth,
  require(CRM_BACKEND === 'postgres' ? './routes/income' : './routes/salesforce'));

// The record-management screens. A new path alongside the Salesforce-backed
// endpoints rather than in place of them - cutover is a separate decision, and
// until then both can be reached at once for comparison.
app.use('/api/records', requireAuth, require('./routes/records'));
app.use('/api/pimax', requireAuth, require('./routes/pimax'));

// Machine-to-machine ingestion. Deliberately not behind requireAuth: Pixit has
// no browser session, so this router does its own INGEST_KEY check and answers
// 503 until that key is set.
//
// Rate limited because it is the one route reachable from the internet without
// a browser session. The key is 256 bits and not worth guessing, but a limit
// also keeps anyone who finds the URL from spending a Pi's CPU on it.
const ingestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/ingest', ingestLimiter, express.json({ limit: '2mb' }), require('./routes/ingest'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
  console.log(`Income endpoints served by: ${CRM_BACKEND}`);
  if (CRM_BACKEND === 'postgres' && !process.env.DATABASE_URL) {
    console.warn('WARNING: CRM_BACKEND=postgres but DATABASE_URL is not set.');
  }
});
