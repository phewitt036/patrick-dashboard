const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const RP_NAME = 'Patrick Dashboard';
const RP_ID = () => process.env.RP_ID || 'patrick-dashboard.vercel.app';
const ORIGIN = () => process.env.ORIGIN || `https://${RP_ID()}`;

let pendingChallenge = null;

function getStoredCredentials() {
  const json = process.env.WEBAUTHN_CREDENTIALS;
  if (json) {
    try { return JSON.parse(json); } catch { return []; }
  }
  // Legacy fallback — single credential env vars
  const id = process.env.WEBAUTHN_CREDENTIAL_ID;
  const pubKey = process.env.WEBAUTHN_PUBLIC_KEY;
  return (id && pubKey) ? [{ id, publicKey: pubKey }] : [];
}

// Registration step 1 — get options
router.get('/register/challenge', async (req, res) => {
  const existing = getStoredCredentials();
  if (existing.length && req.headers['x-setup-key'] !== process.env.AGENT_API_KEY) {
    return res.status(403).json({ error: 'Already registered.' });
  }
  try {
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID(),
      userID: new TextEncoder().encode('patrick'),
      userName: 'patrick',
      userDisplayName: 'Patrick',
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred'
      }
    });
    pendingChallenge = options.challenge;
    res.json(options);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Registration step 2 — verify and return credential to store as env vars
router.post('/register/verify', async (req, res) => {
  try {
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: pendingChallenge,
      expectedOrigin: ORIGIN(),
      expectedRPID: RP_ID(),
      requireUserVerification: true
    });
    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });
    const { credential } = verification.registrationInfo;
    const existing = getStoredCredentials();
    const newCred = { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url') };
    const updated = [...existing, newCred];
    res.json({
      success: true,
      WEBAUTHN_CREDENTIALS: JSON.stringify(updated),
      message: 'Set WEBAUTHN_CREDENTIALS env var to this value, then redeploy.'
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Auth step 1 — get challenge
router.get('/challenge', async (req, res) => {
  try {
    const credentials = getStoredCredentials();
    const options = await generateAuthenticationOptions({
      rpID: RP_ID(),
      userVerification: 'required',
      allowCredentials: credentials.map(c => ({ id: c.id, type: 'public-key' }))
    });
    pendingChallenge = options.challenge;
    res.json(options);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auth step 2 — verify and set session cookie
router.post('/verify', async (req, res) => {
  const credentials = getStoredCredentials();
  if (!credentials.length) return res.status(400).json({ error: 'No passkey registered. Visit /setup.html first.' });
  const match = credentials.find(c => c.id === req.body.id);
  if (!match) return res.status(401).json({ error: 'Credential not recognized.' });
  try {
    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: pendingChallenge,
      expectedOrigin: ORIGIN(),
      expectedRPID: RP_ID(),
      credential: { id: match.id, publicKey: Buffer.from(match.publicKey, 'base64url'), counter: 0 },
      requireUserVerification: true
    });
    if (!verification.verified) return res.status(401).json({ error: 'Authentication failed' });
    const token = jwt.sign({ user: 'patrick' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.cookie('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000
    });
    res.json({ success: true });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// Session check
router.get('/status', (req, res) => {
  const token = req.cookies?.session;
  if (!token) return res.json({ authenticated: false });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    res.json({ authenticated: true });
  } catch {
    res.json({ authenticated: false });
  }
});

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ success: true });
});

module.exports = router;
