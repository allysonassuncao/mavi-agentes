import { Redis } from "ioredis";
import { config } from "./config.js";

/** Conexões novas por uso (BullMQ exige maxRetriesPerRequest null nos workers). */
export function redisConnection(forWorker = false): Redis {
  return new Redis(config().REDIS_URL, {
    maxRetriesPerRequest: forWorker ? null : 3,
    enableReadyCheck: true,
  });
}

let shared: Redis | null = null;
export function redis(): Redis {
  if (!shared) shared = redisConnection();
  return shared;
}
export async function closeRedis() {
  await shared?.quit();
  shared = null;
}
