import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { EXAMPLES, type DatasetKey } from '../docs/.vitepress/theme/components/examples.js';
import { airline, family, gitHistory, metro, microservices, network, ontology, orgChart, packages, powerGrid, social, supplyChain } from '../src/datasets/index.js';
import { open } from '../src/index.js';
import { DATASET_SIZE, WITH_HISTORY, datasetOf, printed, setupFor, type DatasetName } from '../docs/.vitepress/theme/cypher.js';
import type { SetupStep } from '../docs/.vitepress/theme/playground.js';

/**
 * Examples are tests (BRAND.md, Documentation, rule 5). Every ```cypher example in the docs runs as its playground
 * runs it (theme/cypher.ts): on its dataset (the fence's `dataset=`, else the page's front matter `play: dataset`,
 * else `social`), fresh, after the examples above it on that dataset that write. The table printed under it is its
 * tested result, row for row; a long one prints its first rows and `… N more rows`. An example marked
 * `<!-- docs:error CODE -->` must fail with CODE. Blocks marked `noplay` run on `social` with the parameters below.
 *
 * `UPDATE_DOCS=1 npx vitest run test/docs-examples.test.ts` writes the printed results into the pages.
 */
const UPDATE = !!process.env.UPDATE_DOCS;
/** A result longer than this prints its first SHORT rows and how many more. */
const LONG = 12;
const SHORT = 5;

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f.startsWith('.') || f === 'node_modules') return [];
    return statSync(p).isDirectory() ? markdown(p) : p.endsWith('.md') ? [p] : [];
  });
}

const DATA: Record<DatasetName, () => ReturnType<typeof social>> = {
  social,
  family,
  metro,
  network: () => network(DATASET_SIZE.network),
  ontology,
  'org-chart': () => orgChart(DATASET_SIZE['org-chart']),
  packages: () => packages(DATASET_SIZE.packages),
  airline: () => airline(DATASET_SIZE.airline),
  'power-grid': () => powerGrid(DATASET_SIZE['power-grid']),
  'git-history': () => gitHistory(DATASET_SIZE['git-history']),
  'supply-chain': () => supplyChain(DATASET_SIZE['supply-chain']),
  microservices: () => microservices(DATASET_SIZE.microservices),
};

interface Example {
  file: string;
  /** The fence's first line in the file (0-based) and the lines its printed table spans after it. */
  end: number;
  table: { from: number; to: number } | null;
  code: string;
  attrs: Record<string, string>;
  noplay: boolean;
  fails?: string;
  setup: SetupStep[];
}

/** The page's front matter `play:` map, written as a block (`play:` then `  key: value` lines). */
function pageAttrs(text: string): Record<string, string> {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const block = /^play:\s*\n((?:[ \t]+\S.*\n?)*)/m.exec(fm)?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/^\s+([\w-]+):\s*(\S+)\s*$/gm)].map((m) => [m[1]!, m[2]!]));
}

/** The cypher examples of a page, as the kit's playground plugin reads them. */
function examples(file: string): Example[] {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const page = pageAttrs(text);
  const out: Example[] = [];
  const setup: SetupStep[] = [];
  let markers: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^<!--\s*(docs:[\s\S]*?)\s*-->\s*$/.exec(line.trim());
    if (marker) {
      markers.push(marker[1]!);
      continue;
    }
    const open = /^```(\S*)\s*(.*)$/.exec(line);
    if (!open) {
      if (line.trim()) markers = [];
      continue;
    }
    const start = i;
    for (i++; i < lines.length && lines[i] !== '```'; i++);
    const [lang, info] = [open[1]!, open[2]!];
    const kinds = markers.map((m) => m.split(/\s+/)[0]);
    const fails = markers.find((m) => m.startsWith('docs:error'))?.split(/\s+/)[1];
    markers = [];
    if (lang !== 'cypher' || kinds.includes('docs:skip')) continue;
    const flags = info.split(/\s+/).filter(Boolean);
    const attrs = { ...page };
    for (const f of flags) {
      const m = /^([A-Za-z][\w-]*)=(\S*)$/.exec(f);
      if (m) attrs[m[1]!] = m[2]!;
    }
    const code = lines.slice(start + 1, i).join('\n');
    // The table printed under it: after blank lines, consecutive lines that start with |.
    let j = i + 1;
    while (j < lines.length && !lines[j]!.trim()) j++;
    let table: Example['table'] = null;
    if (lines[j]?.startsWith('|')) {
      const from = j;
      while (j < lines.length && lines[j]!.startsWith('|')) j++;
      table = { from, to: j };
    }
    out.push({ file, end: i, table, code, attrs, noplay: flags.includes('noplay'), fails, setup: setup.slice() });
    const sql = code.trim();
    const has = Object.keys(attrs).length > 0;
    setup.push(fails !== undefined ? (has ? { sql, fails: true, attrs } : { sql, fails: true }) : has ? { sql, attrs } : sql);
  }
  return out;
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** The Markdown table for a result. */
function tableOf(columns: readonly string[], rows: readonly (readonly unknown[])[]): string[] {
  const shown = rows.length > LONG ? rows.slice(0, SHORT) : rows;
  const out = [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...shown.map((r) => `| ${r.map(printed).join(' | ')} |`)];
  if (shown.length < rows.length) out.push(`| … ${rows.length - shown.length} more rows |${' |'.repeat(columns.length - 1)}`);
  return out;
}

/** Runs an example as its playground does; the result, or the error it fails with. */
function run(ex: Example) {
  const name = datasetOf(ex.attrs);
  const g = open({ history: WITH_HISTORY.has(name) });
  g.load(DATA[name]());
  if (ex.noplay) return g.run(ex.code, { year: 1900 });
  for (const s of setupFor(ex.setup, name)) {
    try {
      g.run(s.code);
    } catch (e) {
      if (!s.fails) throw e;
    }
  }
  return g.run(ex.code);
}

const files = markdown('docs');
const all = files.flatMap(examples);
const updates = new Map<string, { at: number; remove: number; lines: string[] }[]>();

describe('docs examples', () => {
  test('there are examples', () => expect(all.length).toBeGreaterThan(20));
  test.each(all.map((ex) => [`${ex.file}:${ex.end}: ${ex.code.split('\n')[0]}`, ex] as const))('%s', (_where, ex) => {
    if (ex.fails !== undefined) {
      let code: string | undefined;
      try {
        run(ex);
      } catch (e) {
        code = (e as { code?: string }).code ?? 'no code';
      }
      expect(code, 'the error it is marked to fail with').toBe(ex.fails);
      return;
    }
    const r = run(ex);
    if (ex.noplay) return;
    // A runnable example shows something: rows, a plan or what it wrote.
    if (!/^\s*(CREATE|DROP) INDEX/i.test(ex.code)) expect(r.rows.length + Object.values(r.counts).reduce((a, b) => a + b, 0), ex.code).toBeGreaterThan(0);
    // A plan, and a write that returns nothing, print no table.
    const want = r.explain || !r.columns.length ? [] : tableOf(r.columns, r.rows);
    const lines = readFileSync(ex.file, 'utf8').split('\n');
    const have = ex.table ? lines.slice(ex.table.from, ex.table.to) : [];
    if (UPDATE) {
      if (have.join('\n') !== want.join('\n')) {
        const list = updates.get(ex.file) ?? [];
        // A new table goes after a blank line under the fence; one there already is replaced.
        list.push(ex.table ? { at: ex.table.from, remove: ex.table.to - ex.table.from, lines: want } : { at: ex.end + 1, remove: 0, lines: want.length ? ['', ...want] : [] });
        updates.set(ex.file, list);
      }
      return;
    }
    expect(have.map(cells), 'the printed result under the example (UPDATE_DOCS=1 writes it)').toEqual(want.map(cells));
  });
  if (UPDATE)
    test('write the printed results', () => {
      for (const [file, list] of updates) {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (const u of list.sort((a, b) => b.at - a.at)) lines.splice(u.at, u.remove, ...u.lines);
        writeFileSync(file, lines.join('\n'));
      }
    });
});

describe('playground examples', () => {
  // As the playground loads them: every dataset keeps its history; the networks with their growth.
  const data: Record<DatasetKey, () => ReturnType<typeof social>> = {
    social, family, metro, ontology,
    network: () => network(800, 42, { history: true }),
    big: () => network(800, 42, { history: true }),
  };
  const cases = (Object.keys(EXAMPLES) as DatasetKey[]).flatMap((k) => EXAMPLES[k].map((ex) => [k, ex.title, ex.query] as const));
  test.each(cases)('%s: %s', (k, _title, query) => {
    const g = open({ history: true });
    g.load(data[k]());
    const r = g.run(query);
    // Every example shows something.
    expect(r.rows.length, query).toBeGreaterThan(0);
  });
});
