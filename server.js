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

app.use(express.json());
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) {
    if (!req.path.startsWith('/api')) return res.redirect('/login.html');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.clearCookie('session');
    if (!req.path.startsWith('/api')) return res.redirect('/login.html');
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
app.get('/claw.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'claw.html')));

// Static files (login.html, setup.html, assets — no auth)
app.use(express.static(path.join(__dirname, 'public')));

// Protected API routes
app.use('/api/income', requireAuth, require('./routes/salesforce'));
app.use('/api/pimax', requireAuth, require('./routes/pimax'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT}`));
