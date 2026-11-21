import { describe, expect, test } from 'vitest';
import { Database } from 'smaltdb-src/engine/database.js';
import { compile } from '../src/cypher/index.js';
import { HistoryStore, open, SmaltcyError, type Graph } from '../src/index.js';
import { social } from '../src/datasets/index.js';
import { compileQuery, lastCommitOf, lit, paramValues, Unsupported } from '../src/smaltdb/compile.js';
import { graphTables, graphTablesFor, loadStatements, schemaStatements, type GraphTables } from '../src/smaltdb/schema.js';
import { forgetOnSmaltdb, latestVersion, runOnSmaltdb, type NextIds, type RunOptions, type SmaltdbDatabase } from '../src/smaltdb/write.js';
import { EVOLVING, randomSteps, type CommitOptions, type HistoryStep } from './helpers/history-cases.js';
import { dataOf } from './helpers/smaltdb.js';

/**
 * History on smaltdb (ADR 0004): a graph that keeps history on both engines, written step by step (the histories of
 * test/history.test.ts), then read at every version with `AT VERSION`, and at commit times with `AT TIME`. smaltcy's
 * versions count 1, 2, 3 …; smaltdb's are its commit ids, so each smaltcy version is compared with the commit it made.
 */

const NODES = 'MATCH (n) RETURN id(n) AS id, labels(n) AS labels, properties(n) AS props ORDER BY id';
const RELS = 'MATCH (a)-[r]->(b) RETURN id(r) AS id, type(r) AS type, id(a) AS s, id(b) AS e, properties(r) AS props ORDER BY id';
const PATTERN = "MATCH (a:A)-[r:R]->(b) WHERE r.w > 2 RETURN a.name AS a, b.k AS k, r.seen AS seen ORDER BY a, k";

const commit = (action: string, more: object = {}) => ({ kind: 'transaction', action, ...more }) as never;

/** A graph that keeps history on both engines, kept in step. */
class Pair {
  readonly db = Database.openMemory();
  tables: GraphTables;
  /** The next ids, kept across statements as smaltcy's store keeps them (it doesn't take back the ids of a rollback). */
  readonly ids: NextIds = { node: 0, relationship: 0 };
  /** smaltcy's versions, and the smaltdb commit each made. */
  readonly commits = new Map<number, number>([[0, 0]]);

  constructor(readonly g: Graph, private readonly author: string, tables: GraphTables = { ...graphTables([], [], 'graph', true), history: 'versions' }) {
    this.tables = tables;
    for (const st of schemaStatements(tables)) this.db.queryPlan(st);
  }

  /** The social dataset, loaded on both in one commit (smaltcy's version 1). */
  static evolving(): Pair {
    let t = Date.UTC(2026, 10, 1);
    const g = open({ history: { clock: () => (t += 86_400_000), author: 'ana' } });
    g.load(social(), EVOLVING.load);
    const data = dataOf(g);
    const p = new Pair(g, 'ana', { ...graphTablesFor(data), history: 'versions' });
    p.db.queryPlan(commit('begin', { mode: 'deferred', author: 'ana', ...EVOLVING.load }));
    for (const st of loadStatements(data, p.tables)) p.db.queryPlan(st);
    p.db.queryPlan(commit('commit'));
    p.commits.set(1, latestVersion(p.db));
    for (const [cypher, options] of EVOLVING.writes) p.step({ kind: 'run', statement: cypher, options });
    return p;
  }

  private smaltdb(cypher: string, options: RunOptions = {}) {
    const r = runOnSmaltdb(this.db, compile(cypher).plan, this.tables, { ...options, ids: this.ids });
    this.tables = r.tables;
    return r;
  }

  /** One step on both; a version on smaltdb exactly when smaltcy makes one. */
  step(s: HistoryStep): void {
    const before = this.g.version!;
    const last = latestVersion(this.db);
    const by = (o: CommitOptions) => ({ author: o.author ?? this.author, ...(o.message !== undefined ? { message: o.message } : {}) });
    switch (s.kind) {
      case 'fail': {
        expect(() => this.g.transaction((tx) => {
          tx.run(s.statement);
          throw new Error('stop');
        })).toThrow('stop');
        const tables = this.tables;
        this.db.queryPlan(commit('begin', { mode: 'deferred' }));
        try {
          this.smaltdb(s.statement);
        } finally {
          this.db.queryPlan(commit('rollback'));
          this.tables = tables;
        }
        break;
      }
      case 'transaction':
        this.g.transaction((tx) => { for (const st of s.statements) tx.run(st); }, s.options);
        this.db.queryPlan(commit('begin', { mode: 'deferred', ...by(s.options) }));
        for (const st of s.statements) this.smaltdb(st);
        this.db.queryPlan(commit('commit'));
        break;
      case 'run':
        this.g.run(s.statement, {}, s.options);
        expect(this.smaltdb(s.statement, by(s.options)).version).toBe(latestVersion(this.db));
        break;
    }
    const now = latestVersion(this.db);
    if (this.g.version! > before) {
      expect(now, `${JSON.stringify(s)}: a commit`).toBeGreaterThan(last);
      this.commits.set(this.g.version!, now);
    } else {
      expect(now, `${JSON.stringify(s)}: no commit`).toBe(last);
    }
  }

  /** A query on both: smaltcy's at a version, smaltdb's at the commit it made. */
  same(cypher: string, version: number, at: (q: string) => string = (q) => `AT VERSION $v ${q}`): void {
    const mine = this.g.run(at(cypher), { v: version });
    const theirs = runOnSmaltdb(this.db, compile(at(cypher)).plan, this.tables, { params: { v: this.commits.get(version)! } });
    expect(theirs.rows, `${cypher} at version ${version}`).toEqual(mine.rows);
    expect(theirs.version).toBe(this.commits.get(version));
  }

  /** smaltdb's commits: id, time, author, message. */
  recorded(): { id: number; time: number; author: string | null; message: string | null }[] {
    const rows = this.db.queryPlan({ kind: 'query', plan: { op: 'scan', table: 'smalt_commits', columns: [0, 1, 2, 3] } } as never).rows;
    return rows.map(([id, time, author, message]) => ({ id: id as number, time: time as number, author: author as string | null, message: message as string | null }));
  }
}

function randomPair(seed: number, versions: number): Pair {
  let t = Date.UTC(2026, 0, 1);
  const p = new Pair(open({ history: { clock: () => (t += 60_000), author: 'test' } }), 'test');
  const steps = randomSteps(seed);
  while (p.g.version! < versions) p.step(steps.next().value);
  return p;
}

describe('history on smaltdb: every version as it was', () => {
  test.each([1, 2, 3])('seed %i: AT VERSION reads every version as smaltcy does', (seed) => {
    const p = randomPair(seed, 40);
    for (const v of p.commits.keys()) {
      p.same(NODES, v);
      p.same(RELS, v);
      p.same(PATTERN, v);
      // version() is the version read: on smaltdb, the commit.
      expect(runOnSmaltdb(p.db, compile('AT VERSION $v RETURN version() AS v').plan, p.tables, { params: { v: p.commits.get(v)! } }).rows).toEqual([[p.commits.get(v)]]);
    }
    // The present, and version() in it.
    p.same(NODES, p.g.version!, (q) => q);
    expect(runOnSmaltdb(p.db, compile('RETURN version() AS v').plan, p.tables).rows).toEqual([[p.commits.get(p.g.version!)]]);
  });

  test('commits carry the author and message smaltcy records', () => {
    const p = randomPair(5, 30);
    const recorded = new Map(p.recorded().map((c) => [c.id, c]));
    for (const c of p.g.commits()) {
      const theirs = recorded.get(p.commits.get(c.version)!)!;
      expect({ author: theirs.author, message: theirs.message }, `version ${c.version}`).toEqual({ author: c.author ?? null, message: c.message ?? null });
    }
    // Every commit recorded is a version: nothing else wrote.
    expect(recorded.size).toBe(p.g.version);
  });

  test('AT TIME reads the last commit at or before a moment', () => {
    const p = randomPair(7, 20);
    const versionOf = new Map([...p.commits].map(([v, c]) => [c, v]));
    const recorded = p.recorded();
    for (const { time } of recorded) {
      // smaltdb's clock: commits in the same millisecond read as the last of them.
      const last = Math.max(...recorded.filter((c) => c.time <= time).map((c) => c.id));
      for (const t of [time, new Date(time).toISOString()]) {
        const r = runOnSmaltdb(p.db, compile(`AT TIME $t ${NODES}`).plan, p.tables, { params: { t } });
        expect(r.version).toBe(last);
        expect(r.rows).toEqual(p.g.run(`AT VERSION $v ${NODES}`, { v: versionOf.get(last)! }).rows);
        expect(runOnSmaltdb(p.db, compile('AT TIME $t RETURN version() AS v').plan, p.tables, { params: { t } }).rows).toEqual([[last]]);
      }
    }
    const before = runOnSmaltdb(p.db, compile("AT TIME '2000-01-01' MATCH (n) RETURN count(n) AS n").plan, p.tables);
    expect([before.rows, before.version]).toEqual([[[0]], 0]);
  });

  test('forget() drops the versions before one, as smaltcy does', () => {
    const p = randomPair(6, 30);
    (p.g.store as HistoryStore).forget(10);
    forgetOnSmaltdb(p.db, p.tables, p.commits.get(10)!);
    for (const v of [...p.commits.keys()].filter((v) => v >= 10)) {
      p.same(NODES, v);
      p.same(RELS, v);
    }
    for (const q of [NODES, 'RETURN 1 AS x']) {
      expect(() => p.g.run(`AT VERSION 9 ${q}`)).toThrow(/no version 9/);
      expect(() => runOnSmaltdb(p.db, compile(`AT VERSION ${p.commits.get(9)} ${q}`).plan, p.tables)).toThrow(/no version/);
    }
    // A moment before the oldest version kept reads that version.
    const mine = p.g.run(`AT TIME '2000-01-01' ${NODES}`);
    const theirs = runOnSmaltdb(p.db, compile(`AT TIME '2000-01-01' ${NODES}`).plan, p.tables);
    expect([mine.version, theirs.version]).toEqual([10, p.commits.get(10)]);
    expect(theirs.rows).toEqual(mine.rows);
    expect(() => forgetOnSmaltdb(p.db, p.tables, latestVersion(p.db) + 1)).toThrow(/no version/);
  });

  test('a version after the latest is an error, as on smaltcy', () => {
    const p = randomPair(8, 5);
    expect(() => p.g.run(`AT VERSION 6 ${NODES}`)).toThrow(/no version 6/);
    expect(() => runOnSmaltdb(p.db, compile(`AT VERSION ${latestVersion(p.db) + 1} ${NODES}`).plan, p.tables)).toThrow(/no version/);
    expect(() => runOnSmaltdb(p.db, compile(`AT VERSION -1 ${NODES}`).plan, p.tables)).toThrow(/no version/);
  });
});

describe('the last commit is read from the end of smalt_commits', () => {
  /** The operators smaltdb runs a query with, from the top, each with the rows it gave (EXPLAIN ANALYZE). */
  const operators = (db: Database, plan: unknown): [string, number][] =>
    (db.queryPlan({ kind: 'explain', mode: 'analyze', query: { kind: 'query', plan } } as never).rows as unknown[][]).map((r) => [String(r[2]), r[5] as number]);
  /** The last commit recorded at or before a time (every one, without), from all of them. */
  const lastOf = (p: Pair, time = Infinity): number => Math.max(0, ...p.recorded().filter((c) => c.time <= time).map((c) => c.id));

  test('before the first commit there is none', () => {
    const p = new Pair(open({ history: true }), 'x');
    expect(p.recorded()).toEqual([]);
    expect(latestVersion(p.db)).toBe(0);
    expect(runOnSmaltdb(p.db, compile('RETURN version() AS v').plan, p.tables).rows).toEqual([[0]]);
  });

  test('the latest version: one row read, whatever the commits', () => {
    const p = randomPair(9, 25);
    expect(p.recorded().length).toBeGreaterThan(20);
    expect(latestVersion(p.db)).toBe(lastOf(p));
    const ops = operators(p.db, lastCommitOf());
    // No sort and no aggregate, and the scan stops at its first row.
    expect(ops.map(([name]) => name)).toEqual(['PROJECT', 'LIMIT', 'PROJECT', 'SCAN smalt_commits']);
    expect(ops.map(([, rows]) => rows)).toEqual([1, 1, 1, 1]);
  });

  test('the last commit at or before a time: the commits after it are read, then it', () => {
    const p = randomPair(10, 25);
    const recorded = p.recorded();
    for (const { time } of recorded) {
      const ops = operators(p.db, lastCommitOf(lit(time)));
      expect(ops.map(([name]) => name)).toEqual(['PROJECT', 'LIMIT', 'PROJECT', 'FILTER', 'SCAN smalt_commits']);
      expect(ops.map(([, rows]) => rows), String(time)).toEqual([1, 1, 1, 1, recorded.filter((c) => c.time > time).length + 1]);
    }
    // A time before the first commit: every commit is read, and none counts.
    const before = Math.min(...recorded.map((c) => c.time)) - 1;
    expect(operators(p.db, lastCommitOf(lit(before))).map(([, rows]) => rows)).toEqual([0, 0, 0, 0, recorded.length]);
  });

  test('a time between two milliseconds reads the last commit before it', () => {
    const p = randomPair(11, 12);
    for (const { time } of p.recorded()) {
      for (const t of [time + 0.5, time - 0.5]) {
        // Through the runner, which finds the version first; then compiled as it is, where version() finds it.
        const r = runOnSmaltdb(p.db, compile('AT TIME $t RETURN version() AS v').plan, p.tables, { params: { t } });
        expect([r.rows, r.version], String(t)).toEqual([[[lastOf(p, t)]], lastOf(p, t)]);
        const q = compileQuery(compile('AT TIME $t RETURN version() AS v').plan, p.tables, { params: { t } });
        expect(p.db.queryPlan(q.statement, paramValues(q, { t }) as never).rows, String(t)).toEqual([[lastOf(p, t)]]);
      }
    }
  });

  test('a database that prepares no statements reads the same versions, and takes no maximum over the commits', () => {
    const p = randomPair(12, 15);
    const statements: unknown[] = [];
    const plain: SmaltdbDatabase = {
      queryPlan: (stmt, params) => {
        statements.push(stmt);
        return p.db.queryPlan(stmt, params as never);
      },
      get inTransaction() {
        return p.db.inTransaction;
      },
    };
    expect(latestVersion(plain)).toBe(lastOf(p));
    const { time } = p.recorded()[5]!;
    for (const q of ['AT TIME $t RETURN version() AS v', `AT TIME $t ${NODES}`]) {
      const mine = runOnSmaltdb(plain, compile(q).plan, p.tables, { params: { t: time } });
      const theirs = runOnSmaltdb(p.db, compile(q).plan, p.tables, { params: { t: time } });
      expect([mine.rows, mine.version], q).toEqual([theirs.rows, lastOf(p, time)]);
    }
    expect(runOnSmaltdb(plain, compile(NODES).plan, p.tables).version).toBe(lastOf(p));
    const wrote = runOnSmaltdb(plain, compile('CREATE (:Z)').plan, p.tables, { ids: p.ids });
    expect(wrote.version).toBe(lastOf(p));
    expect(wrote.version).toBe(latestVersion(p.db));
    const text = statements.map((x) => JSON.stringify(x));
    expect(text.some((x) => x.includes('smalt_commits'))).toBe(true);
    expect(text.filter((x) => x.includes('smalt_commits') && x.includes('"aggregate"'))).toEqual([]);
  });

  test('each database has its own statements, which follow its commits, a forget and a new label', () => {
    const a = randomPair(13, 8);
    const b = randomPair(14, 16);
    expect([latestVersion(a.db), latestVersion(b.db), latestVersion(a.db)]).toEqual([lastOf(a), lastOf(b), lastOf(a)]);
    expect(lastOf(a)).not.toBe(lastOf(b));
    const at = (p: Pair, t: number) => runOnSmaltdb(p.db, compile('AT TIME $t RETURN version() AS v').plan, p.tables, { params: { t } }).rows;
    const ta = a.recorded()[3]!.time;
    const tb = b.recorded()[9]!.time;
    expect([at(a, ta), at(b, tb), at(a, ta)]).toEqual([[[lastOf(a, ta)]], [[lastOf(b, tb)]], [[lastOf(a, ta)]]]);
    // A commit on one moves its latest, and not the other's.
    const was = latestVersion(b.db);
    a.step({ kind: 'run', statement: 'CREATE (:NeverSeen {k: 1})', options: {} });
    expect([latestVersion(a.db), latestVersion(b.db)]).toEqual([lastOf(a), was]);
    forgetOnSmaltdb(b.db, b.tables, b.commits.get(10)!);
    expect([latestVersion(b.db), at(b, tb)]).toEqual([was, [[Math.max(lastOf(b, tb), b.commits.get(10)!)]]]);
  });
});

describe('temporal Cypher on smaltdb', () => {
  test('the evolving social graph: AT VERSION, version(), authors and messages', () => {
    const p = Pair.evolving();
    for (const v of [0, 1, 2, 3, 4]) {
      p.same('MATCH (p:Person) RETURN p.name AS name, p.title AS title ORDER BY name', v);
      p.same(RELS, v);
    }
    p.same('MATCH (p:Person {name: $n}) RETURN p.title AS t', 1, (q) => `AT VERSION $v ${q.replace('$n', "'Ada'")}`);
    const recorded = p.recorded();
    expect(recorded.map((c) => [c.author, c.message])).toEqual(p.g.commits().map((c) => [c.author, c.message]));
  });

  test('what reads the past can refuse', () => {
    const p = Pair.evolving();
    const v = p.commits.get(2)!;
    const refused = (q: string) => expect(() => runOnSmaltdb(p.db, compile(q).plan, p.tables), q).toThrow(Unsupported);
    refused(`AT VERSION ${v} MATCH (a:Person {name: 'Ada'})-[:KNOWS*1..2]->(f) RETURN count(DISTINCT f) AS n`);
    refused(`AT VERSION ${v} MATCH p = shortestPath((a:Person {name: 'Ada'})-[*]-(b:Person {name: 'Tim'})) RETURN length(p) AS n`);
    refused('RETURN size(commits()) AS n');
    refused('RETURN commit(2).message AS m');
    refused("MATCH (p:Person {name: 'Ada'}) RETURN history(p) AS h");
    expect(() => runOnSmaltdb(p.db, compile(`AT VERSION ${v} CREATE (:X)`).plan, p.tables)).toThrow(SmaltcyError);
    // An author for one statement inside a transaction: its begin or commit takes it.
    p.db.queryPlan(commit('begin', { mode: 'deferred' }));
    expect(() => runOnSmaltdb(p.db, compile('CREATE (:X)').plan, p.tables, { author: 'ana' })).toThrow(Unsupported);
    p.db.queryPlan(commit('rollback'));
  });

  test('a write that changes nothing makes no version on either', () => {
    const p = Pair.evolving();
    for (const statement of [
      "MATCH (p:Person {name: 'Ada'}) SET p.title = 'Countess'",
      'MATCH (p:Person) SET p.born = p.born',
      "MATCH (p:Person {name: 'Ada'}) SET p += {title: 'Countess'}",
      "MATCH (p:Person {name: 'Ada'}) REMOVE p.nothing, p:Nothing SET p:Person",
      "MATCH (p:Person {name: 'Nobody'}) DETACH DELETE p",
    ]) p.step({ kind: 'run', statement, options: {} });
    expect(p.g.version).toBe(4);
    // A change undone in the same statement is two changes: a version on both.
    p.step({ kind: 'run', statement: "MATCH (p:Person {name: 'Ada'}) SET p.k = 1 SET p.k = null", options: {} });
    expect(p.g.version).toBe(5);
  });

  test("ids aren't given again while a version holds them", () => {
    const p = new Pair(open({ history: true }), 'x');
    for (const statement of ['CREATE (:A)-[:R]->(:B)', 'MATCH (b:B) DETACH DELETE b', 'CREATE (:C)-[:S]->(:D)']) {
      p.g.run(statement);
      // No counter kept: the ids come from the graph and its history.
      p.tables = runOnSmaltdb(p.db, compile(statement).plan, p.tables).tables;
    }
    const q = 'MATCH (n) OPTIONAL MATCH (n)-[r]->() RETURN id(n) AS n, labels(n) AS l, id(r) AS r ORDER BY n';
    expect(runOnSmaltdb(p.db, compile(q).plan, p.tables).rows).toEqual(p.g.run(q).rows);
  });

  test('a graph without history has none to read', () => {
    const db = Database.openMemory();
    const tables = graphTables([], [], 'graph', true);
    for (const st of schemaStatements(tables)) db.queryPlan(st);
    expect(runOnSmaltdb(db, compile('RETURN version() AS v').plan, tables).rows).toEqual(open().run('RETURN version() AS v').rows);
    expect(() => runOnSmaltdb(db, compile('AT VERSION 1 MATCH (n) RETURN n').plan, tables)).toThrow(/keeps no history/);
    expect(() => forgetOnSmaltdb(db, tables, 1)).toThrow(/keeps no history/);
  });
});
