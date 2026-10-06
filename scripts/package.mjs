import { readFile, writeFile, mkdir, lstat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const whitelist = ['main.js', 'manifest.json', 'styles.css'];
const files = [];
for (const name of whitelist) {
  const source = join(root, name);
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Packaging requires a regular local ${name}.`);
  const content = await readFile(source);
  if (!content.length) throw new Error(`Refusing to package an empty ${name}.`);
  files.push({ name, content });
}
const manifest = JSON.parse(files.find(file => file.name === 'manifest.json').content.toString('utf8'));
if (manifest.id !== 'draft-companion' || !/^\d+\.\d+\.\d+(?:-[a-z\d.-]+)?$/i.test(manifest.version)) {
  throw new Error('Unexpected plugin ID or unsafe version string.');
}
const dist = join(root, 'dist');
const canonicalDirectory = join(dist, manifest.id);
const versionDirectory = join(dist, `${manifest.id}-${manifest.version}`);
const pluginDirectory = join(versionDirectory, manifest.id);
const zipPath = join(dist, `${manifest.id}-${manifest.version}.zip`);
for (const directory of [dist, canonicalDirectory, versionDirectory]) {
  try { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Packaging output must be a local directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
try { const stat = await lstat(zipPath); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Packaging output must be a regular ZIP file.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dist, { recursive: true });
await rm(canonicalDirectory, { recursive: true, force: true });
await rm(versionDirectory, { recursive: true, force: true });
await mkdir(canonicalDirectory, { recursive: true });
await mkdir(pluginDirectory, { recursive: true });
for (const { name, content } of files) {
  await writeFile(join(canonicalDirectory, name), content);
  await writeFile(join(pluginDirectory, name), content);
}

// A dependency-free stored ZIP: exactly the allowlisted runtime files, no directory scan.
const table = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = content => {
  let crc = 0xffffffff;
  for (const byte of content) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const localParts = [];
const centralParts = [];
let offset = 0;
for (const { name, content } of files) {
  const filename = Buffer.from(`${manifest.id}/${name}`, 'utf8');
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26);
  localParts.push(local, filename, content);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
  centralParts.push(central, filename);
  offset += local.length + filename.length + content.length;
}
const central = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...localParts, central, end]);
await writeFile(zipPath, archive);
console.log(`Package: ${zipPath}`);
console.log(`Install folder: ${canonicalDirectory}`);
console.log(`Version folder: ${pluginDirectory}`);
console.log(`Allowlist: ${whitelist.join(', ')}; no data.json, test requests, source maps or credentials are included.`);
console.log(`SHA256: ${createHash('sha256').update(archive).digest('hex')}`);
