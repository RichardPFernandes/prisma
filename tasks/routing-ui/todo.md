# Tarefas: Dashboard — telas de roteamento de modelo

> **Fontes:** [SPEC.md](SPEC.md) (aprovada em 2026-11-06) e [plan.md](plan.md)
> (proposta).
>
> **Como trabalhar:**
> - TDD: o teste nasce falhando.
> - Comando focado: `node --test dashboard/<arquivo>.test.js`.
> - Registre todo teste novo no `npm test` do `dashboard/package.json`.
> - A suíte completa roda pela skill `prisma-tests`.
> - Fixtures sintéticas apenas, sem dado do consumidor.
> - Não editar `dashboard/cost-projection.js` nem `dashboard/public/cost-attempts.js`.

## Fase 1: projeção (Entrega 1)

### T1: Projeção da configuração e da policy

**Descrição:** `routing-projection.projectConfig(readResult)` converte a saída do
`readRoutingConfig` em `config`. Cobre os casos:
- `mode`: OFF ausente, OFF declarado, ON ou INVALID com `cause`/`detail`;
- `policy_ref` com `id`, `version` e `sha_short`, **sem** `path`;
- `status` e `approval.by/at` da policy;
- tabela classe → tier → modelos → esforço;
- `default_route` e `effort_applied`.

**Aceite:**
- [x] OFF, ON e INVALID produzem a forma esperada. Campo ausente vira `"UNKNOWN"`, nunca 0 nem string vazia. Entrada ilegível vira `mode: UNKNOWN`, nunca OFF.
- [x] A policy aprovada p1 gera C1/C2 → `claude-sonnet-5-5` e C3–C5 + `default_route` → `claude-opus-5-5`, com `effort_applied: false`.
- [x] A saída não contém `path` nem nenhuma string com cara de caminho (`findPathLike`). Inclui um teste de contrato com o `readRoutingConfig` real num consumidor sintético.

> **T1 feita em 2026-11-06, sem commit.**
> - Teste focado: 13/13.
> - Suíte dashboard (receita oficial, Node 20.20.2 / npm 10.8.2, HEAD 4d39a3c com diff): 314/314.
> - `check:js` limpo; `lint:src` limpo (cobre só `scripts/src` e `dashboard/src`, então `dashboard/*.js` fica fora, como os vizinhos).
> - `arch:check` limpo só com Node 22.23.2: o dependency-cruiser não roda no Node 20.

**Verificação:** `node --test dashboard/routing-projection.test.js`
**Depende de:** nada. **Arquivos:** `dashboard/routing-projection.js`, `dashboard/routing-projection.test.js`. **Tamanho:** S

### T2: Projeção das Runs roteadas

**Descrição:** `projectRun({ state, snapshotResult, currentPolicyRef })`. Devolve:
- `mode` da Run: ON se há `routing_snapshot`, OFF se não há, UNKNOWN se ilegível;
- `snapshot`: `sha_short`, `policy_ref` e `integrity` (`ok` ou `detail`);
- `policy_drift`;
- contagem de `selection_source` a partir das RoutingDecisions do `cost_tracking` bruto. Valor desconhecido passa como veio;
- `overrides[]` com estado *pendente* (sem `override_ref` correspondente numa decisão) ou *aplicada*.

**Aceite:**
- [x] Os casos íntegro, adulterado, ausente e com `policy_drift` mostram a policy **do snapshot**, nunca a vigente.
  - Com ligação gravada e snapshot não lido: `mode: UNKNOWN`, nunca OFF.
  - Config vigente OFF ou INVALID: `DIFFERENT`, sem policy vigente.
- [x] Override aplicada e override ainda não aplicada (`NOT_APPLIED`: pendente ou superada) são distinguidas pelo `override_ref` das decisões.
- [x] Run OFF não ganha contagens nem métricas de roteamento (`null`). Run ON sem Attempt mostra contagem vazia explícita.

> **T2 feita em 2026-11-06, sem commit.**
> - Assinatura final: `projectRun({ taskId, ticketId, state, snapshotResult, current })`, em que `current` é a saída de `projectConfig`.
> - Teste focado: 25/25, com contrato com o `loadRunSnapshot` real sobre um DOM-06 sintético (íntegro e adulterado).
> - Suíte dashboard pela receita oficial (Node 20.20.2): 326/326. `check:js` e `lint:src` limpos.
> - `arch:check` limpo com Node 22.23.2.

**Verificação:** teste focado.
**Depende de:** T1. **Arquivos:** os mesmos de T1 e uma fixture em `dashboard/test-fixtures/routing/` (ou inline, seguindo o padrão do repo). **Tamanho:** M

### T3: Projeção das recusas, da mistura de modelos e da sombra × real

**Descrição:**
- `projectAdmissionBlocked(marker)`: `cause`, `detail`, `transient`, `first_blocked_at` e o estado do aviso (enviado, falhou, incerto ou não enviado).
- `projectNotStarted(attempts)`: nó, `cause`, `detail` e `at`.
- `projectModels(cost_tracking)`: por nó e Attempt, `requested.model` × `observed.usage[].model` e `cost.usd`, com `mismatch` marcado.
- `mix`: agregado da janela por modelo, em % de Attempts e % de custo. Attempt sem preço entra em `unpriced`, não soma 0.
- `shadowVsReal`: classe e tier de `would_route` × classe e tier da decisão. Resultado `same`, `up`, `down` ou `UNKNOWN`. `quality_effect` é sempre `"NOT_MEASURED"`.

**Aceite:**
- [x] Custo `null` nunca vira 0 no agregado. A completude aparece como `priced_attempts` / `unpriced_attempts`. Sem preço, `share_cost` é `null`.
- [x] Pedido ≠ observado gera `mismatch: true` e a projeção não escolhe um dos dois.
  - Não roteado: `null`, porque a comparação não se aplica.
  - Sem uso principal observado: `UNKNOWN`.
- [x] Sombra ausente gera `UNAVAILABLE`, sem inventar comparação. O efeito na qualidade é sempre `NOT_MEASURED`.

> **T3 feita em 2026-11-06, sem commit. Ajustes em relação à descrição:**
> - **Mistura por modelo pedido.** O `usage` bruto não traz custo por modelo; ele é calculado em `cost-projection.js`, que não pode ser tocado. Por isso a mistura agrega o custo do Attempt inteiro pelo **modelo pedido**, com `NOT_ROUTED` para não roteados. Os modelos observados aparecem por Attempt, sem ratear custo. Por modelo observado, ver Q10 em plan.md.
> - **Sombra × real por tier.** A sombra do Implement vira classe e tier máximos dos grupos, pela mesma regra do despacho (A1). A comparação é de tier e usa `SAME`, `REAL_HIGHER`, `REAL_LOWER` e `UNKNOWN`. A versão da policy de sombra aparece, porque ela é diferente da p1.
> - `projectNotStarted` também mostra a classe e o modelo que teriam sido usados, quando o Attempt tem RoutingDecision.
> - Nome final: `projectAttemptModels`.
> - Testes de contrato com `dom06.beginAttempt` e `listAttempts` reais.

**Verificação:** teste focado.
**Depende de:** T1. **Arquivos:** os mesmos de T1. **Tamanho:** M

### Checkpoint A

- [x] `node --test dashboard/routing-projection.test.js` verde (36/36).
- [x] `npm run check:js` e lint limpos. Suíte dashboard pela receita oficial (Node 20.20.2): 337/337. `arch:check` limpo com Node 22.23.2.
- [x] Teste de varredura anti-caminho sobre todas as saídas de T1–T3, com um caminho plantado em todos os campos de entrada.

> **Checkpoint A em 2026-11-06.** Evidência em `prisma-evidence/2026-11-06-pri-205-routing-ui/t3/`.

## Fase 2: API e telas (Entrega 1)

### T4: `GET /api/routing`

**Descrição:** em `server.js`:
- lê a config com `readRoutingConfig(repoRoot)`;
- percorre as Runs pelo mesmo caminho do `/api/would-route-metrics` (`collectCandidates`, `archivedAway`, `pickCandidate`);
- lê o snapshot só das Runs com `routing_snapshot`, via `loadRunSnapshot`;
- chama `listAttempts` só das Runs `blocked` com evento `routing NOT_STARTED`;
- lê o marcador de admissão;
- chama a projeção e aplica `redactDeep`.

Cache por `(taskId, state_version)`.

**Aceite:**
- [x] 200 com `{config, admission_blocked, runs, mix, shadow_vs_real}` nos cenários OFF, ON e INVALID, e com snapshot adulterado. Também vêm `generated_at` e `runs_total`.
- [x] Erro de leitura de uma Run não derruba a resposta: a Run sai como `mode: UNKNOWN`, com `error: STATE_UNREADABLE` ou `PROJECTION_FAILED`. Erro geral devolve 500 com mensagem redigida.
- [x] A varredura anti-caminho passa na resposta HTTP. A raiz do consumidor, o `settings_path` e o `policy.json` não aparecem.

- [x] Fronteira G3 respeitada. O Richard escolheu a opção A em 2026-11-06.
  - O `server.js` não importa nada novo de `scripts/lib`. Ele chama `scripts/routing-read.js --json` por `execFile`, como já faz com `replay-cycle.js`.
  - Com o leitor fora do ar, a resposta traz `reader: FAILED`, a config fica `UNKNOWN`, a Run roteada fica `UNKNOWN` e `not_started` vira `'UNKNOWN'`. Nada vira OFF.

> **T4 feita em 2026-11-06, sem commit.** Primeiro bloqueou no `arch:check` (3 imports de `scripts/lib`, baseline *shrink-only*). Foi refeita pela opção A.
>
> **Testes:**
> - `scripts/routing-read.test.js`: 5/5.
> - `dashboard/routing-api.test.js`: 8/8.
>
> **Receita oficial, Node 20.20.2:**
> - dashboard: 345/345.
> - scripts: 1334/1343. As 3 falhas são subtestes de `architecture-boundaries`, porque o dependency-cruiser não roda no Node 20. É ambiente e acontece igual na `main`.
>
> **Receita oficial, Node 22.23.2:**
> - dashboard: 345/345.
> - scripts: 1336/1343, com `architecture-boundaries` verde. A única falha foi `redmine-fetch.test.js` (throttle, "gap 3: 479ms"). É intermitente por tempo: isolado, passou 3/3 no Node 22, e o diff não toca `scripts/lib`.
>
> **Checks:**
> - `check:js` (dashboard e scripts) e `lint:src`: limpos.
> - `arch:check` (Node 22): **sem violações novas** (163 módulos, 77 conhecidas, igual à baseline).
>
> **Ajustes em relação à descrição:**
> - **`scripts/routing-read.js`.** Lê pelos donos: `readRoutingConfig`, `loadRunSnapshot` e `listAttempts`. Dos Attempts `NOT_STARTED`, devolve só os campos que a tela usa (sem snapshot, obrigações nem `plugin_proof`). Saída 2 para uso incorreto: stdin inválido, caminho relativo ou chave duplicada.
> - **Cache em vez de `(taskId, state_version)`.** O `state_version` só sobe com campo crítico, e o `cost_tracking` muda sem ele. O `state.json` é relido a cada requisição, como no `/api/would-route-metrics`.
>   - O **snapshot íntegro** fica em cache pela ligação (pasta `_dom06`, `attempt_id` e sha), porque é imutável. Falha não entra no cache.
>   - O **NOT_STARTED** fica em cache pelo mtime da pasta de Attempts do DOM-06 da Run. Há teste de invalidação.
> - **DOM-06 em toda Run roteada,** não só nas `blocked`. A leitura é barata com o cache e não depende de evento.
> - **`?limit`** é inteiro de 1 a 500 (padrão 100) e só corta a lista de Runs. A mistura e a sombra usam todas as Runs. Valor inválido devolve 400.
> - Pré-tasks sintéticas (tickets barrados) não entram em `runs`; elas aparecem em `admission_blocked`.

**Verificação:** `node --test dashboard/routing-api.test.js` e `node --test scripts/routing-read.test.js`, os dois registrados no `npm test` de cada pacote.
**Depende de:** T1–T3. **Arquivos:** `dashboard/server.js`, `dashboard/routing-api.test.js`, `dashboard/package.json`, `scripts/routing-read.js`, `scripts/routing-read.test.js`, `scripts/package.json`. **Tamanho:** M

### T5: View "Roteamento de modelo", aba "Hoje"

**Descrição:**
- item `roteamento` no grupo Operação de `views.js`, em `public/routing.js` com CSS em `public/screens/routing.css`;
- aba Hoje com o cartão da config e policy, o aviso de esforço não aplicado e a lista de Runs com filtros: ON, OFF, com recusa, com override;
- admissões recusadas e `NOT_STARTED`;
- mistura de modelos;
- atualização pelo refresh ao vivo existente.

**Aceite:**
- [x] OFF mostra "Roteamento desligado", sem números de roteamento: nem "0 %" nem "US$ 0,00".
  - INVALID mostra "Configuração inválida" com a causa.
  - Leitor fora do ar mostra "Estado desconhecido" e aviso; nunca OFF.
- [x] Glifo, texto e `aria-label` em todo estado:
  - ✓ roteada, ○ sem roteamento, ‖ com recusa, ? desconhecido;
  - "diferente do pedido" vem em texto, não só por cor.
  - Os filtros usam `data-tfilter` (`routing-<filtro>`), então `views.js` devolve o foco depois do refresh.
- [x] Em 375 px não há rolagem horizontal da página.
  - `document.scrollWidth` = 375 = `innerWidth`.
  - Runs e mistura viram cartões e lista. A tabela da policy fica numa região rolável rotulada (`role=region`, `tabindex=0`).

**Verificação:**
- [x] `routing-ui.test.js`: 8/8, no harness `vm` do `version-ui.test.js` (navegação, `aria-selected`, estados, filtros, Atualizar).
- [x] Manual no navegador: Dashboard real contra um consumidor sintético, em 1440×900 e 375×812.
  - Notas e capturas em `prisma-evidence/2026-11-06-pri-205-routing-ui/t5/`.
  - Único erro no console: 500 em `/api/validate-config`, painel que já existia. O consumidor sintético não tem `config-contract.json`, então não tem relação com esta mudança.

> **T5 feita em 2026-11-06, sem commit.**
> - Receita oficial do dashboard: 353/353 no Node 20.20.2 e no 22.23.2.
> - `check:js`, `lint:src` e `arch:check` (Node 22) limpos, sem violação nova.
> - O item de nav "Roteamento de modelo" fica em Operação, antes de "Medição de modelo". A T6 vai absorver a "Medição de modelo" na aba "Sombra × real".

**Depende de:** T4. **Arquivos:** `dashboard/public/routing.js`, `dashboard/public/screens/routing.css`, `dashboard/public/views.js`, `dashboard/public/index.html`, `dashboard/routing-ui.test.js`. **Tamanho:** M

### T6: Aba "Sombra × real" (absorve "Medição de modelo")

**Descrição:**
- a aba mostra a comparação de T3 e embute a `WouldRouteMetricsView` existente;
- a "economia potencial" ganha o rótulo **hipótese (razão de preço), não custo real**;
- o item de nav "Medição de modelo" vira atalho para esta aba, para não quebrar links e testes.

**Aceite:**
- [x] A legenda diz em texto e com glifo: = igual, ↑ real acima da sombra, ↓ real abaixo da sombra, ? sem comparação. Ao lado vem o aviso "Efeito na qualidade: não medido".
- [x] Os testes atuais de `would-route-metrics` continuam verdes: unidade e API, 21/21 junto com `routing-ui`.

> **T6 feita em 2026-11-06, sem commit.**
>
> **Testes:**
> - `routing-ui.test.js`: 13/13, com 5 testes novos da T6.
> - Receita oficial do dashboard: 358/358 no Node 20.20.2 e no 22.23.2.
> - `check:js`, `lint:src` e `arch:check` (Node 22) limpos.
> - Navegador em 1440 px e 375 px: evidência em `prisma-evidence/.../t6/`.
>
> **Ajustes em relação à descrição:**
> - **"Medição de modelo" saiu da nav** em vez de virar um item duplicado. O hash e a preferência `medicao-modelo` viram alias de `roteamento` com a aba Sombra, pelo mesmo mecanismo do alias `my-tickets` → `redmine`. Assim links antigos continuam funcionando. O `setView` passou a aplicar o alias.
> - **Textos desatualizados corrigidos** na `would-route-metrics.js`, que vai além do rótulo previsto:
>   - **Cliente:** título "Medição em sombra (S3)", banner "Só medição em sombra…" e duas frases que diziam "S4 desligado / despacho AS-IS".
>   - **Servidor** (`dashboard/would-route-metrics.js`): a nota e 3 frases do diagnóstico.
>   - Depois da S4, essas frases podiam ser falsas com o roteamento ligado. A mudança é só de texto, sem efeito na lógica.
> - `docs/dashboard-medicao-modelo-humano.md` foi atualizado para a nova navegação.

**Verificação:** testes focados de `would-route-metrics*` e `routing-ui`, e conferência manual.
**Depende de:** T5. **Arquivos:** `dashboard/public/routing.js`, `dashboard/public/would-route-metrics.js` (só o rótulo), `dashboard/public/views.js`. **Tamanho:** S

### T7: Bloco "Roteamento" no detalhe da Run + formulário de override

**Descrição:** `public/routing-run.js`, ligado no detalhe da Run fora de `cost-attempts.js`. Mostra:
- snapshot, policy da Run e drift;
- overrides pendentes e aplicadas;
- `NOT_STARTED`;
- formulário com escopo `ticket` ou `node`, nó, modelo vindo do `eligible_set` do snapshot, esforço vindo do `effort_map` com a nota SP-1, e credencial pelo fluxo do `authorization.js`.

O `operation_id` é gerado uma vez e reusado no retry. O formulário fica desabilitado com motivo quando a Run é OFF ou o snapshot está ilegível. A resposta 409 aparece com `code` e `error`.

O snapshot do `eligible_set` e do `effort_map` vem do `/api/routing`, ou de um campo novo no resumo da Run se ficar mais simples. Essa escolha fica registrada no PR.

**Aceite:**
- [x] Override válida grava (200) e aparece como "ainda não aplicada".
  - Quando a resposta se perde, o retry reusa o mesmo `operation_id` e recebe `already_processed`, sem segunda override.
  - Mudar o formulário depois de um resultado incerto gera um `operation_id` novo.
- [x] Cada código chega à UI como veio do writer, com uma explicação curta ao lado. Testado contra o servidor real: `OVERRIDE_INELIGIBLE` (o `APPROVER_DENIED` saiu com a §3.6 da SPEC). Os outros (`ROUTING_OFF`, `ROUTING_UNVERIFIABLE`, `OVERRIDE_INVALID`, conflito) passam pelo mesmo caminho genérico `code` + `error`.
  - Nó rodando: o botão fica desabilitado com o motivo, no padrão PRI-126. O writer continua sendo a guarda.
  - Snapshot não verificado ou sem modelos elegíveis: desabilitado com o motivo.
- [x] ~~A senha do aprovador não é salva.~~ Desde 2026-11-06 não há aprovador nem senha (SPEC §3.6); o formulário não manda credencial nenhuma.

> **T7 feita em 2026-11-06, sem commit.**
>
> **Testes:**
> - `routing-run-ui.test.js`: 8/8, contra o `createDashboard` real com aprovador sintético e Run roteada com snapshot no DOM-06.
> - Projeção 3 testes novos e API 1 teste novo.
> - Receita oficial do dashboard: 370/370 no Node 20.20.2 e no 22.23.2. `check:js`, `lint:src` e `arch:check` (Node 22) limpos.
>
> **Navegador:** gravação real pelo formulário. A config de aprovadores era sintética, nunca `~/.config/prisma`. Resultado:
> - RO-2 gravada pelo writer existente; a Run continuou `blocked`.
> - Em 375 px, a caixa cabe na tela.
> - Evidência em `prisma-evidence/.../t7/`.
>
> **Ajustes em relação à descrição:**
> - Opções do formulário vêm de dois campos novos na projeção da Run, `snapshot.eligible_models` e `snapshot.efforts`, lidos **do snapshot**, nunca da policy vigente.
> - `GET /api/routing?task=<id>` lê só a Run pedida. Valor fora do formato de task-id devolve 400.
> - O bloco só aparece em Run com `routing_snapshot`. Run OFF não ganha bloco, para não poluir o detalhe; nela o writer recusaria com `ROUTING_OFF`.
> - Escopo `subtask` não é oferecido (Q6). Nós oferecidos: plan, implement, review, test, verify e commit. O writer aceita qualquer nó; a lista só guia.

**Verificação:** extensão do `authorization-api.test.js`, ou `routing-override-ui.test.js`, para o caminho UI → endpoint; teste manual com fixture ON.
**Depende de:** T4. Pode correr em paralelo com T5 e T6. **Arquivos:** `dashboard/public/routing-run.js`, `dashboard/public/index.html`, CSS, teste. **Tamanho:** M

### T7b: Seletor do classificador — "Só policy" / "Policy + Jev" (UI feita contra o contrato; integração pendente)

> **UI feita em 2026-11-06, sem commit.**
> - **Onde:** cartão "Classificador (núcleo 2)" na aba Hoje (`routing.js`), com estilos em `routing.css`.
> - **Testes:** `routing-ui.test.js` 19/19, sendo 6 da T7b contra um fixture do contrato. Receita oficial do dashboard: 376/376 nos Nodes 20 e 22. `check:js`, `lint:src` e `arch:check` limpos.
> - **Navegador**, com o Dashboard real e um fixture do contrato:
>   - fluxo completo: "Enviado" durante a espera e "Aplicado" só depois do 200;
>   - opções recusadas mostram o código e o detalhe que vêm da API;
>   - sem rolagem horizontal em 375 px.
>   - Evidência em `prisma-evidence/.../t7b/`.
> - **Pendente:** teste de integração com o endpoint real quando a sessão do Jev avisar.
> - **Aprovador e senha removidos de todo o Dashboard** (decisão do Richard em 2026-11-06; SPEC §3.6).
>   - **Servidor:** `requireApprover` virou `actorOf()`. A autoria é o usuário do sistema operacional; o filtro de localhost continua.
>   - **Telas:** autorização de SQL, devolução ao QA, override e seletor, todas sem campos de credencial.
>   - **Testes de autorização reescritos:** sem 401/403/429; autoria = usuário do SO; o pedido continua recusado sem hash; Origin de terceiro → 403.
>   - **Docs:** runbook e concurrency-map, com o risco que isso abre registrado.
>   - **Contrato do seletor:** a sessão do Jev foi avisada de que o POST não tem mais credenciais.

> **2026-11-06: contrato recebido da sessão do Jev.** Está na SPEC §3.5 e em `prisma-evidence/.../contrato-seletor-classificador.md`.
> - **Pode ser feito já:** a UI contra o contrato, testada com um servidor de fixtures.
> - **Fica para quando o endpoint existir:** o teste de integração com o endpoint real e a verificação no navegador. A sessão do Jev avisa.
> - **Plano de implementação:** um bloco no cartão "Configuração do projeto" de `routing.js`.
>   - Lê `GET /api/routing/classifier`.
>   - Mostra as opções a partir de `options[]`: desabilitadas com `refusal` e `detail`.
>   - Pede motivo (`reason`) e confirmação.
>   - Grava com `expected_version` e com o `operation_id` reusado no reenvio.
>   - Mostra "enviado…" até a resposta; "aplicado" ou "já registrado" só depois do 200.
>   - Exibe o histórico.

**Origem:** requisito do Richard em 2026-11-06, via sessão coordenadora: "deve ter como selecionar as duas opções tanto usar o jev quanto só usar a policy". Detalhes na SPEC §3.5.

**Divisão:**
- A sessão do Jev (`local_98c26694…`) é dona do contrato da seção `classifier`, do writer governado (validações 0–5 do §4.8) e do endpoint. Ela vai mandar o formato da API.
- Esta tarefa é só o controle na UI.

**Descrição:** no cartão "Configuração do projeto" da aba Hoje:
- estado atual do classificador (provider, modo, versão, quem/quando/motivo, se a API trouxer);
- controle com **"Só policy"** (`off`) e **"Policy + Jev"** (`jev` em `shadow`);
- **"Policy + Jev (ativo)"** desabilitado com o motivo vindo da API enquanto não houver calibração;
- aviso fixo **"vale só para Runs novas"**;
- gravação no padrão do override da T7: aprovador pelo fluxo de credencial existente, `expected_version`, chave de idempotência reusada no retry e confirmação antes de gravar;
- recusa do writer projetada com `code` + `error`. A tela não é a guarda.

**Aceite:**
- [ ] O estado atual aparece. Sem dado, aparece desconhecido, nunca "Só policy" por omissão.
- [ ] "Só policy" e "Policy + Jev" gravam pelo endpoint da sessão do Jev. Repetir com a mesma chave devolve o resultado gravado, sem segunda escrita.
- [ ] "Ativo" fica desabilitado com o motivo enquanto a API não indicar calibração válida.
- [ ] Cada código de recusa do §4.8 chega à tela como veio.
- [ ] O aviso "vale só para Runs novas" está sempre visível. Sem rolagem horizontal em 375 px.

**Verificação:** testes no harness de UI e contra o endpoint real da sessão do Jev; verificação no navegador.
**Depende de:** formato da API (sessão do Jev) e T7 (padrão de credencial e idempotência). **Arquivos prováveis:** `dashboard/public/routing.js`, `screens/routing.css`, `routing-ui.test.js`, e a projeção do estado do classificador no `/api/routing` se a API não trouxer a sua. **Tamanho:** M

### Checkpoint B (PR 1)

- [ ] `prisma-tests` (scripts + dashboard), `check:js`, `lint:src` e `arch:check` limpos.
- [ ] Critérios de aceite 1–5, 7 e 8 da SPEC conferidos.
- [x] Revisão independente (Claude, 2026-11-06): CHANGES_REQUESTED, com 2 MAJOR, 8 MINOR e alguns NIT. Achados corrigidos ou registrados.
  - **MAJOR-1, corrigido:** Origin de outra porta do localhost passava no filtro. Agora o Origin tem de estar na mesma porta do Dashboard (HTTP e WebSocket), e escrita com `Sec-Fetch-Site` diferente de `same-origin`/`none` é recusada. Testes em `server.test.js` e no `authorization-api.test.js` (handback, reject e override: 403 e nenhum efeito).
  - **MAJOR-2, corrigido:** depois de um 5xx, o `operation_id` é mantido e a tela mostra "resultado incerto". Só 2xx ou 4xx com `code` encerram a operação. Testes nos dois formulários.
  - **MINOR-1, corrigido:** a chave do cache do snapshot inclui `mtime` e tamanho do Attempt de admissão. Teste de adulteração.
  - **MINOR-5, corrigido:** uma Run ON com recusas não verificadas aparece como "? roteada, recusas desconhecidas".
  - **MINOR-6, corrigido:** sem decisão real, a sombra não mostra contagens zeradas.
  - **MINOR-7, corrigido:** o 500 do `/api/routing` não devolve mais `e.message`.
  - **MINOR-8, corrigido:** varredura anti-caminho no `?task=` e no snapshot adulterado.
  - **NITs de texto, corrigidos:** comentário do override, runbook e aceite da T7.
  - **Registrados para depois** (não bloqueiam):
    - MINOR-2: a view não recarrega com os eventos do WebSocket; hoje é preciso clicar em Atualizar.
    - MINOR-3: o motivo do seletor perde o foco a cada refresh.
    - MINOR-4: o `change` do select remonta o bloco e o foco se perde.
    - NITs:
      - o formulário vem pré-preenchido com o último modelo e o esforço `alto`;
      - o glifo com `aria-label` duplica o texto ao lado;
      - o tablist não tem navegação por setas;
      - `role=note` num bloco com formulário;
      - as classes `rtr-*` não têm CSS;
      - o `updated_at` sai cru do state;
      - `validateRoutingOverride` ainda diz "aprovador ausente".
- [ ] Verificação no navegador em 1440 px e 375 px, com evidência na pasta de evidência.
- [ ] Handoff e PR. Merge pelo Richard.

## Fase 3: custo × qualidade (Entrega 2; depende de Q1, Q2, Q4, Q5 e Q7)

### T8: Projeção de qualidade

**Descrição:** `projectQuality(runs, params)`. Parâmetros nomeados:
- `APPROVED_PROXY` (Q1);
- `SMALL_N` (Q2);
- `INTERVAL` (Q4);
- `WINDOW` (Q5);
- `COST_SCOPE` (Q7).

Célula = `policy_ref` × classe do Implement × modelo pedido no Implement. Em cada célula:
- `n` iniciado, aceito, não aceito, em andamento e missing;
- aprovação com IC de Wilson;
- custo real por aprovada, com intervalo por bootstrap de semente fixa;
- custo por tentativa, retrabalho, recusa de QA, mediana de duração e completude;
- `status`: `MEASURED`, `SMALL_SAMPLE`, `NOT_MEASURED(dep)` ou `UNKNOWN`.

Métricas de S5, S6 e Jev saem como `NOT_MEASURED` com a dependência indicada.

**Aceite:**
- [ ] Zero aprovadas dá custo por aprovada `null`, com motivo. Nunca infinito nem 0.
- [ ] Célula com custo sem preço sai como "incompleta", com contagem.
- [ ] Policies diferentes nunca caem na mesma célula. Resultados determinísticos pela semente.

**Verificação:** teste focado com fixtures.
**Depende de:** T2, T3 e as respostas. **Arquivos:** `dashboard/routing-quality.js` e teste. **Tamanho:** M

### T9: `GET /api/routing/quality`

**Descrição:** endpoint com `?window=` validado, redação e cache.
**Aceite:**
- [ ] Forma estável.
- [ ] `window` inválida dá 400.
- [ ] Varredura anti-caminho.

**Verificação:** `routing-quality-api.test.js`.
**Depende de:** T8. **Arquivos:** `server.js`, teste, `package.json`. **Tamanho:** S

### T10: Aba "Custo × qualidade"

**Descrição:**
- matriz classe × modelo com seletor de métrica;
- dispersão com custo real em escala log × aprovação com IC, e tabela alternativa;
- painel do par selecionado;
- piso de qualidade só visual, sem gravar nada;
- ★ só fora de amostra pequena;
- texto "custo real = todas as tentativas ÷ aprovadas" com o proxy de aprovada **nomeado**;
- células S5, S6 e Jev como "não medido (dependência)".

Sem botão "pedir mudança".

**Aceite:**
- [ ] Critério 6 da SPEC.
- [ ] Sem rolagem horizontal em 375 px.
- [ ] Legenda em texto, não só cor.

**Verificação:** `routing-ui.test.js` e manual em 1440 px e 375 px.
**Depende de:** T9. **Arquivos:** `public/routing.js`, `routing.css`, teste. **Tamanho:** M

### Checkpoint C (PR 2)

- [ ] Mesmo checklist do Checkpoint B, com o critério 6 da SPEC.
- [ ] Respostas Q1, Q2, Q4, Q5 e Q7 registradas na SPEC.
