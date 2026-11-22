import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDay, combineScore, hamming, laplacianVariance } from '../public/analyze.js';

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

test('a canvas read failure leaves later photos and progress intact', { timeout: 1000 }, async (t) => {
  const canvases = [];
  const globals = {
    document: {
      hidden: false,
      createElement(tag) {
        if (tag !== 'canvas') throw new Error('Model loading is unavailable in this Node test');
        const canvas = {
          getContext() {
            return {
              canvas,
              drawImage(image) {
                canvas.image = image;
              },
              getImageData(_x, _y, width, height) {
                if (canvas.image.failRead) throw new Error('Canvas read failed');
                return { data: new Uint8ClampedArray(width * height * 4).fill(128) };
              },
            };
          },
        };
        canvases.push(canvas);
        return canvas;
      },
    },
    async createImageBitmap(file) {
      return { width: 8, height: 8, failRead: file === broken, close() {} };
    },
    // The tab becomes hidden after the frame is requested.
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }

  const broken = new File(['broken'], 'broken.jpg');
  const valid = new File(['valid'], 'valid.jpg');
  const progress = [];
  const result = await analyzeDay([broken, valid], {
    onProgress: (update) => progress.push(update),
  });

  assert.deepEqual(result.excluded, [{ file: broken, score: null, reason: 'unsupported' }]);
  assert.deepEqual(result.kept.map(({ file }) => file), [valid]);
  assert.deepEqual(progress, [{ done: 1, total: 2 }, { done: 2, total: 2 }]);
  assert.deepEqual(canvases.slice(0, 2).map(({ width }) => width), [0, 0]);
});
