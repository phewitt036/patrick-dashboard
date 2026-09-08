require('dotenv').config();
const express = require('express');
const path = require('path');
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
    jwt.verify(token, process.env.JWT_SECRET);
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
app.use('/api/ingest', express.json({ limit: '2mb' }), require('./routes/ingest'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
  console.log(`Income endpoints served by: ${CRM_BACKEND}`);
  if (CRM_BACKEND === 'postgres' && !process.env.DATABASE_URL) {
    console.warn('WARNING: CRM_BACKEND=postgres but DATABASE_URL is not set.');
  }
});
