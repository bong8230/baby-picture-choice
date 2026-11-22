import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const framed = Buffer.alloc(12 + data.length);
  framed.writeUInt32BE(data.length);
  name.copy(framed, 4);
  data.copy(framed, 8);
  framed.writeUInt32BE(crc32(data, crc32(name)), 8 + data.length);
  return framed;
}

function cameraColor(x, y) {
  const lens = Math.hypot(x - 0.50, y - 0.53);
  if (lens < 0.085) return [36, 99, 68];
  if (lens < 0.112) return [101, 159, 121];

  const body = x >= 0.23 && x < 0.77 && y >= 0.37 && y < 0.69;
  const finder = x >= 0.37 && x < 0.55 && y >= 0.30 && y < 0.37;
  return body || finder ? [239, 245, 238] : [36, 99, 68];
}

function makePng(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + 3 * size;
  const pixels = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const color = cameraColor(x / size, y / size);
      pixels.set(color, y * stride + 1 + 3 * x);
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../public/icon-${size}.png`, import.meta.url), makePng(size));
}
