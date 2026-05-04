require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const app = express();

app.use(express.json());
app.use(cookieParser());

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
app.use('/auth', require('./routes/auth'));

// Protected dashboard
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Static files (login.html, setup.html, assets — no auth)
app.use(express.static(path.join(__dirname, 'public')));

// Protected API routes
app.use('/api/income', requireAuth, require('./routes/salesforce'));
app.use('/api/agent', require('./routes/agents'));
app.use('/api/pimax', requireAuth, require('./routes/pimax'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT}`));
