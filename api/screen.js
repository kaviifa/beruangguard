'use strict';
const { screenApproval } = require('../lib/guard');

// Vercel serverless function: POST /api/screen (rewritten from /screen).
module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const result = await screenApproval(input);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status === 400 || err instanceof SyntaxError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('screen error:', err);
    return res.status(502).json({ error: 'upstream RPC failed: ' + err.message });
  }
};
