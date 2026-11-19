// Bundles bench/smaltdb.ts with esbuild and runs it in Node, with smaltdb from the build packed.json pins
// (node_modules/smaltdb, installed by `npm run deps`).
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('node_modules/smaltdb/package.json', 'utf8')).version;
await esbuild.build({
  entryPoints: [process.env.BENCH_ENTRY ?? 'bench/smaltdb.ts'],
  outfile: '.cache/bench-smaltdb.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
  alias: { 'smaltdb-src': './node_modules/smaltdb/src' },
  define: { __SMALTDB_VERSION__: JSON.stringify(version) },
});
execFileSync(process.execPath, ['.cache/bench-smaltdb.mjs'], { stdio: 'inherit' });
