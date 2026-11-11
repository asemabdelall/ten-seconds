import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

let server, base, dir;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ten-'));
  process.env.DATA_FILE = path.join(dir, 'results.json');
  const { start } = await import('../server.js');
  server = await start(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

const post = (body) => fetch(base + '/api/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const result = (over = {}) => ({ clientId: randomUUID(), playerId: randomUUID(), name: 'ACE', elapsedMs: 10012.5, playedAt: Date.now(), ...over });

test('accepts a result and recomputes perfect server-side', async () => {
  const r = result({ elapsedMs: 10000.2, perfect: false });
  const res = await post(r);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.perfect, true);
  assert.equal(body.rank, 1);
  assert.equal(body.personalBest, true);
});

test('client cannot claim perfect', async () => {
  const res = await post(result({ elapsedMs: 9000, perfect: true }));
  assert.equal((await res.json()).perfect, false);
});

test('idempotent by clientId (offline retries never duplicate)', async () => {
  const r = result({ name: 'DUP' });
  assert.equal((await post(r)).status, 201);
  const again = await post(r);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, true);
  const board = await (await fetch(base + '/api/leaderboard?limit=100')).json();
  assert.equal(board.entries.filter((e) => e.name === 'DUP').length, 1);
});

test('rejects invalid submissions with 4xx', async () => {
  for (const bad of [
    { elapsedMs: -1 }, { elapsedMs: 99999 }, { name: 'x' }, { name: '<script>' },
    { clientId: 'nope' }, { playedAt: Date.now() + 3600_000 }, { playedAt: Date.now() - 40 * 86400_000 },
  ]) {
    const res = await post(result(bad));
    assert.equal(res.status, 422, JSON.stringify(bad));
  }
});

test('leaderboard ranks best result per player by distance from 10 000 ms', async () => {
  const p = randomUUID();
  await post(result({ playerId: p, name: 'BOB', elapsedMs: 10300 }));
  await post(result({ playerId: p, name: 'BOB', elapsedMs: 9950 }));
  const board = await (await fetch(`${base}/api/leaderboard?player=${p}`)).json();
  const bobs = board.entries.filter((e) => e.name === 'BOB');
  assert.equal(bobs.length, 1);
  assert.equal(bobs[0].elapsedMs, 9950);
  assert.equal(bobs[0].me, true);
  const deltas = board.entries.map((e) => Math.abs(e.deltaMs));
  assert.deepEqual(deltas, [...deltas].sort((a, b) => a - b));
});

test('serves the PWA essentials with correct types', async () => {
  const m = await fetch(base + '/manifest.webmanifest');
  assert.match(m.headers.get('content-type'), /manifest\+json/);
  const sw = await fetch(base + '/sw.js');
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(base + '/../server.js')).status !== 200, true);
});
