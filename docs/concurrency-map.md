> Candidata extraída PRI-60. Os exemplos/histórico de app-back neste documento
> identificam a origem, não configuram o consumidor atual. Consulte docs/consumption.md
> e docs/extraction-paths.md: comandos de plataforma em PRISMA_ROOT, cwd/REPO_PATH
> e configuração/estado no consumidor. Nenhum procedimento de recovery/cutover
> é autorizado por esta cópia. A fonte histórica continua atribuída no manifesto.

# Mapa de concorrência do state.json

Watcher, agentes (nós `/plan`…`/commit`), dashboard, replay, resume-session, aprovação
humana e aprovação de SPEC_CHANGE leem e gravam o mesmo `memory/runs/<task-id>/state.json`.
Este documento diz como cada operação é protegida contra avançar o estado a partir de uma
leitura obsoleta.

| Peça | Arquivo | Papel |
|---|---|---|
| Writer | `scripts/state-writer.js` | único que grava `state.json`: lock, escrita atômica, `state_version`, merge de 3 vias, limpeza de órfãos, CLI dos agentes |
| CAS | `scripts/cas.js` | único que compara expectativas (versão, nó, spec_hash, execution_id, operation_id) com o disco; `CASError`; auditoria |
| Auditoria | `logs/state-conflicts.jsonl` (checkout principal, fora do git) | um evento por conflito, append-only |
| Dashboard | `GET /api/state/version`, `dashboard/public/state-version.js` | aviso antes do clique e 409 depois dele |
| Testes | `scripts/state-concurrency.test.js`, `dashboard/state-version-api.test.js` | os 10 cenários |

Plano e decisões: `memory/runs/2026-10-01-state-concurrency/plan.md`.

## Ambiente (base das garantias)

- I/O: `fs` nativo, síncrono. O projeto não usa `fs-extra`, `graceful-fs` nem `write-file-atomic`, e não foi adicionada dependência.
- SO: macOS (Darwin, arm64). Watcher, dashboard e agentes rodam no mesmo host. O fluxo não usa WSL nem Windows.
- Filesystem: APFS, volume único. O tmp é criado **no mesmo diretório** do `state.json`, então fica no mesmo filesystem por construção, e `rename(2)` é atômico.
- Limites conhecidos:
  - No macOS, `fsync` não força o cache do disco. Para isso seria preciso `F_FULLFSYNC`, que o Node não expõe. A escrita resiste a crash do processo, mas não a queda de energia.
  - No Windows, `rename` falha com `EPERM`/`EBUSY` se outro processo estiver com o arquivo aberto. O writer re-tenta até 5 vezes, com backoff curto.
  - No WSL sobre `/mnt/c` (drvfs), `rename` não é atômico. Se o fluxo for para lá, use o filesystem Linux do WSL.

## Campos críticos (incrementam `state_version`)

| Campo | Por quê |
|---|---|
| `node` | decide o próximo despacho |
| `status` | decide se despacha ou pausa |
| `execution_id` | dono da execução (girar = takeover) |
| `spec_hash` | baseline do /plan |
| `spec.hash`, `spec.version` | spec versionada |
| `artifact_validity.<plan\|implement\|review\|evidence\|verify>.validity.status` | VALID/STALE |
| `retries` (por nó; `0` = ausente) | decide escalada por `max_retries` |

Todo o resto é campo secundário e **nunca** incrementa a versão: `events`, `updated_at`,
`node_started_at`, `node_timeout_ms`, `agent_pid`, `cost_tracking`, `transcripts_*`,
`human_inputs`, `human_input_interpretations`, `processed_operations`, `pr_status`,
`qa_*`, `spec_pending_approval` etc. Por isso heartbeat, eventos e custo não geram conflito
falso com as transições.

Só o writer calcula a versão, sempre como `versão efetiva do disco + (algum campo crítico mudou ? 1 : 0)`.
Nenhum caller grava `state_version`. Uma escrita que mude vários campos críticos de uma vez
conta como uma transição só (+1).

**Edição fora do writer.** A cada escrita, o writer grava `critical_fingerprint`, um hash
dos campos críticos. Se um agente com Edit ou um humano mudar um campo crítico à mão, o
fingerprint deixa de bater, e o disco passa a contar como `state_version + 1` para o CAS
(`cas.effectiveVersion`). Assim, um CAS feito contra a leitura anterior a essa edição falha.
O endpoint de versão do dashboard usa a mesma versão efetiva.

## Operações críticas e como cada uma está protegida

| Operação | Quem | CAS (campos) | execution_id | Idempotência (`operation_id`) | Política em conflito |
|---|---|---|---|---|---|
| Transição de nó | agente: `state-writer.js transition --from --to` | `expected_state_version` + `expected_node` | sim (`$STATE_EXECUTION_ID`) | — | agente: re-tenta 1x |
| Retry de fase (`retries.<nó>`) | agente: `transition --retry` | versão + nó | sim | — | agente: re-tenta 1x |
| Resume por mensagem do dashboard (blocked/escalated) | watcher: `interpretBlockedHumanInput` | versão lida **antes** do intérprete | — | `human_input_resume:<message_hash>` | não aplica; reavalia no próximo tick |
| Consumo de human input | watcher: `checkHumanInput` | versão lida no despacho | — | `human_input:<message_hash>` | crash no meio não reinjeta a mensagem |
| Aprovação de spec (draft/auto-repair) | watcher: `runTaskSpecGate` | versão + `expected_spec_hash` lidos antes dos awaits do Redmine | — | `spec_approval:<journal>` | não aplica; próximo tick |
| Pedido de aprovação (dashboard → Redmine) | `POST /api/redmine/comment` | versão + spec_hash da tela, na **reserva** (dentro do lock, antes de postar) | — | `dashboard:<uuid>` (o mesmo em todas as tentativas da decisão) | 409 / `OPERATION_IN_PROGRESS` / `already_processed` — ver "Aprovação pelo dashboard" |
| Aprovação/rejeição de SPEC_CHANGE | `spec-change.js approve/reject` (watcher, CLI) | versão + `expected_spec_hash`, com lock até o fim | — | change_id `SC-NNN@<task>` | 2ª vez: `already_processed` |
| Replay (início) | `cycle-replayer.replayFrom` (dashboard/CLI) | versão + nó + execution_id **do run original** (tela ou leitura), lock até criar o run novo | sim | — | 409 (`ReplayError` com code do CAS) |
| Replay (persistência) | agente do run de replay | versão + nó | sim: o run de replay nasce com `init`, ou seja, execution_id próprio | — | agente: re-tenta 1x |
| Resume-session | `POST /api/runs/:id/resume-session` | versão da tela | sim (o da tela); **gira** o execution_id | — | 409; contenção de despacho (`despacho_reservado` / `fetch_em_execucao`) → **202** (state já retomado) |
| QA retry | `POST /api/runs/:id/retry-qa-rejection` | versão da tela, conferida **antes** do Redmine | **gira** | UUID do clique | 409 / `already_processed` |
| Pedido de autorização | agente: `authorization.js request` | versão lida (ou `--expected-version`) + `$STATE_EXECUTION_ID` | sim, se houver | — | um pedido em aberto por vez; exit 3 em conflito |
| Aprovar / Recusar / Já apliquei (autorização) | `POST /api/runs/:id/authorization/{approve,reject,manual}` (acesso local; sem aprovador desde 2026-11-06) | versão da tela (+ hash confirmado e alias escolhido no approve) | — | UUID do clique (`AUTHORIZATION_DECISION`) | 409 / `already_processed`; a execução (db-effect) é escrita de sistema depois da decisão |
| Devolver ao QA | `POST /api/runs/:id/handback-qa` (ou `then: handback_qa`) | versão da tela, na **reserva** antes do Redmine | — | UUID do clique (`QA_HANDBACK`), mesmo id na retomada de resultado incerto | 409 / `already_processed`; arquiva com lock até o rename |
| Commit | agente: `transition --operation=commit` | versão + nó (`commit`) | sim (obrigatório) | — | agente: re-tenta 1x |
| Archive | agente: `state-writer.js archive`; dashboard: `POST /api/runs/:id/archive` | versão + nó, lock até o `rename` da pasta | sim (obrigatório) | — | agente: aborta; dashboard: 409 |
| Despacho de um ticket (check-then-act) | watcher (tick) e dashboard (`dispatchNode`: ▶ Disparar, retomadas, replay) → `dispatchTicket` | — (reserva por ticket entre processos, ver "Despacho por ticket") | — | — | pula com `despacho_reservado` / `fetch_em_execucao`; dashboard: 409 |
| Carimbo de PID do lease | watcher: `node-lease.recordAgentPid` | estado `running` e `node_started_at` sob lock; `execution_id` validado em `scripts/cas.js` | sim | — | lease liberado ou takeover: gravação tardia ignorada |
| Release do lease | watcher/wrapper: `node-lease releaseNode` | — | sim (o do lease) | — | `SESSION_CONFLICT`: release ignorado |
| Escritas de sistema (eventos, custo, transcrições, PR poll, gates) | watcher, libs | merge de 3 vias com a leitura-base, ou mutator sobre o disco fresco | — | — | só recusa se outro processo mudou o mesmo campo crítico |

Campos obrigatórios por operação: `cas.REQUIRED` em `scripts/cas.js`. Faltar um deles é
erro de programação (`TypeError`), nunca passa em silêncio.

### Despacho por ticket (PRI-218)

`dispatchTicket` (`scripts/readmine-watcher.js`) é o ponto comum de despacho do watcher
e do dashboard, que rodam em processos diferentes. Ele roda inteiro sob a reserva do ticket,
`scripts/lib/dispatch-reservation.js`:

- A primitiva é a da trava do watcher: link() exclusivo, dono `(pid, início)` e retomada sob guarda quando o dono morre.
- O arquivo fica ao lado da trava, em `.git/prisma-dispatch-<ticket>.lock` ou `/tmp`.
- A reserva cobre o caminho da primeira leitura (state.json, marcador) até o despacho ficar
  visível: state.json `running` ou `gate.fetch_dispatch` com o `agent_pid` do agente.
- Quem chega com a reserva tomada pula com `despacho_reservado`.
- Se o dono crashar, a reserva é retomada no próximo despacho e não fica órfã. Em erro, ela sai no `finally`.
- Falha ao gravar o marcador `fetch_dispatch` aborta o spawn (falha fechada): sem marcador
  visível a corrida original voltaria.
- Hostname diferente na reserva (mesma regra da trava do watcher) conta como dono vivo —
  tipicamente disco compartilhado entre máquinas; remoção manual se tiver certeza.

O marcador `fetch_dispatch` passa a valer também para o watcher (`nodeLease.fetchDispatchLive`).
Enquanto o agente do fetch_ticket+plan vive, nada é redespachado no ticket (`fetch_em_execucao`),
nem o nó do state.json que ele acabou de criar. As regras de validade do marcador:

- Marcador com `dispatch_id` e sem `agent_pid` é de um despacho que não chegou ao spawn, e conta como morto.
- Marcador legado (sem `dispatch_id`) vence no prazo, como antes.
- Despacho que falha antes do agente remove o marcador na hora.
- `POST /api/runs/:id/resume-session` com contenção de despacho responde **202** (adiado):
  o state já girou; o próximo tick/despachante cobre o agente.

### execution_id

- Nasce no início do ciclo, no `state-writer.js init` (que o `/fetch-ticket` e o dry-run usam), e no mesmo momento `processed_operations` é zerado. Run legado ganha um no primeiro despacho (`acquireNode`).
- Gira em takeover: resume-session, QA retry e replay (o run novo já nasce com `init`).
- Na sessão concorrente, o watcher passa `STATE_EXECUTION_ID` ao agente e guarda o id no lease. Antes de persistir, a sessão relê o disco:
  - id diferente: `SESSION_CONFLICT`, nada é gravado e o conflito vai para o log;
  - id igual: segue o CAS normal (a `state_version` também precisa bater).
- `SESSION_CONFLICT` nunca é re-tentado, porque a sessão perdeu a posse.

### Run arquivado ou movido

- `update()`, e por consequência o release do lease, os eventos e o custo, devolve `null` quando a pasta do run não existe mais: o `/commit` arquivou o run, inclusive se isso aconteceu enquanto o update esperava o lock. É o "nada a fazer" esperado, e não gera ENOENT nem log de falha. Outros erros de filesystem (EACCES, EISDIR…) continuam propagando.
- `write()` com `base`, ou com um objeto que já tem `state_version` (ou seja, foi lido de um run), para uma pasta que não existe mais devolve `STATE_CONFLICT` (`cas.runGoneConflict`, logado com `actual_state_version: null`). O run **não** é recriado em `memory/runs`, porque um escritor obsoleto não pode ressuscitar um run arquivado. Run novo legítimo nasce por `init()` ou por `write()` de um objeto sem `state_version`.

### Idempotência

`processed_operations[] = [{ operation_id, type, processed_at }]` é gravado no mesmo
commit atômico da operação. Se o `operation_id` já está na lista, a resposta é
`{ status: "already_processed", operation_id }` e nada é aplicado. Essa checagem vem
antes da comparação de versão, para que a 2ª aprovação seja tratada como repetição e não
como conflito.

### Aprovação pelo dashboard (efeito externo: comentário no Redmine)

O comentário é um efeito fora do `state.json` e não cabe numa transação. A decisão de
consumir o `operation_id`, porém, cabe, e é tomada em duas fases:

1. **Reserva** (`cas.reserveOperation`, dentro do lock do run). Valida o CAS (versão e spec_hash da tela) e a idempotência, e grava `pending_operations[]` (campo secundário, sem `state_version` novo). De N pedidos simultâneos com o mesmo id, só um reserva. Os outros recebem 409 `OPERATION_IN_PROGRESS`, ou `already_processed` se o primeiro já terminou.
2. **Efeito**. `PUT` da nota com o marcador `[op dashboard:<uuid>]` no fim. O watcher só olha o começo da nota (a palavra-chave), então o marcador não muda a aprovação.
3. **Desfecho** (`cas.finishOperation`):
   - `done` (2xx): vai para `processed_operations` e a reserva sai.
   - `failed` (4xx: o Redmine recusou e certamente não gravou): a reserva sai e a próxima tentativa posta.
   - `uncertain` (timeout, rede ou 5xx: pode ter gravado): a reserva fica marcada.
4. **Retomada**. Uma reserva `uncertain`, ou vencida (`APPROVAL_RESERVATION_TTL_MS` = 120 s, que é o caso de dashboard morto), volta como `reclaimed`. Antes de qualquer `PUT`, o servidor lê os journals do ticket: se o marcador está lá, conclui `done` sem repostar; se não está, posta; se não consegue ler, mantém `uncertain` e responde 502.

O front usa o **mesmo** `operation_id` em todas as tentativas da mesma decisão até uma
dar certo. Um clique repetido depois de 502 cai na retomada, e não num pedido novo.

| Crash do dashboard | Estado | Próximo clique (mesmo id) |
|---|---|---|
| antes do efeito (reserva gravada, `PUT` não saiu) | reserva viva até vencer | dentro de 120 s: 409 em andamento; depois: retoma, não acha o marcador e posta **uma** vez |
| durante o efeito (`PUT` em voo) | reserva viva ou `uncertain` | retoma e confere o marcador: se chegou ao Redmine, não reposta; se não chegou, posta |
| depois do efeito, antes do `done` local | reserva viva | retoma, acha o marcador e conclui `done` sem repostar |

Semântica: **exactly-once efetivo** enquanto o ticket puder ser lido. O Redmine não tem
chave de idempotência, então a garantia vem de "conferir antes de repetir". No pior caso
(conferência impossível), o fluxo é **at-most-once**: responde 502 e não reposta às cegas.
A escolha é do lado seguro: um comentário duplicado não aplicaria a decisão duas vezes (o
watcher pega a primeira resposta e o change_id é idempotente), mas poluiria o ticket.
Run sem `state.json` (pré-task): a deduplicação fica só no processo do dashboard.

## Fluxo de escrita atômica (e o que acontece em cada crash)

```
lock state.json.lock: escrito num tmp com "pid ts" + fsync e publicado por link(2) (atômico,
     EEXIST se ocupado; o lock nunca existe vazio). Reentrante no processo. Abandonado = dono
     morto, ou conteúdo ilegível com mais de 30 s; a quebra é serializada por
     state.json.lock.break. Dono vivo nunca perde o lock por idade (STATE_LOCK_TIMEOUT)
 └─ 1. lê o disco + token (inode, tamanho, mtime ns)
    2. valida (CAS explícito | leitura-base | base obsoleta) e calcula state_version
    3. JSON.stringify → state.json.<pid>.<seq>.tmp (O_EXCL, mesmo diretório)
    4. fsync(tmp) + close
    5. token ainda igual? (escritor fora do lock mexeu → descarta o tmp e volta ao 1, até 3x)
    6. rename(tmp, state.json)      ← ponto atômico
    7. fsync(diretório)
unlock
```

| Crash em | Resultado |
|---|---|
| antes do 3 | nada mudou, e o lock do morto é retomado na próxima escrita ou no startup. Um tmp de criação de lock (`state.json.lock.<pid>.<seq>.tmp`) que tenha ficado para trás é descartado pelo `cleanupOrphans` |
| 3–5 (tmp parcial ou completo) | `state.json` intacto. O tmp órfão é **descartado** no startup do watcher (`cleanupOrphans`: pid do nome morto, ou mais de 10 min) e nunca é aplicado como estado |
| depois do 6 | estado novo inteiro. Se o 7 não rodou, o rename pode se perder numa queda de energia (ver limites acima), mas nunca fica meio arquivo |

Leitura: JSON truncado, que vem de escritor fora do writer no meio de um `writeFileSync`,
é re-lido até 5 vezes, com 10 ms de intervalo, antes de ser considerado ilegível.

Startup do orquestrador: `readmine-watcher.js main()` roda
`stateWriter.cleanupOrphans` em `memory/runs` e em cada `.claude/worktrees/*/memory/runs`
(incluindo `_archive`), antes do scan de nós órfãos. Manual:
`node "$PRISMA_ROOT/scripts/state-writer.js" cleanup memory/runs`.

## Política de retry por tipo de operação

| Tipo | Em `STATE_CONFLICT` | Em `SESSION_CONFLICT` |
|---|---|---|
| Agente (transição, retry de fase, replay, commit) | `cas.transactWithRetry`: relê, `revalidate(fresh)` confere se ainda faz sentido (o nó ainda é o `--from`), tenta **uma** vez. Se falhar de novo ou não fizer mais sentido, aborta, loga `STATE_CONFLICT_ABORTED` e a CLI sai com exit 3 | aborta (exit 3) |
| Humano (aprovações, human input pelo dashboard, QA retry, resume, archive) | sem retry. HTTP **409** `{code, error: "Este run mudou desde que a tela foi carregada. Atualize antes de executar esta ação.", conflicts}`, nunca 500 | idem |
| Sistema (watcher, heartbeat, eventos, custo) | campo secundário: o mutator roda sobre o disco fresco, e por isso não há conflito. Escrita de objeto inteiro com leitura-base: merge de 3 vias, que reaplica só o delta desta escrita sobre o disco (é a re-tentativa única). Recusa só se outro processo mudou o mesmo campo crítico de forma diferente; aí o gate fica para o próximo tick | release ignorado |

## Dashboard

- `GET /api/state/version?taskId=<id>` → `{ state_version, node, execution_id }` e nada mais.
- `public/state-version.js` faz polling a cada **5 s**, só do run aberto no detalhe e só com a aba visível. Se o servidor estiver à frente da `stateVersion` que a tela carregou, aparece um banner não bloqueante com o botão "Atualizar". Quando o WebSocket entrega o estado novo, o banner some sozinho.
- As ações (QA retry, resume, replay, archive, aprovar ou rejeitar spec) mandam no body o `casToken` que a tela carregou e um `operation_id`. Uma resposta 409 de CAS mostra o mesmo banner.
- A comparação numérica do banner no cliente é só uma dica visual. Quem decide é sempre o CAS do servidor.

## Auditoria

`logs/state-conflicts.jsonl`, um JSON por linha, só append (`O_APPEND`):

```json
{"event":"STATE_CONFLICT","timestamp":"2026-10-01T17:35:07.161Z","operation":"spec_change_approval","task_id":"43800-desconto","actor":"spec-change:approve","pid":52425,"expected_state_version":17,"actual_state_version":19,"expected_spec_hash":"ffffffff","actual_spec_hash":"3be4c1d2","operation_id":"SC-001@43800-desconto","conflicting_fields":["state_version","spec_hash"]}
```

O log usa uma lista fixa de campos. Nunca entram o estado inteiro, ACs, `human_inputs`,
notas ou tokens. `spec_hash` e `execution_id` aparecem só com os 8 primeiros caracteres.
O arquivo fica no checkout principal, mesmo quando o run está num worktree. Testes podem
redirecioná-lo com `STATE_CONFLICTS_LOG`. Eventos: `STATE_CONFLICT`, `SESSION_CONFLICT` e
`STATE_CONFLICT_ABORTED`.

## CLI dos agentes (`scripts/state-writer.js`)

```bash
node "$PRISMA_ROOT/scripts/state-writer.js" version    memory/runs/<id>
node "$PRISMA_ROOT/scripts/state-writer.js" init       memory/runs/<id> --input=<state.json novo>        # /fetch-ticket
node "$PRISMA_ROOT/scripts/state-writer.js" set        memory/runs/<id> --input=<patch.json> | --set campo=valor
node "$PRISMA_ROOT/scripts/state-writer.js" transition memory/runs/<id> --from=review --to=implement --retry
node "$PRISMA_ROOT/scripts/state-writer.js" archive    memory/runs/<id> --to=memory/runs/_archive/<id> --status=committed --expected-node=commit
node "$PRISMA_ROOT/scripts/state-writer.js" cleanup    memory/runs
```

Exit 3 indica conflito, com o JSON do erro no stderr. Os templates em `.claude/commands/`
mandam o agente parar sem gravar mais nada e reportar.

## Garantias verificadas por teste

Os testes também conferem, por varredura estática, que só `scripts/state-writer.js` grava
`state.json` e que comparações de `state_version`, `execution_id` e `expected_*` só
aparecem em `scripts/cas.js`. As comparações de hash de **drift** (`invalidate.classify`,
`spec-authority`) não entram nessa regra: são domínio da Dependency Invalidation, não de CAS.
