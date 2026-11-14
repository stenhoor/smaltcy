---
description: 'For AI agents that write code with smaltcy. How to use it, its rules, and where the complete agent guide is.'
---

# For AI agents

This page is written for AI agents that write code with smaltcy, and it opens the agent guide. The site publishes
Markdown made for agents beside its pages:

- [`/agents.md`](https://stenhoor.github.io/smaltcy/agents.md): this page, then the Cypher reference, the functions,
  where smaltcy differs from openCypher and the API, in one file. Every example in it is tested, with its result.
- [`/llms.txt`](https://stenhoor.github.io/smaltcy/llms.txt): an index of every page, each as Markdown.
- Any page as Markdown: its address with `.md`, such as
  [`guide/examples.md`](https://stenhoor.github.io/smaltcy/guide/examples.md).

## What smaltcy is

smaltcy is a graph database for the browser that speaks Cypher, written in TypeScript. A graph holds nodes and
relationships. A node has labels and properties, and a relationship has one type, a direction and properties. Cypher
compiles to a graph plan, plain JSON, that the engine validates and runs on a store. The graph lives in memory, in the
page or in a Web Worker. Durable storage will come from smaltdb. The package is `@smaltworks/smaltcy`, which is not
on npm yet.

## How to use it

```ts
import { open, SmaltcyError } from '@smaltworks/smaltcy';

const db = open(); // in memory; open({ history: true }) keeps every version
db.run('CREATE INDEX FOR (p:Person) ON (p.name)');
db.run('CREATE (:Person {name: $name, born: $born})', { name: 'Ada', born: 1815 });
try {
  db.run('MATCH (p:Person {name: $name}) DELETE p', { name: 'Ada' });
} catch (e) {
  if (!(e instanceof SmaltcyError && e.code === 'SMALTCY_CONSTRAINT')) throw e;
}
const rows = db.query('MATCH (p:Person) WHERE p.born < $year RETURN p.name AS name', { year: 1900 }); // [{ name: 'Ada' }]
db.transaction((tx) => {
  tx.run("MATCH (p:Person {name: 'Ada'}) SET p.field = 'mathematics'");
  tx.run("CREATE (:Topic {name: 'mathematics'})");
});
```

- **Calls are synchronous** on a graph in the page. `run` returns `columns`, `rows` (arrays), the write `counts` and
  `ms`. `query` returns the rows as objects. `explain` returns the plan as text. With a graph in a Web Worker
  (`connect`, [In a Web Worker](./worker)), the same calls return promises.
- **Pass values as parameters** (`$name`), never by building Cypher text.
- **Each statement that writes is atomic.** `transaction` makes several statements one unit: if the function throws,
  nothing it wrote stays.
- **Nodes, relationships and paths** come back as `{ kind: 'node', id, labels, properties }`,
  `{ kind: 'relationship', id, type, start, end, properties }` and `{ kind: 'path', nodes, relationships }`.
- **Errors** throw a `SmaltcyError`. Branch on its `code` (`SMALTCY_SYNTAX`, `SMALTCY_SEMANTIC`, …), never on its
  `message`, whose wording may change. The codes are in the [API reference](../reference/api#error-codes).

## Rules that differ from openCypher

- **A subset of Cypher.** What smaltcy doesn't read fails with `SMALTCY_SYNTAX` or `SMALTCY_SEMANTIC`, never with a
  wrong answer. Not supported, among others: `CALL` procedures and subqueries, `FOREACH`, `LOAD CSV`, temporal and
  spatial types, label expressions (`:A|B`), quantified path patterns and constraints. The list, with what to do
  instead, is in [Where it differs](../reference/divergences).
- **Numbers are JavaScript doubles.** A literal with a point or an exponent is a float (`7.0 / 2` is `3.5`, `7 / 2`
  is `3`), and a whole-number property acts as an integer: use `toFloat(n.x) / 2` to divide as floats.
- **Relationships in a `CREATE` need one type and a direction.**
- **History is smaltcy's own:** `AT VERSION n` and `AT TIME t` before a query, and `version()`, `commits()`,
  `commit()` and `history()`, read a graph opened with `{ history: true }` ([Time travel](./time-travel)).
- **`EXPLAIN` shows smaltcy's own plan steps.** Ids are the store's integers.

## Sample data

Every example in the docs runs on a sample graph from `@smaltworks/smaltcy/datasets`: `social` unless the example
says otherwise (`dataset=metro` on its fence). [Sample data](./sample-data) describes each one. To run an example
yourself, load the dataset first:

```ts
import { open } from '@smaltworks/smaltcy';
import { social } from '@smaltworks/smaltcy/datasets';

const db = open();
db.load(social());
db.query("MATCH (:Person {name: 'Ada'})-[:KNOWS]->(f) RETURN f.name AS name"); // [{ name: 'Alan' }]
```
