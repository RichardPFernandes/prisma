# Spec: Dashboard — telas de roteamento de modelo (roteamento hoje, override, custo × qualidade)

> **Status:** APROVADA pelo Richard em 2026-11-06. As perguntas Q1–Q9 continuam
> abertas e vão para o plano. Nada foi planejado nem codado. A aprovação desta spec não é Ready da issue, não adota policy, não aplica
> RC-1 a RC-6 (NOT APPLIED) nem RRC-F31-001/002 (NOT APPLIED) e não altera o desenho
> v9. `roadmap-ref: UNKNOWN`.
>
> **Issue:** confirmada pelo Richard em 2026-11-06, mas **não criada**. O Linear
> recusou por limite de issues do plano gratuito (requestId `a565acae8c8fb553`).
> O texto está em `prisma-evidence/2026-11-06-pri-205-routing-ui/issue-draft.md`.
> A segunda tentativa, em 2026-11-06, também foi recusada (requestId `a565c3b608f9b0ff`).
> Por decisão do Richard, o texto ficou registrado como comentário na PRI-205
> (`facad109-13bb-43c6-99d3-4f2d82a9e685`). A issue própria segue **pendente**.
>
> **Fontes:** desenho v9 §4.6, §4.7, §4.8, §5.3, §5.7 e S7a–S7d
> (`prisma-evidence/pri-205/desenho-selecao-modelo.md`); policy aprovada
> `routing-pri205@p1-2026-11-06` (sha `02923a43…`,
> `prisma-evidence/2026-11-06-pri-233/policy-aprovada/`); código na `main` em
> `4d39a3c` (PRI-233, PRs #97 e #99 mergeados); canvas do Espectro, artboards
> `ModelRouting`, `ModelLab` e `TierEscalation` (versão `1793969742-cc62`, só
> referência visual). O `ModelLab` cita o Codex como experimental. Isso está
> desatualizado e não entra.

## 1. Objetivo

O Richard quer ver **custo × qualidade** do roteamento de modelo, e não só a
economia. Hoje o Dashboard mostra a sombra S3 com uma "economia potencial" estimada
por razão de preço e mostra, no detalhe da Run, o custo por Attempt. Não mostra:

- a policy vigente;
- quais Runs estão roteadas, com qual snapshot;
- o modelo que de fato rodou em cada nó;
- a qualidade do resultado ao lado do custo.

Esta fatia entrega três telas, todas como **projeção** (§5.7: o Dashboard lê o que o
watcher grava; nunca calcula classe, resolve modelo ou decide escalonamento):

1. **Roteamento hoje**: configuração e policy do consumidor, Runs com snapshot,
   admissões recusadas, Attempts `NOT_STARTED`, mistura de modelos e sombra × real.
2. **Override humano**: formulário para o writer que já existe
   (`POST /api/runs/:taskId/routing-override`).
3. **Custo × qualidade** (no estilo do `ModelLab`): custo real por tarefa aprovada,
   por classe × modelo, com `n`, intervalo e marca de amostra pequena. Cada métrica
   vem marcada com o que existe hoje e o que depende de S5, S6 ou do Jev em sombra.

**Usuário:** o Richard (operador local, um consumidor por instância do Dashboard).
**Sucesso:** ele responde, só pela tela, a três perguntas. Esta Run roteou para onde e
por quê? Quanto custou cada tarefa aprovada em Sonnet × Opus, e com que qualidade?
Quanto disso ainda é amostra pequena ou não medido?

## 2. AS-IS (o que já existe e será reaproveitado)

| Peça | Onde | Estado |
| -- | -- | -- |
| Config do consumidor `.claude/model-routing.json` (`mode`, `policy_ref {id, version, sha256, path}`) | `scripts/lib/model-routing-policy.js` `readRoutingConfig` (nunca lança; OFF/ON/INVALID) | não projetado no Dashboard |
| Snapshot `routing` da Run (imutável, no Attempt de admissão do DOM-06) + ligação `state.routing_snapshot = {attempt_id, sha256}` | `scripts/lib/routing-run.js` `loadRunSnapshot` | não projetado (vai cru dentro de `state`) |
| RoutingDecision por Attempt (`policy_ref`, classe, regra, candidatos, escolhido, `selection_source`, `override_ref`, `effort_applied`, `plugin_proof`) | `cost_tracking.nodes.*.attempts[].routing_decision`, e o Attempt DOM-06 | o detalhe da Run imprime o campo cru (a sessão `routing-decision-ui` está corrigindo isso em `cost-attempts.js`) |
| `requested {model, effort}` e `observed.usage[].model` por Attempt | `cost_tracking` (`scripts/lib/cost-tracking.js` `attemptRecord`) | parcial no detalhe da Run |
| Sombra S3 `would_route` por Attempt | `cost_tracking…attempts[].would_route` | aba **Operação › Medição de modelo** (`/api/would-route-metrics`): contagem por faixa e "economia potencial" por **razão de preço**, que é hipótese e não custo real |
| Admissão recusada | `memory/runs/routing-admission-blocked.json` → pré-task `routingBlocked` | badge na lista de Runs |
| Attempt `NOT_STARTED` de nó roteado | Attempt DOM-06 (`admission.status = NOT_STARTED`, `cause`, `detail`, `routing`) + evento `checkpoint` + `status = blocked` | aparece só como Run bloqueada |
| Overrides | `state.routing_overrides[]` → `routingOverrides` no resumo | projetado, sem tela nem formulário |
| Writer de override | `authorization.recordRoutingOverride` (aprovador, CAS, `operation_id`; recusa `OVERRIDE_INVALID`, `ROUTING_OFF`, `ROUTING_UNVERIFIABLE`, `OVERRIDE_INELIGIBLE`, conflito de versão, nó rodando) | só a API |

## 3. Escopo

### 3.1 Roteamento hoje (dados que já existem)

**A. Configuração e policy do consumidor**

- Mostra `mode` (`OFF` ausente, `OFF` declarado, `ON`, `INVALID` com `cause`/`detail`).
- Mostra `policy_ref`: id, versão e sha curto. Também mostra `status` e `approval.by/at`, se estiverem na policy.
- Tabela classe → tier → modelo(s) → esforço declarado, com o `default_route`.
- Aviso fixo: "esforço declarado, não aplicado (SP-1): só `--model`" quando `effort_applied = false`.
- Leitura pelo mesmo `readRoutingConfig` do watcher, sem lógica paralela. **Nunca** projeta `policy_ref.path` nem caminho absoluto.

**B. Runs roteadas**

Por Run:

- `mode` da Run, derivado só de `state.routing_snapshot`: presente = ON; ausente = OFF; ilegível = UNKNOWN.
- Sha curto do snapshot e `policy_ref` do snapshot.
- Integridade (`ok` ou o `detail` do `snapshotIntegrity`).
- Se a policy do snapshot é diferente da vigente, aparece "esta Run usa @X; vigente @Y", sem rebind e sem botão de religar.
- Contagem de Attempts por `selection_source` (`RULES`, `PLAN_RAISED`, `CONSERVATIVE_DEFAULT`, `FIXED_NODE`, `HUMAN_OVERRIDE`, `DEFAULT_INHERITED`; valor desconhecido é exibido como veio, sem mapear).
- Overrides gravados.

**C. Recusas**

- Admissões recusadas: os tickets do marcador, com `cause`, `detail`, `transient`, `first_blocked_at` e o estado do aviso: enviado, falhou, incerto.
- Attempts `NOT_STARTED`: nó, `cause` (`CONFIG_UNVERIFIABLE`, `PROVIDER_NOT_ELIGIBLE`), `detail` e quando.

**D. Mistura de modelos**

- Por Run e por nó: o modelo pedido (`requested.model`) × os modelos observados (`observed.usage[].model`), com o custo do Attempt.
- Pedido ≠ observado aparece destacado, e o painel não escolhe um dos dois.
- No agregado da janela: o percentual de Attempts e de custo por modelo, com o rodapé "custo somado dos Attempts; classificador fora da conta" (como no canvas).

**E. Sombra × real**

- Por Attempt do Implement: a classe e o tier de `would_route` (S3) × a classe e o tier da RoutingDecision real.
- Resultado: igual, diferente para cima ou diferente para baixo.
- **Não** mostra "diferente, pior" nem "mesmo resultado": é contrafactual, sem medição (o canvas tem essa legenda; aqui ela vira "não medido").
- A "economia potencial" atual por razão de preço continua rotulada como hipótese (ver Q4).

### 3.2 Override humano

- Formulário no detalhe da Run (e atalho na lista da tela Roteamento) que chama o
  endpoint existente. Campos:
  - **escopo**: `ticket` ou `node`. `subtask` só aparece com a S5 (ver Q6);
  - **nó**: quando o escopo é `node`;
  - **modelo**: lista do `eligible_set.models` **do snapshot da Run**, não da policy vigente;
  - **esforço**: chaves do `effort_map` do snapshot, com a nota "registrado; não vai ao despacho enquanto `effort_applied = false`".
- O `operation_id` é gerado no cliente e **reusado** ao repetir depois de erro de rede ou resposta incerta. `expected_state_version` vem da projeção.
- **Sem aprovador nem senha** (decisão do Richard em 2026-11-06, até existirem roles; ver §3.6). A autoria é o usuário do sistema operacional que roda o Dashboard.
- A tela **só projeta** a recusa: mostra `code` e `error` do 409 (`OVERRIDE_INELIGIBLE`, `ROUTING_OFF`, `ROUTING_UNVERIFIABLE`, `OVERRIDE_INVALID`, conflito de versão, nó rodando). Ela não valida elegibilidade por conta própria, a não ser limitar as opções ao snapshot.
- Run OFF ou snapshot ilegível: o formulário aparece desabilitado com o motivo. O endpoint continua sendo a guarda.
- Depois de gravar: "vale a partir do próximo limite de nó (D-4)" e a lista `routing_overrides[]` (ref, escopo, valor, quem, quando). A override está *pendente* até o próximo Attempt e *aplicada* quando um `override_ref` aparece numa RoutingDecision.

### 3.3 Custo × qualidade (estilo `ModelLab`)

Unidade: **tarefa = Run**. Na S4 só o Implement roteia, então a célula é
**classe do Implement × modelo pedido no Implement**. A classe é a da RoutingDecision
(máxima dos grupos do plano). Os demais nós vão no `default_route` e entram no custo
da Run, não na célula.

| Métrica | Definição | Hoje? |
| -- | -- | -- |
| Custo real por tarefa aprovada | Σ `cost.usd` de **todos** os Attempts de todas as Runs da célula (todos os nós, retries, NOT_STARTED = 0 custo observado) ÷ nº de Runs **aprovadas** da célula. Run com algum Attempt sem preço → custo da célula marcado "incompleto" com a contagem, nunca somado como 0 | **HOJE**, mas depende da definição de "aprovada" (Q1) |
| Taxa de aprovação + IC 95% | aprovadas ÷ Runs **encerradas** da célula; intervalo de Wilson | **HOJE** com proxy (Q1) |
| Custo por tentativa | Σ custo ÷ nº de Attempts do Implement | HOJE |
| Retrabalho | voltas Review → Implement por Run (`retries`/`loop_count`) | HOJE |
| Recusa QA | Runs com `qa_retry_count > 0` | HOJE |
| `n` iniciado / aceito / não aceito / em andamento / missing | por célula, sempre visível | HOJE |
| Amostra pequena | célula com `n` encerrado < limiar (Q2): marca ○, sem ★ "melhor" | HOJE |
| Completude | % de Attempts com modelo e custo completos (indicador, H05) | HOJE |
| Por **subtarefa** (classe real de cada grupo, escalonamento, aprovação no 1º Attempt, `scope_violation`) | §5.3 | **S5**: aparece como "não medido (S5)" |
| CPA por braço e versão de policy, regra de decisão §5.5, rubrica PRI-80 | §5.3–5.5 | **S6**: "não medido (S6)" |
| Acerto do núcleo 2 (Jev) em sombra, por classificador | §4.8, S7c | **Jev sombra** (spec em `spec/pri-205-jev-sombra`): "não medido" |
| Latência p95 | duração do Attempt existe, mas p95 com `n` pequeno não é informativo | HOJE como mediana com `n`; p95 só com `n` ≥ limiar |
| Escalonamento de tier | §4.6 / D7 | **fora** (S5) |

Visual:

- matriz classe × modelo com a métrica escolhida;
- dispersão com custo real (log) × aprovação e IC;
- painel do par selecionado com `n`, intervalo e notas;
- "piso de qualidade" ajustável só no cliente, como filtro visual: não grava nada e não é a regra §5.5.

O texto "O mais barato por tentativa raramente é o mais barato por tarefa aprovada"
fica. O botão "pedir mudança ao Roteamento" do canvas **não** entra (não há writer de
policy; ver Fora de escopo).

### 3.5 Seletor do classificador na tela (requisito novo, 2026-11-06)

**Origem:** o Richard pediu, via sessão coordenadora: "deve ter como selecionar as duas opções tanto usar o jev quanto só usar a policy". Isso traz para esta fatia **só o controle na UI** do seletor do classificador (D23 / S7d). O resto fica com a sessão do Jev (`local_98c26694…`), que define e entrega:
- o contrato da seção `classifier`;
- o writer governado, com as validações 0–5 do §4.8 na ordem e os códigos de recusa;
- o endpoint.

**O controle (aba Hoje, cartão "Configuração do projeto"):**

- **Escopo:** por projeto consumidor, ou seja, o consumidor desta instância do Dashboard.
- **Opções:**
  - **"Só policy"** (`provider = off`): só o núcleo 1, a policy.
  - **"Policy + Jev"** (`provider = jev`, `mode = shadow`): o Jev opina em sombra, sem efeito no despacho.
  - **"Policy + Jev (ativo)"** aparece **desabilitado com o motivo** enquanto não houver `calibration_ref` PASS. Por exemplo: "sem calibração aprovada (D20)". A tela não decide; o motivo vem do estado que a API projeta.
- **Estado atual:** provider, modo, versão da seção `classifier`, quem trocou, quando e o motivo, se a API trouxer.
- **Aviso fixo:** "Vale só para Runs novas. Runs já admitidas mantêm o classificador do próprio snapshot."
- **Padrão do formulário de override (T7):**
  - sem aprovador nem senha (§3.6);
  - `expected_version` (CAS) e chave de idempotência gerada uma vez e reusada ao repetir;
  - confirmação antes de gravar.
- **A tela só projeta a recusa do writer** (`code` + `error`) e não é a guarda. Códigos previstos no §4.8:
  - `CLASSIFIER_IDEMPOTENCY_MISMATCH`, `CLASSIFIER_VERSION_CONFLICT`, `CLASSIFIER_SCOPE_NOT_AUTHORIZED`;
  - `CLASSIFIER_NOT_CALIBRATED`, `CLASSIFIER_CALIBRATION_MISMATCH`, `CLASSIFIER_LOCKED_BY_EXPERIMENT`.
- Na tela, nada fica fixado no código além do que a API declarar. Se o formato vier diferente, vale o da API.
- **Contrato recebido em 2026-11-06** da sessão do Jev (SPEC dela, §B11). O endpoint ainda não existe; a sessão do Jev avisa quando existir. Cópia em `prisma-evidence/2026-11-06-pri-205-routing-ui/contrato-seletor-classificador.md`. Pontos principais:
  - **Leitura:** `GET /api/routing/classifier` traz `current` (`version`, `choice`, `mode`, `source`, `by`, `at`, `reason`), `options` (com `allowed`, `refusal` e `detail` por opção e modo) e `history` (até 20 versões).
  - **Gravação:** `POST /api/routing/classifier` recebe `choice`, `mode`, `expected_version`, `operation_id`, `reason` (sem credenciais desde 2026-11-06; §3.6).
    - Respostas: 200 `applied` ou `already_processed`; 400, 409 e 422 com `code` (os 401, 403 e 429 do aprovador saem com a §3.6).
  - **Onde a escolha fica:** num registro próprio do consumidor, `memory/routing/classifier-selection.json`, append-only e fora da policy. O hash da p1 não muda.
  - **Hoje:** "Policy + Jev" vem com `allowed: false` e `CLASSIFIER_SCOPE_NOT_AUTHORIZED`, porque ainda não há Authority Ref. `active` fica sempre bloqueado.
  - **Na tela:** "enviado" até a resposta, nunca "aplicado" antes do 200. O mesmo `operation_id` é reaproveitado no reenvio.
- **Como a T7b usa isso:** a tela lê e grava direto nesses endpoints. O `/api/routing` não muda. O motivo de cada opção desabilitada vem de `options[].refusal` e `detail`; a tela não infere nada.
- **Bloqueio que resta:** só a existência do endpoint, para o teste de integração. A UI pode ser feita contra o contrato com um servidor de fixtures.

### 3.6 Sem aprovador nem senha (decisão do Richard, 2026-11-06)

"essas coisas de aprovador e senha pode remover de tudo, se eu tenho acesso ja posso executar, essa coisa de aprovador só vai ter de verdade quando implementar as roles"; depois, sobre as ações que já existiam, "na vdd os outros pode sim".

- **Vale para todo o Dashboard:** override de roteamento, seletor do classificador, autorização de SQL (aprovar, recusar e já apliquei) e devolução ao QA.
- **Servidor:** o `requireApprover` virou `actorOf()`, e a autoria (`by`) é o usuário do sistema operacional.
  - O acesso continua limitado ao filtro de localhost (Host e Origin).
  - `scripts/lib/approvers.js` fica para as roles.
- **Telas:** sem campos de aprovador e senha.
- **Risco aceito, registrado no runbook:** sem a senha, um processo do mesmo usuário (inclusive um agente) pode decidir pela API local.
  - A execução de SQL ainda exige a confirmação física do Keychain.
  - As demais ações não têm barreira física.

### 3.4 Fora de escopo (só registrado)

- **Escalonamento de tier** (`TierEscalation`, §4.6, D7): depende da S5.
- **Seletor do classificador: writer, contrato e endpoint** (S7d, D23, validações 0–5 do §4.8). Ficam com a sessão do Jev. O controle na UI entrou nesta fatia; ver §3.5.
- **Proposta ou edição de policy** pelo Dashboard (histórico `@7 → @8`, fila de aprovações e "voltar em um clique" do canvas). Adoção de policy exige aprovação humana fora da tela.
- Nós além do Implement com regra própria (o canvas mostra review/test/spec com regras de sombra que não existem no Prisma).
- Budget, Providers e RunDetail do canvas, além do que já está acima.
- `dashboard/cost-projection.js` e `dashboard/public/cost-attempts.js`: a sessão `routing-decision-ui` está trabalhando neles. Esta fatia não os edita e consome a projeção que eles expõem depois do merge.

## 4. Contrato de leitura (proposta)

Endpoints novos, só leitura, GET, com projeção pura e testável num módulo novo
(`dashboard/routing-projection.js`):

- `GET /api/routing`: `config` (`mode`, `policy_ref` sem `path`, `status`, tabela da
  policy, `default_route`, `effort_applied`), `admission_blocked`, `runs[]` (task,
  ticket, `mode`, `snapshot {sha_short, policy_ref, integrity}`, `policy_drift`,
  `selection_sources`, `overrides[]`, `not_started[]`, `models {requested, observed,
  cost_usd}` por nó), `mix` (agregado da janela) e `shadow_vs_real`.
- `GET /api/routing/quality?window=30d`: células classe × modelo com as métricas do
  §3.3, cada uma com `status: MEASURED | SMALL_SAMPLE | NOT_MEASURED(dep) | UNKNOWN`.

Regras da projeção:

- **UNKNOWN nunca vira 0**. Ausência de custo é `null` com motivo. Contagem desconhecida é `"UNKNOWN"`.
- **Sem caminhos e sem segredos.** Ficam de fora `policy_ref.path`, `plugin_proof.settings_path`, `attempt_ref.path`, `dir`, `root` e o conteúdo de `--settings`. Tudo passa por `redactDeep`. Teste dedicado procura `/Users/`, `/home/`, `\\` e `.claude/` em toda a saída.
- O snapshot é lido **só** pelo `routing-run.loadRunSnapshot` (o mesmo do watcher) e só leitura. A configuração vigente é lida pelo `readRoutingConfig`. Nunca se lê a config corrente para interpretar uma Run antiga.
- Runs arquivadas seguem as regras de visibilidade que já existem (`archivedAway`).
- Atualização ao vivo pelo mesmo WS/refresh das outras views. Sem polling novo.

## 5. UI

- Uma view na navegação **Operação**: "Roteamento de modelo", com abas: *Hoje*,
  *Sombra × real*, *Custo × qualidade*. Ela absorve a "Medição de modelo" atual (Q3).
- No detalhe da Run: um bloco "Roteamento" com o snapshot, os overrides, o formulário e os `NOT_STARTED`. Esse bloco fica fora de `cost-attempts.js`.
- Segue o tema do Espectro (`prisma-theme.css`, `theme.css`) e os padrões de controle do painel Versão (PRI-126): botão desabilitado com motivo, confirmação e recusa vinda do endpoint.
- **Celular (≤ 390 px):** sem rolagem horizontal da página. Matriz e tabelas viram lista de cartões ou região rolável com `role="region"` e rótulo, como em `cost-attempts`. A dispersão tem alternativa em tabela.
- Acessibilidade: legendas em texto (não só cor), glifos com `aria-label`, foco preservado nos refreshes (como `views.js` faz hoje).

## 6. Testes e verificação

- Receita oficial (skill `prisma-tests`: `harness/run-tests.js`, HOME/TMPDIR sintéticos, loopback).
- Unidade da projeção com fixtures sintéticas:
  - `mode` OFF, ON e INVALID;
  - snapshot íntegro, adulterado e ausente;
  - policy do snapshot diferente da vigente;
  - Attempts sem preço;
  - `NOT_STARTED`;
  - override pendente e override aplicado;
  - célula com `n` pequeno;
  - garantia de "nunca 0 no lugar de UNKNOWN";
  - varredura anti-caminho.
- API: `/api/routing` e `/api/routing/quality` (formato e redação). Override: 200, `already_processed` com o mesmo `operation_id`, e cada código de 409 chegando à UI.
- UI: teste no estilo `version-ui.test.js` (navegação, `aria`) e verificação manual no navegador do Dashboard local, em 1440 px e em 375 px.
- `check:js`, `lint:src`, `arch:check` limpos.
- Revisão independente só com Claude. Merge exclusivo do Richard.

## 7. Critérios de aceite

1. Com `mode` ausente, a tela diz "Roteamento desligado" e as Runs aparecem como OFF. Nenhuma métrica de roteamento aparece como 0.
2. Com `mode = ON` e policy aprovada, a tela mostra `routing-pri205@p1-2026-11-06`, sha curto e C1/C2 → Sonnet 5.5, C3–C5 e `default_route` → Opus 5.5, com o aviso de esforço não aplicado.
3. Uma Run roteada mostra a ligação e o snapshot. Se a policy vigente mudar, a Run continua mostrando a do snapshot, com o aviso de diferença.
4. Admissão recusada e `NOT_STARTED` aparecem com causa e detalhe, sem caminho local.
5. O formulário de override grava pelo endpoint existente. As recusas do writer aparecem com o código. Repetir com o mesmo `operation_id` não grava duas vezes.
6. Custo × qualidade mostra `n`, IC e "amostra pequena". As métricas de S5, S6 e Jev aparecem como "não medido (dependência)".
7. Nenhuma resposta da API contém caminho absoluto, `settings_path` ou segredo.
8. Na largura de celular, nada causa rolagem horizontal da página.
9. (§3.5) O cartão da configuração mostra o classificador atual e permite escolher "Só policy" ou "Policy + Jev" (sombra) pelo writer da sessão do Jev.
   - "Ativo" aparece desabilitado com o motivo enquanto não houver calibração.
   - O aviso "vale só para Runs novas" está sempre visível.
   - Cada recusa do writer aparece com o código.
   - Repetir com a mesma chave de idempotência não grava duas vezes.

## 8. Limites

- **Sempre:** projeção só leitura; reusar `readRoutingConfig`, `loadRunSnapshot` e o writer de override; UNKNOWN explícito; testes pela receita oficial.
- **Perguntar antes:** endpoint que escreve além do override; mudar `cost-projection.js` e `cost-attempts.js` depois do merge da outra sessão; mudar o formato de dado gravado pelo watcher.
- **Nunca:** calcular classe ou resolver modelo no Dashboard; religar snapshot; editar policy; inventar dado de demonstração; projetar caminho ou segredo; chamar Codex.

## 9. Perguntas em aberto (para o Richard)

- **Q1. O que é "tarefa aprovada" hoje?** Sem a rubrica PRI-80, a proposta é: Run que
  chegou ao Commit com PR **e** não teve recusa de QA depois (proxy). Alternativas:
  (a) só "chegou ao Commit"; (b) PR mergeado; (c) ticket fechado no Redmine. O
  denominador da qualidade muda com a escolha, e o rótulo da tela vai dizer qual
  proxy está em uso.
- **Q2. Limiar de "amostra pequena".** Proposta: `n` encerrado < 10 na célula, sem ★,
  e IC sempre visível. Outro número?
- **Q3. A "Medição de modelo" atual.** (a) absorver na nova view como aba "Sombra × real", com a "economia potencial" rotulada como hipótese (recomendado); (b) manter as duas views; (c) remover a economia potencial.
- **Q4. Intervalo do custo real.** Para a aprovação, Wilson 95%. Para o custo por aprovada, a proposta é bootstrap por Run (1 000 reamostragens, semente fixa) no servidor. Ou basta p25–p75 do custo por Run?
- **Q5. Janela padrão** do agregado: 30 dias (como no `ModelLab`) ou "desde a ativação da policy p1"? Proposta: desde a policy vigente, com seletor 7 / 30 / tudo, e células separadas por `policy_ref`. Versões não se misturam.
- **Q6. Escopo `subtask` no formulário.** O writer aceita, mas a S4 não roteia por subtarefa. Proposta: esconder até a S5.
- **Q7. Custo da Run inteira ou só do Implement na célula?** Proposta: a Run inteira (é o "custo real por tarefa aprovada"), com o custo do Implement ao lado.
- **Q8. Onde fica esta spec.** **Resolvida em 2026-11-06 no Checkpoint B:** movida para `tasks/routing-ui/SPEC.md`, para não apagar a spec da PRI-233 na raiz nem conflitar com a sessão do Jev, que também usa a raiz. `SPEC.md` na raiz substitui, nesta branch, a spec aprovada da PRI-233 (que continua no histórico do git). Prefere mover para `docs/specs/` ou manter a convenção da raiz?
- **Q9. Fatiamento.** Proposta: duas entregas. **(1)** Roteamento hoje + override; **(2)** custo × qualidade, depois de Q1/Q2/Q4. Ou uma só?

## 10. Rascunho da issue no Linear (não criada)

- **Time:** PRI. **Título:** "PRI-205: Dashboard — roteamento de modelo hoje, override
  e custo × qualidade".
- **Relações:** related to PRI-205 e PRI-233. Menciona as candidatas S7c (painel de
  calibração) e S7d (seletor do classificador) como trabalho futuro, não coberto.
- **Descrição:** §1, §3 (com a tabela "Hoje? / S5 / S6 / Jev"), §7 e §9 desta spec.
- **Observação:** a sessão do Jev registrou que o Linear recusou a criação de issue
  por limite do plano gratuito. Se recusar de novo, o texto fica em
  `prisma-evidence/2026-11-06-pri-205-routing-ui/issue-draft.md` e o handoff sai
  BLOCKED.
