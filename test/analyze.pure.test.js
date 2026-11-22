import assert from 'node:assert/strict';
import test from 'node:test';
import { combineScore, hamming, laplacianVariance } from '../public/analyze.js';

test('hamming counts differing bits across a 64-bit hash', () => {
  assert.equal(hamming(0n, 0b1011n), 3);
  assert.equal(hamming(1n << 63n, 1n), 2);
  assert.equal(hamming(0b1011n, 0b1011n), 0);
});

test('Laplacian variance is zero for a solid image', () => {
  const gray = new Uint8ClampedArray(16).fill(128);
  assert.equal(laplacianVariance(gray, 4, 4), 0);
});

test('Laplacian variance detects alternating light and dark pixels', () => {
  const gray = Uint8ClampedArray.of(
    0, 255, 0, 255,
    255, 0, 255, 0,
    0, 255, 0, 255,
    255, 0, 255, 0,
  );
  assert.ok(laplacianVariance(gray, 4, 4) > 0);
});

test('missing face scores leave sharpness and exposure at full relative weight', () => {
  assert.equal(combineScore({ sharp: 1, exposure: 1 }), 1);
  assert.equal(combineScore({ sharp: 1, exposure: 1, eyes: 1, smile: 1 }), 1);
  assert.equal(combineScore({ sharp: 0.5, exposure: 0.5 }), 0.5);
});

test('eyes and smile together account for at most 30 percent of the score', () => {
  const baseline = combineScore({ sharp: 0, exposure: 0, eyes: 0, smile: 0 });
  const bestFace = combineScore({ sharp: 0, exposure: 0, eyes: 1, smile: 1 });
  assert.ok(bestFace > baseline);
  assert.ok(bestFace - baseline <= 0.3);
});
