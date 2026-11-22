const MAX_IMAGE_SIDE = 512;
const HASH_SIZE = 8;
const DUPLICATE_DISTANCE = 5;
const BLUR_MEDIAN_RATIO = 0.2;
const FRAME_WAIT_TIMEOUT_MS = 50;
const SCORE_WEIGHTS = { sharp: 55, exposure: 25, eyes: 14, smile: 6 };

const VENDOR_URL = new URL('./vendor/mediapipe/', import.meta.url);
let modelPromise;

async function createFaceLandmarker() {
  const { FaceLandmarker, FilesetResolver } = await import(
    './vendor/mediapipe/vision_bundle.mjs'
  );
  const fileset = await FilesetResolver.forVisionTasks(new URL('wasm', VENDOR_URL).href);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: new URL('face_landmarker.task', VENDOR_URL).href,
      delegate: 'CPU',
    },
    runningMode: 'IMAGE',
    numFaces: 5,
    outputFaceBlendshapes: true,
  });
}

function getFaceLandmarker() {
  modelPromise ??= createFaceLandmarker().catch((error) => {
    modelPromise = undefined;
    throw error;
  });
  return modelPromise;
}

export async function preloadModels() {
  await getFaceLandmarker();
}

export function hamming(a, b) {
  let remaining = a ^ b;
  let count = 0;
  while (remaining !== 0n) {
    remaining &= remaining - 1n;
    count += 1;
  }
  return count;
}

export function laplacianVariance(gray, width, height) {
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let squaredSum = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const value = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1]
        - 4 * gray[i];
      sum += value;
      squaredSum += value * value;
    }
  }

  const count = (width - 2) * (height - 2);
  return Math.max(0, squaredSum / count - (sum / count) ** 2);
}

export function combineScore(parts) {
  let score = 0;
  let totalWeight = 0;
  for (const [name, weight] of Object.entries(SCORE_WEIGHTS)) {
    if (parts[name] === undefined) continue;
    score += parts[name] * weight;
    totalWeight += weight;
  }
  return score / totalWeight;
}

function luminance(pixels, i) {
  return (77 * pixels[i] + 150 * pixels[i + 1] + 29 * pixels[i + 2]) >> 8;
}

function readImageMetrics(pixels, width, height) {
  const gray = new Uint8ClampedArray(width * height);
  let lightSum = 0;
  let clipped = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const light = luminance(pixels, i * 4);
    gray[i] = light;
    lightSum += light;
    if (light <= 5 || light >= 250) clipped += 1;
  }

  const mean = lightSum / gray.length / 255;
  const brightness = 1 - Math.abs(2 * mean - 1);
  return {
    sharpness: laplacianVariance(gray, width, height),
    exposure: 0.6 * brightness + 0.4 * (1 - clipped / gray.length),
  };
}

function differenceHash(context, image) {
  const width = HASH_SIZE + 1;
  context.drawImage(image, 0, 0, width, HASH_SIZE);
  const { data } = context.getImageData(0, 0, width, HASH_SIZE);
  let hash = 0n;
  for (let y = 0; y < HASH_SIZE; y += 1) {
    for (let x = 0; x < HASH_SIZE; x += 1) {
      const i = (y * width + x) * 4;
      hash <<= 1n;
      if (luminance(data, i) > luminance(data, i + 4)) hash |= 1n;
    }
  }
  return hash;
}

function readFaceScores({ faceBlendshapes }) {
  if (!faceBlendshapes.length) return {};

  let eyes = 1;
  let smile = 0;
  for (const { categories } of faceBlendshapes) {
    const scores = new Map(categories.map(({ categoryName, score }) => [categoryName, score]));
    const blink = Math.max(scores.get('eyeBlinkLeft') ?? 0, scores.get('eyeBlinkRight') ?? 0);
    const faceSmile = ((scores.get('mouthSmileLeft') ?? 0) + (scores.get('mouthSmileRight') ?? 0)) / 2;
    eyes = Math.min(eyes, 1 - blink);
    smile = Math.max(smile, faceSmile);
  }
  return { eyes, smile };
}

function drawScaledImage(context, bitmap) {
  const { canvas } = context;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
}

function median(values) {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return (values[Math.floor((values.length - 1) / 2)] + values[middle]) / 2;
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (document.hidden) {
      setTimeout(resolve, 0);
      return;
    }
    const frame = requestAnimationFrame(() => {
      clearTimeout(timeout);
      setTimeout(resolve, 0);
    });
    const timeout = setTimeout(() => {
      cancelAnimationFrame(frame);
      resolve();
    }, FRAME_WAIT_TIMEOUT_MS);
  });
}

function rankPhotos(photos, excluded) {
  if (!photos.length) return [];

  const reference = median(photos.map(({ sharpness }) => sharpness));
  for (const photo of photos) {
    const { sharpness, exposure, eyes, smile } = photo;
    const sharp = sharpness === 0 ? 0 : sharpness / (sharpness + reference);
    photo.score = combineScore({ sharp, exposure, eyes, smile });
    photo.reasons = [`sharp: ${sharp.toFixed(3)}`, `exposure: ${exposure.toFixed(3)}`];
    if (eyes !== undefined) photo.reasons.push(`eyes: ${eyes.toFixed(3)}`);
    if (smile !== undefined) photo.reasons.push(`smile: ${smile.toFixed(3)}`);
  }

  photos.sort((a, b) => b.score - a.score);
  const representatives = [];
  for (const { file, score, reasons, sharpness, hash } of photos) {
    if (sharpness < reference * BLUR_MEDIAN_RATIO) {
      excluded.push({ file, score, reason: 'blur' });
      continue;
    }

    // Compare against kept photos so an indirect match cannot point at an excluded one.
    const duplicate = representatives.find((photo) => hamming(hash, photo.hash) <= DUPLICATE_DISTANCE);
    if (duplicate) {
      excluded.push({ file, score, reason: 'duplicate', duplicateOf: duplicate.file });
    } else {
      representatives.push({ file, score, reasons, hash });
    }
  }
  return representatives.map(({ file, score, reasons }) => ({ file, score, reasons }));
}

export async function analyzeDay(files, { onProgress } = {}) {
  const photos = [];
  const excluded = [];
  const warnings = new Set();
  const total = files.length;
  if (!total) return { kept: [], excluded, warnings: [] };

  const canvas = document.createElement('canvas');
  const hashCanvas = document.createElement('canvas');
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    hashCanvas.width = HASH_SIZE + 1;
    hashCanvas.height = HASH_SIZE;
    const hashContext = hashCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    let landmarker;
    try {
      landmarker = await getFaceLandmarker();
    } catch (e) {
      console.warn('[analyze]', 'face model', e);
      warnings.add('face-model-unavailable');
    }

    for (let index = 0; index < total; index += 1) {
      const file = files[index];
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        try {
          drawScaledImage(context, bitmap);
        } finally {
          bitmap.close();
        }
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const metrics = readImageMetrics(data, canvas.width, canvas.height);
        let face = {};
        if (landmarker) {
          try {
            face = readFaceScores(landmarker.detect(canvas));
          } catch (e) {
            console.warn('[analyze]', file?.name, e);
            warnings.add('face-inference-failed');
          }
        }
        photos.push({ file, ...metrics, ...face, hash: differenceHash(hashContext, canvas) });
      } catch (e) {
        console.warn('[analyze]', file?.name, e);
        excluded.push({ file, score: null, reason: 'unsupported' });
      }
      onProgress?.({ done: index + 1, total });
      if (index + 1 < total) await yieldToBrowser();
    }
  } finally {
    canvas.width = 0;
    hashCanvas.width = 0;
  }

  const kept = rankPhotos(photos, excluded);
  return { kept, excluded, warnings: [...warnings] };
}
