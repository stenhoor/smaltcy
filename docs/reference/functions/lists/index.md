---
description: 'List functions: Functions that take lists apart and make them.'
---

# List functions

Functions that take lists apart and make them. A `null` argument gives `null`. List operators (`+`, `IN`,
`list[i]`, `list[a..b]`) and comprehensions are in [expressions](../../cypher/expressions).

## Functions {#functions}

- [`size`](./size): The number of elements in a list, characters in a string, keys in a map, or relationships in a path.
- [`head`](./head): A list's first element, or `null` for an empty list.
- [`last`](./last): A list's last element, or `null` for an empty list.
- [`tail`](./tail): A list without its first element.
- [`reverse`](./reverse): A list in reverse order, or a string with its characters reversed.
- [`range`](./range): The integers from `START` to `END`, both included, `STEP` apart (1 by default; negative counts down).
- [`isEmpty`](./isEmpty): True when a list, string or map has nothing in it.
