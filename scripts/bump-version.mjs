import { readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const newerThan = (next, previous) => {
  const a = next.split('.').map(BigInt);
  const b = previous.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
};

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 1 && stableVersion.test(args[0]), 'Usage: node scripts/bump-version.mjs <next stable x.y.z version>');
  const next = args[0];
  const names = ['package.json', 'package-lock.json', 'manifest.json', 'versions.json'];
  const files = [];
  for (const name of names) {
    const path = join(root, name);
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Version inputs must be regular local files.');
    const before = await readFile(path, 'utf8');
    files.push({ path, before, data: JSON.parse(before) });
  }
  const [pkg, lock, manifest, versions] = files.map(file => file.data);
  assert(manifest.id === 'draft-companion' && pkg.name === manifest.id, 'Plugin and package IDs must agree.');
  assert(stableVersion.test(manifest.version) && stableVersion.test(manifest.minAppVersion), 'Current manifest versions must be stable x.y.z versions.');
  assert(pkg.version === manifest.version && lock.version === manifest.version && lock.packages?.['']?.version === manifest.version, 'Resolve inconsistent versions before preparing a release.');
  assert(versions && typeof versions === 'object' && !Array.isArray(versions) && versions[manifest.version] === manifest.minAppVersion, 'Current versions.json mapping is invalid.');
  for (const [version, minimum] of Object.entries(versions)) assert(stableVersion.test(version) && stableVersion.test(minimum), 'Invalid versions.json entry.');
  assert(newerThan(next, manifest.version), 'Next version must be greater than the current version.');
  assert(!Object.hasOwn(versions, next), 'This version already exists in versions.json.');
  const previous = manifest.version;
  pkg.version = next;
  lock.version = next;
  lock.packages[''].version = next;
  manifest.version = next;
  versions[next] = manifest.minAppVersion;
  const suffix = `.release-temp-${randomUUID()}`;
  const replaced = [];
  try {
    // Prepare all updates before replacing any source file. No commit, tag or push is made.
    for (const file of files) await writeFile(`${file.path}${suffix}`, `${JSON.stringify(file.data, null, 2)}\n`, { flag: 'wx' });
    for (const file of files) {
      await rename(`${file.path}${suffix}`, file.path);
      replaced.push(file);
    }
  } catch (error) {
    for (const file of replaced) await writeFile(file.path, file.before);
    throw error;
  } finally {
    for (const file of files) await rm(`${file.path}${suffix}`, { force: true });
  }
  console.log(`Prepared version ${previous} -> ${next}; minimum Obsidian remains ${manifest.minAppVersion}.`);
  console.log('Run tests, package and check-release, review the changes, then commit and push the matching version tag when ready.');
  console.log('This script does not create a Git tag or publish a release.');
}

main().catch(error => { console.error(`Version update failed: ${error.message}`); process.exitCode = 1; });
