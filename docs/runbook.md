> Candidata extraída PRI-60. Os exemplos/histórico de app-back neste documento
> identificam a origem, não configuram o consumidor atual. Consulte docs/consumption.md
> e docs/extraction-paths.md: comandos de plataforma em PRISMA_ROOT, cwd/REPO_PATH
> e configuração/estado no consumidor. Nenhum procedimento de recovery/cutover
> é autorizado por esta cópia. A fonte histórica continua atribuída no manifesto.

# Runbook Operacional — Graph Engineering / Claude Automation

> Para quem está vendo isto às 22h sem lembrar dos detalhes: leia primeiro
> **"Como o sistema funciona em 1 minuto"** e **"Diagnóstico rápido"**, depois pule
> direto pro cenário que bate com o sintoma.
>
> Tudo aqui foi conferido contra o código em `scripts/readmine-watcher.js`,
> `scripts/lib/*.js`, `scripts/watcher-manager.js`, `dashboard/server.js`,
> `.graph/graph.yaml`, `.graph/schemas/state.schema.json` e `.claude/commands/*.md`
> (setembro/2026). Onde o comportamento não pôde ser confirmado no código, o texto diz
> **"comportamento a confirmar"**. Se algo aqui divergir do código, o código vence —
> corrija este arquivo.
>
> Sobre o `AGENTS.md`: o da raiz foi removido junto com o Codex em 2026-09-18
> (`memory/decisions/2026-09-18-remocao-codex-workflow.md`). O que sobra é
> `.cursor/AGENTS.md`, que é instrução para o Cursor e não descreve nenhum cenário de
> falha — por isso este runbook não o cita.

---

## Como o sistema funciona em 1 minuto

| Peça | O que é | Onde |
|---|---|---|
| **Dashboard** | Servidor Express local que controla o watcher e mostra os runs | `dashboard/server.js` → `http://localhost:3333` (porta = env `PORT`) |
| **Laço do watcher** | Dispara um *tick* a cada `WATCHER_TICK_INTERVAL_MS` (padrão 60 s). Se o tick sai com erro, reinicia em 3 s, **no máximo 3× por hora** — depois para com `error: "restart_limit_reached"` | `scripts/watcher-manager.js` (roda dentro do dashboard) |
| **Tick** | Um processo `node "$PRISMA_ROOT/scripts/readmine-watcher.js"` que roda **uma vez e sai**. Não é um daemon. | `scripts/readmine-watcher.js` |
| **Agente** | Processo destacado pelo tick (sobrevive ao tick e ao dashboard). Um despacho = um nó do grafo. Quem decide se está vivo é o lease (`agent_pid` + `agent_started_at`), não o texto `claude` no comando. | `state.json` |
| **Estado da task** | `state.json` — única fonte de verdade de em que pé a task está | `.claude/worktrees/<ticket>/memory/runs/<task-id>/state.json` (tasks de ticket) ou `memory/runs/<task-id>/state.json` (tasks ad-hoc) |
| **Arquivo morto** | Tasks finalizadas | `memory/runs/_archive/<task-id>/` |

O que cada tick faz, nesta ordem (`main()` e `tick()` em `readmine-watcher.js`):

1. **Recupera nós órfãos** (tasks presas em `running` cujo agente morreu) — ver cenário 1.
2. Busca no Redmine os tickets **atribuídos a você** (`assigned_to_id=me`, o dono da
   `REDMINE_API_KEY`) com status **Aprovada (id 11)** ou **Recusa QA (id 13)**.
3. Soma a isso os tickets que já têm task ativa num worktree local (mesmo que no
   Redmine já estejam em "Em Desenvolvimento").
4. Para cada ticket, lê o `state.json` e decide: despachar o próximo nó, ou pular
   (com um motivo gravado em `memory/runs/watcher-state.json`).

Grafo (`.graph/graph.yaml`): `fetch_ticket → plan → implement → review → test → verify → commit`.
Review/test reprovados voltam pro implement (máx. 3 retries; verify máx. 2); estourou,
a task vai pra `escalated` e espera humano.

Status do Redmine que o sistema mexe:

| Quem | Transição |
|---|---|
| `/fetch-ticket` | Aprovada → **Em Desenvolvimento** (id 2) |
| `/commit` | → **Ag Merge** (id 20), **só se o PR abriu de fato** |

### Status do `state.json` que você vai encontrar

| `status` | Significado | O watcher redespacha sozinho? |
|---|---|---|
| `in_progress` | Parado entre nós, pronto pro próximo | **Sim**, no próximo tick |
| `running` | Um agente está (ou estava) rodando o nó `node` | Não — vira `in_progress` pela recuperação de órfão se o agente morreu |
| `blocked`, `escalated`, `needs_human_review` | Precisa de humano | Não (comenta no Redmine uma vez) |
| `interrupted` | Watcher recebeu SIGTERM no meio do nó | Não — retome gravando `in_progress` |
| `session_limit` | Sessão do agente estourou contexto/tokens | Não — retome pelo dashboard (até 3×) |
| `state_corrupted` | `state.json` falhou na validação | Não — ver cenário 7 |
| `spec-invalid`, `spec-pending-approval` | Spec do ticket incompleta | Espera "aceito"/"aprovado" no Redmine |
| `plan-escalation`, `churn-escalation`, `pre-build-failed` | Portões de qualidade | Espera "aceito" no Redmine ou flag `--aceitar-*` (churn: também o botão "Aceitar churn" no detalhe do run) |
| `spec-drift` | Spec mudou depois do /plan sem aprovação, ou a spec sumiu | Espera `spec_change_approved` + `spec_change_hash`, spec revertida, `node="plan"`, ou a mesma spec no checkout principal (o portão restaura e grava `spec_restored`) |
| `spec-change-pending-approval` | O /implement propôs uma SPEC_CHANGE (ver `spec_change_pending` e `spec-change-audit.json`) | Espera "aprovado" (volta pro /plan) ou "rejeitado" no Redmine/dashboard. Sem Redmine: `node "$PRISMA_ROOT/scripts/lib/spec-change.js" approve\|reject memory/runs/<task-id> --by="<nome>"` |
| `spec-change-rejected` | SPEC_CHANGE rejeitada, spec intacta | Sim, por mensagem no dashboard (Responder ao agente), interpretada como em `blocked` — ou grave `node="implement"`, `status="in_progress"` para implementar a spec como está |
| `authorization-pending` | O agente pediu autorização para ação externa privilegiada (ex.: SQL num banco compartilhado) — ver `pending_authorization` | Não (comenta no Redmine uma vez). Decisão **só** pelo dashboard: Aprovar / Recusar / Já apliquei manualmente. Mensagem livre não aprova — ver "Autorização humana" |
| `handed_back_qa` | Devolvido ao QA sem código (Ag Teste + arquivado) | Não — terminal; nova Recusa QA usa "Corrigir recusa QA" |
| `committed` | `/commit` terminou (PR aberto ou commit local) | Não — terminal |
| `fully_merged` | Todos os PRs MERGED (polling do Bitbucket) | Não — terminal |

`node` é **sempre o próximo nó a rodar**, nunca o que acabou de rodar (esse fica em `history`).

---

## Testes dos pacotes (receita oficial)

Procedimento de desenvolvimento da plataforma, não de operação do consumidor. Rode
em checkout/floor descartável da revisão exata, com dependências já preparadas
pelos locks de cada pacote. Não use o consumidor ativo como fixture. O ambiente
de referência é Node 20.20.2/npm 10.8.2. Registre as versões efetivamente
executadas, HEAD e diff: testes de árvore modificada não certificam o commit base
sozinho.

```bash
# Substitua os caminhos absolutos antes de executar. CK é o checkout descartável,
# que faz também o papel de raiz de assets sintéticos dos testes (não de consumidor
# vivo). EV fica fora do checkout e guarda HOME/TMPDIR sintéticos e os TAPs.
CK="/caminho/checkout-descartavel"; EV="/caminho/evidencia"
mkdir -p "$EV/home" "$EV/tmp"
run_suite() {
  env -i PATH="/caminho/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    HOME="$EV/home" TMPDIR="$EV/tmp" \
    NODE_OPTIONS="--require=$CK/harness/loopback-only.cjs" \
    PRISMA_ROOT="$CK" REPO_PATH="$CK" \
    npm --prefix "$CK/$1" test > "$EV/$1.tap" 2>&1
}
run_suite scripts; scripts_exit=$?
run_suite dashboard; dashboard_exit=$?
printf 'scripts exit=%s; dashboard exit=%s\n' "$scripts_exit" "$dashboard_exit"
shasum -a 256 "$EV/scripts.tap" "$EV/dashboard.tap"
```

- `env -i` com HOME/TMPDIR sintéticos impede que o `npm` use cache, logs e config
  do home real e que os testes gravem no TMPDIR do sistema.
- `harness/loopback-only.cjs` recusa conexões TCP Node fora do loopback. É um
  reforço bounded: não cobre subprocessos shell (curl, git) nem é sandbox universal.

Os dois `npm test` passam pelo harness `harness/run-tests.js`. Ele exige
REPO_PATH/PRISMA_ROOT absolutos e existentes, confere a identidade do checkout do
harness e os assets de teste, executa os arquivos selecionados pelo manifest com
cwd REPO_PATH, gera TAP e preserva o exit code. Root ausente é exit 2 antes dos
testes, sem fallback para scripts/ ou dashboard/. Roots distintos são permitidos
quando REPO_PATH contém os assets sintéticos necessários:
`.claude/spec-hash-config.json`, `.claude/config-contract.json` e
`scripts/fixtures/ticket-example.json`. Esta fixture é própria dos testes, não
traz ticket, configuração, histórico ou segredo do consumidor.

O runner também isola o ambiente: o `node --test` recebe só `PATH`, `HOME`,
`TMPDIR`, `LANG`, `LC_ALL`, `TZ`, `CI`, `NODE_OPTIONS` e os dois roots. Config do
consumidor (`WATCHER_*`, `OPENAPI_*`), credenciais e variáveis `npm_*` são
descartadas mesmo sem `env -i`. Teste que precisa de identidade ou config de
consumidor deve fixá-la na própria fixture.

A seleção preexistente de cada pacote é preservada; scripts acrescenta o
harness legado de abertura de PR e os testes do runner. Não equivale a todos os
arquivos `*.test.js` do repositório, nem a C0–C5. Os testes de API usam servidores
falsos loopback e os de DOM06 criam Attempts sintéticos com o CLI/gate reais.
Execute sem credenciais/rede externa. Em ambientes restritos, `ps` e eventos do
filesystem precisam estar disponíveis aos testes de lease/watchers; falha de
infraestrutura não é PASS.

Exija resumo TAP final e exit code, liste cada falha com causa ou UNKNOWN e
preserve os hashes. Um run verde isolado não substitui a reconciliação das
baselines por revisão (C0–C5) nem a revisão independente; harness histórico
ausente deste repo não deve ser transportado por este procedimento. Nenhum teste
admite repin, cutover, alteração de contrato ou relaxamento de DOM06.

---

## Diagnóstico rápido

Rode da raiz do consumidor (`cd <checkout-consumidor>` ou onde estiver o checkout
principal — **nunca de dentro de um worktree**). Precisa de `jq`.

**1. O laço do watcher está vivo?**

```bash
curl -s localhost:3333/api/watcher/status | jq '{state, running, phase, error, restarts_last_hour, next_tick_at, ticks}'
```

- Sem resposta → o dashboard está fora do ar (nada roda). Ver "Como reiniciar o watcher".
- `state: "stopped"` + `error: "restart_limit_reached"` → o tick crashou 3× na última hora. Ver cenário 2.
- `state: "running"`, `phase: "idle"`, `pid: null` → **normal** entre ticks.

**2. Saúde (lê disco, não chama Redmine, não grava nada):**

```bash
node "$PRISMA_ROOT/scripts/readmine-watcher.js" --health-check | jq
```

`healthy: false` + `issues` lista órfãos e watcher morto com ciclo ativo. Exit code 1 = inconsistente.

**3. O que o último tick decidiu para cada ticket:**

```bash
jq '{last_tick_at, tickets: (.tickets | map_values({status, action, reason, node, taskId}))}' memory/runs/watcher-state.json
```

`reason` diz exatamente por que um ticket foi pulado (tabela no cenário 2).

**4. Todas as tasks ativas (fora do `_archive`):**

```bash
find memory/runs .claude/worktrees -path '*/memory/runs/*/state.json' -not -path '*/_archive/*' 2>/dev/null \
  | while read -r f; do jq -r --arg f "$f" '[.task_id, .status, .node, (.node_started_at // "-"), ((.agent_pid // "-")|tostring), (.updated_at // "-"), $f] | @tsv' "$f"; done \
  | column -t -s $'\t'
```

Atenção ao ler essa lista: os worktrees podem conter **cópias antigas** de runs de outros
tickets (ex: `43499-...` dentro de `.claude/worktrees/43539/`). Para despachar, o watcher só
considera, no worktree `.claude/worktrees/<ticket>/`, as pastas que começam com `<ticket>-`
(`findActiveTask`). Ignore as demais ao diagnosticar um ticket.

**5. Processos vivos:**

```bash
ps -Ao pid,etime,command | grep -E 'readmine-watcher|claude -p|dashboard/server' | grep -v grep
```

**6. Log ao vivo do watcher** (só existe em memória no dashboard — ringbuffer de 200 linhas, não vai para disco):

```bash
curl -sN localhost:3333/api/watcher/log-stream
```

**7. Log de um ticket** (saída do agente `[claude]` + marcos do watcher `[watcher]`, já com secrets redigidos):

```bash
tail -n 100 memory/runs/<ticket>.log
```

---

## Cenários de falha

### 1. Task presa em "running" por mais de 30 minutos

**Sintoma:** `state.json` mostra `status: "running"`, mas nenhum processo `claude` trabalha nela.

**Causa provável:** o watcher, o agente ou a máquina morreu com o nó em andamento. Quem
devolve o status para `in_progress` é o *release* do lease (`scripts/lib/node-lease.js`),
que roda quando o agente sai; se ninguém sobreviveu para rodá-lo, sobra `running`.

**Comportamento real (importante antes de agir):** o sistema já trata isso sozinho, **no
início de cada tick** (`recoverOrphans`):

- `agent_pid` gravado e o processo morreu, ou o pid foi reciclado (o processo que está
  nesse pid **não** começou em `agent_started_at` — vale mesmo que o comando contenha
  `claude`) → órfão **na hora**, no próximo tick.
- Lease antigo, sem `agent_started_at`: o processo conta como o agente só se nasceu entre
  `node_started_at` e 15 min depois (`LEGACY_SPAWN_WINDOW_MS` em `scripts/lib/node-lease.js`).
  Fora dessa janela é órfão. `ps`/`pgrep` conferem o que o operador está vendo; quem decide
  é o lease.
- sem `agent_pid` → órfão só depois de `node_timeout_ms` (padrão **60 min**, env
  `NODE_TIMEOUT_MS`; não é 30 min — 30 dava falso positivo em nó vivo, ver
  `memory/decisions/2026-09-22-recuperacao-no-orfao-watcher.md`).
- nó comum órfão → volta para `in_progress` + `recovered_from_orphan`, e é
  **redespachado no mesmo nó** (sem mexer em `retries`).
- nó **`commit`** órfão → vira `needs_human_review` e **não** é redespachado (pode ter
  feito push/aberto PR antes de morrer).
- `running` **sem** `node_started_at` → não decide; loga `[recovery] ... verifique manualmente`.

Então, com 30–60 min e o watcher rodando, na maioria dos casos **esperar** resolve.

**Ação:**

1. Veja o lease da task:
   ```bash
   jq '{status, node, node_started_at, node_timeout_ms, agent_pid, agent_started_at}' .claude/worktrees/<ticket>/memory/runs/<task-id>/state.json
   ```
2. O agente está vivo? A checagem é o início do processo, não o nome do binário:
   ```bash
   ps -p <agent_pid> -o pid,lstart,etime,command
   ```
   - **Mesmo pid e o `lstart` bate com `agent_started_at`** (tolerância de 2 s; codex, `sh` ou
     outro binário contam igual) → não é órfão, está trabalhando (nós de review/test/commit
     costumam levar 45–60 min). Acompanhe `tail -f memory/runs/<ticket>.log`. Se tiver certeza de
     que está travado, veja "Como interromper o ciclo de uma task específica".
   - **Sem `agent_started_at`** (lease antigo): vivo só se o `lstart` cai na janela de 15 min
     a partir de `node_started_at`.
   - **Morto, pid inexistente, ou `lstart` diferente do gravado** (pid reciclado) → siga.
     `pgrep` aqui é checagem, não a regra.
3. O laço do watcher está rodando? (Diagnóstico rápido, passo 1.)
   - Sim → espere o próximo tick (`next_tick_at`). Confirme no log-stream a linha
     `[recovery] Task <task-id>: nó <nó> órfão desde ... — redespachando`.
   - Não → inicie o watcher (ver "Como reiniciar o watcher"); a recuperação roda no primeiro tick.
4. Quer ver o que a recuperação faria sem gravar nada?
   ```bash
   node "$PRISMA_ROOT/scripts/readmine-watcher.js" --dry-run --ticket=<ticket>
   ```
5. Se o nó era `commit` e virou `needs_human_review`: vá para o cenário 3/4 — confira se a
   branch foi empurrada e se há PR **antes** de retomar:
   ```bash
   git -C .claude/worktrees/<ticket> log --oneline -5
   git -C .claude/worktrees/<ticket> status --short
   git ls-remote --heads origin <ticket>
   jq '.pull_request, .pr_id, .pr_status' .claude/worktrees/<ticket>/memory/runs/<task-id>/state.json
   ```
   Se nada foi empurrado, retome gravando `"status": "in_progress"` (com o watcher parado —
   ver "Como interromper").
6. Caso `running` sem `node_started_at` (não é tratado sozinho): com o watcher parado e o agente
   confirmadamente morto, grave `"status": "in_progress"` à mão.

**NÃO faça:**
- Não edite o `state.json` com o laço do watcher rodando **nem** com o agente vivo — os dois
  gravam nele e a sua edição é sobrescrita (ou pior, você gera dois agentes no mesmo worktree).
- Não diminua `NODE_TIMEOUT_MS` para "destravar mais rápido": em modo normal cada tick é um
  startup, e um nó lento declarado órfão vira dois agentes no mesmo worktree.
- Não redespache um `commit` órfão sem conferir branch remota e PRs.

---

### 2. Watcher iniciou mas não está processando tasks

**Sintoma:** tickets em "Aprovada" no Redmine, mas nenhum ciclo começa (nenhum worktree novo
em `.claude/worktrees/<ticket>`, nenhum `memory/runs/<ticket>.log` crescendo).

**Causas prováveis:**

| # | Causa | Onde aparece |
|---|---|---|
| A | Laço parado (dashboard fora, Stop, ou `restart_limit_reached`) | `/api/watcher/status` |
| B | Tick crasha logo no início (ex: `REPO_PATH` ausente no `.env`) | log-stream / `restart_limit_reached` |
| C | Redmine inacessível / `REDMINE_API_KEY` inválida / `REDMINE_URL` errada | log-stream com erro de JS logo após o tick começar |
| D | Ticket não está atribuído ao dono da API key, ou não está em Aprovada/Recusa QA | ticket nem aparece em `watcher-state.json` |
| E | Binário `claude` fora do `PATH` **do processo do dashboard** | log: `AVISO: binário \`claude\` não encontrado no PATH.`; `reason: "claude_indisponivel"` |
| F | O ticket foi visto mas pulado por uma regra | `reason` em `watcher-state.json` |

**Diagnóstico — nesta ordem:**

```bash
# A — laço
curl -s localhost:3333/api/watcher/status | jq '{state, error, restarts_last_hour, last_run}'
jq '.[-10:]' dashboard/watcher-history.json          # start/stop/crash/restart_limit recentes

# B, C, E — o que o tick está imprimindo
curl -sN localhost:3333/api/watcher/log-stream        # Ctrl+C pra sair

# D, F — o que o último tick decidiu
jq '.last_tick_at, (.tickets | map_values({status, action, reason}))' memory/runs/watcher-state.json

# Simular um tick para um ticket sem despachar nada (só GET no Redmine; não grava nada em
# memory/ nem nos worktrees — o que gravaria sai como "[dry-run] ... gravaria state.json: ..."):
node "$PRISMA_ROOT/scripts/readmine-watcher.js" --dry-run --ticket=<ticket>
```

Se `last_tick_at` é antigo (mais que alguns minutos), o problema é A/B/C. Se é recente e o
ticket não está na lista, é D. Se está na lista com `action: "skip"`, é F.

**Testar o Redmine sem imprimir a chave** (carrega o `.env` só nesta subshell):

```bash
( set -a; . ./.env; set +a; curl -s -o /dev/null -w 'HTTP %{http_code}\n' -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/users/current.json" )
```

200 = ok; 401 = chave inválida; `000` = sem rede/URL errada.

**Ação por causa:**

- **A** — Laço parado: veja "Como reiniciar o watcher de forma segura". Se foi
  `restart_limit_reached`, **não** aperte Start antes de achar a causa no log (senão volta a
  crashar 3× e para de novo).
- **B** — Crash no startup: leia o erro no log-stream. Confira que o `.env` existe **na raiz do
  app-back** (não num worktree) e tem `REPO_PATH`, `REDMINE_URL`, `REDMINE_API_KEY`
  preenchidos (ver comentários do `.env.example`). Depois: Start.
- **C** — Redmine: toda chamada do watcher passa por `scripts/lib/redmine-fetch.js`.
  - Chave inválida → linha `[redmine] GET ...: HTTP 401 — erro de autenticação, sem retry.`
    (ou 403) no log-stream. Corrija `REDMINE_API_KEY` no `.env`.
  - Instabilidade (429/503/504, erro de rede) → o watcher repete sozinho com backoff
    (`REDMINE_RETRY_MAX_ATTEMPTS`, padrão 3; linhas `[redmine-throttle]`/retry no log). Se
    passa depois de alguns ticks, não precisa fazer nada.
  - URL errada → erro de rede persistente; corrija `REDMINE_URL`.

  O watcher relê o `.env` a cada tick, mas o dashboard só relê a lista de secrets para
  redação no Start — depois de mudar o `.env`, faça Stop/Start. *Comportamento a confirmar:*
  depois do 401 o código não checa o status da resposta, então o esperado é um erro de JS
  (`TypeError`) logo em seguida no log e o tick sair com código 0 — o laço **não** para, só não
  processa nada.
- **D** — No Redmine: atribua o ticket a você (o usuário dono da API key) e coloque em
  **Aprovada**. Outros status (Em Desenvolvimento, Ag Teste, Ag Atualização...) são ignorados
  para iniciar ciclo.
- **E** — O dashboard herda o `PATH` do terminal que o iniciou. Confira `command -v claude` no
  mesmo terminal, corrija e reinicie o **dashboard** (não só o watcher).
- **F** — Motivos de skip mais comuns (`reason` em `watcher-state.json`):

  | `reason` | O que fazer |
  |---|---|
  | `branch_liberacao_invalida` | Preencha o campo "Branch Liberação" do ticket com `Dev - Local` ou `Master - Stage` |
  | `spec_aguardando_aceite` (`spec-invalid`) | Complete a descrição do ticket ou responda **aceito** no Redmine (ou `--aceitar-spec=<id>`) |
  | `spec_aguardando_aprovacao` (`spec-pending-approval`) | Leia o draft comentado no ticket e responda **aprovado** |
  | `pretask_pergunta_pendente` | Preencha a seção `## Resposta` em `memory/runs/<ticket>-pretask-question.md` |
  | `ja_tratado_neste_ciclo` | Já existe task arquivada mais nova que a última alteração do ticket — é esperado. Para abrir ciclo novo, o ticket precisa ser alterado no Redmine depois do último commit |
  | `recusa_qa_aguardando_retry` | Recusa QA com run anterior: use o botão **"Corrigir recusa QA"** no dashboard (ou `WATCHER_RECUSA_QA_NOVO_CICLO=1` para abrir ciclo novo) |
  | `no_em_execucao` | Já há agente no nó — cenário 1 |
  | `status_blocked` / `status_escalated` / `status_needs_human_review` / `status_state_corrupted` | Humano precisa agir — leia o comentário `[Watcher]` no ticket; corrupção → cenário 7 |
  | `status_interrupted` | Retome gravando `"status": "in_progress"` (watcher parado) |
  | `status_authorization_pending` | Pedido de autorização esperando decisão no dashboard — seção "Autorização humana" |
  | `handback_nao_arquivada` | `handed_back_qa` fora do `_archive` (devolução morreu no meio): confira o ticket e arquive pelo dashboard |
  | `status_session_limit` | Botão de retomada no dashboard (`POST /api/runs/<task-id>/resume-session`, máx. 3×) |
  | `plan_escalation` / `churn_escalation` / `pre-build-failed` | Responda **aceito** no Redmine ou rode com `--aceitar-plano=<id>` / `--aceitar-churn=<id>` / `--aceitar-build=<id>`. Churn: antes de aceitar, veja o que cada rodada mudou com `git log -p refs/churn/<task>/start..refs/churn/<task>/rounds -- <arquivo>` no worktree do ticket; o botão "Aceitar churn" do dashboard faz o mesmo que o "aceito" |
  | `committed_nao_arquivada` | `/commit` não terminou o arquivamento — cenário 4 |
  | `claude_indisponivel` | Causa E |
  | `erro_inesperado` | Exceção só neste ticket; o `error` vem junto — leia o log-stream |

**NÃO faça:**
- Não rode `node "$PRISMA_ROOT/scripts/readmine-watcher.js"` à mão (sem `--dry-run`/`--health-check`) **ao
  mesmo tempo** que o laço do dashboard: são dois ticks concorrentes decidindo sobre os mesmos
  `state.json`.
- Não use `--follow` em nada automatizado — ele encadeia até 30 nós no mesmo processo; é para
  execução acompanhada.
- Não mude o status do ticket para Aprovada "para forçar" se ele já tem task ativa — a task
  ativa já é reidratada sozinha; o que trava é o `reason`.

---

### 3. PR aberto com código errado

**Sintoma:** o PR no Bitbucket existe, mas o diff está errado (mudança indevida, arquivo
faltando, lógica errada).

**Contexto — o que já aconteceu quando você vê o PR:**
- O `/commit` fez push da branch `<ticket>` (app-back e irmãos tocados: app-front, app-core,
  mo-entity), abriu o PR via `scripts/bitbucket-open-pr.sh` (sempre como **Draft**; `[HIGH-RISK]`
  se `risk_level: high`), gravou `pull_request`/`pr_id`/`pr_status: "draft"` no `state.json`,
  moveu o ticket para **Ag Merge**, preencheu "Apontamentos Desenvolvedor" e arquivou a task
  (`status: "committed"`, pasta em `memory/runs/_archive/`).
- No tick seguinte o watcher **remove os worktrees do ticket** (a branch local fica). Não
  remove se houver mudança não commitada no worktree, nem enquanto houver preview do dashboard
  no ar para o ticket.
- O polling de PRs grava o status do Bitbucket em `pull_request.<repo>.status`. Só "todos
  MERGED" muda o status da task (`fully_merged`). Um repo MERGED + outro DECLINED gera evento
  `escalation`.

**Ação:**

1. **Impeça o merge primeiro.** Se ainda está como Draft, ninguém faz merge por engano — deixe
   assim. Se alguém marcou como pronto, volte para Draft ou peça para não mergear no próprio PR.
2. Localize a task arquivada e os PRs:
   ```bash
   ls -d memory/runs/_archive/<ticket>-* .claude/worktrees/<ticket>/memory/runs/_archive/<ticket>-* 2>/dev/null
   jq '{status, pr_status, pr_id, pull_request, risk_level}' memory/runs/_archive/<task-id>/state.json
   ```
3. Escolha o caminho:

   **a) Corrigir em cima do mesmo PR (preferido — recomendação):** mova o ticket no Redmine
   para **Recusa QA** com uma nota explicando o que está errado e clique **"Corrigir recusa QA"**
   no dashboard. Esse é o caminho de retrabalho suportado: reaproveita o task-id, traz o run de
   volta pro worktree (recriado), injeta a nota no prompt e reentra em `implement`; o novo
   `/commit` empurra na mesma branch e o PR se atualiza sozinho. O worktree recriado liga
   a memória local ao checkout principal. Se a branch trouxer `spec/`, `decisions/` ou
   `flows/` versionados, preserva os diretórios e liga recursivamente só as entradas
   ausentes; arquivos e links existentes não são substituídos e `runs/` fica separado.
   O retry também copia, sem sobrescrever, os artefatos do ticket ainda ausentes
   (`*-spec.md`, `*-spec-changelog.json`, `*-ac-provenance.json`, `*-attachments/`).
   Spec ausente com `spec_hash`, falha de leitura ou erro no registro do rebaseline
   mantém o sinal e gera aviso explícito. Enquanto houver sinal pendente, o despacho
   normal também espera, mesmo com `node=implement`/`status=in_progress` do dashboard.
   O retry explícito registra a spec pós-commit como baseline, mantendo a versão.
   Se o changelog for um link de arquivo, sua gravação atômica usa o destino real
   no checkout principal e preserva o link no worktree. Repetir o mesmo rebaseline
   após falha na gravação do state não duplica o hash vigente no changelog.
   Se a spec sumir depois, o portão de drift restaura só quando o arquivo do
   checkout principal tem o mesmo `spec_hash` do Plan (evento `spec_restored`); hash diferente
   ou spec ausente nos dois continua `spec-drift`.

   **b) Correção manual rápida:** recrie o worktree (ou use outro checkout), faça checkout da
   branch `<ticket>`, corrija, commite e `git push` — o PR se atualiza. O `state.json`
   arquivado não precisa mudar.

   **c) Reexecutar a partir de um nó (replay):** gera um run **novo** (`replayOf`), sem tocar
   no original. Sempre rode primeiro com `--dry-run`:
   ```bash
   node "$PRISMA_ROOT/scripts/replay-cycle.js" --task <task-id> --from implement --dry-run
   ```
   *Comportamento a confirmar:* o replay reaproveita "o mesmo worktree"; como o worktree é
   removido logo após o PR abrir, confira no `--dry-run` se ele encontra o worktree antes de
   rodar de verdade.

   **d) Abortar de vez (o PR não deve existir):**
   1. No Bitbucket, **Decline** o PR em **cada** repo listado em `pull_request` (não existe
      script de decline neste repo — é pela UI ou API do Bitbucket). Declinar só um dos repos
      deixa a mudança pela metade.
   2. No Redmine, tire o ticket de "Ag Merge" para o status que o time usa para trabalho
      cancelado/a refazer (o watcher não reage a isso sozinho).
   3. Se a branch remota não deve mais existir: `git push origin --delete <ticket>` em cada
      repo — **só** se ninguém mais trabalha nela.
   4. O `state.json` arquivado fica como está (`committed`). Não reescreva histórico dele; se
      quiser registrar, acrescente uma entrada em `agent_log` com `"agent": "human"` e `note`.

**NÃO faça:**
- Não dê `git push --force` numa branch com PR aberto sem avisar quem está revisando.
- Não mova a pasta arquivada de volta para `memory/runs/` à mão para "reabrir" — o
  `status: "committed"` fora do arquivo vira `committed_nao_arquivada` e o watcher pula. Use
  Recusa QA (a) ou replay (c).
- Não coloque o ticket em **Aprovada** esperando um ciclo limpo: se o ticket foi alterado depois
  do commit, o watcher abre um `fetch_ticket` novo **na mesma branch `<ticket>`**, que já tem o
  código errado. *Comportamento a confirmar:* como o `/fetch-ticket` lida com a branch já
  existente e divergente.

---

### 4. Redmine e state.json dessincronizados

**Sintoma:** Redmine mostra **"Em Desenvolvimento"** (o nome real do status; não existe "Em
andamento" no fluxo) mas o `state.json` mostra `committed` — ou o contrário.

**Qual fonte é a verdade:** o **`state.json`** é a única fonte de verdade sobre o ciclo
(`memory/decisions/2026-09-29-remocao-status-yaml.md`). O status do Redmine é um *efeito
colateral* que os nós aplicam (`/fetch-ticket` → Em Desenvolvimento; `/commit` → Ag Merge) e
que **o watcher nunca reconcilia sozinho**. O watcher só *lê* o status do Redmine para: iniciar
ciclo (Aprovada/Recusa QA) e gravar `ticket_status`/`qa_rejection`. Reconciliar = ajustar o
Redmine para refletir o `state.json`, não o contrário.

**Caso A — Redmine "Em Desenvolvimento", `state.json` `committed`:**
o `/commit` terminou, mas a transição para Ag Merge não aconteceu. Causas documentadas em
`.claude/commands/commit.md` passo 7:
- PR **não** abriu (credenciais Bitbucket ausentes) → transição pulada de propósito.
- Redmine devolveu **422** exigindo campo customizado (achado no ticket #43425: "Necessita Lib.
  Plano", id 7).
- MCP do Redmine indisponível na sessão.

```bash
jq '{status, pull_request, pr_status, redmine_ticket}' memory/runs/_archive/<task-id>/state.json
grep -n -i "ag merge\|422\|redmine" memory/runs/<ticket>.log | tail -20
```

- Tem URL em `pull_request` → mova o ticket para **Ag Merge** manualmente no Redmine (preencha
  o campo obrigatório que ele pedir).
- **Não** tem URL → não houve PR: empurre/abra o PR à mão (os worktrees ficam intactos nesse
  caso) com `scripts/bitbucket-open-pr.sh`, grave a URL em `pull_request`, e só então mova para Ag
  Merge.

**Caso B — `committed` mas a pasta está em `memory/runs/` (não em `_archive/`):**
o watcher loga `status "committed" mas ainda em memory/runs/ (não arquivada)` e pula
(`committed_nao_arquivada`). O `/commit` morreu entre marcar e arquivar. Com o watcher parado,
mova a pasta:
```bash
mv .claude/worktrees/<ticket>/memory/runs/<task-id> .claude/worktrees/<ticket>/memory/runs/_archive/<task-id>
```
ou use o dashboard (`POST /api/runs/<task-id>/archive`), que faz o mesmo movimento dentro de
`memory/runs`.

**Caso C — Redmine "Ag Merge", `state.json` ainda não `committed`:**
típico de `commit` órfão (`needs_human_review`, cenário 1) ou `interrupted` durante o commit: o
PR abriu mas a sessão morreu antes de marcar `committed`.
```bash
jq '{status, node, pull_request, events: (.events[-5:])}' .claude/worktrees/<ticket>/memory/runs/<task-id>/state.json
```
Se o PR existe no Bitbucket, **não** redespache o commit (abriria PR duplicado / push repetido).
*Comportamento a confirmar:* não há rotina para "fechar" um commit parcial; o caminho seguro é,
com o watcher parado, completar à mão o que faltou (gravar `pull_request`/`pr_id`/`pr_status`,
`status: "committed"`, mover para `_archive/`).

**Caso D — Redmine "Aprovada", task local em andamento:** normal se alguém voltou o status à
mão; a task ativa continua sendo processada pelo `state.json`. Não é problema.

**NÃO faça:**
- Não "conserte" o `state.json` para bater com o Redmine (ex: trocar `committed` por
  `in_progress` porque o Redmine diz Em Desenvolvimento) — isso redespacha nós já concluídos.
- Não mova o ticket para Aprovada para "resincronizar" — pode abrir ciclo novo (cenário 3, d).

---

### 5. Codex falhando em todos os nós (problema de ambiente)

> **Atualização importante:** o Codex **não faz mais parte do fluxo** desde 2026-09-18
> (`memory/decisions/2026-09-18-remocao-codex-workflow.md`). Todo nó roda só com Claude Code
> (`claude -p`), sem fallback. `current_agent: "codex"` só aparece em tasks antigas. O cenário
> equivalente hoje é **o Claude falhando em todos os nós**. Se você ainda usa o Codex à mão,
> fora do watcher, os diagnósticos dele são *comportamento a confirmar*.

**Sintoma:** todos os ciclos das últimas horas param no mesmo ponto, sem avançar; eventos
`node_error` seguidos; ou todos os runs viram `session_limit`.

**Causas prováveis e como distinguir:**

| Causa | Como aparece | Ação do watcher |
|---|---|---|
| **Limite de uso/quota da conta** | Saída com `usage limit`, `rate limit exceeded`, `quota exceeded`, `session limit`, `429 too many requests` | Loga "Claude pareceu indisponível" e tenta de novo no próximo tick (e no seguinte...) |
| **Auth expirada** | `401 unauthorized`, `missing bearer` | Idem — repete até alguém logar de novo |
| **Estouro de contexto da sessão** (não é quota) | stderr com `context window`, `max_tokens`, `token limit` | `status: "session_limit"`, **não** redespacha |
| **CLI atualizado/quebrado ou fora do PATH** | `AVISO: binário \`claude\` não encontrado no PATH.`, ou exit code ≠ 0 imediato em todos os nós | `claude_indisponivel` / `node_error` |
| **Rede** | Erros de conexão na saída do agente; as chamadas do watcher ao Redmine também começam a ser repetidas/falhar (cenário 2 C) | Redmine: retry com backoff. Agente: *comportamento a confirmar* (sem assinatura específica no código) |

Atenção: a detecção por texto (`looksUnavailable`/`looksLikeSessionLimit`) só funciona em modo
`--follow`. No modo normal (laço do dashboard) o agente roda destacado — o que você vê é o
`state.json` não avançar e eventos `node_end`/`node_error` com `exit_code`. Por isso, olhe o log
do ticket.

**Diagnóstico:**

```bash
# 1. Mesma falha em vários tickets? Procure as assinaturas nos logs recentes
grep -l -i -E 'usage limit|rate limit exceeded|quota exceeded|session limit|429 too many|401 unauthorized|missing bearer' memory/runs/*.log
grep -h -i -E 'usage limit|rate limit|quota|401|context window|max_tokens|token limit' memory/runs/*.log | tail -20

# 2. Últimos eventos de erro de cada task ativa
find .claude/worktrees -path '*/memory/runs/*/state.json' -not -path '*/_archive/*' \
  | xargs -I{} jq -r '[.task_id, ((.events // []) | map(select(.type=="node_error" or .type=="node_end")) | last | "\(.type) \(.node) exit=\(.exit_code) \(.ts // .at)")] | @tsv' {}

# 3. O CLI está OK neste ambiente?
command -v claude && claude --version
claude -p "responda apenas: ok"      # consome uma chamada; exit 0 + "ok" = conta/auth/rede ok

# 4. Consumo recente (ledger de custo por ticket)
ls -t memory/runs/*-cost.json | head -5 | xargs -I{} jq -c '{file: "{}", totals}' {}
```

Não há comando no repo para consultar a quota restante da conta — *comportamento a
confirmar*; o sinal prático é a mensagem de limite na saída (passo 1) ou o teste do passo 3.

**Ação por causa:**
- **Quota/limite:** pare o laço do watcher (Stop no dashboard) até o limite resetar — senão cada
  tick redespacha e falha de novo, gerando ruído. Depois, Start. As tasks estão em `in_progress`
  e continuam de onde pararam.
- **Auth:** rode `claude` interativamente no mesmo usuário/terminal e refaça o login; depois
  Stop/Start do watcher.
- **CLI quebrado após atualização:** confirme com `claude --version` e o teste do passo 3. Volte
  para a versão anterior pelo mesmo gerenciador que instalou (*comportamento a confirmar* — o repo
  não fixa versão do CLI). Reinicie o **dashboard** se o `PATH` mudou.
- **`session_limit` em massa:** retome cada run pelo dashboard (botão de retomada /
  `POST /api/runs/<task-id>/resume-session`, máx. 3 por run). Se o mesmo nó estoura de novo, o
  `context.md` está grande demais: veja `templates/context-summarization.md`.
- **Rede:** confira o teste do Redmine (cenário 2) e o passo 3; espere voltar.

**NÃO faça:**
- Não deixe o laço rodando durante um bloqueio de quota "para ver se volta" — é tick falhando a
  cada 60 s.
- Não troque `status` de `session_limit` para `in_progress` à mão só para destravar: o dashboard
  controla `resume_count`/`session_interrupted`; editar direto pula esse controle.
- Não reative o Codex como fallback editando `memory/project.yaml > agentes_workflow` — o
  watcher não tem mais esse código.

---

### 6. memory/runs/ crescendo descontroladamente / disco cheio

**O que realmente ocupa espaço:** em geral **não** é `memory/runs/`, e sim os worktrees. Medido
em 2026-09-29: `memory/runs/` ≈ 3,4 MB; `.claude/worktrees/` ≈ 1,5 GB (cada worktree é um
checkout completo + `target/` do Maven).

**Verifique o que está usando espaço:**

```bash
df -h .
du -sh memory/runs memory/runs/_archive .claude/worktrees 2>/dev/null
du -sh .claude/worktrees/* 2>/dev/null | sort -h | tail -10
du -sh .claude/worktrees/*/target 2>/dev/null | sort -h | tail -10
ls -lhS memory/runs/*.log | head -10                     # log por ticket — só cresce, sem rotação
find memory/runs .claude/worktrees -name 'state.json.corrupted-*' 2>/dev/null   # backups de corrupção
find memory -name '*.tmp' 2>/dev/null                     # sobras de escrita atômica interrompida
git worktree list
```

**O que o sistema já limpa sozinho:**
- Worktrees do ticket: removidos pelo watcher **depois do PR aberto** (e, o que sobrar, depois do
  merge). Ficam se: houve mudança não commitada, preview do dashboard no ar, outra task do ticket
  andando, ou `WORKTREE_CLEANUP_ON_PR_OPEN=0`. Falhas ficam em `worktrees_cleanup_errors` no
  `state.json`.
- Nada mais. **Não existe rotina automática** que apague runs arquivados, logs `<ticket>.log` ou
  `*-cost.json`.

**Cleanup manual (seguro, do maior ganho para o menor):**

1. **Worktrees de tasks já finalizadas** (status `committed`/`fully_merged` com PR):
   ```bash
   git worktree list
   git -C .claude/worktrees/<ticket> status --short          # tem que estar vazio
   git worktree remove .claude/worktrees/<ticket>             # sem --force
   git worktree prune
   ```
   Repita para os irmãos (`.claude/worktrees/<ticket>-<repo>` e `../<repo>/.claude/worktrees/<ticket>`,
   no repo dono de cada um).
2. **`target/` de worktrees ainda ativos:** `rm -rf .claude/worktrees/<ticket>/target` (o próximo build
   recompila).
3. **Logs grandes de tickets finalizados:** compacte fora do repo em vez de apagar:
   ```bash
   mkdir -p ~/graph-logs-backup && gzip -c memory/runs/<ticket>.log > ~/graph-logs-backup/<ticket>.log.gz && : > memory/runs/<ticket>.log
   ```
4. **Runs arquivados antigos:** exporte antes, depois compacte fora do repo:
   ```bash
   node "$PRISMA_ROOT/scripts/export-runs.js" --output ~/graph-logs-backup/runs-$(date +%F).json --pretty
   tar -czf ~/graph-logs-backup/archive-$(date +%F).tgz memory/runs/_archive
   ```
   Só remova do `_archive/` depois disso, e **mantenha o run arquivado mais recente de cada
   ticket** (ver "NÃO faça").

**NÃO faça:**
- Não apague `memory/runs/_archive/<task-id>` do último ciclo de um ticket: o watcher usa o
  arquivado mais recente para decidir `ja_tratado_neste_ciclo`. Sem ele, um ticket que ainda
  esteja em Aprovada/Recusa QA vira **ciclo novo** (novo `fetch_ticket`). O registro de critérios
  de aceite, o knowledge graph, o replay e o export também leem de lá.
- Não apague pastas de tasks **ativas** (fora de `_archive/`) nem o `state.json` delas: sem
  `state.json` o watcher não enxerga a task e pode abrir `fetch_ticket` por cima do worktree.
- Não use `git worktree remove --force` num worktree com mudança não commitada sem saber de onde
  ela veio.
- Não apague `memory/runs/watcher-runtime.json` com o watcher rodando (é o que o health-check lê).

---

### 7. state.json corrompido (status: state_corrupted)

**Sintoma:** task com `status: "state_corrupted"`; comentário `[Watcher]` no ticket dizendo
"state.json inválido"; log `[state-error] Task <task-id>: state.json inválido — ...`.

**Causa:** o watcher valida todo `state.json` contra `.graph/schemas/state.schema.json`
(`scripts/validate-state.js`) ao ler. Falhou (JSON truncado, campo obrigatório faltando, tipo ou
valor fora do enum — ex: `status: "cancelled"`, que **não existe** no schema) → o watcher:
- se o JSON estava ilegível: copia o original para `state.json.corrupted-<timestamp>` e reescreve
  um `state.json` mínimo (`node: "escalated"`, `history: []`);
- se o JSON era legível: mantém o conteúdo;
- em ambos: grava `status: "state_corrupted"` + `state_error` (`reason`, `errors`,
  `previous_status`, `backup`) + evento `node_error`, e **nunca mais redespacha** até um humano
  trocar o status.

**Inspecionar:**

```bash
F=.claude/worktrees/<ticket>/memory/runs/<task-id>/state.json
jq '.state_error' "$F"
jq '.events[-5:]' "$F"
ls -l "$(dirname "$F")"/state.json.corrupted-* 2>/dev/null
# validar contra o schema (precisa de `npm install` em scripts/ uma vez, para o ajv)
node "$PRISMA_ROOT/scripts/validate-state.js" "$F"
```

**Quando é seguro editar à mão:**
- ✅ O laço do watcher está **parado** e não há agente vivo na task (`ps -p <agent_pid>`).
- ✅ Os erros são pontuais e claros em `state_error.errors` (enum errado, campo com tipo errado,
  campo obrigatório faltando — `task_id`, `node`, `history`, `status`).
- ✅ Há backup legível em `state_error.backup` para restaurar.

Passos:
1. Pare o watcher (ver "Como interromper").
2. Faça uma cópia: `cp "$F" "$F.manual-$(date +%s)"`.
3. Corrija o campo apontado — ou restaure do backup `state.json.corrupted-*` e corrija nele.
4. Volte `status` para o valor certo: normalmente `state_error.previous_status`; se era
   `running`, use `in_progress`.
5. **Apague o campo `state_error`.**
6. Valide: `node "$PRISMA_ROOT/scripts/validate-state.js" "$F"` → sem saída e exit 0.
7. Inicie o watcher.

**Quando NÃO é seguro (pare e peça ajuda / use replay):**
- ❌ Não há backup e o `state.json` foi reescrito no mínimo (`history: []`, `node: "escalated"`) —
  você não sabe em que nó a task estava. Reconstrua a partir de `handoff.md`, `context.md` e
  `memory/runs/<ticket>.log`, ou abandone o run e use `scripts/replay-cycle.js` (recusa runs
  `state_corrupted` — corrija primeiro o mínimo para passar no schema).
- ❌ O agente ou o watcher estão rodando.
- ❌ A corrupção se repete logo depois de corrigir — algum agente/comando está gravando formato
  errado; investigue o log do ticket antes de editar de novo.

**NÃO faça:**
- Não apague o `state.json` "para recomeçar" — ver cenário 6.
- Não apague nem reescreva `events` e `agent_log` (são append-only; o dashboard e o cost-tracking
  leem deles).
- Não troque o status para `in_progress` deixando `state_error` no arquivo.

---

### 8. Browser test / Playwriter não consegue acessar a aplicação

> **Comportamento a confirmar:** não há nenhuma referência a Playwriter, Playwright ou "browser
> test" nos comandos do grafo (`.claude/commands/test.md`, `verify.md`), no watcher, no dashboard
> ou em `memory/`. O `/test` deste repo roda `mvn test` (escopado por `affectedServices`). Se os
> browser tests rodam por outra ferramenta/ambiente, documente aqui quem os dispara e onde fica o
> resultado `SKIPPED`. O que segue é o que dá para verificar com o que existe no repo.

**Sintoma:** todos os browser tests retornam `SKIPPED`.

**Causa provável:** a aplicação não está no ar na porta esperada (back Quarkus em **8080**,
`quarkus.http.port` em `src/main/resources/application.properties`; front do preview em **9000**).

**Ação:**

1. Algo escuta nas portas?
   ```bash
   lsof -nP -iTCP:8080 -sTCP:LISTEN
   lsof -nP -iTCP:9000 -sTCP:LISTEN
   ```
2. O back responde? (`smallrye-health` está no `pom.xml`, então `/q/health` existe)
   ```bash
   curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:8080/q/health
   curl -s http://localhost:8080/q/health | jq
   ```
3. Subir a aplicação do ticket pelo preview do dashboard (back + front do worktree):
   ```bash
   curl -s -X POST localhost:3333/api/preview/<ticket>/start | jq
   curl -s localhost:3333/api/preview/<ticket>/status | jq
   curl -sN localhost:3333/api/preview/<ticket>/log-stream      # log do build/boot
   ```
   Portas configuráveis por `PREVIEW_BACK_PORT`/`PREVIEW_FRONT_PORT` no `.env`. Se a porta estiver
   ocupada, o preview recusa com `porta em uso (...)`.
4. Teste manual: abra `http://localhost:9000` no navegador e percorra o fluxo descrito em
   "Como chegar no ponto do Desenvolvimento?" nos Apontamentos do ticket.
5. Ao terminar: `curl -s -X POST localhost:3333/api/preview/<ticket>/stop`.

**NÃO faça:**
- Não mate o processo que está na 8080 sem saber de quem é — pode ser o back principal de outro
  dev/sessão (`lsof` mostra o comando).
- Não deixe o preview no ar à toa: enquanto ele estiver ativo, o watcher **adia** a limpeza dos
  worktrees do ticket.

---

## Autorização humana (ação privilegiada, SQL governado, devolução ao QA)

Caso que originou (#42359): o `/implement` concluiu que a Recusa QA era do **banco** (check
constraint sem `SERVICO_ADICIONAL`; o SQL já estava versionado) e só podia parar em `blocked`
com o motivo em texto. Agora o agente registra um **pedido estruturado** e um **aprovador
cadastrado** decide no dashboard, escolhendo o banco.

### Uma vez por máquina: bancos

> **Sem aprovador nem senha desde 2026-11-06.** Decisão do Richard: "se eu tenho acesso ja posso executar", até existirem roles.
> - Quem tem acesso ao Dashboard decide.
> - O acesso continua limitado a `localhost`: Host local e, quando vier, Origin local **na mesma porta do Dashboard**. Escrita com `Sec-Fetch-Site` diferente de `same-origin`/`none` é recusada. Isso barra páginas de terceiros, outras páginas do próprio localhost (outra porta) e DNS rebinding.
> - A autoria gravada (`by`) é o usuário do sistema operacional que roda o Dashboard.
> - O passo 1 abaixo (`approvers.js add`) não é mais necessário. A lib `scripts/lib/approvers.js` continua no repo para quando houver roles.
> - O risco que isso abre está em **Limite que sobra**, no fim da seção.

Tudo fica em `~/.config/prisma/` (dono = você, diretório 700, arquivos 600, sem symlink — se
não estiver assim, o dashboard recusa) e no Keychain. **Nada** disso é lido do `.env` do
consumidor ou de variável de ambiente: um agente escreve no worktree, no `state.json` e no `.env`.

```bash
# 1. (Não é mais necessário desde 2026-11-06: o Dashboard não pede aprovador.)

# 2. Banco do QA a partir do .properties do app-back (ISO-8859-1/CRLF; só o datasource padrão,
#    os nomeados como "portal" ficam de fora). Mostra host/banco/usuário mascarados e pede
#    confirmação; a senha vai DIRETO para o Keychain pelo stdin do `security -i`
#    (nunca em argv, na tela ou em arquivo temporário):
cd ~/Workspace/app-back
node "$PRISMA_ROOT/scripts/lib/db-targets.js" add qa-app \
     --from-properties=src/main/resources/application.properties --env=qa --label="QA – embarc_db_stage"
#    (datasource nomeado: --datasource=portal). Sem o .properties: add qa-app --host= --db= --user= --env=qa
#    e o macOS pede a senha.
node "$PRISMA_ROOT/scripts/lib/db-targets.js" check qa-app     # item existe no Keychain (não lê a senha)
node "$PRISMA_ROOT/scripts/lib/db-targets.js" list             # alias, rótulo, ambiente
# trocar a senha: db-targets.js secret qa-app · tirar: db-targets.js remove qa-app
```

- **Atenção (app-back):** use o `application.properties` (`192.168.10.234/embarc_db_stage`). O
  `application-qa.properties` aponta para `embarc_db_production` nesse mesmo host, um banco que **não
  existe** lá: o cadastro passaria, mas a execução falharia na conexão.
- **Keychain com ACL vazia:** o item é criado com `-T ''`, então **cada** leitura (cada execução
  aprovada) mostra o diálogo do macOS "security quer usar a informação confidencial prisma-db-qa-app".
  Clique **Permitir**, nunca **Sempre Permitir**: isso põe o `security` na ACL e qualquer processo seu
  passa a ler a senha sem perguntar. O diálogo é a confirmação física que um agente com shell não
  consegue dar. Sem sessão gráfica (SSH), a leitura falha e nada executa.
- O segredo é lido só pelo processo filho do db-effect (`scripts/lib/db-exec-child.js`, por
  `/usr/bin/security`), na hora de executar. O filho conecta pelo driver `pg` (senha no objeto de
  conexão, nada em env/argv) e devolve as saídas sem senha, usuário, host nem banco.
- Produção (`env` contendo `prod`, `prd` ou `live`, ou `production: true`) não é selecionável sem
  `allow_production: true` na entrada (`--allow-production`). O nome do banco não decide — `--env` decide.
- Desde 2026-11-06 não há cadastro de aprovador: as ações privilegiadas não pedem senha.

### Fluxo

1. **Pedido** — o agente roda `node "$PRISMA_ROOT/scripts/lib/authorization.js" request memory/runs/<task-id> --input=<pedido.json>` (esqueleto: `template`). O run vai para `authorization-pending` com o sha256 do `.sql`, o `verify_sql` (só leitura), o esperado, o `then` (`handback_qa` ou `resume:<nó>`) e, no máximo, um `target_hint` — o agente **sugere**, não escolhe o banco. O watcher pula a task (`status_authorization_pending`), **não** passa mensagem livre pelo intérprete e comenta no Redmine uma vez.
2. **Decisão** — no detalhe do run, caixa "🔐 Autorização": clique **Carregar bancos** (alias, rótulo, ambiente, host/banco mascarados — `"display": "visible"` na entrada mostra). Confira o SQL e o hash e:
   - A caixa mostra o ticket (derivado do task-id, não do `state.json`), o SQL **integral** (sem redação; acima de 200 KB bloqueia em vez de truncar), as checagens que recusaram algo, a nota da devolução ao QA (quando `then` é `handback_qa`) e o **hash do pedido** para o banco escolhido.
   - **Aprovar e executar** (escolhendo o banco): o servidor recalcula o hash do pedido (ticket, artefato + sha256, `verify_sql`, `expected_contains`, `then`, banco) e recusa com `REQUEST_CHANGED` se algo mudou desde a tela; congela a cópia aprovada (com o SQL) em `~/.config/prisma/approved/` e executa **essa** cópia: `verify_sql` antes numa conexão `default_transaction_read_only=on`, o artefato em **uma** transação aberta pelo Node (um comando por mensagem do protocolo estendido; `statement_timeout=60s`/`lock_timeout=5s` fixos na conexão), `verify_sql` depois. Saídas em `memory/runs/<task-id>/authorization/<AUTH-NNN>/` (`pre.txt`, `apply.txt`, `post.txt`, `result.json`). Cada execução é um Attempt DOM06 `db-effect` em `dom06/attempts/`.
   - O artefato é conferido por um tokenizer SQL (strings, `E'…'`, `$tag$…$tag$`, `"…"`, comentários aninhados): recusa `\` fora de literal, `BEGIN/COMMIT/ROLLBACK/END/SAVEPOINT/RELEASE/ABORT/PREPARE TRANSACTION`, `SET/RESET` de `*_timeout`/`ROLE`/`SESSION AUTHORIZATION`, `set_config`, `CONCURRENTLY`, `VACUUM`, `COPY` e afins. O `verify_sql` precisa ser **um** comando só leitura.
   - **Recusar**: volta para `blocked` com o motivo; "Responder ao agente" segue valendo.
   - **Já apliquei manualmente**: registra quem; com banco escolhido, roda só o `verify_sql` para conferir; depois segue o mesmo `then`.
   - `authorization_history` (append-only) registra quem decidiu (usuário do sistema operacional que roda o Dashboard), o alias escolhido e o horário — nunca o segredo. O alvo executado é o aprovado: trocar o alias depois exige nova aprovação (`TARGET_CHANGED`).
3. **Desfecho** — sucesso com `then: "resume:<nó>"` → `in_progress` no nó. Com `then: "handback_qa"` → devolução ao QA (abaixo). Falha certa (transação desfeita, alvo recusado, hash mudou, segredo ausente) → `blocked`, fase `failed`. Resultado **incerto** (conexão caiu no meio, timeout) → `blocked`, fase `uncertain`: o Prisma **não** repete; confira no banco e use "Já apliquei manualmente" (ou Recusar).

**Devolver ao QA sem código** (botão "↩ Devolver ao QA" em run `blocked`/`authorization-pending`, sem aprovador desde 2026-11-06; ou automático pelo `then`): nenhum agente é despachado. PUT governado no Redmine (Attempt DOM06 `handback_qa`, header `X-Redmine-API-Key`): status **Ag Teste** (`REDMINE_STATUS_AG_TESTE`, padrão 8), nota com o resumo (alvo/hora do SQL) e "Apontamentos Desenvolvedor" (`REDMINE_CF_APONTAMENTOS_ID`, padrão 2) — os dois textos são editáveis antes de confirmar. Só com o Redmine confirmando o run é arquivado em `<raiz do run>/_archive/` com `status: "handed_back_qa"` (sem entrar no `dashboard-archived.json`, como o arquivamento do `/commit`). 422 → mensagem com o campo exigido; qualquer falha **não** arquiva e o run fica `blocked`. Resultado incerto (5xx/rede) → o próximo clique reaproveita o `operation_id` e confere o marcador `[op handback:<id>]` nos journals antes de repostar. Nova Recusa QA depois: o watcher pula com `recusa_qa_aguardando_retry` e "Corrigir recusa QA" restaura o run arquivado (fluxo normal).

**Run bloqueado antes desta feature (registrar o pedido retroativamente)** — com o watcher **parado** e nenhum agente vivo no run, da raiz do worktree do ticket (o `.sql` é procurado no worktree e, se não estiver, no checkout principal):

```bash
cat > /tmp/pedido.json <<'JSON'
{ "kind": "db_migration", "summary": "<o que e por quê>", "target_hint": { "alias": "<alias sugerido>", "datasource": "app", "env": "qa" },
  "artifact": "docs/migrations/<arquivo>.sql", "verify_sql": "SELECT ...", "expected": "<o que deve aparecer>",
  "expected_contains": "<texto>", "then": "handback_qa", "requested_by": "implement" }
JSON
STATE_EXECUTION_ID= node "$PRISMA_ROOT/scripts/lib/authorization.js" request memory/runs/<task-id> --input=/tmp/pedido.json   # exit 4 = registrado
```

**Limite que sobra (atualizado em 2026-11-06, sem aprovador):** o dashboard continua sem login e só
aceita localhost, o que barra visitante de página de terceiros. Com a senha de aprovação removida,
**nada mais impede "aprovação por texto"**: um processo do mesmo usuário (inclusive um agente
despachado pelo watcher) pode chamar a API local e decidir sozinho.
- A **execução de SQL** ainda exige a confirmação física do diálogo do Keychain ("Permitir").
- **Já apliquei manualmente**, **Recusar**, **Devolver ao QA** (que escreve no Redmine) e o
  **override de roteamento** não têm mais barreira física.
- Isso vale até existirem roles.

O texto anterior, mantido para o histórico: a senha de aprovação impedia
visitante da página e aprovação por texto; a config fora do repo impede quem só escreve no
worktree/`state.json`/`.env`; o Keychain com ACL vazia impede leitura silenciosa da senha. Mas, sem
sandbox ou usuário do SO separado para os agentes, um processo do **mesmo usuário** com shell livre
continua podendo escrever em `~/.config/prisma` (cadastrar aprovador/alvo) e falar com o dashboard.
**Proteção definitiva recomendada:** rodar o dashboard (e `~/.config/prisma`, o Keychain) com **outro
usuário do macOS**, ou os agentes num sandbox sem acesso a `~/.config/prisma` e sem `security`.

**NÃO faça:** gravar `pending_authorization`/`authorization_history` à mão; aprovar por mensagem ("aprovado" no chat ou no Redmine não aprova nada); colocar senha na allowlist, no pedido ou em argv; dar `allow_production: true` "para testar".

---

## Comandos úteis de diagnóstico

Todos da raiz do consumidor, com PRISMA_ROOT explícito. Substitua `<ticket>` (ex: `43670`) e `<task-id>` (ex:
`43670-rastreabilidade-spec`).

```bash
# --- Watcher / laço ---
curl -s localhost:3333/api/watcher/status | jq
curl -s localhost:3333/api/watcher/health | jq
node "$PRISMA_ROOT/scripts/readmine-watcher.js" --health-check | jq
curl -sN localhost:3333/api/watcher/log-stream
jq '.[-20:]' dashboard/watcher-history.json                  # start/stop/crash/restart_limit
jq . memory/runs/watcher-runtime.json                        # pid, activeCycle, lastCompletedCycle, nextPollAt
jq '.last_tick_at, .tickets' memory/runs/watcher-state.json  # decisão do último tick por ticket
cat dashboard/watcher.pid 2>/dev/null                        # pid do tick em curso (só existe durante o tick)

# --- Simular sem efeitos ---
# --dry-run (argv): tick real só de leitura (Redmine/Bitbucket só GET). Nada muda em memory/ (runs,
# archive, spec, knowledge graph, registro de ACs, patterns, consolidator-state, watcher-state/runtime,
# .watcher-mode) nem nos worktrees; o que despacharia/gravaria sai como "[dry-run] ...". Não confundir
# com DRY_RUN=true (env), que simula um ciclo inteiro com ticket fictício e grava o run de teste.
node "$PRISMA_ROOT/scripts/readmine-watcher.js" --dry-run
node "$PRISMA_ROOT/scripts/readmine-watcher.js" --dry-run --ticket=<ticket>

# --- Tasks / state.json ---
find memory/runs .claude/worktrees -path '*/memory/runs/*/state.json' -not -path '*/_archive/*' 2>/dev/null
jq '{status, node, history, retries, node_started_at, agent_pid, updated_at}' .claude/worktrees/<ticket>/memory/runs/<task-id>/state.json
jq '.status' .claude/worktrees/<ticket>/memory/runs/<task-id>/state.json
jq '.events[-10:]' .claude/worktrees/<ticket>/memory/runs/<task-id>/state.json
jq '.agent_log[-3:]' .claude/worktrees/<ticket>/memory/runs/<task-id>/state.json
grep -l '"status": "running"' .claude/worktrees/*/memory/runs/*/state.json memory/runs/*/state.json 2>/dev/null
node "$PRISMA_ROOT/scripts/validate-state.js" .claude/worktrees/<ticket>/memory/runs/<task-id>/state.json
curl -s localhost:3333/api/runs | jq                         # visão do dashboard

# --- Logs de ticket / agente ---
tail -f memory/runs/<ticket>.log
grep -n '\[watcher\]' memory/runs/<ticket>.log | tail -20
ls -t memory/runs/*.log | head

# --- Processos ---
ps -Ao pid,etime,command | grep -E 'readmine-watcher|claude -p|dashboard/server' | grep -v grep
ps -p <agent_pid> -o pid,etime,command

# --- Worktrees / git ---
git worktree list
git -C .claude/worktrees/<ticket> status --short
git -C .claude/worktrees/<ticket> log --oneline -5
git ls-remote --heads origin <ticket>

# --- PRs ---
jq '.pull_request, .pr_status, .pr_id' memory/runs/_archive/<task-id>/state.json
jq . memory/runs/pr-status-poll.json

# --- Claude CLI / custo ---
command -v claude && claude --version
jq '.totals' memory/runs/<ticket>-cost.json

# --- Disco ---
du -sh memory/runs memory/runs/_archive .claude/worktrees
du -sh .claude/worktrees/* | sort -h | tail
```

Nunca rode `cat .env` ou `env` numa sessão compartilhada/gravada — imprime os secrets. Para testar
credenciais, use o padrão `( set -a; . ./.env; set +a; curl ... )` do cenário 2, que não os imprime.

---

## Como interromper o ciclo de uma task específica

**Não existe status `cancelled`.** O schema não tem esse valor — gravar `"status": "cancelled"`
faz a task virar `state_corrupted` no próximo tick. Os jeitos válidos de parar uma task são
**pausar** (`blocked`) ou **arquivar**.

1. **Pare o laço do watcher** (evita que um tick redespache enquanto você mexe):
   ```bash
   curl -s -X POST localhost:3333/api/watcher/stop | jq '{state}'
   ```
   Isso **não** mata agentes já despachados (eles rodam destacados).
2. **Se há agente rodando na task, encerre-o:**
   ```bash
   jq '{agent_pid, agent_started_at, node}' .claude/worktrees/<ticket>/memory/runs/<task-id>/state.json
   ps -p <agent_pid> -o pid,lstart,command    # o lstart tem de bater com agent_started_at; o texto do comando só confere
   kill <agent_pid>                            # SIGTERM; o wrapper tenta liberar o lease ao sair
   ```
   Espere alguns segundos e confira se `status` voltou para `in_progress`. *Comportamento a
   confirmar:* se o release roda com o agente morto por sinal; se continuar `running`, siga para o
   passo 3 do mesmo jeito.
3. **Escolha:**

   **Pausar (retomável):** edite o `state.json` e grave `"status": "blocked"`, acrescentando em
   `agent_log` um registro do que você fez:
   ```json
   { "agent": "human", "at": "2026-09-29T22:00:00Z", "note": "Pausado manualmente: <motivo>" }
   ```
   O watcher vai pular a task (`status_blocked`) e **comentar no Redmine uma única vez** que ela
   precisa de intervenção. Para retomar: `"status": "in_progress"` (o nó em `node` é redespachado).

   **Encerrar (tirar do fluxo):** arquive pelo dashboard:
   ```bash
   curl -s -X POST localhost:3333/api/runs/<task-id>/archive -H 'Content-Type: application/json' -d '{"force": true}' | jq
   ```
   Isso move a pasta para `memory/runs/_archive/` (reversível por
   `POST /api/archive/<task-id>/restore`). **Também** tire o ticket de Aprovada/Recusa QA no
   Redmine — senão, se o ticket for alterado depois, o watcher abre ciclo novo.
4. Valide e religue:
   ```bash
   node "$PRISMA_ROOT/scripts/validate-state.js" <caminho do state.json, se ainda ativo>
   curl -s -X POST localhost:3333/api/watcher/start | jq '{state}'
   ```

**NÃO faça:**
- Não use `status` fora do enum (`cancelled`, `aborted`, `paused`...).
- Não apague a pasta da task nem o worktree para "cancelar".
- Não edite com o laço ligado.
- Não interrompa um nó `commit` no meio sem conferir depois branch remota e PR (cenário 1, passo 5).

---

## Trava de instância (um writer por REPO_PATH)

Dois watchers no mesmo consumidor (fonte e candidata, dois laços, um cron no meio de um laço)
não podem gravar `memory/runs` ao mesmo tempo. A trava é adquirida no começo de `main()`,
antes de custo pendente, syncs e recuperação de órfão.

| | |
|---|---|
| Caminho | `<REPO_PATH>/.git/prisma-watcher.lock` quando `.git` é diretório. Se `.git` for arquivo (worktree git) ou não existir, `/tmp/prisma-watcher-<hash do REPO_PATH>.lock`. Nunca dentro de `memory/`. |
| Dono | pid + início do processo (`ps -o lstart=`). Pid reciclado não segura a trava. |
| Segundo writer | Não grava nada. Mensagem em stderr e exit **75**. Vale para tick único, `--ticket` e laço do dashboard. |
| Trava velha | Processo morto (ou pid reciclado) é retomada no próximo start, sem apagar à mão. |
| `--dry-run` | Não adquire trava e não cria arquivo. `DRY_RUN=true` (simulação) trava, mas o arquivo continua fora de `memory/`. |
| Laço do dashboard | Segura a trava do Start ao Stop, inclusive entre ticks, e passa o token ao tick filho. |

```bash
node "$PRISMA_ROOT/scripts/lib/watcher-lock.js" status --repo="$REPO_PATH"
# exit 0 = nenhum watcher e nenhum agente destacado vivo; exit 1 = algum dos dois
```

`pgrep` mostra processos; não substitui esse status. Agente destacado vivo aparece na mesma
saída (pid + `agent_started_at`). Enquanto ele existir, não mova o checkout do Prisma: o
wrapper libera o lease chamando `scripts/lib/node-lease.js` desse checkout.

---

## Como reiniciar o watcher de forma segura

**Como o Stop funciona:** o dashboard manda SIGTERM ao tick em curso. Se o tick está conduzindo
um nó em primeiro plano, o shutdown graceful (`scripts/lib/graceful-shutdown.js`) marca a task
como `interrupted`, comenta no Redmine e sai (até `GRACEFUL_TIMEOUT_MS`, padrão 10 s; depois
SIGKILL). Entre ticks o Stop é instantâneo. **Agentes destacados continuam rodando** — o Stop não
os mata.

### Antes

```bash
# 1. Estado atual e o que está rodando
curl -s localhost:3333/api/watcher/status | jq '{state, phase, error, next_tick_at}'
node "$PRISMA_ROOT/scripts/readmine-watcher.js" --health-check | jq '{status, activeCycle, healthy, issues}'
ps -Ao pid,etime,command | grep -E 'readmine-watcher|claude -p' | grep -v grep   # checagem visual; a garantia é a trava
node "$PRISMA_ROOT/scripts/lib/watcher-lock.js" status --repo="$REPO_PATH"

# 2. Pré-requisitos do próximo tick
test -f .env && echo ".env ok"
command -v claude && claude --version
( set -a; . ./.env; set +a; curl -s -o /dev/null -w 'Redmine HTTP %{http_code}\n' -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/users/current.json" )
```

- Prefira reiniciar com `phase: "idle"` (entre ticks) — assim nenhuma task vira `interrupted`.
- Se o motivo do restart foi `restart_limit_reached`, ache e corrija a causa no log-stream antes.

### Reiniciar

Só o laço (dashboard continua no ar):
```bash
curl -s -X POST localhost:3333/api/watcher/restart | jq '{state, error}'
```

Dashboard inteiro (necessário se mudou o `PATH` ou o código do dashboard):
```bash
# Ctrl+C no terminal do dashboard (mata também o tick em curso), depois:
cd dashboard && npm start          # http://localhost:3333
# no navegador ou:
curl -s -X POST localhost:3333/api/watcher/start | jq '{state}'
```
Se o dashboard morreu com um tick vivo, ele detecta o watcher órfão pelo `dashboard/watcher.pid`
e o encerra no próximo Start.

### Depois

```bash
# 1. Laço rodando e tick acontecendo
curl -s localhost:3333/api/watcher/status | jq '{state, ticks, restarts_last_hour, error}'
jq '.last_tick_at' memory/runs/watcher-state.json          # deve ficar recente (≈ 1 min)

# 2. Recuperação de órfãos e decisões do primeiro tick
curl -sN localhost:3333/api/watcher/log-stream               # procure [recovery] e "Tick concluído: N ticket(s)"

# 3. Tasks que ficaram interrupted pelo Stop
grep -l '"status": "interrupted"' .claude/worktrees/*/memory/runs/*/state.json 2>/dev/null
```

Para cada task `interrupted`: com o laço parado, grave `"status": "in_progress"` no `state.json`
(o nó em `activeNodeAtInterruption`/`node` é redespachado) e religue.

**NÃO faça:**
- Não use `kill -9` no tick: pula o shutdown graceful e deixa a task em `running` até a recuperação
  de órfão (imediata se houver `agent_pid` morto; até 60 min se não houver).
- Não suba um segundo dashboard (ou um cron com `readmine-watcher.js`) com outro já no ar.
  A trava de instância recusa o segundo: ele não grava nada e sai com código 75. `pgrep` antes
  do tick é checagem, não a garantia — a garantia é `node "$PRISMA_ROOT/scripts/lib/watcher-lock.js" status`.
- Não reinicie em loop "para ver se destrava" — a partir de 3 crashes por hora o laço para sozinho.
