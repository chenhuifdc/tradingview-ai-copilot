/**
 * Zero-dependency in-memory LRU + TTL Cache, Single-Flight request coalescing,
 * and Per-Node Circuit Breaker for market data resilience.
 */

class LruTtlCache {
  constructor({ maxEntries = 200, defaultTtlMs = 60000, nowFn = () => Date.now(), sweepIntervalMs = 0 } = {}) {
    this.maxEntries = Math.max(1, Number(maxEntries) || 200);
    this.defaultTtlMs = Math.max(1, Number(defaultTtlMs) || 60000);
    this.nowFn = nowFn;
    this.store = new Map();
    this.sweepTimer = null;

    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.pruneExpired(), sweepIntervalMs);
      if (typeof this.sweepTimer.unref === 'function') {
        this.sweepTimer.unref();
      }
    }
  }

  get size() {
    return this.store.size;
  }

  getEntry(key, { allowStale = false, maxStaleMs = 0 } = {}) {
    const entry = this.store.get(key);
    if (!entry) return null;

    const now = this.nowFn();
    const ageMs = Math.max(0, now - entry.createdAt);
    const isExpired = now > entry.expiresAt;

    if (!isExpired) {
      // Refresh LRU order
      this.store.delete(key);
      this.store.set(key, entry);
      return {
        value: entry.value,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        ageMs,
        stale: false
      };
    }

    if (allowStale && maxStaleMs > 0) {
      if (ageMs <= maxStaleMs) {
        return {
          value: entry.value,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          ageMs,
          stale: true
        };
      }
      this.store.delete(key);
    }
    return null;
  }

  get(key) {
    const hit = this.getEntry(key, { allowStale: false });
    return hit ? hit.value : undefined;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    const now = this.nowFn();
    const effectiveTtl = Math.max(1, Number(ttlMs) || this.defaultTtlMs);

    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      this.pruneExpired();
      while (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey === undefined) break;
        this.store.delete(oldestKey);
      }
    }

    const entry = {
      value,
      createdAt: now,
      expiresAt: now + effectiveTtl
    };
    this.store.set(key, entry);
    return value;
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  pruneExpired(maxRetentionMs = 0) {
    const now = this.nowFn();
    let removed = 0;
    for (const [k, entry] of this.store.entries()) {
      const deadline = maxRetentionMs > 0
        ? Math.max(entry.expiresAt, entry.createdAt + maxRetentionMs)
        : entry.expiresAt;
      if (now > deadline) {
        this.store.delete(k);
        removed += 1;
      }
    }
    return removed;
  }
}

class SingleFlightGroup {
  constructor() {
    this.inFlight = new Map();
  }

  get inFlightCount() {
    return this.inFlight.size;
  }

  async do(key, fn) {
    if (this.inFlight.has(key)) {
      const shared = await this.inFlight.get(key);
      return { value: shared, shared: true };
    }

    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    const value = await promise;
    return { value, shared: false };
  }
}

class CoalescingLruCache {
  constructor(options = {}) {
    this.cache = new LruTtlCache(options);
    this.singleFlight = new SingleFlightGroup();
  }

  get size() {
    return this.cache.size;
  }

  get(key) {
    return this.cache.get(key);
  }

  getEntry(key, opts) {
    return this.cache.getEntry(key, opts);
  }

  set(key, value, ttlMs) {
    return this.cache.set(key, value, ttlMs);
  }

  clear() {
    this.cache.clear();
  }

  async getOrLoad(key, loaderFn, ttlMs) {
    const cached = this.cache.getEntry(key, { allowStale: false });
    if (cached) {
      return {
        value: cached.value,
        fromCache: true,
        coalesced: false,
        createdAt: cached.createdAt,
        ageMs: cached.ageMs,
        stale: false
      };
    }

    const { value, shared } = await this.singleFlight.do(key, async () => {
      const fresh = await loaderFn();
      this.cache.set(key, fresh, ttlMs);
      return fresh;
    });

    const entry = this.cache.getEntry(key, { allowStale: true, maxStaleMs: Number.MAX_SAFE_INTEGER });
    return {
      value,
      fromCache: false,
      coalesced: shared,
      createdAt: entry ? entry.createdAt : this.cache.nowFn(),
      ageMs: entry ? entry.ageMs : 0,
      stale: false
    };
  }
}

class NodeCircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 30000, nowFn = () => Date.now() } = {}) {
    this.failureThreshold = Math.max(1, Number(failureThreshold) || 3);
    this.cooldownMs = Math.max(100, Number(cooldownMs) || 30000);
    this.nowFn = nowFn;
    this.nodes = new Map();
  }

  _getState(nodeId) {
    if (!this.nodes.has(nodeId)) {
      this.nodes.set(nodeId, {
        state: 'CLOSED',
        failures: 0,
        openedAt: 0,
        halfOpenInFlight: false
      });
    }
    return this.nodes.get(nodeId);
  }

  getNodeStatus(nodeId) {
    const st = this._getState(nodeId);
    const now = this.nowFn();
    if (st.state === 'OPEN' && now - st.openedAt >= this.cooldownMs) {
      return { state: 'HALF_OPEN', failures: st.failures };
    }
    return { state: st.state, failures: st.failures };
  }

  canAttempt(nodeId) {
    const st = this._getState(nodeId);
    const now = this.nowFn();

    if (st.state === 'CLOSED') {
      return { allowed: true, state: 'CLOSED', halfOpenProbe: false };
    }

    if (st.state === 'OPEN') {
      if (now - st.openedAt >= this.cooldownMs) {
        st.state = 'HALF_OPEN';
        st.halfOpenInFlight = true;
        return { allowed: true, state: 'HALF_OPEN', halfOpenProbe: true };
      }
      return { allowed: false, state: 'OPEN', halfOpenProbe: false };
    }

    // HALF_OPEN
    if (!st.halfOpenInFlight) {
      st.halfOpenInFlight = true;
      return { allowed: true, state: 'HALF_OPEN', halfOpenProbe: true };
    }
    return { allowed: false, state: 'HALF_OPEN', halfOpenProbe: false };
  }

  recordSuccess(nodeId) {
    const st = this._getState(nodeId);
    st.state = 'CLOSED';
    st.failures = 0;
    st.openedAt = 0;
    st.halfOpenInFlight = false;
  }

  recordFailure(nodeId) {
    const st = this._getState(nodeId);
    const now = this.nowFn();
    st.failures += 1;
    st.halfOpenInFlight = false;
    if (st.state === 'HALF_OPEN' || st.failures >= this.failureThreshold) {
      st.state = 'OPEN';
      st.openedAt = now;
    }
  }

  reset() {
    this.nodes.clear();
  }
}

module.exports = {
  LruTtlCache,
  SingleFlightGroup,
  CoalescingLruCache,
  NodeCircuitBreaker
};
