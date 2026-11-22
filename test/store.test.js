import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, StoreError } from '../src/store.js';
import { MatchError, currentMatch, merge } from '../public/bracket.js';

const WEEK = '2026-W47';

async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Deterministic rng so brackets are reproducible.
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function photoInput(i, ext = 'jpg') {
  return {
    bytes: Buffer.from(`original-bytes-${i}-\u0000ÿ-${'x'.repeat(i)}`, 'latin1'),
    ext,
    originalName: `IMG_${i}.${ext}`,
    takenAt: 1700000000000 + i,
    score: i / 100,
    thumb: Buffer.from(`thumb-${i}`),
  };
}

async function addPhotos(store, n, week = WEEK) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await store.addPhoto(week, photoInput(i))).id);
  return ids;
}

// Play a voter's whole bracket, choosing with prefer(a, b) -> winner.
async function playAll(store, voter, prefer, week = WEEK) {
  let view = await store.voterState(week, voter);
  while (view.match) {
    const m = view.match;
    view = await store.pick(week, voter, m.id, prefer(m.a, m.b));
  }
  return view;
}

// Preference by a fixed ranking list: earlier in list wins.
const byList = (list) => (a, b) => (list.indexOf(a) <= list.indexOf(b) ? a : b);

test('addPhoto stores original bytes verbatim and thumbnail', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root);
  const input = photoInput(3, 'jpeg');
  const { id } = await store.addPhoto(WEEK, input);
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  const orig = await store.photoPath(WEEK, id, 'orig');
  assert.equal(orig, join(root, 'pool', WEEK, `${id}.jpeg`));
  assert.ok((await readFile(orig)).equals(input.bytes));
  const thumb = await store.photoPath(WEEK, id, 'thumb');
  assert.equal(thumb, join(root, 'pool', WEEK, `${id}.thumb.jpg`));
  assert.ok((await readFile(thumb)).equals(input.thumb));
  const weeks = await store.listWeeks();
  assert.deepEqual(weeks, [
    { week: WEEK, status: 'collecting', photoCount: 1, voters: { me: { done: false }, wife: { done: false } } },
  ]);
});

test('validation: bad week, id, ext and kind are rejected', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root);
  await assert.rejects(store.addPhoto('../etc', photoInput(1)), StoreError);
  await assert.rejects(store.addPhoto('2026-47', photoInput(1)), StoreError);
  await assert.rejects(store.addPhoto(WEEK, photoInput(1, 'exe')), StoreError);
  await assert.rejects(store.addPhoto(WEEK, { ...photoInput(1), ext: 'JPG/../x' }), StoreError);
  await assert.rejects(store.addPhoto(WEEK, { ...photoInput(1), bytes: 'nope' }), StoreError);
  const [id] = await addPhotos(store, 1);
  await assert.rejects(store.photoPath(WEEK, '../../secret', 'orig'), StoreError);
  await assert.rejects(store.photoPath(WEEK, id, 'raw'), StoreError);
  await assert.rejects(store.photoPath('2026-W01', id, 'orig'), (e) => e instanceof StoreError && e.code === 'not_found');
  await assert.rejects(store.voterState(WEEK, 'mom'), StoreError);
  // Uppercase ext is normalised to lowercase.
  const { id: id2 } = await store.addPhoto(WEEK, { ...photoInput(2), ext: 'PNG' });
  assert.ok((await store.photoPath(WEEK, id2, 'orig')).endsWith(`${id2}.png`));
});

test('startVoting locks collection; removePhoto only while collecting', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(2) });
  await assert.rejects(store.startVoting(WEEK), StoreError); // no week yet
  const ids = await addPhotos(store, 3);
  await store.removePhoto(WEEK, ids[2]);
  await assert.rejects(store.photoPath(WEEK, ids[2], 'orig'), StoreError);
  assert.deepEqual(await readdir(join(root, 'pool', WEEK)).then((f) => f.sort()),
    [`${ids[0]}.jpg`, `${ids[0]}.thumb.jpg`, `${ids[1]}.jpg`, `${ids[1]}.thumb.jpg`].sort());
  const tokens = await store.startVoting(WEEK);
  assert.match(tokens.me, /^[A-Za-z0-9_-]{32}$/);
  assert.match(tokens.wife, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(tokens.me, tokens.wife);
  await assert.rejects(store.addPhoto(WEEK, photoInput(9)), StoreError);
  await assert.rejects(store.removePhoto(WEEK, ids[0]), StoreError);
  await assert.rejects(store.startVoting(WEEK), StoreError);
  assert.deepEqual(await store.findByToken(tokens.me), { week: WEEK, voter: 'me' });
  assert.deepEqual(await store.findByToken(tokens.wife), { week: WEEK, voter: 'wife' });
  assert.equal(await store.findByToken('nope'), null);
  assert.equal(await store.findByToken(''), null);
});

test('startVoting with zero photos throws', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root);
  const [id] = await addPhotos(store, 1);
  await store.removePhoto(WEEK, id);
  await assert.rejects(store.startVoting(WEEK), StoreError);
});

test('concurrent identical picks: one succeeds, one MatchError with latest view', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(3) });
  await addPhotos(store, 4);
  await store.startVoting(WEEK);
  const v = await store.voterState(WEEK, 'me');
  const m = v.match;
  const results = await Promise.allSettled([
    store.pick(WEEK, 'me', m.id, m.a),
    store.pick(WEEK, 'me', m.id, m.a),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.ok(bad[0].reason instanceof MatchError);
  assert.equal(bad[0].reason.view.match.index, 2);
  assert.equal(ok[0].value.match.index, 2);
});

test('me and wife play 20 matches concurrently to completion', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(4) });
  const ids = await addPhotos(store, 20);
  await store.startVoting(WEEK);
  const first = (await store.voterState(WEEK, 'me')).match;
  assert.equal(first.total, 20);
  const pref = byList(ids);
  let count = { me: 0, wife: 0 };
  const run = async (voter) => {
    let view = await store.voterState(WEEK, voter);
    while (view.match) {
      view = await store.pick(WEEK, voter, view.match.id, pref(view.match.a, view.match.b));
      count[voter]++;
    }
  };
  await Promise.all([run('me'), run('wife')]);
  assert.deepEqual(count, { me: 20, wife: 20 });
  const me = await store.voterState(WEEK, 'me');
  assert.equal(me.status, 'done');
  assert.equal(me.myRanks.length, 3);
  assert.equal(me.myRanks[0], ids[0]);
  const scores = Object.fromEntries(ids.map((id, i) => [id, i / 100]));
  assert.deepEqual(me.result.saved, merge(me.result.me, me.result.wife, scores).saved);
  assert.equal(me.result.saved[0], ids[0]);
});

test('result hidden until both done, then overlap copied to selected/ and done', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(5) });
  const ids = await addPhotos(store, 5);
  const tokens = await store.startVoting(WEEK);
  const meView = await playAll(store, 'me', byList([ids[0], ids[1], ids[2], ids[3], ids[4]]));
  assert.equal(meView.myRanks.length, 3);
  assert.equal(meView.otherDone, false);
  assert.equal(meView.result, null);
  assert.equal(meView.status, 'voting');
  const wifeMid = await store.voterState(WEEK, 'wife');
  assert.equal(wifeMid.otherDone, true);
  assert.equal(wifeMid.result, null);
  assert.equal(wifeMid.myRanks, null);
  // No field of the not-yet-done voter's view may carry me's ranks.
  for (const k of ['me', 'wife', 'ranks', 'otherRanks']) assert.ok(!(k in wifeMid), k);
  assert.ok(!JSON.stringify(wifeMid).includes(JSON.stringify(meView.myRanks)));
  const wifeView = await playAll(store, 'wife', byList([ids[0], ids[4], ids[3], ids[2], ids[1]]));
  assert.equal(wifeView.status, 'done');
  assert.deepEqual(wifeView.result.me, meView.myRanks);
  assert.deepEqual(wifeView.result.wife, wifeView.myRanks);
  const scores = Object.fromEntries(ids.map((id, i) => [id, i / 100]));
  const expected = merge(meView.myRanks, wifeView.myRanks, scores).saved;
  assert.ok(expected.length >= 1);
  assert.equal(expected[0], ids[0]);
  assert.deepEqual(wifeView.result.saved, expected);
  const names = expected.map((_, i) => `${WEEK}_${i + 1}.jpg`);
  assert.deepEqual(wifeView.result.files, names);
  assert.equal(wifeView.result.joint, false);
  assert.deepEqual((await readdir(join(root, 'selected'))).sort(), names);
  for (let i = 0; i < expected.length; i++) {
    const src = photoInput(ids.indexOf(expected[i])).bytes;
    assert.ok((await readFile(join(root, 'selected', names[i]))).equals(src));
  }
  const weeks = await store.listWeeks();
  assert.equal(weeks[0].status, 'done');
  assert.deepEqual(weeks[0].voters, { me: { done: true }, wife: { done: true } });
  // Tokens still resolve until revoked.
  assert.deepEqual(await store.findByToken(tokens.me), { week: WEEK, voter: 'me' });
  assert.equal(await store.revokeDoneTokens(), 1);
  assert.equal(await store.findByToken(tokens.me), null);
  assert.equal(await store.findByToken(tokens.wife), null);
  assert.equal(await store.revokeDoneTokens(), 0);
});

test('undo: requires current match id, works after finishing while other still voting', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(6) });
  const ids = await addPhotos(store, 3);
  await store.startVoting(WEEK);
  let v = await store.voterState(WEEK, 'me');
  assert.equal(v.canUndo, false);
  await assert.rejects(store.undo(WEEK, 'me', v.match.id), MatchError); // nothing to undo
  const m1 = v.match;
  v = await store.pick(WEEK, 'me', m1.id, m1.a);
  assert.equal(v.canUndo, true);
  await assert.rejects(store.undo(WEEK, 'me', m1.id), MatchError); // stale id
  v = await store.undo(WEEK, 'me', v.match.id);
  assert.deepEqual(v.match, m1);
  v = await playAll(store, 'me', byList(ids));
  assert.equal(v.match, null);
  assert.equal(v.canUndo, true);
  await assert.rejects(store.undo(WEEK, 'me', 'final'), MatchError);
  v = await store.undo(WEEK, 'me', null);
  assert.equal(v.myRanks, null);
  assert.ok(v.match);
  v = await playAll(store, 'me', byList(ids));
  await playAll(store, 'wife', byList(ids));
  v = await store.voterState(WEEK, 'me');
  assert.equal(v.status, 'done');
  assert.equal(v.canUndo, false);
  await assert.rejects(store.undo(WEEK, 'me', null), MatchError);
  await assert.rejects(store.pick(WEEK, 'me', 'final', ids[0]), MatchError);
});

test('joint final: no overlap -> pending; concurrent jointPick applies only the first', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(7) });
  // 12 photos: at most one quarter can be all of me's top 3, so wife (preferring
  // everything else) never ranks any of them -> guaranteed no overlap.
  const ids = await addPhotos(store, 12);
  await store.startVoting(WEEK);
  const mv = await playAll(store, 'me', byList(ids));
  const R = mv.myRanks;
  const wifePref = [...ids.filter((id) => !R.includes(id)).reverse(), ...R];
  const wv = await playAll(store, 'wife', byList(wifePref));
  assert.equal(wv.status, 'voting');
  assert.equal(wv.match, null);
  assert.ok(wv.myRanks.every((id) => !R.includes(id)));
  assert.deepEqual(wv.jointFinal, [R[0], wv.myRanks[0]]);
  assert.deepEqual(wv.result.me, R);
  assert.deepEqual(wv.result.wife, wv.myRanks);
  assert.deepEqual(wv.result.saved, []);
  assert.equal(wv.canUndo, false);
  assert.deepEqual((await store.voterState(WEEK, 'me')).jointFinal, wv.jointFinal);
  await assert.rejects(store.undo(WEEK, 'wife', null), MatchError);
  await assert.rejects(store.pick(WEEK, 'wife', 'final', wv.myRanks[0]), MatchError);
  const outsider = ids.find((id) => !wv.jointFinal.includes(id));
  await assert.rejects(store.jointPick(WEEK, outsider), MatchError); // not in pair
  const [a, b] = wv.jointFinal;
  const results = await Promise.allSettled([
    store.jointPick(WEEK, b, 'wife'),
    store.jointPick(WEEK, a, 'me'),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.ok(results[1].reason instanceof MatchError);
  assert.equal(results[1].reason.view.voter, 'me');
  const v = results[0].value;
  assert.equal(v.voter, 'wife');
  assert.equal(v.status, 'done');
  assert.equal(v.jointFinal, null);
  assert.deepEqual(v.result.saved, [b]);
  assert.equal(v.result.joint, true);
  const sel = await readdir(join(root, 'selected'));
  assert.deepEqual(sel, [`${WEEK}_1.jpg`]);
  assert.ok((await readFile(join(root, 'selected', sel[0]))).equals(photoInput(ids.indexOf(b)).bytes));
});

test('single photo: no matches, both done immediately on view, saved', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(8) });
  const [id] = await addPhotos(store, 1);
  await store.startVoting(WEEK);
  const v = await store.voterState(WEEK, 'me');
  assert.equal(v.status, 'done');
  assert.deepEqual(v.result.saved, [id]);
});

test('finalize resume: copies the rest under the same names without overwriting', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(9) });
  const ids = await addPhotos(store, 4);
  await store.startVoting(WEEK);
  await playAll(store, 'me', byList(ids));
  await playAll(store, 'wife', byList(ids));
  // Simulate crash between "finalizing recorded" and "all copies done".
  const jsonPath = join(root, 'data', 'weeks', `${WEEK}.json`);
  const data = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(data.status, 'done');
  assert.deepEqual(data.final.files.map((f) => f.name), [`${WEEK}_1.jpg`, `${WEEK}_2.jpg`, `${WEEK}_3.jpg`]);
  const src = (n) => photoInput(ids.indexOf(data.final.files[n].id)).bytes;
  data.status = 'finalizing';
  await writeFile(jsonPath, JSON.stringify(data));
  const sel = join(root, 'selected');
  await unlink(join(sel, `${WEEK}_2.jpg`));
  await unlink(join(sel, `${WEEK}_3.jpg`));
  await writeFile(join(sel, `${WEEK}_1.jpg`), 'pre-existing');

  const store2 = createStore(root);
  assert.equal((await store2.listWeeks())[0].status, 'finalizing'); // listWeeks does not retry
  await store2.resumeFinalize();
  assert.deepEqual((await readdir(sel)).sort(), [`${WEEK}_1.jpg`, `${WEEK}_2.jpg`, `${WEEK}_3.jpg`]);
  assert.equal(await readFile(join(sel, `${WEEK}_1.jpg`), 'utf8'), 'pre-existing');
  assert.ok((await readFile(join(sel, `${WEEK}_2.jpg`))).equals(src(1)));
  assert.ok((await readFile(join(sel, `${WEEK}_3.jpg`))).equals(src(2)));
  assert.equal((await store2.voterState(WEEK, 'me')).status, 'done');
  const after = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(after.status, 'done');
  // No temp files left behind.
  assert.deepEqual((await readdir(join(root, 'data', 'weeks'))), [`${WEEK}.json`]);
});

test('setScores updates scores used for tie-break and rejects unknown ids', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(10) });
  const ids = await addPhotos(store, 2);
  await store.setScores(WEEK, { [ids[0]]: 0.1, [ids[1]]: 0.9 });
  await assert.rejects(store.setScores(WEEK, { zzzzzz: 1 }), StoreError);
  await assert.rejects(store.setScores(WEEK, { [ids[0]]: 'x' }), StoreError);
  await store.startVoting(WEEK);
  // me [0,1], wife [1,0]: both sums 3 -> higher score (ids[1]) first.
  await playAll(store, 'me', byList([ids[0], ids[1]]));
  const v = await playAll(store, 'wife', byList([ids[1], ids[0]]));
  assert.deepEqual(v.result.saved, [ids[1], ids[0]]);
  await assert.rejects(store.setScores(WEEK, { [ids[0]]: 1 }), StoreError); // done
});

test('voterState shape before voting is a state error; now is injectable', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { now: () => 1234 });
  await addPhotos(store, 2);
  await assert.rejects(store.voterState(WEEK, 'me'), (e) => e instanceof StoreError && e.code === 'state');
  const data = JSON.parse(await readFile(join(root, 'data', 'weeks', `${WEEK}.json`), 'utf8'));
  assert.equal(data.createdAt, 1234);
  assert.equal(data.photos[0].addedAt, 1234);
  assert.equal(currentMatch({ order: [], picks: [] }), null);
});

test('finalize copy failure: pick still resolves (finalizing), next voterState retries to done', async (t) => {
  const root = await tempRoot(t);
  const { copyFile } = await import('node:fs/promises');
  let fail = 1;
  const logs = [];
  const flaky = async (from, to) => {
    if (fail-- > 0) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    return copyFile(from, to);
  };
  const store = createStore(root, { rng: seeded(11), copyFile: flaky, log: (m) => logs.push(m) });
  const ids = await addPhotos(store, 3);
  await store.startVoting(WEEK);
  await playAll(store, 'me', byList(ids));
  const v = await playAll(store, 'wife', byList(ids));
  assert.equal(v.status, 'finalizing');
  assert.ok(v.result.files.length >= 1);
  assert.equal(logs.length, 1);
  const again = await store.voterState(WEEK, 'me');
  assert.equal(again.status, 'done');
  assert.deepEqual((await readdir(join(root, 'selected'))).sort(), again.result.files.slice().sort());
});

test('minor validation: winner/match ids type-checked; addPhoto cleans up on save failure; corrupt JSON skipped', async (t) => {
  const root = await tempRoot(t);
  const logs = [];
  const store = createStore(root, { rng: seeded(12), log: (m) => logs.push(m) });
  const ids = await addPhotos(store, 2);
  await store.startVoting(WEEK);
  const m = (await store.voterState(WEEK, 'me')).match;
  await assert.rejects(store.pick(WEEK, 'me', m.id, '../x'), (e) => e instanceof StoreError && e.code === 'invalid');
  await assert.rejects(store.pick(WEEK, 'me', 42, ids[0]), (e) => e instanceof StoreError && e.code === 'invalid');
  await assert.rejects(store.undo(WEEK, 'me', {}), (e) => e instanceof StoreError && e.code === 'invalid');
  await assert.rejects(store.jointPick(WEEK, '../x'), (e) => e instanceof StoreError && e.code === 'invalid');

  // Save failure: 'data' is a plain file, so mkdir data/weeks fails after the pool files are written.
  const root2 = await tempRoot(t);
  await writeFile(join(root2, 'data'), 'blocker');
  await assert.rejects(createStore(root2).addPhoto(WEEK, photoInput(1)));
  assert.deepEqual(await readdir(join(root2, 'pool', WEEK)), []);

  await writeFile(join(root, 'data', 'weeks', '2026-W49.json'), '{not json');
  const weeks = await store.listWeeks();
  assert.deepEqual(weeks.map((w) => w.week), [WEEK]);
  assert.equal(await store.findByToken('x'.repeat(32)), null);
  assert.ok(logs.some((l) => l.includes('2026-W49')));
});

async function finishWeek(store, ids) {
  await store.startVoting(WEEK);
  await playAll(store, 'me', byList(ids));
  return playAll(store, 'wife', byList(ids));
}

test('HEIC photo: full.jpg stored, finalize copies it as .jpg; jpeg->.jpg; png keeps ext; originals untouched', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(3) });
  const full = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const heic = { ...photoInput(0, 'heic'), fullJpeg: full };
  const a = (await store.addPhoto(WEEK, heic)).id;
  const b = (await store.addPhoto(WEEK, photoInput(1, 'jpeg'))).id;
  const c = (await store.addPhoto(WEEK, photoInput(2, 'png'))).id;
  assert.ok((await readFile(join(root, 'pool', WEEK, `${a}.full.jpg`))).equals(full));
  const data = JSON.parse(await readFile(join(root, 'data', 'weeks', `${WEEK}.json`), 'utf8'));
  assert.equal(data.photos[0].hasFullJpeg, true);
  assert.equal(data.photos[1].hasFullJpeg, false);
  const v = await finishWeek(store, [a, b, c]);
  assert.equal(v.status, 'done');
  const want = { [a]: ['jpg', full], [b]: ['jpg', photoInput(1).bytes], [c]: ['png', photoInput(2).bytes] };
  assert.equal(v.result.saved.length, 3);
  for (const [i, id] of v.result.saved.entries()) {
    const [ext, expected] = want[id];
    assert.equal(v.result.files[i], `${WEEK}_${i + 1}.${ext}`);
    assert.ok((await readFile(join(root, 'selected', v.result.files[i]))).equals(expected));
  }
  assert.ok((await readFile(join(root, 'pool', WEEK, `${a}.heic`))).equals(photoInput(0).bytes));
});

test('addPhoto: HEIC needs fullJpeg, others reject it, failure cleans full.jpg, remove deletes it', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root);
  await assert.rejects(store.addPhoto(WEEK, photoInput(0, 'heic')), (e) => e.code === 'invalid');
  await assert.rejects(store.addPhoto(WEEK, photoInput(0, 'heif')), (e) => e.code === 'invalid');
  await assert.rejects(store.addPhoto(WEEK, { ...photoInput(0, 'heic'), fullJpeg: Buffer.alloc(0) }), (e) => e.code === 'invalid');
  await assert.rejects(store.addPhoto(WEEK, { ...photoInput(0, 'jpg'), fullJpeg: Buffer.from('x') }), (e) => e.code === 'invalid');
  const id = (await store.addPhoto(WEEK, { ...photoInput(1, 'heif'), fullJpeg: Buffer.from('jpg') })).id;
  const dir = join(root, 'pool', WEEK);
  assert.equal((await readdir(dir)).length, 3);
  await store.removePhoto(WEEK, id);
  assert.deepEqual(await readdir(dir), []);
});

test('finalize resume: old-format record (no src) still copies the original; recorded src is reused', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root, { rng: seeded(9) });
  const ids = await addPhotos(store, 2);
  await finishWeek(store, ids);
  const jsonPath = join(root, 'data', 'weeks', `${WEEK}.json`);
  const data = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.ok(data.final.files.every((f) => typeof f.src === 'string'));
  for (const f of data.final.files) delete f.src; // old record format
  data.status = 'finalizing';
  await writeFile(jsonPath, JSON.stringify(data));
  const sel = join(root, 'selected');
  const name = data.final.files[0].name;
  await unlink(join(sel, name));
  const store2 = createStore(root);
  await store2.resumeFinalize();
  const src = photoInput(ids.indexOf(data.final.files[0].id)).bytes;
  assert.ok((await readFile(join(sel, name))).equals(src));
  assert.equal(JSON.parse(await readFile(jsonPath, 'utf8')).status, 'done');
});

test('addPhoto with fullJpeg removes full.jpg too when saving the week fails', async (t) => {
  const root = await tempRoot(t);
  const store = createStore(root);
  await writeFile(join(root, 'data'), 'blocker'); // mkdir data/weeks fails after pool files are written
  await assert.rejects(store.addPhoto(WEEK, { ...photoInput(0, 'heic'), fullJpeg: Buffer.from('j') }));
  assert.deepEqual(await readdir(join(root, 'pool', WEEK)), []);
});
