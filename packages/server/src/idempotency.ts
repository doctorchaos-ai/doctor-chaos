/**
 * In-memory idempotency cache for POST endpoints.
 *
 * Scope note: this cache is **process-local and does not survive
 * restart**. That is acceptable for the A0 dogfood target (see design
 * doc §3 — "Idempotency Key 实现"), where a single user occasionally
 * restarts the daemon. If A2 dogfood surfaces this as a real problem,
 * persist the cache alongside the snapshot — see deferred item D-idem.
 */

import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * What we remember for each replayed key — enough to reproduce the
 * original HTTP response exactly.
 */
export interface CachedResponse {
  readonly status: ContentfulStatusCode;
  readonly body: unknown;
}

/**
 * Construction options for {@link IdempotencyCache}.
 */
export interface IdempotencyCacheOptions {
  /** Maximum number of entries before LRU eviction kicks in. Default: 1000. */
  readonly capacity?: number;

  /** Entry TTL in milliseconds. Default: 10 minutes. */
  readonly ttlMs?: number;

  /** Clock source — replaceable so tests can advance time without waiting. */
  readonly now?: () => number;
}

interface Entry {
  readonly value: CachedResponse;
  readonly expiresAt: number;
}

/**
 * A small capacity-bounded, TTL-expiring map, implemented on top of
 * JavaScript's `Map` (which preserves insertion order).
 *
 * We pay O(1) amortised for both `get` and `set`, and trade away the
 * ability to touch an entry to refresh its LRU position on read —
 * the use case here is "a burst of retries within a few seconds", so
 * ordinary insertion order is the right semantics.
 */
export class IdempotencyCache {
  private readonly store = new Map<string, Entry>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: IdempotencyCacheOptions = {}) {
    this.capacity = options.capacity ?? 1000;
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Retrieve a cached response. Returns `undefined` if the key is
   * unknown or has expired. Expired entries are deleted lazily on
   * access — no background timer runs.
   */
  get(key: string): CachedResponse | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Remember a response for future retries. If the cache is at
   * capacity, the oldest entry (first inserted) is evicted first.
   */
  set(key: string, value: CachedResponse): void {
    // If we're replacing an existing key, delete first so the new
    // insertion lands at the end of the insertion order and the key
    // is treated as freshly inserted for eviction purposes.
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
    if (this.store.size > this.capacity) {
      // The oldest entry is the first one yielded by `.keys()`.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
  }

  /**
   * Number of live entries. Useful in tests and diagnostics.
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Drop all entries. Primarily a test-hook; production code has no
   * business calling this.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Build a composite cache key from tenant id and client-supplied
   * idempotency key. Exposed as a helper so route handlers and
   * tests stay consistent.
   */
  static buildKey(tenantId: string, idempotencyKey: string): string {
    return `${tenantId}:${idempotencyKey}`;
  }
}
