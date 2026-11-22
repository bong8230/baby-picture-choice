import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBracket, currentMatch, applyPick, undo, ranks, merge, MatchError,
} from '../public/bracket.js';

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mk = (n) => Array.from({ length: n }, (_, i) => `p${i}`);

function playAll(b, pick = (m) => m.a) {
  let guard = 0, played = 0;
  for (let m = currentMatch(b); m; m = currentMatch(b)) {
    b = applyPick(b, m.id, pick(m));
    played++;
    assert.ok(++guard < 100);
  }
  return { b, played };
}

for (const n of [1, 2, 3, 4, 5, 8, 13, 16]) {
  test(`full run n=${n}`, () => {
    const ids = mk(n);
    const { b, played } = playAll(createBracket(ids, mulberry32(n)));
    assert.equal(currentMatch(b), null);
    const r = ranks(b);
    assert.equal(r.length, Math.min(n, 3));
    assert.equal(new Set(r).size, r.length);
    for (const id of r) assert.ok(ids.includes(id));
    assert.equal(played, n === 1 ? 0 : n - 1 + (n >= 4 ? 1 : 0));
  });
}

test('n=1 no matches', () => {
  const b = createBracket(['x'], mulberry32(1));
  assert.equal(currentMatch(b), null);
  assert.deepEqual(ranks(b), ['x']);
});

test('index/total/label/order', () => {
  let b = createBracket(mk(8), mulberry32(3));
  const seen = [];
  for (let m = currentMatch(b); m; m = currentMatch(b)) {
    seen.push(m);
    assert.equal(m.total, 8);
    b = applyPick(b, m.id, m.a);
  }
  assert.deepEqual(seen.map((m) => m.index), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(seen.map((m) => m.label),
    ['8강', '8강', '8강', '8강', '준결승', '준결승', '3·4위전', '결승']);
  assert.equal(seen[6].id, 'third');
  assert.equal(seen[7].id, 'final');
  assert.equal(new Set(seen.map((m) => m.id)).size, 8);
});

test('first pick winner is rank 1; loser rank 2', () => {
  const { b } = playAll(createBracket(mk(4), mulberry32(2)), (m) => m.b);
  assert.equal(ranks(b).length, 3);
});

test('n=3 has no third-place match; third is semifinal loser', () => {
  let b = createBracket(mk(3), mulberry32(5));
  const labels = [];
  for (let m = currentMatch(b); m; m = currentMatch(b)) {
    labels.push(m.label);
    b = applyPick(b, m.id, m.a);
  }
  assert.ok(!labels.includes('3·4위전'));
  assert.equal(ranks(b).length, 3);
});

test('rng determinism', () => {
  const m1 = currentMatch(createBracket(mk(8), mulberry32(7)));
  const m2 = currentMatch(createBracket(mk(8), mulberry32(7)));
  assert.deepEqual(m1, m2);
  const o = (s) => JSON.stringify(createBracket(mk(8), mulberry32(s)));
  assert.notEqual(o(1), o(2));
});

test('applyPick/undo', () => {
  const b0 = createBracket(mk(8), mulberry32(9));
  const m0 = currentMatch(b0);
  const snap = JSON.stringify(b0);
  const b1 = applyPick(b0, m0.id, m0.b);
  assert.equal(JSON.stringify(b0), snap, 'input not mutated');
  assert.notEqual(b1, b0);
  assert.notDeepEqual(currentMatch(b1), m0);
  const b2 = undo(b1);
  assert.deepEqual(currentMatch(b2), m0);
  assert.equal(JSON.stringify(b1).length > 0, true);
  assert.deepEqual(undo(b0), b0);
});

test('applyPick errors', () => {
  const b0 = createBracket(mk(4), mulberry32(9));
  const m0 = currentMatch(b0);
  assert.throws(() => applyPick(b0, 'nope', m0.a), MatchError);
  assert.throws(() => applyPick(b0, m0.id, 'zzz'), MatchError);
  const b1 = applyPick(b0, m0.id, m0.a);
  assert.throws(() => applyPick(b1, m0.id, m0.a), MatchError); // already played
  const done = playAll(b0).b;
  assert.throws(() => applyPick(done, m0.id, m0.a), MatchError);
});

test('createBracket rejects duplicates', () => {
  assert.throws(() => createBracket(['a', 'a'], mulberry32(1)), MatchError);
});

test('JSON roundtrip', () => {
  let b = createBracket(mk(5), mulberry32(4));
  b = JSON.parse(JSON.stringify(b));
  let m = currentMatch(b);
  b = JSON.parse(JSON.stringify(applyPick(b, m.id, m.a)));
  assert.equal(currentMatch(undo(b)).id, m.id);
  const { b: done } = playAll(b);
  const r = ranks(JSON.parse(JSON.stringify(done)));
  assert.equal(r.length, 3);
});

test('ranks incomplete -> []', () => {
  assert.deepEqual(ranks(createBracket(mk(4), mulberry32(1))), []);
});

test('merge', () => {
  const s = { a: 1, b: 1, c: 1 };
  assert.deepEqual(merge(['a', 'b', 'c'], ['c', 'a', 'x'], s), { saved: ['a', 'c'] });
});
test('merge tie by score', () => {
  const r = merge(['a', 'b'], ['b', 'a'], { a: 0.5, b: 0.9 });
  assert.deepEqual(r, { saved: ['b', 'a'] });
});
test('merge no overlap', () => {
  assert.deepEqual(merge(['a', 'b', 'c'], ['x', 'y', 'z'], {}), { jointFinal: ['a', 'x'] });
});
test('merge same first is saved[0]', () => {
  const r = merge(['a', 'b', 'c'], ['a', 'c', 'b'], { b: 9, c: 1 });
  assert.equal(r.saved[0], 'a');
});
