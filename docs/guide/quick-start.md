---
description: 'Five minutes, three steps. Install smaltcy, run Cypher from your code, then change a query and run it on this page.'
---

# Quick start

Five minutes, three steps: install smaltcy, run Cypher from your code, then change a query and run it on this page.

## 1. Install

```sh
npm install --save-exact @smaltworks/smaltcy@0.1.0
```

smaltcy 0.1.0 is not on npm yet. [Installation](./getting-started) has the entry points and what else to know.

## 2. Run Cypher from your code

```ts
import { open } from '@smaltworks/smaltcy';

const db = open(); // a graph in memory, in the page

db.run(`
  CREATE (ada:Person {name: 'Ada'})-[:KNOWS {since: 1833}]->(alan:Person {name: 'Alan'}),
         (alan)-[:KNOWS {since: 1936}]->(:Person {name: 'Grace'})
`);

const rows = db.query('MATCH (a:Person)-[:KNOWS]->(b) RETURN a.name AS a, b.name AS b');
console.log(rows); // [{ a: 'Ada', b: 'Alan' }, { a: 'Alan', b: 'Grace' }]
```

`open()` gives a graph in memory. `run` returns the columns, the rows and what a write changed. `query` returns the rows as objects.

## 3. Try it here

This example runs in your browser, on a small sample graph of twelve people, the cities they live in, the topics they
like, and who knows whom. Change it and press **Run** (or Ctrl+Enter). **Reset** brings back the example, and **Share**
copies a link to your version.

```cypher
MATCH (p:Person)-[:LIVES_IN]->(c:City)
RETURN c.name AS city, count(*) AS people, collect(p.name) AS names
ORDER BY people DESC, city
```

| city | people | names |
| --- | --- | --- |
| London | 3 | ["Ada","Alan","Tim"] |
| New York | 3 | ["Grace","Barbara","Frances"] |
| Palo Alto | 3 | ["Donald","John","Ken"] |
| Boston | 2 | ["Margaret","Radia"] |
| Austin | 1 | ["Edsger"] |

The table under the code is the tested result: the docs' tests run every example and check what it prints. When a
result holds nodes, relationships or paths, Run also draws them as a graph:

```cypher
MATCH path = (:Person {name: 'Ada'})-[:KNOWS*1..2]-(:Person)
RETURN path
```

| path |
| --- |
| Ada → Alan |
| Ada → Alan → Grace |
| Ada → Alan → Edsger |

## Next

- [Installation](./getting-started): the package, its entry points, parameters, indexes and transactions.
- [Examples](./examples): common queries, step by step.
- [The Cypher reference](../reference/cypher/) and the [functions](../reference/functions).
- The [playground](../playground): any query on any sample graph, with the graph drawn beside the rows.
