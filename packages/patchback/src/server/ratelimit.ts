/**
 * In-memory fixed window limiter. Fine for a single container.
 * On serverless or multiple replicas, swap for Redis / Upstash / platform limits.
 *
 * The table is bounded: forged client addresses cannot grow it without limit.
 */
export function createRateLimiter(limit: number, windowMs = 10 * 60_000, maxKeys = 20_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  };
  setInterval(sweep, windowMs).unref?.();

  return {
    take(key: string): boolean {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt < now) {
        if (hits.size >= maxKeys) {
          sweep();
          // Still full: drop the oldest entries (Map keeps insertion order).
          for (const k of hits.keys()) {
            if (hits.size < maxKeys * 0.9) break;
            hits.delete(k);
          }
        }
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return limit > 0;
      }
      entry.count += 1;
      return entry.count <= limit;
    },
  };
}
