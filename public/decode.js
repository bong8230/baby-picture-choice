// Image decoding for analysis and thumbnails. HEIC (which Chrome Android cannot decode)
// goes through a vendored libheif WASM build; everything else uses createImageBitmap.
const HEIC_EXT = /\.(heic|heif)$/i;
const HEIC_TYPE = /^image\/(heic|heif)$/i;
const FULL_JPEG_QUALITY = 0.95;

// libheif is loaded lazily, only from the local vendor folder (no CDN).
const LIBHEIF_URL = new URL('./vendor/libheif/libheif-bundle.mjs', import.meta.url);
let libheifPromise;

export function isHeic(file) {
  return HEIC_TYPE.test(file?.type ?? '') || HEIC_EXT.test(file?.name ?? '');
}

function getLibheif() {
  libheifPromise ??= import(LIBHEIF_URL.href)
    .then((module) => module.default())
    .catch((error) => {
      libheifPromise = undefined;
      throw error;
    });
  return libheifPromise;
}

// Decode the primary image to RGBA. libheif applies irot/imir/clap by default, and
// width/height are the post-transform size. Returns { width, height, data }.
export async function decodeHeicPixels(file) {
  const libheif = await getLibheif();
  let bytes = new Uint8Array(await file.arrayBuffer());
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(bytes);
  bytes = null;
  const image = images?.[0];
  if (!image) throw new Error('HEIC 이미지를 해석할 수 없습니다.');
  try {
    const width = image.get_width();
    const height = image.get_height();
    const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
    const filled = await new Promise((resolve) => image.display(target, resolve));
    if (!filled) throw new Error('HEIC 디코딩에 실패했습니다.');
    return { width, height, data: target.data };
  } finally {
    for (const item of images) item.free?.();
    decoder.free?.();
  }
}

// Returns { width, height, draw(ctx, dw, dh), close() } so callers can draw at any size
// and then release it. The wrapped source is an ImageBitmap in both cases.
export async function decodeToBitmap(file, opts = {}) {
  let bitmap;
  if (isHeic(file)) {
    let pixels = await decodeHeicPixels(file);
    try {
      bitmap = await createImageBitmap(new ImageData(pixels.data, pixels.width, pixels.height));
    } finally {
      pixels = null;
    }
  } else {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', ...opts });
  }
  return {
    width: bitmap.width,
    height: bitmap.height,
    draw: (context, dw, dh) => context.drawImage(bitmap, 0, 0, dw, dh),
    close: () => bitmap.close(),
  };
}

// Full-resolution JPEG for HEIC files; null for anything else.
export async function toFullJpeg(file) {
  if (!isHeic(file)) return null;
  const pixels = await decodeHeicPixels(file);
  const canvas = document.createElement('canvas');
  try {
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const context = canvas.getContext('2d', { alpha: false });
    context.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('JPG로 변환할 수 없습니다.'));
      }, 'image/jpeg', FULL_JPEG_QUALITY);
    });
  } finally {
    canvas.width = 0;
  }
}
