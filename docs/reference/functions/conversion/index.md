---
description: 'Conversion functions: Functions that turn a value into another type, or name its type.'
---

# Conversion functions

Functions that turn a value into another type, or name its type. Text that doesn't convert gives `null`,
not an error.

## Functions {#functions}

- [`toString`](./toString): A number, boolean or string as text. A whole-number float keeps its point: `toString(2.0)` is `'2.0'`.
- [`toInteger`](./toInteger): A number, text or boolean as an integer, cut towards zero. Text that isn't a number gives `null`.
- [`toFloat`](./toFloat): A number or text as a float. Text that isn't a number gives `null`.
- [`toBoolean`](./toBoolean): `'true'` and `'false'` (in any case, around white space) as booleans, a number as `true` unless it's 0, and a boolean as itself. Other text gives `null`.
- [`valueType`](./valueType): The name of a value's type: `NULL`, `BOOLEAN`, `INTEGER`, `FLOAT`, `STRING`, `LIST`, `MAP`, `NODE`, `RELATIONSHIP` or `PATH`.
