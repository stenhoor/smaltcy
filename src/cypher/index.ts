/**
 * Cypher for smaltcy (`@smaltworks/smaltcy/cypher`): text to graph plans. The engine never sees Cypher.
 */
import { functionsRegistered } from '../functions/library.js';
import type { GraphPlan } from '../plan/ops.js';
import { bind } from './binder.js';
import { parse } from './parser.js';

export interface CompiledCypher {
  readonly plan: GraphPlan;
  /** The text started with EXPLAIN. */
  readonly explain: boolean;
}

/**
 * The statements compiled lately, by their text: an application runs the same text again and again, with other
 * parameters, and a plan is immutable data, so one serves every run. Emptied when a function is registered, which can
 * change what a text binds to.
 */
const compiled = new Map<string, CompiledCypher>();
let compiledAt = 0;
/** How many texts are kept (the oldest goes first), and the longest text kept. */
const KEPT = 256;
const LONGEST = 4096;

/** Parses and binds one Cypher statement. The same text gives the same plan object while it is kept. */
export function compile(text: string): CompiledCypher {
  const now = functionsRegistered();
  if (now !== compiledAt) {
    compiled.clear();
    compiledAt = now;
  }
  const kept = compiled.get(text);
  if (kept !== undefined) return kept;
  const st = parse(text);
  const out: CompiledCypher = { plan: bind(st), explain: st.explain };
  if (text.length <= LONGEST) {
    if (compiled.size >= KEPT) compiled.delete(compiled.keys().next().value!);
    compiled.set(text, out);
  }
  return out;
}

export { parse } from './parser.js';
export { bind } from './binder.js';
export type * as ast from './ast.js';
