import { describe, it, expect } from 'vitest';
import worker from '../src/index';

describe('worker entrypoint', () => {
  it('answers GET / with 200', async () => {
    const res = await worker.fetch(new Request('https://example.com/'), {} as never, {} as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('should-i-work');
  });
});
