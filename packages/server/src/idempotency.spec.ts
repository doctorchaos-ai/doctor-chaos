import { describe, expect, it } from 'vitest';
import { IdempotencyCache } from './idempotency.js';

describe('IdempotencyCache', () => {
  it('returns undefined for unknown keys', () => {
    const cache = new IdempotencyCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('replays a stored response for the same key', () => {
    const cache = new IdempotencyCache();
    cache.set('k', { status: 200, body: { hello: 'world' } });
    expect(cache.get('k')).toEqual({ status: 200, body: { hello: 'world' } });
  });

  it('evicts the oldest entry once capacity is exceeded', () => {
    const cache = new IdempotencyCache({ capacity: 2 });
    cache.set('a', { status: 200, body: 'a' });
    cache.set('b', { status: 200, body: 'b' });
    cache.set('c', { status: 200, body: 'c' });
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')?.body).toBe('b');
    expect(cache.get('c')?.body).toBe('c');
    expect(cache.size()).toBe(2);
  });

  it('expires entries after their TTL', () => {
    let clock = 0;
    const cache = new IdempotencyCache({ ttlMs: 100, now: () => clock });
    cache.set('k', { status: 200, body: 'v' });
    clock = 99;
    expect(cache.get('k')?.body).toBe('v');
    clock = 101;
    expect(cache.get('k')).toBeUndefined();
    // Expired lookup is eagerly cleaned up.
    expect(cache.size()).toBe(0);
  });

  it('treats overwriting a key as a fresh insertion for eviction order', () => {
    const cache = new IdempotencyCache({ capacity: 2 });
    cache.set('a', { status: 200, body: 'a1' });
    cache.set('b', { status: 200, body: 'b' });
    // Overwriting 'a' should move it to the end so that inserting
    // 'c' evicts 'b' instead.
    cache.set('a', { status: 200, body: 'a2' });
    cache.set('c', { status: 200, body: 'c' });
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.body).toBe('a2');
    expect(cache.get('c')?.body).toBe('c');
  });

  it('buildKey composes tenant + idempotency key deterministically', () => {
    expect(IdempotencyCache.buildKey('default', 'xyz')).toBe('default:xyz');
  });
});
