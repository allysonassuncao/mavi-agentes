// Cria uma chave para a API de administração e mostra UMA vez.
//   DATABASE_URL=... npm run api-client -- "MAVI Tasks" [empresa1,empresa2]
import postgres from "postgres";
import { newToken, sha256 } from "../src/crypto.js";

const [name, companies] = process.argv.slice(2);
if (!name) throw new Error('Uso: npm run api-client -- "Nome" [empresas separadas por vírgula]');
const url = process.env.DATABASE_URL_SESSION ?? process.env.DATABASE_URL;
if (!url) throw new Error("Defina DATABASE_URL.");
const sql = postgres(url.split("?")[0]!, { max: 1, prepare: false });
const key = newToken("mva_");
const scope = companies ? companies.split(",").map((s) => s.trim()).filter(Boolean) : null;
await sql`insert into public.api_clients (name, key_hash, key_hint, company_scope) values (${name}, ${sha256(key)}, ${key.slice(-4)}, ${scope})`;
await sql.end();
console.log(`Chave de "${name}" (guarde agora; não é mostrada de novo):\n${key}`);
