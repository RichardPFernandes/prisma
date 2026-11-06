# Plano: Dashboard — telas de roteamento de modelo

> **Fonte:** [SPEC.md](SPEC.md), aprovada pelo Richard em 2026-11-06.
> **Issue:** confirmada e não criada (limite do plano gratuito do Linear). O texto
> está em `prisma-evidence/2026-11-06-pri-205-routing-ui/issue-draft.md`.
> **Status:** PROPOSTA, aguardando aprovação do plano. Nada foi codado.
>
> Este plano fica em `tasks/routing-ui/` porque `tasks/plan.md` e `tasks/todo.md`
> ainda têm itens abertos da PRI-233. Não mexi neles.
> **Base:** `main` em `4d39a3c` (PR #99 mergeado). Antes de começar, atualizar a
> base com `sync_with_base_branch`.

## Visão geral

São duas entregas, cada uma num PR (proposta da Q9):

- **Entrega 1 — Roteamento hoje + override.** Usa só dado que já existe. Não depende de nenhuma das perguntas em aberto.
- **Entrega 2 — Custo × qualidade.** Começa depois das respostas a Q1, Q2, Q4, Q5 e Q7. Enquanto elas não chegam, os valores recomendados da SPEC entram como **parâmetros nomeados**, cada um num único lugar, para trocar sem refazer o trabalho.

## Decisões de arquitetura

- **Módulo de projeção puro, `dashboard/routing-projection.js`.** Recebe dados já lidos (config, states, snapshots, attempts) e devolve o read model. Não acessa disco e não usa relógio implícito, para poder ser testado com fixtures. O `server.js` só faz a leitura e chama o módulo, no mesmo padrão de `would-route-metrics.js`.
- **Leitura pelos donos que já existem:**
  - configuração: `model-routing-policy.readRoutingConfig`;
  - snapshot: `routing-run.loadRunSnapshot`;
  - Attempts `NOT_STARTED`: `dom06-attempt.listAttempts` e `readAttempt`.
  
  Nenhuma lógica paralela, nenhuma escrita, nenhum rebind.
- **Redação em duas camadas:**
  1. A projeção monta cada objeto com uma **lista de campos permitidos**, em vez de copiar e apagar. Assim `path`, `settings_path` e `attempt_ref` nunca entram.
  2. O `redactDeep` roda por cima.
  
  Um teste varre a saída à procura de padrões de caminho.
- **Override:** a UI reusa o fluxo de credencial de `public/authorization.js` (aprovador e senha, `StateVersion.casBody`) e o endpoint existente. O servidor não muda. Se faltar algo no contrato do endpoint, isso volta para a spec antes de mexer.
- **UI:** um arquivo novo `public/routing.js` com a view `roteamento` em Operação. A aba "Sombra × real" absorve a `would-route-metrics.js` atual (Q3a): ela é **reusada como componente**, não reescrita. O bloco no detalhe da Run fica em `public/routing-run.js`.
- **Não toca** `dashboard/cost-projection.js` nem `dashboard/public/cost-attempts.js`. Se a sessão `routing-decision-ui` mudar o formato do `cost_tracking` projetado, a projeção nova lê o **bruto** (como o `/api/would-route-metrics` já faz) e não depende daquele trabalho.

## Grafo de dependências

```
T1 projeção: config + policy ──┐
T2 projeção: runs + snapshot ──┼─> T4 GET /api/routing ─> T5 view "Hoje" ─> T6 aba "Sombra × real"
T3 projeção: recusas + mix ────┘                    └──> T7 bloco da Run + override
                                                                    │
     (API do classificador, sessão do Jev) ──> T7b seletor "Só policy" / "Policy + Jev" (usa o padrão da T7)
                                                                    │
                     (Q1, Q2, Q4, Q5, Q7) ─> T8 projeção qualidade ─> T9 GET /api/routing/quality ─> T10 aba "Custo × qualidade"
```

## Tarefas

As tarefas detalhadas estão em [todo.md](todo.md):

- **Fase 1, fundação (Entrega 1):** T1, T2, T3. Checkpoint A.
- **Fase 2, API e telas (Entrega 1):** T4, T5, T6, T7 e T7b. Checkpoint B (PR 1: revisão, testes, verificação no navegador).
  - **T7b** é o seletor do classificador, requisito novo do Richard de 2026-11-06 (SPEC §3.5). O contrato da API chegou em 2026-11-06; o endpoint ainda não existe. A UI pode ser feita contra o contrato, e a integração fica para quando o endpoint existir.
  - Se a API não chegar antes do Checkpoint B, a T7b vai para o PR 2 e o PR 1 sai sem ela. Essa decisão fica para o Checkpoint B.
- **Fase 3, custo × qualidade (Entrega 2):** T8, T9, T10. Checkpoint C (PR 2).

## Riscos e mitigação

| Risco | Impacto | Mitigação |
| -- | -- | -- |
| Ler snapshot ou DOM-06 a cada refresh fica lento com muitas Runs | Médio | Ler só Runs com `routing_snapshot` e cachear por `(task, state_version)`; `listAttempts` só para Run `blocked` com evento `routing NOT_STARTED` |
| Vazar caminho local (policy, `--settings`, `attempt_ref`) | Alto | Lista de campos permitidos + `redactDeep` + teste de varredura em toda resposta nova |
| A sessão `routing-decision-ui` muda o formato do `cost_tracking` | Médio | Ler o `cost_tracking` bruto; sem dependência dos arquivos dela; rebase antes do PR |
| Proxy de "aprovada" (Q1) induz leitura errada da qualidade | Alto | Proxy nomeado na própria tela, valor da Q1 num único parâmetro, sem ★ "melhor" com amostra pequena |
| Não há Runs com `mode = ON` no consumidor para verificar no navegador | Médio | Fixtures sintéticas num `memory/` temporário (receita de teste); nunca dado do consumidor no repo |
| A matriz e a dispersão quebram no celular | Baixo | Lista de cartões abaixo de 640 px e tabela alternativa à dispersão; verificação em 375 px |

## Decisão G3: **opção A escolhida pelo Richard em 2026-11-06** ("A: CLI via execFile")

A implementação está em `scripts/routing-read.js` (`--json`, stdin → stdout). O `server.js` chama a CLI com `execFile`, num processo por requisição e só com o que falta no cache. O `server.js` não importa nada novo de `scripts/lib`.

**O problema:**
- O `/api/routing` precisa de três leitores do watcher: `readRoutingConfig`, `loadRunSnapshot` e `dom06.listAttempts`.
- A regra `no-dashboard-scripts-internals` (G3) proíbe o dashboard de importar `scripts/lib`. O caminho público previsto é `scripts/src/application`/`composition`, que só existe depois da F12 e hoje está vazio.
- A baseline de violações conhecidas só pode diminuir.

| Opção | O que é | Custo / risco |
| -- | -- | -- |
| **A. CLI de leitura (recomendada)** | Um script `scripts/routing-read.js --json` que usa os leitores do dono e devolve o read model já projetado. O dashboard chama com `execFile`, como já faz com `replay-cycle.js` e `readmine-watcher.js --health-check`. A projeção (`routing-projection.js`) passa para o script, ou o script devolve dado bruto e o dashboard projeta. | Não cria lógica paralela e segue o precedente. Custa um processo por requisição (~50–100 ms), que se reduz com cache por mtime no servidor. Não vale como fachada F12, mas também não piora a baseline. |
| B. Fachada em `scripts/src` | Primeiro módulo `application` + `adapter` + `composition` (TS compilado) para leitura de roteamento. | É o alvo arquitetural, mas é trabalho de F12. Mexe em build, `ownership.yaml` e convenções. Fica fora desta fatia. |
| C. Exceção na baseline | Aceitar 3 arestas novas como dívida até a F12. | Rebaixa um gate que hoje é *shrink-only*. Só com decisão governada explícita, e exige mudar o teste. |
| D. Ler os arquivos direto no dashboard | Reimplementar a leitura e a verificação de hash. | Cria lógica paralela ao dono (AGENTS.md, regra 4) e diverge do watcher. Não recomendada. |

## Perguntas ainda abertas (da SPEC)

Valor provisório de cada uma; nenhuma bloqueia a Entrega 1.

- **Q1:** aprovada = chegou ao Commit com PR e sem recusa de QA depois.
- **Q2:** amostra pequena = `n` < 10.
- **Q3:** absorver a "Medição de modelo".
- **Q4:** Wilson para aprovação; bootstrap com semente fixa para custo.
- **Q5:** janela por `policy_ref`, com seletor 7, 30 dias ou tudo.
- **Q6:** sem escopo `subtask` no formulário.
- **Q7:** custo da Run inteira, com o do Implement ao lado.
- **Q8:** SPEC na raiz.
- **Q9:** duas entregas.
- **Q10 (nova, da T3):** a mistura por **modelo observado com custo** precisa do custo por modelo, que hoje só o `cost-projection.js` calcula. Valor provisório: misturar pelo modelo pedido e listar os observados sem custo. Depois do merge do `pri-233-followup`, usar a projeção dele ou manter assim?

## Processo

Plan → Implement (TDD por tarefa) → Review independente (só Claude) → Test (`prisma-tests`) → Verify → Commit. Merge exclusivo do Richard.
