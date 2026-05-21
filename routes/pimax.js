const express = require('express');
const router = express.Router();

const HUB = () => process.env.AGENT_HUB_URL;
const KEY = () => process.env.AGENT_API_KEY;

function hubHeaders() {
  return { 'Content-Type': 'application/json', 'x-api-key': KEY() };
}

router.get('/intel', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/intel`, { headers: hubHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

router.get('/briefing', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/briefing`, { headers: hubHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

router.post('/run/:agent', async (req, res) => {
  const { agent } = req.params;
  if (!['scout', 'pam', 'pam-mining', 'pam-day', 'triage'].includes(agent)) {
    return res.status(400).json({ error: 'Invalid agent' });
  }
  try {
    const r = await fetch(`${HUB()}/run/${agent}`, { method: 'POST', headers: hubHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

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
router.get('/claw/conversations', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/chat/conversations`, { headers: hubHeaders() });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: 'pimax unreachable' }); }
});

router.delete('/claw/conversations/:id', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/chat/conversations/${req.params.id}`, { method: 'DELETE', headers: hubHeaders() });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: 'pimax unreachable' }); }
});

router.get('/claw/conversations/:id/messages', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/chat/conversations/${req.params.id}/messages`, { headers: hubHeaders() });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: 'pimax unreachable' }); }
});

// Claw v2 — attachments (base64 JSON body)
router.post('/claw/attachments/upload', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/chat/attachments/upload`, {
      method: 'POST',
      headers: hubHeaders(),
      body: JSON.stringify(req.body)
    });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: 'pimax unreachable' }); }
});

// Claw v2 — knowledge files
router.get('/claw/knowledge', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/chat/knowledge`, { headers: hubHeaders() });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: 'pimax unreachable' }); }
});

router.post('/claw/knowledge', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/chat/knowledge`, {
      method: 'POST',
      headers: hubHeaders(),
      body: JSON.stringify(req.body)
    });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: 'pimax unreachable' }); }
});

router.delete('/claw/knowledge/:name', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/chat/knowledge/${encodeURIComponent(req.params.name)}`, { method: 'DELETE', headers: hubHeaders() });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: 'pimax unreachable' }); }
});

router.post('/note', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/note`, {
      method: 'POST',
      headers: hubHeaders(),
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

router.post('/triage/apply', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/triage/apply`, {
      method: 'POST',
      headers: hubHeaders(),
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

router.get('/pam-mining', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/pam-mining`, { headers: hubHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

router.get('/pam-day', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/pam-day`, { headers: hubHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

router.get('/mining', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/mining`, { headers: hubHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

router.get('/fan', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/fan/status`, { headers: hubHeaders() });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

router.post('/fan/override', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/fan/override`, {
      method: 'POST',
      headers: hubHeaders(),
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

router.delete('/fan/override', async (req, res) => {
  try {
    const r = await fetch(`${HUB()}/fan/override`, {
      method: 'DELETE',
      headers: hubHeaders()
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
});

module.exports = router;
