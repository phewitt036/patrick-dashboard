require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/income', require('./routes/salesforce'));
app.use('/api/agent', require('./routes/agents'));

// Env test
app.get('/api/test-env', (req, res) => {
  res.json({
    hasKey: !!process.env.AGENT_API_KEY,
    keyLength: process.env.AGENT_API_KEY ? process.env.AGENT_API_KEY.length : 0
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT}`));