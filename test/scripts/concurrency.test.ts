import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../../scripts/lib/concurrency';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const items = [30, 10, 20, 5];
    const results = await mapWithConcurrency(items, 4, async (ms) => {
      await delay(ms);
      return ms;
    });
    expect(results).toEqual([30, 10, 20, 5]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active--;
      return i;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (i) => {
      seen.push(i);
      return i;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles an empty input', async () => {
    const results = await mapWithConcurrency([], 4, async (i: number) => i);
    expect(results).toEqual([]);
  });

  it('handles a limit larger than the input', async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (i) => i * 2);
    expect(results).toEqual([2, 4]);
  });
});
