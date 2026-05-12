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
  if (!['scout', 'pam', 'triage'].includes(agent)) {
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
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'pimax unreachable' });
  }
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
