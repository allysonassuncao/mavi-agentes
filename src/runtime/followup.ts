import { config } from "../config.js";
import { db } from "../db.js";
import { moveDealsTo, sendTeamNotice } from "../integrations/index.js";
import { addPrivateNote } from "../integrations/deals.js";
import { hmToMin, spDayKey, spMinutes, spYmd, addDays, spDate } from "../integrations/time.js";
import { chatWithFallback, type ChatMessage } from "../llm/client.js";
import { log } from "../log.js";
import { conversationAiOn, inboxType, listTemplates, rest, sendMessage, sendTemplate, wabaWindowOpen } from "../makecrm/client.js";
import { agentKeys } from "../secrets.js";
import type { FollowupStepT, FollowupT } from "../spec/followup.js";
import type { TeamNotifyConfig } from "../spec/integrations.js";
import type { WeeklyHours } from "../spec/weekly-hours.js";
import { cleanText, typingDelayMs } from "./output.js";
import { buildSystemPrompt, contextBlock } from "./prompt.js";
import { integrationCtx, publishedSpec, type ConversationRow } from "./turn.js";

/**
 * Uma etapa da régua de follow-up. Confere de novo, na hora, se ainda vale:
 * o lead não respondeu, a IA continua ligada na conversa no MakeCRM, não há
 * reunião marcada (se pedido) e está dentro dos horários de envio. Na caixa
 * oficial com a janela de 24h fechada, só vai o modelo aprovado da etapa.
 */

export type FollowupOutcome = "sent" | "skipped" | "postponed" | "stopped" | "finished" | "ignored";

/** O próximo momento dentro da janela de envio (ou o próprio "agora"). */
export function nextOpening(win: WeeklyHours | null, now = new Date()): Date {
  if (!win || !Object.values(win).some(Boolean)) return now;
  for (let i = 0; i < 8; i++) {
    const ymd = addDays(spYmd(now), i);
    const d = win[spDayKey(ymd) as keyof WeeklyHours];
    if (!d) continue;
    if (i === 0) {
      const m = spMinutes(now);
      if (m >= hmToMin(d.from) && m < (d.to === "23:59" ? 24 * 60 : hmToMin(d.to))) return now;
      if (m < hmToMin(d.from)) return spDate(ymd, d.from);
      continue;
    }
    return spDate(ymd, d.from);
  }
  return now;
}

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(nome|primeiro_nome|agente|empresa)\}/g, (_, k: string) => vars[k] ?? "");

export async function processFollowup(conversationId: string, step: number): Promise<FollowupOutcome> {
  const sql = db();
  const [conv] = await sql<(ConversationRow & { followup_step: number; followup_next_at: Date | null; followup_state: string })[]>`
    select * from public.conversations where id = ${conversationId}`;
  if (!conv || conv.simulation || conv.followup_state !== "active" || conv.followup_step !== step) return "ignored";
  if (!conv.followup_next_at || conv.followup_next_at.getTime() > Date.now() + 5_000) return "ignored";

  const stop = async () => {
    await sql`update public.conversations set followup_state = 'idle', followup_next_at = null where id = ${conv.id}`;
    return "stopped" as const;
  };
  const published = await publishedSpec(conv.agent_id);
  const fu: FollowupT | null = published?.spec.followup ?? null;
  if (!published || !fu?.enabled || !fu.steps[step]) return stop();
  const spec = published.spec;
  const s: FollowupStepT = fu.steps[step];

  // O lead respondeu depois da última mensagem do agente?
  const [last] = await sql<{ role: string }[]>`
    select role from public.messages where conversation_id = ${conv.id} and role in ('user', 'assistant') order by id desc limit 1`;
  if (last?.role === "user") return stop();
  if (!(await conversationAiOn(conv.external_id))) return stop();
  if (fu.skip_if_meeting) {
    const [m] = await sql`select 1 from public.agent_meetings where conversation_id = ${conv.id} and status = 'scheduled' and ends_at > now() limit 1`;
    if (m) return stop();
  }
  // Fora dos horários de envio: espera abrir.
  const opening = nextOpening(fu.window);
  if (opening.getTime() > Date.now() + 60_000) {
    await sql`update public.conversations set followup_next_at = ${opening} where id = ${conv.id}`;
    return "postponed";
  }

  const ctx = await integrationCtx(conv, spec);
  const vars = {
    nome: conv.contact_name ?? "",
    primeiro_nome: (conv.contact_name ?? "").split(/\s+/)[0] ?? "",
    agente: spec.persona.name,
    empresa: spec.persona.company,
  };
  const type = ctx.inboxId ? await inboxType(ctx.inboxId) : null;
  const closed = type === 2 && !(await wabaWindowOpen(conv.external_id));

  const [turn] = await sql<{ id: string }[]>`select gen_random_uuid() as id`;
  const turnId = turn!.id;
  let texts: string[] = [];
  let usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0 };
  let model: string | null = null;
  let note = "";

  try {
    if (closed) {
      if (!s.template) {
        note = "janela de 24h fechada e etapa sem modelo aprovado: pulada";
      } else {
        const tpl = (await listTemplates(conv.company_id)).find((t) => t.template_id === s.template!.template_id);
        if (!tpl) note = "modelo aprovado não encontrado no MakeCRM: pulada";
        else {
          const params = s.template.params.map((p) => fill(p, vars));
          await sendTemplate({ companyId: conv.company_id, conversationId: conv.external_id, inboxId: ctx.inboxId!, maviUserId: conv.mavi_user_id, template: tpl, params });
          texts = [`[modelo ${tpl.name}] ${params.join(" · ")}`];
        }
      }
    } else if (s.mode === "fixed") {
      texts = [cleanText(fill(s.text, vars), spec)];
    } else {
      const history = (
        await sql<{ role: "user" | "assistant"; content: string }[]>`
          select role, content from (select id, role, content from public.messages
            where conversation_id = ${conv.id} and role in ('user', 'assistant') order by id desc limit 30) h order by id`
      ).map((m) => ({ role: m.role, content: m.content }) as ChatMessage);
      const res = await chatWithFallback(
        {
          model: spec.model.model ?? config().DEFAULT_MODEL,
          keys: await agentKeys(conv.agent_id),
          pricing: spec.model.pricing,
          maxTokens: 600,
          messages: [
            { role: "system", content: buildSystemPrompt(spec) },
            ...history,
            {
              role: "user",
              content:
                `[Instrução do sistema — o lead não respondeu à sua última mensagem. Esta é a retomada ${step + 1} de ${fu.steps.length}.]\n` +
                "Escreva UMA retomada curta e natural (1 ou 2 mensagens curtas, separadas por uma linha em branco), sem repetir o que já disse e sem saudação longa. " +
                "Puxe o assunto de onde parou e convide o lead a responder. Responda só com o texto das mensagens.\n" +
                (s.text ? `Orientação: ${s.text}\n` : "") +
                contextBlock({ contactName: conv.contact_name, phone: conv.phone, facts: conv.facts, summary: conv.summary, retrieved: [] }),
            },
          ],
        },
        spec.model.fallback_model ?? config().FALLBACK_MODEL,
        spec.model.fallback_pricing,
      );
      usage = res.usage;
      model = res.model;
      texts = (res.message.content ?? "")
        .split(/\n\s*\n/)
        .map((t) => cleanText(t, spec))
        .filter(Boolean)
        .slice(0, 2);
    }

    if (!closed) {
      for (let i = 0; i < texts.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, typingDelayMs(texts[i]!)));
        await sendMessage({ companyId: conv.company_id, userId: conv.mavi_user_id, conversationId: conv.external_id, content: texts[i]! });
      }
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error({ conversationId: conv.id, step, err }, "follow-up: falhou");
    await sql`
      insert into public.turns (id, conversation_id, agent_id, agent_version, status, model, tokens_in, tokens_out, tokens_cached, cost_usd, output, error)
      values (${turnId}, ${conv.id}, ${conv.agent_id}, ${published.version}, 'error', ${model}, ${usage.tokensIn}, ${usage.tokensOut}, ${usage.tokensCached}, ${usage.costUsd},
              ${sql.json({ followup: step } as never)}, ${`Follow-up ${step + 1}: ${err}`.slice(0, 2000)})`;
    // Tenta de novo em 15 minutos (até a próxima resposta do lead).
    await sql`update public.conversations set followup_next_at = now() + interval '15 minutes' where id = ${conv.id}`;
    return "postponed";
  }

  // Registro e próxima etapa
  const next = fu.steps[step + 1];
  await sql.begin(async (tx) => {
    for (const t of texts)
      await tx`insert into public.messages (conversation_id, role, content, turn_id, meta) values (${conv.id}, 'assistant', ${t}, ${turnId}, ${tx.json({ followup: step } as never)})`;
    await tx`
      insert into public.turns (id, conversation_id, agent_id, agent_version, status, model, tokens_in, tokens_out, tokens_cached, cost_usd, output)
      values (${turnId}, ${conv.id}, ${conv.agent_id}, ${published.version}, ${texts.length ? "done" : "skipped"}, ${model},
              ${usage.tokensIn}, ${usage.tokensOut}, ${usage.tokensCached}, ${usage.costUsd},
              ${tx.json({ followup: step, messages: texts.map((t) => ({ text: t, media: [] })), note: note || null } as never)})`;
    if (next)
      await tx`update public.conversations set followup_step = ${step + 1}, last_reply_at = now(),
        followup_next_at = now() + make_interval(mins => ${next.after_minutes}) where id = ${conv.id}`;
    else await tx`update public.conversations set followup_step = ${step + 1}, followup_state = 'done', followup_next_at = null where id = ${conv.id}`;
  });
  if (next) return texts.length ? "sent" : "skipped";

  // Fim da régua sem resposta
  const end = fu.on_finish;
  try {
    if (end.move) await moveDealsTo(ctx, end.move.pipeline_id, end.move.stage_id, "fim do follow-up sem resposta", true);
    const notify = spec.integrations.find((i) => i.type === "team_notify" && i.enabled) as TeamNotifyConfig | undefined;
    if (end.notify && notify) await sendTeamNotice(notify, fill(end.notify, vars), ctx);
    if (end.turn_off_ai) {
      await rest(`inbox_conversations?id=eq.${encodeURIComponent(conv.external_id)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ ia_actived: false }),
      });
      if (ctx.inboxId) await addPrivateNote(conv.external_id, ctx.inboxId, "O follow-up da MAVI terminou sem resposta: a IA foi desligada nesta conversa.").catch(() => {});
    }
  } catch (e) {
    log.warn({ conversationId: conv.id, err: e instanceof Error ? e.message : String(e) }, "follow-up: ação do fim falhou");
  }
  return "finished";
}
