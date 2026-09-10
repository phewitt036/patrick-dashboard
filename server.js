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

// ---------------------------------------------------------------------------
// Patforce-only front door
// ---------------------------------------------------------------------------
// Patforce lives inside this repo, but a hostname published for the gig records
// must not double as a way into the command centre. The panels and their
// upstream proxies are nothing to do with income, and reaching them needs only
// the same session, so leaving them served would make one passkey open both.
//
// Off by default. The Vercel deployment sets nothing and stays the full
// dashboard; the pimax instance sets PATFORCE_ONLY=1 and is the CRM alone.
const PATFORCE_ONLY = process.env.PATFORCE_ONLY === '1';
if (PATFORCE_ONLY) {
  const BLOCKED_PAGES = new Set(['/index.html', '/gig', '/gig.html', '/claw', '/claw.html']);
  const BLOCKED_APIS = ['/api/pimax', '/api/pixit'];
  app.use((req, res, next) => {
    // The records screen is the front page here, not a link buried in a menu.
    if (req.path === '/') return res.redirect('/records');
    if (BLOCKED_PAGES.has(req.path)) return res.status(404).send('Not found');
    if (BLOCKED_APIS.some(a => req.path === a || req.path.startsWith(a + '/'))) {
      return res.status(404).json({ error: 'Not found' });
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

      // There is no dashboard behind this hostname, so the link back to it
      // would 404 and, more to the point, should not be here at all. Matched
      // on the tag rather than its text: the markup uses an HTML entity for
      // the arrow, which an exact-text match missed.
      const backAt = out.indexOf("<a class=\"back\"");
      if (backAt >= 0) {
        const closeAt = out.indexOf("</a>", backAt);
        if (closeAt >= 0) out = out.slice(0, backAt) + out.slice(closeAt + 4);
      }

      // Drop the dashboard icon rather than leave two competing ones.
      out = out.split('<link rel="icon" href="/favicon.svg">').join('');

      out = out.indexOf('</head>') >= 0
        ? out.replace('</head>', PWA_HEAD + '</head>')
        : PWA_HEAD + out;

      res.type('html').send(out);
    });
  };

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

// Static files (login.html, setup.html, assets — no auth)
app.use(express.static(path.join(__dirname, 'public')));

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
