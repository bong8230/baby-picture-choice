// HTTP routes and access control. This server is the security boundary.
//
// Tailscale forwards port 10000 to 127.0.0.1:8790 and adds headers:
//   Tailscale-Funnel-Request: ?1   public internet (Funnel) traffic; client copies are stripped
//   Tailscale-User-Login           tailnet user identity
// Funnel traffic may only reach voting paths (/v/<valid token>...) and the vote static files.
// Admin paths need: no funnel header AND Tailscale-User-Login === config.adminLogin.
// Every denied or unknown request gets the same 404.

import http from 'node:http';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatchError, StoreError } from './store.js';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PUBLIC_BASE = 'https://my-pc.example-tailnet.ts.net:10000';
const MB = 1024 * 1024;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const FUNNEL_STATIC = new Set(['/vote.js', '/vote.css', '/bracket.js', '/styles.css']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};
const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

class HttpError extends Error {
  constructor(status, message = '') {
    super(message);
    this.status = status;
  }
}

// Port 10000 state from `tailscale serve status --json` (same rules as scripts/funnel.js).
export function state10000(cfg) {
  const isPort = (key) => key.split(':').pop() === '10000';
  const web = Object.keys(cfg?.Web || {}).some(isPort);
  const tcp = Object.keys(cfg?.TCP || {}).includes('10000');
  const funnel = Object.entries(cfg?.AllowFunnel || {}).some(([k, v]) => isPort(k) && v);
  if (funnel) return 'funnel';
  if (web || tcp) return 'tailnet';
  return 'off';
}

export function tailscaleFunnelState() {
  return new Promise((res, rej) => {
    execFile('tailscale', ['serve', 'status', '--json'], { timeout: 5000, windowsHide: true }, (err, out) => {
      if (err) return rej(err);
      try { res(state10000(out.trim() ? JSON.parse(out) : {})); } catch (e) { rej(e); }
    });
  });
}

// Split the raw path into decoded segments. Returns null for anything suspicious:
// empty segments, ".", "..", "/", "\", NUL or control chars after decoding, bad escapes.
function parsePath(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) return null;
  const q = rawUrl.indexOf('?');
  const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = new URLSearchParams(q === -1 ? '' : rawUrl.slice(q + 1));
  if (rawPath === '/') return { segs: [], path: '/', query };
  if (rawPath.includes('\\')) return null;
  const segs = [];
  for (const raw of rawPath.slice(1).split('/')) {
    let s;
    try { s = decodeURIComponent(raw); } catch { return null; }
    if (!s || s === '.' || s === '..' || /[/\\\u0000-\u001f\u007f]/.test(s)) return null;
    segs.push(s);
  }
  return { segs, path: '/' + segs.join('/'), query };
}

// Hosts we answer for: loopback, the publicBase host and config.allowedHosts.
// Blocks DNS-rebinding pages that point a foreign name at 127.0.0.1.
function hostAllowed(host, extra) {
  if (typeof host !== 'string') return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]') return true;
  return extra.includes(name);
}

// "host[:port]" lowercased, with the https default port dropped.
const normHostPort = (h) => String(h).toLowerCase().replace(/:443$/, '');

// CSRF guard for every non-GET request. Tailscale adds Tailscale-User-Login to cross-site
// tailnet requests too, so a foreign page could otherwise auto-submit a form to admin routes.
// Requires: X-Requested-With: fetch (a custom header forces a CORS preflight we never answer),
// Sec-Fetch-Site absent or same-origin, and Origin (if sent) equal to https://<Host> or the
// publicBase origin (in case the proxy rewrites Host).
function sameOriginWrite(req, publicOrigin) {
  if (req.headers['x-requested-with'] !== 'fetch') return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (o.protocol !== 'https:') return false;
  const got = normHostPort(o.host);
  return got === normHostPort(req.headers.host ?? '') || got === publicOrigin;
}

export function createServer({
  rootDir = APP_DIR,
  publicDir = join(rootDir, 'public'),
  config = {},
  store,
  funnelState = tailscaleFunnelState,
  maxPhotoBytes = 50 * MB,
  maxThumbBytes = 10 * MB,
  maxJsonBytes = 64 * 1024,
  log = (...a) => console.error(...a),
} = {}) {
  if (!store) throw new Error('createServer: store is required');
  const adminLogin = typeof config.adminLogin === 'string' ? config.adminLogin : '';
  const publicBase = String(config.publicBase || DEFAULT_PUBLIC_BASE).replace(/\/+$/, '');
  const extraHosts = [
    new URL(publicBase).hostname.toLowerCase(),
    ...(Array.isArray(config.allowedHosts) ? config.allowedHosts : []).map((h) => String(h).toLowerCase()),
  ];
  const publicOrigin = normHostPort(new URL(publicBase).host);
  const weeksDir = join(rootDir, 'data', 'weeks');
  const publicRoot = resolve(publicDir);

  function baseHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
  }

  function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    if (res.headersSent) { res.destroy(); return; }
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...extra });
    res.end(buf);
  }
  const notFound = (res) => send(res, 404, 'Not found', 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

  // Resolve a public/ file; null unless it is a regular file really inside publicRoot.
  async function publicFile(segs) {
    if (!segs.length || segs.some((s) => s.startsWith('.'))) return null;
    const p = resolve(publicRoot, ...segs);
    if (!p.startsWith(publicRoot + sep)) return null;
    try {
      const real = await realpath(p);
      const realRoot = await realpath(publicRoot);
      if (!real.startsWith(realRoot + sep)) return null;
      const st = await stat(real);
      return st.isFile() ? { file: real, size: st.size } : null;
    } catch {
      return null;
    }
  }

  async function sendFile(res, file, type, cache) {
    let st;
    try { st = await stat(file); } catch { return notFound(res); }
    if (!st.isFile()) return notFound(res);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache });
    await new Promise((done) => {
      const s = createReadStream(file);
      s.on('error', (e) => { log('read failed', file, e.message); res.destroy(); done(); });
      s.on('end', done);
      s.pipe(res);
    });
  }

  async function sendStatic(res, segs) {
    const f = await publicFile(segs);
    if (!f) return notFound(res);
    const type = MIME[extname(f.file).toLowerCase()] || 'application/octet-stream';
    const cache = type.startsWith('text/html') ? 'no-store' : 'no-cache';
    return sendFile(res, f.file, type, cache);
  }

  async function sendPhoto(res, week, id, kind) {
    const file = await store.photoPath(week, id, kind);
    const ext = kind === 'thumb' ? 'jpg' : extname(file).slice(1).toLowerCase();
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    return sendFile(res, file, IMAGE_MIME[ext] || 'application/octet-stream', 'no-store');
  }

  // Read the whole body, aborting with 413 once it passes `limit` bytes.
  function readBody(req, limit) {
    return new Promise((ok, fail) => {
      const len = req.headers['content-length'];
      if (len !== undefined && Number(len) > limit) return fail(new HttpError(413));
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (c) => {
        if (over) return;
        size += c.length;
        if (size > limit) { over = true; chunks.length = 0; fail(new HttpError(413)); return; }
        chunks.push(c);
      });
      req.on('end', () => { if (!over) ok(Buffer.concat(chunks)); });
      req.on('error', (e) => fail(e));
    });
  }

  async function readJson(req) {
    const buf = await readBody(req, maxJsonBytes);
    let v;
    try {
      v = buf.length ? JSON.parse(buf.toString('utf8')) : {};
    } catch {
      throw new StoreError('invalid', 'bad json');
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new StoreError('invalid', 'body must be a JSON object');
    return v;
  }

  async function listPhotos(week) {
    let w;
    try {
      w = JSON.parse(await readFile(join(weeksDir, `${week}.json`), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
      throw e;
    }
    return w.photos.map((p) => ({ id: p.id, originalName: p.originalName, takenAt: p.takenAt ?? null, score: p.score ?? null }));
  }

  function optNumber(v) {
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new StoreError('invalid', 'bad number');
    return n;
  }

  // Body = thumb + original + optional full JPEG (HEIC/HEIF only). X-Thumb-Length and the
  // optional X-Full-Length are non-negative integers; original must be non-empty.
  async function upload(req, res, week, query) {
    const tl = req.headers['x-thumb-length'];
    if (typeof tl !== 'string' || !/^[1-9]\d*$/.test(tl)) throw new HttpError(400, 'bad X-Thumb-Length');
    const thumbLen = Number(tl);
    if (thumbLen > maxThumbBytes) throw new HttpError(413);
    const fl = req.headers['x-full-length'];
    if (fl !== undefined && (typeof fl !== 'string' || !/^(0|[1-9]\d*)$/.test(fl))) throw new HttpError(400, 'bad X-Full-Length');
    const fullLen = fl === undefined ? 0 : Number(fl);
    if (!Number.isSafeInteger(fullLen)) throw new HttpError(400, 'bad X-Full-Length');
    const body = await readBody(req, maxThumbBytes + maxPhotoBytes);
    if (thumbLen + fullLen >= body.length) throw new HttpError(400, 'bad lengths');
    if (body.length - thumbLen > maxPhotoBytes) throw new HttpError(413);
    const origEnd = body.length - fullLen;
    const takenRaw = query.get('takenAt');
    const takenAt = takenRaw === null || takenRaw === '' ? null : (/^-?\d+(\.\d+)?$/.test(takenRaw) ? Number(takenRaw) : takenRaw);
    const { id } = await store.addPhoto(week, {
      thumb: body.subarray(0, thumbLen),
      bytes: body.subarray(thumbLen, origEnd),
      fullJpeg: fullLen > 0 ? body.subarray(origEnd) : undefined,
      ext: query.get('ext') ?? '',
      originalName: query.get('name') ?? '',
      takenAt,
      score: optNumber(query.get('score')),
    });
    return json(res, 200, { id });
  }

  async function admin(req, res, segs, query) {
    const m = req.method;
    const [a, b, c, d, e, f] = segs;
    const n = segs.length;
    if (n === 1 && a === 'admin' && m === 'GET') return sendStatic(res, ['admin.html']);
    if (a !== 'api' || b !== 'admin') return m === 'GET' ? sendStatic(res, segs) : notFound(res);
    if (n === 3 && c === 'weeks' && m === 'GET') return json(res, 200, await store.listWeeks());
    if (n === 3 && c === 'funnel' && m === 'GET') {
      let state = 'unknown';
      try { state = await funnelState(); } catch (err) { log('funnel status failed:', err.message); }
      return json(res, 200, { state });
    }
    if (n === 5 && c === 'img' && m === 'GET' && WEEK_RE.test(d) && ID_RE.test(e)) return sendPhoto(res, d, e, 'thumb');
    if (c !== 'weeks' || !WEEK_RE.test(d ?? '')) return notFound(res);
    if (n === 5 && e === 'photos' && m === 'GET') return json(res, 200, await listPhotos(d));
    if (n === 5 && e === 'photos' && m === 'POST') return upload(req, res, d, query);
    if (n === 6 && e === 'photos' && m === 'DELETE' && ID_RE.test(f)) {
      await store.removePhoto(d, f);
      return json(res, 200, { ok: true });
    }
    if (n === 5 && e === 'scores' && m === 'PUT') {
      await store.setScores(d, await readJson(req));
      return json(res, 200, { ok: true });
    }
    if (n === 5 && e === 'links' && m === 'GET') {
      const t = await store.getLinksTokens(d);
      if (!t) return notFound(res);
      return json(res, 200, { links: { me: `${publicBase}/v/${t.me}`, wife: `${publicBase}/v/${t.wife}` } });
    }
    if (n === 5 && e === 'start' && m === 'POST') {
      const t = await store.startVoting(d);
      return json(res, 200, { links: { me: `${publicBase}/v/${t.me}`, wife: `${publicBase}/v/${t.wife}` } });
    }
    return notFound(res);
  }

  // /v/<token>[/api/state|/api/pick|/api/undo|/api/joint|/img/<id>]
  async function vote(req, res, segs) {
    const token = segs[1];
    if (!TOKEN_RE.test(token)) return notFound(res);
    const who = await store.findByToken(token);
    if (!who) return notFound(res);
    const { week, voter } = who;
    const m = req.method;
    const rest = segs.slice(2).join('/');
    try {
      if (rest === '' && m === 'GET') return await sendStatic(res, ['vote.html']);
      if (rest === 'api/state' && m === 'GET') return json(res, 200, await store.voterState(week, voter));
      if (segs.length === 4 && segs[2] === 'img' && m === 'GET' && ID_RE.test(segs[3])) {
        return await sendPhoto(res, week, segs[3], 'thumb');
      }
      if (m === 'POST' && rest === 'api/pick') {
        const { matchId, winnerId } = await readJson(req);
        return json(res, 200, await store.pick(week, voter, matchId, winnerId));
      }
      if (m === 'POST' && rest === 'api/undo') {
        const { matchId = null } = await readJson(req);
        return json(res, 200, await store.undo(week, voter, matchId));
      }
      if (m === 'POST' && rest === 'api/joint') {
        const { winnerId } = await readJson(req);
        return json(res, 200, await store.jointPick(week, winnerId, voter));
      }
      return notFound(res);
    } catch (err) {
      if (err instanceof MatchError) {
        const view = err.view ?? (await store.voterState(week, voter).catch(() => null));
        return json(res, 409, view ?? { error: 'conflict' });
      }
      // Never reveal details on the public surface: invalid / not_found look like a miss.
      if (err instanceof StoreError) return err.code === 'state' ? json(res, 409, { error: 'state' }) : notFound(res);
      if (err instanceof HttpError && err.status !== 413) return notFound(res);
      throw err;
    }
  }

  async function handle(req, res) {
    baseHeaders(res);
    if (!hostAllowed(req.headers.host, extraHosts)) return notFound(res);
    const parsed = parsePath(req.url);
    if (!parsed) return notFound(res);
    const { segs, path, query } = parsed;
    if (req.method !== 'GET' && !sameOriginWrite(req, publicOrigin)) return notFound(res);
    const isFunnel = req.headers['tailscale-funnel-request'] !== undefined;
    const login = req.headers['tailscale-user-login'];
    const isAdmin = !isFunnel && adminLogin !== '' && typeof login === 'string' && login === adminLogin;

    if (segs[0] === 'v' && segs.length >= 2) return vote(req, res, segs);
    if (FUNNEL_STATIC.has(path) && req.method === 'GET') return sendStatic(res, segs);
    if (!isAdmin) return notFound(res);
    if (segs.length === 0 && req.method === 'GET') {
      res.writeHead(302, { Location: '/admin', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return admin(req, res, segs, query);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) {
        if (err.status === 413) {
          send(res, 413, 'Payload too large', 'text/plain; charset=utf-8', { Connection: 'close' });
          res.on('finish', () => req.destroy());
          return;
        }
        return send(res, err.status, err.message || 'Bad request');
      }
      if (err instanceof StoreError) {
        const status = { invalid: 400, not_found: 404, state: 409 }[err.code] ?? 500;
        return status === 404 ? notFound(res) : json(res, status, { error: err.code, message: err.message });
      }
      log('request failed:', req.method, req.url, err);
      send(res, 500, 'Internal error');
    });
  });
  return server;
}
