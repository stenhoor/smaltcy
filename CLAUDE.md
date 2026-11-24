# CLAUDE.md

smaltcy (repository `stenhoor/smaltcy`, npm `@smaltworks/smaltcy`) is a graph database for the browser in TypeScript:
Cypher compiles to graph plans, an engine runs plans on pluggable stores, and a WebGPU graph view draws graphs. It is
part of the smalt family: smaltdb's CLAUDE.md has the family's shared working rules, and they apply here too.

## Brand: read smalt-brand first

Before changing the site, the README or how the product is described, read smalt-brand's `BRAND.md` and
`DECISIONS.md`. Copy the site theme (`docs/.vitepress/theme/{shiki.ts,smaltdb.css,smaltworks.ts,stage.ts,playground.ts,agents.ts}`) and the
badges unchanged from the family. smaltcy's brand is set (smalt-brand's DECISIONS.md, "smaltcy", 2026-11-14): a
language, in the language layer's magenta (the hero's `suffix language`), said "smalt-sigh", with the **Graph** mark.
The logo files in `docs/public/` come from smalt-brand's `logos/smaltcy/`, unchanged; a change starts there.

## Workflow

The family's rules: one task per branch and pull request; open it once CI passes; the owner merges. Before pushing,
`npm run check` and `npm run test:quick`. (smaltcy started in `apbeers/smalt-graph-db`, where work went straight to
`main`; that ended with the move here, 2026-11-13.) CI runs on pull requests and on pushes to `main`, and can be run by
hand on a branch (Actions → CI → Run workflow; tick `full` for the full browser suite).

The site (https://stenhoor.github.io/smaltcy/) deploys from `.github/workflows/docs.yml` only: the repository's
Settings → Pages → Source must stay **GitHub Actions**. With "Deploy from a branch", GitHub publishes the repository's
root on every push and replaces the site with a 404 (2026-11-12). A push that touches no docs or source doesn't
redeploy; run the Docs workflow by hand to republish.

Two more of the family's rules:

- **Facts only.** Don't tell the owner something you haven't confirmed. A fact comes from the code, a command's
  output, a document you read in this session, or GitHub itself; say which when it isn't obvious. Label everything
  else as an assumption, in those words, with what would confirm it, and check before asserting when checking is
  cheap. Correct a wrong fact where you wrote it, and say so.
- **Watch your PRs to the merge.** A PR you open is yours until it is merged or closed: subscribe to its activity, fix
  CI failures and answer reviews as they arrive, then do what the merge unblocks and stop watching. Watching is
  event-driven: never poll, sleep or schedule checks for it. Merging stays with the owner.
  (Both rules: smaltworks' [session rules](https://github.com/stenhoor/smaltworks/blob/main/context/session-rules.md).)

## Commands

| Command | What it does |
| --- | --- |
| `npm ci && npm run deps` | Installs dependencies, then the pinned smaltdb build in `packed.json` (see below). First, and again after every `npm ci` or `npm install` |
| `npm run check` | Typecheck, then the tests (vitest). Before every commit |
| `npm run test:browser` | The playground, tech demo and runnable docs in headless Chromium with WebGPU (SwiftShader), a few minutes. What CI runs |
| `npm run test:quick` | `check`, then the browser tests with `--quick` (smaller graphs, fewer steps), about a minute. While working on the playground or the demo |
| `npm run bench` | The stores on a generated network; compare with docs/research/benchmarks.md |
| `npm run bench:smaltdb` | The same queries on smaltcy's engine and on smaltdb. `BENCH_ENTRY=bench/writes.ts` runs the writes, `BENCH_ENTRY=bench/vary.ts` statements that differ each time. The three are the bar for switching (ADR 0004); read the ratio column (docs/research/benchmarks.md, "Method") |
| `npm run docs:dev` / `docs:build` | The site with the playground |
| `npm run build` | `dist/` and type declarations |

Playwright is installed globally in the cloud containers; don't run `playwright install`.

## smaltdb, before its first publish

The compiler to smaltdb plans (`src/smaltdb`, [ADR 0004](docs/adr/0004-cypher-on-smaltdb.md); smaltdb's ADR 0033, step 8)
is tested against smaltdb, whose 0.9.0 is not on npm yet. `packed.json` pins it to a commit; `scripts/fetch-packed.mjs`
(identical in every repository that uses it, smaltql's included: don't edit it here) builds that commit, packs it and
installs the tarball with `npm install --no-save`, so it never reaches `package.json` or the lockfile. To try an unmerged
smaltdb change, run `node scripts/fetch-packed.mjs --local smaltdb=../smaltdb`. When 0.9.0 is published, the script
and `packed.json` are deleted and the pin becomes a dependency.

`src/smaltdb` imports smaltdb's types only (`import type … from 'smaltdb/engine'` and `'smaltdb/language'`) and builds
its plans as data, so smaltdb is not a runtime dependency; it isn't an entry point yet, and the build leaves it out.
Cypher is a language registered with smaltdb (`cypherLanguage`, `src/smaltdb/language.ts`): whoever has the engine
registers it (the tests in `test/helpers/smaltdb.ts`, each benchmark at its top), and `runOnSmaltdb` gives smaltdb a
statement's text. smaltdb keeps statements; nothing here does. Tests run smaltdb from the source in its packed build
(`smaltdb-src/…`, aliased in `vitest.config.ts`). `test/smaltdb-differential.test.ts`
runs the Cypher read cases on both engines: a case the compiler can't compile yet is listed there, and refused with
`Unsupported`, never answered differently.

## Layers and rules

- **Modular:** each part of `src/` is a package entry point meant to be reused on its own (`docs/guide/modules.md`).
  `test/modules.test.ts` holds the table of which layer may import which, and bundles every entry point on its own
  to check what it pulls in. A new dependency between layers changes that table on purpose, never by accident. The
  client carries no engine; Cypher never imports the engine.
- **Drawing lives in smaltkit** (ADR 0003): the GPU graph view and the timeline are `smaltkit/graph` and
  `smaltkit/timeline` (stenhoor/smaltkit), so smaltbi and the other apps draw graphs with the same code. `/render` and
  `/timeline` here only re-export them. Change them in smaltkit (its own PR, its tests and browser tests), then move the
  pin in `package.json` here.
- A new entry point goes in `package.json` `exports`, `scripts/build.mjs`, the `tsconfig.json` and `vitest.config.ts`
  aliases, the table in `docs/guide/modules.md` and the README. The TypeScript examples in that guide are type-checked
  (`test/docs-ts.test.ts`).
- Plans say what, never how: no store names or traversal orders in the plan format. The match planner decides.
- A new store passes `test/store-conformance.test.ts`, the Cypher suites (`describe.each` over stores) and the
  differential test.
- The docs follow smalt-brand's documentation standard (BRAND.md, "Documentation"): Quick start, Getting started,
  User guide and Reference, in the nav and the sidebar.
- Every ```` ```cypher ```` block in `docs/` runs where it stands, in the site kit's playground (`playground.ts`,
  copied unchanged from smalt-brand) with smaltcy's runner (`docs/.vitepress/theme/cypher.ts`), on a sample dataset:
  the fence's `dataset=…`, else `social`. Its setup is the examples above it on the same dataset that write; `noplay`
  keeps one plain. The table under an example is its tested result: `test/docs-examples.test.ts` runs each as the
  playground does and checks the table row for row (`UPDATE_DOCS=1 npx vitest run test/docs-examples.test.ts`
  writes them), and runs every playground example. `<!-- docs:error CODE -->` marks one that must fail.
- The build writes Markdown for agents beside the pages (`agents.ts`, also from the kit): `/llms.txt`, `/agents.md`
  (opened by `docs/guide/agents.md`) and a twin of every page. Give a page a front matter `description:` when its first
  sentence doesn't describe it.
- A Cypher feature that isn't supported fails with an error, never a wrong answer; list it in
  `docs/reference/divergences.md`.
- No runtime dependencies but smaltkit, the family's shared kit, pinned to a commit. Ask the owner before adding any
  other package, as the family's rules say.
- No fixed sleeps in tests. Probe tests (`test/zz-*.test.ts`) are scratch: never commit them.
- A significant decision gets an ADR in `docs/adr/`.
