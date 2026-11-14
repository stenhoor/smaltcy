import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as smaltcy from '../src/index.js';

/**
 * The API reference's working demo runs as written (BRAND.md, Documentation, rule 6), and each `console.log(…); //
 * value` prints that value. docs-ts.test.ts type-checks it.
 */
test('the API reference working demo prints what its comments say', () => {
  const md = readFileSync('docs/reference/api.md', 'utf8');
  const demo = /## Working demo[\s\S]*?```ts\n([\s\S]*?)```/.exec(md)?.[1];
  expect(demo, 'the API page has a working demo').toBeTruthy();
  const printed: unknown[] = [];
  const expected: unknown[] = [];
  const code = demo!
    .replace(/^import \{([^}]*)\} from '@smaltworks\/smaltcy';$/m, 'const {$1} = smaltcy;')
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
  new Function('smaltcy', 'print', code)(smaltcy, (v: unknown) => printed.push(v));
  expect(printed).toEqual(expected);
});
