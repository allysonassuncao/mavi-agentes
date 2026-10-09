// Aplica as migrações de supabase/migrations em ordem, uma vez cada.
//   DATABASE_URL_SESSION=... npm run migrate
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL;
if (!url) throw new Error("Defina DATABASE_URL_SESSION (ou DATABASE_URL).");

const dir = path.resolve("supabase/migrations");
const sql = postgres(url.split("?")[0]!, { max: 1, onnotice: () => {} });
try {
  await sql`create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now())`;
  await sql`alter table public._migrations enable row level security`;
  await sql`revoke all on public._migrations from anon, authenticated`;
  const done = new Set((await sql<{ name: string }[]>`select name from public._migrations`).map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const body = fs.readFileSync(path.join(dir, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into public._migrations (name) values (${f})`;
    });
    console.log(`aplicada: ${f}`);
  }
  console.log("migrações em dia");
} finally {
  await sql.end();
}
