// Draws the app icon (public/icons/icon.svg: a road running into mountains on a blue-teal square) as PNGs for the
// install manifest, without any image library: a tiny rasterizer with anti-aliasing and Node's zlib for the PNG.
// Usage: node tools/build-icons.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const lines = [
  { pts: [[4, 19.5], [10.5, 11.5], [15, 17], [18.5, 12.5], [28, 19.5]], width: 2, alpha: 1 },
  { pts: [[13.5, 28.5], [15.5, 22]], width: 2, alpha: 0.85 },
  { pts: [[18.5, 28.5], [16.5, 22]], width: 2, alpha: 0.85 },
];
const A = [0x0a, 0x84, 0xff];
const B = [0x30, 0xd1, 0xc6];

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// coverage of a rounded square (0..32, radius r) at a point, with a one-pixel soft edge
function roundRect(x, y, r, px) {
  const cx = Math.min(Math.max(x, r), 32 - r);
  const cy = Math.min(Math.max(y, r), 32 - r);
  const d = Math.hypot(x - cx, y - cy) - r;
  return Math.max(0, Math.min(1, 0.5 - d / px));
}

function draw(size, rounded) {
  const px = 32 / size; // one pixel in icon units
  const rgba = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * px;
      const y = (j + 0.5) * px;
      const t = (x + y) / 64;
      let c = A.map((a, k) => a + (B[k] - a) * t);
      for (const l of lines) {
        let d = Infinity;
        for (let k = 0; k < l.pts.length - 1; k++) d = Math.min(d, segDist(x, y, l.pts[k], l.pts[k + 1]));
        const cov = Math.max(0, Math.min(1, (l.width / 2 - d) / px + 0.5)) * l.alpha;
        c = c.map((v) => v + (255 - v) * cov);
      }
      const a = rounded ? roundRect(x, y, 7, px) : 1;
      const o = (j * size + i) * 4;
      rgba[o] = Math.round(c[0]);
      rgba[o + 1] = Math.round(c[1]);
      rgba[o + 2] = Math.round(c[2]);
      rgba[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, rgba);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let j = 0; j < size; j++) rgba.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = new URL("../public/icons/", import.meta.url);
fs.writeFileSync(new URL("icon-192.png", dir), draw(192, true));
fs.writeFileSync(new URL("icon-512.png", dir), draw(512, true));
// maskable: full bleed, the launcher crops it to its own shape
fs.writeFileSync(new URL("icon-maskable-512.png", dir), draw(512, false));
console.log("wrote icon-192.png, icon-512.png, icon-maskable-512.png");
