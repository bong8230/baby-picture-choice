import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeHeicPixels, decodeToBitmap, isHeic, toFullJpeg } from '../public/decode.js';

test('isHeic matches extension (any case) and mime type', () => {
  assert.equal(isHeic({ name: 'a.HEIC', type: '' }), true);
  assert.equal(isHeic({ name: 'b.heif', type: '' }), true);
  assert.equal(isHeic({ name: 'x', type: 'image/heic' }), true);
  assert.equal(isHeic({ name: 'x', type: 'IMAGE/HEIF' }), true);
  assert.equal(isHeic({ name: 'c.jpg', type: 'image/jpeg' }), false);
  assert.equal(isHeic({}), false);
});

test('libheif loads only from a local path relative to import.meta.url', async () => {
  const source = await readFile(new URL('../public/decode.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /https?:\/\//);
  assert.match(source, /import\.meta\.url/);
});

test('toFullJpeg returns null for non-HEIC without decoding', async () => {
  assert.equal(await toFullJpeg({ name: 'c.jpg', type: 'image/jpeg' }), null);
});

test('decodeToBitmap rejects for a non-decodable HEIC', async () => {
  const bad = new Blob([new Uint8Array(32)], { type: 'image/heic' });
  await assert.rejects(decodeToBitmap(bad));
});

test('decodes a real HEIC fixture to RGBA pixels with correct size and colors', async () => {
  const bytes = await readFile(new URL('./fixtures/tiny.heic', import.meta.url));
  const blob = new Blob([bytes], { type: 'image/heic' });
  const { width, height, data } = await decodeHeicPixels(blob);
  assert.equal(width, 64);
  assert.equal(height, 32);
  assert.equal(data.length, 64 * 32 * 4);
  const px = (x, y) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 3));
  assert.ok(px(8, 16)[0] > 200 && px(8, 16)[2] < 60, 'left half red');
  assert.ok(px(56, 16)[2] > 200 && px(56, 16)[0] < 60, 'right half blue');
});
