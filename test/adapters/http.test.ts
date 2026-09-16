import { describe, it, expect } from 'vitest';
import { safeEqual } from '../../src/adapters/http';

describe('safeEqual', () => {
  it('true for identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });
  it('false for same-length strings that differ', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
  it('false for different-length strings', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('true for two empty strings', () => {
    expect(safeEqual('', '')).toBe(true);
  });
});
