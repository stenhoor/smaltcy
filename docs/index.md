---
layout: home
hero:
  name: 'sm<span class="alt">alt</span><span class="suffix language">cy</span>'
  text: 'Small. Alternative.<br>Connected.'
  tagline: A graph database for the browser that speaks Cypher.
  image:
    light: /graph-mark.svg
    dark: /graph-mark-on-dark.svg
    alt: smaltcy
  actions:
    - theme: brand
      text: Open the playground
      link: /playground
    - theme: alt
      text: Tech demo
      link: /demo
    - theme: alt
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/stenhoor/smaltcy
features:
  - title: Cypher in, rows and graphs out
    details: MATCH, OPTIONAL MATCH, WITH, variable-length paths, shortest paths, aggregates, CREATE, MERGE, SET and DELETE, in a hand-written parser.
  - title: Plans between the language and the engine
    details: Cypher compiles to a graph plan, plain JSON the engine validates and runs. Other languages can build the same plans.
  - title: One plan, any store
    details: An in-memory adjacency store for writes and a compact CSR store for reads run the same plans, chosen by statistics, and pass the same tests.
  - title: Drawn on the GPU
    details: Force layout in WebGPU compute shaders, drawn in 2D or 3D, with picking, search and labels on the GPU too.
---

```ts
import { open } from '@smaltworks/smaltcy';

const db = open();
db.run(`CREATE (:Person {name: 'Ada'})-[:KNOWS]->(:Person {name: 'Alan'})`);
db.query('MATCH (a)-[:KNOWS]->(b) RETURN a.name AS a, b.name AS b');
// [{ a: 'Ada', b: 'Alan' }]
```

