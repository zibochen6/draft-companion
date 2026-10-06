import { build, context } from 'esbuild';
import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const license = await readFile(new URL('./LICENSE', import.meta.url), 'utf8');
const notices = await readFile(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
const options = {
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs',
  target: 'es2021', outfile: 'main.js', external: ['obsidian', 'electron', ...builtinModules, ...builtinModules.map(m => `node:${m}`)],
  sourcemap: false, minify: process.argv.includes('production'),
  banner: { js: `/* Draft Companion ${manifest.version} — generated runtime\n${license}\n${notices.replaceAll('*/', '* /')}\n*/` }
};
if (process.argv.includes('production')) await build(options);
else { const ctx = await context(options); await ctx.watch(); }
