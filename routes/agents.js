const express = require('express');
const router = express.Router();

// Simple in-memory store for agent updates
// Will persist properly once we add a database later
let agentStatus = {
  scout: { status: 'idle', message: '', lastUpdate: null },
  pam: { status: 'idle', message: '', lastUpdate: null },
  claw: { status: 'idle', message: '', lastUpdate: null }
};

// Middleware — check API key on all agent routes
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.AGENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET — dashboard reads agent status
router.get('/status', (req, res) => {
  res.json(agentStatus);
});

// POST — agents write their status here
router.post('/update', requireApiKey, (req, res) => {
  const { agent, status, message } = req.body;
  if (!agent || !agentStatus[agent]) {
    return res.status(400).json({ error: 'Invalid agent name' });
  }
  agentStatus[agent] = {
    status,
    message,
    lastUpdate: new Date().toISOString()
  };
  console.log(`Agent update: ${agent} → ${status}`);
  res.json({ success: true });
});

module.exports = router;