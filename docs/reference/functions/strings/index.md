---
description: 'String functions: Functions that change and take apart text.'
---

# String functions

Functions that change and take apart text. A `null` argument gives `null`, and an argument that isn't
text fails with `SMALTCY_TYPE`. Positions count from 0. `STARTS WITH`, `ENDS WITH`, `CONTAINS`, `=~` and `+` are
operators, in [expressions](../../cypher/expressions). [`size`](../lists/size) and [`reverse`](../lists/reverse) take
strings too.

## Functions {#functions}

- [`toUpper`](./toUpper): The text in upper case.
- [`toLower`](./toLower): The text in lower case.
- [`trim`](./trim): The text without white space at either end.
- [`ltrim`](./ltrim): The text without white space at its start.
- [`rtrim`](./rtrim): The text without white space at its end.
- [`substring`](./substring): The part of the text from position `START` (the first is 0), `LENGTH` characters long, or to the end.
- [`left`](./left): The first `N` characters of the text.
- [`right`](./right): The last `N` characters of the text.
- [`replace`](./replace): The text with every occurrence of `FIND` replaced by `WITH`.
- [`split`](./split): The parts of the text between occurrences of `DELIMITER`, as a list.
