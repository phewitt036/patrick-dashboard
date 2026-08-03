const express = require('express');
const router = express.Router();

const BASE = () => process.env.PIXIT_BASE_URL || 'https://usepixit.com';
const KEY = () => process.env.PIXIT_KEY;

// The key stays here rather than in gig.html: this repo is public, so anything
// the browser is handed is effectively published.
function forward(path, method) {
  return async (req, res) => {
    if (!KEY()) return res.status(503).json({ success: false, error: 'PIXIT_KEY not configured' });
    try {
      const opts = { method, headers: { 'x-patrick-key': KEY() } };
      if (method === 'POST') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(req.body);
      }
      const r = await fetch(`${BASE()}${path}`, opts);
      res.status(r.status).json(await r.json());
    } catch (e) {
      res.status(502).json({ success: false, error: 'pixit unreachable' });
    }
  };
}

router.get('/trackers', forward('/api/patrick/trackers', 'GET'));
router.post('/extract-and-push', forward('/api/patrick/extract-and-push', 'POST'));

module.exports = router;
