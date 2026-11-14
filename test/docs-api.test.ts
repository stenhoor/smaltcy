import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as smaltcy from '../src/index.js';
import * as engine from '../src/engine/index.js';
import * as datasets from '../src/datasets/index.js';

const modules: Record<string, unknown> = { engine, datasets };

/**
 * The working demos of the API, plans and stores reference pages run as written (BRAND.md, Documentation, rule 6), and
 * each `console.log(…); // value` prints that value. docs-ts.test.ts type-checks them.
 */
test.each(['docs/reference/api.md', 'docs/reference/plans.md', 'docs/reference/stores.md'])('the working demo in %s prints what its comments say', (page) => {
  const md = readFileSync(page, 'utf8');
  const demo = /## Working demo[\s\S]*?```ts\n([\s\S]*?)```/.exec(md)?.[1];
  expect(demo, 'the API page has a working demo').toBeTruthy();
  const printed: unknown[] = [];
  const expected: unknown[] = [];
  const code = demo!
    .replace(/^import \{([^}]*)\} from '@smaltworks\/smaltcy(\/[a-z]+)?';$/gm, (_m, names: string, sub?: string) => `const {${names.replace(/\btype \w+,?/g, '')}} = ${sub ? `modules['${sub.slice(1)}']` : 'smaltcy'};`)
    // Types say nothing at run time.
    .replace(/: QueryPlan\b/g, '')
    .replace(/console\.log\((.*)\); \/\/ (.*)$/gm, (_m, arg: string, want: string) => {
      // A comment that isn't an expression is the text printed, such as an error code.
      let value: unknown;
      try {
        value = new Function(`return (${want})`)();
      } catch {
        value = want;
      }
      expected.push(value);
      return `print(${arg});`;
    });
  new Function('smaltcy', 'modules', 'print', code)(smaltcy, modules, (v: unknown) => printed.push(v));
  expect(printed).toEqual(expected);
});
