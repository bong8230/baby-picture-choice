import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/routes.js';
import { createStore } from '../src/store.js';

const ADMIN = 'owner@example.com';
const WEEK = '2026-W47';
const FUNNEL = { 'tailscale-funnel-request': '?1' };
const ADMIN_H = { 'tailscale-user-login': ADMIN };

// Raw request: http.request sends the path verbatim (fetch would normalize "..").
// Non-GET requests send X-Requested-With: fetch like the real frontends; pass null to omit it.
function req(port, method, path, { headers = {}, body } = {}) {
  if (method !== 'GET') headers = { 'x-requested-with': 'fetch', ...headers };
  headers = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== null));
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    r.end();
  });
}

// listen(0) on this Windows host often fails with EFAULT (reproduced outside this app), so pick a
// random high port and retry on EFAULT / EADDRINUSE.
async function listen(server) {
  for (let i = 0; ; i++) {
    try {
      return await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(20000 + Math.floor(Math.random() * 40000), '127.0.0.1', () => { server.off('error', fail); ok(); });
      });
    } catch (e) {
      if (!['EFAULT', 'EADDRINUSE', 'EACCES'].includes(e.code) || i >= 50) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

async function setup(t, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'server-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pub = join(root, 'public');
  await mkdir(join(pub, 'vendor', 'mediapipe', 'wasm'), { recursive: true });
  await writeFile(join(pub, 'admin.html'), '<!doctype html><title>admin</title>');
  await writeFile(join(pub, 'vote.html'), '<!doctype html><title>vote</title>');
  await writeFile(join(pub, 'vote.js'), 'export {};');
  await writeFile(join(pub, 'bracket.js'), 'export {};');
  await writeFile(join(pub, 'analyze-spike.html'), '<!doctype html>');
  await writeFile(join(pub, 'vendor', 'mediapipe', 'vision_bundle.mjs'), 'export {};');
  await writeFile(join(pub, 'vendor', 'mediapipe', 'wasm', 'x.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  await writeFile(join(pub, 'vendor', 'mediapipe', 'face.task'), Buffer.from([1, 2, 3]));
  await writeFile(join(root, 'config.json'), JSON.stringify({ adminLogin: ADMIN, secret: 'leak' }));
  const store = createStore(root, { rng: seeded(), log: () => {} });
  const server = createServer({
    rootDir: root,
    publicDir: pub,
    config: { adminLogin: ADMIN, port: 0, ...(opts.config || {}) },
    store,
    funnelState: async () => 'tailnet',
    log: () => {},
    ...(opts.server || {}),
  });
  await listen(server);
  t.after(() => new Promise((r) => server.close(r)));
  return { root, pub, store, port: server.address().port };
}

function photo(i) {
  return { bytes: Buffer.from(`orig-${i}`), ext: 'jpg', originalName: `IMG_${i}.jpg`, thumb: Buffer.from(`thumb-${i}`) };
}

async function votingWeek(store, n = 4, week = WEEK) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await store.addPhoto(week, photo(i))).id);
  const tokens = await store.startVoting(week);
  return { ids, tokens };
}

test('funnel requests to admin paths and admin-only static are 404', async (t) => {
  const { port } = await setup(t);
  for (const p of ['/admin', '/api/admin/weeks', '/vendor/mediapipe/vision_bundle.mjs', '/analyze-spike.html', '/api/admin/funnel']) {
    const r = await req(port, 'GET', p, { headers: { ...FUNNEL, ...ADMIN_H } });
    assert.equal(r.status, 404, p);
  }
});

test('/admin needs the configured tailscale login', async (t) => {
  const { port } = await setup(t);
  assert.equal((await req(port, 'GET', '/admin')).status, 404);
  assert.equal((await req(port, 'GET', '/admin', { headers: { 'tailscale-user-login': 'other@example.com' } })).status, 404);
  const ok = await req(port, 'GET', '/admin', { headers: ADMIN_H });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /^text\/html/);
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal(ok.headers['referrer-policy'], 'no-referrer');
});

test('missing adminLogin in config disables admin entirely', async (t) => {
  const { port } = await setup(t, { config: { adminLogin: '' } });
  assert.equal((await req(port, 'GET', '/admin', { headers: { 'tailscale-user-login': '' } })).status, 404);
  assert.equal((await req(port, 'GET', '/admin', { headers: ADMIN_H })).status, 404);
});

test('revoked and unknown tokens are 404', async (t) => {
  const { port, store } = await setup(t);
  const { tokens } = await votingWeek(store, 1, '2026-W46'); // 1 photo goes straight to done
  assert.equal((await req(port, 'GET', `/v/${tokens.me}/api/state`, { headers: FUNNEL })).status, 200);
  await store.revokeDoneTokens();
  assert.equal((await req(port, 'GET', `/v/${tokens.me}/api/state`, { headers: FUNNEL })).status, 404);
  assert.equal((await req(port, 'GET', `/v/${tokens.me}`, { headers: FUNNEL })).status, 404);
  assert.equal((await req(port, 'GET', '/v/nosuchtokennosuchtokennosuchtok/api/state', { headers: FUNNEL })).status, 404);
  assert.equal((await req(port, 'GET', '/v/nosuchtoken')).status, 404);
});

test('path traversal and malformed weeks are 404', async (t) => {
  const { port, store } = await setup(t);
  const { tokens } = await votingWeek(store);
  const bad = [
    `/v/${tokens.me}/img/../../config.json`,
    `/v/${tokens.me}/img/..%2f..%2fconfig.json`,
    `/v/${tokens.me}/img/%2e%2e%2f%2e%2e%2fconfig.json`,
    `/v/${tokens.me}/img/..%5c..%5cconfig.json`,
    `/v/${tokens.me}/img/a%00`,
    '/vote.js/../../config.json',
    '/%2e%2e/config.json',
    '/..%5cconfig.json',
    '/vendor/mediapipe/..%2f..%2f..%2fconfig.json',
  ];
  for (const p of bad) {
    for (const headers of [FUNNEL, ADMIN_H]) {
      const r = await req(port, 'GET', p, { headers });
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.toString().includes('leak'), p);
    }
  }
  for (const p of ['/api/admin/weeks/../x/photos', '/api/admin/weeks/..%2fx/photos', '/api/admin/img/../x/abc', '/api/admin/weeks/2026-47/photos']) {
    assert.equal((await req(port, 'GET', p, { headers: ADMIN_H })).status, 404, p);
  }
});

test('funnel request with a valid token gets state, vote page, images and allowed static', async (t) => {
  const { port, store } = await setup(t);
  const { ids, tokens } = await votingWeek(store);
  const r = await req(port, 'GET', `/v/${tokens.wife}/api/state`, { headers: FUNNEL });
  assert.equal(r.status, 200);
  assert.equal(r.json.voter, 'wife');
  assert.equal(r.json.week, WEEK);
  assert.equal(r.headers['cache-control'], 'no-store');
  const page = await req(port, 'GET', `/v/${tokens.wife}`, { headers: FUNNEL });
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /vote/);
  const img = await req(port, 'GET', `/v/${tokens.wife}/img/${ids[0]}`, { headers: FUNNEL });
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/jpeg');
  assert.equal(img.body.toString(), 'thumb-0');
  assert.equal((await req(port, 'GET', `/v/${tokens.wife}/img/nosuchid`, { headers: FUNNEL })).status, 404);
  const js = await req(port, 'GET', '/vote.js', { headers: FUNNEL });
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await req(port, 'GET', '/bracket.js', { headers: FUNNEL })).status, 200);
  assert.equal((await req(port, 'GET', '/admin.html', { headers: FUNNEL })).status, 404);
});

test('stale matchId on pick gives 409 with the latest view', async (t) => {
  const { port, store } = await setup(t);
  const { tokens } = await votingWeek(store);
  const s = (await req(port, 'GET', `/v/${tokens.me}/api/state`, { headers: FUNNEL })).json;
  const m = s.match;
  const ok = await req(port, 'POST', `/v/${tokens.me}/api/pick`, { headers: FUNNEL, body: { matchId: m.id, winnerId: m.a } });
  assert.equal(ok.status, 200);
  assert.notEqual(ok.json.match.id, m.id);
  const stale = await req(port, 'POST', `/v/${tokens.me}/api/pick`, { headers: FUNNEL, body: { matchId: m.id, winnerId: m.a } });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json, ok.json);
  const undo = await req(port, 'POST', `/v/${tokens.me}/api/undo`, { headers: FUNNEL, body: { matchId: ok.json.match.id } });
  assert.equal(undo.status, 200);
  assert.equal(undo.json.match.id, m.id);
  const bad = await req(port, 'POST', `/v/${tokens.me}/api/pick`, { headers: FUNNEL, body: '{not json' });
  assert.equal(bad.status, 404);
  const joint = await req(port, 'POST', `/v/${tokens.me}/api/joint`, { headers: FUNNEL, body: { winnerId: m.a } });
  assert.equal(joint.status, 409);
});

test('.wasm and .task get the right content types', async (t) => {
  const { port } = await setup(t);
  const w = await req(port, 'GET', '/vendor/mediapipe/wasm/x.wasm', { headers: ADMIN_H });
  assert.equal(w.status, 200);
  assert.equal(w.headers['content-type'], 'application/wasm');
  const k = await req(port, 'GET', '/vendor/mediapipe/face.task', { headers: ADMIN_H });
  assert.equal(k.headers['content-type'], 'application/octet-stream');
  const m = await req(port, 'GET', '/vendor/mediapipe/vision_bundle.mjs', { headers: ADMIN_H });
  assert.equal(m.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await req(port, 'GET', '/analyze-spike.html', { headers: ADMIN_H })).status, 200);
});

test('upload, list, thumb, scores, delete and start', async (t) => {
  const { port, root } = await setup(t);
  const thumb = Buffer.from('THUMB');
  const orig = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xfe, 0xff, 0xd9]);
  const up = (q, body, extra = {}) => req(port, 'POST', `/api/admin/weeks/${WEEK}/photos?${q}`, {
    headers: { ...ADMIN_H, 'x-thumb-length': String(thumb.length), ...extra }, body,
  });
  const r = await up('ext=jpg&name=IMG_1.jpg&takenAt=1700000000000&score=0.5', Buffer.concat([thumb, orig]));
  assert.equal(r.status, 200);
  assert.match(r.json.id, /^[A-Za-z0-9_-]+$/);
  const list = await req(port, 'GET', `/api/admin/weeks/${WEEK}/photos`, { headers: ADMIN_H });
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  assert.deepEqual(list.json[0], { id: r.json.id, originalName: 'IMG_1.jpg', takenAt: 1700000000000, score: 0.5 });
  const { readFile } = await import('node:fs/promises');
  assert.ok((await readFile(join(root, 'pool', WEEK, `${r.json.id}.jpg`))).equals(orig));
  const img = await req(port, 'GET', `/api/admin/img/${WEEK}/${r.json.id}`, { headers: ADMIN_H });
  assert.equal(img.body.toString(), 'THUMB');
  assert.equal(img.headers['cache-control'], 'no-store');
  // funnel cannot upload or list
  assert.equal((await up('ext=jpg', Buffer.concat([thumb, orig]), FUNNEL)).status, 404);
  // bad thumb lengths
  for (const v of ['abc', '-1', '0', String(thumb.length + orig.length), '1.5']) {
    assert.equal((await up('ext=jpg', Buffer.concat([thumb, orig]), { 'x-thumb-length': v })).status, 400, v);
  }
  assert.equal((await up('ext=exe', Buffer.concat([thumb, orig]))).status, 400);
  const r2 = await up('ext=png&name=b.png', Buffer.concat([thumb, orig]));
  assert.equal(r2.status, 200);
  const sc = await req(port, 'PUT', `/api/admin/weeks/${WEEK}/scores`, { headers: ADMIN_H, body: { [r2.json.id]: 0.9 } });
  assert.equal(sc.status, 200);
  const del = await req(port, 'DELETE', `/api/admin/weeks/${WEEK}/photos/${r.json.id}`, { headers: ADMIN_H });
  assert.equal(del.status, 200);
  assert.equal((await req(port, 'DELETE', `/api/admin/weeks/${WEEK}/photos/${r.json.id}`, { headers: ADMIN_H })).status, 404);
  const weeks = await req(port, 'GET', '/api/admin/weeks', { headers: ADMIN_H });
  assert.equal(weeks.json[0].photoCount, 1);
  const start = await req(port, 'POST', `/api/admin/weeks/${WEEK}/start`, { headers: ADMIN_H });
  assert.equal(start.status, 200);
  assert.match(start.json.links.me, /^https:\/\/my-pc\.example-tailnet\.ts\.net:10000\/v\/[A-Za-z0-9_-]{32}$/);
  assert.match(start.json.links.wife, /\/v\/[A-Za-z0-9_-]{32}$/);
  assert.equal((await req(port, 'POST', `/api/admin/weeks/${WEEK}/start`, { headers: ADMIN_H })).status, 409);
  assert.equal((await up('ext=jpg', Buffer.concat([thumb, orig]))).status, 409);
  const empty = await req(port, 'GET', '/api/admin/weeks/2026-W01/photos', { headers: ADMIN_H });
  assert.deepEqual(empty.json, []);
});

test('upload over the size limit gets 413', async (t) => {
  const { port } = await setup(t, { server: { maxPhotoBytes: 1000 } });
  const body = Buffer.alloc(5000, 1);
  const r = await req(port, 'POST', `/api/admin/weeks/${WEEK}/photos?ext=jpg`, {
    headers: { ...ADMIN_H, 'x-thumb-length': '10' }, body,
  });
  assert.equal(r.status, 413);
});

test('funnel status endpoint reports state and unknown on error', async (t) => {
  const { port } = await setup(t);
  const r = await req(port, 'GET', '/api/admin/funnel', { headers: ADMIN_H });
  assert.deepEqual(r.json, { state: 'tailnet' });
  const s2 = await setup(t, { server: { funnelState: async () => { throw new Error('no tailscale'); } } });
  assert.deepEqual((await req(s2.port, 'GET', '/api/admin/funnel', { headers: ADMIN_H })).json, { state: 'unknown' });
});

test('unknown routes and wrong methods are 404', async (t) => {
  const { port } = await setup(t);
  assert.equal((await req(port, 'POST', '/admin', { headers: ADMIN_H })).status, 404);
  assert.equal((await req(port, 'GET', '/nope', { headers: ADMIN_H })).status, 404);
  assert.equal((await req(port, 'GET', '/config.json', { headers: ADMIN_H })).status, 404);
  assert.equal((await req(port, 'GET', '/pool/x', { headers: ADMIN_H })).status, 404);
});

test('foreign Host header (DNS rebinding) is 404 even with admin login', async (t) => {
  const { port } = await setup(t);
  assert.equal((await req(port, 'GET', '/admin', { headers: { ...ADMIN_H, host: 'evil.example.com:8790' } })).status, 404);
  assert.equal((await req(port, 'GET', '/admin', { headers: { ...ADMIN_H, host: 'my-pc.example-tailnet.ts.net:10000' } })).status, 200);
});

test('cross-site writes are 404 and change nothing; same-origin fetch writes work', async (t) => {
  const { port, store } = await setup(t);
  await store.addPhoto(WEEK, photo(1));
  const start = (headers) => req(port, 'POST', `/api/admin/weeks/${WEEK}/start`, { headers: { ...ADMIN_H, ...headers } });
  const host = `127.0.0.1:${port}`;
  const bad = [
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { 'x-requested-with': null }, // plain form post
    { 'x-requested-with': 'XMLHttpRequest' },
    { origin: `http://${host}` }, // wrong scheme
    { origin: 'null' },
  ];
  for (const h of bad) {
    assert.equal((await start(h)).status, 404, JSON.stringify(h));
    assert.equal((await store.listWeeks())[0].status, 'collecting', JSON.stringify(h));
  }
  // cross-site vote write is also blocked
  const { tokens } = await votingWeek(store, 4, '2026-W40');
  const s = (await req(port, 'GET', `/v/${tokens.me}/api/state`)).json;
  const pick = await req(port, 'POST', `/v/${tokens.me}/api/pick`, {
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: { matchId: s.match.id, winnerId: s.match.a },
  });
  assert.equal(pick.status, 404);
  assert.deepEqual((await req(port, 'GET', `/v/${tokens.me}/api/state`)).json, s);
  // same-origin: Origin matching Host, or the publicBase origin
  const ok = await start({ origin: `https://${host}`, 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 200);
  assert.equal((await store.listWeeks()).find((w) => w.week === WEEK).status, 'done'); // 1 photo goes straight to done
  await store.addPhoto('2026-W49', photo(2));
  const ok2 = await req(port, 'POST', '/api/admin/weeks/2026-W49/start', {
    headers: { ...ADMIN_H, origin: 'https://my-pc.example-tailnet.ts.net:10000', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(ok2.status, 200);
});

test('JSON bodies must be objects; token-route errors stay generic', async (t) => {
  const { port, store } = await setup(t);
  await store.addPhoto(WEEK, photo(1));
  for (const body of ['[]', '1', 'null', '"x"']) {
    assert.equal((await req(port, 'PUT', `/api/admin/weeks/${WEEK}/scores`, { headers: ADMIN_H, body })).status, 400, body);
  }
  const { tokens } = await votingWeek(store, 4, '2026-W40');
  for (const body of ['[]', '1', 'null']) {
    assert.equal((await req(port, 'POST', `/v/${tokens.me}/api/pick`, { body })).status, 404, body);
  }
  const id = (await req(port, 'GET', `/api/admin/weeks/${WEEK}/photos`, { headers: ADMIN_H })).json[0].id;
  const img = await req(port, 'GET', `/api/admin/img/${WEEK}/${id}`, { headers: ADMIN_H });
  assert.equal(img.headers['cross-origin-resource-policy'], 'same-origin');
});

test('Host allowlist: no generic ts.net wildcard; config.allowedHosts is case-insensitive', async (t) => {
  const { port } = await setup(t, { config: { allowedHosts: ['Other.Example.Net'] } });
  assert.equal((await req(port, 'GET', '/admin', { headers: { ...ADMIN_H, host: 'attacker.tailxxxx.ts.net' } })).status, 404);
  assert.equal((await req(port, 'GET', '/admin', { headers: { ...ADMIN_H, host: 'other.example.net:10000' } })).status, 200);
});

test('admin links endpoint: returns start links, 404 for funnel / non-admin / revoked / collecting', async (t) => {
  const { port, store } = await setup(t);
  const week = '2026-W47';
  const url = `/api/admin/weeks/${week}/links`;
  assert.equal((await req(port, 'GET', url, { headers: ADMIN_H })).status, 404); // no such week
  await store.addPhoto(week, photo(0));
  await store.addPhoto(week, photo(1));
  assert.equal((await req(port, 'GET', url, { headers: ADMIN_H })).status, 404); // collecting
  const start = await req(port, 'POST', `/api/admin/weeks/${week}/start`, { headers: ADMIN_H });
  const got = await req(port, 'GET', url, { headers: ADMIN_H });
  assert.equal(got.status, 200);
  assert.deepEqual(got.json, start.json);
  assert.equal((await req(port, 'GET', url, { headers: { ...FUNNEL, ...ADMIN_H } })).status, 404);
  assert.equal((await req(port, 'GET', url)).status, 404);
  assert.equal((await req(port, 'GET', url, { headers: { 'tailscale-user-login': 'other@example.com' } })).status, 404);

  const done = '2026-W46';
  await votingWeek(store, 1, done); // 1 photo settles to done
  assert.equal((await req(port, 'GET', `/api/admin/weeks/${done}/links`, { headers: ADMIN_H })).status, 200);
  await store.revokeDoneTokens();
  assert.equal((await req(port, 'GET', `/api/admin/weeks/${done}/links`, { headers: ADMIN_H })).status, 404);
});
