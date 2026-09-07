const express = require('express');
const router = express.Router();

const HUB = () => process.env.AGENT_HUB_URL;
const KEY = () => process.env.AGENT_API_KEY;

function hubHeaders() {
  return { 'Content-Type': 'application/json', 'x-api-key': KEY() };
}

function proxy(hubPath, method = 'GET') {
  return async (req, res) => {
    const path = typeof hubPath === 'function' ? hubPath(req) : hubPath;
    try {
      const opts = { method, headers: hubHeaders() };
      if (method === 'POST') opts.body = JSON.stringify(req.body);
      const r = await fetch(`${HUB()}${path}`, opts);
      res.status(r.status).json(await r.json());
    } catch (e) {
      res.status(502).json({ error: 'pimax unreachable' });
    }
  };
}

router.get('/intel', proxy('/intel'));
router.get('/briefing', proxy('/briefing'));

router.post('/run/:agent', (req, res, next) => {
  if (!['scout', 'pam', 'pam-day', 'triage'].includes(req.params.agent)) {
    return res.status(400).json({ error: 'Invalid agent' });
  }
  next();
}, proxy(req => `/run/${req.params.agent}`, 'POST'));

router.post('/chat', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/chat/claw`, {
      method: 'POST',
      headers: hubHeaders(),
      body: JSON.stringify(req.body)
    });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      const { Readable } = require('stream');
      const nodeStream = Readable.fromWeb(r.body);
      nodeStream.pipe(res);
      nodeStream.on('error', () => res.end());
    } else {
      res.status(r.status).json(await r.json());
    }
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

// Claw v2 — conversations
router.get('/claw/conversations', proxy('/chat/conversations'));
router.delete('/claw/conversations/:id', proxy(req => `/chat/conversations/${req.params.id}`, 'DELETE'));
router.get('/claw/conversations/:id/messages', proxy(req => `/chat/conversations/${req.params.id}/messages`));

// Claw v2 — attachments (base64 JSON body)
router.post('/claw/attachments/upload', proxy('/chat/attachments/upload', 'POST'));

// Claw v2 — knowledge files
router.get('/claw/knowledge', proxy('/chat/knowledge'));
router.post('/claw/knowledge', proxy('/chat/knowledge', 'POST'));
router.delete('/claw/knowledge/:name', proxy(req => `/chat/knowledge/${encodeURIComponent(req.params.name)}`, 'DELETE'));

router.post('/note', proxy('/note', 'POST'));
router.post('/triage/apply', proxy('/triage/apply', 'POST'));

router.get('/pam-day', proxy('/pam-day'));
router.get('/nodes', proxy('/nodes'));

router.get('/fan', proxy('/fan/status'));
router.post('/fan/override', proxy('/fan/override', 'POST'));
router.delete('/fan/override', proxy('/fan/override', 'DELETE'));
router.get('/fan/pihole', proxy('/fan/pihole'));
router.post('/fan/pihole', proxy('/fan/pihole', 'POST'));

// Rack chimney — the two 120mm ARGB fans bolted into the MOJO rack itself, bottom
// intake and top exhaust, driven by an ESP32 running ESPHome rather than by a Pi.
// The chain is dashboard -> agent-hub -> Home Assistant on bee -> ESP32, so the same
// shape as the pimax fan above: agent-hub owns the curve and the fleet-status colour,
// and the dashboard only asks and shows.
//
// Intake and exhaust are separate PWM channels on purpose. Running the intake a little
// faster than the exhaust keeps the rack at positive pressure, so air enters through
// the filtered bottom rather than being pulled in through every seam in the frame.
router.get('/rack', proxy('/rack/status'));
router.post('/rack/override', proxy('/rack/override', 'POST'));
router.delete('/rack/override', proxy('/rack/override', 'DELETE'));

// Lights are a separate call from speed because they are not always driven by the same
// thing: the ring can be showing fleet status while the fans sit on the temp curve.
router.post('/rack/lights', proxy('/rack/lights', 'POST'));

// Mining switch. The POST is deliberately not a passthrough of the hub's path: the
// button sends {enabled} to /api/pimax/mining and agent-hub takes it at
// /mining/enabled, so the dashboard has one noun for the thing it is switching.
router.get('/mining', proxy('/mining'));
router.post('/mining', proxy('/mining/enabled', 'POST'));

module.exports = router;
