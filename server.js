/**
 * Ten Seconds server: static PWA hosting + leaderboard API. No dependencies.
 *
 *   GET  /api/health
 *   GET  /api/leaderboard?limit=50&player=<playerId>
 *   POST /api/results  { clientId, playerId, name, elapsedMs, playedAt }
 *
 * Results are stored in data/results.json (atomic writes). For production at
 * scale, swap `db` for a real database; the API contract stays the same.
 */
import http from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { buildHash } from './lib/build-hash.js';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, TARGET_MS, MAX_RUN_MS } from './public/js/timing.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'results.json');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
    "script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};

/* ------------------------------------------------------------------ storage */
const db = {
  results: [],           // every accepted result
  byClientId: new Map(), // idempotency index
  async load() {
    try {
      const rows = JSON.parse(await readFile(DATA_FILE, 'utf8'));
      if (Array.isArray(rows)) this.results = rows;
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Could not read data file:', err.message);
    }
    for (const r of this.results) this.byClientId.set(r.clientId, r);
  },
  _saving: Promise.resolve(),
  save() {
    // Serialise writes; write to a temp file then rename (atomic on POSIX).
    this._saving = this._saving.then(async () => {
      await mkdir(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      await writeFile(tmp, JSON.stringify(this.results));
      await rename(tmp, DATA_FILE);
    }).catch((err) => console.error('Save failed:', err.message));
    return this._saving;
  },
};

/** Best result per player, ranked by distance from 10 000 ms, then earliest. */
function standings() {
  const best = new Map();
  for (const r of db.results) {
    const cur = best.get(r.playerId);
    if (!cur || r.absDeltaMs < cur.absDeltaMs || (r.absDeltaMs === cur.absDeltaMs && r.receivedAt < cur.receivedAt)) {
      best.set(r.playerId, r);
    }
  }
  return [...best.values()].sort((a, b) => a.absDeltaMs - b.absDeltaMs || a.receivedAt - b.receivedAt);
}

const publicRow = (r, rank, playerId) => ({
  rank,
  name: r.name,
  elapsedMs: r.elapsedMs,
  deltaMs: r.elapsedMs - TARGET_MS,
  perfect: r.perfect,
  playedAt: r.playedAt,
  me: !!playerId && r.playerId === playerId,
});

/* ------------------------------------------------------------------ validation */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[\p{L}\p{N} _.\-]{2,16}$/u;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // offline results older than 30 days are refused

function validate(body, now) {
  if (!body || typeof body !== 'object') return 'Invalid body';
  const { clientId, playerId, name, elapsedMs, playedAt } = body;
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) return 'Invalid clientId';
  if (typeof playerId !== 'string' || !UUID_RE.test(playerId)) return 'Invalid playerId';
  if (typeof name !== 'string' || !NAME_RE.test(name.trim())) return 'Invalid name';
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs > MAX_RUN_MS) return 'Invalid time';
  if (typeof playedAt !== 'number' || !Number.isFinite(playedAt)) return 'Invalid playedAt';
  if (playedAt > now + 5 * 60_000) return 'playedAt is in the future';
  if (playedAt < now - MAX_AGE_MS) return 'Result is too old';
  return null;
}

/* ------------------------------------------------------------------ rate limiting */
const hits = new Map();
function rateLimited(ip, limit = 60, windowMs = 60_000) {
  const now = Date.now();
  const h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > windowMs) { h.n = 0; h.t = now; }
  h.n++;
  hits.set(ip, h);
  return h.n > limit;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 120_000) hits.delete(k); }, 60_000).unref();

/* ------------------------------------------------------------------ http helpers */
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(data);
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ api */
async function api(req, res, url) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  if (url.pathname === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, time: Date.now() });
  }

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 50, 1), 100);
    const player = url.searchParams.get('player') || '';
    const all = standings();
    const entries = all.slice(0, limit).map((r, i) => publicRow(r, i + 1, player));
    let you = null;
    if (player) {
      const idx = all.findIndex((r) => r.playerId === player);
      if (idx >= limit) you = publicRow(all[idx], idx + 1, player);
    }
    return send(res, 200, { target: TARGET_MS, total: all.length, entries, you });
  }

  if (url.pathname === '/api/results' && req.method === 'POST') {
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many submissions, slow down' });
    let body;
    try { body = await readJson(req); } catch (err) { return send(res, err.status || 400, { error: err.message }); }
    const now = Date.now();
    const error = validate(body, now);
    if (error) return send(res, 422, { error });

    const rankOf = (playerId) => standings().findIndex((r) => r.playerId === playerId) + 1;

    // Idempotent: a retried submission returns the original outcome.
    const existing = db.byClientId.get(body.clientId);
    if (existing) {
      return send(res, 200, { ok: true, duplicate: true, id: existing.clientId, rank: rankOf(existing.playerId), perfect: existing.perfect });
    }

    const previousBest = standings().find((r) => r.playerId === body.playerId);
    // The server re-derives the verdict from the raw elapsed time; the client never says "perfect".
    const ev = evaluate(body.elapsedMs);
    const row = {
      clientId: body.clientId,
      playerId: body.playerId,
      name: body.name.trim().replace(/\s+/g, ' ').toUpperCase(),
      elapsedMs: Math.round(body.elapsedMs * 10_000) / 10_000,
      absDeltaMs: ev.absDeltaMs,
      perfect: ev.perfect,
      playedAt: body.playedAt,
      receivedAt: now,
      offline: now - body.playedAt > 60_000,
    };
    // Keep the player's newest name on all their rows.
    for (const r of db.results) if (r.playerId === row.playerId) r.name = row.name;
    db.results.push(row);
    db.byClientId.set(row.clientId, row);
    await db.save();

    return send(res, 201, {
      ok: true,
      id: row.clientId,
      perfect: row.perfect,
      rank: rankOf(row.playerId),
      personalBest: !previousBest || row.absDeltaMs < previousBest.absDeltaMs,
    });
  }

  return send(res, 404, { error: 'Not found' });
}

/* ------------------------------------------------------------------ static */
async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');

  let info;
  try { info = await stat(file); } catch { info = null; }
  if (!info || !info.isFile()) {
    // Unknown paths without an extension are app routes: serve the shell.
    if (!path.extname(rel)) return serveStatic(req, res, new URL('/index.html', url));
    return send(res, 404, 'Not found');
  }

  const ext = path.extname(file);
  const base = path.basename(file);
  let cache = 'public, max-age=3600';
  if (base === 'sw.js' || ext === '.html' || ext === '.webmanifest') cache = 'no-cache';
  else if (ext === '.woff2' || rel.startsWith('/icons/') || rel.startsWith('/splash/')) cache = 'public, max-age=604800';

  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cache,
    'Last-Modified': info.mtime.toUTCString(),
    ...SECURITY_HEADERS,
  };
  if (rel === '/sw.js') {
    const body = (await readFile(file, 'utf8')).replace('__BUILD_HASH__', await buildHash(PUBLIC));
    headers['Service-Worker-Allowed'] = '/';
    headers['Content-Length'] = Buffer.byteLength(body);
    delete headers['Last-Modified'];
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(info.mtime.toUTCString())) {
    res.writeHead(304, headers); return res.end();
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ main */
export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return await serveStatic(req, res, url);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Server error' });
    }
  });
}

export async function start(port = PORT, host = HOST) {
  await db.load();
  const server = createServer();
  await new Promise((r) => server.listen(port, host, r));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await start();
  const { port } = server.address();
  console.log(`Ten Seconds running on http://localhost:${port}`);
}
