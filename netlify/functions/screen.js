'use strict';
const { screenApproval } = require('../../lib/guard');

// Netlify serverless function: POST /screen (rewritten from /screen via netlify.toml).
exports.handler = async (event) => {
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'content-type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method not allowed' }) };
  }

  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || '{}';
    const input = JSON.parse(raw);
    const result = await screenApproval(input);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    if (err.status === 400 || err instanceof SyntaxError) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: err.message }) };
    }
    console.error('screen error:', err);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'upstream RPC failed: ' + err.message }) };
  }
};
