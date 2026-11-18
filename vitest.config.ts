import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));
// smaltdb, for the compiler to its plans (ADR 0033 step 8 in smaltdb): its source in the packed build that
// scripts/fetch-packed.mjs installs (packed.json), as smaltql's tests run it.
const db = (p: string) => fileURLToPath(new URL(`./node_modules/smaltdb/src/${p}`, import.meta.url));
const dbPackage = db('../package.json');
const dbVersion = existsSync(dbPackage) ? (JSON.parse(readFileSync(dbPackage, 'utf8')) as { version: string }).version : '0.0.0';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^smaltdb\/engine$/, replacement: db('engine/index.ts') },
      { find: /^smaltdb-src\/(.*)\.js$/, replacement: db('$1.ts') },
      { find: /^@smaltworks\/smaltcy$/, replacement: src('index.ts') },
      { find: /^@smaltworks\/smaltcy\/worker-runtime$/, replacement: src('worker/runtime.ts') },
      { find: /^@smaltworks\/smaltcy\/(engine|plan|cypher|render|datasets|functions|store|history|timeline|client)$/, replacement: src('$1/index.ts') },
    ],
  },
  define: { __SMALTDB_VERSION__: JSON.stringify(dbVersion) },
  server: { deps: { inline: [/node_modules\/smaltdb\//] } },
  test: {
    include: ['test/**/*.test.ts'],
    // The tests share no state between files (each builds its own graphs), so one worker runs them all: about three
    // times faster than a fresh worker per file.
    isolate: false,
  },
});
