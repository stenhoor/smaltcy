/**
 * Histories of writes, run on smaltcy's engine (test/history.test.ts) and on smaltdb (test/smaltdb-history.test.ts).
 */

/** A commit's author and message. */
export interface CommitOptions {
  readonly author?: string;
  readonly message?: string;
}

/** One step of a history. */
export type HistoryStep =
  /** A transaction that runs the statement, then fails: it changes nothing and makes no version. */
  | { readonly kind: 'fail'; readonly statement: string }
  /** Two statements in one transaction: one version at most. */
  | { readonly kind: 'transaction'; readonly statements: readonly string[]; readonly options: CommitOptions }
  /** One statement: a version when it changes something. */
  | { readonly kind: 'run'; readonly statement: string; readonly options: CommitOptions };

/**
 * Random writes from a seed, as many as asked for: creates, relationships between nodes found by id, properties and
 * labels set and removed, deletes. Some steps are transactions of two statements, some fail.
 */
export function* randomSteps(seed: number): Generator<HistoryStep, never> {
  let s = seed;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
  const statements = [
    () => `CREATE (:${pick(['A', 'B', 'C'])} {k: ${Math.floor(rand() * 5)}, name: 'n${Math.floor(rand() * 1000)}'})`,
    () => `MATCH (a), (b) WHERE id(a) = ${Math.floor(rand() * 40)} AND id(b) = ${Math.floor(rand() * 40)} CREATE (a)-[:R {w: ${Math.floor(rand() * 9)}}]->(b)`,
    () => `MATCH (n) WHERE id(n) % 3 = ${Math.floor(rand() * 3)} SET n.k = ${Math.floor(rand() * 9)}`,
    () => `MATCH (n:A) WHERE n.k = ${Math.floor(rand() * 5)} SET n:Tagged REMOVE n.name`,
    () => `MATCH (n:Tagged) REMOVE n:Tagged SET n.name = 'back'`,
    () => `MATCH (n) WHERE id(n) = ${Math.floor(rand() * 40)} DETACH DELETE n`,
    () => `MATCH ()-[r:R]->() WHERE r.w = ${Math.floor(rand() * 9)} DELETE r`,
    () => `MATCH ()-[r:R]->() WHERE r.w > 4 SET r.w = r.w - 1, r.seen = true`,
  ];
  for (;;) {
    const roll = rand();
    if (roll < 0.1) yield { kind: 'fail', statement: pick(statements)() };
    else if (roll < 0.25) {
      const a = pick(statements)();
      yield { kind: 'transaction', statements: [a, pick(statements)()], options: { message: 'two at once' } };
    } else {
      const statement = pick(statements)();
      yield { kind: 'run', statement, options: rand() < 0.5 ? { author: pick(['ana', 'bo']), message: 'edit' } : {} };
    }
  }
}

/** The social graph, loaded, then changed: versions 1 to 4 (the load is version 1). */
export const EVOLVING = {
  load: { message: 'Load the social graph' },
  writes: [
    ["MATCH (p:Person {name: 'Ada'}) SET p.title = 'Countess'", { message: 'Add title' }],
    ["MATCH (p:Person {name: 'Tim'}) DETACH DELETE p", { author: 'bo', message: 'Remove Tim' }],
    ["CREATE (:Person {name: 'Hedy', born: 1914})", { message: 'Add Hedy' }],
  ] as const satisfies readonly (readonly [string, CommitOptions])[],
};
