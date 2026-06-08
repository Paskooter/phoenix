// In-memory TTL cache — the Redis substitute for the relay layer (lasso used Redis with EX).
// The datastore is an implementation detail behind the {relayData, lassoDataFromRedis} contract.

export class TTLCache {
  constructor() { this.m = new Map(); }

  get(key) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp <= Date.now()) { this.m.delete(key); return null; }
    return e.v;
  }

  set(key, value, ttlSeconds) {
    this.m.set(key, { v: value, exp: Date.now() + ttlSeconds * 1000 });
  }

  clear() { this.m.clear(); }
}
