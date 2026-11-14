---
description: 'Graph functions: Functions that read nodes, relationships and paths: their ids, labels, types, properties and ends.'
---

# Graph functions

Functions that read nodes, relationships and paths: their ids, labels, types, properties and ends. A
`null` argument gives `null`.

## Functions {#functions}

- [`id`](./id): The id of a node or relationship: the store's integer.
- [`elementId`](./elementId): The id of a node or relationship as text: `n` and the id for a node, `r` and the id for a relationship.
- [`labels`](./labels): A node's labels, as a list of strings.
- [`type`](./type): A relationship's type.
- [`properties`](./properties): The properties of a node or relationship, as a map. A map gives itself.
- [`keys`](./keys): The property keys of a node or relationship, or the keys of a map, as a list of strings.
- [`startNode`](./startNode): The node a relationship starts at.
- [`endNode`](./endNode): The node a relationship ends at.
- [`nodes`](./nodes): A path's nodes, in order, as a list.
- [`relationships`](./relationships): A path's relationships, in order, as a list.
- [`length`](./length): The number of relationships in a path. On a string or a list, its size.
- [`degree`](./degree): The number of relationships at a node: `DIRECTION` is `'out'`, `'in'` or `'both'` (the default), and `TYPE` counts only that type.
