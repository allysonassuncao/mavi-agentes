# MAVI Agentes — plano

Motor de agentes conversacionais da Make Vendas. Projeto separado do MAVI Tasks,
do MakeCRM e do mavi-llm.

- **MAVI Tasks** constrói e orquestra (construtor completo, simulador, versões,
  conhecimento, custos). Fala só com a API deste motor.
- **Construtor do MakeCRM** (Fase 6) grava a mesma especificação pela mesma API,
  com um subconjunto das opções, para os clientes que se configuram sozinhos.
- **Motor** (este repositório) recebe as mensagens do MakeCRM, pensa e responde.
  Continua funcionando mesmo se o MAVI Tasks ou a Vercel caírem.
- **MakeCRM** continua dono das conversas e dos canais. O motor só recebe pelo
  webhook de IA da caixa (`agent_inbox_webhooks`) e responde pela `sendMessage`.
- **mavi-llm e os fluxos do n8n** continuam como estão. Só agentes novos nascem aqui.

## O que o levantamento mostrou (08/10/2026)

- 1.397 fluxos nas 2 VPS, 287 ativos, **59 agentes de cliente** (mediana de 96 nós).
- ~55 dos 59 têm **o mesmo esqueleto**: recebe → bloqueio → junta mensagens
  (Redis + espera) → transcreve áudio / lê imagem e PDF → AI Agent com memória
  Postgres + Think + saída em frases → envia frase a frase pelo MakeCRM → log e
  custo. **Esse esqueleto é o pipeline fixo do motor: não se configura.**
- O que varia: o prompt e **285 ferramentas-subfluxo** (mediana 10 nós):
  ~47% CRM/banco, ~16% validação/cálculo, ~15% API de terceiro, ~11% IA dentro,
  ~10% Google Agenda.
- ~100 fluxos satélite: follow-ups, lembretes, eventos de pagamento, disparos.
- Prompts com mediana de **~25 mil caracteres** (p90 ~74 mil), tudo a cada
  chamada. **Nenhum agente usa base vetorizada.**

## Arquitetura

```
WhatsApp ─▶ Go (MakeCRM) ─POST /v1/inbound/makecrm/<token>─▶ API ─▶ fila (Redis)
                                                                     │
                       ┌──────────── worker ◀────────────────────────┘
                       │ junta mensagens → mídia → memória → busca no conhecimento
                       │ → LLM com ferramentas → responder(frases + mídias)
                       ▼
             sendMessage (MakeCRM) ─▶ WhatsApp

MAVI Tasks ─▶ API de administração (agentes, versões, conhecimento, simulador, rastros)
```

- **Stack:** Node 22 + TypeScript, Fastify, BullMQ (Redis), Postgres do projeto
  Supabase `mavi-agentes` (São Paulo) com pgvector, Supabase Storage para arquivos.
- **Processos:** `api` (HTTP) e `worker` (fila), mesma imagem Docker, em contêineres
  nos servidores da Make Vendas (`agentes.maso.app.br`). Escala horizontal: mais
  workers.
- **Só o motor acessa o banco do motor.**

## Especificação do agente (`mavi-agent/v1`)

Um JSON versionado (`src/spec/agent.ts`). Rascunho editável; publicar cria uma
versão imutável; voltar = publicar uma versão antiga de novo.

| Bloco | O que tem |
|---|---|
| `persona` | nome, papel, empresa, resumo, segmento, endereço, idioma, tom, tamanho das respostas, emojis |
| `instructions` | objetivo, roteiro da conversa, regras, o que nunca fazer, horários, texto livre |
| `knowledge` | liga/desliga, quantos trechos na pré-busca, ferramenta de busca, reordenação |
| `memory` | quantas mensagens recentes, resumo, dados do contato a coletar |
| `media` | entender áudio, imagem, documento |
| `buffer` | segundos esperando o lead terminar de digitar |
| `output` | máximo de mensagens por resposta, atraso de digitação, ajustes de texto |
| `model` | provedor, modelo, modelo reserva, esforço |
| `handoff` | quando e como passar para humano |
| `tools` | ferramentas (Fase 2+) |
| `automations` | automações (Fase 4) |

## Conhecimento (RAG) — Fase 1

Objetivo: prompt enxuto e o agente buscando só o que importa.

- **Núcleo fixo** (persona, regras, roteiro) no prompt de sistema, estável para o
  cache de prompt do provedor. Data, hora, dados do contato e trechos encontrados
  entram no fim, na mensagem da vez.
- **Base por tipo** (`knowledge_items`): `faq` (um par por trecho), `product` (um
  item por trecho, com atributos em `meta`), `document` (PDF/DOCX/texto/página,
  em trechos com uma frase de contexto gerada na entrada), `media` (descrição da
  mídia → o agente acha e envia a certa), `example` (boas conversas/objeções),
  `text` (texto livre).
- **Busca híbrida** (`kb_search`): vetor (pgvector HNSW, `text-embedding-3-small`,
  1536) + palavra-chave (tsvector português sem acento), unidos por RRF.
  Reordenação por LLM opcional por agente.
- **Pré-busca automática** a cada vez (última mensagem + resumo) e ferramenta
  `buscar_conhecimento` para o agente pesquisar mais.
- **Memória do contato:** últimas N mensagens + resumo da conversa + dados
  coletados (`registrar_dados_do_contato`).
- Só conteúdo escolhido para o lead entra na base.

## Pipeline de uma resposta

1. **Entrada** (`POST /v1/inbound/makecrm/<token>`): o token identifica a ligação
   agente ↔ caixa. Responde 202 na hora. Ignora `from_me`. Guarda a mensagem
   (sem duplicar pelo `source_id`). **Nunca grava `provider_token`.**
2. **Espera** (`buffer.seconds`): cada mensagem agenda uma vez; só a mais recente
   roda. Trava por conversa (uma resposta por vez).
3. **Mídia:** áudio → transcrição; imagem → descrição; PDF/DOCX → texto.
4. **Contexto:** núcleo + histórico + resumo + dados do contato + pré-busca.
5. **LLM com ferramentas** até 6 rodadas. A resposta sai sempre pela ferramenta
   `responder` (frases + mídias), ou silêncio com motivo.
6. **Envio** frase a frase pela `sendMessage`, com atraso de digitação.
7. **Rastro** (`turns`): modelo, tokens, custo, tempo por etapa, ferramentas,
   trechos usados, saída, erro. Rastros ficam 90 dias; totais diários ficam.

Passagem para humano: o Go já desliga a IA da conversa quando alguém responde
pelo aparelho. A ferramenta `transferir_para_humano` desliga também
(`inbox_conversations.ia_actived = false` + nota privada).

## API de administração (Fase 1)

Chave por cliente da API (`api_clients`, só o hash é guardado). MAVI Tasks usa a
sua pelo servidor, nunca pelo navegador.

- `POST /v1/agents` · `GET /v1/agents` · `GET /v1/agents/:id`
- `PUT /v1/agents/:id/draft` · `POST /v1/agents/:id/publish` · `GET /v1/agents/:id/versions`
- `POST /v1/agents/:id/bindings` (liga a uma caixa do MakeCRM) · `DELETE /v1/bindings/:id`
- `POST /v1/agents/:id/knowledge` (texto, FAQ, produto, mídia, URL) · arquivo por
  multipart · `GET` lista · `DELETE` · `POST /v1/agents/:id/knowledge/search` (teste)
- `POST /v1/agents/:id/simulate` (rascunho ou versão; não envia nada)
- `GET /v1/agents/:id/turns` · `GET /v1/turns/:id` · `GET /v1/agents/:id/usage` · `GET /v1/agents/:id/conversations` · `GET /v1/agents/:id/conversations/:cid/messages`
- `GET /v1/agents/:id/gaps` · `GET|PATCH /v1/agents/:id/gap-topics/:tid` · `POST …/suggest|apply|merge`
- `GET /v1/agents/:id/report` · `POST /v1/agents/:id/reading` · `GET /v1/agents/:id/insights/conversations` · `GET /v1/agents/:id/conversations/:cid/insight`

## Lacunas e insights

- **Lacunas:** na mesma chamada da resposta, o agente avisa (campo `lacunas` da
  ferramenta `responder`) perguntas/objeções que o treinamento não cobre. Só nas
  conversas reais (`gaps`). A cada 2 min o worker agrupa as novas em temas pelo
  vetor (`gap_topics`, parecido ≥ 0,8; com 3+ ocorrências a MAVI dá o título).
  A MAVI sugere a resposta (conhecimento + perfil + como a equipe respondeu no
  MakeCRM) e, aplicada, ela entra como pergunta frequente; o tema fica
  "treinado" e conta se voltar a aparecer. Cobertura = respostas sem lacuna.
- **Insights:** cada conversa da amostra (`agents.insights_sample_percent`,
  fixa por conversa: hash do id) é lida 3 h depois de esfriar
  (`conversation_insights`: resultado, motivo, objeções, sentimento, falhas).
  O relatório junta números exatos (mensagens, rastros, reuniões, follow-up,
  custo) com a amostra, sempre contra o período anterior; a Leitura da MAVI
  (`agent_readings`) cita as conversas que sustentam cada ponto.
- O resumo semanal na Caixa de entrada fica no MAVI Tasks (quem recebe e o
  envio); o motor só dá o relatório e a Leitura.

## Fases

| Fase | Entrega |
|---|---|
| **1** | Motor + conhecimento + simulador + publicação; no MAVI Tasks: criar agente, editar, base de conhecimento, simulador, publicar, ligar caixa, rastros. **Piloto: cliente 774.** |
| 2 | Ferramentas nativas: MakeCRM (mover etapa, responsável, campos, notas, notificar grupo), Google Agenda, utilitários, sub-agente, resumo. |
| 3 | Conector de API + modelos prontos (RD, Kommo, Advbox, ZapSign…), cofre de credenciais, ação composta em passos, passo de código (só equipe Make Vendas). |
| 4 | Automações: follow-ups, lembretes, webhooks de entrada (pagamento/checkout), disparos. |
| 5 | Lacunas, exemplos aprendidos, criar com a MAVI, conversas-teste e avaliação, modelos por nicho, roteador de modelos. |
| 6 | Construtor do MakeCRM gravando no motor; Instagram/TikTok (exige mudança no Go). |

## Limitações conhecidas

- O Go guarda a URL do webhook de IA por 1 h no Redis dele: ligar/desligar uma
  caixa pode levar até 1 h para valer.
- Se alguém salvar de novo as "Conexões" do agente na tela atual do MakeCRM, a URL
  volta a ser a do mavi-llm (corrigido na Fase 6).
- Só WhatsApp (o Go só leva Uazapi e Business API à IA).
