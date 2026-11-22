// Week store: server-side state for one week of photo candidates and the couple's votes.
//
// Disk layout under rootDir:
//   pool/<week>/<id>.<ext>        original bytes, exactly as received
//   pool/<week>/<id>.thumb.jpg    thumbnail
//   pool/<week>/<id>.full.jpg     full-size JPEG of a HEIC/HEIF original (made on the phone)
//   data/weeks/<week>.json        week state (written to .tmp then renamed)
//   selected/<week>_<rank>.<ext>  final copies (HEIC/HEIF -> the full JPEG as .jpg; jpeg -> .jpg)
//
// Every read-validate-modify-write of a week runs inside a per-week promise-chain lock.
// Status flow: collecting -> voting -> (voting + jointFinal pending) -> finalizing -> done.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createBracket, currentMatch, applyPick, undo as undoBracket, ranks, merge, MatchError,
} from '../public/bracket.js';

export { MatchError };

// code: 'invalid' (400), 'not_found' (404), 'state' (409, wrong status for the operation)
export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const WEEK_RE = /^\d{4}-W\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
const VOTERS = ['me', 'wife'];
const OTHER = { me: 'wife', wife: 'me' };
const isHeicExt = (e) => e === 'heic' || e === 'heif';

function checkWeek(week) {
  if (typeof week !== 'string' || !WEEK_RE.test(week)) throw new StoreError('invalid', `bad week: ${week}`);
  const n = Number(week.slice(6));
  if (n < 1 || n > 53) throw new StoreError('invalid', `bad week: ${week}`);
}
function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new StoreError('invalid', `bad photo id`);
}
function checkVoter(voter) {
  if (!VOTERS.includes(voter)) throw new StoreError('invalid', `bad voter: ${voter}`);
}
function normExt(ext) {
  const e = typeof ext === 'string' ? ext.toLowerCase().replace(/^\./, '') : '';
  if (!EXTS.has(e)) throw new StoreError('invalid', `bad ext: ${ext}`);
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rename with short retries: Windows can briefly refuse while another handle (AV, reader) is open.
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(10 * (i + 1));
    }
  }
}

async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await renameRetry(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// Options (tests): rng for bracket shuffles, now for timestamps, copyFile to inject copy
// failures, log for non-fatal errors (default console.error).
export function createStore(rootDir, {
  rng = Math.random, now = Date.now, copyFile: copy = copyFile, log = (...a) => console.error(...a),
} = {}) {
  const poolDir = join(rootDir, 'pool');
  const weeksDir = join(rootDir, 'data', 'weeks');
  const selectedDir = join(rootDir, 'selected');
  const locks = new Map();

  function withLock(week, fn) {
    const prev = locks.get(week) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(week, tail);
    tail.then(() => { if (locks.get(week) === tail) locks.delete(week); });
    return run;
  }

  const weekFile = (week) => join(weeksDir, `${week}.json`);

  async function load(week) {
    try {
      return JSON.parse(await readFile(weekFile(week), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      throw e;
    }
  }
  async function mustLoad(week) {
    const w = await load(week);
    if (!w) throw new StoreError('not_found', `no week ${week}`);
    return w;
  }
  // For scans (listWeeks/findByToken): a corrupt week file is logged and skipped.
  async function safeLoad(week) {
    try {
      return await load(week);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      log(`store: skipping unparseable ${weekFile(week)}: ${e.message}`);
      return null;
    }
  }
  async function save(w) {
    await mkdir(weeksDir, { recursive: true });
    await atomicWrite(weekFile(w.week), JSON.stringify(w, null, 2));
  }

  async function listWeekIds() {
    let names;
    try { names = await readdir(weeksDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .filter((w) => WEEK_RE.test(w))
      .sort()
      .reverse();
  }

  const isDone = (w, voter) => !!(w.voters && ranks(w.voters[voter]).length);
  const scoresOf = (w) => Object.fromEntries(w.photos.map((p) => [p.id, p.score ?? 0]));

  function findPhoto(w, id) {
    const p = w.photos.find((x) => x.id === id);
    if (!p) throw new StoreError('not_found', `no photo ${id}`);
    return p;
  }

  // Both brackets complete and no result yet -> merge; overlap -> finalizing, none -> jointFinal pending.
  // Caller must hold the lock. Returns true if w changed.
  function settle(w) {
    if (w.status !== 'voting' || w.jointFinal || w.final) return false;
    if (!isDone(w, 'me') || !isDone(w, 'wife')) return false;
    const me = ranks(w.voters.me);
    const wife = ranks(w.voters.wife);
    const r = merge(me, wife, scoresOf(w));
    if (r.jointFinal) {
      w.jointFinal = r.jointFinal;
      return true;
    }
    beginFinalize(w, me, wife, r.saved, false);
    return true;
  }

  // Each file records its source (name inside pool/<week>/) and final name at this step, so a
  // resume reuses them. Records without `src` (older format) copy the original file.
  function planFile(w, id, rank) {
    const p = findPhoto(w, id);
    if (isHeicExt(p.ext)) {
      if (!p.hasFullJpeg) throw new StoreError('state', `photo ${id} has no full JPEG`);
      return { id, name: `${w.week}_${rank}.jpg`, src: `${id}.full.jpg` };
    }
    const outExt = p.ext === 'jpeg' ? 'jpg' : p.ext;
    return { id, name: `${w.week}_${rank}.${outExt}`, src: `${id}.${p.ext}` };
  }

  function beginFinalize(w, me, wife, saved, joint) {
    w.final = {
      me, wife, saved, joint,
      files: saved.map((id, i) => planFile(w, id, i + 1)),
    };
    w.jointFinal = null;
    w.status = 'finalizing';
    w.finalizedAt = now();
  }

  // Phase 2: copy originals under the recorded names; never overwrite. Caller holds the lock
  // and has already saved the 'finalizing' state.
  async function copyFinal(w) {
    await mkdir(selectedDir, { recursive: true });
    for (const f of w.final.files) {
      const dest = join(selectedDir, f.name);
      if (await exists(dest)) continue;
      const p = findPhoto(w, f.id);
      const tmp = join(selectedDir, `.${f.name}.${randomBytes(4).toString('hex')}.tmp`);
      try {
        await copy(join(poolDir, w.week, f.src ?? `${p.id}.${p.ext}`), tmp);
        if (await exists(dest)) continue; // appeared meanwhile: keep it
        await renameRetry(tmp, dest);
      } finally {
        await unlink(tmp).catch(() => {});
      }
    }
    const done = { ...w, status: 'done', doneAt: now() };
    await save(done);
    Object.assign(w, done);
  }

  // Copy failures are not fatal: the week stays 'finalizing' and the copy is retried on the
  // next locked load (tryFinish) or by resumeFinalize(). Caller holds the lock.
  async function tryFinish(w) {
    if (w.status !== 'finalizing') return;
    try {
      await copyFinal(w);
    } catch (e) {
      log(`store: finalize copy for ${w.week} failed, will retry: ${e.message}`);
    }
  }

  // Locked load used by voter reads and vote ops: retries a pending finalize first.
  async function loadLive(week) {
    const w = await mustLoad(week);
    await tryFinish(w);
    return w;
  }

  // settle + persist + (if finalizing) copy. Caller holds the lock.
  async function commit(w) {
    settle(w);
    await save(w);
    await tryFinish(w);
  }

  function view(w, voter) {
    if (w.status === 'collecting' || !w.voters) throw new StoreError('state', `week ${w.week} is not voting`);
    const mine = w.voters[voter];
    const myDone = isDone(w, voter);
    const otherDone = isDone(w, OTHER[voter]);
    const both = myDone && otherDone;
    const open = w.status === 'voting' && !w.jointFinal;
    return {
      week: w.week,
      voter,
      status: w.status,
      photos: w.photos.map((p) => p.id),
      match: open ? currentMatch(mine) : null,
      canUndo: open && mine.picks.length > 0,
      myRanks: myDone ? ranks(mine) : null,
      otherDone,
      jointFinal: w.status === 'voting' && w.jointFinal ? w.jointFinal.slice() : null,
      result: both
        ? w.final
          ? {
            me: w.final.me.slice(), wife: w.final.wife.slice(), saved: w.final.saved.slice(),
            joint: w.final.joint, files: w.final.files.map((f) => f.name),
          }
          : { me: ranks(w.voters.me), wife: ranks(w.voters.wife), saved: [], joint: false, files: [] }
        : null,
    };
  }

  // Run a voting mutation; on MatchError attach the latest view so callers can answer 409 with it.
  async function voteOp(week, voter, mutate) {
    checkWeek(week);
    checkVoter(voter);
    return withLock(week, async () => {
      const w = await loadLive(week);
      if (!w.voters) throw new StoreError('state', `week ${week} is not voting`);
      try {
        mutate(w);
      } catch (e) {
        if (e instanceof MatchError) e.view = view(w, voter);
        throw e;
      }
      await commit(w);
      return view(w, voter);
    });
  }

  return {
    async listWeeks() {
      const out = [];
      for (const week of await listWeekIds()) {
        const w = await safeLoad(week);
        if (!w) continue;
        out.push({
          week,
          status: w.status,
          photoCount: w.photos.length,
          voters: { me: { done: isDone(w, 'me') }, wife: { done: isDone(w, 'wife') } },
        });
      }
      return out;
    },

    async addPhoto(week, { bytes, ext, originalName, takenAt = null, score = null, thumb, fullJpeg } = {}) {
      checkWeek(week);
      const e = normExt(ext);
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new StoreError('invalid', 'bytes must be a non-empty Buffer');
      if (!Buffer.isBuffer(thumb) || !thumb.length) throw new StoreError('invalid', 'thumb must be a non-empty Buffer');
      const hasFull = fullJpeg !== undefined && fullJpeg !== null;
      if (hasFull && (!Buffer.isBuffer(fullJpeg) || !fullJpeg.length)) throw new StoreError('invalid', 'fullJpeg must be a non-empty Buffer');
      if (isHeicExt(e) && !hasFull) throw new StoreError('invalid', 'HEIC/HEIF needs fullJpeg');
      if (!isHeicExt(e) && hasFull) throw new StoreError('invalid', 'fullJpeg only for HEIC/HEIF');
      if (score !== null && !Number.isFinite(score)) throw new StoreError('invalid', 'bad score');
      if (takenAt !== null && typeof takenAt !== 'number' && typeof takenAt !== 'string') {
        throw new StoreError('invalid', 'bad takenAt');
      }
      const name = typeof originalName === 'string' ? originalName.split(/[\\/]/).pop().slice(0, 255) : '';
      return withLock(week, async () => {
        const w = (await load(week)) ?? {
          version: 1, week, status: 'collecting', createdAt: now(), photos: [],
          tokens: null, tokensRevoked: false, voters: null, jointFinal: null, final: null,
        };
        if (w.status !== 'collecting') throw new StoreError('state', `week ${week} is ${w.status}`);
        const id = randomBytes(9).toString('base64url');
        const dir = join(poolDir, week);
        await mkdir(dir, { recursive: true });
        const files = [join(dir, `${id}.${e}`), join(dir, `${id}.thumb.jpg`)];
        if (hasFull) files.push(join(dir, `${id}.full.jpg`));
        try {
          await atomicWrite(files[0], bytes);
          await atomicWrite(files[1], thumb);
          if (hasFull) await atomicWrite(files[2], fullJpeg);
          w.photos.push({ id, ext: e, originalName: name, takenAt, score, addedAt: now(), hasFullJpeg: hasFull });
          await save(w);
        } catch (err) {
          for (const f of files) await unlink(f).catch(() => {});
          throw err;
        }
        return { id };
      });
    },

    async removePhoto(week, id) {
      checkWeek(week);
      checkId(id);
      return withLock(week, async () => {
        const w = await mustLoad(week);
        if (w.status !== 'collecting') throw new StoreError('state', `week ${week} is ${w.status}`);
        const p = findPhoto(w, id);
        w.photos = w.photos.filter((x) => x.id !== id);
        await save(w);
        for (const f of [`${id}.${p.ext}`, `${id}.thumb.jpg`, `${id}.full.jpg`]) {
          await unlink(join(poolDir, week, f)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
        }
      });
    },

    async setScores(week, scores) {
      checkWeek(week);
      if (!scores || typeof scores !== 'object') throw new StoreError('invalid', 'scores must be an object');
      for (const [id, s] of Object.entries(scores)) {
        checkId(id);
        if (!Number.isFinite(s)) throw new StoreError('invalid', `bad score for ${id}`);
      }
      return withLock(week, async () => {
        const w = await mustLoad(week);
        if (w.status !== 'collecting' && !(w.status === 'voting' && !w.jointFinal)) {
          throw new StoreError('state', `week ${week} is ${w.status}`);
        }
        for (const id of Object.keys(scores)) findPhoto(w, id);
        for (const p of w.photos) if (Object.hasOwn(scores, p.id)) p.score = scores[p.id];
        await save(w);
      });
    },

    async startVoting(week) {
      checkWeek(week);
      return withLock(week, async () => {
        const w = await mustLoad(week);
        if (w.status !== 'collecting') throw new StoreError('state', `week ${week} is ${w.status}`);
        if (!w.photos.length) throw new StoreError('state', `week ${week} has no photos`);
        const ids = w.photos.map((p) => p.id);
        w.voters = { me: createBracket(ids, rng), wife: createBracket(ids, rng) };
        w.tokens = { me: randomBytes(24).toString('base64url'), wife: randomBytes(24).toString('base64url') };
        w.tokensRevoked = false;
        w.status = 'voting';
        w.votingStartedAt = now();
        await commit(w); // a 1-photo week settles immediately
        return { ...w.tokens };
      });
    },

    // Tokens of a started, non-revoked week; null otherwise (collecting / revoked / none).
    async getLinksTokens(week) {
      checkWeek(week);
      return withLock(week, async () => {
        const w = await load(week);
        if (!w || !w.tokens || w.tokensRevoked || w.status === 'collecting') return null;
        return { me: w.tokens.me, wife: w.tokens.wife };
      });
    },

    async findByToken(token) {
      if (typeof token !== 'string' || !token) return null;
      const t = Buffer.from(token);
      for (const week of await listWeekIds()) {
        const w = await safeLoad(week);
        if (!w || !w.tokens || w.tokensRevoked || w.status === 'collecting') continue;
        for (const voter of VOTERS) {
          const c = Buffer.from(w.tokens[voter]);
          if (c.length === t.length && timingSafeEqual(c, t)) return { week, voter };
        }
      }
      return null;
    },

    async voterState(week, voter) {
      checkWeek(week);
      checkVoter(voter);
      return withLock(week, async () => view(await loadLive(week), voter));
    },

    async pick(week, voter, matchId, winnerId) {
      if (typeof matchId !== 'string') throw new StoreError('invalid', 'matchId must be a string');
      checkId(winnerId);
      return voteOp(week, voter, (w) => {
        if (w.status !== 'voting' || w.jointFinal) throw new MatchError('voting closed');
        w.voters[voter] = applyPick(w.voters[voter], matchId, winnerId);
      });
    },

    // matchId: the match the client currently shows (null when its bracket is finished).
    async undo(week, voter, matchId) {
      if (matchId != null && typeof matchId !== 'string') throw new StoreError('invalid', 'matchId must be a string or null');
      return voteOp(week, voter, (w) => {
        if (w.status !== 'voting' || w.jointFinal) throw new MatchError('voting closed');
        const b = w.voters[voter];
        const cur = currentMatch(b);
        if ((cur ? cur.id : null) !== (matchId ?? null)) throw new MatchError(`stale match: ${matchId}`);
        if (!b.picks.length) throw new MatchError('nothing to undo');
        w.voters[voter] = undoBracket(b);
      });
    },

    // First valid pick of the pending pair wins; returns the given voter's view.
    async jointPick(week, winnerId, voter = 'me') {
      checkId(winnerId);
      return voteOp(week, voter, (w) => {
        if (w.status !== 'voting' || !w.jointFinal) throw new MatchError('no joint final pending');
        if (!w.jointFinal.includes(winnerId)) throw new MatchError(`invalid winner: ${winnerId}`);
        beginFinalize(w, ranks(w.voters.me), ranks(w.voters.wife), [winnerId], true);
      });
    },

    async resumeFinalize() {
      let n = 0;
      for (const week of await listWeekIds()) {
        await withLock(week, async () => {
          const w = await load(week);
          if (w && w.status === 'finalizing') { await copyFinal(w); n++; }
        });
      }
      return n;
    },

    async revokeDoneTokens() {
      let n = 0;
      for (const week of await listWeekIds()) {
        await withLock(week, async () => {
          const w = await load(week);
          if (w && w.status === 'done' && w.tokens && !w.tokensRevoked) {
            w.tokensRevoked = true;
            await save(w);
            n++;
          }
        });
      }
      return n;
    },

    async photoPath(week, id, kind) {
      checkWeek(week);
      checkId(id);
      if (kind !== 'orig' && kind !== 'thumb') throw new StoreError('invalid', `bad kind: ${kind}`);
      return withLock(week, async () => {
        const p = findPhoto(await mustLoad(week), id);
        return join(poolDir, week, kind === 'orig' ? `${id}.${p.ext}` : `${id}.thumb.jpg`);
      });
    },
  };
}
