import postgres from "postgres";
import { config } from "./config.js";

let client: postgres.Sql | null = null;

/** Conexão do motor (transaction pooler do Supabase: sem prepared statements). */
export function db(): postgres.Sql {
  if (!client) {
    const c = config();
    client = postgres(c.DATABASE_URL.split("?")[0]!, {
      max: c.DB_POOL_MAX,
      prepare: false,
      idle_timeout: 30,
      connect_timeout: 15,
      onnotice: () => {},
      transform: { undefined: null },
    });
  }
  return client;
}

export async function closeDb() {
  await client?.end({ timeout: 5 });
  client = null;
}

/** pgvector espera '[0.1,0.2,...]'. */
export const toVector = (v: number[]) => `[${v.join(",")}]`;
