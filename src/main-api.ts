import { buildServer } from "./api/server.js";
import { config } from "./config.js";
import { closeDb } from "./db.js";
import { log } from "./log.js";
import { closeQueues } from "./queue.js";
import { closeRedis } from "./redis.js";

const app = await buildServer();
await app.listen({ host: "0.0.0.0", port: config().PORT });
log.info({ port: config().PORT }, "api no ar");

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, async () => {
    log.info("api: encerrando");
    await app.close();
    await Promise.allSettled([closeQueues(), closeRedis(), closeDb()]);
    process.exit(0);
  });
}
