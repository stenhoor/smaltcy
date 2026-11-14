---
description: 'Aggregate functions: Aggregates turn many rows into one value.'
---

# Aggregate functions

Aggregates turn many rows into one value. They go in [`RETURN`](../../cypher/return) and
[`WITH`](../../cypher/with): the items without an aggregate group the rows, and each group gives one row. With no
such items, all the rows are one group. Every aggregate skips `null`, and with `DISTINCT` (`count(DISTINCT x)`) sees
each value once. An aggregate in `WHERE`, or inside another aggregate, fails with `SMALTCY_SEMANTIC`.

## Functions {#functions}

- [`count`](./count): The number of rows, with `*`, or of values that aren't `null`.
- [`sum`](./sum): The sum of the values; 0 when there are none.
- [`avg`](./avg): The mean of the values; `null` when there are none.
- [`min`](./min): The smallest value, in Cypher's order; `null` when there are none.
- [`max`](./max): The largest value, in Cypher's order; `null` when there are none.
- [`collect`](./collect): The values as a list, in the order of the rows, without `null`s.
- [`stDev`](./stDev): The standard deviation of a sample: divided by *n* - 1. 0 for fewer than two values.
- [`stDevP`](./stDevP): The standard deviation of a whole population: divided by *n*. 0 for no values.
