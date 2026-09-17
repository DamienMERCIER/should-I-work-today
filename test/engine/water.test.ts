import { describe, it, expect } from 'vitest';
import { wetsuitFor } from '../../src/engine/water';

describe('wetsuitFor', () => {
  it('follows the usual chart, degree by degree at each boundary', () => {
    expect([25, 24, 23].map(wetsuitFor)).toEqual(['lycra', 'lycra', 'shorty']);
    expect([20, 19].map(wetsuitFor)).toEqual(['shorty', 'full32']);
    expect([17, 16].map(wetsuitFor)).toEqual(['full32', 'full43']);
    expect([14, 13].map(wetsuitFor)).toEqual(['full43', 'full54']);
    expect([11, 10, 8].map(wetsuitFor)).toEqual(['full54', 'full54Cold', 'full54Cold']);
  });
});
