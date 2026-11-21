'use strict';

class TtlCache {
  constructor({ ttlMs, maxStaleMs = 6 * 60 * 60 * 1000, maxEntries = 500, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxStaleMs = maxStaleMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.inflight = new Map();
  }

  peek(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.storedAt > this.maxStaleMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key, value) {
    const entry = { value, storedAt: this.now() };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return entry;
  }

  async getOrFetch(key, fetcher) {
    const entry = this.peek(key);
    if (entry && this.now() - entry.storedAt <= this.ttlMs) {
      return { value: entry.value, storedAt: entry.storedAt, stale: false, fromCache: true };
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      const run = async () => this.set(key, await fetcher());
      pending = run().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }

    try {
      const fresh = await pending;
      return { value: fresh.value, storedAt: fresh.storedAt, stale: false, fromCache: false };
    } catch (error) {
      if (entry) {
        return { value: entry.value, storedAt: entry.storedAt, stale: true, fromCache: true, error };
      }
      throw error;
    }
  }
}

module.exports = { TtlCache };
