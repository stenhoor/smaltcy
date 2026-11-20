import { describe, expect, test } from 'vitest';
import { Database } from 'smaltdb-src/engine/database.js';
import { compile } from '../src/cypher/index.js';
import { dumpGraph } from '../src/engine/io.js';
import { open, type Graph } from '../src/index.js';
import { network } from '../src/datasets/index.js';
import { compileQuery, paramValues, Unsupported, type CompileOptions } from '../src/smaltdb/compile.js';
import { runOnSmaltdb } from '../src/smaltdb/write.js';
import { graphTablesFor, type GraphTables } from '../src/smaltdb/schema.js';
import { social } from './helpers/graphs.js';
import { both, dataOf } from './helpers/smaltdb.js';
import { READ_CASES, READ_PARAMS } from './helpers/read-cases.js';

/**
 * Cypher on smaltdb (ADR 0004; smaltdb ADR 0033, step 8): Cypher compiled by smaltcy's compiler, then to a smaltdb plan,
 * and run on the same graph loaded into smaltdb. Each query must give the rows smaltcy's own engine gives, or be refused
 * as not supported yet.
 */

/**
 * The read cases the compiler refuses, with what it names. The list can only shrink: a case on it that compiles fails,
 * and so does a case off it that gives other rows.
 */
const UNSUPPORTED = new Map<string, string>([
  ['labels and keys', 'keys() (a smaltdb map keeps its keys sorted)'],
]);

/**
 * Runs a Cypher query on smaltdb: its rows as objects keyed by column, as `Graph.query` gives them. Compiled as
 * written, and then as an application's query runs (`runOnSmaltdb`: by its shape, src/smaltdb/shape.ts), twice, the
 * second time with the statement kept: the same rows each way.
 */
function onSmaltdb(db: Database, tables: GraphTables, cypher: string, params: Record<string, unknown> = {}, options: CompileOptions = {}) {
  const q = compileQuery(compile(cypher).plan, tables, { ...options, params });
  const r = db.queryPlan(q.statement, paramValues(q, params) as never);
  if (Object.keys(options).length === 0) {
    for (let i = 0; i < 2; i++) {
      const s = runOnSmaltdb(db, compile(cypher).plan, tables, { params });
      expect(s.columns, `${cypher}: by its shape`).toEqual(q.columns);
      expect(s.rows, `${cypher}: by its shape`).toEqual(r.rows);
    }
  }
  return r.rows.map((row) => Object.fromEntries(q.columns.map((c, i) => [c, row[i]])));
}

describe('the read cases on smaltdb', () => {
  const { db, tables } = both(social());
  test.each(READ_CASES)('%s', (name, cypher, expected) => {
    const feature = UNSUPPORTED.get(name);
    if (feature !== undefined) {
      let error: unknown;
      try {
        onSmaltdb(db, tables, cypher, READ_PARAMS);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Unsupported);
      expect((error as Unsupported).feature).toBe(feature);
      return;
    }
    expect(onSmaltdb(db, tables, cypher, READ_PARAMS)).toEqual(expected);
  });

  test('how many run', () => {
    expect(READ_CASES.length - UNSUPPORTED.size).toBe(58);
    for (const name of UNSUPPORTED.keys()) expect(READ_CASES.some(([n]) => n === name), name).toBe(true);
  });
});

/** Properties of every kind, where smaltdb's meaning and Cypher's differ (smaltdb ADR 0033, section 5.4). */
const MIXED = `CREATE (:T {k: 'int', v: 1}), (:T {k: 'float', v: 1.5}), (:T {k: 'str', v: 'a'}), (:T {k: 'true', v: true}),
  (:T {k: 'false', v: false}), (:T {k: 'list', v: [1, 2]}), (:T {k: 'none'}), (:T {k: 'zero', v: 0}), (:T {k: 'ten', v: 10}),
  (:T {k: 'str2', v: 'B'})`;

describe("Cypher's meaning, where smaltdb's differs: both engines give the same rows", () => {
  const g = open();
  g.run(MIXED);
  const { db, tables } = both(g);
  test.each([
    ['values of every kind come back as they went in', 'MATCH (n:T) RETURN n.k AS k, n.v AS v ORDER BY k'],
    ['comparisons across kinds: false for =, NULL for <', "MATCH (n:T) RETURN n.k AS k, n.v = 1 AS eq1, n.v = true AS eqt, n.v < 2 AS lt2, n.v >= 'a' AS gea ORDER BY k"],
    ['ORDER BY: lists, strings, booleans, numbers, then NULL', 'MATCH (n:T) RETURN n.k AS k ORDER BY n.v, k'],
    ['ORDER BY DESC: NULL first', 'MATCH (n:T) RETURN n.k AS k ORDER BY n.v DESC, k'],
    ['min and max across kinds', 'MATCH (n:T) RETURN min(n.v) AS lo, max(n.v) AS hi'],
    ['min and max of numbers and strings', "MATCH (n:T) WHERE n.k <> 'list' RETURN min(n.v) AS lo, max(n.v) AS hi"],
    ['aggregates of numbers', "MATCH (n:T) WHERE n.k IN ['int', 'float', 'zero', 'ten'] RETURN min(n.v) AS lo, max(n.v) AS hi, sum(n.v) AS s, avg(n.v) AS a"],
    ['collect leaves NULLs out', 'MATCH (n:T) RETURN collect(n.v) AS vs'],
    ['count DISTINCT keeps true apart from 1', 'MATCH (n:T) RETURN count(DISTINCT n.v) AS c'],
    ['aggregates of no rows: sum 0, collect []', 'MATCH (n:Nobody) RETURN sum(n.v) AS s, avg(n.v) AS a, min(n.v) AS lo, collect(n.v) AS c'],
    ['integer and float arithmetic', 'RETURN 7 / 2 AS a, 7.0 / 2 AS b, -7 / 2 AS c, 7 % 3 AS d, -7 % 3 AS e, 2 * 3 + 1 AS f, 1.5 + 1 AS g'],
    ['booleans and NULLs', "RETURN true = 1 AS a, 1 = 1.0 AS b, 'a' < 'b' AS c, 1 < 'a' AS d, null = null AS e, true < false AS f, true AND null AS g, false AND null AS h, true XOR false AS i, true XOR null AS j"],
    ['NaN equals nothing', 'RETURN 0.0 / 0 = 0.0 / 0 AS nan, 1.0 / 0 AS inf'],
    ['lists and maps of mixed kinds', "RETURN [1, 'a', true] AS l, {a: 1, b: true} AS m, [true, false] AS bs"],
    ['size of strings and lists', "MATCH (n:T) WHERE n.k IN ['str', 'list', 'str2'] RETURN n.k AS k, size(n.v) AS s ORDER BY k"],
    ['IN a list of mixed kinds', "MATCH (n:T) RETURN n.k AS k, n.v IN [1, 'a', true] AS i ORDER BY k"],
    ['DISTINCT across kinds', "UNWIND [1, 1.0, 2, true, 'a', 'a', null] AS x RETURN DISTINCT x"],
    ['string functions only on strings', "MATCH (n:T) WHERE n.k IN ['str', 'str2'] RETURN toUpper(n.v) AS u, toLower(n.v) AS l, n.v STARTS WITH 'a' AS s ORDER BY u"],
    ['CASE compares as = does', "MATCH (n:T) RETURN n.k AS k, CASE n.v WHEN 1 THEN 'one' WHEN true THEN 'yes' ELSE 'other' END AS c ORDER BY k"],
    ['list comprehensions and quantifiers over a property', "MATCH (n:T) WHERE n.k = 'list' RETURN [x IN n.v WHERE x > 1 | x * 10] AS l, any(x IN n.v WHERE x = 2) AS a, all(x IN n.v WHERE x > 1) AS b"],
    ['quantifiers with NULLs', 'RETURN single(x IN [1, null, 2] WHERE x = 1) AS s, none(x IN [] WHERE x = 1) AS n, all(x IN [1, null] WHERE x > 0) AS a'],
    ['+ joins strings', "MATCH (n:T) WHERE n.k IN ['str', 'str2'] RETURN n.v + n.v AS c ORDER BY c"],
    ['coalesce across kinds', "MATCH (n:T) RETURN n.k AS k, coalesce(n.v, 'missing') AS c ORDER BY k"],
  ])('%s', (_name, cypher) => {
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });

  // Errors in Cypher, where smaltdb would give a value: the plan raises smaltcy's error (smaltdb's raise_error), with
  // its code and message.
  test.each([
    ['division by zero', 'RETURN 1 / 0 AS x'],
    ['a predicate that is not a boolean', 'MATCH (n:T) WHERE n.v RETURN n.k AS k'],
    ['adding a boolean', "MATCH (n:T) WHERE NOT n.k IN ['str', 'str2', 'list'] RETURN n.k AS k, n.v + 1 AS p ORDER BY k"],
    ['adding a boolean to a float', "MATCH (n:T) WHERE n.k = 'true' RETURN 1.5 + n.v AS p"],
    ['subtracting from a string', "MATCH (n:T) WHERE n.k = 'str' RETURN n.v - 1 AS p"],
    ['multiplying a boolean', "MATCH (n:T) WHERE n.k = 'true' RETURN n.v * 1.5 AS p"],
    ['dividing a list', "MATCH (n:T) WHERE n.k = 'list' RETURN n.v / 2 AS p"],
    ['the modulo of a string', "MATCH (n:T) WHERE n.k = 'str' RETURN n.v % 2 AS p"],
    ['sum of a string', 'MATCH (n:T) RETURN sum(n.v) AS s'],
    ['avg of a boolean', "MATCH (n:T) WHERE n.k = 'true' RETURN avg(n.v) AS a"],
    ['size of a boolean', "MATCH (n:T) WHERE n.k = 'true' RETURN size(n.v) AS s"],
    ['size of a number', "MATCH (n:T) WHERE n.k = 'int' RETURN size(n.v) AS s"],
    ['abs of a boolean', "MATCH (n:T) WHERE n.k = 'true' RETURN abs(n.v) AS a"],
    ['negating a string', "MATCH (n:T) WHERE n.k = 'str' RETURN -n.v AS a"],
    ['toUpper of a number', "MATCH (n:T) WHERE n.k = 'float' RETURN toUpper(n.v) AS u"],
    ['a list comprehension over a number', "MATCH (n:T) WHERE n.k = 'float' RETURN [x IN n.v | x] AS l"],
    ['a quantifier over a boolean', "MATCH (n:T) WHERE n.k = 'true' RETURN any(x IN n.v WHERE x = 1) AS a"],
    ["a list comprehension's predicate that is not a boolean", "MATCH (n:T) WHERE n.k = 'list' RETURN [x IN n.v WHERE x | x] AS l"],
    ["a quantifier's predicate that is not a boolean", "MATCH (n:T) WHERE n.k = 'list' RETURN all(x IN n.v WHERE x) AS a"],
    ['NOT of a string', "MATCH (n:T) WHERE n.k = 'str' RETURN NOT n.v AS a"],
    ['AND of a number', "MATCH (n:T) WHERE n.k = 'int' RETURN n.v AND true AS a"],
    ['a CASE condition that is not a boolean', "MATCH (n:T) WHERE n.k = 'int' RETURN CASE WHEN n.v THEN 1 END AS c"],
  ])('both engines raise the same error: %s', (_name, cypher) => {
    const error = (run: () => unknown) => {
      try {
        run();
      } catch (e) {
        return { code: (e as { code: string }).code, message: (e as Error).message };
      }
      return undefined;
    };
    const mine = error(() => g.query(cypher));
    expect(mine?.code).toBe('SMALTCY_TYPE');
    expect(error(() => onSmaltdb(db, tables, cypher))).toEqual(mine);
  });

  test('size of a map, as smaltcy gives it', () => {
    const cypher = 'RETURN size({a: 1, b: 2}) AS s';
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });
});

/**
 * Lists and maps compared and ordered element by element, `+` of strings, numbers, booleans and lists, and `%` of
 * floats: computed by the compiler with smaltcy's meaning (ADR 0004).
 */
const VALUES = `CREATE (:V {k: 'int', v: 1}), (:V {k: 'float', v: 1.5}), (:V {k: 'neg', v: -7.5}), (:V {k: 'zero', v: 0}),
  (:V {k: 'big', v: 1e21}), (:V {k: 'huge', v: 123456789012345680000}), (:V {k: 'str', v: 'a'}), (:V {k: 'true', v: true}),
  (:V {k: 'none'}), (:V {k: 'list', v: [1, 2]}), (:V {k: 'list2', v: [1, 3]}), (:V {k: 'list3', v: [1]}),
  (:V {k: 'empty', v: []}), (:V {k: 'floats', v: [1.0, 2.5]}), (:V {k: 'strs', v: ['a', 'b']}), (:V {k: 'bools', v: [true, false]})`;

describe('lists, maps, + and %: both engines give the same rows', () => {
  const g = open();
  g.run(VALUES);
  const { db, tables } = both(g);
  test.each([
    // = and <> of lists and maps: element by element, with Cypher's NULLs.
    ['= of lists', 'RETURN [1, null] = [1, null] AS a, [1, 2] = [1, 3] AS b, [1] = [1, 2] AS c, [1, 2] = [1.0, 2] AS d, [] = [] AS e, [[1, 2], [3]] = [[1, 2], [3]] AS f, [[1, null]] = [[1, 2]] AS g, [1, \'a\'] = [1, \'b\'] AS h, [null, 1] = [null, 2] AS i, [1] <> [2] AS j, [true] = [1] AS k, [0.0 / 0] = [0.0 / 0] AS l, [1] = 1 AS m, [1] = null AS n'],
    ['= of maps', 'RETURN {a: 1, b: 2} = {b: 2, a: 1} AS a, {a: 1} = {a: 1, b: 2} AS b, {a: 1} = {b: 1} AS c, {a: null} = {a: null} AS d, {a: [1, 2]} = {a: [1, 2.0]} AS e, {a: 1} = [1] AS f, {a: 1, b: null} = {a: 2, b: null} AS g, {} = {} AS h, {a: {b: [1]}} <> {a: {b: [2]}} AS i'],
    ['= of properties of every kind', 'MATCH (n:V), (m:V) WHERE n.k < m.k RETURN n.k AS a, m.k AS b, n.v = m.v AS e, n.v <> m.v AS ne ORDER BY a, b'],
    ['= in IN, CASE and list comprehensions', "MATCH (n:V) RETURN n.k AS k, n.v IN [[1, 2], [1]] AS i, CASE n.v WHEN [] THEN 'empty' WHEN [1, 2] THEN 'pair' ELSE 'other' END AS c, [x IN [[1], [1, 2]] WHERE x = n.v] AS l ORDER BY k"],
    // < of lists: the first difference decides, else the shorter first; NULL where elements don't compare; maps NULL.
    ['< of lists', "RETURN [1, 2] < [1, 3] AS a, [1, 2] < [1] AS b, [1] < [1, 2] AS c, [] < [1] AS d, [null] < [] AS e, [] < [null] AS f, [1, null] < [2, null] AS g, [null, 1] < [null, 2] AS h, [1, 'a'] < [1, 2] AS i, [[1, 2]] < [[1, 3]] AS j, [true] < [false] AS k, ['a'] >= ['b'] AS l, [0.0 / 0] < [1] AS m, [1, 2] <= [1, 2] AS n, [1, {a: 1}] < [2, {a: 1}] AS o, [1] < 'a' AS p"],
    ['< of maps is NULL', 'RETURN {a: 1} < {a: 2} AS a, {a: 1} >= {a: 1} AS b, [{a: 1}] < [{a: 2}] AS c'],
    ['< of properties of every kind', 'MATCH (n:V), (m:V) WHERE n.k < m.k RETURN n.k AS a, m.k AS b, n.v < m.v AS l, n.v >= m.v AS ge ORDER BY a, b'],
    ['< in a list comprehension, reading its elements', 'RETURN [x IN [[1, 2], [3]] | [y IN x WHERE [y] < x]] AS a, [x IN [[1, 2], [3]] | [y IN [[1], [3]] WHERE y <= [x[0]]]] AS b'],
    // ORDER BY, min and max: Cypher's order of kinds, lists element by element.
    ['ORDER BY lists, nested and mixed', "UNWIND [[1, 2], [1], [], [1, null], [null], [1, 'a'], ['a'], [true], [[1]], [[1, 2]], [[]], [0.0 / 0], [1.5], [2], [1, 2, 3], null, 1, 'a', [[[[1]]]], [[[[0]]]]] AS x RETURN x ORDER BY x"],
    ['ORDER BY lists DESC', "UNWIND [[1, 2], [1], [], [1, null], [null], [1, 'a'], ['a'], [true], [[1]], [[1, 2]], [[]], [0.0 / 0], [1.5], [2], [1, 2, 3], null, 1, 'a'] AS x RETURN x ORDER BY x DESC"],
    ['ORDER BY properties', 'MATCH (n:V) RETURN n.k AS k ORDER BY n.v, k'],
    ['ORDER BY a list of a static type', "MATCH (n:V) WHERE n.k STARTS WITH 'list' RETURN n.k AS k ORDER BY [size(n.v), 0 - size(n.v)] DESC, [n.k] DESC"],
    ['min and max of lists', "UNWIND [[1, 2], [1], [], [2, 0], [1, null]] AS x WITH x, [x, 'a'] AS y RETURN min(x) AS lo, max(x) AS hi, min(y) AS ly, max(y) AS hy"],
    ['min and max of properties', 'MATCH (n:V) RETURN min(n.v) AS lo, max(n.v) AS hi'],
    // + of lists: joined, a value appended or prepended (NULL too).
    ['+ of lists and values', "RETURN [1, 2] + [3] AS a, [1] + 2 AS b, 0 + [1] AS c, [1] + null AS d, null + [1] AS e, [] + [] AS f, [1] + ['a'] AS g, [true] + [1] AS h, [[1]] + [[2]] AS i, [1] + [[2]] AS j, ['a'] + true AS k, 'a' + [1] AS l, [1] + {a: 1} AS m, [[1, [2, [3, [4, [5]]]]]] + [[6]] AS n"],
    ['+ of properties and lists', "MATCH (n:V) RETURN n.k AS k, n.v + [9] AS a, [9] + n.v AS b, null + n.v AS d, n.v + null AS e ORDER BY k"],
    ['+ of lists from properties', "MATCH (n:V) WHERE n.k IN ['list', 'empty', 'floats', 'strs', 'bools'] RETURN n.k AS k, n.v + n.v AS c ORDER BY k"],
    ['UNWIND of + of lists', 'UNWIND [1, 2] + [3] AS x RETURN x'],
    // + of a string and a number or a boolean: JavaScript's String().
    ['+ of a string and a number or a boolean', "RETURN 'a' + 1 AS a, 'a' + 1.5 AS b, 'a' + 1.0 AS c, 'a' + true AS d, false + 'b' AS e, 'a' + 1e21 AS f, 'a' + 123456789012345680000 AS g, 'a' + (0.0 / 0) AS h, 'a' + (1.0 / 0) AS i, 'a' + (-1.0 / 0) AS j, 'a' + 1e-7 AS k, 'a' + 0.1 AS l, 'a' + (1.0 / 3) AS m, 'a' + -0.0 AS n, 'a' + 9007199254740993 AS o, 'a' + 1.7976931348623157e308 AS p, 'a' + -2.5e25 AS q, 2 + 'b' AS r, 'a' + null AS s, null + 'a' AS t, 'a' + 5e-324 AS u, 'a' + 1e16 AS v"],
    ['+ of strings and properties', "MATCH (n:V) WHERE NOT n.k IN ['list', 'list2', 'list3', 'empty', 'floats', 'strs', 'bools'] RETURN n.k AS k, 'x' + n.v AS a, n.v + 'x' AS b ORDER BY k"],
    // % of floats: JavaScript's, the sign of the dividend; NaN by zero, but for two whole numbers.
    ['% of floats', 'RETURN 5.5 % 2 AS a, -5.5 % 2 AS b, 5.5 % -2 AS c, -5.5 % -2 AS d, 5.5 % 0 AS e, (0.0 / 0) % 2 AS f, 5 % (1.0 / 0) AS g, (1.0 / 0) % 2 AS h, 7 % 2.5 AS i, 1e300 % 7 AS j, -4.5 % 4.5 AS k, 7 % 3 AS l, -7 % 3 AS m, null % 2.5 AS n, 2.5 % null AS o, 2.5 % -0.0 AS p'],
    ['% of properties', "MATCH (n:V) WHERE n.k IN ['int', 'float', 'zero', 'neg', 'big', 'huge'] RETURN n.k AS k, n.v % 3 AS a, 10 % (n.v + 0.5) AS b, n.v % 1.5 AS c, n.v % -0.5 AS d, n.v % 7.5 AS e ORDER BY k"],
  ])('%s', (_name, cypher) => {
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });

  // Errors, the same on both engines.
  test.each([
    ['% by zero of whole numbers', "MATCH (n:V) WHERE n.k = 'int' RETURN n.v % 0 AS m"],
    ['% by zero of a float with a whole value', "MATCH (n:V) WHERE n.k = 'float' RETURN (n.v * 2) % 0 AS m"],
    ['+ of a list and a map: still a type error elsewhere', "MATCH (n:V) WHERE n.k = 'true' RETURN n.v + {a: 1} AS p"],
  ])('both engines raise the same error: %s', (_name, cypher) => {
    const error = (run: () => unknown) => {
      try {
        run();
      } catch (e) {
        return { code: (e as { code: string }).code, message: (e as Error).message };
      }
      return undefined;
    };
    const mine = error(() => g.query(cypher));
    expect(mine?.code).toBe('SMALTCY_TYPE');
    expect(error(() => onSmaltdb(db, tables, cypher))).toEqual(mine);
  });

  test('% of floats by zero is NaN', () => {
    const cypher = "MATCH (n:V) WHERE n.k IN ['float', 'neg'] RETURN n.v % 0 AS m";
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });

  test("+ of a string and a number: String()'s digits, for numbers of every size", () => {
    // Doubles from 1e-300 to 1e300, whole numbers beyond 2^53, and numbers with up to 17 significant digits.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const xs: number[] = [2 ** 53, 2 ** 53 + 2, 1e21, 1e21 - 65536, 2 ** 1023, Number.MAX_VALUE, 1.5e16, 5e-324];
    for (let i = 0; i < 300; i++) {
      let x = random() * 10 * 10 ** (Math.floor(random() * 600) - 300);
      if (i % 3 === 0) x = Math.round(random() * 2 ** 53) * 2 ** Math.floor(random() * 200);
      if (i % 5 === 0) x = Number((random() * 10).toPrecision(1 + Math.floor(random() * 17))) * 10 ** Math.floor(random() * 40);
      xs.push(i % 2 ? -x : x);
    }
    const cypher = "RETURN '' + $x AS s";
    for (const x of xs) expect(onSmaltdb(db, tables, cypher, { x }), String(x)).toEqual(g.query(cypher, { x }));
  });

  // What the compiler refuses when a row reaches it, where smaltcy gives a value: lists and maps nested deeper than it
  // compares them, and maps in ORDER BY, which smaltcy orders by a text of their entries.
  test.each([
    ['= of lists nested five deep', 'RETURN [[[[[1]]]]] = [[[[[1]]]]] AS a', 'lists and maps nested more than 4 deep'],
    ['< of lists nested five deep', 'RETURN [[[[[1]]]]] < [[[[[2]]]]] AS a', 'lists and maps nested more than 4 deep'],
    ['ORDER BY lists nested five deep', 'UNWIND [[[[[1]]]], [[[[[2]]]]]] AS x RETURN x ORDER BY x', 'lists and maps nested more than 4 deep'],
    ['ORDER BY maps', 'UNWIND [{a: 1}, {a: 2}] AS m RETURN m ORDER BY m', 'ordering maps'],
    ['ORDER BY lists of maps', 'UNWIND [[{a: 1}], [{a: 2}]] AS m RETURN m ORDER BY m', 'ordering maps'],
    ['max of maps', 'UNWIND [{a: 1}, {a: 2}] AS m RETURN max(m) AS m', 'ordering maps'],
  ])('refused when met: %s', (_name, cypher, feature) => {
    expect(() => g.query(cypher)).not.toThrow();
    let error: unknown;
    try {
      onSmaltdb(db, tables, cypher);
    } catch (e) {
      error = e;
    }
    expect({ code: (error as { code: string }).code, message: (error as Error).message }).toEqual({ code: 'SMALTCY_UNSUPPORTED', message: new Unsupported(feature).message });
  });

  test('lists nested four deep compare', () => {
    const cypher = 'RETURN [[[[1]]]] = [[[[1]]]] AS a, [[[[1]]]] < [[[[1, 2]]]] AS b, [[[[1, null]]]] = [[[[1, null]]]] AS c';
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });
});

/** Relationships: self-loops, parallel relationships of two types, an isolated node. */
const RELS = `CREATE (a:N {k: 'a'}), (b:N {k: 'b'}), (c:N:M {k: 'c'}), (d:M {k: 'd'}),
  (a)-[:R {w: 1}]->(b), (b)-[:R {w: 2}]->(c), (c)-[:R {w: 3}]->(a), (a)-[:R {w: 4}]->(a),
  (a)-[:S {w: 5, f: true}]->(b), (b)-[:S {w: 6}]->(b), (c)-[:R {w: 7}]->(b)`;

/** Queries over `RELS`. */
const REL_CASES: [string, string][] = [
  ['one hop out', "MATCH (x {k: 'a'})-[r]->(y) RETURN r.w AS w, y.k AS y ORDER BY w"],
  ['one hop in', "MATCH (x {k: 'b'})<-[r]-(y) RETURN r.w AS w, y.k AS y ORDER BY w"],
  ['either direction: a self-loop once', "MATCH (x {k: 'a'})-[r]-(y) RETURN r.w AS w, y.k AS y ORDER BY w"],
  ['self-loops, either direction', 'MATCH (x)-[r]-(x) RETURN x.k AS x, r.w AS w ORDER BY w'],
  ['self-loops, directed', 'MATCH (x)-[r]->(x) RETURN x.k AS x, r.w AS w ORDER BY w'],
  ['uniqueness: a path never uses a relationship twice', 'MATCH (x)-[r1]-(y)-[r2]-(z) RETURN x.k AS x, r1.w AS a, r2.w AS b, z.k AS z ORDER BY a, b, x, z'],
  ['uniqueness across the patterns of one MATCH', 'MATCH (x)-[r1:R]->(y), (u)-[r2:R]->(v) RETURN count(*) AS n'],
  ['no uniqueness across MATCH clauses', 'MATCH (x)-[r1:R]->(y) MATCH (u)-[r2:R]->(v) RETURN count(*) AS n'],
  ['uniqueness between types that may be the same', 'MATCH (x)-[r1]->(y)-[r2:S]->(z) RETURN r1.w AS a, r2.w AS b ORDER BY a, b'],
  ['type alternatives', 'MATCH (x)-[r:R|S]->(y) RETURN type(r) AS t, r.w AS w ORDER BY w'],
  ['a type the graph lacks', 'MATCH ()-[r:S|NOPE]->() RETURN r.w AS w ORDER BY w'],
  ['only a type the graph lacks', 'MATCH ()-[r:NOPE]->() RETURN count(*) AS n'],
  ['a relationship property map', 'MATCH (x)-[r {w: 2}]->(y) RETURN x.k AS x, y.k AS y'],
  ['a boolean in a relationship property map', 'MATCH ()-[r {f: true}]->() RETURN r.w AS w'],
  ['a cycle of three', 'MATCH (x)-[:R]->(y)-[:R]->(z)-[:R]->(x) RETURN x.k AS x, y.k AS y, z.k AS z ORDER BY x'],
  ['labels on both ends', 'MATCH (x:N)-[r]->(y:M) RETURN x.k AS x, r.w AS w ORDER BY w'],
  ['OPTIONAL MATCH with WHERE', 'MATCH (x:N) OPTIONAL MATCH (x)-[r:R]->(y) WHERE r.w > 2 RETURN x.k AS x, y.k AS y, r.w AS w ORDER BY x, w'],
  ['OPTIONAL MATCH, then count', 'MATCH (x) OPTIONAL MATCH (x)<-[r:S]-(y) RETURN x.k AS x, count(r) AS n ORDER BY x'],
  ['OPTIONAL MATCH between bound nodes', "MATCH (x {k: 'a'}), (y {k: 'c'}) OPTIONAL MATCH (x)-[r]-(y) RETURN r.w AS w ORDER BY w"],
  ['OPTIONAL MATCH of a chain', 'MATCH (x:M) OPTIONAL MATCH (x)-[:R]->(y)-[:R]->(z) RETURN x.k AS x, y.k AS y, z.k AS z ORDER BY x, y, z'],
  ['OPTIONAL MATCH on a NULL node', "OPTIONAL MATCH (x {k: 'none'}) OPTIONAL MATCH (x)-[r]->(y) RETURN x.k AS x, r.w AS w"],
  ['relationships compared, and NULL', 'MATCH (x)-[r1]->(y) OPTIONAL MATCH (y)-[r2]->(x) RETURN r1.w AS a, r2.w AS b, r2 IS NULL AS none, r1 = r2 AS same ORDER BY a, b'],
  ['id, startNode, endNode and properties', 'MATCH (x)-[r:S]->(y) RETURN id(r) AS id, startNode(r).k AS s, endNode(r).k AS e, properties(r) AS p ORDER BY id'],
  ['relationships and nodes in results', 'MATCH (x:M)<-[r]-(y) RETURN x, r, y ORDER BY r.w'],
  ['DISTINCT relationships', 'MATCH (x)-[r]-(y) WITH DISTINCT r RETURN count(*) AS n'],
  ['counts by type', 'MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS n, sum(r.w) AS s ORDER BY t'],
  ['degree', "MATCH (x) RETURN x.k AS x, degree(x) AS d, degree(x, 'out') AS o, degree(x, 'in', 'R') AS i ORDER BY x"],
  ['WITH, then a hop from the bound node', 'MATCH (x:N) WITH x ORDER BY x.k LIMIT 2 MATCH (x)-[r:R]->(y) RETURN x.k AS x, y.k AS y ORDER BY x, y'],
  ['a hop from the far end, whose property map is the selective part', "MATCH (x)-[r]-(y {k: 'b'}) RETURN x.k AS x, r.w AS w"],
  ['a hop from the end WHERE finds', "MATCH (x)-[r:R|S]-(y) WHERE y.k = 'c' RETURN x.k AS x, r.w AS w"],
  ['a hop from the far end, counted', "MATCH (x)-[r]-(y {k: 'b'}) RETURN count(*) AS n, count(DISTINCT x) AS d, count(DISTINCT id(r)) AS r"],
  ['a hop from the end WHERE finds, counted', "MATCH (x:N)-[r:R|S]-(y) WHERE y.k = 'c' RETURN count(x) AS n, count(DISTINCT id(r)) AS r"],
  ['hops from a row, a label, then a hop of one type', "MATCH (x {k: 'a'})-[r1]-(y:N)-[r2:R]->(z {k: 'c'}) RETURN r1.w AS a, y.k AS y, r2.w AS b"],
  ['a hop from a row to a bound node', "MATCH (x {k: 'a'}), (y {k: 'b'}) MATCH (x)-[r]-(y) RETURN r.w AS w"],
  ['a hop from a row, collected', "MATCH (x {k: 'b'})-[r:R]-(y) RETURN collect(r.w) AS ws, collect(y.k) AS ys"],
  ['a hop from a row, the rows a LIMIT keeps', "MATCH (x {k: 'c'})-[r]-(y)-[q]-(z) RETURN r.w AS a, q.w AS b, z.k AS z LIMIT 4"],
  ['variable length from zero', "MATCH (x {k: 'd'})-[*0..3]-(y) RETURN y.k AS y"],
  // Where the order doesn't show (counts, EXISTS), a search from each row rather than `paths`.
  ['variable length, counted', "MATCH (x {k: 'a'})-[*1..2]-(y) RETURN count(*) AS n, count(DISTINCT y) AS d"],
  ['variable length of two types, counted', "MATCH (x {k: 'a'})-[:R|S*1..3]-(y) RETURN count(*) AS n, count(DISTINCT y) AS d, count(DISTINCT id(y)) AS i"],
  ['variable length, unbounded trails, counted', 'MATCH (x)-[:R*]->(y) RETURN count(*) AS n, count(y) AS c'],
  ['variable length in, counted', "MATCH (x {k: 'a'})<-[*1..3]-(y) RETURN count(*) AS n"],
  ['variable length from zero, counted', 'MATCH (x)-[*0..2]-(y) RETURN count(*) AS n, count(DISTINCT y) AS d'],
  ['variable length from the far end, counted', "MATCH (y {k: 'a'}) MATCH (x)-[*1..2]->(y) RETURN count(*) AS n, count(DISTINCT x) AS d"],
  ['variable length with properties, counted', 'MATCH (x)-[rs:R*1..3 {w: 2}]->(y) RETURN count(*) AS n, count(rs) AS r'],
  ['variable length, its relationships counted', "MATCH (x {k: 'b'})-[rs*1..2]-(y) RETURN count(rs) AS n, count(*) AS c"],
  ['variable length and a fixed hop, counted', "MATCH (x {k: 'a'})-[r:R]->(y)-[rs:R*1..2]->(z) RETURN count(*) AS n, count(DISTINCT z) AS d"],
  ['variable length, then a hop, counted', "MATCH (x {k: 'a'})-[:R*1..2]-(y)-[r]-(z) RETURN count(*) AS n, count(DISTINCT z) AS d, count(r) AS r"],
  ['variable length to a labelled node, counted', "MATCH (x {k: 'c'})-[*1..3]-(y:N) RETURN count(*) AS n"],
  ['variable length in EXISTS', "MATCH (x) WHERE EXISTS { (x)-[:R*2..2]->() } RETURN x.k AS x ORDER BY x"],
  ['variable length from a NULL node, counted', "OPTIONAL MATCH (x {k: 'none'}) OPTIONAL MATCH (x)-[*0..2]-(y) RETURN count(y) AS n, count(*) AS c"],
  ['hops whose far ends are only counted', "MATCH (x {k: 'a'})-[r]-()-[q]-(z) RETURN count(z) AS n, count(DISTINCT z) AS d, count(DISTINCT id(z)) AS i, count(q) AS q"],
  ['variable length with properties', 'MATCH (x)-[rs:R*1..3 {w: 2}]->(y) RETURN x.k AS x, y.k AS y, size(rs) AS n ORDER BY x, y'],
  ['variable length of a type the graph lacks', 'MATCH (x)-[:NOPE*0..1]->(y) RETURN x.k AS x, y.k AS y ORDER BY x'],
  ['a named path in results', "MATCH p = (x {k: 'c'})-[:R*1..2]->(y {k: 'a'}) RETURN p ORDER BY length(p)"],
  ['shortest path', "MATCH (x {k: 'c'}), (y {k: 'b'}), p = shortestPath((x)-[*]->(y)) RETURN length(p) AS len, [n IN nodes(p) | n.k] AS ks"],
  ['shortest path to the same node', "MATCH (x {k: 'a'}), p = shortestPath((x)-[*0..]->(x)) RETURN length(p) AS len"],
  ['collect of nodes', "MATCH (x:N) WITH collect(x) AS xs RETURN size(xs) AS n, [x IN xs | x.k] AS ks, xs"],
];

describe('relationships: both engines give the same rows', () => {
  const g = open();
  g.run(RELS);
  const { db, tables } = both(g);
  test.each(REL_CASES)('%s', (_name, cypher) => {
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });

  // Ordered by lists too (Cypher's order of lists, element by element).
  test.each([
    ['variable length: trails', "MATCH (x {k: 'a'})-[rs:R*]->(y) RETURN y.k AS y, [r IN rs | r.w] AS ws ORDER BY y, ws"],
    ['variable length, either direction: a self-loop once', "MATCH (x {k: 'a'})-[rs*1..2]-(y) RETURN y.k AS y, [r IN rs | r.w] AS ws ORDER BY y, ws"],
    ['variable length from the far end', "MATCH (x)-[rs:R*2]->(y {k: 'b'}) RETURN x.k AS x, [r IN rs | r.w] AS ws ORDER BY x, ws"],
    ['variable length and a fixed hop: no relationship twice', "MATCH (x {k: 'a'})-[r:R]->(y)-[rs:R*1..2]->(z) RETURN r.w AS w, [q IN rs | q.w] AS ws ORDER BY w, ws"],
    ['a named path', "MATCH p = (x {k: 'c'})-[:R]->(y)-[:R]->(z) RETURN length(p) AS len, [n IN nodes(p) | n.k] AS ks, [r IN relationships(p) | type(r)] AS ts ORDER BY ks, ts"],
    ['all shortest paths, either direction', "MATCH (x {k: 'a'}), (y {k: 'c'}), p = allShortestPaths((x)-[*]-(y)) RETURN length(p) AS len, [r IN relationships(p) | r.w] AS ws ORDER BY ws DESC"],
  ])('%s, ordered by a list', (_name, cypher) => {
    const rows = g.query(cypher);
    expect(rows.length).toBeGreaterThan(0);
    expect(onSmaltdb(db, tables, cypher)).toEqual(rows);
  });

  // The same rows, in any order.
  const sorted = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
  test("a variable-length relationship's hops are not bound again by a later hop (Cypher's uniqueness)", () => {
    const cypher = "MATCH (x {k: 'a'})-[rs:R*1..2]-(y)-[r:R]-(z) RETURN [q IN rs | q.w] AS ws, r.w AS w";
    const rows = g.query(cypher) as { ws: number[]; w: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => !row.ws.includes(row.w))).toBe(true);
    expect(sorted(onSmaltdb(db, tables, cypher))).toEqual(sorted(rows));
  });

  test('id(r) and relationships in results are refused when the graph was loaded without relationship ids', () => {
    const data = dumpGraph(g.store);
    const t = graphTablesFor(data);
    expect(t.relationshipIds).toBe(false);
    expect(() => compileQuery(compile('MATCH ()-[r]->() RETURN id(r) AS id').plan, t)).toThrow(Unsupported);
    expect(() => compileQuery(compile('MATCH ()-[r]->() RETURN r').plan, t)).toThrow(Unsupported);
    expect(graphTablesFor(dataOf(g)).relationshipIds).toBe(true);
  });
});

/** EXISTS, pattern predicates and pattern comprehensions: nested plans, correlated with the row they are run from. */
describe('nested plans: both engines give the same rows', () => {
  const g = open();
  g.run(RELS);
  const { db, tables } = both(g);
  test.each([
    ['EXISTS on a node', 'MATCH (x) WHERE EXISTS { MATCH (x)-[:S]->() } RETURN x.k AS x ORDER BY x'],
    ['a negated pattern predicate', 'MATCH (x) WHERE NOT (x)-->() RETURN x.k AS x ORDER BY x'],
    ['a pattern predicate between bound nodes', 'MATCH (x), (y) WHERE x.k < y.k AND (x)-[:R]-(y) RETURN x.k AS x, y.k AS y ORDER BY x, y'],
    ['a pattern predicate with labels and properties', "MATCH (x) WHERE (x)-[{w: 2}]->(:N:M {k: 'c'}) RETURN x.k AS x"],
    ['EXISTS with a WHERE that reads an outer relationship', 'MATCH (x)-[r]->(y) WHERE EXISTS { MATCH (y)-[s]->(z) WHERE s.w > r.w } RETURN r.w AS w ORDER BY w'],
    ['NOT EXISTS, correlated on both ends of a relationship', 'MATCH (x)-[r:R]->(y) WHERE NOT EXISTS { MATCH (y)-[:R]->(x) } RETURN r.w AS w ORDER BY w'],
    ['EXISTS and a pattern predicate as values', 'MATCH (x) RETURN x.k AS x, EXISTS { MATCH (x)<-[:S]-() } AS e, (x)-[:R]->(x) AS loop ORDER BY x'],
    ['EXISTS with a variable-length relationship', 'MATCH (x) WHERE EXISTS { MATCH (x)-[:R*2]->(x) } RETURN x.k AS x ORDER BY x'],
    ['EXISTS inside EXISTS', 'MATCH (x) WHERE EXISTS { MATCH (x)-->(y) WHERE EXISTS { MATCH (y)-[:S]->(y) } } RETURN x.k AS x ORDER BY x'],
    ['EXISTS in an OPTIONAL MATCH', 'MATCH (x:N) OPTIONAL MATCH (x)-[r]->(y) WHERE (y)-[:S]->() RETURN x.k AS x, r.w AS w ORDER BY x, w'],
    ['EXISTS of a NULL node', "OPTIONAL MATCH (x {k: 'none'}) RETURN EXISTS { MATCH (x)-->() } AS e, [(x)-->(y) | y.k] AS ys"],
    ['EXISTS after WITH', 'MATCH (x) WITH x.k AS k, x WHERE (x)-[:S]-() RETURN k ORDER BY k'],
    ['a pattern comprehension in WHERE', 'MATCH (x) WHERE size([(x)-->(y) | y]) > 1 RETURN x.k AS x ORDER BY x'],
    ['a pattern comprehension in ORDER BY', 'MATCH (x) RETURN x.k AS k ORDER BY size([(x)-->() | 1]) DESC, k'],
    ['a pattern comprehension in an aggregate', 'MATCH (x) RETURN sum(size([(x)-->() | 1])) AS n, collect(EXISTS { MATCH (x)-[:S]->() }) AS es'],
  ])('%s', (_name, cypher) => {
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });

  // A pattern comprehension's list is in the order its pattern matches, which Cypher leaves open as it does a MATCH's:
  // smaltdb's goes by type, then by relationship; smaltcy's store by relationship id. The same elements, in any order.
  // (Elements compared by their JSON with keys sorted: a smaltdb map keeps its keys sorted.)
  const canon = (x: unknown): string =>
    JSON.stringify(x, (_k, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => (p < q ? -1 : 1))) : v));
  const sortedLists = (rows: Record<string, unknown>[]) =>
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.map(canon).sort() : v])));
  test.each([
    ['a pattern comprehension', 'MATCH (x) RETURN x.k AS x, [(x)-[r]->(y) | r.w] AS ws ORDER BY x'],
    ['a pattern comprehension with WHERE', 'MATCH (x) RETURN x.k AS x, [(x)-[r]->(y) WHERE r.w > 2 | y.k] AS ys ORDER BY x'],
    ['a pattern comprehension reading an outer relationship', 'MATCH (x)-[r]->(y) RETURN r.w AS w, [(y)-[q]->(z) WHERE q.w > r.w | q.w] AS later ORDER BY w'],
    ['a pattern comprehension giving nodes', 'MATCH (x:N) RETURN x.k AS x, [(x)<-[:R]-(y) | y] AS ys ORDER BY x'],
    ['a pattern comprehension giving lists and NULLs', "MATCH (x {k: 'c'}) RETURN [(x)-->(y) | labels(y)] AS ls, [(x)-->(y) | y.nope] AS ns"],
    ['a pattern comprehension of a chain', "MATCH (x {k: 'a'}) RETURN [(x)-[:R]->(y)-[:R]->(z) | z.k] AS zs"],
    ['a pattern comprehension in either direction', 'MATCH (x) RETURN x.k AS x, [(x)-[r]-(y) | r.w] AS ws ORDER BY x'],
    ['a pattern comprehension of a variable-length relationship', 'MATCH (x) RETURN x.k AS x, [(x)-[:R*1..2]->(y) | y.k] AS ys ORDER BY x'],
  ])('%s (its lists in any order)', (_name, cypher) => {
    const rows = g.query(cypher) as Record<string, unknown>[];
    expect(rows.some((r) => Object.values(r).some((v) => Array.isArray(v) && v.length > 1))).toBe(true);
    expect(sortedLists(onSmaltdb(db, tables, cypher))).toEqual(sortedLists(rows));
  });

  test('refused: nested plans inside list comprehensions, and pattern comprehensions giving relationships', () => {
    // smaltdb's nested plans don't read an `each`'s elements.
    expect(() => onSmaltdb(db, tables, "MATCH (x) RETURN [k IN ['a', 'b'] | size([(x)-->(y) WHERE y.k = k | 1])] AS n")).toThrow(Unsupported);
    expect(() => onSmaltdb(db, tables, 'MATCH (x) RETURN [(x)-[r]->() | r] AS rs')).toThrow(Unsupported);
  });
});

/** Labels and relationship types that differ only in case: two of each, as in Cypher (smaltdb's graphs are case-sensitive). */
const CASES = `CREATE (a:Person {k: 'a'}), (b:person {k: 'b'}), (c:Person:person {k: 'c'}), (d:PERSON {k: 'd'}),
  (a)-[:KNOWS {w: 1}]->(b), (b)-[:knows {w: 2}]->(c), (c)-[:KNOWS {w: 3}]->(a), (a)-[:knows {w: 4}]->(d), (d)-[:Knows {w: 5}]->(a)`;

describe('labels and types that differ only in case: both engines give the same rows', () => {
  const g = open();
  g.run(CASES);
  const { db, tables } = both(g);
  test('each spelling is a label and a type of its own in smaltdb, with a table of its own', () => {
    expect([...tables.labelTables.keys()]).toEqual(['Person', 'person', 'PERSON']);
    expect([...tables.types.keys()]).toEqual(['KNOWS', 'knows', 'Knows']);
    const names = [...tables.labelTables.values(), ...tables.types.values()].map((n) => n.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(db.catalog.graph('graph')!.nodes.map((n) => n.label)).toEqual(['smaltcy:node', 'Person', 'person', 'PERSON']);
    expect(db.catalog.graph('graph')!.edges.map((e) => e.type)).toEqual(['KNOWS', 'knows', 'Knows']);
  });
  test.each([
    ['each label', 'MATCH (n:Person) RETURN n.k AS k ORDER BY k'],
    ['the other spelling', 'MATCH (n:person) RETURN n.k AS k ORDER BY k'],
    ['both labels', 'MATCH (n:Person:person) RETURN n.k AS k'],
    ['a spelling no node has', 'MATCH (n:PERSON) RETURN n.k AS k'],
    ['a spelling the graph lacks', 'MATCH (n:PeRsOn) RETURN n.k AS k'],
    ['labels in order', 'MATCH (n) RETURN n.k AS k, labels(n) AS l ORDER BY k'],
    ['label tests', 'MATCH (n) RETURN n.k AS k, n:Person AS a, n:person AS b, n:PERSON AS c ORDER BY k'],
    ['each type', 'MATCH (x)-[r:KNOWS]->(y) RETURN r.w AS w, x.k AS x, y.k AS y ORDER BY w'],
    ['the other spelling of a type', 'MATCH (x)-[r:knows]->(y) RETURN r.w AS w, type(r) AS t ORDER BY w'],
    ['type alternatives', 'MATCH ()-[r:KNOWS|Knows]->() RETURN r.w AS w, type(r) AS t ORDER BY w'],
    ['a type the graph lacks', 'MATCH ()-[r:kNoWs]->() RETURN r.w AS w'],
    ['every relationship and its type', 'MATCH ()-[r]->() RETURN r.w AS w, type(r) AS t ORDER BY w'],
    ['variable length over one spelling', "MATCH (a {k: 'a'})-[:KNOWS*1..3]->(b) RETURN b.k AS k ORDER BY k"],
    ['a pattern with labels and types of both spellings', 'MATCH (a:Person)-[:knows]->(b:person) RETURN a.k AS a, b.k AS b ORDER BY a, b'],
    ['EXISTS with one spelling', 'MATCH (n) WHERE EXISTS { (n)-[:knows]->(:person) } RETURN n.k AS k ORDER BY k'],
  ])('%s', (_name, cypher) => {
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });
});

describe('the graph in smaltdb', () => {
  test('nodes, labels in order, and relationships by type', () => {
    const { db, tables } = both(social());
    expect(db.queryPlan({ kind: 'query', plan: { op: 'scan', table: tables.nodes, columns: [0] } }).rows).toHaveLength(7);
    expect(onSmaltdb(db, tables, "MATCH (p {name: 'Grace'}) RETURN labels(p) AS l, id(p) AS id")).toEqual([{ l: ['Person', 'Admiral'], id: 2 }]);
    const knows = tables.types.get('KNOWS')!;
    expect(db.queryPlan({ kind: 'query', plan: { op: 'scan', table: knows, columns: [0, 1, 2] } }).rows[0]).toEqual([0, 1, { since: 1833 }]);
    expect(db.catalog.graph('graph')!.nodes.map((n) => n.label)).toEqual(['smaltcy:node', 'Person', 'Admiral', 'City']);
  });

  test('the reserved label is refused', () => {
    const h = open();
    h.run('CREATE (:`smaltcy:node`)');
    expect(() => graphTablesFor(dumpGraph(h.store))).toThrow(/reserved/);
  });

  test('a graph without relationships: no edge tables, no rows', () => {
    const { g, db, tables } = both((() => { const h = open(); h.run('CREATE (:A {k: 1})'); return h; })());
    expect(tables.types.size).toBe(0);
    for (const cypher of ['MATCH p = (x)-[*0..1]->(y) RETURN p', 'MATCH (x)-->(y) RETURN count(*) AS n', 'MATCH (x) RETURN [(x)--(y) | y.k] AS ys, (x)--() AS e']) {
      expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
    }
  });

  test('parameters are typed by their values', () => {
    const { db, tables } = both(social());
    expect(onSmaltdb(db, tables, 'MATCH (p:Person) WHERE p.born > $y AND $flag RETURN count(*) AS n', { y: 1925, flag: true })).toEqual([{ n: 2 }]);
    expect(() => compileQuery(compile('RETURN $nope AS x').plan, tables)).toThrow(Unsupported);
  });
});

/**
 * Comparisons of a property (a value of any kind) with a string or number literal compile to smaltdb's own comparison
 * where it has Cypher's meaning (`=`: false across kinds; `<`: NULL across kinds and for NaN), so smaltdb can estimate
 * them and seek with an index. Values of every kind, with and without an index on the property.
 */
const KINDS = `CREATE (:T {k: 'int1', v: 1}), (:T {k: 'float1', v: 1.0}), (:T {k: 'float', v: 1.5}), (:T {k: 'str1', v: '1'}),
  (:T {k: 'stra', v: 'a'}), (:T {k: 'strtrue', v: 'true'}), (:T {k: 'true', v: true}), (:T {k: 'false', v: false}),
  (:T {k: 'list', v: [1]}), (:T {k: 'liststr', v: ['a']}), (:T {k: 'none'}), (:T {k: 'zero', v: 0}), (:T {k: 'nan', v: 0.0 / 0.0}),
  (:T {k: 'negzero', v: -0.0}), (:T {k: 'inf', v: 1.0 / 0}), (:T {k: 'neginf', v: -1.0 / 0}), (:T {k: 'big', v: 9007199254740991})`;

describe('comparisons with literals: both engines give the same rows', () => {
  const g = open();
  g.run(KINDS);
  const { db, tables } = both(g);
  const cases: [string, string][] = [
    ['= of numbers and strings', "MATCH (n:T) RETURN n.k AS k, n.v = 1 AS a, n.v = 0 AS b, n.v = 1.5 AS c, n.v = '1' AS d, n.v = 'a' AS e, n.v = 'true' AS f, 1 = n.v AS g, n.v = 9007199254740991 AS h ORDER BY k"],
    ['<> of numbers and strings', "MATCH (n:T) RETURN n.k AS k, n.v <> 1 AS a, n.v <> 'a' AS b, 1.5 <> n.v AS c ORDER BY k"],
    ['< and > of numbers', 'MATCH (n:T) RETURN n.k AS k, n.v < 1 AS a, n.v >= 0 AS b, n.v > 1.5 AS c, 0 < n.v AS d, n.v <= -1 AS e ORDER BY k'],
    ['< and > of strings', "MATCH (n:T) RETURN n.k AS k, n.v < 'b' AS a, 'a' <= n.v AS b, n.v > '1' AS c ORDER BY k"],
    ['= in WHERE', 'MATCH (n:T) WHERE n.v = 1 RETURN n.k AS k ORDER BY k'],
    ['a string in WHERE', "MATCH (n:T) WHERE n.v = 'a' RETURN n.k AS k ORDER BY k"],
    ['a property map', 'MATCH (n:T {v: 0}) RETURN n.k AS k ORDER BY k'],
    ['a property map of a string', "MATCH (n:T {v: 'true'}) RETURN n.k AS k ORDER BY k"],
    ['a range in WHERE', 'MATCH (n:T) WHERE n.v > 0 AND n.v < 2 RETURN n.k AS k ORDER BY k'],
    ['a range of strings in WHERE', "MATCH (n:T) WHERE n.v >= '1' RETURN n.k AS k ORDER BY k"],
    ['IN a list of literals', "MATCH (n:T) WHERE n.v IN [1, 'a'] RETURN n.k AS k ORDER BY k"],
  ];
  test.each(cases)('%s', (_name, cypher) => {
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });
  test('with an index on the property: the same rows, and smaltdb seeks with it', () => {
    const h = open();
    h.run(KINDS);
    h.run("UNWIND range(1, 500) AS i CREATE (:U {k: 'filler', v: i + 1000})");
    const { db: idb, tables: it } = both(h);
    runOnSmaltdb(idb, compile('CREATE INDEX FOR (n:T) ON (n.v)').plan, it);
    for (const [, cypher] of cases) expect(onSmaltdb(idb, it, cypher), cypher).toEqual(h.query(cypher));
    const q = compileQuery(compile('MATCH (n:T) WHERE n.v = 1 RETURN n.k AS k').plan, it);
    const explained = idb.queryPlan({ kind: 'explain', mode: 'plan', query: q.statement } as never).rows.map((r) => r.join(' '));
    expect(explained.some((line) => line.includes('USING INDEX graph_ix_'))).toBe(true);
  });
});

/**
 * A parameter is compared as a literal of its kind is (a string, a whole number, a float): the same rows as smaltcy's
 * engine for a value of every kind, and a seek with an index on the property.
 */
describe('comparisons with parameters: both engines give the same rows', () => {
  const g = open();
  g.run(KINDS);
  const { db, tables } = both(g);
  const values: [string, unknown][] = [
    ['1', 1],
    ['0', 0],
    ['-0.0', -0],
    ['1.5', 1.5],
    ["'1'", '1'],
    ["'a'", 'a'],
    ["'true'", 'true'],
    ['the largest whole number held exactly', 9007199254740991],
    ['a whole number past it', 1e300],
    ['NaN', NaN],
    ['infinity', Infinity],
    ['true', true],
    ['null', null],
  ];
  const cases: [string, string][] = [
    ['=, <> and the orderings', 'MATCH (n:T) RETURN n.k AS k, n.v = $x AS a, $x = n.v AS b, n.v <> $x AS c, n.v < $x AS d, n.v >= $x AS e, $x < n.v AS f ORDER BY k'],
    ['= in WHERE', 'MATCH (n:T) WHERE n.v = $x RETURN n.k AS k ORDER BY k'],
    ['a property map', 'MATCH (n:T {v: $x}) RETURN n.k AS k ORDER BY k'],
    ['> in WHERE', 'MATCH (n:T) WHERE n.v > $x RETURN n.k AS k ORDER BY k'],
    ['<= in WHERE', 'MATCH (n:T) WHERE $x >= n.v RETURN n.k AS k ORDER BY k'],
  ];
  const all = values.flatMap(([name, x]) => cases.map(([what, cypher]): [string, string, unknown] => [`${what}, with ${name}`, cypher, x]));
  test.each(all)('%s', (_name, cypher, x) => {
    expect(onSmaltdb(db, tables, cypher, { x })).toEqual(g.query(cypher, { x }));
  });
  test('with an index on the property: the same rows, and smaltdb seeks with it', () => {
    const h = open();
    h.run(KINDS);
    h.run("UNWIND range(1, 500) AS i CREATE (:U {k: 'filler', v: i + 1000})");
    const { db: idb, tables: it } = both(h);
    runOnSmaltdb(idb, compile('CREATE INDEX FOR (n:T) ON (n.v)').plan, it);
    for (const [name, cypher, x] of all) expect(onSmaltdb(idb, it, cypher, { x }), name).toEqual(h.query(cypher, { x }));
    for (const x of [1, 1.5, 'a']) {
      const q = compileQuery(compile('MATCH (n:T) WHERE n.v = $x RETURN n.k AS k').plan, it, { params: { x } });
      const explained = idb.queryPlan({ kind: 'explain', mode: 'plan', query: q.statement } as never, [x]).rows.map((r) => r.join(' '));
      expect(explained.some((line) => line.includes('USING INDEX graph_ix_')), String(x)).toBe(true);
    }
  });
});

/**
 * A generated network (`network(300)`): the compiled MATCHes (join regions, unions of edge tables, nodes only a
 * relationship reaches, paths from each row, shortest paths by a search) give smaltcy's rows. Cypher leaves the order
 * of rows open without ORDER BY, and the two engines' orders differ where groups or paths are found in another order,
 * so rows are compared in any order.
 */
describe('a generated network: both engines give the same rows', () => {
  const g = open();
  g.load(network(300));
  const { db, tables } = both(g);
  const norm = (rows: unknown[]) => rows.map((r) => JSON.stringify(r, (_k, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(9) : v))).sort();
  test.each([
    ['one hop, either direction', 'MATCH (p:Person)-[:KNOWS]-(f) RETURN p.name AS p, f.name AS f'],
    ['one hop out', 'MATCH (p:Person)-[:KNOWS]->(f) RETURN p.name AS p, f.name AS f'],
    ['relationships with anonymous ends', 'MATCH ()-[r:KNOWS]->() RETURN id(r) AS r'],
    ['relationships of every type, both ways', 'MATCH (a)-[r]-(b) RETURN id(a) AS a, id(r) AS r, id(b) AS b'],
    ['an anonymous end, in', 'MATCH (a)<-[r]-() RETURN id(a) AS a, id(r) AS r'],
    ['two hops through an anonymous node', 'MATCH (p:Person {community: 1})-[:KNOWS]-()-[:KNOWS]-(f) RETURN p.name AS p, f.name AS f'],
    ['three hops', "MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]-()-[:KNOWS]-()-[:KNOWS]-(f) RETURN count(f) AS n, count(DISTINCT f) AS d"],
    ['triangles', 'MATCH (p:Person {community: 1})-[:KNOWS]->(b)-[:KNOWS]->(c), (p)-[:KNOWS]->(c) RETURN p.name AS p, b.name AS b, c.name AS c'],
    ['groups', 'MATCH (p:Person)-[:LIVES_IN]->(c:City) RETURN c.name AS c, count(p) AS n, avg(p.age) AS a'],
    ['variable length, either direction', 'MATCH (p:Person {community: 2})-[:KNOWS*1..2]-(f) RETURN p.name AS p, f.name AS f'],
    ['variable length, its relationships', 'MATCH (p:Person {community: 2})-[rs:KNOWS*1..2]->(f) RETURN p.name AS p, [r IN rs | id(r)] AS rs, f.name AS f'],
    ['variable length to an anonymous node', "MATCH (p:Person {name: 'Bo 1'})-[:KNOWS*1..3]-() RETURN count(*) AS n"],
    ['variable length, counted', 'MATCH (p:Person {community: 2})-[:KNOWS*1..3]-(f) RETURN count(*) AS n, count(DISTINCT f) AS d'],
    ['variable length out, from the far end, counted', "MATCH (f:Person {name: 'Bo 1'}) MATCH (p)-[:KNOWS*1..3]->(f) RETURN count(*) AS n, count(DISTINCT p) AS d"],
    ['a filter on a label scan', 'MATCH (p:Person) WHERE p.age > 70 RETURN p.name AS p'],
    ['OPTIONAL MATCH with WHERE', 'MATCH (p:Person) OPTIONAL MATCH (p)-[:KNOWS]->(q) WHERE q.age > 60 RETURN p.name AS p, q.name AS q'],
    ['a match from bound nodes', 'MATCH (p:Person) WITH p ORDER BY p.name LIMIT 20 MATCH (p)-[:KNOWS]-(q) RETURN p.name AS p, q.name AS q'],
    ['a pattern comprehension', 'MATCH (p:Person) RETURN p.name AS p, size([(p)-[:KNOWS]-(q) | q.name]) AS n'],
    ['shortest paths between pairs', 'MATCH (a:Person), (b:Person) WHERE id(a) < 12 AND id(a) > 8 AND id(b) < 40 AND id(b) > 20 MATCH p = shortestPath((a)-[:KNOWS*]-(b)) RETURN id(a) AS a, id(b) AS b, length(p) AS n'],
    ['shortest paths, directed and bounded', 'MATCH (a:Person), (b:Person) WHERE id(a) < 12 AND id(a) > 8 AND id(b) < 60 AND id(b) > 20 MATCH p = shortestPath((a)<-[:KNOWS*..4]-(b)) RETURN id(a) AS a, id(b) AS b, length(p) AS n'],
    ['all shortest paths, bounded', 'MATCH (a:Person), (b:Person) WHERE id(a) < 11 AND id(a) > 8 AND id(b) < 30 AND id(b) > 20 MATCH p = allShortestPaths((a)-[:KNOWS*..3]-(b)) RETURN id(a) AS a, id(b) AS b, length(p) AS n'],
    ['a named path', 'MATCH p = (a:Person {community: 3})-[:KNOWS]->(b)-[:LIVES_IN]->(c) RETURN [n IN nodes(p) | id(n)] AS ns'],
    ['type alternatives', 'MATCH (a)-[:KNOWS|LIVES_IN]->(b) RETURN id(a) AS a, id(b) AS b'],
    ['type alternatives, both ways, then a label', 'MATCH (a:Person)-[:KNOWS|LIVES_IN]-(b)-[:LIVES_IN]-(c:City) RETURN id(a) AS a, id(b) AS b, id(c) AS c'],
    ['a hop from a person, then a hop of one type', "MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]-(f)-[:LIVES_IN]->(c) RETURN f.name AS f, c.name AS c"],
    ['a hop from the far end', "MATCH (a)-[:KNOWS]-(b:Person {name: 'Bo 1'}) RETURN a.name AS a"],
    ['every type, both ways, from a node WHERE finds', "MATCH (p:Person)-[r]-(x) WHERE p.name = 'Bo 1' RETURN type(r) AS t, id(r) AS r, id(x) AS x"],
  ])('%s', (_name, cypher) => {
    const rows = g.query(cypher);
    expect(rows.length).toBeGreaterThan(0);
    expect(norm(onSmaltdb(db, tables, cypher))).toEqual(norm(rows));
  });

  test('a match whose order shows nowhere asks smaltdb for none', () => {
    const plan = JSON.stringify(compileQuery(compile("MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]-()-[:KNOWS]-(f) RETURN count(f) AS n").plan, tables).statement);
    expect(plan).not.toContain('"ordered"');
    expect(plan).not.toContain('"sort"');
    expect(plan).not.toContain('"window"');
  });

  test("a hop is one of smaltdb's relationships, whatever its direction and types", () => {
    const planOf = (cypher: string) => JSON.stringify(compileQuery(compile(cypher).plan, tables).statement);
    const count = (plan: string, part: string) => plan.split(part).length - 1;
    // Either way, and of any type: one FROM item each, with no union of tables and no search around it.
    for (const cypher of ["MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]-()-[r]-(f) RETURN count(f) AS n", "MATCH (p:Person {name: 'Bo 1'})<-[:KNOWS|LIVES_IN]-()-[:KNOWS]->(f) RETURN count(f) AS n"]) {
      const plan = planOf(cypher);
      expect(count(plan, '"op":"relationships"')).toBe(2);
      expect(plan).not.toContain('"op":"iterate"');
      expect(plan).not.toContain('"op":"setop"');
    }
    expect(planOf("MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]->(f) RETURN count(f) AS n")).toContain(`"op":"relationships","graph":"${tables.graph}","direction":"out","types":["KNOWS"]`);
    // Read from the end that is bound: here the pattern's `to` end, so the relationship is read as it comes in.
    expect(planOf("MATCH (p:Person {name: 'Bo 1'}) MATCH (f)-[:KNOWS]->(p) RETURN count(f) AS n")).toContain('"direction":"in"');
    // One type, one way, neither end bound: its table.
    const all = planOf('MATCH ()-[r:KNOWS]->() RETURN count(r) AS n');
    expect(all).not.toContain('"op":"relationships"');
    expect(all).toContain(`"table":"${tables.types.get('KNOWS')}"`);
    // A far node whose labels alone are asked for is an entry of the label index, not a row of the node table.
    const labelled = planOf("MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]-()-[:KNOWS]-(f:Person) RETURN count(f) AS n");
    expect(count(labelled, `"table":"${tables.nodes}"`)).toBe(1);
    expect(count(labelled, `"table":"${tables.labels}"`)).toBe(2);
    // Read, it is a row of the node table.
    expect(count(planOf("MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]-(f:Person) RETURN f.name AS n"), `"table":"${tables.nodes}"`)).toBe(2);
  });

  test("a variable-length relationship whose order shows nowhere is a search from each row, and a node only counted isn't read", () => {
    const walk = JSON.stringify(compileQuery(compile("MATCH (p:Person {name: 'Bo 1'})-[:KNOWS*1..3]-(f) RETURN count(DISTINCT f) AS n").plan, tables).statement);
    expect(walk).toContain('"name":"walk"');
    expect(walk).not.toContain('"op":"paths"');
    expect(walk).not.toContain('"sort"');
    // Its far node is only counted: the node table is read once, for the person found by name.
    expect(walk.split(`"table":"${tables.nodes}"`).length - 1).toBe(1);
    const hops = JSON.stringify(compileQuery(compile("MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]-()-[:KNOWS]-(f) RETURN count(f) AS n").plan, tables).statement);
    expect(hops.split(`"table":"${tables.nodes}"`).length - 1).toBe(1);
  });
});
