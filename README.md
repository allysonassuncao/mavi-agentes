# MAVI Agentes

Motor de agentes conversacionais da Make Vendas. Recebe as mensagens de WhatsApp
do MakeCRM, responde com o agente configurado (prompt + base de conhecimento +
ferramentas) e devolve pela `sendMessage` do MakeCRM.

Quem constrói os agentes (MAVI Tasks, construtor do MakeCRM) usa só a API de
administração. Plano completo em [docs/PLANO.md](docs/PLANO.md).

## Rodar localmente

```bash
npm install
cp .env.example .env   # preencha
npm run migrate        # aplica supabase/migrations no banco do motor
npm run dev:api        # http://localhost:8080
npm run dev:worker     # fila (respostas e base de conhecimento)
npm test
```

Precisa de um Redis (`docker run -p 6379:6379 redis:7.4-alpine`).
Com `MAKECRM_DRY_RUN=true` nada é enviado ao MakeCRM.

## Chave da API

```bash
npm run api-client -- "MAVI Tasks"
```

Mostra a chave uma vez; o banco guarda só o hash. Use `Authorization: Bearer <chave>`.

## Produção (VPS com Portainer)

1. `./scripts/release.sh v1` — gera a imagem linux/amd64 e envia ao Docker Hub
   (`allysonassuncao/mavi-agentes`, repositório **privado**).
2. Portainer › Stacks: use [deploy/portainer-stack.yml](deploy/portainer-stack.yml)
   e preencha as variáveis de ambiente.
3. DNS: `agentes.maso.app.br` apontando para a VPS (o Traefik emite o certificado).
4. `npm run migrate` (do seu computador) quando houver migração nova.

Sem Portainer: `docker compose up -d --build` com o `.env` ao lado.

`api` (HTTP, atrás do Traefik em `agentes.maso.app.br`), `worker` (2 réplicas) e
`redis`. Segredos no `.env` do servidor, nunca no git.

## Estrutura

| Pasta | O quê |
|---|---|
| `src/spec` | Especificação do agente (`mavi-agent/v1`) — o contrato com os construtores |
| `src/api` | API: entrada do MakeCRM (`/v1/inbound/makecrm/<token>`) e administração |
| `src/runtime` | Uma resposta: espera, mídia, contexto, LLM com ferramentas, envio, rastro |
| `src/knowledge` | Base de conhecimento: leitura de arquivos, trechos, vetores, busca híbrida |
| `src/makecrm` | Integração com o MakeCRM (sendMessage, passar para humano, webhook da caixa) |
| `supabase/migrations` | Esquema do banco do motor |
