import { describe, expect, it } from 'vitest';
import { lazy } from './lazy';

describe('lazy', () => {
  it('memoises the promise but forgets a rejection so the next call retries', async () => {
    let calls = 0;
    const load = lazy(async () => {
      if (++calls === 1) throw new Error('boom');
      return calls;
    });
    await expect(load()).rejects.toThrow('boom');
    expect(await load()).toBe(2);
    expect(await load()).toBe(2);
    expect(calls).toBe(2);
  });
});
