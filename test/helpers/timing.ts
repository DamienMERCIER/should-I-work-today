/**
 * The fastest of a few runs, in milliseconds.
 *
 * These measurements guard a CPU budget (10 ms per Worker invocation), and noise — a garbage collection, a
 * shared CI runner, another test file's threads — only ever adds time. The minimum is therefore the closest
 * thing to what a warm isolate pays, and a real regression still cannot hide behind it: something that got
 * slower multiplies every run, including the fastest one.
 */
export function fastestMs(run: () => void, attempts = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < attempts; i++) {
    const t0 = performance.now();
    run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}
