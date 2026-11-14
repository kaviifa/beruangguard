'use strict';
/**
 * BeruangGuard local server — zero dependencies, Node.js http module.
 *
 *   node server.js            # listens on http://localhost:3000
 *   PORT=8080 node server.js  # custom port
 *
 * Routes:
 *   GET  /          -> demo page (public/index.html)
 *   GET  /health    -> { ok: true }
 *   POST /screen    -> JSON verdict (see lib/guard.js)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { screenApproval } = require('./lib/guard');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(PUBLIC_DIR, urlPath);
  // Prevent path traversal outside public/.
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) return reject(new Error('body too large'));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/screen') {
    try {
      const raw = await readBody(req);
      const input = JSON.parse(raw || '{}');
      const result = await screenApproval(input);
      return sendJson(res, 200, result);
    } catch (err) {
      if (err.status === 400 || err instanceof SyntaxError) {
        return sendJson(res, 400, { error: err.message });
      }
      console.error('screen error:', err);
      return sendJson(res, 502, { error: 'upstream RPC failed: ' + err.message });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res);

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`BeruangGuard listening on http://localhost:${PORT}`);
});
