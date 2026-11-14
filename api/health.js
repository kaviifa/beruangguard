'use strict';

// Vercel serverless function: GET /api/health (rewritten from /health).
module.exports = (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  return res.status(200).json({ ok: true });
};
