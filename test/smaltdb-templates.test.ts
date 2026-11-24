import { describe, expect, test } from 'vitest';
import type { LanguageStatement } from 'smaltdb-src/engine/plan/language.js';
import { lex, LIT_FLOAT, LIT_NUMBER, LIT_STRING, scanLiterals, type LiteralScan } from '../src/cypher/parser.js';
import { open } from '../src/index.js';
import { cypherLanguage } from '../src/smaltdb/language.js';
import { templateCounts } from '../src/smaltdb/template.js';
import { runOnSmaltdb } from '../src/smaltdb/write.js';
import { social } from './helpers/graphs.js';
import { READ_CASES } from './helpers/read-cases.js';
import { both } from './helpers/smaltdb.js';
import { WRITE_CASES } from './helpers/write-cases.js';

/**
 * A statement told from its text (src/smaltdb/template.ts; ADR 0004, "A statement told from its text"): a text that
 * is a known one but for its strings and numbers gives the statement that one was, with its own values, and is not
 * parsed. It must be the statement a parse of the text gives, whatever the text is.
 *
 * Besides these tests, every statement of every test that runs on smaltdb is checked so (test/helpers/smaltdb.ts).
 */

/** A generator of numbers from a seed (mulberry32), so a failure can be run again. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CORPUS: readonly string[] = [...READ_CASES.map(([, cypher]) => cypher), ...WRITE_CASES.flatMap(([, , steps]) => steps.map((s) => s.cypher))];

interface Literal {
  readonly start: number;
  readonly end: number;
  readonly kind: number;
  readonly value: string | number;
}

/** A text's strings and numbers as `lex` has them; undefined where it refuses the text. */
function lexed(text: string): Literal[] | undefined {
  let tokens: ReturnType<typeof lex>;
  try {
    tokens = lex(text);
  } catch {
    return undefined;
  }
  const out: Literal[] = [];
  for (const t of tokens) {
    if (t.k === 'str') out.push({ start: t.start, end: t.end, kind: LIT_STRING, value: t.v });
    // The parser's rule for a float: written with a point or an exponent, and not in hex.
    else if (t.k === 'num') out.push({ start: t.start, end: t.end, kind: !/^0[xX]/.test(t.v) && /[.eE]/.test(t.v) ? LIT_FLOAT : LIT_NUMBER, value: t.num! });
  }
  return out;
}

describe("a statement's strings and numbers, found without its tokens", () => {
  const MAX = 24;
  const scan: LiteralScan = { count: 0, hash: 0, start: [], end: [], kind: [], value: [] };
  /** What the scan and `lex` disagree on for a text, or '' where they agree. */
  function difference(text: string): string {
    const want = lexed(text);
    const ok = scanLiterals(text, scan, MAX);
    const refused = want === undefined || want.length > MAX || want.some((l) => typeof l.value === 'number' && !Number.isFinite(l.value));
    if (refused) return ok ? `scanned, where lex refuses it or it is past what a scan takes: ${JSON.stringify(text)}` : '';
    if (!ok) return `not scanned: ${JSON.stringify(text)}`;
    if (scan.count !== want.length) return `${scan.count} found, lex has ${want.length}: ${JSON.stringify(text)}`;
    for (let i = 0; i < want.length; i++) {
      const w = want[i]!;
      if (scan.start[i] !== w.start || scan.end[i] !== w.end || scan.kind[i] !== w.kind || !Object.is(scan.value[i], w.value)) {
        return `${i}: ${JSON.stringify([scan.start[i], scan.end[i], scan.kind[i], scan.value[i]])}, lex has ${JSON.stringify([w.start, w.end, w.kind, w.value])}: ${JSON.stringify(text)}`;
      }
    }
    return '';
  }

  test('the statements of the read and write cases', () => {
    expect(CORPUS.length).toBeGreaterThan(90);
    for (const text of CORPUS) expect(difference(text)).toBe('');
  });

  test.each([
    ["RETURN 'a', \"b\", 'it\\'s', \"say \\\"hi\\\"\", 'tab\\there', '\\u0041\\u00e9', ''"],
    ['RETURN 1, 23, 1.5, .5, 0.25, 1e3, 1E-3, 2.5e+10, 0x1F, 0XAB, 007, 1e, 1.e3'],
    ['MATCH (a)-[*1..3]->(b), (c)-[*..2]-(d), (e)-[*2..]-(f), (g)-[*4]-(h) RETURN a.x[1..2], b[..3], [1,2,3][0]'],
    ['RETURN -5, - 5, --5, -0, 1-2, a.b-3, x - -1, -.5, -1e2'],
    ['MATCH (`a b`:`L 1` {`k 2`: 3}) RETURN `a b`.`k``2`, $p1, $`q 2`, $7'],
    ["// a comment's quote: 'x' 1\nRETURN 1 /* 2 \"three\" */ + 4 // 5"],
    ['RETURN a.b.c, n.x1, x1e3, _1, a1.5, 1.x, 2.e, 3..4, 5...6, 7.8.9'],
    ['RETURN 1<2, 3<=4, 5<>6, 7!=8, 9=~10, 11>=12, a+=13, (14)-->(15), (16)<--(17), 18<-19, 20->21'],
    ["RETURN {a: 1, 'b': 2, `c`: 3}, [x IN [1, 2] WHERE x > 1 | x * 2]"],
    ['RETURN 1e999, 0x, 0xZ, 99999999999999999999, 1.7976931348623157e308'],
    ['RETURN 1 2  3﻿'],
    ["RETURN 'unterminated"],
    ["RETURN 'bad \\q escape'"],
    ["RETURN 'cut \\u00"],
    ['RETURN `unterminated'],
    ['RETURN 1 /* unterminated'],
    ['RETURN $'],
    ['RETURN 1 ! 2'],
    ['RETURN 1 ~ 2'],
    ['RETURN 1 # 2'],
    ['RETURN é'],
    [''],
    ['   \n\t'],
  ])('%j', (text) => {
    expect(difference(text)).toBe('');
  });

  test('more strings and numbers than a scan takes: refused', () => {
    const list = (n: number) => `RETURN [${Array.from({ length: n }, (_, i) => i).join(', ')}]`;
    expect(scanLiterals(list(MAX), scan, MAX)).toBe(true);
    expect(scan.count).toBe(MAX);
    expect(scanLiterals(list(MAX + 1), scan, MAX)).toBe(false);
  });

  test('texts that differ only in their strings and numbers share a hash, whatever the values', () => {
    const hash = (text: string): number => {
      expect(scanLiterals(text, scan, MAX)).toBe(true);
      return scan.hash;
    };
    const a = hash("MATCH (p:Person {name: 'Ada'}) WHERE p.born > 1800 RETURN p.name");
    expect(hash("MATCH (p:Person {name: \"Alan Turing\"}) WHERE p.born > 0x7 RETURN p.name")).toBe(a);
    // Another kind of value, and another text outside the values: another hash.
    expect(hash("MATCH (p:Person {name: 'Ada'}) WHERE p.born > 1800.5 RETURN p.name")).not.toBe(a);
    expect(hash("MATCH (p:Person {name: 'Ada'}) WHERE p.born >= 1800 RETURN p.name")).not.toBe(a);
    expect(hash("MATCH (p:Person {name: 'Ada'})  WHERE p.born > 1800 RETURN p.name")).not.toBe(a);
  });

  test('texts made of the pieces a lexer has to tell apart', () => {
    const PIECES = ["'", '"', '`', '$', '/', '*', '.', '..', '-', '+', '0', '1', '9', 'x', 'X', 'e', 'E', 'a', 'f', '_', ' ', '\n', '\\', 'u', 'n', '(', ')', '[', ']', '{', '}', ',', ':', '|', ';', '=', '<', '>', '!', '~', '%', '^', '#', 'é', ' ', '//', '/*', '*/', '0x', '1e', '.5', "\\'", '\\u0041', '1.5', "'a'"];
    const next = random(20261124);
    let scanned = 0;
    for (let n = 0; n < 40000; n++) {
      let text = '';
      for (let k = 1 + Math.floor(next() * 12); k > 0; k--) text += PIECES[Math.floor(next() * PIECES.length)]!;
      // `lex` does not come back from a `$` and a backtick with no backtick after them: such a text is left out.
      const at = text.lastIndexOf('$`');
      if (at >= 0 && text.indexOf('`', at + 2) < 0) continue;
      const d = difference(text);
      if (d !== '') throw new Error(d);
      if (lexed(text) !== undefined) scanned++;
    }
    // Enough of them are texts `lex` takes.
    expect(scanned).toBeGreaterThan(4000);
  });
});

interface Shaped {
  readonly hash?: number;
  readonly tokens?: readonly unknown[];
  readonly values?: readonly unknown[];
  readonly paramCount: number;
  readonly paramNames: ReadonlyMap<string, number>;
  readonly shape?: unknown;
}

/** Cypher with templates and without, each language its own: nothing another test ran is known to them. */
function languages() {
  const told = cypherLanguage();
  const parsing = cypherLanguage(undefined, { templates: false });
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean =>
    a === undefined || b === undefined ? a === b : a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  /**
   * Gives a text to both, which must give one statement or refuse it alike. Says whether the statement was told from
   * the text ('told'), parsed, or refused.
   */
  const give = (text: string): 'told' | 'parsed' | 'refused' => {
    let want: Shaped | undefined;
    let wantError: unknown;
    try {
      want = parsing.parseOne!(text) as unknown as Shaped;
    } catch (e) {
      wantError = e;
    }
    const before = templateCounts.told;
    let got: Shaped | undefined;
    let gotError: unknown;
    try {
      got = told.parseOne!(text) as unknown as Shaped;
    } catch (e) {
      gotError = e;
    }
    if (want === undefined) {
      if (got !== undefined) throw new Error(`A statement, where the parser refuses the text: ${text}`);
      expect((gotError as Error).message, text).toBe((wantError as Error).message);
      return 'refused';
    }
    if (got === undefined) throw gotError;
    const alike =
      got.hash === want.hash &&
      got.paramCount === want.paramCount &&
      (got.shape === undefined) === (want.shape === undefined) &&
      same(got.tokens, want.tokens) &&
      same(got.values, want.values) &&
      JSON.stringify([...got.paramNames]) === JSON.stringify([...want.paramNames]);
    if (!alike) throw new Error(`Not the statement its parse gives: ${text}\n  values ${JSON.stringify(got.values)}, parsed ${JSON.stringify(want.values)}`);
    return templateCounts.told > before ? 'told' : 'parsed';
  };
  /** The values taken out of the statement the language with templates gives for a text. */
  const values = (text: string): readonly unknown[] => (told.parseOne!(text) as unknown as Shaped).values!;
  return { give, values, told: told.parseOne! as (text: string) => LanguageStatement };
}

describe('a text that is a known one but for its strings and numbers is not parsed', () => {
  test('the first statement of a shape is parsed, the second makes the template, the next are told', () => {
    const { give, values } = languages();
    const made = templateCounts.made;
    const q = (name: string) => `MATCH (p:Person {name: ${name}}) RETURN p.born AS born`;
    expect(give(q("'Ada'"))).toBe('parsed');
    expect(templateCounts.made).toBe(made);
    expect(give(q("'Alan'"))).toBe('parsed');
    expect(templateCounts.made).toBe(made + 1);
    for (const name of ["'Grace'", "''", '"Edsger"', "'O\\'Hara'", "'Ada'", "'\\u0041da'"]) expect(give(q(name)), name).toBe('told');
    expect(values(q("'O\\'Hara'"))).toEqual(["O'Hara"]);
    expect(templateCounts.made).toBe(made + 1);
    // Another text outside the value is another skeleton: parsed, and the shape being known it gets its template at once.
    expect(give(q("'Ada'").replace('RETURN', ' RETURN'))).toBe('parsed');
    expect(templateCounts.made).toBe(made + 2);
    expect(give(q("'Alan'").replace('RETURN', ' RETURN'))).toBe('told');
  });

  test('without templates every new text is parsed', () => {
    const parsing = cypherLanguage(undefined, { templates: false });
    const before = { ...templateCounts };
    for (const name of ['Ada', 'Alan', 'Grace', 'Edsger']) parsing.parseOne!(`MATCH (p:Person {name: '${name}'}) RETURN p.born AS born`);
    expect(templateCounts).toEqual(before);
  });

  test('a value of another kind is another statement', () => {
    const { give } = languages();
    const q = (v: string) => `MATCH (p:Person) WHERE p.born < ${v} RETURN p.name AS name`;
    expect([1815, 1912, 0, 2000, 7].map((v) => give(q(String(v))))).toEqual(['parsed', 'parsed', 'told', 'told', 'told']);
    // A float is another shape, with its own template.
    expect(['1815.5', '0.25', '1e-3', '.5'].map((v) => give(q(v)))).toEqual(['parsed', 'parsed', 'told', 'told']);
    // A float whose value is whole is another skeleton (it would divide as a float) of the whole numbers' shape,
    // which is known: its first statement makes the template.
    expect(['2.0', '1e3', '7.0'].map((v) => give(q(v)))).toEqual(['parsed', 'told', 'told']);
    // Past the whole numbers JavaScript holds exactly, a number stays written: each is a statement of its own.
    expect(['9007199254740993', '9007199254740995', '9007199254740997'].map((v) => give(q(v)))).toEqual(['parsed', 'parsed', 'parsed']);
    expect(give(q('5'))).toBe('told');
    // In hex it is the number it is.
    expect(give(q('0x10'))).toBe('told');
  });

  test('a - before a number is folded into it', () => {
    const { give, values } = languages();
    const q = (v: string) => `MATCH (p:Person) WHERE p.born > -${v} RETURN p.name AS name`;
    expect(['5', '6', '7', '0'].map((v) => give(q(v)))).toEqual(['parsed', 'parsed', 'told', 'told']);
    expect(values(q('7'))).toEqual([-7]);
    expect(Object.is(values(q('0'))[0], -0)).toBe(true);
    const twice = (v: string) => `MATCH (p:Person) WHERE p.born > - -${v} RETURN p.name AS name`;
    // Two of them fold to the number: the shape above, with another skeleton.
    expect(['5', '6', '7'].map((v) => give(twice(v)))).toEqual(['parsed', 'told', 'told']);
    expect(values(twice('7'))).toEqual([7]);
    // A subtraction is no sign.
    const minus = (v: string) => `MATCH (p:Person) WHERE p.born - ${v} > 0 RETURN p.name AS name`;
    expect(['5', '6', '7'].map((v) => give(minus(v)))).toEqual(['parsed', 'parsed', 'told']);
    expect(values(minus('7'))).toEqual([7, 0]);
  });

  test('values taken out with both signs: 0 is told from the others', () => {
    const { give } = languages();
    // The binder reads `ORDER BY` as a returned item where the two are written alike: -0 and 0 are, -5 and 5 are not.
    const q = (a: string, b: string) => `MATCH (p:Person) RETURN p.born + -${a} AS x ORDER BY p.born + ${b}`;
    for (const [a, b] of [['5', '6'], ['7', '8'], ['1', '2'], ['3', '3'], ['4', '4'], ['9', '9'], ['0', '0'], ['0', '0'], ['0', '0'], ['0', '1'], ['2', '0'], ['5', '5'], ['0', '0']]) give(q(a!, b!));
  });

  test('what stays written is part of the template: a count of hops, a LIMIT, a list, a column with no alias', () => {
    const { give } = languages();
    const hops = (name: string, n: number) => `MATCH (:Person {name: '${name}'})-[:KNOWS*1..${n}]->(x) RETURN x.name AS name`;
    expect([hops('Ada', 2), hops('Alan', 2), hops('Grace', 2)].map(give)).toEqual(['parsed', 'parsed', 'told']);
    // Another count is another statement: its own shape, and then its own template.
    expect([hops('Ada', 3), hops('Alan', 3), hops('Grace', 3), hops('Edsger', 2)].map(give)).toEqual(['parsed', 'parsed', 'told', 'told']);
    const limit = (year: number, n: number) => `MATCH (p:Person) WHERE p.born < ${year} RETURN p.name AS name LIMIT ${n}`;
    expect([limit(1900, 2), limit(1910, 2), limit(1920, 2), limit(1930, 3), limit(1940, 3), limit(1950, 3), limit(1960, 2)].map(give)).toEqual(['parsed', 'parsed', 'told', 'parsed', 'parsed', 'told', 'told']);
    const list = (name: string, a: number) => `MATCH (p:Person) WHERE p.name = '${name}' OR p.born IN [${a}, 1912] RETURN p.name AS name`;
    expect([list('Ada', 1), list('Alan', 1), list('Grace', 1), list('Grace', 2), list('Ada', 2), list('Edsger', 2)].map(give)).toEqual(['parsed', 'parsed', 'told', 'parsed', 'parsed', 'told']);
    const column = (name: string, a: number) => `MATCH (p:Person {name: '${name}'}) RETURN p.born + ${a}`;
    expect([column('Ada', 1), column('Alan', 1), column('Grace', 1), column('Grace', 2), column('Ada', 2), column('Alan', 2)].map(give)).toEqual(['parsed', 'parsed', 'told', 'parsed', 'parsed', 'told']);
  });

  test('a skeleton whose values all stay written gets no template, and is tried once', () => {
    const { give } = languages();
    const refused = templateCounts.refused;
    // Each number is in its column's name.
    const q = (a: number, b: number) => `MATCH (p:Person) RETURN p.born + ${a}, p.born - ${b}`;
    expect([q(1, 2), q(1, 2), q(1, 2), q(3, 4), q(3, 4), q(3, 4)].map(give)).toEqual(['parsed', 'parsed', 'parsed', 'parsed', 'parsed', 'parsed']);
    expect(templateCounts.refused).toBe(refused + 1);
  });

  test('values that are equal bind as one where the binder reads them alike', () => {
    const { give } = languages();
    const q = (a: number, b: number) => `MATCH (p:Person) RETURN p.born + ${a} AS x ORDER BY p.born + ${b}`;
    // Equal: the ORDER BY reads the returned item. Unequal: it is an expression of its own. Two shapes, two templates.
    expect([q(1, 1), q(2, 2), q(3, 3), q(4, 4)].map(give)).toEqual(['parsed', 'parsed', 'told', 'told']);
    expect([q(1, 2), q(3, 4), q(5, 6), q(7, 8)].map(give)).toEqual(['parsed', 'parsed', 'told', 'told']);
    expect([q(9, 9), q(9, 8)].map(give)).toEqual(['told', 'told']);
  });

  test('a statement with parameters and values', () => {
    const { give, told } = languages();
    const q = (year: number) => `MATCH (p:Person {name: $name}) WHERE p.born < ${year} RETURN p.name AS name SKIP $skip`;
    expect([1900, 1910, 1920, 1930].map((y) => give(q(y)))).toEqual(['parsed', 'parsed', 'told', 'told']);
    const st = told(q(1940));
    expect([...st.paramNames]).toEqual([['$name', 1], ['$skip', 2]]);
    expect(st.paramCount).toBe(2);
    // Its variant is its parameters' kinds, and the SKIP's count itself.
    expect(st.variant!({ name: 'Ada', skip: 1 })).toBe(told(q(1900)).variant!({ name: 'Alan', skip: 1 }));
    expect(st.variant!({ name: 'Ada', skip: 1 })).not.toBe(st.variant!({ name: 'Ada', skip: 2 }));
  });

  test('writes', () => {
    const { give } = languages();
    const create = (i: number, name: string) => `CREATE (:Bench {i: ${i}, name: '${name}'})`;
    expect([create(1, 'a'), create(2, 'b'), create(3, 'c'), create(0, '')].map(give)).toEqual(['parsed', 'parsed', 'told', 'told']);
    const set = (name: string, v: number) => `MATCH (p:Person {name: '${name}'}) SET p.bench = ${v}`;
    expect([set('Ada', 1), set('Alan', 2), set('Grace', 3)].map(give)).toEqual(['parsed', 'parsed', 'told']);
    const merge = (name: string) => `MERGE (p:Person {name: '${name}'}) ON CREATE SET p.made = 1 ON MATCH SET p.seen = 2`;
    expect([merge('Ada'), merge('Nobody'), merge('Alan')].map(give)).toEqual(['parsed', 'parsed', 'told']);
  });

  test('more strings and numbers than a template takes: parsed each time', () => {
    const { give } = languages();
    const q = (n: number, from: number) => `MATCH (p:Person) WHERE ${Array.from({ length: n }, (_, i) => `p.born <> ${from + i}`).join(' AND ')} RETURN p.name AS name`;
    expect([q(16, 0), q(16, 100), q(16, 200), q(16, 300)].map(give)).toEqual(['parsed', 'parsed', 'told', 'told']);
    expect([q(17, 0), q(17, 100), q(17, 200), q(17, 300)].map(give)).toEqual(['parsed', 'parsed', 'parsed', 'parsed']);
  });

  test('a text the parser refuses is refused alike, with a template for its skeleton or without', () => {
    const { give } = languages();
    const q = (name: string) => `MATCH (p:Person {name: ${name}}) RETURN p.born AS born`;
    expect([q("'Ada'"), q("'Alan'"), q("'Grace'")].map(give)).toEqual(['parsed', 'parsed', 'told']);
    // A string that does not end, an escape there is none of, a name where the string was, a value too many.
    expect([q("'Ada"), q("'bad \\q'"), q('Ada'), q("'Ada' 1")].map(give)).toEqual(['refused', 'refused', 'refused', 'refused']);
  });

  test('EXPLAIN and a read of the past are refused as before, and index statements are parsed', () => {
    const { give } = languages();
    for (let i = 0; i < 4; i++) {
      expect(give(`EXPLAIN MATCH (p:Person {name: 'n${i}'}) RETURN p`)).toBe('refused');
      expect(give(`AT VERSION ${i + 1} MATCH (p:Person {name: 'n${i}'}) RETURN p`)).toBe('refused');
      expect(give('CREATE INDEX FOR (p:Person) ON (p.name)')).toBe('parsed');
    }
  });

  test('256 templates are kept, and the oldest go first', () => {
    const { give } = languages();
    const q = (k: number, name: string) => `MATCH (p:Person {name: '${name}'}) RETURN p.born AS c${k}`;
    for (let k = 0; k < 300; k++) {
      expect(give(q(k, 'a')), String(k)).toBe('parsed');
      give(q(k, 'b'));
      expect(give(q(k, 'c')), String(k)).toBe('told');
    }
    // The last 256 skeletons have their templates; the first 44 were put out, and make theirs again.
    for (let k = 44; k < 300; k++) expect(give(q(k, 'd')), String(k)).toBe('told');
    expect(give(q(0, 'd'))).toBe('parsed');
    give(q(0, 'e'));
    expect(give(q(0, 'f'))).toBe('told');
  });
});

describe('the statements of the read and write cases, with other values in them', () => {
  // Values the parser reads in different ways: equal ones, 0, floats whose value is whole, numbers past the exact ones.
  const STRINGS = ["'Ada'", "'Alan'", "''", '"Grace"', "'O\\'Hara'", "'x y'", "'Ünï'", "'Ada'"];
  const NUMBERS = ['0', '1', '2', '3', '1912', '1815', '7', '0x1F', '9007199254740993'];
  const FLOATS = ['0.5', '1.5', '2.0', '1e3', '1E-3', '0.0', '.25'];

  test.each([[1], [2], [3]])('seed %i', (seed) => {
    const { give } = languages();
    const next = random(seed);
    const pick = (from: readonly string[]) => from[Math.floor(next() * from.length)]!;
    const before = templateCounts.told;
    let statements = 0;
    for (const text of CORPUS) {
      const literals = lexed(text);
      if (literals === undefined || literals.length === 0) continue;
      // The text as it is, then with other values: each a text of one skeleton where the kinds are the same.
      give(text);
      for (let round = 0; round < 16; round++) {
        let out = '';
        let at = 0;
        for (const l of literals) {
          const keep = next() < 0.25;
          out += text.slice(at, l.start) + (keep ? text.slice(l.start, l.end) : l.kind === LIT_STRING ? pick(STRINGS) : l.kind === LIT_FLOAT && next() < 0.9 ? pick(FLOATS) : pick(NUMBERS));
          at = l.end;
        }
        give(out + text.slice(at));
        statements++;
      }
    }
    expect(statements).toBeGreaterThan(800);
    // A good part of them were told from their text.
    expect(templateCounts.told - before).toBeGreaterThan(statements / 5);
  });
});

describe('statements told from their text give the rows a parse gives', () => {
  const g = social();
  const { db } = both(g);
  /** A query's rows on smaltdb as objects keyed by column, as `Graph.query` gives them. */
  const onSmaltdb = (cypher: string) => {
    const r = runOnSmaltdb(db, cypher);
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
  };

  test('reads', () => {
    const before = templateCounts.told;
    const names = ['Ada', 'Alan', 'Grace', 'Edsger', 'Barbara', 'Nobody', '', "O'Hara"];
    for (const name of names) {
      const quoted = `'${name.replace(/'/g, "\\'")}'`;
      for (const q of [
        `MATCH (p:Person {name: ${quoted}}) RETURN p.born AS born`,
        `MATCH (:Person {name: ${quoted}})-[:KNOWS]->(b) RETURN b.name AS name ORDER BY name`,
        `MATCH (:Person {name: ${quoted}})-[:KNOWS*1..2]->(b) RETURN DISTINCT b.name AS name ORDER BY name`,
        `MATCH (p:Person) WHERE p.name <> ${quoted} AND p.born > ${1800 + name.length * 20} RETURN p.name AS name ORDER BY name LIMIT 3`,
        `MATCH (p:Person) WHERE p.born > -${name.length} RETURN count(p) AS n, ${quoted} AS who`,
      ]) {
        expect(onSmaltdb(q), q).toEqual(g.query(q));
      }
    }
    // Of each query's eight texts, the third and the next are told: the registered language checks each against its parse.
    expect(templateCounts.told - before).toBeGreaterThanOrEqual(5 * 6);
  });

  test('writes', () => {
    const mine = open();
    const { db: theirs } = both(mine);
    const before = templateCounts.told;
    for (let i = 0; i < 12; i++) {
      for (const q of [
        `CREATE (:Bench {i: ${i}, half: ${i}.5, name: 'n${i}'})`,
        `MATCH (b:Bench {i: ${i}}) SET b.twice = ${i * 2}`,
        `MERGE (b:Bench {name: 'n${i % 5}'}) ON MATCH SET b.seen = ${i}`,
        `MATCH (b:Bench {i: ${i}}) CREATE (b)-[:NEXT {w: ${-i}}]->(:Bench {i: ${100 + i}})`,
      ]) {
        const a = mine.run(q);
        const b = runOnSmaltdb(theirs, q);
        expect(b.counts, q).toEqual(a.counts);
      }
    }
    const all = 'MATCH (b:Bench) OPTIONAL MATCH (b)-[r:NEXT]->(c) RETURN b.i AS i, b.half AS half, b.name AS name, b.twice AS twice, b.seen AS seen, r.w AS w, c.i AS next ORDER BY i';
    const rows = runOnSmaltdb(theirs, all);
    expect(rows.rows.map((row) => Object.fromEntries(rows.columns.map((c, i) => [c, row[i]])))).toEqual(mine.query(all));
    expect(templateCounts.told - before).toBeGreaterThanOrEqual(4 * 9);
  });
});
