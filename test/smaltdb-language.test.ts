import { describe, expect, test } from 'vitest';
import { Database } from 'smaltdb-src/engine/database.js';
import { registeredLanguage, type LanguageStatement } from 'smaltdb-src/engine/plan/language.js';
import { parse } from '../src/cypher/index.js';
import { readsThePast } from '../src/cypher/parser.js';
import { open, SmaltcyError } from '../src/index.js';
import { Unsupported } from '../src/smaltdb/compile.js';
import { cypherLanguage } from '../src/smaltdb/language.js';
import { graphTables, graphTablesIn, LANGUAGE, schemaStatements } from '../src/smaltdb/schema.js';
import { latestVersion, runOnSmaltdb } from '../src/smaltdb/write.js';
import { social } from './helpers/graphs.js';
import { binds, both } from './helpers/smaltdb.js';

/**
 * Cypher as a language registered with smaltdb (src/smaltdb/language.ts; ADR 0004, "A language of smaltdb"): smaltdb's
 * entry points that take a statement's text take Cypher by the language's name, and smaltdb keeps what a statement
 * bound to. test/helpers/smaltdb.ts registers it, as an application does.
 */

const CYPHER = { language: LANGUAGE };
const NONE = { nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0, labelsAdded: 0, labelsRemoved: 0 };

describe('smaltdb reads Cypher', () => {
  test('the language is registered under its name, and binds to plan data', () => {
    const language = registeredLanguage(LANGUAGE);
    expect(LANGUAGE).toBe('cypher');
    expect(language?.name).toBe('cypher');
    expect(language?.plans).toBe('data');
    expect(cypherLanguage().name).toBe('cypher');
  });

  test('query, run, exec and prepare take a Cypher text by the name of the language', () => {
    const g = social();
    const { db } = both(g);
    const born = "MATCH (p:Person {name: 'Ada'}) RETURN p.born AS born";
    expect(db.query(born, undefined, CYPHER)).toMatchObject({ columns: ['born'], rows: [[1815]] });
    expect(db.prepare(born, CYPHER).all()).toEqual([[1815]]);
    // A write: `query` gives its rows and what it wrote; `run` and `exec` write as well.
    const made = db.query("CREATE (n:Made {i: 1}) RETURN n.i AS i, labels(n) AS labels", undefined, CYPHER);
    expect(made.rows).toEqual([[1, ['Made']]]);
    expect(made.graph).toEqual({ ...NONE, nodesCreated: 1, propertiesSet: 1, labelsAdded: 1 });
    db.run('CREATE (:Made {i: 2})', undefined, CYPHER);
    db.exec('CREATE (:Made {i: 3})', undefined, CYPHER);
    expect(db.query('MATCH (n:Made) RETURN n.i AS i ORDER BY i', undefined, CYPHER).rows).toEqual([[1], [2], [3]]);
    // No other language is registered: a text without the name is not read.
    expect(() => db.query(born)).toThrow();
  });

  test("a statement's parameters: by name, with or without the $, and by position", () => {
    const { db } = both(social());
    const q = 'MATCH (p:Person) WHERE p.name = $name AND p.born < $year RETURN p.born AS born';
    expect(db.query(q, { name: 'Ada', year: 1900 }, CYPHER).rows).toEqual([[1815]]);
    expect(db.query(q, { $name: 'Ada', $year: 1900 }, CYPHER).rows).toEqual([[1815]]);
    // By position: in the order the statement first reads them.
    expect(db.query(q, ['Ada', 1900], CYPHER).rows).toEqual([[1815]]);
    expect(db.query(q, ['Ada', 1800], CYPHER).rows).toEqual([]);
    // A list and a map are values too, where the compiler takes one: in a write. A read refuses them.
    expect(db.query("MATCH (p:Person {name: 'Ada'}) SET p += $m, p.l = $l RETURN p.a AS a, p.l AS l", { m: { a: 7 }, l: [1, 'x'] }, CYPHER).rows).toEqual([[7, [1, 'x']]]);
    expect(() => db.query('UNWIND $names AS name RETURN name', { names: ['Ada'] }, CYPHER)).toThrow(Unsupported);
  });

  test('what smaltdb gives for a text is what runOnSmaltdb gives', () => {
    const g = social();
    const { db } = both(g);
    for (const q of ['MATCH (p:Person) RETURN p.name AS name, p.born AS born ORDER BY name', 'MATCH (a:Person)-[r:KNOWS]->(b) RETURN a.name AS a, r AS r, b AS b ORDER BY a, b.name', 'MATCH p = (:Person {name: \'Ada\'})-[:KNOWS]->() RETURN p']) {
      const through = runOnSmaltdb(db, q);
      const direct = db.query(q, undefined, CYPHER);
      expect([direct.columns, direct.rows], q).toEqual([through.columns, through.rows]);
      expect(through.rows, q).toEqual(g.run(q).rows);
    }
  });

  test('a text smaltdb has seen is not parsed again, and one of a kept shape is parsed and not bound', () => {
    const { db } = both(social());
    const language = registeredLanguage(LANGUAGE)!;
    let parsed = 0;
    const parseOne = language.parseOne!;
    // Counted here on the language that is registered, and put back.
    (language as { parseOne: (text: string) => LanguageStatement }).parseOne = (text) => (parsed++, parseOne(text));
    try {
      const q = (name: string) => `MATCH (p:Person {name: '${name}'}) RETURN p.born AS year`;
      const before = binds();
      expect(db.query(q('Ada'), undefined, CYPHER).rows).toEqual([[1815]]);
      expect([parsed, binds() - before]).toEqual([1, 1]);
      expect(db.query(q('Ada'), undefined, CYPHER).rows).toEqual([[1815]]);
      expect([parsed, binds() - before]).toEqual([1, 1]);
      expect(db.query(q('Alan'), undefined, CYPHER).rows).toEqual([[1912]]);
      expect([parsed, binds() - before]).toEqual([2, 1]);
    } finally {
      (language as { parseOne: unknown }).parseOne = parseOne;
    }
  });
});

describe('what the language refuses', () => {
  test('EXPLAIN: smaltdb explains the plan a statement binds to', () => {
    const { db } = both(social());
    for (const q of ['EXPLAIN MATCH (p:Person) RETURN p.name AS name', 'explain CREATE (:X)']) {
      expect(() => db.query(q, undefined, CYPHER), q).toThrow(Unsupported);
      expect(() => runOnSmaltdb(db, q), q).toThrow(Unsupported);
    }
    expect(db.query('MATCH (x:X) RETURN count(x) AS n', undefined, CYPHER).rows).toEqual([[0]]);
  });

  test('AT VERSION and AT TIME given to smaltdb as text; runOnSmaltdb finds the version and runs them', () => {
    const db = Database.openMemory();
    for (const st of schemaStatements({ ...graphTables([], [], 'graph', true), history: 'versions' })) db.queryPlan(st);
    runOnSmaltdb(db, 'CREATE (:V {i: 1})');
    const first = latestVersion(db);
    runOnSmaltdb(db, 'CREATE (:V {i: 2})');
    const count = 'MATCH (v:V) RETURN count(v) AS n';
    for (const q of [`AT VERSION ${first} ${count}`, `AT VERSION $v ${count}`, `AT TIME $t ${count}`, `EXPLAIN AT VERSION ${first} ${count}`]) {
      expect(() => db.query(q, { v: first, t: 0 }, CYPHER), q).toThrow(Unsupported);
    }
    expect(runOnSmaltdb(db, `AT VERSION ${first} ${count}`)).toMatchObject({ rows: [[1]], version: first });
    expect(runOnSmaltdb(db, `AT VERSION $v ${count}`, { params: { v: first } })).toMatchObject({ rows: [[1]], version: first });
    expect(runOnSmaltdb(db, count)).toMatchObject({ rows: [[2]], version: latestVersion(db) });
    expect(() => runOnSmaltdb(db, `EXPLAIN AT VERSION ${first} ${count}`)).toThrow(Unsupported);
    // A write of the past is the binder's to refuse, whoever runs it.
    expect(() => runOnSmaltdb(db, `AT VERSION ${first} CREATE (:V)`)).toThrow(SmaltcyError);
  });
});

describe('a read of the past is told by its first words', () => {
  const TEXTS = [
    'AT VERSION 3 MATCH (n) RETURN n',
    'at version 3 MATCH (n) RETURN n',
    'At Time $t MATCH (n) RETURN n',
    '  \n\tAT TIME $t RETURN 1 AS x',
    '// a comment\nAT VERSION 1 RETURN 1 AS x',
    '/* one */ AT /* two */ VERSION // three\n 1 RETURN 1 AS x',
    'EXPLAIN AT VERSION 1 RETURN 1 AS x',
    'explain\nat time 5 RETURN 1 AS x',
    'EXPLAIN MATCH (n) RETURN n',
    'MATCH (at) RETURN at',
    'MATCH (n) WHERE n.at = 1 RETURN n.version AS version, n.time AS time',
    'WITH 1 AS AT RETURN AT',
    'UNWIND [1] AS VERSION RETURN VERSION',
    "RETURN 'AT VERSION 1' AS s",
    '// AT VERSION 1\nRETURN 1 AS x',
    '/* AT TIME 1 */ RETURN 1 AS x',
    'RETURN 1 AS x',
    'CREATE INDEX FOR (n:L) ON (n.k)',
    'DROP INDEX ON :L(k)',
    "CREATE (:AT {VERSION: 1, TIME: 'now'})",
  ];
  test.each(TEXTS)('%s', (text) => {
    const st = parse(text);
    expect(readsThePast(text)).toBe(st.t === 'query' && st.asOf !== undefined);
  });

  test('a text that does not parse fails as it did, whichever way it is told', () => {
    const { g, db } = both(social());
    for (const text of ['AT VERSION', 'AT TIME MATCH', 'AT', 'ATVERSION 1 RETURN 1', 'AT VERSIONS 1 RETURN 1', '/* open', 'EXPLAIN', '', '   ']) {
      let mine: unknown;
      try {
        g.run(text);
      } catch (e) {
        mine = e;
      }
      expect(mine, text).toBeInstanceOf(SmaltcyError);
      let theirs: unknown;
      try {
        runOnSmaltdb(db, text);
      } catch (e) {
        theirs = e;
      }
      expect({ code: (theirs as SmaltcyError).code, message: (theirs as Error).message }, text).toEqual({ code: (mine as SmaltcyError).code, message: (mine as Error).message });
    }
  });
});

describe("the graph's tables are read from smaltdb's catalog", () => {
  test('with the labels and types statements added, the same until the schema changes', () => {
    const { db, tables } = both(social());
    const read = graphTablesIn(db.catalog);
    expect(read).toEqual({ ...tables, relationshipIds: true });
    expect(graphTablesIn(db.catalog)).toBe(read);
    runOnSmaltdb(db, "MATCH (p:Person {name: 'Ada'}) SET p.seen = true");
    expect(graphTablesIn(db.catalog)).toBe(read);
    runOnSmaltdb(db, "MATCH (p:Person {name: 'Ada'}) CREATE (p)-[:WROTE]->(:Note {n: 1})");
    const after = graphTablesIn(db.catalog);
    expect([...after.labelTables.keys()]).toEqual([...read.labelTables.keys(), 'Note']);
    expect([...after.types.keys()]).toEqual([...read.types.keys(), 'WROTE']);
    expect(runOnSmaltdb(db, 'MATCH (:Person)-[:WROTE]->(n:Note) RETURN n.n AS n').rows).toEqual([[1]]);
  });

  test('a database with no graph made for Cypher', () => {
    const db = Database.openMemory();
    expect(() => graphTablesIn(db.catalog)).toThrow(/no graph made for Cypher/);
    expect(() => db.query('RETURN 1 AS x', undefined, CYPHER)).toThrow(/no graph made for Cypher/);
    // A property graph made another way is not one.
    db.queryPlan({ kind: 'schema', op: { op: 'createTable', ifNotExists: false, temp: false, table: { name: 'people', columns: [{ name: 'id', declaredType: 'INTEGER', type: 'INTEGER', notNull: false, collation: 'binary' }], keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }], checks: [], foreignKeys: [], storage: 'row' } } } as never);
    db.queryPlan({ kind: 'schema', op: { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'other', nodes: [{ label: 'Person', table: 'people', id: 'id' }], edges: [] } } } as never);
    expect(() => graphTablesIn(db.catalog)).toThrow(/no graph made for Cypher/);
    expect(() => graphTablesIn(db.catalog, 'other')).toThrow(/was not made for Cypher/);
    expect(() => graphTablesIn(db.catalog, 'nothing')).toThrow(/no property graph nothing/);
  });

  test('two graphs made for Cypher: the language is registered for one by its name', () => {
    const db = Database.openMemory();
    for (const name of ['one', 'two']) for (const st of schemaStatements(graphTables(['L'], [], name, true))) db.queryPlan(st);
    expect(() => graphTablesIn(db.catalog)).toThrow(/more than one graph made for Cypher \(one, two\)/);
    expect(graphTablesIn(db.catalog, 'TWO').nodes).toBe('two_node');
    // A language for the second graph binds to its tables (not registered here: the tests share one registration).
    const bound = cypherLanguage('two').parseOne!('MATCH (n:L) RETURN count(n) AS n').bind({ catalog: db.catalog } as never);
    expect(JSON.stringify(bound)).toContain('two_');
    expect(JSON.stringify(bound)).not.toContain('one_');
    expect(db.queryPlan(bound as never).rows).toEqual([[0]]);
  });
});

describe('a graph on smaltcy and the same statements given to smaltdb as text', () => {
  test('a mix of reads and writes, each text three times: bound, by its text, and with a statement in between', () => {
    const g = open();
    const { db } = both(g);
    const statements = [
      "CREATE (:Person {name: 'Ada', born: 1815})-[:KNOWS {since: 1833}]->(:Person {name: 'Charles', born: 1791})",
      "MATCH (p:Person) WHERE p.born < 1800 SET p.old = true RETURN p.name AS name",
      'MATCH (a)-[r:KNOWS]->(b) RETURN a.name AS a, r.since AS since, b.name AS b',
      "MERGE (p:Person {name: 'Ada'}) ON MATCH SET p.seen = coalesce(p.seen, 0) + 1 RETURN p.seen AS seen",
      'MATCH (p:Person) RETURN p.name AS name, p.seen AS seen, p.old AS old ORDER BY name',
    ];
    for (let round = 0; round < 3; round++) {
      for (const cypher of statements) {
        const mine = g.run(cypher);
        const theirs = runOnSmaltdb(db, cypher);
        expect([theirs.columns, theirs.rows, theirs.counts], cypher).toEqual([mine.columns, mine.rows, mine.counts]);
      }
    }
  });
});
