/**
 * docs/grammar.ebnf is the grammar the syntax diagrams and the agent guide show. This test keeps it honest: it derives
 * random statements from the grammar, from the statement rule and from each clause, and checks that the parser reads
 * every one, so the grammar never shows a form smaltcy can't read. (It checks the parse only: a statement can still
 * fail to bind, as `RETURN x` does.) The same as smaltql's test/grammar.test.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEbnf, type Grammar, type Node } from '../docs/.vitepress/theme/railroad.js';
import { compile, parse } from '../src/cypher/index.js';
import { SmaltcyError } from '../src/errors.js';
import { validatePlan } from '../src/plan/validate.js';

const grammar = parseEbnf(readFileSync(new URL('../docs/grammar.ebnf', import.meta.url), 'utf8'));

// Tokens: the grammar's leaves, with values the lexer reads as what they name. Every name is `n`, plain or quoted:
// CREATE INDEX FOR (n:L) ON (n.key) needs the same variable twice.
const TOKENS: Record<string, string[]> = {
  name: ['n', '`n`'],
  'string-literal': ["'s'", '"t"', "'it\\'s'"],
  'numeric-literal': ['1', '2.5', '0x1F', '1e3'],
  integer: ['1', '2', '3'],
  parameter: ['$p', '$`p q`'],
};

/** A deterministic random source, so a failure can be reproduced. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A generator of random sentences of a grammar. */
function generator(grammar: Grammar): (name: string, random: () => number) => string {
  /** The fewest tokens each rule can produce, to end recursion. */
  const cost = new Map<string, number>();
  const minCost = (n: Node): number => {
    switch (n.t) {
      case 'term':
        return 1;
      case 'ref':
        return TOKENS[n.name] ? 1 : (cost.get(n.name) ?? 1e6);
      case 'seq':
        return n.items.reduce((a, i) => a + minCost(i), 0);
      case 'choice':
        return Math.min(...n.items.map(minCost));
      case 'opt':
      case 'skip':
        return 0;
      case 'rep':
        return minCost(n.item);
    }
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, rule] of grammar.rules) {
      const c = minCost(rule);
      if (c < (cost.get(name) ?? 1e6)) {
        cost.set(name, c);
        changed = true;
      }
    }
  }

  // The alternatives of expr before this index are atoms; the rest are wrapped in parentheses where they stand in a
  // bigger expression, so precedence (the operators' table, not the grammar's) never changes how one parses.
  const ATOMIC_EXPR = 1;

  function generate(name: string, random: () => number, depth = 0): string {
    const token = TOKENS[name];
    if (token) return token[Math.floor(random() * token.length)]!;
    const rule = grammar.rules.get(name);
    if (!rule) throw new Error(`no rule ${name}`);
    const deep = depth > 5;
    const out: string[] = [];
    const walk = (n: Node, top: boolean): void => {
      switch (n.t) {
        case 'term':
          out.push(n.text);
          return;
        case 'ref':
          out.push(generate(n.name, random, depth + 1));
          return;
        case 'seq':
          n.items.forEach((i) => walk(i, false));
          return;
        case 'choice': {
          const pick = deep ? n.items.reduce((best, i) => (minCost(i) < minCost(best) ? i : best)) : n.items[Math.floor(random() * n.items.length)]!;
          if (name === 'expr' && top && n.items.indexOf(pick) >= ATOMIC_EXPR && depth > 0) {
            out.push('(');
            walk(pick, false);
            out.push(')');
          } else walk(pick, false);
          return;
        }
        case 'opt':
          if (!deep && random() < 0.4) walk(n.item, false);
          return;
        case 'rep': {
          const times = deep ? 1 : 1 + Math.floor(random() * 3);
          for (let i = 0; i < times; i++) {
            if (i && n.sep) walk(n.sep, false);
            walk(n.item, false);
          }
          return;
        }
        case 'skip':
          return;
      }
    };
    walk(rule, true);
    return out.join(' ');
  }
  return generate;
}

const generate = generator(grammar);

describe('docs/grammar.ebnf', () => {
  it('defines every rule it uses, but the tokens', () => {
    const missing = new Set<string>();
    const visit = (n: Node): void => {
      if (n.t === 'ref' && !grammar.rules.has(n.name) && !TOKENS[n.name]) missing.add(n.name);
      if (n.t === 'seq' || n.t === 'choice') n.items.forEach(visit);
      if (n.t === 'opt' || n.t === 'rep') visit(n.item);
      if (n.t === 'rep' && n.sep) visit(n.sep);
    };
    grammar.rules.forEach(visit);
    expect([...missing]).toEqual([]);
  });

  const clauses = (grammar.rules.get('clause') as Extract<Node, { t: 'choice' }>).items.map((i) => (i as { name: string }).name);
  it.each(['statement', 'create-index', 'drop-index', ...clauses])('every %s it can produce, the parser reads', (rule) => {
    const random = rng(rule.length * 7919);
    const rejected: string[] = [];
    for (let i = 0; i < 400; i++) {
      const cypher = generate(rule, random);
      // `(x) - [1]` reads as a relationship, `(x)-[1]-`: a parenthesized expression minus a list starts a pattern, as
      // the Cypher reference says. The grammar can't show that, so those are left out.
      if (/\)\s*-\s*\[/.test(cypher)) continue;
      try {
        parse(cypher);
      } catch (e) {
        rejected.push(`${cypher}\n    → ${(e as Error).message}`);
      }
    }
    // The shortest few say most about which rule is wrong.
    rejected.sort((a, b) => a.length - b.length);
    expect(rejected.slice(0, 3), `${rule}: statements the grammar produces and the parser rejects`).toEqual([]);
  });
});

/**
 * Each function page draws its function from an ```ebnf block. Random calls derived from it must parse, and the
 * engine must know the function and take that many arguments. (Other errors, such as an argument of the wrong type,
 * are the function's to give.) As smaltql's test does.
 */
describe('function pages', () => {
  const root = new URL('../docs/reference/functions/', import.meta.url);
  const pages = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(new URL(`${d.name}/`, root)).filter((f) => f.endsWith('.md') && f !== 'index.md').map((f) => `${d.name}/${f.slice(0, -3)}`));
  const site = readFileSync(new URL('../docs/grammar.ebnf', import.meta.url), 'utf8');
  // A function page's diagram names its arguments in capitals (`X`, `START`, `NODE`): any expression.
  const ARGUMENT = /^[A-Z][A-Z0-9_]*$/;
  const ARGUMENTS = ['1', "'a'", 'null', '[1, 2]'];

  it('have pages', () => expect(pages.length).toBeGreaterThan(60));

  it.each(pages)('%s: every call its diagram can produce, smaltcy reads and the engine takes', (page) => {
    const md = readFileSync(new URL(`${page}.md`, root), 'utf8');
    const blocks = [...md.matchAll(/^```ebnf\n([\s\S]*?)^```/gm)].map((m) => m[1]!);
    expect(blocks, `${page}: one ebnf block`).toHaveLength(1);
    const name = page.split('/')[1]!;
    const own = parseEbnf(blocks[0]!);
    expect([...own.rules.keys()], `${page}: its rule is named after the page`).toEqual([name]);
    // Its Parameters list names the arguments its diagram has, in order.
    const params = [...(/## Parameters\n\n([\s\S]*?)\n## /.exec(md)?.[1] ?? '').matchAll(/^- `([A-Z][A-Z0-9_]*)`/gm)].map((m) => m[1]);
    const args = [...new Set(blocks[0]!.match(/\b[A-Z][A-Z0-9_]*\b/g) ?? [])].filter((a) => !/^'/.test(a) && blocks[0]!.includes(` ${a}`));
    expect(params, `${page}: Parameters`).toEqual(args.filter((a) => !blocks[0]!.includes(`'${a}'`)));
    // Parsed with the site's grammar, so a rule name the page shares with it is an error; the arguments are tokens.
    const both = parseEbnf(`${site}\n${blocks[0]}`);
    for (const n of new Set(blocks[0]!.match(/\b[A-Z][A-Z0-9_]*\b/g) ?? [])) if (ARGUMENT.test(n) && !both.rules.has(n)) TOKENS[n] = ARGUMENTS;
    const generate = generator(both);
    const random = rng(name.length * 7919);
    const rejected: string[] = [];
    for (let i = 0; i < 50; i++) {
      const cypher = `RETURN ${generate(name, random)} AS v`;
      try {
        validatePlan(compile(cypher).plan);
      } catch (e) {
        const m = (e as Error).message;
        if (e instanceof SmaltcyError && e.code === 'SMALTCY_SYNTAX') rejected.push(`${cypher}\n    → ${m}`);
        else if (/Unknown function|takes .* arguments/.test(m)) rejected.push(`${cypher}\n    → ${m}`);
      }
    }
    rejected.sort((a, b) => a.length - b.length);
    expect(rejected.slice(0, 3), `${page}: calls the diagram produces that smaltcy rejects`).toEqual([]);
  });
});
