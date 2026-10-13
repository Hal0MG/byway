// Packs the app into a zip for another computer (a Mac, a friend's PC) the way GitHub would have it: everything except
// what .gitignore leaves out (keys, your trips, caches, node_modules). Written by hand, without a zip library, so the
// Mac start files keep their "executable" permission (Windows' own zip tool drops it, and then a double-click won't
// run them) and get Unix line endings.
// Usage: node tools/package.mjs [output.zip]   (default: ../byway-<version>.zip)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = path.basename(root).replace(/^(roadtrip-planner|byway)-?/, "") || "app";
const out = path.resolve(process.argv[2] || path.join(root, "..", `byway-${version}.zip`));
const PREFIX = "byway/";

// .gitignore patterns, plus things that never belong in a package
const ignore = [".git/", "dist/", "*.zip",
  ...fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))];
const toRe = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}${p.endsWith("/") ? "" : "(/|$)"}`);
const ignored = ignore.map(toRe);
const skip = (rel) => ignored.some((re) => re.test(rel) || re.test(`${rel}/`));

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (skip(e.isDirectory() ? `${rel}/` : rel)) continue;
    if (e.isDirectory()) walk(full);
    else files.push(rel);
  }
})(root);

const EXEC = /\.(sh|command)$/;
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
const dosTime = (d) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

const locals = [];
const centrals = [];
let offset = 0;
for (const rel of files.sort()) {
  let data = fs.readFileSync(path.join(root, rel));
  if (EXEC.test(rel)) data = Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"));
  const name = Buffer.from(PREFIX + rel, "utf8");
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const { time, date } = dosTime(fs.statSync(path.join(root, rel)).mtime);
  const mode = EXEC.test(rel) ? 0o100755 : 0o100644;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the permissions below count
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += 30 + name.length + packed.length;
}
const cdSize = centrals.reduce((a, b) => a + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cdSize, 12);
end.writeUInt32LE(offset, 16);
fs.writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`${files.length} files, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB -> ${out}`);
