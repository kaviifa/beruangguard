'use strict';

// Netlify serverless function: GET /health (rewritten from /health via netlify.toml).
exports.handler = async (event) => {
  const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method not allowed' }) };
  }
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
