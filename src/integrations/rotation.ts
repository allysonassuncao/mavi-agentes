import { db } from "../db.js";
import { rest } from "../makecrm/client.js";
import type { RotationUserT } from "../spec/integrations.js";
import { spDayKey, spMinutes, spYmd, hmToMin } from "./time.js";

/**
 * Rodízio por peso (como o MakeCRM): entre quem está disponível agora, o que
 * tem menos escolhas abaixo do peso; quando todos chegam ao peso, zera.
 * Disponível = sem "não receber novas oportunidades" no MakeCRM e, quando
 * pedido, dentro do horário de trabalho cadastrado lá.
 */

const DAY_NAME: Record<string, string> = { sun: "sunday", mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday" };

type WorkHours = Record<string, { enabled?: boolean; sessions?: { start: string; end: string }[] }>;

export async function availableUsers(users: RotationUserT[], now = new Date()): Promise<RotationUserT[]> {
  if (!users.length) return [];
  const ids = users.map((u) => u.user_id).join(",");
  const [hours, settings] = await Promise.all([
    users.some((u) => u.work_hours) ? rest<{ user_id: string; settings: WorkHours }[]>(`user_work_hours?select=user_id,settings&user_id=in.(${ids})`) : [],
    rest<{ user_id: string; settings: { settings?: { disable_distribuition_new_deal?: boolean } }[] | null }[]>(`user_settings?select=user_id,settings&user_id=in.(${ids})`),
  ]);
  const day = DAY_NAME[spDayKey(spYmd(now))]!;
  const minute = spMinutes(now);
  return users.filter((u) => {
    const st = settings.find((s) => s.user_id === u.user_id)?.settings;
    if (Array.isArray(st) && st.some((x) => x?.settings?.disable_distribuition_new_deal === true)) return false;
    if (!u.work_hours) return true;
    const wh = hours.find((h) => h.user_id === u.user_id)?.settings?.[day];
    if (!wh?.enabled) return false;
    return (wh.sessions ?? []).some((s) => minute >= hmToMin(s.start) && minute < hmToMin(s.end));
  });
}

/** A ordem de preferência agora (o primeiro é o da vez). */
export async function rotationOrder(agentId: string, key: string, users: RotationUserT[]): Promise<RotationUserT[]> {
  if (users.length <= 1) return users;
  const counts = new Map(
    (await db()<{ user_id: string; count: number }[]>`
      select user_id, count from public.integration_rotation where agent_id = ${agentId} and rotation_key = ${key}`).map((r) => [r.user_id, r.count]),
  );
  const c = (u: RotationUserT) => counts.get(u.user_id) ?? 0;
  const below = users.filter((u) => c(u) < u.weight);
  const pool = below.length ? below : users;
  const rest_ = users.filter((u) => !pool.includes(u));
  return [...[...pool].sort((a, b) => c(a) / a.weight - c(b) / b.weight || c(a) - c(b)), ...rest_];
}

/** Marca a escolha (e zera quando todos chegaram ao peso). */
export async function commitRotation(agentId: string, key: string, users: RotationUserT[], chosen: string) {
  const sql = db();
  await sql`
    insert into public.integration_rotation (agent_id, rotation_key, user_id, count)
    values (${agentId}, ${key}, ${chosen}, 1)
    on conflict (agent_id, rotation_key, user_id) do update set count = public.integration_rotation.count + 1, updated_at = now()`;
  const rows = await sql<{ user_id: string; count: number }[]>`
    select user_id, count from public.integration_rotation where agent_id = ${agentId} and rotation_key = ${key}`;
  const full = users.every((u) => (rows.find((r) => r.user_id === u.user_id)?.count ?? 0) >= u.weight);
  if (full) await sql`update public.integration_rotation set count = 0, updated_at = now() where agent_id = ${agentId} and rotation_key = ${key}`;
}

/** Escolhe e marca: o da vez entre os disponíveis (sem ninguém disponível, entre todos). */
export async function pickUser(agentId: string, key: string, users: RotationUserT[]): Promise<string | null> {
  if (!users.length) return null;
  const available = await availableUsers(users);
  const order = await rotationOrder(agentId, key, available.length ? available : users);
  const chosen = order[0]?.user_id ?? null;
  if (chosen) await commitRotation(agentId, key, users, chosen);
  return chosen;
}
