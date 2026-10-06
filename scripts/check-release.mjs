import { readFile, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeFiles = ['main.js', 'manifest.json', 'styles.css'];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function regularFile(path) {
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Release inputs must be regular local files.');
  const content = await readFile(path);
  assert(content.length > 0, 'Release inputs cannot be empty.');
  return content;
}

async function localDirectory(path) {
  const stat = await lstat(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Release output must be a local directory.');
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Inspect only the named archive, with no extraction or Vault traversal.
function verifyArchive(archive, id, expected) {
  assert(archive.length >= 22, 'Invalid ZIP archive.');
  const end = archive.length - 22;
  assert(archive.readUInt32LE(end) === 0x06054b50, 'Expected a ZIP without trailing data or a comment.');
  assert(archive.readUInt16LE(end + 4) === 0 && archive.readUInt16LE(end + 6) === 0, 'Multi-disk ZIP is unsupported.');
  const count = archive.readUInt16LE(end + 10);
  assert(count === runtimeFiles.length && archive.readUInt16LE(end + 8) === count, 'ZIP must contain exactly three runtime files.');
  assert(archive.readUInt16LE(end + 20) === 0, 'Unexpected ZIP comment.');
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  assert(centralOffset + centralSize === end, 'Invalid ZIP central-directory bounds.');
  let position = centralOffset;
  let localEnd = 0;
  const found = new Set();
  for (let index = 0; index < count; index++) {
    assert(position + 46 <= end && archive.readUInt32LE(position) === 0x02014b50, 'Invalid ZIP entry.');
    const flags = archive.readUInt16LE(position + 8);
    const method = archive.readUInt16LE(position + 10);
    const crc = archive.readUInt32LE(position + 16);
    const compressedSize = archive.readUInt32LE(position + 20);
    const size = archive.readUInt32LE(position + 24);
    const nameLength = archive.readUInt16LE(position + 28);
    const extraLength = archive.readUInt16LE(position + 30);
    const commentLength = archive.readUInt16LE(position + 32);
    const localOffset = archive.readUInt32LE(position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    assert(next <= end && flags === 0x0800 && (method === 0 || method === 8), 'Unexpected ZIP format.');
    const nameBytes = archive.subarray(position + 46, position + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    const filename = name.slice(id.length + 1);
    assert(name === `${id}/${filename}` && runtimeFiles.includes(filename) && !found.has(filename), 'ZIP contains unexpected or duplicate files.');
    assert(size === expected.get(filename).length, 'ZIP runtime size differs from the build.');
    assert(localOffset === localEnd && localOffset + 30 <= centralOffset && archive.readUInt32LE(localOffset) === 0x04034b50, 'Invalid ZIP local entry.');
    assert(archive.readUInt16LE(localOffset + 6) === flags && archive.readUInt16LE(localOffset + 8) === method, 'ZIP headers disagree.');
    assert(archive.readUInt32LE(localOffset + 14) === crc && archive.readUInt32LE(localOffset + 18) === compressedSize && archive.readUInt32LE(localOffset + 22) === size, 'ZIP sizes or checksums disagree.');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    assert(localNameLength === nameLength && archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes), 'ZIP filenames disagree.');
    const contentOffset = localOffset + 30 + localNameLength + localExtraLength;
    localEnd = contentOffset + compressedSize;
    assert(localEnd <= centralOffset, 'ZIP data exceeds local-entry bounds.');
    const packed = archive.subarray(contentOffset, localEnd);
    const content = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: size });
    assert(content.length === size && crc32(content) === crc && content.equals(expected.get(filename)), 'ZIP runtime content differs from the build.');
    found.add(filename);
    position = next;
  }
  assert(position === end && localEnd === centralOffset, 'ZIP contains unaccounted entries or bytes.');
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 2 && args[0] === '--tag'), 'Usage: node scripts/check-release.mjs [--tag 0.1.0]');
  const manifest = JSON.parse(await regularFile(join(root, 'manifest.json')));
  const pkg = JSON.parse(await regularFile(join(root, 'package.json')));
  const lock = JSON.parse(await regularFile(join(root, 'package-lock.json')));
  const versions = JSON.parse(await regularFile(join(root, 'versions.json')));
  assert(manifest.id === 'draft-companion' && pkg.name === manifest.id, 'Plugin and package IDs must agree.');
  assert(stableVersion.test(manifest.version) && stableVersion.test(manifest.minAppVersion), 'Obsidian releases require stable x.y.z versions.');
  assert(pkg.version === manifest.version && lock.version === manifest.version && lock.packages?.['']?.version === manifest.version, 'Package, lockfile and manifest versions must agree.');
  assert(manifest.name && manifest.description && manifest.author && manifest.isDesktopOnly === true, 'Missing desktop plugin metadata.');
  assert(versions && typeof versions === 'object' && !Array.isArray(versions), 'versions.json must be a version mapping.');
  for (const [version, minimum] of Object.entries(versions)) assert(stableVersion.test(version) && stableVersion.test(minimum), 'Invalid versions.json entry.');
  assert(versions[manifest.version] === manifest.minAppVersion, 'versions.json must map this release to its minimum Obsidian version.');
  if (args.length) assert(args[1] === manifest.version, 'Release tag must exactly equal manifest.version, without a v prefix.');
  const expected = new Map();
  for (const name of runtimeFiles) expected.set(name, await regularFile(join(root, name)));
  assert(!expected.get('main.js').toString('utf8').includes('sourceMappingURL='), 'Do not distribute source maps.');
  const dist = join(root, 'dist');
  const versionDirectory = join(dist, `${manifest.id}-${manifest.version}`);
  await localDirectory(dist);
  await localDirectory(versionDirectory);
  for (const directory of [join(dist, manifest.id), join(versionDirectory, manifest.id)]) {
    await localDirectory(directory);
    const names = (await readdir(directory)).sort();
    assert(JSON.stringify(names) === JSON.stringify([...runtimeFiles].sort()), 'Install folders must contain exactly three runtime files.');
    for (const name of runtimeFiles) assert((await regularFile(join(directory, name))).equals(expected.get(name)), 'Install folder content differs from the build.');
  }
  const archive = await regularFile(join(dist, `${manifest.id}-${manifest.version}.zip`));
  verifyArchive(archive, manifest.id, expected);
  console.log(`Release verified: ${manifest.id} ${manifest.version}; Obsidian >= ${manifest.minAppVersion}.`);
  console.log(`Assets: ${runtimeFiles.join(', ')}, ${manifest.id}-${manifest.version}.zip`);
  console.log(`ZIP SHA256: ${createHash('sha256').update(archive).digest('hex')}`);
}

main().catch(error => { console.error(`Release check failed: ${error.message}`); process.exitCode = 1; });
