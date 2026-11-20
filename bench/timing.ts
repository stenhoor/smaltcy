/**
 * How the benchmarks time things, on a machine that isn't quiet. In a cloud container one query took 30 ms in one
 * second and 55 ms in the next, slow stretches lasting a second or more (docs/research/benchmarks.md, "Method"): a
 * median over 7 runs depends on when they ran, and two engines timed one after the other don't meet the same machine.
 *
 * So the engines take turns. Each runs the thing for a short round, then the next engine does, ROUNDS times over. An
 * engine's time is the lowest of its rounds' medians: the machine at its quietest. Its ratio to the first engine is the
 * median of the rounds' ratios, each of two rounds run back to back, which a slow second slows alike: where the times
 * and the ratio disagree, the ratio is the one to read.
 */

/** BENCH_ROUNDS: how many rounds each engine runs. */
export const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 15);
// A round runs the thing until ROUND_MS has passed: at least LEAST times, at most MOST.
const ROUND_MS = 100;
const LEAST = 3;
const MOST = 200;

/** What a benchmark prints under its heading: how its times were taken. */
export const METHOD = `ms: the lowest median of ${ROUNDS} rounds, the engines taking turns; ratio: the median of the rounds' ratios`;

export const median = (ts: readonly number[]): number => [...ts].sort((a, b) => a - b)[Math.floor(ts.length / 2)]!;

/** The time `fn` takes, ms. */
export function timed(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

export interface Times {
  /** For each engine, the lowest of its rounds' medians, ms. */
  readonly ms: number[];
  /** For each engine, the median over the rounds of its round's median over the first engine's in that round. */
  readonly ratio: number[];
}

/**
 * Times one thing on several engines. `engines[e]()` runs it once on engine `e` and returns the time that counts, ms
 * (what it does before and after timing, a setup or a cleanup, doesn't). Each engine runs once to warm up first.
 */
export function rounds(engines: readonly (() => number)[]): Times {
  for (const run of engines) run();
  const medians: number[][] = engines.map(() => []);
  for (let r = 0; r < ROUNDS; r++) {
    engines.forEach((run, e) => {
      const ts: number[] = [];
      let total = 0;
      for (let i = 0; i < LEAST || (i < MOST && total < ROUND_MS); i++) {
        const t = run();
        ts.push(t);
        total += t;
      }
      medians[e]!.push(median(ts));
    });
  }
  return { ms: medians.map((m) => Math.min(...m)), ratio: medians.map((m) => median(m.map((t, r) => t / medians[0]![r]!))) };
}
