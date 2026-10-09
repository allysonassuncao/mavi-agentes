import { closeDb } from "./db.js";
import { log } from "./log.js";
import { closeQueues } from "./queue.js";
import { closeRedis } from "./redis.js";
import { startWorkers } from "./worker.js";

const workers = startWorkers();
log.info("worker no ar");

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, async () => {
    log.info("worker: encerrando (termina o que está em andamento)");
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([closeQueues(), closeRedis(), closeDb()]);
    process.exit(0);
  });
}
