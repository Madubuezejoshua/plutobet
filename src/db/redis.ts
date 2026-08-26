import Redis from "ioredis";

/**
 * Shared Redis client (Upstash in production).
 *
 * Upstash speaks the Redis wire protocol over TLS, so one `rediss://` URL
 * works there and a plain `redis://` works locally and in tests. That keeps
 * tests running against a real Redis rather than a mock, which matters here:
 * the rate budget depends on Lua script atomicity that a fake would not
 * reproduce.
 *
 * Serverless note: `maxRetriesPerRequest: null` keeps a cold-start command
 * from being abandoned mid-flight, and lazy connect avoids paying for a
 * handshake on requests that never touch Redis.
 */

let redisClient: Redis | undefined;

export function getRedisClient(): Redis {
  const redisUrl = process.env.KV_URL?.trim() || process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error("REDIS_URL or KV_URL is required");
  }

  redisClient ??= new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableAutoPipelining: true,
  });
  return redisClient;
}

export const redis = new Proxy({} as Redis, {
  get(_target, property) {
    const client = getRedisClient();
    const member = Reflect.get(client, property, client);
    return typeof member === "function" ? member.bind(client) : member;
  },
});
