// Startup file for cPanel's "Setup Node.js App". Checks what the server needs, then starts it.
// If something is missing it serves a page saying what to fix, rather than cPanel's blank error.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

try {
  process.chdir(__dirname);
} catch {}

const version = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
})();
process.env.BRT_VERSION = process.env.BRT_VERSION || version;
process.env.STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'public');
// Best outside public_html, e.g. /home/<you>/brt-data; set DATA_DIR in Setup Node.js App
process.env.DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const problems = [];
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  problems.push(`This is Node ${process.version}. Boat Race Tracker needs Node 22.13 or later (it uses Node's built-in SQLite). In Setup Node.js App, choose Node 22, save, and restart.`);
}
if ((process.env.ADMIN_TOKEN || '').trim().length < 16) {
  problems.push('ADMIN_TOKEN is not set (or is shorter than 16 characters). In Setup Node.js App, add an environment variable ADMIN_TOKEN with a long random value, save, and restart. You need it to create regattas.');
}
try {
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  fs.accessSync(process.env.DATA_DIR, fs.constants.W_OK);
} catch (e) {
  problems.push(`The data folder ${process.env.DATA_DIR} can't be written: ${e.message}. Check DATA_DIR in Setup Node.js App.`);
}

if (problems.length) {
  helpPage(problems);
} else {
  import('./server.mjs').catch((err) => {
    console.error('[Boat Race Tracker] could not start:', err);
    helpPage([`The server could not start: ${err && err.message ? err.message : err}`]);
  });
}

/** Listens the way the server would, and answers every request with what to fix */
function helpPage(items) {
  for (const p of items) console.error('[Boat Race Tracker]', p);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Boat Race Tracker: setup</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#111827;background:#f8fafc}li{margin:.75rem 0}code{background:#e5e7eb;padding:0 .25rem;border-radius:4px}</style></head>
<body><h1>Boat Race Tracker isn’t running yet</h1><p>Fix the following, then press <b>Restart</b> in cPanel’s Setup Node.js App:</p>
<ol>${items.map((p) => `<li>${esc(p)}</li>`).join('')}</ol><p>Version ${esc(version)} · Node ${esc(process.version)}</p></body></html>`;
  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/health')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, problems: items, version, node: process.version }));
    }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
  });
  const port = process.env.PORT;
  if (typeof PhusionPassenger !== 'undefined') server.listen('passenger');
  else if (port && !/^\d+$/.test(port)) server.listen(port);
  else server.listen(Number(port) || 3000);
}
