import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writePng(path, size) {
  const scale = 4;
  const radius = size * 0.22;
  const center = size / 2;
  const ringOuter = size * 0.32;
  const ringInner = size * 0.19;

  const insideRoundedRect = (x, y) => {
    if (x < 0 || y < 0 || x > size || y > size) return false;
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      let inside = 0;
      let ring = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const px = x + (sx + 0.5) / scale;
          const py = y + (sy + 0.5) / scale;
          if (!insideRoundedRect(px, py)) continue;
          inside += 1;
          const distance = Math.hypot(px - center, py - center);
          if (distance <= ringOuter && distance >= ringInner) ring += 1;
        }
      }
      const total = scale * scale;
      const alpha = Math.round((inside / total) * 255);
      const ringShare = inside > 0 ? ring / inside : 0;
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      // Blue tile with a white ring: readable at 16 px in both themes.
      raw[offset] = Math.round(0 * (1 - ringShare) + 255 * ringShare);
      raw[offset + 1] = Math.round(91 * (1 - ringShare) + 255 * ringShare);
      raw[offset + 2] = Math.round(255 * (1 - ringShare) + 255 * ringShare);
      raw[offset + 3] = alpha;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  return png.length;
}

export const ICON_SIZES = [16, 32, 48, 128];

export function writeIconSet(directory, sizes = ICON_SIZES) {
  mkdirSync(directory, { recursive: true });
  const written = [];
  for (const size of sizes) {
    const path = join(directory, `icon-${size}.png`);
    const bytes = writePng(path, size);
    written.push({ path, size, bytes });
  }
  return written;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const output = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'icons');
  for (const item of writeIconSet(output)) {
    console.log(`icon ${item.size}x${item.size}: ${item.path} (${item.bytes} bytes)`);
  }
}
