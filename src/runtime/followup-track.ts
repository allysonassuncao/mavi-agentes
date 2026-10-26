import { db } from "../db.js";
import { activeDeals, type Deal } from "../integrations/deals.js";
import { rest } from "../makecrm/client.js";
import type { FollowupStepT, FollowupT } from "../spec/followup.js";

/**
 * Qual régua vale para o lead (a "trilha"): a padrão ou a da etapa do funil em
 * que a oportunidade dele está. Com etapas escolhidas no Follow-up, lead com
 * oportunidade aberta fora delas não recebe; lead sem oportunidade recebe a
 * padrão. Conferida ao começar a régua e antes de cada envio.
 */

export type FollowupTrack = { key: string; steps: FollowupStepT[] };
export const DEFAULT_TRACK = "default";

/** A trilha pelas oportunidades abertas (null = sem follow-up). Vale a primeira etapa da lista em que houver oportunidade. */
export function pickTrack(fu: FollowupT, deals: Pick<Deal, "pipeline_id" | "stage_id">[]): FollowupTrack | null {
  if (!fu.stages.length || !deals.length) return { key: DEFAULT_TRACK, steps: fu.steps };
  for (const st of fu.stages)
    if (deals.some((d) => d.stage_id === st.stage_id && d.pipeline_id === st.pipeline_id))
      return st.steps.length ? { key: st.stage_id, steps: st.steps } : { key: DEFAULT_TRACK, steps: fu.steps };
  return null;
}

/** Os passos de uma trilha já guardada (a etapa saiu da configuração: a padrão). */
export function trackSteps(fu: FollowupT, key: string | null | undefined): FollowupStepT[] {
  const st = key && key !== DEFAULT_TRACK ? fu.stages.find((s) => s.stage_id === key) : undefined;
  return st?.steps.length ? st.steps : fu.steps;
}

/** As oportunidades abertas do lead: as ligadas à conversa e as do contato da conversa. */
export async function followupDeals(makecrmConversationId: string): Promise<Deal[]> {
  const enc = encodeURIComponent(makecrmConversationId);
  const [linked, [conv]] = await Promise.all([
    activeDeals(makecrmConversationId),
    rest<{ contact_id: string | null }[]>(`inbox_conversations?select=contact_id&id=eq.${enc}`),
  ]);
  if (!conv?.contact_id) return linked;
  const byContact = await rest<Deal[]>(
    `pipeline_deals?select=id,pipeline_id,stage_id,contact_id,user_id,sdr_id,closer_id,name&contact_id=eq.${encodeURIComponent(conv.contact_id)}&status=eq.1`,
  );
  return [...linked, ...byContact.filter((d) => !linked.some((l) => l.id === d.id))];
}

/** A trilha agora (sem etapas escolhidas, nem consulta o MakeCRM). */
export async function currentTrack(fu: FollowupT, conv: { simulation: boolean; external_id: string }): Promise<FollowupTrack | null> {
  if (!fu.stages.length || conv.simulation) return { key: DEFAULT_TRACK, steps: fu.steps };
  return pickTrack(fu, await followupDeals(conv.external_id));
}

/** Começa a régua do zero a partir de agora, na trilha do lead (fora das etapas: fica parada). */
export async function startFollowup(fu: FollowupT, conv: { id: string; simulation: boolean; external_id: string }): Promise<boolean> {
  const sql = db();
  const track = await currentTrack(fu, conv).catch(() => ({ key: DEFAULT_TRACK, steps: fu.steps }));
  if (!track?.steps.length) {
    await sql`update public.conversations set followup_next_at = null, followup_state = 'idle', followup_track = null where id = ${conv.id}`;
    return false;
  }
  await sql`
    update public.conversations set followup_step = 0, followup_state = 'active', followup_track = ${track.key},
      followup_next_at = now() + make_interval(mins => ${track.steps[0]!.after_minutes})
    where id = ${conv.id}`;
  return true;
}
