---
description: 'Math functions: Functions of numbers.'
---

# Math functions

Functions of numbers. A `null` argument gives `null`, and an argument that isn't a number fails with
`SMALTCY_TYPE`. Numbers are JavaScript doubles ([where it differs](../../divergences#numbers)). The arithmetic
operators are in [expressions](../../cypher/expressions).

## Functions {#functions}

- [`abs`](./abs): The absolute value.
- [`ceil`](./ceil): The smallest whole number not less than `X`.
- [`floor`](./floor): The largest whole number not more than `X`.
- [`round`](./round): `X` rounded to the nearest whole number, or to `DIGITS` decimal places. Halves round away from zero.
- [`sqrt`](./sqrt): The square root; `NaN` for a negative number.
- [`sign`](./sign): -1, 0 or 1, as `X` is negative, zero or positive.
- [`exp`](./exp): *e* to the power `X`.
- [`log`](./log): The natural logarithm.
- [`log10`](./log10): The base-10 logarithm.
- [`sin`](./sin): The sine of an angle in radians.
- [`cos`](./cos): The cosine of an angle in radians.
- [`tan`](./tan): The tangent of an angle in radians.
- [`asin`](./asin): The arcsine, in radians.
- [`acos`](./acos): The arccosine, in radians.
- [`atan`](./atan): The arctangent, in radians.
- [`atan2`](./atan2): The angle, in radians, of the point (`X`, `Y`) from the x-axis.
- [`pi`](./pi): π.
- [`e`](./e): *e*, the base of natural logarithms.
- [`rand`](./rand): A random float from 0 up to, not including, 1: a new one each call.
