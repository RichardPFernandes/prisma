// Dashboard local de observabilidade do watcher (scripts/readmine-watcher.js).
// Dev tool: sem auth por design, mas só escuta em 127.0.0.1 e só lê/escreve dentro
// de diretórios memory/runs/ — ver README.md.
const express = require('express');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const { createCoordination, applyCoordinationDefault } = require('./coordination');
const { createVersion } = require('./version');
const { createOnboarding } = require('./onboarding');
const { createHoursBackfillJob } = require('./redmine-hours-backfill');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, execFileSync } = require('child_process');
function execFileSyncSafe(cmd, args, cwd) {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
}
// Controle do processo do watcher (start/stop/log). NÃO inicia nada no require — só
// quando o usuário clica Start (ou marcou auto-start, ver main).
const defaultWatcherManager = require('../scripts/watcher-manager');
// Preview de ambiente de um worktree (build + app-back :8081 + app-front :9000).
const { createPreviewManager } = require('../scripts/preview-manager');
// "Usar na minha máquina": checkouts principais no commit do ticket (/api/local-checkout*).
const { createLocalCheckout } = require('../scripts/local-checkout');
// Checklist de migração que o watcher põe no context.md (bloco entre marcadores).
const schemaWatcher = require('../scripts/lib/schema-watcher');
const buildValidator = require('../scripts/lib/build-validator');
const churnDetector = require('../scripts/lib/churn-detector');
// "✨ Corrigir com IA" do portão de build (POST /api/runs/:taskId/pre-build/ai-fix).
const preBuildAiFix = require('../scripts/lib/pre-build-ai-fix');
// Conta do Claude dos agentes + uso/limite dela (painel Watcher > Configurações).
const claudeAccount = require('../scripts/lib/claude-account');
const claudeUsage = require('../scripts/lib/claude-usage');
// Knowledge Graph de rastreabilidade ticket → spec → arquivos → PR (aba Grafo).
const knowledgeGraph = require('../scripts/lib/knowledge-graph');
const acRegistry = require('../scripts/lib/ac-registry');
const acProvenance = require('../scripts/lib/ac-provenance');
const invalidate = require('../scripts/invalidate');
// state.json só pelo state-writer; CAS das ações humanas em scripts/cas.js (docs/concurrency-map.md).
const stateWriter = require('../scripts/state-writer');
const cas = require('../scripts/cas');
const acIdsLib = require('../scripts/lib/ac-ids');
// Replay de ciclo a partir de um nó ("↩ Retomar a partir de" no detalhe do run).
const cycleReplayer = require('../scripts/lib/cycle-replayer');
const runComparator = require('../scripts/lib/run-comparator');
const { projectCostTracking } = require('./cost-projection');
const { buildWouldRouteMetrics } = require('./would-route-metrics');
const routingProjection = require('./routing-projection');
// Leitor de roteamento por processo (G3: o dashboard não importa scripts/lib).
const ROUTING_READ_SCRIPT = path.join(__dirname, '..', 'scripts', 'routing-read.js');
// Tira PR de Draft ("Marcar como pronto" no painel de preview).
const { markPrReady } = require('../scripts/check-pr-status');
// Lista/detalha/aprova PRs do Bitbucket, pra aba "PRs" (GET/POST /api/prs*).
const bitbucketPr = require('../scripts/lib/bitbucket-pr');
// Conflito de merge dos PRs abertos, via git merge-tree local (a API do Bitbucket não expõe).
const { createConflictDetector } = require('../scripts/lib/pr-conflicts');
const qaJournal = require('../scripts/lib/redmine-journal-fetcher');
const qaCycles = require('../scripts/lib/qa-cycles');
// Tickets abertos atribuídos ao usuário + detalhe/journals e escrita (status, nota),
// pra aba "Redmine" (GET /api/tickets[/mine|/:id], PUT .../status, POST .../note) — não confundir com o fetchAssignedTickets interno do watcher
// (scripts/readmine-watcher.js), que filtra só Aprovada|Recusa QA.
const redmineTicketList = require('../scripts/lib/redmine-ticket-list');
// Despacha fetch_ticket+plan pra um ticket (POST /api/runs/start) reaproveitando o
// mesmo dispatchTicket do watcher — carregado sob demanda dentro do dispatcher
// (custo de .env/schema/módulos só quando alguém realmente dispara).
const { dispatchNode } = require('../scripts/lib/node-dispatcher');
const nodeLease = require('../scripts/lib/node-lease');
// Export agregado de memory/runs/ como relatório JSON (botão "⬇ Exportar Relatório").
const runsExporter = require('../scripts/lib/runs-exporter');
// Transcrições por nó (post-mortem) — leitura de memory/runs/<task>/transcripts/.
const transcriptWriter = require('../scripts/lib/transcript-writer');
// Webhook de notificação (NOTIFY_WEBHOOK_URL) — mesmo módulo que o watcher usa.
const notify = require('../scripts/notify');
// Pedido de autorização humana (Aprovar/Recusar/Já apliquei), SQL governado (db-effect) e
// devolução ao QA sem código (PRI-180) — ver docs/runbook.md, "Autorização humana".
const authorization = require('../scripts/lib/authorization');
const dbEffect = require('../scripts/lib/db-effect');
const qaHandback = require('../scripts/lib/qa-handback');
const REPLAY_SCRIPT = path.join(__dirname, '..', 'scripts', 'replay-cycle.js');

// .env do próprio dashboard (cp .env.example .env). Nunca sobrescreve env já setada.
// Com `only`, carrega só essas chaves (usado pro .env do repo, ver main).
function loadDotEnv(envPath, only) {
    if (!fs.existsSync(envPath)) return;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
        }
        // `KEY=` vazio não conta: deixa o fallback (.env do repo) valer.
        if (!value) continue;
        if (only && !(typeof only === 'function' ? only(key) : only.includes(key))) continue;
        if (!(key in process.env)) process.env[key] = value;
    }
}

// Credenciais que os proxies de Redmine/Bitbucket usam. Ficam só no processo Node.
const INTEGRATION_KEYS = ['REDMINE_URL', 'REDMINE_API_KEY', 'BITBUCKET_WORKSPACE', 'BITBUCKET_REPO_SLUG', 'BITBUCKET_API_TOKEN'];
// Configuração do preview (scripts/preview-manager.js), também lida do .env do repo.
const PREVIEW_KEYS = ['PREVIEW_BACK_PORT', 'PREVIEW_FRONT_PORT', 'PREVIEW_JAVA_HOME', 'PREVIEW_PROFILE', 'PREVIEW_MVN_OFFLINE',
    'PREVIEW_ADAPTER', 'PREVIEW_MO_ENTITY_REPO', 'PREVIEW_APP_CORE_REPO', 'PREVIEW_FRONT_REPO', 'MS_ROUTER', 'PREVIEW_DB_OPTIONS', 'PREVIEW_LIBS_FROM_BRANCH', 'PREVIEW_LIB_REFS', 'PREVIEW_GRUNT_FORCE', 'PREVIEW_GRUNT_WATCH'];
// Palavra-chave de aprovação do draft de spec (spec-pending-approval). Não é segredo;
// vem do .env do repo junto com as integrações, igual ao watcher.
const APPROVAL_KEYS = ['SPEC_APPROVAL_KEYWORD', 'SPEC_REJECTION_KEYWORD'];
// Portão de build pré-implement (botão "Tentar de novo"): mesmo JDK/timeout do watcher.
const PRE_BUILD_KEYS = ['PRE_BUILD_COMMAND', 'PRE_BUILD_JAVA_HOME', 'PRE_BUILD_TIMEOUT_MS', 'WATCHER_CLAUDE_CONFIG_DIR'];
// Webhook de notificação do watcher (scripts/notify.js) — botão "Testar Notificação".
const NOTIFY_KEYS = ['NOTIFY_WEBHOOK_URL'];
// Ids do handback ao QA (PRI-180). Allowlist de bancos, aprovadores e segredo NUNCA vêm
// do .env do consumidor (um agente escreve nele): só de ~/.config/prisma
// (scripts/lib/prisma-config.js).
const AUTHORIZATION_KEYS = key => ['REDMINE_STATUS_AG_TESTE', 'REDMINE_CF_APONTAMENTOS_ID'].includes(key);
const FETCH_TIMEOUT_MS = 10000;
// Reserva de aprovação (cas.reserveOperation) de dashboard que morreu no meio: vence
// depois disso e o próximo clique confere o ticket antes de repostar.
const APPROVAL_RESERVATION_TTL_MS = 120000;

// ---------------------------------------------------------------------------
// state.pull_request aparece em vários formatos nos runs reais: mapa por repo
// ({ "app-back": { url, id }, ... }, o do schema), valor string com a URL,
// `pr_url` em vez de `url`, ou objeto único ({ id, links.html.href } do Bitbucket
// ou { url, number }). Normaliza tudo pra [{ repo, workspace, id, url, state }].
const PR_URL_RE = /bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests?\/(\d+)/i;
const FLAT_PR_KEYS = ['url', 'pr_url', 'links', 'number', 'id', 'title'];

function extractPrIdFromUrl(url) {
    if (typeof url !== 'string') return null;
    const m = url.match(/\/pull-requests?\/(\d+)/i);
    return m ? m[1] : null;
}

function prEntry(repo, value) {
    const v = typeof value === 'string' ? { url: value } : value;
    if (!v || typeof v !== 'object') return null;
    const url = [v.url, v.pr_url, v.links?.html?.href].find(u => typeof u === 'string' && /^https?:\/\//i.test(u)) || null;
    const m = url ? url.match(PR_URL_RE) : null;
    const id = Number(v.id ?? v.number ?? extractPrIdFromUrl(url)) || null;
    if (!url && !id) return null;
    const localState = typeof (v.state || v.status) === 'string' ? (v.state || v.status).toUpperCase() : null;
    // status/last_checked_at: gravados pelo polling de PRs do watcher (scripts/lib/pr-status-poll.js).
    const lastChecked = typeof v.last_checked_at === 'string' ? v.last_checked_at : null;
    return { repo: repo || (m && m[2]) || null, workspace: m ? m[1] : null, id, url, state: localState, last_checked_at: lastChecked };
}

function extractPrs(pr, primaryRepo = null) {
    if (!pr) return [];
    if (typeof pr === 'string') return [prEntry(null, pr)].filter(Boolean);
    if (typeof pr !== 'object') return [];
    const flat = FLAT_PR_KEYS.some(k => k in pr && (k === 'links' || typeof pr[k] !== 'object'));
    const list = flat ? [prEntry(null, pr)] : Object.entries(pr).map(([repo, v]) => prEntry(repo, v));
    // Configured primary first, preserving recorded order for other entries.
    return list.filter(Boolean).sort((a, b) => (b.repo === primaryRepo) - (a.repo === primaryRepo));
}

// Ativo x concluído. Diferente da regra "tem PR => concluído": um run que ainda
// anda ou está parado esperando alguém continua ativo mesmo já tendo PR (caso real:
// #43452 bloqueado com PR de front aberto) — senão sumiria dentro de "Concluídos".
// spec-pending-approval: o watcher postou um draft (IA) das seções que faltavam na spec
// e espera um comentário com a palavra-chave no Redmine — parado, mas não falhou.
// plan-escalation: plano abaixo do score mínimo depois dos re-plans (watcher, runPlanGate),
// esperando revisão humana — parado, mas não falhou.
// churn-escalation: mesmos arquivos modificados em N rodadas de re-implement sem convergir
// (watcher, runChurnGate) — idem, espera "aceito" ou ajuste da spec/plano.
// spec-drift: a spec mudou depois do /plan sem SPEC_CHANGE aprovado (watcher,
// runSpecDriftGate; scripts/lib/spec-authority.js) — parado até aprovação/replanejamento.
// spec-draft: spec rascunho gerada dos campos do ticket (draft: true), esperando revisão
// humana antes do /fetch-ticket — só existe como run sintético pré-task.
// spec-change-pending-approval / spec-change-rejected: o /implement propôs uma SPEC_CHANGE
// (scripts/lib/spec-change.js) — esperando aprovação no Redmine / rejeitada, parado até
// alguém decidir.
const MOVING_STATUSES = ['in_progress', 'running', 'interrupted', 'blocked', 'escalated', 'needs_human_review', 'spec-pending-approval', 'spec-draft', 'plan-escalation', 'churn-escalation', 'spec-drift', 'spec-change-pending-approval', 'spec-change-rejected', 'authorization-pending'];
const TERMINAL_STATUSES = ['committed', 'fully_merged', 'done', 'closed', 'archived', 'handed_back_qa'];
function deriveRunKind(state) {
    if (!state) return 'unknown';
    if (MOVING_STATUSES.includes(state.status)) return 'active';
    if (state.status === 'failed' || state.status === 'spec-invalid' || state.status === 'pre-build-failed') return 'failed';
    if (extractPrs(state.pull_request).length) return 'has_pr';
    if (TERMINAL_STATUSES.includes(state.status)) return 'completed';
    return 'active';
}

function ticketIdOf(taskId, state) {
    // Task-id com data no começo (2026-09-19-...) não é número de ticket.
    const fromTaskId = /^\d{4}-\d{2}-\d{2}-/.test(taskId) ? null : (taskId.match(/^(\d{4,6})-/) || [])[1];
    const id = state?.ticket_id ?? state?.redmine_ticket?.id ?? fromTaskId;
    return /^\d+$/.test(String(id ?? '')) ? Number(id) : null;
}

function preBuildOf(state) {
    if (!state || !['passed', 'failed', 'skipped'].includes(state.preBuildStatus)) return null;
    return {
        status: state.preBuildStatus,
        errors: Array.isArray(state.preBuildErrors) ? state.preBuildErrors.filter(x => typeof x === 'string') : [],
        durationMs: typeof state.preBuildDurationMs === 'number' ? state.preBuildDurationMs : null,
        at: state.preBuildAt || null,
        accepted: state.preBuildAccepted?.by || null,
        skipReason: typeof state.preBuildSkipReason === 'string' ? state.preBuildSkipReason : null,
    };
}

// Seção "## Decisões de Implementação" da spec (APPEND do /implement, formato em
// templates/spec-decisions-section.md). Retorna quantas entradas ("###") ela tem, ou
// null sem a seção. Ignora comentário HTML e bloco de código: spec que só cita o
// template não conta como spec atualizada.
const SPEC_DECISIONS_HEADING = /^decisoes de implementacao\b/;
function specDecisionsOf(content) {
    if (typeof content !== 'string') return null;
    const norm = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[*_`]/g, '').trim();
    let inFence = false, inSection = false, found = false, entries = 0;
    for (const line of content.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
        if (/^\s{0,3}(```|~~~)/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (!h) continue;
        const level = h[1].length;
        if (level <= 2) {
            inSection = level === 2 && SPEC_DECISIONS_HEADING.test(norm(h[2]));
            found = found || inSection;
        } else if (inSection && level === 3) entries++;
    }
    return found ? { entries } : null;
}

const NODES = ['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'];
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MESSAGE_CHARS = 20000;
const OPENAPI_CONTRACT_FILE = 'openapi-contract.yaml';
const WATCHED_FILES = new Set(['state.json', 'context.md', 'human-input.md', OPENAPI_CONTRACT_FILE]);
// Portão de spec do watcher (memory/runs/<ticket>-spec-gate.json, raiz do checkout
// principal) — é onde fica a pendência de aprovação de draft ANTES de existir task.
const SPEC_GATE_FILE_RE = /^(\d+)-spec-gate\.json$/;
const PRETASK_SUFFIX = '-spec-gate';

function createDashboard(options = {}) {
    const env = { ...(options.env || process.env) };
    const prismaRoot = path.resolve(__dirname, '..');
    // repoRoot explícito vence. Quem só passa memoryDir continua derivando o projeto
    // desse diretório, mesmo que REPO_PATH esteja no ambiente. Sem os dois, vale o consumidor.
    const derivedFromMemory = options.memoryDir ? path.resolve(options.memoryDir, '..', '..') : null;
    const repoRoot = path.resolve(options.repoRoot || derivedFromMemory || env.REPO_PATH || process.cwd());
    const memoryDir = path.resolve(repoRoot, options.memoryDir || env.MEMORY_DIR || 'memory/runs');
    const consumerEnv = { ...env, REPO_PATH: repoRoot, PRISMA_ROOT: prismaRoot };
    const primaryRepo = env.WATCHER_MAIN_REPO_NAME || env.BITBUCKET_REPO_SLUG || path.basename(repoRoot);
    const projectPrs = pr => extractPrs(pr, primaryRepo);
    const siblingNames = (options.siblingRepos || String(env.WATCHER_SIBLING_REPOS || '').split(',').map(r => r.trim()).filter(Boolean));
    for (const name of siblingNames) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) throw new Error('nome de repositório irmão inválido');
    }
    const siblingRepos = siblingNames.map(r => path.resolve(repoRoot, '..', r)).filter(p => fs.existsSync(p));
    // Retentativas do pré-build em andamento (botão "Tentar de novo"), por taskId.
    const preBuildRetrying = new Set();
    // Correções por IA do pré-build em andamento, por taskId: { cancel, events }.
    const aiFixes = new Map();
    const aiFixSpawn = options.aiFixSpawn; // injetável nos testes (senão child_process.spawn)
    // Replays sendo criados (POST /replay), por taskId do original.
    const replaying = new Set();
    // Roda scripts/replay-cycle.js --json e devolve o JSON da stdout. Injetável nos testes.
    const replayRunner = options.replayRunner || ((args) => new Promise(resolve => {
        execFile(process.execPath, [REPLAY_SCRIPT, ...args, '--json'], { cwd: repoRoot, env: consumerEnv, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                let out = null;
                try { out = JSON.parse(stdout); } catch { /* sem JSON: erro abaixo */ }
                if (!out) out = { ok: false, error: (err && err.killed ? 'replay-cycle.js excedeu 120 s' : stderr.trim().split('\n').pop()) || 'replay-cycle.js sem saída' };
                resolve(out);
            });
    }));
    const validateBuild = options.validateBuild || buildValidator.validateBuild;
    // Injetáveis nos testes (evita bater no Redmine de verdade ou spawnar `claude`).
    const redmineOptions = () => ({ redmineUrl: consumerEnv.REDMINE_URL || '', apiKey: consumerEnv.REDMINE_API_KEY || '' });
    const fetchAssignedTickets = options.fetchAssignedTickets || (() => redmineTicketList.fetchAssignedTickets(redmineOptions()));
    const getTicketDetail = options.getTicketDetail || (id => redmineTicketList.getTicketDetail(id, redmineOptions()));
    const updateTicketStatus = options.updateTicketStatus || ((id, status, note) => redmineTicketList.updateTicketStatus(id, status, note, redmineOptions()));
    const addJournalNote = options.addJournalNote || ((id, note) => redmineTicketList.addJournalNote(id, note, redmineOptions()));
    const listIssueStatuses = options.listIssueStatuses || (() => redmineTicketList.listIssueStatuses(redmineOptions()));
    const dispatchTicketNode = args => (options.dispatchNode || dispatchNode)({ ...args, repoPath: repoRoot, env: consumerEnv });
    const worktreesDir = path.resolve(repoRoot, options.worktreesDir || consumerEnv.WORKTREES_DIR || path.join(repoRoot, '.claude', 'worktrees'));
    // Rotação de runs antigos (scripts/cleanup-runs.js): memory/archive/<YYYY-MM>/<task-id>[__<checkout>]/.
    const rotatedArchiveDir = path.resolve(repoRoot, options.archiveDir || consumerEnv.RUNS_ARCHIVE_DIR || path.join(repoRoot, 'memory', 'archive'));
    const graphPath = path.resolve(repoRoot, options.graphPath || consumerEnv.KNOWLEDGE_GRAPH_PATH || path.join(repoRoot, 'memory', 'knowledge-graph.json'));
    // memory/patterns.md (gerado por scripts/memory-consolidator.js) + o contador que
    // acompanha, só pra metadata (quando a última consolidação rodou).
    const patternsPath = path.resolve(repoRoot, options.patternsPath || consumerEnv.CONSOLIDATOR_PATTERNS_PATH || path.join(repoRoot, 'memory', 'patterns.md'));
    const consolidatorStatePath = path.resolve(repoRoot, options.consolidatorStatePath || consumerEnv.CONSOLIDATOR_STATE_PATH || path.join(repoRoot, 'memory', 'consolidator-state.json'));
    // GET /api/runs/:taskId/agent-log/stream: intervalos injetáveis nos testes (senão o
    // padrão de produção — polling de 1s no arquivo, 5s no status, timeout de 30min).
    const agentLogPollMs = options.agentLogPollMs || 1000;
    const agentLogStatusPollMs = options.agentLogStatusPollMs || 5000;
    const agentLogStreamTimeoutMs = options.agentLogStreamTimeoutMs || 30 * 60 * 1000;

    // ---------------------------------------------------------------------------
    // Segurança: nada que pareça credencial sai pela API.
    const SECRET_KEY_RE = /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS)$/i;
    const secretValues = [...Object.entries(process.env), ...Object.entries(consumerEnv)]
        .filter(([k, v]) => (SECRET_KEY_RE.test(k) || k === 'NOTIFY_WEBHOOK_URL') && typeof v === 'string' && v.length >= 6)
        .map(([, v]) => v);
    const INLINE_SECRET_RE = /\b((?:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*[=:]\s*)(["']?)[^\s"']+\2/gi;
    const HEADER_SECRET_RE = /((?:X-Redmine-API-Key|Authorization)\s*[:=]\s*(?:Bearer\s+|Basic\s+)?)(["']?)[^\s"',}]+\2/gi;
    function redact(text) {
        if (typeof text !== 'string') return text;
        let out = text;
        for (const v of secretValues) out = out.split(v).join('***');
        return out.replace(INLINE_SECRET_RE, '$1***').replace(HEADER_SECRET_RE, '$1***');
    }
    function redactDeep(value) {
        if (typeof value === 'string') return redact(value);
        if (Array.isArray(value)) return value.map(redactDeep);
        if (value && typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY_RE.test(k) ? '***' : redactDeep(v);
            return out;
        }
        return value;
    }

    // ---------------------------------------------------------------------------
    // Descoberta de runs.
    function runRoots() {
        const roots = [{ label: 'main', dir: memoryDir }];
        if (fs.existsSync(worktreesDir)) {
            for (const d of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
                if (!d.isDirectory()) continue;
                const dir = path.join(worktreesDir, d.name, 'memory', 'runs');
                if (fs.existsSync(dir)) roots.push({ label: `worktree:${d.name}`, dir, worktree: d.name });
            }
        }
        return roots;
    }

    function readJson(p) {
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
    }

    function stateTime(state) {
        return new Date(state?.updated_at || state?.started_at || 0).getTime() || 0;
    }

    // Todas as cópias de cada taskId. Várias worktrees carregam cópias antigas do
    // mesmo run (memory/runs já foi versionado), então cada taskId é resolvido pra
    // UMA cópia: a do worktree do ticket (é a que o watcher lê e processa), senão a
    // atualizada mais recentemente.
    //
    // Sem readdirSync por evento/request: runsCache (root.dir -> { root, names }) é
    // lido do disco uma vez por root (ao entrar no watcher) e depois só mantido pelos
    // addDir/unlinkDir do chokidar.
    const isRunDirName = name => !name.startsWith('_') && TASK_ID_RE.test(name);
    const runsCache = new Map();
    function cacheRoot(root) {
        const names = new Set();
        try {
            for (const d of fs.readdirSync(root.dir, { withFileTypes: true })) if (d.isDirectory() && isRunDirName(d.name)) names.add(d.name);
        } catch { /* root sumiu entre o existsSync e o readdir: fica vazio */ }
        runsCache.set(root.dir, { root, names });
    }

    function collectCandidates() {
        const byTask = new Map();
        for (const { root, names } of runsCache.values()) {
            for (const name of names) {
                if (!byTask.has(name)) byTask.set(name, []);
                byTask.get(name).push({ taskId: name, dir: path.join(root.dir, name), root });
            }
        }
        return byTask;
    }

    // Run pedido por id que o chokidar ainda não reportou (acabou de ser criado): um
    // existsSync por root — sem readdir — e já entra no cache.
    function candidatesOf(taskId) {
        let found = collectCandidates().get(taskId);
        if (!found) { syncWatchedRoots(); found = collectCandidates().get(taskId) || []; } // worktree nova ainda não vista pelo timer
        for (const { root, names } of runsCache.values()) {
            if (names.has(taskId)) continue;
            const dir = path.join(root.dir, taskId);
            try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
            names.add(taskId);
            found.push({ taskId, dir, root });
        }
        return found.length ? found : null;
    }

    function pickCandidate(taskId, candidates) {
        const ticket = (taskId.match(/^(\d+)-/) || [])[1];
        const own = ticket && candidates.find(c => c.root.worktree === ticket);
        if (own) return own;
        let best = null, bestT = -1;
        for (const c of candidates) {
            const t = stateTime(readJson(path.join(c.dir, 'state.json')));
            if (t > bestT) { best = c; bestT = t; }
        }
        return best;
    }

    function resolveRun(taskId) {
        if (!isRunDirName(taskId)) return null;
        const candidates = candidatesOf(taskId);
        if (!candidates) return null;
        const chosen = pickCandidate(taskId, candidates);
        return { ...chosen, copies: candidates.length };
    }

    function runStatus(state) {
        if (!state) return 'unknown';
        const s = state.status;
        // fully_merged = committed com todos os PRs mergeados (polling de PRs do watcher).
        if (s === 'committed' || s === 'fully_merged' || s === 'handed_back_qa') return 'committed';
        // authorization-pending: pedido de autorização humana (scripts/lib/authorization.js) — Aprovar/Recusar no detalhe.
        if (s === 'authorization-pending') return 'awaiting_approval';
        if (s === 'blocked' || s === 'escalated' || s === 'needs_human_review' || s === 'interrupted' || s === 'session_limit' || s === 'plan-escalation' || s === 'churn-escalation' || s === 'spec-drift' || s === 'spec-change-rejected' || state.node === 'escalated') return 'needs_human_review';
        if (s === 'spec-pending-approval' || s === 'spec-draft' || s === 'spec-change-pending-approval') return 'awaiting_approval';
        // pre-build-failed: portão de build do watcher (runPreBuildGate) — mvn compile falhou antes do implement.
        if (s === 'spec-invalid' || s === 'failed' || s === 'pre-build-failed') return 'failed';
        if (s === 'in_progress' || s === 'running') return 'running';
        return 'pending';
    }

    // state.node = PRÓXIMO nó a rodar (convenção do watcher); history = já visitados.
    // awaiting_approval cai no 'pending': o nó atual está esperando, não falhou.
    // /test, /verify e /commit não gravam em history: o node_end dos events também conta,
    // e run commitado tem todas as etapas concluídas.
    function nodeStatuses(state) {
        const out = {};
        const status = runStatus(state);
        const visited = new Set(state?.history || []);
        for (const e of state?.events || []) if (e?.type === 'node_end') visited.add(e.node);
        for (const n of NODES) out[n] = status === 'committed' || visited.has(n) ? 'done' : 'pending';
        if (state && status !== 'committed' && NODES.includes(state.node)) {
            out[state.node] = status === 'running' ? 'running'
                : (status === 'failed' || status === 'needs_human_review') ? 'failed'
                    : 'pending';
            // Retry (Recusa QA, review reprovado): history acumula os nós do ciclo anterior,
            // mas o que vem depois do nó atual ainda vai rodar de novo — mostra pendente.
            for (const n of NODES.slice(NODES.indexOf(state.node) + 1)) out[n] = 'pending';
        }
        return out;
    }

    function readRunState(run) {
        return run.pretask ? run.state : withFetchDispatchClock(run, readJson(path.join(run.dir, 'state.json')));
    }

    // Despacho conjunto /fetch-ticket + /plan: quem cria o state.json é o agente (sem
    // status "running"/node_started_at — o watcher só carimba no fim, stampNewTask), então
    // o relógio do nó (public/node-clock.js) não aparecia no plan. Enquanto o marcador do
    // gate estiver de pé (sai quando o agente termina), o lease é derivado dele: plan
    // conta a partir da criação da task, com o mesmo prazo final do despacho.
    function withFetchDispatchClock(run, state) {
        if (!state || state.node_started_at || !['in_progress', 'running'].includes(state.status)) return state;
        if (!['fetch_ticket', 'plan'].includes(state.node)) return state;
        const id = ticketIdOf(run.taskId, state);
        const dispatched = id && fetchDispatchOf(readJson(path.join(memoryDir, `${id}-spec-gate.json`)));
        if (!dispatched) return state;
        const dispatchAt = Date.parse(dispatched.started_at);
        const createdAt = Date.parse(state.started_at);
        const startAt = state.node === 'plan' && Number.isFinite(createdAt) && createdAt >= dispatchAt ? createdAt : dispatchAt;
        const timeout = Number(dispatched.timeout_ms) > 0 ? Number(dispatched.timeout_ms) : 60 * 60 * 1000;
        return {
            ...state, status: 'running',
            node_started_at: new Date(startAt).toISOString(),
            node_timeout_ms: Math.max(1, timeout - (startAt - dispatchAt)),
            node_clock_derived: 'fetch_dispatch',
        };
    }

    // Spec da task: memory/spec/<ticket>-spec.md da mesma raiz do run (worktree do ticket
    // ou checkout principal); task sem ticket usa o próprio task-id, igual ao /implement.
    function readSpec(run, state) {
        const specDir = path.join(run.root.dir, '..', 'spec');
        const ids = [ticketIdOf(run.taskId, state), run.taskId].filter(x => x != null);
        for (const id of ids) {
            try { return fs.readFileSync(path.join(specDir, `${id}-spec.md`), 'utf8'); } catch { /* próximo */ }
        }
        return null;
    }

    const hasQaHistory = state => !!state && (state.qa_rejection || state.qa_retry_count > 0 || Array.isArray(state.qa_rejections));

    function summarize(run) {
        const state = readRunState(run);
        return {
            taskId: run.taskId,
            // Número do ticket Redmine (null se não der pra derivar) — usado pelo
            // dashboard pra casar uma run com o ticket que a originou (ex: POST
            // /api/runs/start checando duplicata, aba "Meus Tickets" achando a run
            // recém-criada por polling). Mesma função usada no resto do arquivo.
            ticketId: ticketIdOf(run.taskId, state),
            location: run.root.label,
            copies: run.copies,
            status: runStatus(state),
            node: state?.node || null,
            // Versão que esta tela carregou + expectativas que as ações devolvem no body
            // (scripts/cas.js). O polling de GET /api/state/version compara com isto.
            stateVersion: state ? cas.effectiveVersion(state) : null,
            casToken: state ? cas.snapshotOf(state) : null,
            nodes: nodeStatuses(state),
            ticket: state?.redmine_ticket || null,
            updatedAt: state?.updated_at || state?.started_at || null,
            pendingHumanInput: !run.pretask && fs.existsSync(path.join(run.dir, 'human-input.md')),
            pretask: run.pretask === true,
            kind: deriveRunKind(state),
            pr_url: projectPrs(state?.pull_request)[0]?.url || null,
            // [] = suíte completa; null = watcher ainda não calculou (ver scripts/lib/service-detector.js).
            affectedServices: Array.isArray(state?.affectedServices) ? state.affectedServices.filter(x => typeof x === 'string') : null,
            // Gravado pelo watcher (scripts/lib/schema-watcher.js). null = sem mudança de schema ou não calculado.
            schemaChanges: state?.schema_changes_detected === true
                ? { riskLevel: ['low', 'medium', 'high'].includes(state.schema_risk_level) ? state.schema_risk_level : 'low' }
                : null,
            // Portão de build pré-implement (scripts/lib/build-validator.js); null = não rodou (task antiga ou antes do implement).
            preBuild: preBuildOf(state) && { ...preBuildOf(state), retrying: preBuildRetrying.has(run.taskId), aiFix: aiFixOf(run, state) },
            // Spec da task com "## Decisões de Implementação" (APPEND do /implement); null = sem a seção.
            specDecisions: run.pretask ? null : specDecisionsOf(readSpec(run, state)),
            // Contrato OpenAPI da task (nó Plan, só task de endpoint) — liga o botão
            // "Ver contrato OpenAPI" do detalhe (GET /api/runs/:taskId/openapi-contract).
            hasOpenApiContract: !run.pretask && fs.existsSync(path.join(run.dir, OPENAPI_CONTRACT_FILE)),
            // De que nós dá pra retomar (scripts/lib/cycle-replayer.js) — mesma regra que o
            // POST /replay e o scripts/replay-cycle.js aplicam.
            replay: run.pretask ? null : cycleReplayer.replayOptions(state),
            // Status do ticket no Redmine: o que o watcher gravou (ticket_status) ou, em
            // arquivado com demanda aberta, o que a varredura acabou de ler. qaRejected
            // liga o badge/botão "Corrigir recusa QA" (POST /retry-qa-rejection).
            ticketStatus: run.demand?.status || state?.ticket_status || null,
            qaRejected: !run.pretask && !!state && qaJournal.isQaRejectedStatus(run.demand?.status || state.ticket_status),
            qaRetryCount: Number.isInteger(state?.qa_retry_count) ? state.qa_retry_count : 0,
            qaRetryPending: !run.pretask && fs.existsSync(path.join(run.dir, 'retry-signal.json')),
            // PRI-184: motivo do sinal parado (watcher gravou qa_retry_blocked); null se limpo/ausente.
            // PRI-233 T8: overrides humanas de roteamento gravadas (append-only); [] sem nenhuma.
            routingOverrides: !run.pretask && Array.isArray(state?.routing_overrides)
                ? state.routing_overrides.map(o => ({
                    ref: o.ref, scope: o.scope, node: o.node || null, subtaskKey: o.subtask_key || null,
                    value: o.value, by: o.by, recordedAt: o.recorded_at,
                }))
                : [],
            // PRI-233 T9: admissão recusada por roteamento ON inválido (pré-task sintética).
            routingBlocked: run.pretask && state?.routing_admission_blocked
                ? {
                    scope: 'admission',
                    cause: state.routing_admission_blocked.cause,
                    detail: state.routing_admission_blocked.detail,
                    transient: state.routing_admission_blocked.transient,
                    firstBlockedAt: state.routing_admission_blocked.first_blocked_at,
                    notifiedAt: state.routing_admission_blocked.notified_at,
                    configFile: '.claude/model-routing.json',
                }
                : null,
            qaRetryBlocked: (!run.pretask && state?.qa_retry_blocked
                && typeof state.qa_retry_blocked === 'object'
                && typeof state.qa_retry_blocked.reason === 'string'
                && typeof state.qa_retry_blocked.at === 'string')
                ? { reason: state.qa_retry_blocked.reason, at: state.qa_retry_blocked.at }
                : null,
            // Cada recusa separada do ciclo principal (scripts/lib/qa-cycles.js); null = run
            // sem recusa. Só lê o context.md (blocos de recusa) de run que já teve alguma.
            qaCycles: run.pretask || !hasQaHistory(state) ? null : redactDeep(qaCycles.buildQaCycles(state, readContext(run.dir))),
            // Project the cost subtree before every API/WS summary. Internal
            // attempt refs/read order must never travel with this read model.
            state: state ? redactDeep({ ...state, ...(state.cost_tracking ? {
                cost_tracking: projectCostTracking(state.cost_tracking, {
                    run,
                    ticketId: ticketIdOf(run.taskId, state),
                }),
            } : {}) }) : null,
        };
    }

    // ---------------------------------------------------------------------------
    // Arquivar pelo dashboard. Move SÓ a cópia resolvida do run pra <root>/_archive/
    // (mesma convenção do /commit). Cópias velhas do mesmo task-id em worktrees de
    // outros tickets não são tocadas — mexer nelas deixaria deleções no git desses
    // worktrees, que acabam indo junto no commit de outro ticket. Em vez disso o
    // registro abaixo (arquivo não versionado: memory/ é ignorado pro que é novo)
    // esconde o task-id enquanto nenhuma cópia for atualizada depois do arquivamento
    // — run que volta a andar reaparece sozinho.
    const REGISTRY = path.join(memoryDir, '_archive', 'dashboard-archived.json');
    function readRegistry() { return readJson(REGISTRY) || {}; }
    function writeRegistry(reg) {
        fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
        const tmp = `${REGISTRY}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
        fs.renameSync(tmp, REGISTRY);
    }
    function archivedAway(taskId, candidates, reg = readRegistry()) {
        const entry = reg[taskId];
        if (!entry) return false;
        const at = Date.parse(entry.archived_at) || 0;
        return !(candidates || []).some(c => stateTime(readJson(path.join(c.dir, 'state.json'))) > at);
    }

    // ---------------------------------------------------------------------------
    // Arquivados com demanda em aberto. O /commit arquiva o run ao concluir o ciclo,
    // mas a demanda segue (PR aberto, "Ag Merge"/"Ag Teste" no Redmine) — e aí o run
    // sumia do dashboard justo na fase de acompanhar o PR (caso real: #43609). Quem diz
    // se a demanda terminou é o status do ticket no Redmine, não o state.json (todo
    // arquivado diz "committed"). Varredura em segundo plano, com cache por ticket: 5 min
    // pra ticket aberto, 1 h pra fechado. Por ticket entra só o arquivado mais recente,
    // e nunca quando o ticket já tem run ativo ou quando o run foi arquivado pelo
    // próprio dashboard (o usuário pediu pra tirar). Sem Redmine configurado não dá pra
    // saber — nenhum entra.
    const CLOSED_STATUS_RE = /conclu|encerr|fechad|closed|rejeit|cancel|finaliz/i;
    const ISSUE_TTL_OPEN_MS = 5 * 60 * 1000;
    const ISSUE_TTL_CLOSED_MS = 60 * 60 * 1000;
    const issueCache = new Map(); // ticketId -> { at, status, closed }
    let archivedOpen = new Map(); // taskId -> { taskId, dir, root, ticketId, demand }
    let archivedScan = null;
    let archivedScanAt = 0;

    function archivedCandidates() {
        const byTask = new Map();
        for (const root of runRoots()) {
            const dir = path.join(root.dir, '_archive');
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const d of entries) {
                if (!d.isDirectory() || !isRunDirName(d.name)) continue;
                if (!byTask.has(d.name)) byTask.set(d.name, []);
                byTask.get(d.name).push({ taskId: d.name, dir: path.join(dir, d.name), root: { ...root, label: `${root.label} (_archive)` } });
            }
        }
        return byTask;
    }

    async function issueStatus(ticketId) {
        const hit = issueCache.get(ticketId);
        if (hit && Date.now() - hit.at < (hit.closed ? ISSUE_TTL_CLOSED_MS : ISSUE_TTL_OPEN_MS)) return hit;
        const redmineUrl = (consumerEnv.REDMINE_URL || '').replace(/\/+$/, '');
        const apiKey = consumerEnv.REDMINE_API_KEY;
        if (!redmineUrl || !apiKey) return null;
        try {
            const { issue } = await fetchJson(`${redmineUrl}/issues/${ticketId}.json`, { 'X-Redmine-API-Key': apiKey, Accept: 'application/json' });
            const name = issue?.status?.name || '';
            const closed = typeof issue?.status?.is_closed === 'boolean' ? issue.status.is_closed : CLOSED_STATUS_RE.test(name);
            const entry = { at: Date.now(), status: name, closed, assigned_to: issue?.assigned_to?.name || null };
            issueCache.set(ticketId, entry);
            return entry;
        } catch (e) {
            // Ticket removido do Redmine conta como fechado; erro de rede mantém o último valor.
            if (e.status === 404) { const entry = { at: Date.now(), status: 'não encontrado', closed: true }; issueCache.set(ticketId, entry); return entry; }
            return hit || null;
        }
    }

    async function scanArchivedOpen() {
        if (archivedScan) return archivedScan;
        archivedScan = (async () => {
            const reg = readRegistry();
            const activeTickets = new Set();
            for (const [taskId, candidates] of collectCandidates()) {
                if (archivedAway(taskId, candidates, reg)) continue;
                const chosen = pickCandidate(taskId, candidates);
                const id = chosen && ticketIdOf(taskId, readJson(path.join(chosen.dir, 'state.json')));
                if (id) activeTickets.add(id);
            }
            const latestByTicket = new Map();
            for (const [taskId, candidates] of archivedCandidates()) {
                if (reg[taskId] || candidatesOf(taskId)) continue;
                const chosen = pickCandidate(taskId, candidates);
                const state = chosen && readJson(path.join(chosen.dir, 'state.json'));
                const ticketId = state && ticketIdOf(taskId, state);
                if (!ticketId || activeTickets.has(ticketId)) continue;
                const prev = latestByTicket.get(ticketId);
                if (!prev || stateTime(state) > prev.t) latestByTicket.set(ticketId, { ...chosen, ticketId, t: stateTime(state) });
            }
            const items = [...latestByTicket.values()];
            const next = new Map();
            let i = 0;
            await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
                while (i < items.length) {
                    const it = items[i++];
                    const st = await issueStatus(it.ticketId);
                    if (!st || st.closed) continue;
                    next.set(it.taskId, { taskId: it.taskId, dir: it.dir, root: it.root, ticketId: it.ticketId, demand: { status: st.status, assigned_to: st.assigned_to || null, checked_at: new Date(st.at).toISOString() } });
                }
            }));
            const changed = next.size !== archivedOpen.size || [...next.keys()].some(k => !archivedOpen.has(k))
                || [...next.values()].some(v => archivedOpen.get(v.taskId)?.demand.status !== v.demand.status);
            archivedOpen = next;
            archivedScanAt = Date.now();
            if (changed) broadcast({ type: 'runs_changed' });
            return next;
        })().finally(() => { archivedScan = null; });
        return archivedScan;
    }

    function archivedRun(taskId) {
        const a = archivedOpen.get(taskId);
        return a && fs.existsSync(a.dir) ? { taskId, dir: a.dir, root: a.root, copies: 1, archived: true, demand: a.demand } : null;
    }
    // ---------------------------------------------------------------------------
    // Pré-task: spec da descrição do ticket rejeitada ANTES do /fetch-ticket, com draft
    // do auto-repair (scripts/lib/spec-repairer.js) aguardando aprovação. Ainda não há
    // state.json — o watcher só guarda a pendência no gate file — então o dashboard
    // monta um run sintético, só leitura, com id "<ticket>-spec-gate". Some sozinho
    // quando a pendência acaba ou quando surge um run de verdade do ticket (aí é o
    // state.json dele que carrega spec_pending_approval).
    function pretaskRuns() {
        let names = [];
        try { names = fs.readdirSync(memoryDir); } catch { return []; }
        const withRun = new Set();
        const reg = readRegistry();
        for (const [taskId, candidates] of collectCandidates()) {
            if (archivedAway(taskId, candidates, reg)) continue;
            const chosen = pickCandidate(taskId, candidates);
            const id = chosen && ticketIdOf(taskId, readJson(path.join(chosen.dir, 'state.json')));
            if (id) withRun.add(id);
        }
        const out = [];
        for (const name of names) {
            const m = SPEC_GATE_FILE_RE.exec(name);
            if (!m || withRun.has(Number(m[1]))) continue;
            const gate = readJson(path.join(memoryDir, name));
            const pending = gate?.spec_pending_approval;
            const ticketId = Number(m[1]);
            const taskId = `${ticketId}${PRETASK_SUFFIX}`;
            const dispatched = fetchDispatchOf(gate);
            if (dispatched && !(gate?.status === 'spec-pending-approval' && pending)) {
                // /fetch-ticket despachado, state.json ainda não criado pelo agente.
                out.push({
                    taskId, pretask: true, copies: 1,
                    dir: path.join(memoryDir, taskId),
                    root: { label: 'pretask', dir: memoryDir },
                    state: {
                        task_id: taskId, node: 'fetch_ticket', history: [], status: 'running',
                        redmine_ticket: { id: ticketId, ...(typeof gate.subject === 'string' ? { subject: gate.subject } : {}) },
                        updated_at: dispatched.started_at, started_at: dispatched.started_at,
                        node_started_at: dispatched.started_at,
                        ...(Number(dispatched.timeout_ms) > 0 ? { node_timeout_ms: Number(dispatched.timeout_ms) } : {}),
                    },
                });
                continue;
            }
            if (gate?.status === 'spec-draft') {
                // Spec rascunho (draft: true) gerada pelo watcher, esperando revisão humana.
                const since = gate.spec_draft?.since || gate.checked_at || null;
                out.push({
                    taskId, pretask: true, copies: 1,
                    dir: path.join(memoryDir, taskId),
                    root: { label: 'pretask', dir: memoryDir },
                    state: {
                        task_id: taskId, node: 'fetch_ticket', history: [], status: 'spec-draft',
                        redmine_ticket: { id: ticketId, ...(typeof gate.subject === 'string' ? { subject: gate.subject } : {}) },
                        spec_draft: {
                            spec_path: `memory/spec/${ticketId}-spec.md`, since,
                            ai_sections: Array.isArray(gate.spec_draft?.ai_sections) ? gate.spec_draft.ai_sections.filter(k => typeof k === 'string') : [],
                        },
                        updated_at: gate.checked_at || since, started_at: since,
                    },
                });
                continue;
            }
            if (gate?.status !== 'spec-pending-approval' || !pending || typeof pending !== 'object') continue;
            out.push({
                taskId, pretask: true, copies: 1,
                // Diretório que não existe: contexto/log saem vazios; nada escreve nele.
                dir: path.join(memoryDir, taskId),
                root: { label: 'pretask', dir: memoryDir },
                state: {
                    task_id: taskId, node: 'fetch_ticket', history: [], status: 'spec-pending-approval',
                    redmine_ticket: { id: ticketId, ...(typeof gate.subject === 'string' ? { subject: gate.subject } : {}) },
                    spec_pending_approval: pending,
                    updated_at: gate.checked_at || pending.posted_at || null,
                    started_at: pending.posted_at || null,
                },
            });
        }
        // PRI-233 (PRI-205 S4, T9 / diretriz R-6 n.º 7): admissão recusada por roteamento
        // ON com configuração inválida. O watcher guarda os tickets barrados no marcador do
        // projeto (memory/runs/routing-admission-blocked.json); cada um sem run vira uma
        // pré-task bloqueada, só leitura. Some quando o marcador sai (config corrigida).
        const blocked = readJson(path.join(memoryDir, 'routing-admission-blocked.json'));
        if (blocked && typeof blocked.cause === 'string' && Array.isArray(blocked.tickets)) {
            for (const ticketId of blocked.tickets) {
                if (!Number.isInteger(ticketId) || withRun.has(ticketId)) continue;
                const taskId = `${ticketId}${PRETASK_SUFFIX}`;
                if (out.some(r => r.taskId === taskId)) continue;
                out.push({
                    taskId, pretask: true, copies: 1,
                    dir: path.join(memoryDir, taskId),
                    root: { label: 'pretask', dir: memoryDir },
                    state: {
                        task_id: taskId, node: 'fetch_ticket', history: [], status: 'blocked',
                        redmine_ticket: { id: ticketId },
                        routing_admission_blocked: {
                            cause: blocked.cause,
                            detail: typeof blocked.detail === 'string' ? blocked.detail : null,
                            transient: blocked.transient === true,
                            first_blocked_at: typeof blocked.first_blocked_at === 'string' ? blocked.first_blocked_at : null,
                            notified_at: typeof blocked.notified_at === 'string' ? blocked.notified_at : null,
                        },
                        updated_at: blocked.first_blocked_at || null, started_at: blocked.first_blocked_at || null,
                    },
                });
            }
        }
        return out;
    }
    // Marcador gravado pelo watcher ao despachar o /fetch-ticket (gate.fetch_dispatch).
    // Mesma regra do watcher (nodeLease.fetchDispatchLive): com agent_pid, vivo enquanto
    // o agente vive; sem pid, o despacho não chegou ao agente (o ▶ Disparar cai na
    // reserva do ticket se ainda estiver em curso); marcador legado vence no timeout.
    function fetchDispatchOf(gate) {
        return nodeLease.fetchDispatchLive(gate);
    }
    function pretaskRun(taskId) {
        if (typeof taskId !== 'string' || !taskId.endsWith(PRETASK_SUFFIX)) return null;
        return pretaskRuns().find(r => r.taskId === taskId) || null;
    }

    function summarizeAny(run) {
        const out = summarize(run);
        if (run.archived) { out.archived = true; out.demand = run.demand; out.pendingHumanInput = false; }
        return out;
    }

    function listRuns() {
        syncWatchedRoots();
        const runs = [];
        const reg = readRegistry();
        const seen = new Set();
        for (const [taskId, candidates] of collectCandidates()) {
            if (archivedAway(taskId, candidates, reg)) continue;
            const chosen = pickCandidate(taskId, candidates);
            if (chosen) { runs.push(summarize({ ...chosen, copies: candidates.length })); seen.add(taskId); }
        }
        for (const taskId of archivedOpen.keys()) {
            const run = !seen.has(taskId) && !reg[taskId] && archivedRun(taskId);
            if (run) runs.push(summarizeAny(run));
        }
        for (const run of pretaskRuns()) if (!seen.has(run.taskId)) runs.push(summarize(run));
        return runs.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    }

    function readContext(dir) {
        try { return fs.readFileSync(path.join(dir, 'context.md'), 'utf8'); } catch { return ''; }
    }

    function tail(text, n) {
        const lines = text.split('\n');
        return lines.slice(Math.max(0, lines.length - n)).join('\n');
    }

    // Caminho do log bruto do agente (claude -p) pra um run — scripts/readmine-watcher.js
    // > logPathFor/spawnAgent/spawnAgentDetached grava em RUNS_DIR/<ticketId>.log, e
    // RUNS_DIR é sempre REPO_PATH/memory/runs (raiz principal do checkout, nunca o
    // worktree do ticket — ver .env > REPO_PATH). Por isso usa `memoryDir` (root
    // "main") direto, não `run.root.dir` (que pode ser a cópia de um worktree). Task
    // ad-hoc sem ticket (ticketId null) nunca teve agente despachado pelo watcher —
    // não existe log.
    function ticketLogPath(ticketId) {
        return ticketId != null ? path.join(memoryDir, `${ticketId}.log`) : null;
    }

    // ---------------------------------------------------------------------------
    // HTTP
    const app = express();
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server, verifyClient: ({ req }) => isLocalRequest(req) });

    // Sem auth, então bloqueia DNS rebinding / páginas de terceiros falando com a porta.
    function isLocalHost(value) {
        if (!value) return false;
        let host = value;
        try { host = new URL(value.includes('://') ? value : `http://${value}`).hostname; } catch { return false; }
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    }
    // Sem aprovador (decisão de 2026-11-06), este filtro é a única fronteira das ações:
    // - Origin, quando vier, tem de ser local E na MESMA porta do Dashboard. Outra página
    //   do localhost (ex.: dev server em :5173) não fala com ele (revisão do Checkpoint B,
    //   MAJOR-1: POST "simples" sem preflight escrevia).
    // - Escrita com Sec-Fetch-Site diferente de same-origin/none é recusada. GET não, para
    //   não quebrar abrir o Dashboard por um link (navegação cross-site).
    const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    function sameDashboardPort(origin, req) {
        let u;
        try { u = new URL(origin); } catch { return false; }
        const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
        return Number.isInteger(req.socket?.localPort) && port === req.socket.localPort;
    }
    function isLocalRequest(req) {
        if (!isLocalHost(req.headers.host)) return false;
        const origin = req.headers.origin;
        if (origin && (!isLocalHost(origin) || !sameDashboardPort(origin, req))) return false;
        const site = req.headers['sec-fetch-site'];
        if (WRITE_METHODS.has(req.method) && site && site !== 'same-origin' && site !== 'none') return false;
        return true;
    }

    app.disable('x-powered-by');
    // Saúde pra monitoramento: registrado antes do filtro de localhost de propósito.
    // Só contadores — nada de caminho, env ou header.
    const startedAt = Date.now();
    let lastFileChange = null;
    app.get('/api/status', (req, res) => res.json({
        uptime_ms: Date.now() - startedAt,
        ws_clients: wss.clients.size,
        last_file_change: lastFileChange,
        runs_tracked: collectCandidates().size,
    }));
    app.use((req, res, next) => (isLocalRequest(req) ? next() : res.status(403).json({ error: 'somente localhost' })));
    app.use(express.json({ limit: '100kb' }));
    app.use(express.static(path.join(__dirname, 'public')));
    const coordination = createCoordination({ env, broadcast, redact: redactDeep });
    app.get('/api/coordination', (req, res) => {
        coordination.read().then(result => res.json(result))
            .catch(() => res.status(500).json({ error: 'não foi possível ler o estado de coordenação' }));
    });

    // Medição sombra would_route (PRI-223 / dashboard): contagem por faixa, economia
    // potencial vs Opus-only, lista recente. Lê cost_tracking bruto; não aplica S4.
    app.get('/api/would-route-metrics', (req, res) => {
        try {
            const recentLimit = req.query.limit != null ? Number(req.query.limit) : undefined;
            const feeds = [];
            const reg = readRegistry();
            for (const [taskId, candidates] of collectCandidates()) {
                if (archivedAway(taskId, candidates, reg)) continue;
                const chosen = pickCandidate(taskId, candidates);
                if (!chosen) continue;
                const state = stateWriter.read(chosen.dir) || readJson(path.join(chosen.dir, 'state.json'));
                feeds.push({
                    taskId,
                    ticketId: ticketIdOf(taskId, state),
                    updatedAt: state?.updated_at || null,
                    cost_tracking: state?.cost_tracking || null,
                });
            }
            res.json(redactDeep(buildWouldRouteMetrics(feeds, { recentLimit })));
        } catch (e) {
            res.status(500).json({ error: redact(e.message) });
        }
    });

    // Telas de roteamento de modelo (PRI-205; SPEC das telas, T4). Só leitura. Config e
    // policy vigentes, snapshot de cada Run e NOT_STARTED vêm dos MESMOS leitores do
    // watcher, por processo: scripts/routing-read.js (regra G3: o dashboard não importa
    // scripts/lib; mesmo padrão do replay-cycle.js). Snapshot da Run nunca é relido da
    // config corrente. A projeção (routing-projection.js) só deixa sair campos
    // permitidos: sem caminhos locais. Snapshot íntegro é imutável e fica em cache pela
    // ligação; NOT_STARTED, pelo mtime da pasta de Attempts do DOM-06 da Run. Um processo
    // por requisição, só com o que não está em cache (a config é sempre relida).
    const routingReadScript = options.routingReadScript || ROUTING_READ_SCRIPT;
    const routingSnapshotCache = new Map();
    const routingNotStartedCache = new Map();
    const ROUTING_CACHE_MAX = 2000;
    function cachePut(cache, key, value) {
        if (cache.size >= ROUTING_CACHE_MAX) cache.clear();
        cache.set(key, value);
    }
    function runRoutingRead(input) {
        return new Promise(resolve => {
            const child = execFile(process.execPath, [routingReadScript, '--json'],
                { cwd: repoRoot, env: consumerEnv, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
                (err, stdout) => {
                    let out = null;
                    try { out = JSON.parse(stdout); } catch { out = null; }
                    if (err || !out || out.ok !== true) {
                        if (err || out?.error) console.error(`[dashboard] routing-read: ${redact(out?.error || err?.message || 'sem saída')}`);
                        return resolve(null);
                    }
                    resolve(out);
                });
            child.on('error', () => resolve(null));
            child.stdin.on('error', () => {});
            child.stdin.end(JSON.stringify(input));
        });
    }
    const ROUTING_LIMIT_DEFAULT = 100;
    const ROUTING_LIMIT_MAX = 500;
    app.get('/api/routing', async (req, res) => {
        let limit = ROUTING_LIMIT_DEFAULT;
        if (req.query.limit != null) {
            const n = Number(req.query.limit);
            if (!Number.isInteger(n) || n < 1 || n > ROUTING_LIMIT_MAX) {
                return res.status(400).json({ error: `limit deve ser inteiro entre 1 e ${ROUTING_LIMIT_MAX}` });
            }
            limit = n;
        }
        // ?task=<task-id>: só aquela Run (bloco "Roteamento" do detalhe da Run, T7).
        const onlyTask = req.query.task != null ? String(req.query.task) : null;
        if (onlyTask != null && !isRunDirName(onlyTask)) return res.status(400).json({ error: 'task inválida' });
        try {
            // 1) Lê os state.json e decide o que o leitor precisa buscar (cache vazio).
            const entries = [];
            const toRead = [];
            const reg = readRegistry();
            for (const [taskId, candidates] of collectCandidates()) {
                if (onlyTask != null && taskId !== onlyTask) continue;
                if (archivedAway(taskId, candidates, reg)) continue;
                const chosen = pickCandidate(taskId, candidates);
                if (!chosen) continue;
                let state = null;
                try { state = stateWriter.read(chosen.dir) || readJson(path.join(chosen.dir, 'state.json')); } catch { state = null; }
                const entry = { taskId, dir: path.resolve(chosen.dir), state };
                entries.push(entry);
                const binding = state && typeof state === 'object' ? state.routing_snapshot : null;
                if (!binding) continue;
                const fetchRunDir = path.join(path.dirname(entry.dir), '_dom06');
                // mtime e tamanho do arquivo do Attempt de admissão na chave: adulteração
                // depois da 1ª leitura invalida o cache (revisão do Checkpoint B, MINOR-1).
                let fileSig = 'absent';
                if (typeof binding.attempt_id === 'string' && /^[0-9a-f-]{36}$/i.test(binding.attempt_id)) {
                    try {
                        const st = fs.statSync(path.join(fetchRunDir, 'dom06', 'attempts', `${binding.attempt_id}.json`));
                        fileSig = `${st.mtimeMs}:${st.size}`;
                    } catch { fileSig = 'absent'; }
                }
                entry.snapKey = `${fetchRunDir}|${binding.attempt_id}|${binding.sha256}|${fileSig}`;
                let mtime = null;
                try { mtime = fs.statSync(path.join(entry.dir, 'dom06', 'attempts')).mtimeMs; } catch { mtime = null; }
                entry.nsKey = mtime == null ? null : `${entry.dir}|${mtime}`;
                const needSnap = !routingSnapshotCache.has(entry.snapKey);
                const needNs = entry.nsKey != null && !routingNotStartedCache.has(entry.nsKey);
                if (needSnap || needNs) toRead.push({ key: taskId, run_dir: entry.dir, binding, not_started: needNs });
            }
            // 2) Um processo do leitor do dono (config sempre; Runs só o que faltou).
            const read = await runRoutingRead({ repo_root: path.resolve(repoRoot), runs: toRead });
            const config = routingProjection.projectConfig(read ? read.config : null);
            const admission_blocked = routingProjection.projectAdmissionBlocked(readJson(path.join(memoryDir, 'routing-admission-blocked.json')));
            // 3) Projeta.
            const runs = [];
            const modelRows = [];
            const shadowRows = [];
            const shadowSummary = { SAME: 0, REAL_HIGHER: 0, REAL_LOWER: 0, UNKNOWN: 0 };
            for (const { taskId, dir, state, snapKey, nsKey } of entries) {
                const ticketId = ticketIdOf(taskId, state);
                const updatedAt = typeof state?.updated_at === 'string' ? state.updated_at : null;
                const unknownRow = error => ({ task_id: taskId, ticket_id: Number.isInteger(ticketId) ? ticketId : null, mode: 'UNKNOWN', error, updated_at: updatedAt });
                if (!state || typeof state !== 'object') { runs.push(unknownRow('STATE_UNREADABLE')); continue; }
                try {
                    const fresh = read?.runs?.[taskId];
                    let snapshotResult;
                    if (snapKey) {
                        snapshotResult = routingSnapshotCache.get(snapKey) || fresh?.snapshot;
                        if (snapshotResult?.ok === true) cachePut(routingSnapshotCache, snapKey, snapshotResult);
                    }
                    let notStarted = null;
                    if (snapKey) {
                        if (nsKey == null) notStarted = [];
                        else if (routingNotStartedCache.has(nsKey)) notStarted = routingNotStartedCache.get(nsKey);
                        else if (Array.isArray(fresh?.attempts)) {
                            notStarted = routingProjection.projectNotStarted(fresh.attempts);
                            cachePut(routingNotStartedCache, nsKey, notStarted);
                        } else notStarted = 'UNKNOWN';
                    }
                    const run = routingProjection.projectRun({ taskId, ticketId, state, current: config, snapshotResult });
                    const models = routingProjection.projectAttemptModels(state.cost_tracking);
                    const shadow = routingProjection.projectShadowVsReal(state.cost_tracking);
                    modelRows.push(...models);
                    for (const k of Object.keys(shadowSummary)) shadowSummary[k] += shadow.summary[k];
                    shadowRows.push(...shadow.rows.map(r => ({ task_id: run.task_id, ...r })));
                    runs.push({ ...run, updated_at: updatedAt, models, not_started: run.mode === 'OFF' ? null : notStarted });
                } catch {
                    runs.push(unknownRow('PROJECTION_FAILED'));
                }
            }
            runs.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
            res.json(redactDeep({
                generated_at: new Date().toISOString(),
                // Leitor fora do ar: config e snapshots ficam UNKNOWN (nunca OFF).
                reader: read ? 'OK' : 'FAILED',
                config,
                admission_blocked,
                runs_total: runs.length,
                runs: runs.slice(0, limit),
                mix: routingProjection.buildMix(modelRows),
                shadow_vs_real: { summary: shadowSummary, rows: shadowRows },
            }));
        } catch (e) {
            // Sem e.message na resposta: erro de E/S cita caminho local (critério 7 da
            // SPEC; revisão do Checkpoint B, MINOR-7). O detalhe vai só para o log.
            console.error(`[dashboard] /api/routing: ${redact(e.message)}`);
            res.status(500).json({ error: 'falha ao ler o roteamento' });
        }
    });

    function withRun(req, res) {
        // Run ativo primeiro; senão, um arquivado com demanda aberta (só leitura).
        const run = resolveRun(req.params.taskId) || (isRunDirName(req.params.taskId) ? archivedRun(req.params.taskId) || pretaskRun(req.params.taskId) : null);
        if (!run) {
            res.status(404).json({ error: `run não encontrado: ${req.params.taskId}` });
            return null;
        }
        return run;
    }

    // Cotação USD→BRL pra exibir cost_tracking.*.cost_usd em reais (o watcher grava só
    // US$; a conversão é na exibição, com a cotação do dia). USD_BRL no .env fixa a taxa;
    // senão, PTAX de venda do Banco Central (último boletim dos últimos 7 dias), em cache
    // por 6 h. Falha de rede devolve o último valor obtido; sem nenhum, rate=null e o
    // front mostra só US$. Só a data vai na URL — nada do projeto sai daqui.
    const FX_TTL_MS = 6 * 60 * 60 * 1000;
    let fxCache = null;
    async function usdBrl() {
        const fixed = Number(String(consumerEnv.USD_BRL || '').replace(',', '.'));
        if (fixed > 0) return { rate: fixed, source: 'USD_BRL (.env)', date: null };
        if (fxCache && Date.now() - fxCache.fetchedAt < FX_TTL_MS) return fxCache.value;
        const mdY = d => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getFullYear()}`;
        const end = new Date(), start = new Date(Date.now() - 7 * 86400000);
        const url = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/' +
            'CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)' +
            `?@dataInicial='${mdY(start)}'&@dataFinalCotacao='${mdY(end)}'` +
            '&$format=json&$orderby=dataHoraCotacao%20desc&$top=1';
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const row = (await r.json()).value?.[0];
            if (!(row?.cotacaoVenda > 0)) throw new Error('sem cotação no período');
            const value = { rate: row.cotacaoVenda, source: 'PTAX venda (Banco Central)', date: String(row.dataHoraCotacao).slice(0, 10) };
            fxCache = { value, fetchedAt: Date.now() };
            return value;
        } catch (e) {
            if (fxCache) return { ...fxCache.value, stale: true };
            return { rate: null, source: null, date: null, error: `cotação indisponível (${e.message})` };
        }
    }
    app.get('/api/fx', async (req, res) => res.json(await usdBrl()));

    // Tickets Redmine abertos atribuídos ao usuário (aba "Meus Tickets"). Cache de
    // 30s (mesmo espírito do fxCache acima) pra não bater no Redmine a cada poll do
    // front nem a cada clique manual de atualizar. REDMINE_USER_ID (se setada) só
    // entra num log de auditoria — nunca na chamada à API, que já resolve "eu" via
    // assigned_to_id=me.
    const TICKETS_MINE_TTL_MS = 30 * 1000;
    let ticketsMineCache = null;
    async function ticketsMine() {
        if (ticketsMineCache && Date.now() - ticketsMineCache.fetchedAt < TICKETS_MINE_TTL_MS) {
            return ticketsMineCache.value;
        }
        const value = await fetchAssignedTickets();
        ticketsMineCache = { value, fetchedAt: Date.now() };
        if (consumerEnv.REDMINE_USER_ID) {
            console.log(`[dashboard] /api/tickets/mine consultado (REDMINE_USER_ID=${consumerEnv.REDMINE_USER_ID}, ${value.length} ticket(s))`);
        }
        return value;
    }
    app.get('/api/tickets/mine', async (req, res) => res.json(await ticketsMine()));

    // ---------------------------------------------------------------------------
    // Aba "Redmine": tickets atribuídos (mesma fonte/cache de /api/tickets/mine)
    // enriquecidos com o run vinculado e o PR dele, detalhe com journals, e escrita
    // direta no Redmine (status / nota). Toda mensagem de erro passa por redact() —
    // a key nunca sai em resposta nem em log.
    //
    // Run vinculado: entre os runs do ticket (listRuns, já ordenado do mais recente),
    // o primeiro ainda não concluído; senão o mais recente. PR: o do run vinculado;
    // se ele não tem, o do run mais recente do ticket que tenha PR.
    function linkedRunFor(ticketId, runsList) {
        const mine = runsList.filter(r => r.ticketId === ticketId);
        if (!mine.length) return { linkedRun: null, prUrl: null };
        const linked = mine.find(r => r.kind !== 'completed') || mine[0];
        const prUrl = linked.pr_url || mine.find(r => r.pr_url)?.pr_url || null;
        return {
            linkedRun: { taskId: linked.taskId, status: linked.status, node: linked.node, kind: linked.kind, updatedAt: linked.updatedAt },
            prUrl,
        };
    }
    const redmineIssueUrl = id => {
        const base = (consumerEnv.REDMINE_URL || '').replace(/\/+$/, '');
        return base ? `${base}/issues/${id}` : null;
    };
    function ticketsError(res, e) {
        const status = [400, 403, 404, 422, 503].includes(e?.status) ? e.status : 502;
        res.status(status).json({ error: redact(e?.message || 'falha falando com o Redmine') });
    }

    app.get('/api/tickets', async (req, res) => {
        const list = await ticketsMine();
        const runsList = listRuns();
        res.json(list.map(t => ({ ...t, url: redmineIssueUrl(t.id), ...linkedRunFor(t.id, runsList) })));
    });

    // Registrado antes de /api/tickets/:id (senão "statuses" cairia no :id).
    app.get('/api/tickets/statuses', async (req, res) => {
        try { res.json(await listIssueStatuses()); } catch (e) { ticketsError(res, e); }
    });

    app.get('/api/tickets/:id', async (req, res) => {
        if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id de ticket inválido' });
        try {
            const ticket = await getTicketDetail(req.params.id);
            const { journals, ...rest } = ticket;
            res.json({ ticket: { ...rest, url: redmineIssueUrl(ticket.id) }, journals, ...linkedRunFor(Number(req.params.id), listRuns()) });
        } catch (e) { ticketsError(res, e); }
    });

    // Depois de escrever no Redmine, o cache de 30s da lista fica velho — invalida
    // pra próxima leitura (auto-refresh ou atualização da linha) já vir com o novo status.
    app.put('/api/tickets/:id/status', async (req, res) => {
        if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id de ticket inválido' });
        const { statusId, note } = req.body || {};
        try {
            await updateTicketStatus(req.params.id, statusId, note);
            ticketsMineCache = null;
            res.json({ ok: true });
        } catch (e) { ticketsError(res, e); }
    });

    app.post('/api/tickets/:id/note', async (req, res) => {
        if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id de ticket inválido' });
        try {
            await addJournalNote(req.params.id, req.body?.note);
            ticketsMineCache = null;
            res.json({ ok: true });
        } catch (e) { ticketsError(res, e); }
    });

    app.get('/api/runs', (req, res) => res.json(listRuns()));

    // "▶ Disparar" na aba "Meus Tickets": dispara fetch_ticket+plan pra um ticket que
    // ainda não tem run. Reaproveita scripts/lib/node-dispatcher.js (dispatchNode),
    // a MESMA função usada por scripts/replay-cycle.js e, no fundo, pelo tick normal
    // do watcher (dispatchTicket) — não reimplementa gates (spec, branch liberação,
    // pergunta pré-task) nem cria state.json à mão (quem cria é o próprio fetch_ticket).
    //
    // Sem `follow`, dispatchNode devolve rápido: o processo do Claude é destacado
    // (spawnAgent, readmine-watcher.js) e a chamada não espera o ciclo terminar. Por
    // isso a resposta de sucesso NÃO tem runId ainda — o front faz um polling curto
    // em GET /api/runs até a run aparecer (ver dashboard/public/views.js).
    const startingTickets = new Set();
    app.post('/api/runs/start', async (req, res) => {
        const ticketId = String(req.body?.ticketId ?? '').trim();
        if (!/^\d+$/.test(ticketId)) return res.status(400).json({ error: 'ticketId inválido' });
        const id = Number(ticketId);

        // POST raro: relê os roots do disco antes da guarda — run que o chokidar ainda
        // não reportou ficaria fora do cache e um segundo agente subiria pro mesmo ticket.
        for (const { root } of [...runsCache.values()]) cacheRoot(root);
        const active = listRuns().find(r => r.ticketId === id && r.kind !== 'completed');
        if (active) return res.status(409).json({ error: 'run já ativa para este ticket', runId: active.taskId });

        if (startingTickets.has(id)) return res.status(409).json({ error: 'disparo já em andamento para este ticket' });
        startingTickets.add(id);
        try {
            const result = await dispatchTicketNode({ ticketId: id, follow: false });
            if (result.action === 'dispatched' || result.action === 'dry-run') {
                return res.json({ ok: true, ticketId: id, runId: null, pending: true });
            }
            if (result.action === 'skip' && result.reason === 'recusa_qa_aguardando_retry') {
                return res.status(409).json({ error: 'run já ativa para este ticket', runId: result.taskId });
            }
            // Outro processo (watcher, outra aba/retomada) está despachando este ticket
            // agora, ou o fetch_ticket+plan dele ainda roda (PRI-218).
            if (result.action === 'skip' && ['despacho_reservado', 'fetch_em_execucao'].includes(result.reason)) {
                return res.status(409).json({ error: 'disparo já em andamento para este ticket', runId: result.taskId || null });
            }
            if (result.action === 'skip') {
                const messages = {
                    branch_liberacao_invalida: 'Ticket sem o campo "Branch Liberação" reconhecido no Redmine.',
                    spec_aguardando_aceite: 'Descrição do ticket incompleta — precisa ser aceita no Redmine antes.',
                    spec_aguardando_aprovacao: 'Descrição do ticket incompleta — draft aguardando aprovação no Redmine.',
                    spec_draft_gerado: 'Spec rascunho gerada do ticket (draft: true) — revise e troque para draft: false para liberar.',
                    spec_draft_aguardando_revisao: 'Spec rascunho com draft: true aguardando revisão — troque para draft: false para liberar.',
                    spec_draft_falhou: 'Falha gerando a spec rascunho do ticket — o watcher tenta de novo no próximo ciclo.',
                    pretask_pergunta_pendente: 'Há uma pergunta pré-task pendente de resposta no Redmine.',
                    worktree_indisponivel: 'Nenhum worktree livre no momento — tente de novo em instantes.',
                    ja_tratado_neste_ciclo: 'Este ticket já foi tratado neste ciclo (nenhuma mudança nova desde o último commit).',
                    recusa_qa_sem_comentarios: 'Ticket em Recusa QA sem comentário explicando o motivo — não há o que corrigir automaticamente.',
                    // PRI-233: roteamento de modelo (mode ON).
                    routing_admission_blocked: 'Roteamento de modelo ligado com configuração inválida — corrija .claude/model-routing.json (ou use mode OFF) para admitir Runs novas.',
                    routing_not_started: 'Roteamento de modelo ligado: o despacho roteado não pôde iniciar (NOT_STARTED) — veja o motivo no Redmine ou no Attempt.',
                };
                return res.status(422).json({ error: messages[result.reason] || `não foi possível disparar (${result.reason})` });
            }
            return res.status(502).json({ error: 'Redmine indisponível ou resposta inesperada do orquestrador' });
        } catch (e) {
            return res.status(502).json({ error: `falha disparando o ticket: ${redact(e.message)}` });
        } finally {
            startingTickets.delete(id);
        }
    });

    // Export agregado de memory/runs/ (scripts/lib/runs-exporter.js) — botão "⬇ Exportar
    // Relatório" do header. Sempre stream com download direto (nunca inline no browser):
    // o relatório pode crescer bastante com o histórico completo de runs.
    app.get('/api/export', async (req, res) => {
        let result;
        try {
            result = await runsExporter.exportRuns({
                repoPath: repoRoot,
                since: typeof req.query.since === 'string' ? req.query.since : undefined,
                incremental: req.query.incremental === '1' || req.query.incremental === 'true',
            });
        } catch (e) {
            return res.status(500).json({ error: `export falhou: ${e.message}` });
        }
        const pretty = req.query.pretty === '1' || req.query.pretty === 'true';
        const json = JSON.stringify(result.report, null, pretty ? 4 : 0);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="runs-report-${result.report.exportedAt.slice(0, 10)}.json"`);
        res.send(json);
    });

    // Knowledge Graph (memory/knowledge-graph.json do checkout principal, gravado pelo
    // watcher e pelo /commit). Sem filtro devolve tudo; ?taskId= (43425, TASK-43425 ou
    // 43425-slug) ou ?file= recortam o subgrafo. `tickets` já vem montado como
    // ticket → spec → [arquivos] → PRs pra aba Grafo não refazer a travessia.
    app.get('/api/graph', (req, res) => {
        let graph;
        try { graph = knowledgeGraph.readGraph(graphPath); }
        catch (e) { return res.status(500).json({ error: `knowledge-graph.json ilegível: ${e.message}` }); }
        const taskId = typeof req.query.taskId === 'string' ? req.query.taskId.trim() : '';
        const file = typeof req.query.file === 'string' ? req.query.file.trim() : '';
        let sub = graph;
        if (taskId) sub = knowledgeGraph.subgraphForTicket(graph, taskId);
        if (file) {
            const byFile = knowledgeGraph.subgraphForFile(graph, file, repoRoot);
            sub = taskId
                ? { nodes: Object.fromEntries(Object.entries(sub.nodes).filter(([id]) => id in byFile.nodes)), edges: sub.edges.filter(e => e.from in byFile.nodes) }
                : byFile;
        }
        const tickets = Object.entries(sub.nodes).filter(([, n]) => n.type === 'ticket').map(([id, n]) => {
            const out = sub.edges.filter(e => e.from === id);
            const to = rel => out.filter(e => e.rel === rel).map(e => ({ id: e.to, at: e.at, ...(sub.nodes[e.to] || graph.nodes[e.to] || {}) }));
            return { id, ...n, specs: to('generated_spec'), files: to('touched_file'), prs: to('opened_pr') };
        }).sort((a, b) => (b.ticket_id || 0) - (a.ticket_id || 0));
        res.json(redactDeep({
            version: graph.version, updatedAt: graph.updatedAt, filter: { taskId: taskId || null, file: file || null },
            exists: fs.existsSync(graphPath), nodes: sub.nodes, edges: sub.edges, tickets,
        }));
    });

    // memory/patterns.md (scripts/memory-consolidator.js) pra aba "Padrões" — arquivo
    // + metadata de quando/quantos runs a última consolidação analisou. Sem token
    // real esperado aqui, mas passa por redact() por consistência com a regra
    // inviolável de nunca deixar secret escapar por resposta HTTP.
    app.get('/api/patterns', (req, res) => {
        const exists = fs.existsSync(patternsPath);
        let content = null;
        let updatedAt = null;
        if (exists) {
            try {
                content = redact(fs.readFileSync(patternsPath, 'utf8'));
                updatedAt = fs.statSync(patternsPath).mtime.toISOString();
            } catch (e) {
                return res.status(500).json({ error: `patterns.md ilegível: ${e.message}` });
            }
        }
        const counterState = readJson(consolidatorStatePath) || {};
        res.json({
            exists, content, updatedAt,
            lastConsolidationAt: counterState.last_run_at ?? null,
            totalConsolidations: counterState.total_consolidations ?? 0,
            completedRunsAtLastRun: counterState.completed_runs_at_last_run ?? null,
        });
    });

    // Força a varredura dos arquivados (botão Atualizar). Respeita o cache por ticket.
    app.post('/api/archived-open/refresh', async (req, res) => {
        try { const m = await scanArchivedOpen(); res.json({ ok: true, count: m.size, scanned_at: new Date(archivedScanAt).toISOString() }); }
        catch (e) { res.status(500).json({ error: redact(e.message) }); }
    });

    // Validade dos artefatos derivados da spec (scripts/invalidate.js describe): por fase
    // (trilho de nós: badge ⚠ STALE), por AC (RunDetail: "Evidence produzida contra Spec
    // v1. Spec atual: v2.") e UNKNOWN como "legado sem versão". Só hashes/versões/status.
    function runValidity(run, state) {
        try { return redactDeep(invalidate.describe(state, { evidenceData: invalidate.readEvidence(run.dir), runDir: run.dir })); } catch { return null; }
    }

    // Versão leve para o polling do dashboard (public/state-version.js): só
    // { state_version, node, execution_id } — nunca o state inteiro nem segredo.
    app.get('/api/state/version', (req, res) => {
        const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
        if (!isRunDirName(taskId)) return res.status(400).json({ error: 'taskId inválido' });
        const run = resolveRun(taskId);
        if (!run) return res.status(404).json({ error: `run não encontrado: ${taskId}` });
        const state = stateWriter.read(run.dir);
        if (!state) return res.status(404).json({ error: 'state.json ausente ou inválido' });
        res.json({ state_version: cas.effectiveVersion(state), node: state.node ?? null, execution_id: state.execution_id ?? null });
    });

    app.get('/api/runs/:taskId', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const summary = summarizeAny(run);
        if (!summary.state) return res.status(404).json({ error: 'state.json ausente ou inválido' });
        res.json({ ...summary, validity: runValidity(run, summary.state), context: redact(readContext(run.dir)) });
    });

    app.get('/api/runs/:taskId/validity', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const state = readRunState(run);
        if (!state) return res.status(404).json({ error: 'state.json ausente ou inválido' });
        res.json(runValidity(run, state));
    });

    // Comparação lado a lado (scripts/lib/run-comparator.js, botão "Comparar" da lista).
    // :taskId aceita <task-id> ou <task-id>%2Fstate-replay-<id>.json. O diretório sai
    // da mesma resolução do resto do dashboard (worktree do ticket primeiro); run fora
    // dela (memory/runs/_archive, memory/archive/<YYYY-MM>) cai no locator da lib.
    // Só leitura.
    function compareRunOf(ref) {
        const parsed = runComparator.parseRunRef(ref);
        const run = resolveRun(parsed.taskId) || archivedRun(parsed.taskId);
        if (run && fs.existsSync(path.join(run.dir, parsed.file))) {
            return runComparator.loadRunFromDir(run.dir, { ...parsed, source: run.root?.label || null, repoPath: repoRoot });
        }
        return runComparator.loadRun(ref, { repoPath: repoRoot });
    }
    app.get('/api/compare/:taskIdA/:taskIdB', (req, res) => {
        let runA, runB;
        try {
            runA = compareRunOf(req.params.taskIdA);
            runB = compareRunOf(req.params.taskIdB);
        } catch (e) {
            return res.status(e.code === 'invalid_ref' ? 400 : 404).json({ error: redact(e.message) });
        }
        res.json(redactDeep(runComparator.compareRuns(runA, runB)));
    });

    // Checklist de migração do run: o bloco inteiro do context.md (o /log só devolve o
    // fim do arquivo). signature muda quando o watcher regenera a checklist — o front
    // usa pra descartar os checkboxes salvos no localStorage que eram da versão antiga.
    app.get('/api/runs/:taskId/schema-checklist', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const block = run.pretask ? null : schemaWatcher.extractContextChecklist(readContext(run.dir));
        const state = readRunState(run);
        res.json({
            detected: state?.schema_changes_detected === true || !!block,
            riskLevel: state?.schema_risk_level || null,
            markdown: block ? redact(block.markdown) : null,
            signature: block?.signature || null,
        });
    });

    // Contrato OpenAPI gerado pelo Plan (memory/runs/<task-id>/openapi-contract.yaml).
    // Texto puro: o front mostra o YAML como está, sem interpretar.
    app.get('/api/runs/:taskId/openapi-contract', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        let content;
        try { content = run.pretask ? null : fs.readFileSync(path.join(run.dir, OPENAPI_CONTRACT_FILE), 'utf8'); } catch { content = null; }
        if (content == null) return res.status(404).json({ error: 'run sem contrato OpenAPI (task sem endpoint ou Plan ainda não rodou)' });
        res.type('text/plain').send(redact(content));
    });

    app.get('/api/runs/:taskId/log', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const lines = Math.min(Math.max(parseInt(req.query.lines, 10) || 100, 1), 5000);
        res.json({ taskId: run.taskId, lines, log: redact(tail(readContext(run.dir), lines)) });
    });

    // context.md inteiro pro preview em Markdown (public/context-md.js). Só o arquivo da
    // pasta do run: task-id inválido ou traversal cai no 404 do withRun, e symlink que
    // aponta pra fora da pasta conta como ausente.
    app.get('/api/runs/:taskId/context', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        let markdown = null;
        if (!run.pretask) {
            try {
                const real = fs.realpathSync(path.join(run.dir, 'context.md'));
                if (path.dirname(real) === fs.realpathSync(run.dir) && fs.statSync(real).isFile()) markdown = fs.readFileSync(real, 'utf8');
            } catch { /* sem context.md */ }
        }
        res.json({ taskId: run.taskId, archived: !!run.archived, exists: markdown != null, markdown: markdown == null ? null : redact(markdown) });
    });

    // Histórico completo do log do agente (distinto do /log acima, que é o fim de
    // context.md) — linhas [watcher]/[claude] já timestampadas na escrita, ver
    // ticketLogPath. Usado pelo botão "Ver log" quando o run já terminou.
    app.get('/api/runs/:taskId/agent-log', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const logPath = ticketLogPath(ticketIdOf(run.taskId, readRunState(run)));
        if (!logPath) {
            res.type('text/plain').send('(task sem ticket Redmine — nenhum agente foi despachado pelo watcher para ela; sem log.)\n');
            return;
        }
        let content = '';
        try { content = fs.readFileSync(logPath, 'utf8'); } catch { /* ainda sem output */ }
        res.type('text/plain').send(redact(content));
    });

    // Transcrição completa de um nó (scripts/lib/transcript-writer.js) — superfície de
    // post-mortem da aba "Transcrições". :nodeId = "verify" (última tentativa, ou
    // ?attempt=N) ou "verify-2". Lista vem de state.transcripts[] (fallback:
    // transcripts/index.json, se o agente regravou state.json sem o campo). Lê .json ou
    // .json.gz. Conteúdo sensível: só local, e passa pelo redact como o resto do run.
    app.get('/api/runs/:taskId/transcript/:nodeId', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        if (run.pretask) return res.status(404).json({ error: 'ticket ainda sem task: nenhuma transcrição' });
        const m = String(req.params.nodeId).match(/^([a-z_]+?)(?:-(\d+))?$/);
        if (!m) return res.status(400).json({ error: 'nodeId inválido' });
        const node = m[1];
        const wanted = parseInt(m[2] || req.query.attempt, 10) || null;
        const state = readRunState(run);
        const list = Array.isArray(state?.transcripts) && state.transcripts.length ? state.transcripts : transcriptWriter.readIndex(run.dir);
        const forNode = list.filter(t => t && t.nodeId === node && Number.isInteger(t.attempt));
        const entry = wanted
            ? forNode.find(t => t.attempt === wanted)
            : forNode.sort((a, b) => b.attempt - a.attempt)[0];
        if (!entry) return res.status(404).json({ error: `sem transcrição do nó ${node}${wanted ? ` (tentativa ${wanted})` : ''}` });
        // path vem de state.json (gravável pelo agente): só aceita transcripts/<arquivo>.
        if (!/^transcripts\/[A-Za-z0-9._-]+\.json(\.gz)?$/.test(entry.path || '')) {
            return res.status(400).json({ error: 'caminho de transcrição inválido no state.json' });
        }
        let doc;
        try { doc = transcriptWriter.readTranscriptFile(path.join(run.dir, entry.path)); }
        catch (e) { return res.status(500).json({ error: `transcrição ilegível: ${redact(e.message)}` }); }
        if (!doc) return res.status(404).json({ error: `arquivo ausente: ${entry.path}` });
        res.json(redactDeep({
            taskId: run.taskId, nodeId: node, attempt: entry.attempt, path: entry.path, sizeBytes: entry.sizeBytes ?? null,
            attempts: forNode.map(t => t.attempt).sort((a, b) => a - b),
            metadata: doc.metadata || {},
            conversation: Array.isArray(doc.conversation) ? doc.conversation : [],
        }));
    });

    app.post('/api/runs/:taskId/message', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        if (run.archived) return res.status(409).json({ error: 'run arquivado: o watcher não lê mensagens de runs em _archive' });
        if (run.pretask) return res.status(409).json({ error: 'ticket ainda sem task: não há agente pra ler a mensagem' });
        const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
        if (!message) return res.status(400).json({ error: 'message required' });
        if (message.length > MAX_MESSAGE_CHARS) return res.status(413).json({ error: `message > ${MAX_MESSAGE_CHARS} chars` });
        const filePath = path.join(run.dir, 'human-input.md');
        // Append, não overwrite: várias mensagens antes do watcher consumir não se perdem.
        try {
            fs.appendFileSync(filePath, `## Human input — ${new Date().toISOString()}\n\n${message}\n\n`, 'utf8');
        } catch (e) {
            console.error(`[dashboard] human-input.md de ${run.taskId}: ${redact(e.message)}`);
            return res.status(500).json({ ok: false, error: 'Falha ao gravar mensagem' });
        }
        res.json({ ok: true, taskId: run.taskId, location: run.root.label, path: path.relative(repoRoot, filePath) });
    });

    // Botão "Tentar de novo" do portão de build pré-implement: roda o mesmo validador do
    // watcher (scripts/lib/build-validator.js) no worktree do ticket e grava o resultado
    // com a mesma regra (applyResult). Passou => in_progress, e o próximo tick do watcher
    // despacha o implement; falhou de novo => continua pre-build-failed com os erros novos
    // (o comentário no Redmine, se os erros mudaram, fica com o watcher). 202 na hora:
    // o resultado chega pelo WebSocket quando o state.json muda.
    app.post('/api/runs/:taskId/pre-build/retry', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        if (run.archived || run.pretask) return res.status(409).json({ error: 'run arquivado ou ainda sem task' });
        const statePath = path.join(run.dir, 'state.json');
        const state = readJson(statePath);
        if (state?.status !== 'pre-build-failed') return res.status(409).json({ error: 'o run não está parado no pré-build' });
        const ticket = (run.root.label.match(/^worktree:(\d+)$/) || [])[1];
        if (!ticket) return res.status(409).json({ error: 'run fora do worktree do ticket: não há onde compilar' });
        if (preBuildRetrying.has(run.taskId)) return res.status(409).json({ error: 'já recompilando' });
        if (aiFixes.has(run.taskId)) return res.status(409).json({ error: 'a IA está corrigindo o build' });
        const worktree = path.join(worktreesDir, ticket);
        const workspace = path.dirname(repoRoot);

        preBuildRetrying.add(run.taskId);
        const pushState = () => {
            const current = resolveRun(run.taskId);
            if (!current) return;
            const summary = summarize(current);
            if (summary.state) broadcast({ type: 'state_update', taskId: run.taskId, state: summary.state, run: summary });
        };
        pushState();
        res.status(202).json({ ok: true, taskId: run.taskId, retrying: true });

        (async () => {
            let result;
            try {
                result = await validateBuild(worktree, { siblingRepos, env: consumerEnv });
            } catch (e) {
                result = { success: false, duration: 0, errors: [`Falha rodando o validador: ${e.message}`] };
            }
            // Sobre o disco fresco, dentro do lock: o watcher pode ter mexido no meio (aceite
            // no Redmine, recompilou num tick).
            stateWriter.update(statePath, fresh => {
                if (fresh.status !== 'pre-build-failed') return cas.SKIP;
                buildValidator.applyResult(fresh, result, {
                    fingerprint: result.success || result.infraError ? null : buildValidator.worktreeFingerprint(worktree),
                    source: 'retentativa pelo dashboard',
                });
            }, { operation: 'pre_build_retry', actor: 'dashboard' });
        })().catch(e => console.error(`[dashboard] pré-build de ${run.taskId}: ${redact(e.message)}`))
            .finally(() => { preBuildRetrying.delete(run.taskId); pushState(); });
    });

    // "Aceitar churn" do detalhe: mesmo efeito de responder "aceito" no Redmine (watcher,
    // runChurnGate). As contagens atuais viram baseline (churnAccepted.counts): o arquivo
    // só escala de novo se acumular mais CHURN_THRESHOLD rodadas. O watcher despacha o
    // implement no próximo tick.
    app.post('/api/runs/:taskId/churn/accept', async (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        if (run.archived || run.pretask) return res.status(409).json({ error: 'run arquivado ou ainda sem task' });
        const statePath = path.join(run.dir, 'state.json');
        const state = readJson(statePath);
        if (state?.status !== 'churn-escalation') return res.status(409).json({ error: 'o run não está parado por churn' });
        const ticket = (run.root.label.match(/^worktree:(\d+)$/) || [])[1];
        if (!ticket) return res.status(409).json({ error: 'run fora do worktree do ticket: não há rodadas pra contar' });
        const worktree = path.join(worktreesDir, ticket);
        const taskId = run.taskId;
        let counts = {};
        try {
            if (churnDetector.resolveRef(worktree, churnDetector.roundsRef(taskId))) {
                counts = (await churnDetector.detectChurn(worktree, churnDetector.resolveThreshold(consumerEnv), {
                    anchor: churnDetector.anchorRef(taskId), head: churnDetector.roundsRef(taskId),
                })).counts;
            }
        } catch (e) {
            return res.status(500).json({ error: redact(`falha contando as rodadas: ${e.message}`) });
        }
        const at = new Date().toISOString();
        let applied = false;
        try {
            stateWriter.update(statePath, fresh => {
                if (fresh.status !== 'churn-escalation') return cas.SKIP;
                applied = true;
                Object.assign(fresh, { status: 'in_progress', churnAccepted: { at, by: 'dashboard', counts }, updated_at: at });
                fresh.events = [...(Array.isArray(fresh.events) ? fresh.events : []),
                    { type: 'churn_accepted', node: 'implement', ts: at, at, detail: 'aceito pelo dashboard' }];
            }, { operation: 'churn_accept', actor: 'dashboard', expect: humanExpect(req, state) });
        } catch (e) {
            if (sendConflict(res, e)) return;
            throw e;
        }
        if (!applied) return res.status(409).json({ error: 'o run saiu do churn enquanto aceitava' });
        const summary = summarize(resolveRun(taskId));
        if (summary?.state) broadcast({ type: 'state_update', taskId, state: summary.state, run: summary });
        res.json({ ok: true, taskId });
    });

    // "✨ Corrigir com IA" do portão de build pré-implement: despacha um `claude -p`
    // (scripts/lib/pre-build-ai-fix.js) no worktree do ticket com os erros no prompt e
    // transmite cada passo pelo WebSocket ({type:'prebuild_ai_event'}) — o painel
    // acompanha ao vivo. Os eventos também vão pra <run>/pre-build-ai-fix.jsonl (GET
    // abaixo, pra recarregar a página no meio). Enquanto roda, state.preBuildAiFix
    // .status="running" (+ pid do agente) faz o watcher NÃO recompilar a cada edição
    // (ver runPreBuildGate). No fim o veredito é o do build-validator, gravado com a
    // mesma applyResult do "Tentar de novo": passou => in_progress e o watcher despacha
    // o implement no próximo tick; falhou => continua pre-build-failed com os erros novos.
    const AI_FIX_LOG = 'pre-build-ai-fix.jsonl';
    const AI_FIX_STATUSES = ['running', 'passed', 'failed', 'cancelled', 'error'];
    function pidAlive(pid) {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
    }
    function aiFixOf(run, state) {
        const f = state?.preBuildAiFix;
        if (!f || !AI_FIX_STATUSES.includes(f.status)) return null;
        // "running" sem este processo conduzindo e sem o agente vivo = dashboard caiu no meio.
        const orphan = f.status === 'running' && !aiFixes.has(run.taskId) && !pidAlive(f.pid);
        return {
            status: orphan ? 'error' : f.status,
            startedAt: f.startedAt || null,
            finishedAt: f.finishedAt || null,
            summary: typeof f.summary === 'string' ? redact(f.summary) : orphan ? 'O dashboard reiniciou com a correção em andamento.' : null,
            costUsd: typeof f.costUsd === 'number' ? f.costUsd : null,
        };
    }
    // Expectativas CAS de uma ação humana: o casToken que a tela carregou (body) ou, sem
    // ele, a leitura do início da requisição — protege também a janela dos awaits.
    function humanExpect(req, state) {
        const b = req.body || {};
        const snap = cas.snapshotOf(state);
        const pick = (k, ok) => (b[k] !== undefined && ok(b[k]) ? b[k] : snap[k]);
        const str = v => v === null || typeof v === 'string';
        return {
            expected_state_version: pick('expected_state_version', Number.isInteger),
            expected_node: pick('expected_node', str),
            expected_spec_hash: pick('expected_spec_hash', str),
            execution_id: pick('execution_id', str),
        };
    }
    function operationIdOf(req) {
        const id = req.body?.operation_id;
        return typeof id === 'string' && /^[\w:.@-]{8,100}$/.test(id) ? id : require('crypto').randomUUID();
    }
    // Conflito CAS → 409 com a mensagem fixa (nunca 500 genérico). true = respondeu.
    function sendConflict(res, e) {
        if (!cas.isConflict(e)) return false;
        res.status(409).json(cas.httpBody(e));
        return true;
    }
    // Pré-checagem antes de efeitos externos (Redmine, despacho): a tela está velha?
    function precheck(run, operation, expect, extra = {}) {
        return cas.validate({ runDir: run.dir, operation, actor: 'dashboard', ...expect, ...extra }, stateWriter.read(run.dir));
    }

    app.get('/api/runs/:taskId/pre-build/ai-fix', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const live = aiFixes.get(run.taskId);
        let events = live ? live.events : [];
        if (!live) {
            try {
                events = fs.readFileSync(path.join(run.dir, AI_FIX_LOG), 'utf8').split('\n').filter(Boolean)
                    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            } catch { /* nunca rodou */ }
        }
        res.json({ taskId: run.taskId, aiFix: aiFixOf(run, readRunState(run)), events });
    });

    app.post('/api/runs/:taskId/pre-build/ai-fix', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        if (run.archived || run.pretask) return res.status(409).json({ error: 'run arquivado ou ainda sem task' });
        const statePath = path.join(run.dir, 'state.json');
        const state = readJson(statePath);
        if (state?.status !== 'pre-build-failed') return res.status(409).json({ error: 'o run não está parado no pré-build' });
        const ticket = (run.root.label.match(/^worktree:(\d+)$/) || [])[1];
        if (!ticket) return res.status(409).json({ error: 'run fora do worktree do ticket: não há onde corrigir' });
        if (aiFixes.has(run.taskId) || (state.preBuildAiFix?.status === 'running' && pidAlive(state.preBuildAiFix.pid))) {
            return res.status(409).json({ error: 'a IA já está corrigindo este build' });
        }
        if (preBuildRetrying.has(run.taskId)) return res.status(409).json({ error: 'recompilando agora — espere terminar' });
        const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 2000) : '';
        const worktree = path.join(worktreesDir, ticket);
        const workspace = path.dirname(repoRoot);
        const errors = state.preBuildErrors || [];
        const logPath = path.join(run.dir, AI_FIX_LOG);

        const session = { events: [], cancel: null };
        aiFixes.set(run.taskId, session);
        const emit = ev => {
            const event = { ...ev, text: redact(ev.text || ''), at: new Date().toISOString() };
            session.events.push(event);
            if (session.events.length > 1000) session.events.shift();
            try { fs.appendFileSync(logPath, JSON.stringify(event) + '\n'); } catch { /* log é conveniência */ }
            broadcast({ type: 'prebuild_ai_event', taskId: run.taskId, event });
        };
        const pushState = () => {
            const current = resolveRun(run.taskId);
            if (!current) return;
            const summary = summarize(current);
            if (summary.state) broadcast({ type: 'state_update', taskId: run.taskId, state: summary.state, run: summary });
        };
        const setFix = patch => stateWriter.update(statePath, fresh => {
            fresh.preBuildAiFix = { ...(fresh.preBuildAiFix || {}), ...patch };
            fresh.updated_at = new Date().toISOString();
        }, { operation: 'pre_build_ai_fix', actor: 'dashboard' });

        try { fs.writeFileSync(logPath, ''); } catch { /* idem */ }
        const javaHome = buildValidator.resolveJavaHome(worktree, consumerEnv).javaHome || null;
        const addDirs = siblingRepos.map(dir => path.join(dir, '.claude', 'worktrees', ticket)).filter(p => fs.existsSync(p));
        let handle;
        try {
            handle = preBuildAiFix.startFix({
                worktree,
                args: preBuildAiFix.claudeArgs(preBuildAiFix.buildPrompt({
                    ticketId: ticket, errors, extra: note, env: consumerEnv,
                    // Só os que viram jar no ~/.m2 (app-front não entra no build do app-back); mo-entity primeiro.
                    siblingDirs: addDirs,
                }), { addDirs }),
                env: preBuildAiFix.agentEnv(consumerEnv, javaHome),
                onEvent: emit,
                timeoutMs: preBuildAiFix.resolveTimeoutMs(),
                ...(aiFixSpawn ? { spawn: aiFixSpawn } : {}),
                ...(options.aiFixBin ? { bin: options.aiFixBin } : {}),
            });
        } catch (e) {
            aiFixes.delete(run.taskId);
            return res.status(500).json({ error: `não deu pra iniciar o agente: ${redact(e.message)}` });
        }
        session.cancel = handle.cancel;
        const startedAt = new Date().toISOString();
        setFix({ status: 'running', startedAt, finishedAt: null, pid: handle.pid || null, summary: null, costUsd: null });
        emit({ kind: 'phase', text: `Agente despachado no worktree .claude/worktrees/${ticket} com ${errors.length} erro(s)` });
        pushState();
        res.status(202).json({ ok: true, taskId: run.taskId, startedAt });

        (async () => {
            const out = await handle.done;
            const cost = out.result?.costUsd ?? null;
            if (out.cancelled) {
                emit({ kind: 'phase', text: 'Correção cancelada. O que o agente já editou continua no worktree — o watcher recompila sozinho no próximo tick.' });
                setFix({ status: 'cancelled', finishedAt: new Date().toISOString(), summary: 'Cancelada pelo usuário.', costUsd: cost });
                return;
            }
            if (out.timedOut) emit({ kind: 'tool_error', text: `Agente passou de ${Math.round(preBuildAiFix.resolveTimeoutMs() / 60000)} min (PRE_BUILD_AI_FIX_TIMEOUT_MS) e foi encerrado.` });
            try {
                const stat = execFileSyncSafe('git', ['diff', '--stat', 'HEAD', '--', '.', ':(exclude)memory'], worktree);
                if (stat) emit({ kind: 'diff', text: stat });
            } catch { /* sem git: segue */ }
            emit({ kind: 'phase', text: `Validando com ${buildValidator.MVN_COMMAND}…` });
            let result;
            try {
                result = await validateBuild(worktree, { siblingRepos, env: consumerEnv });
            } catch (e) {
                result = { success: false, duration: 0, errors: [`Falha rodando o validador: ${e.message}`] };
            }
            const ok = result.success || !!result.infraError;
            emit({
                kind: 'build', ok,
                text: result.success ? `Build passou em ${Math.round(result.duration / 1000)}s — o watcher despacha o Implement no próximo ciclo.`
                    : result.infraError ? `Validação pulada por ambiente: ${result.errors.join('; ')}`
                    : `Build ainda falha (${result.errors.length} erro(s)):\n${result.errors.slice(0, 20).join('\n')}`,
            });
            const fingerprint = ok ? null : buildValidator.worktreeFingerprint(worktree);
            stateWriter.update(statePath, fresh => {
                if (fresh.status === 'pre-build-failed') {
                    buildValidator.applyResult(fresh, result, { fingerprint, source: 'correção por IA pelo dashboard' });
                }
                fresh.preBuildAiFix = {
                    ...(fresh.preBuildAiFix || {}),
                    status: out.code === null && !out.result ? 'error' : ok ? 'passed' : 'failed',
                    finishedAt: new Date().toISOString(),
                    summary: out.result?.text ? redact(out.result.text) : out.timedOut ? 'Tempo esgotado.' : null,
                    costUsd: cost,
                };
            }, { operation: 'pre_build_ai_fix', actor: 'dashboard' });
            // Registro pro Implement/Review: a base foi mexida antes do ciclo começar.
            if (out.result?.text) {
                try {
                    fs.appendFileSync(path.join(run.dir, 'context.md'),
                        `\n\n## Correção do build pré-implement por IA (dashboard) — ${new Date().toISOString()}\n\n` +
                        `Build ${result.success ? 'passou' : ok ? 'não validado (ambiente)' : 'ainda falha'} depois da correção. ` +
                        `Resumo do agente:\n\n${redact(out.result.text)}\n`);
                } catch { /* context.md é registro, não fluxo */ }
            }
        })().catch(e => {
            emit({ kind: 'tool_error', text: `Falha conduzindo a correção: ${e.message}` });
            try { setFix({ status: 'error', finishedAt: new Date().toISOString(), summary: redact(e.message) }); } catch { /* idem */ }
        }).finally(() => { aiFixes.delete(run.taskId); pushState(); });
    });

    app.post('/api/runs/:taskId/pre-build/ai-fix/cancel', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const session = aiFixes.get(run.taskId);
        if (!session?.cancel) return res.status(409).json({ error: 'nenhuma correção por IA em andamento' });
        session.cancel();
        res.json({ ok: true, taskId: run.taskId });
    });

    // "🔄 Corrigir recusa QA": ticket voltou do QA como Recusa QA. Reaproveita o MESMO
    // run (nada de task nova): anexa a nota do QA no fim do context.md, move o ticket pra
    // "Em Desenvolvimento", aponta o state.json pro implement e deixa retry-signal.json
    // pro watcher — é ele que recria o worktree se o merge já o apagou, traz o run de
    // volta de _archive pra <worktree>/memory/runs/ e despacha o implement (ver
    // consumeQaRetrySignals em scripts/readmine-watcher.js). Nota ausente ou journals
    // fora do ar não impedem o retry; Redmine sem aceitar a troca de status impede (502,
    // nada local é escrito — clicar de novo é seguro).
    const qaRedmine = options.qaRedmine || {
        fetchLastRejectionNote: id => qaJournal.fetchLastRejectionNote(id, redmineOptions()),
        setIssueStatus: (id, status) => qaJournal.setIssueStatus(id, status, redmineOptions()),
    };
    const qaDevelopmentStatus = Number(consumerEnv.REDMINE_STATUS_EM_DESENVOLVIMENTO_ID) || 2;
    const qaRetrying = new Set();
    app.post('/api/runs/:taskId/retry-qa-rejection', async (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        if (run.pretask) return res.status(409).json({ error: 'ticket ainda sem task: não há ciclo pra corrigir' });
        const statePath = path.join(run.dir, 'state.json');
        const state = readJson(statePath);
        if (!state) return res.status(404).json({ error: 'state.json ausente ou inválido' });
        const ticketStatus = run.demand?.status || state.ticket_status || null;
        if (!qaJournal.isQaRejectedStatus(ticketStatus)) {
            return res.status(400).json({ error: `o ticket não está em Recusa QA (status: ${ticketStatus || 'desconhecido'})` });
        }
        if (state.status === 'running') return res.status(409).json({ error: 'há um nó rodando neste run agora' });
        const signalPath = path.join(run.dir, 'retry-signal.json');
        if (fs.existsSync(signalPath)) return res.status(409).json({ error: 'retry já solicitado — aguardando o watcher' });
        const issueId = /^\d+$/.test(String(state.issue_id ?? '')) ? Number(state.issue_id) : ticketIdOf(run.taskId, state);
        if (!issueId) return res.status(409).json({ error: 'run sem ticket do Redmine' });
        if (qaRetrying.has(run.taskId)) return res.status(409).json({ error: 'retry já em andamento' });
        // Operação humana (scripts/cas.js qa_retry): idempotente pelo operation_id do clique
        // e CAS contra o que a tela carregou — conferido antes de mexer no Redmine.
        const expect = humanExpect(req, state);
        const operationId = operationIdOf(req);
        try {
            const pre = precheck(run, 'qa_retry', { expected_state_version: expect.expected_state_version }, { operation_id: operationId });
            if (pre.status === 'already_processed') return res.json({ ok: true, status: 'already_processed', operation_id: operationId, taskId: run.taskId });
        } catch (e) {
            if (sendConflict(res, e)) return;
            throw e;
        }
        qaRetrying.add(run.taskId);
        try {
            const found = await qaRedmine.fetchLastRejectionNote(issueId);
            const moved = await qaRedmine.setIssueStatus(issueId, qaDevelopmentStatus);
            if (!moved.ok) return res.status(502).json({ error: redact(`Redmine: ${moved.error}`) });

            const at = new Date().toISOString();
            const contextBefore = readContext(run.dir);
            const build = fresh => ({
                ...fresh,
                ticket_status: moved.status?.name || 'Em Desenvolvimento',
                qa_rejection: {
                    note: found?.note ?? null,
                    rejected_at: found?.rejected_at || fresh.qa_rejection?.rejected_at || null,
                    journal_id: found?.journal_id ?? null,
                    retry_requested_at: at,
                },
                // Histórico por recusa (o qa_rejection acima só guarda a última), com o custo
                // acumulado neste instante — base do custo por recusa no dashboard.
                qa_rejections: qaCycles.appendRejection(fresh, contextBefore, { note: found?.note, rejected_at: found?.rejected_at || fresh.qa_rejection?.rejected_at || null, journal_id: found?.journal_id, at }),
                qa_retry_count: (Number.isInteger(fresh.qa_retry_count) ? fresh.qa_retry_count : 0) + 1,
                // Retry = execução nova: a sessão do ciclo anterior perde a posse.
                execution_id: stateWriter.newExecutionId(),
                node: 'implement',
                status: 'in_progress',
                updated_at: at,
            });
            let next;
            try {
                const out = cas.transact({
                    runDir: run.dir, operation: 'qa_retry', actor: 'dashboard', operation_id: operationId,
                    expected_state_version: expect.expected_state_version,
                }, fresh => build(fresh));
                if (out.status === 'already_processed') return res.json({ ok: true, status: 'already_processed', operation_id: operationId, taskId: run.taskId });
                next = out.state;
            } catch (e) {
                if (sendConflict(res, e)) return;
                throw e;
            }
            fs.appendFileSync(path.join(run.dir, 'context.md'), qaJournal.contextBlock(found?.note, at), 'utf8');
            fs.writeFileSync(signalPath, JSON.stringify({ node: 'implement', task_id: run.taskId, requested_at: at }, null, 2));

            const summary = summarizeAny({ ...run, demand: run.demand && { ...run.demand, status: next.ticket_status } });
            if (run.archived && archivedOpen.has(run.taskId)) archivedOpen.get(run.taskId).demand.status = next.ticket_status;
            broadcast({ type: 'state_update', taskId: run.taskId, state: summary.state, run: summary });
            broadcast({ type: 'runs_changed' });
            res.json({ ok: true, taskId: run.taskId, note: found?.note ?? null, qa_retry_count: next.qa_retry_count, ticket_status: next.ticket_status });
        } catch (e) {
            console.error(`[dashboard] retry recusa QA de ${run.taskId}: ${redact(e.message)}`);
            res.status(500).json({ error: redact(`Falha no retry: ${e.message}`) });
        } finally {
            qaRetrying.delete(run.taskId);
        }
    });

    // "▶ Retomar sessão": badge "⏸ SESSÃO LIMITE" (state.status="session_limit",
    // gravado pelo watcher quando o stderr do agente bate um sinal de estouro de
    // janela de contexto/tokens — ver looksLikeSessionLimit em
    // scripts/readmine-watcher.js). Reaproveita dispatchNode
    // (scripts/lib/node-dispatcher.js), a MESMA função usada por POST
    // /api/runs/start, pra redespachar o nó interrompido — não um spawn cru de
    // `claude` feito à mão aqui: preserva lease de nó, redação de segredo e
    // rastreamento de custo do despacho normal, e evita destrancar todas as
    // permissões atrás de um botão de dashboard. O status precisa sair de
    // "session_limit" ANTES do dispatchNode: dispatchTicket recusa redespachar
    // sozinho um run nesse status (ver o branch irmão do "interrupted").
    // Limite de 3 retomadas (resume_count) pra não virar loop.
    const resuming = new Set();
    app.post('/api/runs/:taskId/resume-session', async (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        if (run.pretask) return res.status(409).json({ error: 'ticket ainda sem task: não há sessão pra retomar' });
        const statePath = path.join(run.dir, 'state.json');
        const state = readJson(statePath);
        if (!state) return res.status(404).json({ error: 'state.json ausente ou inválido' });
        if (state.session_interrupted !== true) {
            return res.status(409).json({ error: 'run não está interrompido' });
        }
        const resumeCount = Number.isInteger(state.resume_count) ? state.resume_count : 0;
        if (resumeCount >= 3) {
            return res.status(429).json({ error: 'limite de 3 retomadas atingido' });
        }
        // Task ad-hoc (sem ticket Redmine, ex: nascida direto de /plan) não tem o que
        // o watcher despache — mesma mensagem/precedente de retry-qa-rejection acima.
        const ticketId = /^\d+$/.test(String(state.issue_id ?? '')) ? Number(state.issue_id) : ticketIdOf(run.taskId, state);
        if (!ticketId) {
            return res.status(409).json({ error: 'run sem ticket do Redmine — retome manualmente rodando o comando do nó nesta sessão' });
        }
        if (resuming.has(run.taskId)) return res.status(409).json({ error: 'retomada já em andamento' });
        const expect = humanExpect(req, state);
        resuming.add(run.taskId);
        try {
            const interruptedNode = state.interrupted_node || state.node;
            const at = new Date().toISOString();
            try {
                precheck(run, 'resume_session', { expected_state_version: expect.expected_state_version, execution_id: expect.execution_id });
            } catch (e) {
                if (sendConflict(res, e)) return;
                throw e;
            }
            if (!fs.existsSync(path.join(run.dir, 'context.md'))) {
                console.warn(`[dashboard] resume-session de ${run.taskId}: context.md ausente — retomando só com state.json`);
            } else {
                fs.appendFileSync(path.join(run.dir, 'context.md'),
                    `\n\n---\n**Retomada de sessão interrompida** (${at})\n` +
                    `Nó anterior: ${interruptedNode}. Interrompida em ${state.interrupted_at || '?'} por estouro de ` +
                    `contexto/tokens. Esta é a retomada nº ${resumeCount + 1}/3 — confira git status/diff e o que já ` +
                    `foi feito antes de continuar.\n`, 'utf8');
            }

            // resume_session (scripts/cas.js): CAS + execution_id da sessão que a tela viu;
            // gira o execution_id — a sessão antiga, se ainda gravar algo, leva SESSION_CONFLICT.
            let next;
            try {
                next = cas.transact({
                    runDir: run.dir, operation: 'resume_session', actor: 'dashboard',
                    expected_state_version: expect.expected_state_version, execution_id: expect.execution_id,
                }, fresh => ({
                    ...fresh,
                    session_interrupted: false,
                    status: 'in_progress',
                    execution_id: stateWriter.newExecutionId(),
                    resumed_at: at,
                    resume_count: resumeCount + 1,
                    updated_at: at,
                })).state;
            } catch (e) {
                if (sendConflict(res, e)) return;
                throw e;
            }

            const summary = summarizeAny(run);
            broadcast({ type: 'state_update', taskId: run.taskId, state: summary.state, run: summary });
            broadcast({ type: 'runs_changed' });

            const result = await dispatchTicketNode({ ticketId, fallbackState: next, follow: false })
                .catch(e => ({ action: 'error', error: e.message }));
            // Contenção normal do despacho (PRI-218): o state já girou (retomada aceita);
            // outro despachante segura a reserva ou o marcador. 202 = adiado, não falha.
            if (result.action === 'skip' && ['despacho_reservado', 'fetch_em_execucao'].includes(result.reason)) {
                console.warn(`[dashboard] resume-session de ${run.taskId}: despacho adiado (${result.reason}) — state já retomado`);
                return res.status(202).json({
                    ok: true, deferred: true, reason: result.reason,
                    taskId: run.taskId, node: interruptedNode, resumeCount: next.resume_count,
                });
            }
            if (result.action !== 'dispatched' && result.action !== 'dry-run') {
                console.error(`[dashboard] resume-session de ${run.taskId}: dispatchNode não disparou (${result.reason || result.action || 'erro desconhecido'})`);
                return res.status(502).json({ error: redact(`não foi possível redespachar (${result.reason || result.action || 'erro desconhecido'})`) });
            }
            res.json({ ok: true, taskId: run.taskId, node: interruptedNode, resumeCount: next.resume_count });
        } catch (e) {
            console.error(`[dashboard] resume-session de ${run.taskId}: ${redact(e.message)}`);
            res.status(500).json({ error: redact(`Falha ao retomar: ${e.message}`) });
        } finally {
            resuming.delete(run.taskId);
        }
    });

    // "↩ Retomar a partir de": cria um run de replay (<task-id>-replay-<n>) no mesmo
    // worktree e re-despacha o ciclo a partir de fromNode, via scripts/replay-cycle.js
    // (validação, Redmine e despacho ficam todos lá — o dashboard não duplica nada). O
    // run original não é tocado. Responde quando o script termina (o agente segue
    // destacado); o run novo chega pelo WebSocket como qualquer outro.
    app.post('/api/runs/:taskId/replay', async (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        if (run.pretask) return res.status(409).json({ error: 'ticket ainda sem task: não há ciclo pra retomar' });
        const fromNode = req.body?.fromNode;
        if (!cycleReplayer.REPLAY_NODES.includes(fromNode)) {
            return res.status(400).json({ error: `fromNode inválido — use ${cycleReplayer.REPLAY_NODES.join(', ')}` });
        }
        const options = cycleReplayer.replayOptions(readRunState(run));
        if (!options.replayable) return res.status(409).json({ error: options.reason });
        if (!options.nodes.includes(fromNode)) return res.status(409).json({ error: `o ciclo original não chegou a rodar os nós anteriores a ${fromNode}` });
        if (replaying.has(run.taskId)) return res.status(409).json({ error: 'já criando um replay deste run' });
        // replay (scripts/cas.js): o run original tem que estar como a tela o carregou.
        const expect = humanExpect(req, readRunState(run));
        const casArgs = [
            '--expected-version', String(expect.expected_state_version),
            '--expected-node', expect.expected_node ?? '',
            '--execution-id', expect.execution_id ?? '',
        ];
        replaying.add(run.taskId);
        try {
            const out = await replayRunner(['--task', run.taskId, '--from', fromNode, ...casArgs]);
            if (!out.ok && (out.code === cas.STATE_CONFLICT || out.code === cas.SESSION_CONFLICT)) {
                return res.status(409).json({ ok: false, code: out.code, error: cas.CONFLICT_MESSAGE });
            }
            if (!out.ok) return res.status(out.code === 'error' || !out.code ? 500 : 409).json({ error: redact(out.error || 'replay falhou'), code: out.code || null });
            syncWatchedRoots();
            res.status(201).json({
                ok: true, taskId: run.taskId, replayTaskId: out.replayTaskId, fromNode: out.fromNode,
                nodesToRun: out.nodesToRun, removed: out.removed, redmine: out.redmine,
                dispatched: out.dispatch?.action === 'dispatched', warnings: (out.warnings || []).map(redact),
            });
        } catch (e) {
            res.status(500).json({ error: redact(e.message) });
        } finally {
            replaying.delete(run.taskId);
        }
    });

    // Status que o dashboard considera "ainda andando": arquivar exige force=true,
    // porque o watcher deixa de ver a task (e, se o ticket voltar pra Aprovada/Recusa
    // QA, começa um ciclo novo).
    const ACTIVE_FOR_ARCHIVE = new Set(['active', 'failed', 'unknown']);

    app.post('/api/runs/:taskId/archive', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        if (run.archived) return res.status(409).json({ error: 'run já está em _archive' });
        if (run.pretask) return res.status(409).json({ error: 'ticket ainda sem task: não há pasta de run pra arquivar' });
        const state = readJson(path.join(run.dir, 'state.json'));
        const kind = deriveRunKind(state);
        if (ACTIVE_FOR_ARCHIVE.has(kind) && req.body?.force !== true) {
            return res.status(409).json({ error: 'run ativo: confirme com force=true', kind, status: state?.status || null });
        }
        const archiveDir = path.join(run.root.dir, '_archive');
        let target = path.join(archiveDir, run.taskId);
        if (fs.existsSync(target)) target = path.join(archiveDir, `${run.taskId}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        // Confere que origem e destino ficam dentro do root de runs (nada sai de memory/runs).
        const inside = (p, root) => path.resolve(p).startsWith(path.resolve(root) + path.sep);
        if (!inside(run.dir, run.root.dir) || !inside(target, run.root.dir)) return res.status(400).json({ error: 'caminho fora de memory/runs' });
        try {
            fs.mkdirSync(archiveDir, { recursive: true });
            // archive (scripts/cas.js): CAS + execution_id do que a tela carregou, com o
            // lock do run até o rename (ninguém grava no meio). Run sem state.json: só move.
            if (state) {
                const expect = humanExpect(req, state);
                stateWriter.archive(run.dir, target, {
                    operation: 'archive', actor: 'dashboard',
                    expect: { expected_state_version: expect.expected_state_version, expected_node: expect.expected_node, execution_id: expect.execution_id },
                });
            } else {
                fs.renameSync(run.dir, target);
            }
        } catch (e) {
            if (sendConflict(res, e)) return;
            console.error(`[dashboard] arquivar ${run.taskId}: ${redact(e.message)}`);
            return res.status(500).json({ error: 'Não foi possível mover a pasta do run' });
        }
        runsCache.get(run.root.dir)?.names.delete(run.taskId);
        const reg = readRegistry();
        reg[run.taskId] = {
            archived_at: new Date().toISOString(), kind, status: state?.status || null,
            from: path.relative(repoRoot, run.dir), to: path.relative(repoRoot, target),
        };
        writeRegistry(reg);
        broadcast({ type: 'runs_changed' });
        scanArchivedOpen().catch(() => {});
        res.json({ ok: true, taskId: run.taskId, kind, from: reg[run.taskId].from, to: reg[run.taskId].to });
    });

    // ---------------------------------------------------------------------------
    // Autorização humana (PRI-180). O agente registra pending_authorization pela CLI
    // (scripts/lib/authorization.js request); a decisão é SÓ por estes endpoints, com CAS
    // (expected_state_version + operation_id) e quem/quando em authorization_history.
    // Aprovar executa o artefato como efeito governado (scripts/lib/db-effect.js, Attempt
    // DOM06) aqui, no processo do dashboard, e só nesta chamada — nenhum estado gravado
    // dispara SQL. Sucesso segue o `then` do pedido (retomar num nó ou devolver ao QA).
    const authorizing = new Set();
    const dbExecutor = options.dbExecutor || null;           // injetável nos testes (nunca banco real)
    const handbackFetch = options.handbackFetch || null;     // idem, Redmine
    // Config privilegiada: ~/.config/prisma do usuário do processo; override só por código (testes).
    const prismaConfigDir = options.prismaConfigDir || null;
    // Autoria das ações privilegiadas (autorização de SQL, devolução ao QA, override de
    // roteamento). Decisão do Richard em 2026-11-06: sem aprovador nem senha até existirem
    // roles — quem tem acesso ao Dashboard executa. O acesso continua restrito ao filtro
    // global de localhost (Host e Origin locais: bloqueia páginas de terceiros e DNS
    // rebinding). A autoria gravada é o usuário do sistema operacional que roda o
    // Dashboard. scripts/lib/approvers.js fica para quando houver roles.
    const LOCAL_ACTOR = (() => {
        try { return os.userInfo().username || 'dashboard-local'; } catch { return 'dashboard-local'; }
    })();
    const actorOf = () => LOCAL_ACTOR;
    function pushRun(taskId) {
        const fresh = resolveRun(taskId);
        if (fresh) {
            const summary = summarizeAny(fresh);
            broadcast({ type: 'state_update', taskId, state: summary.state, run: summary });
        }
        broadcast({ type: 'runs_changed' });
    }
    function afterHandbackArchive(run) {
        runsCache.get(run.root.dir)?.names.delete(run.taskId);
        broadcast({ type: 'runs_changed' });
        scanArchivedOpen().catch(() => {});
    }
    function handbackFor(run, by) {
        return (runDir, ctx) => qaHandback.handback(runDir, {
            by, operationId: ctx.operationId, authorization: ctx.authorization, env: consumerEnv, fetchImpl: handbackFetch,
            onArchived: () => afterHandbackArchive(run),
        });
    }
    // Run onde a decisão faz sentido: ativo, com state.json, sem agente rodando.
    function authorizationRun(req, res) {
        const run = withRun(req, res);
        if (!run) return null;
        if (run.archived || run.pretask) { res.status(409).json({ error: 'run arquivado ou sem task: nada a decidir' }); return null; }
        const state = readJson(path.join(run.dir, 'state.json'));
        if (!state) { res.status(404).json({ error: 'state.json ausente ou inválido' }); return null; }
        if (state.status === 'running') { res.status(409).json({ error: 'há um nó rodando neste run agora' }); return null; }
        if (authorizing.has(run.taskId)) { res.status(409).json({ error: 'outra decisão deste run está em andamento' }); return null; }
        return { run, state };
    }
    function sendAuthorizationError(res, e) {
        if (sendConflict(res, e)) return true;
        if (e instanceof authorization.AuthorizationError) { res.status(409).json({ ok: false, code: e.code, error: e.message }); return true; }
        return false;
    }
    const canHandback = state => ['blocked', authorization.STATUS].includes(state?.status) && state?.pending_authorization?.phase !== 'executing';

    // Detalhe do pedido para a tela de aprovação. SQL e pedido INTEGRAIS, sem redação
    // (a redação escondia trechos que executam — revisão de segurança C3); SQL acima do
    // limite bloqueia a aprovação em vez de truncar. request_hash do pedido para o alvo
    // em ?target= (a tela mostra e devolve na aprovação). Sem dados de alvo aqui.
    app.get('/api/runs/:taskId/authorization', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const state = run.pretask ? null : readJson(path.join(run.dir, 'state.json'));
        if (!state) return res.status(404).json({ error: 'state.json ausente ou inválido' });
        const p = state.pending_authorization || null;
        let artifact = null, request = null, problems = [];
        if (p) {
            const a = dbEffect.readArtifact(p, { roots: authorization.rootsFor(run.dir) });
            artifact = a.ok
                ? { path: p.artifact, content: a.sql, bytes: Buffer.byteLength(a.sql), sha256_now: a.sha, matches: a.sha === p.artifact_sha256 }
                : { path: p.artifact, content: null, error: a.error, code: a.code };
            if (a.ok) problems = dbEffect.checkArtifactSql(a.sql);
            problems = [...problems, ...dbEffect.checkVerifySql(p.verify_sql).map(x => `verify_sql: ${x}`)];
            const targetAlias = typeof req.query.target === 'string' && dbEffect.ALIAS_RE.test(req.query.target) ? req.query.target : null;
            request = authorization.describeRequest(run.dir, { targetAlias });
        }
        const executor = (dbExecutor || dbEffect.createChildExecutor({ configDir: prismaConfigDir })).available?.() || { ok: true };
        const ticketId = authorization.ticketOfTask(run.taskId);
        const showHandback = canHandback(state) || p?.then === 'handback_qa';
        res.json({
            taskId: run.taskId, ticketId, status: state.status, pending: p,
            history: Array.isArray(state.authorization_history) ? state.authorization_history : [],
            artifact, problems, request, executor, max_sql_bytes: dbEffect.MAX_SQL_BYTES,
            handback: { available: !run.archived && canHandback(state), preview: showHandback ? qaHandback.preview(run.dir) : null },
        });
    });

    // Bancos da allowlist para o seletor do Aprovar (acesso local, sem aprovador desde
    // 2026-11-06); só alias, rótulo, ambiente e host/banco mascarados.
    app.post('/api/authorization/targets', async (req, res) => {
        const out = dbEffect.publicTargets({ configDir: prismaConfigDir });
        res.json({ ok: !out.error, targets: out.targets, error: out.error });
    });

    async function decideAndExecute(req, res, mode) {
        const ctx = authorizationRun(req, res);
        if (!ctx) return;
        const by = actorOf();
        const { run, state } = ctx;
        if (authorizing.has(run.taskId)) return res.status(409).json({ error: 'outra decisão deste run está em andamento' });
        const expect = humanExpect(req, state);
        const operationId = operationIdOf(req);
        authorizing.add(run.taskId);
        try {
            let dec;
            try {
                const targetAlias = typeof req.body?.target_alias === 'string' ? req.body.target_alias : null;
                const args = {
                    by, operationId, expectedStateVersion: expect.expected_state_version, authorizationId: req.body?.authorization_id,
                    targetAlias, requestHash: typeof req.body?.request_hash === 'string' ? req.body.request_hash : null, configDir: prismaConfigDir,
                };
                dec = mode === 'apply'
                    ? authorization.approve(run.dir, args)
                    : authorization.markManual(run.dir, { ...args, note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : null });
                if (dec.status !== 'already_processed') console.log(`[dashboard] autorização ${mode === 'apply' ? 'aprovada' : 'manual'} em ${run.taskId} por ${by}${targetAlias ? ` (alvo ${targetAlias})` : ''}`);
            } catch (e) {
                if (sendAuthorizationError(res, e)) return;
                throw e;
            }
            if (dec.status === 'already_processed') return res.json({ ok: true, status: 'already_processed', operation_id: operationId });
            pushRun(run.taskId);
            // A execução usa a cópia congelada na decisão, passada em memória (não relê state/artefato).
            const out = await authorization.execute(run.dir, {
                frozen: dec.frozen, mode: mode === 'apply' ? 'apply' : 'verify',
                configDir: prismaConfigDir, executor: dbExecutor, handback: handbackFor(run, by),
            });
            pushRun(run.taskId);
            const body = {
                ok: out.ok, taskId: run.taskId, by, target: out.result?.target?.alias || null, then: out.then || null, node: out.node || null,
                outcome: out.result?.outcome || null, code: out.result?.code || null, outputs: out.result?.outputs || null,
                handback: out.handback ? { ok: out.handback.ok, archived: !!out.handback.archived, error: out.handback.error || null } : null,
                error: out.ok ? null : redact(out.error || 'falha'),
            };
            res.status(out.ok ? 200 : 502).json(body);
        } catch (e) {
            if (sendAuthorizationError(res, e)) return;
            console.error(`[dashboard] autorização (${mode}) de ${run.taskId}: ${redact(e.message)}`);
            res.status(500).json({ error: redact(`Falha na autorização: ${e.message}`) });
        } finally {
            authorizing.delete(run.taskId);
        }
    }
    app.post('/api/runs/:taskId/authorization/approve', (req, res) => decideAndExecute(req, res, 'apply'));
    app.post('/api/runs/:taskId/authorization/manual', (req, res) => decideAndExecute(req, res, 'manual'));
    app.post('/api/runs/:taskId/authorization/reject', async (req, res) => {
        const ctx = authorizationRun(req, res);
        if (!ctx) return;
        const by = actorOf();
        const { run, state } = ctx;
        const expect = humanExpect(req, state);
        const operationId = operationIdOf(req);
        try {
            const out = authorization.reject(run.dir, {
                by, reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 2000) : '',
                operationId, expectedStateVersion: expect.expected_state_version, authorizationId: req.body?.authorization_id,
            });
            if (out.status === 'already_processed') return res.json({ ok: true, status: 'already_processed', operation_id: operationId });
        } catch (e) {
            if (sendAuthorizationError(res, e)) return;
            throw e;
        }
        pushRun(run.taskId);
        res.json({ ok: true, taskId: run.taskId, status: 'blocked' });
    });

    // PRI-233 T8 (P-2): override humano de roteamento. Mesma autoridade das decisões de
    // autorização (acesso local + CAS/operation_id; sem aprovador desde 2026-11-06), mesmo writer
    // (scripts/lib/authorization.js), sem pausar a Run e recusado com nó rodando (como as
    // demais decisões). Vale a partir do próximo limite de nó; elegibilidade conferida
    // pelo resolver contra o snapshot da Run.
    app.post('/api/runs/:taskId/routing-override', async (req, res) => {
        const ctx = authorizationRun(req, res);
        if (!ctx) return;
        const by = actorOf();
        const { run, state } = ctx;
        const expect = humanExpect(req, state);
        const operationId = operationIdOf(req);
        const str = v => (typeof v === 'string' ? v.slice(0, 200) : null);
        try {
            const out = authorization.recordRoutingOverride(run.dir, {
                by, scope: str(req.body?.scope), node: str(req.body?.node), subtaskKey: str(req.body?.subtask_key),
                value: { model_id: str(req.body?.model_id), effort: str(req.body?.effort) },
                operationId, expectedStateVersion: expect.expected_state_version,
            });
            if (out.status === 'already_processed') return res.json({ ok: true, status: 'already_processed', operation_id: operationId });
            console.log(`[dashboard] override de roteamento ${out.override.ref} em ${run.taskId} por ${by}`);
            pushRun(run.taskId);
            return res.json({ ok: true, taskId: run.taskId, override: out.override });
        } catch (e) {
            if (sendAuthorizationError(res, e)) return;
            throw e;
        }
    });

    // "Devolver ao QA": run blocked/authorization-pending resolvido sem código. Reserva o
    // clique (cas.reserveOperation) antes do Redmine; desfecho incerto mantém a reserva e
    // o mesmo operation_id retoma conferindo o marcador no ticket (sem repostar às cegas).
    app.post('/api/runs/:taskId/handback-qa', async (req, res) => {
        const ctx = authorizationRun(req, res);
        if (!ctx) return;
        const { run, state } = ctx;
        if (!canHandback(state)) return res.status(409).json({ error: `devolver ao QA só vale para run blocked/${authorization.STATUS} (status atual: ${state.status})` });
        const by = actorOf();
        if (authorizing.has(run.taskId)) return res.status(409).json({ error: 'outra decisão deste run está em andamento' });
        const expect = humanExpect(req, state);
        const operationId = operationIdOf(req);
        authorizing.add(run.taskId);
        try {
            let reserved;
            try {
                reserved = cas.reserveOperation({ runDir: run.dir, operation: 'qa_handback', actor: 'dashboard', operation_id: operationId, expected_state_version: expect.expected_state_version });
            } catch (e) {
                if (sendConflict(res, e)) return;
                throw e;
            }
            if (reserved.status === 'already_processed') return res.json({ ok: true, status: 'already_processed', operation_id: operationId });
            if (reserved.status === 'in_progress') return res.status(409).json({ ok: false, code: 'OPERATION_IN_PROGRESS', error: 'devolução já em andamento' });
            const out = await qaHandback.handback(run.dir, {
                by, operationId, env: consumerEnv, fetchImpl: handbackFetch,
                notes: typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 20000) : null,
                apontamentos: typeof req.body?.apontamentos === 'string' ? req.body.apontamentos.slice(0, 20000) : null,
                onArchived: () => afterHandbackArchive(run),
            });
            if (!out.ok) {
                const certain = Number.isInteger(out.http_status) && out.http_status < 500;
                cas.finishOperation({ runDir: run.dir, operation: 'qa_handback', operation_id: operationId, actor: 'dashboard' }, certain ? 'failed' : 'uncertain');
                pushRun(run.taskId);
                return res.status(502).json({ ok: false, error: redact(out.error), http_status: out.http_status ?? null, operation_id: operationId, retry_same_operation: !certain });
            }
            res.json({ ok: true, taskId: run.taskId, archived: true, to: path.relative(repoRoot, out.to), ticketId: out.ticketId });
        } catch (e) {
            console.error(`[dashboard] devolver ao QA ${run.taskId}: ${redact(e.message)}`);
            res.status(500).json({ error: redact(`Falha ao devolver ao QA: ${e.message}`) });
        } finally {
            authorizing.delete(run.taskId);
        }
    });

    // Arquivados. `dashboard`: os que o próprio dashboard arquivou (registro, com
    // Restaurar). `months`: a rotação automática (memory/archive/<YYYY-MM>/), só
    // leitura, agrupada por mês, mais recente primeiro; o mesmo task-id arquivado a
    // partir de vários checkouts (<task-id>__<checkout>) conta uma vez, a cópia mais
    // recente. ?summary=1 devolve só a contagem por mês (readdir, sem ler state.json)
    // — é o que o grupo "Arquivados" fechado pede; a lista vem ao expandir.
    const MONTH_DIR_RE = /^\d{4}-\d{2}$/;
    function rotatedMonths() {
        try {
            return fs.readdirSync(rotatedArchiveDir, { withFileTypes: true })
                .filter(d => d.isDirectory() && MONTH_DIR_RE.test(d.name)).map(d => d.name).sort().reverse();
        } catch { return []; }
    }
    function rotatedEntries(month) {
        try {
            return fs.readdirSync(path.join(rotatedArchiveDir, month), { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => ({ name: d.name, taskId: d.name.replace(/__[\w.-]+$/, '') }))
                .filter(e => isRunDirName(e.taskId));
        } catch { return []; }
    }
    function listRotatedArchive(summary) {
        if (summary) {
            const seen = new Set();
            const months = [];
            for (const month of rotatedMonths()) {
                const ids = rotatedEntries(month).map(e => e.taskId).filter(id => !seen.has(id));
                ids.forEach(id => seen.add(id));
                if (ids.length) months.push({ month, count: new Set(ids).size });
            }
            return months;
        }
        const byTask = new Map();
        for (const month of rotatedMonths()) {
            for (const e of rotatedEntries(month)) {
                const rel = path.join('memory', 'archive', month, e.name);
                const state = readJson(path.join(rotatedArchiveDir, month, e.name, 'state.json'));
                const run = {
                    taskId: e.taskId, month, path: rel, status: state?.status || null, node: state?.node || null,
                    updatedAt: state?.updated_at || state?.node_started_at || state?.started_at || null,
                    ticket: state?.redmine_ticket ? { id: state.redmine_ticket.id ?? null, subject: state.redmine_ticket.subject ?? null } : null,
                };
                const prev = byTask.get(e.taskId);
                if (!prev) byTask.set(e.taskId, { ...run, copies: 1 });
                else {
                    const copies = prev.copies + 1;
                    byTask.set(e.taskId, (Date.parse(run.updatedAt) || 0) > (Date.parse(prev.updatedAt) || 0) ? { ...run, copies } : { ...prev, copies });
                }
            }
        }
        const months = new Map();
        for (const run of byTask.values()) {
            if (!months.has(run.month)) months.set(run.month, []);
            months.get(run.month).push(run);
        }
        return [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, runs]) => ({
            month, count: runs.length,
            runs: runs.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)),
        }));
    }

    app.get('/api/archive', (req, res) => {
        const reg = readRegistry();
        const dashboard = Object.entries(reg).map(([taskId, e]) => {
            const state = readJson(path.join(repoRoot, e.to, 'state.json'));
            return {
                taskId, archived_at: e.archived_at, kind: e.kind, status: e.status, to: e.to,
                exists: fs.existsSync(path.join(repoRoot, e.to)),
                ticket: state?.redmine_ticket || null, updatedAt: state?.updated_at || null,
            };
        }).sort((a, b) => Date.parse(b.archived_at) - Date.parse(a.archived_at));
        const months = listRotatedArchive(req.query.summary === '1');
        res.json({ dashboard, months, total: months.reduce((n, m) => n + m.count, 0) });
    });

    app.post('/api/archive/:taskId/restore', (req, res) => {
        const taskId = req.params.taskId;
        const reg = readRegistry();
        const e = reg[taskId];
        if (!isRunDirName(taskId) || !e) return res.status(404).json({ error: 'não arquivado pelo dashboard' });
        const from = path.resolve(repoRoot, e.to);
        const to = path.resolve(repoRoot, e.from);
        const root = runRoots().find(r => path.resolve(to) === path.join(path.resolve(r.dir), taskId));
        if (!root || !from.startsWith(path.resolve(root.dir) + path.sep)) return res.status(400).json({ error: 'caminho fora de memory/runs' });
        if (fs.existsSync(to)) return res.status(409).json({ error: 'já existe uma pasta com esse run no lugar original' });
        if (!fs.existsSync(from)) { delete reg[taskId]; writeRegistry(reg); return res.status(410).json({ error: 'a pasta arquivada não existe mais' }); }
        try { fs.renameSync(from, to); } catch (err) {
            console.error(`[dashboard] restaurar ${taskId}: ${redact(err.message)}`);
            return res.status(500).json({ error: 'Não foi possível mover a pasta de volta' });
        }
        delete reg[taskId];
        writeRegistry(reg);
        runsCache.get(root.dir)?.names.add(taskId);
        broadcast({ type: 'runs_changed' });
        res.json({ ok: true, taskId, to: e.from });
    });

    // Screenshots do run (memory/runs/<taskId>/screenshots/*). Nome restrito por regex
    // e caminho final conferido contra o diretório — nada sai de screenshots/.
    const SCREENSHOT_RE = /^[\w-]+\.(png|jpg|jpeg|webp)$/i;
    const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

    app.get('/api/runs/:taskId/screenshots', (req, res) => {
        if (!isRunDirName(req.params.taskId)) return res.status(400).json({ error: 'taskId inválido' });
        const run = resolveRun(req.params.taskId);
        if (!run) return res.json({ screenshots: [] });
        const dir = path.join(run.dir, 'screenshots');
        let names;
        try { names = fs.readdirSync(dir); } catch { return res.json({ screenshots: [] }); }
        const screenshots = [];
        for (const filename of names) {
            if (!SCREENSHOT_RE.test(filename)) continue;
            let st;
            try { st = fs.lstatSync(path.join(dir, filename)); } catch { continue; }
            if (!st.isFile()) continue; // symlink/diretório não entram
            screenshots.push({ filename, size: st.size, mtime: st.mtime.toISOString() });
        }
        screenshots.sort((a, b) => a.mtime.localeCompare(b.mtime));
        res.json({ screenshots });
    });

    app.get('/api/runs/:taskId/screenshots/:filename', (req, res) => {
        const { taskId, filename } = req.params;
        if (!isRunDirName(taskId)) return res.status(400).json({ error: 'taskId inválido' });
        if (!SCREENSHOT_RE.test(filename)) return res.status(400).json({ error: 'nome de arquivo inválido' });
        const run = withRun(req, res);
        if (!run) return;
        const base = path.resolve(run.dir, 'screenshots');
        const file = path.resolve(base, filename);
        if (!file.startsWith(base + path.sep)) return res.status(400).json({ error: 'nome de arquivo inválido' });
        let st;
        try { st = fs.lstatSync(file); } catch { st = null; }
        if (!st || !st.isFile()) return res.status(404).json({ error: 'screenshot não encontrado' });
        res.set('X-Content-Type-Options', 'nosniff');
        res.type(IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()]);
        fs.createReadStream(file)
            .on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'screenshot não encontrado' }); else res.destroy(); })
            .pipe(res);
    });
    // Qualquer coisa com mais segmentos (screenshots/../../x) é nome inválido, não "rota inexistente".
    app.all('/api/runs/:taskId/screenshots/*', (req, res) => res.status(400).json({ error: 'nome de arquivo inválido' }));

    // ---------------------------------------------------------------------------
    // Proxies Redmine / Bitbucket. As credenciais ficam só aqui (header da chamada
    // de saída), nunca em URL, log ou resposta — e toda mensagem de erro passa por
    // redact() antes de sair.
    const bitbucketApi = options.bitbucketApi || 'https://api.bitbucket.org/2.0';
    const SLUG_RE = /^[A-Za-z0-9._-]+$/;

    function safeReadState(run) {
        return readRunState(run);
    }

    async function fetchJson(url, headers) {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!resp.ok) {
            const err = new Error(`HTTP ${resp.status}`);
            err.status = resp.status;
            throw err;
        }
        return resp.json();
    }

    function upstreamError(e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'tempo esgotado';
        return redact(e.message || 'erro desconhecido');
    }

    // ---------------------------------------------------------------------------
    // Aba "PRs": todos os PRs do Bitbucket do repo primário (BITBUCKET_WORKSPACE/
    // BITBUCKET_REPO_SLUG — mesma convenção de env já usada acima), com vínculo a
    // run/ticket via memory/runs/**/state.json. Diferente de /api/runs/:taskId/pr
    // (que consulta os PRs DE UMA task já conhecida): aqui a lista vem do
    // Bitbucket primeiro e o vínculo ao run é best-effort depois.
    // repos: o primário + os irmãos (mesma lista SIBLING_REPOS do watcher), ou
    // BITBUCKET_PR_REPOS (vírgula) se definido. PR de ticket costuma nascer em
    // mais de um repo, e a aba lista todos.
    const DEFAULT_SIBLING_REPOS = siblingNames;
    function bitbucketConfig() {
        const workspace = consumerEnv.BITBUCKET_WORKSPACE;
        const repo = consumerEnv.BITBUCKET_REPO_SLUG;
        const token = consumerEnv.BITBUCKET_API_TOKEN;
        if (!token) return { error: 'Bitbucket não configurado (BITBUCKET_API_TOKEN)' };
        if (!SLUG_RE.test(workspace || '') || !SLUG_RE.test(repo || '')) {
            return { error: 'Bitbucket não configurado (BITBUCKET_WORKSPACE/BITBUCKET_REPO_SLUG)' };
        }
        const configured = (consumerEnv.BITBUCKET_PR_REPOS || '').split(',').map(r => r.trim()).filter(Boolean);
        const repos = [...new Set([repo, ...(configured.length ? configured : DEFAULT_SIBLING_REPOS)])].filter(r => SLUG_RE.test(r));
        return { workspace, repo, repos, token };
    }

    // ?repo= das rotas de um PR só: tem que ser um dos repos configurados.
    function repoParam(req, cfg) {
        const repo = req.query.repo || cfg.repo;
        return cfg.repos.includes(repo) ? repo : null;
    }

    // taskId/ticketId de quem abriu cada PR, varrendo TODOS os runs (ativos +
    // worktrees + arquivados — merge geralmente já arquivou a task). Chave
    // "<repo>#<id>" pra não colidir entre repos irmãos que reaproveitam número.
    function buildPrRunIndex() {
        const index = new Map();
        const addFrom = byTask => {
            for (const [taskId, candidates] of byTask) {
                const chosen = pickCandidate(taskId, candidates);
                const state = chosen && readJson(path.join(chosen.dir, 'state.json'));
                if (!state) continue;
                const ticketId = ticketIdOf(taskId, state);
                // URL montada aqui (server-side) porque REDMINE_URL não é exposta ao
                // cliente — o front só recebe o link já pronto, nunca a variável.
                const redmineUrl = (consumerEnv.REDMINE_URL || '').replace(/\/+$/, '');
                const ticketUrl = ticketId && redmineUrl ? `${redmineUrl}/issues/${ticketId}` : null;
                for (const p of projectPrs(state.pull_request)) {
                    if (!p.id) continue;
                    const key = `${p.repo || primaryRepo}#${p.id}`;
                    if (!index.has(key)) index.set(key, { taskId, ticketId, ticketUrl });
                }
            }
        };
        addFrom(collectCandidates());
        addFrom(archivedCandidates());
        return index;
    }

    // Identidade dona do BITBUCKET_API_TOKEN (GET /2.0/user). Cacheada por 5 min,
    // inclusive a falha: token sem o escopo read:user:bitbucket dá 403 sempre.
    let currentUserCache = null;
    async function cachedCurrentUser(cfg) {
        if (currentUserCache && Date.now() - currentUserCache.at < 5 * 60 * 1000) return currentUserCache.user;
        let user = null;
        try {
            user = await bitbucketPr.getCurrentUser({ token: cfg.token, apiBase: bitbucketApi, timeoutMs: FETCH_TIMEOUT_MS });
        } catch (e) {
            console.error(`[dashboard] Bitbucket /user: ${upstreamError(e)}`);
        }
        currentUserCache = { user, at: Date.now() };
        return user;
    }

    // "Meus PRs": a aba só lista PRs de quem é dono do token. Ordem:
    // BITBUCKET_ACCOUNT_ID > GET /user > autor de um PR que o pipeline abriu
    // (scripts/bitbucket-open-pr.sh abre com esse mesmo token, então o autor é
    // o dono dele). Sem nenhum dos três, null.
    let tokenOwnerFromRuns = null;
    async function resolveMe(cfg, prIndex) {
        const envId = (consumerEnv.BITBUCKET_ACCOUNT_ID || '').trim();
        if (envId) return { accountId: envId, displayName: null };
        const user = await cachedCurrentUser(cfg);
        if (user?.accountId) return user;
        if (tokenOwnerFromRuns) return tokenOwnerFromRuns;
        let tries = 0;
        for (const key of [...prIndex.keys()].reverse()) {
            const [repo, prId] = key.split('#');
            if (!cfg.repos.includes(repo) || tries++ >= 3) continue;
            try {
                const pr = await bitbucketPr.getPR({ workspace: cfg.workspace, repo, prId, token: cfg.token, apiBase: bitbucketApi, timeoutMs: FETCH_TIMEOUT_MS });
                if (pr.authorAccountId) return (tokenOwnerFromRuns = { accountId: pr.authorAccountId, displayName: pr.author });
            } catch (e) {
                console.error(`[dashboard] Bitbucket PR ${key} (identidade): ${upstreamError(e)}`);
            }
        }
        return null;
    }

    // Conflito via git merge-tree no clone local de cada repo (primário =
    // repoRoot, irmãos = ../<repo>). options.prConflictDetector: injeção em teste.
    const conflictDetectors = new Map();
    function detectorFor(repo, cfg) {
        if (options.prConflictDetector) return options.prConflictDetector;
        if (!conflictDetectors.has(repo)) {
            const dir = repo === cfg.repo ? repoRoot : path.resolve(repoRoot, '..', repo);
            conflictDetectors.set(repo, fs.existsSync(path.join(dir, '.git')) ? createConflictDetector({ repoRoot: dir }) : null);
        }
        return conflictDetectors.get(repo);
    }
    async function withConflicts(pr, cfg) {
        if (pr.state !== 'OPEN') return pr;
        const detector = detectorFor(pr.repo || cfg.repo, cfg);
        if (!detector) return pr;
        try {
            return { ...pr, ...(await detector.detect(pr)) };
        } catch (e) {
            console.error(`[dashboard] conflito do PR ${pr.repo}#${pr.id}: ${e.message}`);
            return pr;
        }
    }

    function decoratePr(pr, cfg, me, prIndex) {
        const linkedRun = prIndex.get(`${pr.repo || cfg.repo}#${pr.id}`) || null;
        const canApprove = pr.state === 'OPEN' && !!me?.accountId
            && pr.reviewers.some(r => r.accountId && r.accountId === me.accountId && !r.approved);
        return { ...pr, linkedRun, canApprove };
    }

    const NO_IDENTITY_ERROR = 'Não deu para identificar sua conta no Bitbucket (o token não tem o escopo read:user:bitbucket e nenhum run tem PR aberto pelo pipeline). Defina BITBUCKET_ACCOUNT_ID no .env.';

    app.get('/api/prs', async (req, res) => {
        const cfg = bitbucketConfig();
        if (cfg.error) return res.status(503).json({ error: cfg.error });
        try {
            const prIndex = buildPrRunIndex();
            const me = await resolveMe(cfg, prIndex);
            if (!me) return res.status(503).json({ error: NO_IDENTITY_ERROR });
            const warnings = [];
            const list = (repo, state, limit) => bitbucketPr.listPRs({ workspace: cfg.workspace, repo, token: cfg.token, state, limit, authorAccountId: me.accountId, apiBase: bitbucketApi, timeoutMs: FETCH_TIMEOUT_MS });
            const perRepo = await Promise.all(cfg.repos.map(async repo => {
                try {
                    const [open, merged] = await Promise.all([list(repo, 'OPEN', 50), list(repo, 'MERGED', 20)]);
                    return { open, merged };
                } catch (e) {
                    console.error(`[dashboard] Bitbucket /api/prs (${repo}): ${upstreamError(e)}`);
                    warnings.push(`${repo}: ${upstreamError(e)}`);
                    return null;
                }
            }));
            if (perRepo.every(r => r === null)) return res.status(502).json({ error: `Bitbucket: ${warnings.join('; ')}` });
            const open = await Promise.all(perRepo.flatMap(r => r?.open || []).map(pr => withConflicts(pr, cfg)));
            const merged = perRepo.flatMap(r => r?.merged || [])
                .sort((a, b) => (Date.parse(b.updatedOn) || 0) - (Date.parse(a.updatedOn) || 0)).slice(0, 20);
            const prs = [...open, ...merged].map(pr => decoratePr(pr, cfg, me, prIndex));
            const linkedRuns = Object.fromEntries(prs.filter(p => p.linkedRun).map(p => [`${p.repo}#${p.id}`, p.linkedRun]));
            res.json(redactDeep({
                prs, linkedRuns, repos: cfg.repos, warnings,
                currentUser: { displayName: me.displayName || null },
                fetched_at: new Date().toISOString(),
            }));
        } catch (e) {
            console.error(`[dashboard] Bitbucket /api/prs: ${upstreamError(e)}`);
            res.status(502).json({ error: `Bitbucket: ${upstreamError(e)}` });
        }
    });

    app.get('/api/prs/:id', async (req, res) => {
        const cfg = bitbucketConfig();
        if (cfg.error) return res.status(503).json({ error: cfg.error });
        if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id de PR inválido' });
        const repo = repoParam(req, cfg);
        if (!repo) return res.status(400).json({ error: 'repo inválido' });
        try {
            const prIndex = buildPrRunIndex();
            const [detail, me] = await Promise.all([
                bitbucketPr.getPRDetail({ workspace: cfg.workspace, repo, prId: req.params.id, token: cfg.token, apiBase: bitbucketApi, timeoutMs: FETCH_TIMEOUT_MS }),
                resolveMe(cfg, prIndex),
            ]);
            res.json(redactDeep(decoratePr(await withConflicts(detail, cfg), cfg, me, prIndex)));
        } catch (e) {
            console.error(`[dashboard] Bitbucket /api/prs/${req.params.id}: ${upstreamError(e)}`);
            res.status(e.status === 404 ? 404 : 502).json({ error: e.status === 404 ? 'PR não encontrado no Bitbucket' : `Bitbucket: ${upstreamError(e)}` });
        }
    });

    const prApproveInFlight = new Set();
    app.post('/api/prs/:id/approve', async (req, res) => {
        const cfg = bitbucketConfig();
        if (cfg.error) return res.status(503).json({ error: cfg.error });
        const id = req.params.id;
        if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'id de PR inválido' });
        const repo = repoParam(req, cfg);
        if (!repo) return res.status(400).json({ error: 'repo inválido' });
        const key = `${repo}#${id}`;
        if (prApproveInFlight.has(key)) return res.status(409).json({ error: 'já aprovando' });
        prApproveInFlight.add(key);
        try {
            const result = await bitbucketPr.approvePR({ workspace: cfg.workspace, repo, prId: id, token: cfg.token, apiBase: bitbucketApi, timeoutMs: FETCH_TIMEOUT_MS });
            res.json(redactDeep(result));
        } catch (e) {
            console.error(`[dashboard] Bitbucket /api/prs/${id}/approve: ${upstreamError(e)}`);
            res.status(e.status === 404 ? 404 : 502).json({ error: e.status === 404 ? 'PR não encontrado no Bitbucket' : `Bitbucket: ${upstreamError(e)}` });
        } finally {
            prApproveInFlight.delete(key);
        }
    });

    app.get('/api/runs/:taskId/ticket', async (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const ticketId = ticketIdOf(run.taskId, safeReadState(run));
        if (!ticketId) return res.status(404).json({ error: 'no ticket_id in state' });

        const redmineUrl = (consumerEnv.REDMINE_URL || '').replace(/\/+$/, '');
        const apiKey = consumerEnv.REDMINE_API_KEY;
        if (!redmineUrl || !apiKey) return res.status(503).json({ error: 'Redmine not configured' });

        try {
            const { issue } = await fetchJson(`${redmineUrl}/issues/${ticketId}.json`, { 'X-Redmine-API-Key': apiKey, Accept: 'application/json' });
            res.json({
                id: issue.id,
                subject: issue.subject,
                status: issue.status?.name,
                assigned_to: issue.assigned_to?.name,
                tracker: issue.tracker?.name,
                priority: issue.priority?.name,
                estimated_hours: issue.estimated_hours ?? null,
                done_ratio: issue.done_ratio ?? null,
                updated_on: issue.updated_on,
                url: `${redmineUrl}/issues/${issue.id}`,
            });
        } catch (e) {
            if (e.status === 404) return res.status(404).json({ error: `ticket #${ticketId} não encontrado no Redmine` });
            console.error(`[dashboard] Redmine ticket #${ticketId}: ${upstreamError(e)}`);
            res.status(502).json({ error: `Redmine: ${upstreamError(e)}` });
        }
    });

    // Draft da spec gerado por IA esperando aprovação humana (state.spec_pending_approval,
    // gravado pelo watcher). draft_path é relativo ao repo e só vale dentro de
    // memory/spec/ terminando em .draft.md — nada mais do disco sai por aqui.
    const specDir = path.join(repoRoot, 'memory', 'spec');
    function draftFile(draftPath) {
        if (typeof draftPath !== 'string' || !draftPath || path.isAbsolute(draftPath) || !draftPath.endsWith('.draft.md')) return null;
        const file = path.resolve(repoRoot, draftPath);
        return file.startsWith(specDir + path.sep) ? file : null;
    }

    // Provenance de AC (scripts/lib/ac-provenance.js, docs/ac-provenance.md). Identidade
    // de um AC = (ticket, ac_id): AC-01 existe em todo ticket, então a rota preferencial
    // leva os dois. Fonte de verdade = memory/spec/<ticket>-ac-provenance.json; o
    // .graph/ac-registry.json só ajuda a saber que o AC existe. Só referências saem daqui
    // (nunca texto de AC, comentário ou anexo) e a resposta passa pelo redactDeep.
    const acRegistryPath = path.resolve(repoRoot, options.acRegistryPath || path.join(repoRoot, '.graph', 'ac-registry.json'));
    function readAcRegistrySafe() {
        try { return acRegistry.readRegistry(acRegistryPath); } catch { return { tasks: {} }; }
    }
    // IDs da spec do checkout principal e, se houver, do worktree do ticket (onde a spec
    // vive durante o ciclo — o /commit é quem sincroniza a principal).
    function specAcIdsOf(ticket) {
        const ids = new Set();
        for (const file of [path.join(specDir, `${ticket}-spec.md`), path.join(worktreesDir, ticket, 'memory', 'spec', `${ticket}-spec.md`)]) {
            try { for (const id of acRegistry.extractACs(fs.readFileSync(file, 'utf8'), ticket).acIds) ids.add(id); } catch { /* sem spec aqui */ }
        }
        return [...ids];
    }
    function canonAcParam(raw) {
        const m = /^AC-(\d+)$/i.exec(String(raw || '').trim());
        return m ? acIdsLib.canonicalId(Number(m[1])) : null;
    }
    // {exists, log, entry} de (ticket, ac). log.error = log ilegível.
    function acLookup(ticket, ac, registry) {
        const entry = registry.tasks?.[ticket] || null;
        const log = acProvenance.readLog(ticket, { specDir });
        const inLog = !log.error && log.data.events.some(e => e.ac_id === ac);
        const exists = inLog || (Array.isArray(entry?.ac_ids) && entry.ac_ids.includes(ac)) || specAcIdsOf(ticket).includes(ac);
        return { exists, log, entry };
    }
    function provenanceTickets(registry) {
        const ids = new Set([...Object.keys(registry.tasks || {}), ...acProvenance.listTickets({ specDir })]);
        try { for (const f of fs.readdirSync(specDir)) { const m = /^(\d+)-spec\.md$/.exec(f); if (m) ids.add(m[1]); } } catch { /* sem specs */ }
        return [...ids].sort((a, b) => Number(a) - Number(b));
    }
    // Spec version/hash, evidência e PR do run mais recente do ticket (null se não há run).
    function acChainOf(ticket, ac) {
        let best = null, bestT = -1;
        for (const [taskId, candidates] of collectCandidates()) {
            if (!taskId.startsWith(`${ticket}-`)) continue;
            const c = pickCandidate(taskId, candidates);
            const state = c && readJson(path.join(c.dir, 'state.json'));
            const t = state ? stateTime(state) : -1;
            if (state && t > bestT) { best = { c, state }; bestT = t; }
        }
        if (!best) return { spec_version: null, spec_hash: null, evidence_ref: null, pr_ref: null, task_id: null };
        const { c, state } = best;
        const pr = projectPrs(state.pull_request)[0] || null;
        return {
            task_id: c.taskId,
            spec_version: Number.isInteger(state.spec?.version) ? state.spec.version : (Number.isInteger(state.spec_hash_version) ? state.spec_hash_version : null),
            spec_hash: typeof state.spec_hash === 'string' ? state.spec_hash : null,
            evidence_ref: fs.existsSync(path.join(c.dir, 'acceptance-evidence.json')) ? `memory/runs/${c.taskId}/acceptance-evidence.json#${ac}` : null,
            pr_ref: pr ? { repo: pr.repo || null, url: pr.url || null } : null,
        };
    }
    function sendProvenance(res, ticket, ac, registry) {
        const { exists, log, entry } = acLookup(ticket, ac, registry);
        if (log.error) return res.status(500).json({ error: `log de provenance do ticket ${ticket} ilegível (memory/spec/${ticket}-ac-provenance.json) — não reescrito` });
        if (!exists) {
            const legacyHint = entry?.legacy ? ` — o ticket ${ticket} é legado: critérios sem IDs AC-NN, não há como referenciá-los por ID` : '';
            return res.status(404).json({ error: `AC ${ac} não encontrado no ticket ${ticket}${legacyHint}` });
        }
        const sources = acProvenance.sourcesFor(log.data, ac);
        res.json(redactDeep({ ticket_id: ticket, ac_id: ac, legacy: sources.length === 0, sources, ...acChainOf(ticket, ac) }));
    }

    app.get('/api/provenance/:ticket/:acId', (req, res) => {
        const ticket = String(req.params.ticket);
        const ac = canonAcParam(req.params.acId);
        if (!/^\d+$/.test(ticket) || !ac) return res.status(400).json({ error: 'uso: /api/provenance/<ticket>/<AC-NN>' });
        sendProvenance(res, ticket, ac, readAcRegistrySafe());
    });

    app.get('/api/provenance/:acId', (req, res) => {
        const ac = canonAcParam(req.params.acId);
        if (!ac) return res.status(400).json({ error: 'uso: /api/provenance/<AC-NN>?ticket=<ticket> (ou /api/provenance/<ticket>/<AC-NN>)' });
        const registry = readAcRegistrySafe();
        if (req.query.ticket != null) {
            const ticket = String(req.query.ticket);
            if (!/^\d+$/.test(ticket)) return res.status(400).json({ error: 'ticket deve ser numérico' });
            return sendProvenance(res, ticket, ac, registry);
        }
        // Sem ticket: só resolve se exatamente um ticket tiver esse AC — nunca escolhe um AC-01 arbitrário.
        const matches = provenanceTickets(registry).filter(t => acLookup(t, ac, registry).exists);
        if (!matches.length) return res.status(404).json({ error: `AC ${ac} não encontrado em nenhum ticket` });
        if (matches.length > 1) {
            return res.status(409).json({ error: `AC ${ac} existe em ${matches.length} tickets — ac_id não é global; informe o ticket (/api/provenance/<ticket>/${ac})`, candidates: matches });
        }
        sendProvenance(res, matches[0], ac, registry);
    });

    app.get('/api/runs/:taskId/spec-draft', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const state = safeReadState(run);
        if (state?.status === 'spec-draft') {
            // Rascunho gerado pelo watcher: o caminho sai do id do ticket, nunca do gate file.
            const ticketId = ticketIdOf(run.taskId, state);
            if (!ticketId) return res.status(404).json({ error: 'no ticket_id in state' });
            const specPath = `memory/spec/${ticketId}-spec.md`;
            let content;
            try { content = fs.readFileSync(path.join(specDir, `${ticketId}-spec.md`), 'utf8'); } catch { return res.status(404).json({ error: 'spec rascunho não encontrada' }); }
            return res.json({
                taskId: run.taskId, kind: 'spec-draft', draft_path: specPath, content: redact(content),
                posted_at: state.spec_draft?.since ?? null, missing_sections: [],
            });
        }
        if (state?.status !== 'spec-pending-approval') return res.status(409).json({ error: 'run não está aguardando aprovação de spec' });
        const pending = state.spec_pending_approval || {};
        const file = draftFile(pending.draft_path);
        if (!file) return res.status(400).json({ error: 'draft_path inválido (esperado memory/spec/*.draft.md)' });
        let content;
        try { content = fs.readFileSync(file, 'utf8'); } catch { return res.status(404).json({ error: 'draft não encontrado' }); }
        res.json({
            taskId: run.taskId,
            draft_path: pending.draft_path,
            content: redact(content),
            posted_at: pending.posted_at ?? null,
            comment_id: pending.comment_id ?? null,
            reminder_sent: pending.reminder_sent === true,
            missing_sections: Array.isArray(pending.missing_sections) ? pending.missing_sections : [],
            keyword: pending.keyword || consumerEnv.SPEC_APPROVAL_KEYWORD || 'aprovado',
        });
    });

    // Aprovação do draft pelo dashboard: posta no ticket SÓ a palavra-chave (+ uma linha
    // fixa de origem). Não aceita texto livre — não é um canal genérico de comentário.
    // O watcher faz o merge do draft na spec no próximo tick — ou, na spec rascunho
    // (spec-draft), troca para draft: false (specDraftApproval no watcher).
    // SPEC_CHANGE do /implement (spec-change-pending-approval): mesma rota, com
    // action "approve" (palavra de aprovação) ou "reject" (SPEC_REJECTION_KEYWORD); o
    // watcher aplica no próximo tick (runSpecChangeGate). Só depois que o watcher publicou
    // a proposta no Redmine — resposta anterior ao comentário dele não conta.
    const approvalsInFlight = new Set();
    app.post('/api/redmine/comment', async (req, res) => {
        const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : '';
        const action = req.body?.action === 'reject' ? 'reject' : 'approve';
        const run = resolveRun(taskId) || pretaskRun(taskId);
        if (!run) return res.status(404).json({ error: `run não encontrado: ${taskId}` });
        const state = safeReadState(run);
        const isSpecDraft = state?.status === 'spec-draft';
        const isSpecChange = state?.status === 'spec-change-pending-approval';
        if (state?.status !== 'spec-pending-approval' && !isSpecDraft && !isSpecChange) return res.status(409).json({ error: 'run não está aguardando aprovação de spec' });
        if (action === 'reject' && !isSpecChange) return res.status(409).json({ error: 'rejeição só vale para SPEC_CHANGE pendente' });
        if (isSpecChange && !state.spec_change_pending?.posted_at) return res.status(409).json({ error: 'a SPEC_CHANGE ainda não foi publicada no Redmine — o watcher publica no próximo tick' });
        const ticketId = ticketIdOf(run.taskId, state);
        if (!ticketId) return res.status(404).json({ error: 'no ticket_id in state' });

        const redmineUrl = (consumerEnv.REDMINE_URL || '').replace(/\/+$/, '');
        const apiKey = consumerEnv.REDMINE_API_KEY;
        if (!redmineUrl || !apiKey) return res.status(503).json({ error: 'Redmine not configured' });

        // Aprovação humana (scripts/cas.js): a tela tem que estar atual (state_version +
        // spec_hash) e o mesmo clique não posta duas vezes (operation_id do pedido, num
        // namespace próprio — o change_id fica para a aplicação pelo watcher). A decisão de
        // consumir o operation_id é a reserva (cas.reserveOperation, dentro do lock): de
        // pedidos simultâneos, só um posta. Desfecho em cas.finishOperation; reserva
        // retomada (resultado anterior incerto/crash) confere o ticket antes de repostar.
        // Semântica e crash: docs/concurrency-map.md ("Aprovação pelo dashboard").
        const operation = isSpecChange ? 'spec_change_approval' : 'spec_approval';
        const expect = humanExpect(req, state);
        const casOpts = {
            expected_state_version: expect.expected_state_version, expected_spec_hash: expect.expected_spec_hash,
            operation_id: `dashboard:${operationIdOf(req)}`,
        };
        const marker = `[op ${casOpts.operation_id}]`;
        const hasRunState = !run.pretask && fs.existsSync(path.join(run.dir, 'state.json'));
        const finishCtx = { runDir: run.dir, operation, operation_id: casOpts.operation_id, actor: 'dashboard' };
        const finish = outcome => {
            if (!hasRunState) return;
            try { cas.finishOperation(finishCtx, outcome); } catch (e) {
                console.warn(`[dashboard] aprovação de ${run.taskId}: registro do desfecho (${outcome}) falhou: ${redact(e.message)}`);
            }
        };
        let reservation = null;
        const flightKey = `${run.taskId}:${casOpts.operation_id}`;
        if (hasRunState) {
            try {
                reservation = cas.reserveOperation({ runDir: run.dir, operation, actor: 'dashboard', ...casOpts }, { ttlMs: APPROVAL_RESERVATION_TTL_MS });
            } catch (e) {
                if (sendConflict(res, e)) return;
                throw e;
            }
            if (reservation.status === 'already_processed') return res.json({ ok: true, status: 'already_processed', ticketId, action });
            if (reservation.status === 'in_progress') return res.status(409).json({ code: 'OPERATION_IN_PROGRESS', error: 'esta aprovação já está sendo enviada ao Redmine' });
        } else {
            // Run sem state.json (pré-task): só a garantia do processo do dashboard.
            if (approvalsInFlight.has(flightKey)) return res.status(409).json({ code: 'OPERATION_IN_PROGRESS', error: 'esta aprovação já está sendo enviada ao Redmine' });
            approvalsInFlight.add(flightKey);
        }

        const keyword = action === 'reject'
            ? (consumerEnv.SPEC_REJECTION_KEYWORD || 'rejeitado')
            : (consumerEnv.SPEC_APPROVAL_KEYWORD || 'aprovado');
        const scId = state.spec_change_pending?.id || 'SPEC_CHANGE';
        const notes = isSpecChange
            ? `${keyword}\n\n(${action === 'reject' ? 'rejeitado' : 'aprovado'} pelo dashboard local — decisão humana sobre a ${scId} proposta pelo /implement)`
            : isSpecDraft
                ? `${keyword}\n\n(aprovado pelo dashboard local — revisão humana da spec rascunho gerada do ticket)`
                : `${keyword}\n\n(aprovado pelo dashboard local — revisão humana do draft gerado por IA)`;
        const headers = { 'X-Redmine-API-Key': apiKey, 'Content-Type': 'application/json' };
        try {
            if (reservation?.reclaimed) {
                // Tentativa anterior com o mesmo operation_id pode ter postado (timeout,
                // 5xx, dashboard morto no meio): confere pelo marcador antes de repetir.
                let posted;
                try {
                    const r = await fetch(`${redmineUrl}/issues/${ticketId}.json?include=journals`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    posted = ((await r.json())?.issue?.journals || []).some(j => typeof j?.notes === 'string' && j.notes.includes(marker));
                } catch (e) {
                    finish('uncertain');
                    console.error(`[dashboard] Redmine #${ticketId}: conferência da aprovação anterior falhou: ${upstreamError(e)}`);
                    return res.status(502).json({ error: `Redmine: não foi possível confirmar se a aprovação anterior foi registrada (${upstreamError(e)}) — tente de novo` });
                }
                if (posted) {
                    finish('done');
                    return res.json({ ok: true, status: 'already_processed', ticketId, action });
                }
            }
            let resp;
            try {
                resp = await fetch(`${redmineUrl}/issues/${ticketId}.json`, {
                    method: 'PUT', headers,
                    body: JSON.stringify({ issue: { notes: `${notes}\n\n${marker}` } }),
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
            } catch (e) {
                finish('uncertain'); // timeout/rede: o PUT pode ter chegado
                throw e;
            }
            if (!resp.ok) {
                // 4xx: o Redmine recusou, nada gravado. 5xx: pode ter gravado antes de falhar.
                finish(resp.status < 500 ? 'failed' : 'uncertain');
                throw new Error(`HTTP ${resp.status}`);
            }
            finish('done');
            res.json({ ok: true, ticketId, action });
        } catch (e) {
            console.error(`[dashboard] Redmine comentário #${ticketId}: ${upstreamError(e)}`);
            res.status(502).json({ error: `Redmine: ${upstreamError(e)}` });
        } finally {
            approvalsInFlight.delete(flightKey);
        }
    });

    app.get('/api/runs/:taskId/pr', async (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const pullRequest = safeReadState(run)?.pull_request;
        const prs = projectPrs(pullRequest);
        if (!prs.length) return res.status(404).json({ error: 'no pull_request in state' });
        // Todos os repos de state.pull_request (PR Matrix do detalhe): repo registrado
        // sem URL/ID de PR (ex: { branch, pushed, pr_url: null }) vira linha com erro
        // em vez de sumir.
        if (pullRequest && typeof pullRequest === 'object' && !prs.some(p => !p.repo)) {
            for (const repo of Object.keys(pullRequest)) {
                if (!prs.some(p => p.repo === repo)) prs.push({ repo, workspace: null, id: null, url: null, state: null, last_checked_at: null });
            }
        }

        const token = consumerEnv.BITBUCKET_API_TOKEN;
        if (!token) return res.status(503).json({ error: 'Bitbucket not configured' });
        if (!prs.some(p => p.id)) return res.status(422).json({ error: 'cannot determine PR id from state' });

        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        const results = await Promise.all(prs.map(async p => {
            const workspace = p.workspace || consumerEnv.BITBUCKET_WORKSPACE;
            const repo = p.repo || consumerEnv.BITBUCKET_REPO_SLUG;
            const base = { repo, id: p.id, url: p.url, local_state: p.state, status: p.state, last_checked_at: p.last_checked_at };
            if (!p.id) return { ...base, error: p.url ? 'cannot determine PR id from state' : 'sem URL/ID de PR no state.json' };
            if (!SLUG_RE.test(workspace || '') || !SLUG_RE.test(repo || '')) {
                return { ...base, error: 'workspace/repositório do PR desconhecido — defina BITBUCKET_WORKSPACE e BITBUCKET_REPO_SLUG' };
            }
            try {
                const pr = await fetchJson(`${bitbucketApi}/repositories/${workspace}/${repo}/pullrequests/${p.id}`, headers);
                return {
                    ...base,
                    id: pr.id,
                    title: pr.title,
                    state: pr.state,
                    author: pr.author?.display_name,
                    created_on: pr.created_on,
                    updated_on: pr.updated_on,
                    url: pr.links?.html?.href || p.url,
                    source: pr.source?.branch?.name,
                    destination: pr.destination?.branch?.name,
                    reviewers: (pr.reviewers || []).map(r => r.display_name),
                    participants: (pr.participants || []).filter(x => x.approved).map(x => x.user?.display_name),
                };
            } catch (e) {
                console.error(`[dashboard] Bitbucket PR ${repo}#${p.id}: ${upstreamError(e)}`);
                return { ...base, error: e.status === 404 ? 'PR não encontrado no Bitbucket' : `Bitbucket: ${upstreamError(e)}` };
            }
        }));
        res.json({ prs: results.map(r => redactDeep(r)), fetched_at: new Date().toISOString() });
    });

    // "Marcar como pronto" (painel de preview): tira de Draft TODOS os PRs da task
    // (bitbucket-open-pr.sh abre sempre como Draft) e grava pr_status "ready". A task
    // vem do body (taskId do run aberto no painel); sem ele, :ticketId pode ser o
    // próprio task-id ou o número do ticket (vale o run mais recente dele com PR).
    // Só grava "ready" se todos os PRs saíram de Draft — falha parcial deixa "draft"
    // (o botão continua lá pra tentar de novo; o que já saiu não é refeito).
    const prReadyInFlight = new Set();
    function resolvePrRun(ticketId, taskId) {
        const byId = id => id && isRunDirName(id) ? (resolveRun(id) || archivedRun(id)) : null;
        const hinted = byId(taskId);
        if (hinted && String(ticketIdOf(hinted.taskId, readJson(path.join(hinted.dir, 'state.json')))) === ticketId) return hinted;
        const direct = byId(ticketId);
        if (direct) return direct;
        // POST raro: relê os roots do disco em vez de confiar no cache do chokidar
        // (run recém-criado ainda não reportado ficaria de fora).
        for (const { root } of [...runsCache.values()]) cacheRoot(root);
        let best = null, bestT = -1;
        for (const [id, candidates] of collectCandidates()) {
            const c = pickCandidate(id, candidates);
            const st = readJson(path.join(c.dir, 'state.json'));
            if (String(ticketIdOf(id, st)) !== ticketId || !projectPrs(st?.pull_request).length) continue;
            if (stateTime(st) > bestT) { best = c; bestT = stateTime(st); }
        }
        return best;
    }
    app.post('/api/pr/:ticketId/ready', async (req, res) => {
        const ticketId = String(req.params.ticketId);
        if (!TASK_ID_RE.test(ticketId)) return res.status(400).json({ error: 'ticket inválido' });
        const run = resolvePrRun(ticketId, typeof req.body?.taskId === 'string' ? req.body.taskId : null);
        if (!run) return res.status(404).json({ error: `run do ticket ${ticketId} não encontrado` });
        const statePath = path.join(run.dir, 'state.json');
        const state = readJson(statePath);
        if (state?.pr_status === 'merged') return res.status(409).json({ error: 'PR já mergeado' });
        const prs = projectPrs(state?.pull_request).filter(p => p.id);
        if (!prs.length) return res.status(422).json({ error: 'sem pr_url/pr_id no state.json' });
        const token = consumerEnv.BITBUCKET_API_TOKEN;
        if (!token) return res.status(503).json({ error: 'Bitbucket não configurado (BITBUCKET_API_TOKEN)' });
        if (prReadyInFlight.has(run.taskId)) return res.status(409).json({ error: 'já marcando como pronto' });

        prReadyInFlight.add(run.taskId);
        try {
            const failures = [];
            const readyRepos = new Set();
            for (const p of prs) {
                const workspace = p.workspace || consumerEnv.BITBUCKET_WORKSPACE;
                const repo = p.repo || consumerEnv.BITBUCKET_REPO_SLUG;
                if (!SLUG_RE.test(workspace || '') || !SLUG_RE.test(repo || '')) {
                    failures.push(`${repo || '?'}#${p.id}: workspace/repositório desconhecido`);
                    continue;
                }
                try {
                    await markPrReady({ workspace, repo, prId: p.id, token, apiBase: bitbucketApi, timeoutMs: FETCH_TIMEOUT_MS });
                    readyRepos.add(p.repo);
                } catch (e) {
                    console.error(`[dashboard] Bitbucket PR ready ${repo}#${p.id}: ${upstreamError(e)}`);
                    failures.push(`${repo}#${p.id}: ${e.status === 409 ? redact(e.message) : upstreamError(e)}`);
                }
            }
            // Sobre o disco fresco, dentro do lock: o watcher pode ter gravado no meio (polling de PRs).
            stateWriter.update(statePath, fresh => {
                if (fresh.pull_request && typeof fresh.pull_request === 'object') {
                    for (const repo of readyRepos) {
                        const entry = repo && fresh.pull_request[repo];
                        if (entry && typeof entry === 'object') entry.draft = false;
                    }
                }
                if (!failures.length && fresh.pr_status !== 'merged') fresh.pr_status = 'ready';
                if (fresh.pr_id == null || fresh.pr_id === '') fresh.pr_id = prs[0].id;
            }, { operation: 'pr_ready', actor: 'dashboard' });
            if (failures.length) return res.status(502).json({ error: `Bitbucket: ${failures.join('; ')}` });
            res.json({ ok: true });
        } finally {
            prReadyInFlight.delete(run.taskId);
        }
    });

    // ---------------------------------------------------------------------------
    // Controle do watcher (scripts/watcher-manager.js). Atrás do filtro de localhost
    // como o resto: start/stop derruba/sobe processo, não pode vir de página de fora.
    const watcherManager = options.watcherManager || defaultWatcherManager.createWatcherManager({ repoRoot, cwd: repoRoot, env: consumerEnv });
    const prefsFile = options.prefsFile || path.join(repoRoot, 'dashboard', 'dashboard-prefs.json');
    function readPrefs() {
        try { return { auto_start: false, ...JSON.parse(fs.readFileSync(prefsFile, 'utf8')) }; } catch { return { auto_start: false }; }
    }
    const watcherAction = fn => async (req, res) => {
        try { res.json(await fn()); } catch (e) { res.status(500).json({ error: e.message, status: watcherManager.status() }); }
    };
    // Durante a troca do pin (painel Versão) o checkout/node_modules estão mudando: não sobe loop.
    const unlessUpdating = fn => (req, res) => (version.isUpdating()
        ? res.status(409).json({ error: 'Atualização de versão em andamento; aguarde o dashboard reiniciar.', status: watcherManager.status() })
        : fn(req, res));
    app.post('/api/watcher/start', unlessUpdating(watcherAction(() => watcherManager.start())));
    app.post('/api/watcher/stop', watcherAction(() => watcherManager.stop()));
    app.post('/api/watcher/restart', unlessUpdating(watcherAction(() => watcherManager.restart())));
    app.get('/api/watcher/status', (req, res) => res.json(watcherManager.status()));
    // Painel Versão (version.js): pin do Prisma vs origin/main; troca só com o loop parado.
    const watcherLock = require('../scripts/lib/watcher-lock');
    const versionPrismaRoot = path.resolve(options.versionPrismaRoot || prismaRoot);
    const version = createVersion({
        prismaRoot: versionPrismaRoot, repoRoot,
        env: { ...consumerEnv, PRISMA_ROOT: versionPrismaRoot }, redact: redactDeep,
        watcherStatus: () => watcherManager.status(),
        lockStatus: options.versionLockStatus || (() => watcherLock.status(repoRoot)),
        requestExit: options.requestExit || null,
        ...(options.versionExec ? { exec: options.versionExec } : {}),
        ...(options.versionSpawn ? { spawnDetached: options.versionSpawn } : {}),
    });
    app.get('/api/version', async (req, res) => {
        try { res.json(await version.read({ force: req.query.refresh === '1' })); }
        catch { res.status(500).json({ error: 'não foi possível ler a versão' }); }
    });
    app.post('/api/version/update', async (req, res) => {
        try { const r = await version.update(req.body?.target); res.status(r.status).json(r.body); }
        catch { res.status(500).json({ error: 'falha inesperada na atualização' }); }
    });
    // Modo do watcher (banner "DRY-RUN MODE"): memory/runs/.watcher-mode, gravado pelo
    // watcher no início de cada tick (scripts/lib/dry-run.js) — o tick live regrava com
    // mode="live", então o banner some sozinho. DRY_RUN=true no env do dashboard também
    // conta: os watchers que ele sobe herdam o env e vão rodar em dry-run.
    app.get('/api/watcher/mode', (req, res) => {
        const file = readJson(path.join(memoryDir, '.watcher-mode'));
        const fromEnv = consumerEnv.DRY_RUN === 'true';
        const dryRun = fromEnv || file?.mode === 'dry-run';
        res.json({
            mode: dryRun ? 'dry-run' : (file?.mode === 'live' ? 'live' : 'unknown'),
            dry_run: dryRun,
            source: fromEnv ? 'env' : (file ? 'file' : null),
            updated_at: file?.updated_at || null,
            fixture: dryRun ? file?.fixture || null : null,
            tickets: dryRun && Array.isArray(file?.tickets) ? file.tickets : [],
        });
    });
    // Saúde do PROCESSO watcher (não de um run): roda `readmine-watcher.js --health-check`
    // (só leitura) e devolve o JSON dele. Exit 1 = estado inconsistente — continua 200,
    // com healthy=false/issues, pra barra de status mostrar o problema em vez de erro.
    // Laço do dashboard parado e nenhum watcher vivo: sem próxima poll nem uptime.
    const runHealthCheck = options.healthCheck || (() => new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'readmine-watcher.js'), '--health-check'],
            { cwd: repoRoot, env: consumerEnv, timeout: 15000, maxBuffer: 1024 * 1024 },
            (err, stdout) => {
                try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); }
                catch { reject(err || new Error('health-check sem JSON na saída')); }
            });
    }));
    app.get('/api/watcher/health', async (req, res) => {
        try {
            const h = await runHealthCheck();
            const mgr = watcherManager.status();
            // O health-check só vê o tick/agente, não o laço: agente destacado vivo com
            // o laço parado sai "running/healthy" — mas ninguém vai despachar o próximo nó.
            if (mgr.state === 'stopped' && !h.watcherPid) {
                Object.assign(h, { status: 'stopped', nextPollAt: null, uptimeSeconds: 0 });
                if (h.activeCycle) {
                    const c = h.activeCycle;
                    h.healthy = false;
                    h.issues = [...(h.issues || []), `laço do watcher parado com ${c.taskId || '?'} (${c.node || '?'}) em execução — o próximo nó não será despachado; use Start`];
                }
            }
            res.json(redactDeep({ ...h, manager: { state: mgr.state, running: !!mgr.running } }));
        } catch (e) {
            res.status(500).json({ error: `health-check falhou: ${e.message}` });
        }
    });
    // Saúde da CONFIGURAÇÃO (.claude/, .graph/, .env.example contra
    // .claude/config-contract.json): roda `scripts/validate-config.js --format json`
    // (só leitura — o --fix nunca é chamado daqui) e devolve o relatório. Exit 1 =
    // há erros — continua 200 com exitCode=1, pro header mostrar o alerta em vez de erro.
    const runValidateConfig = options.validateConfig || (() => new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'validate-config.js'), '--format', 'json'],
            { cwd: repoRoot, env: consumerEnv, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout) => {
                let report;
                try { report = JSON.parse(String(stdout)); } catch { return reject(err || new Error('validate-config sem JSON na saída')); }
                if (report.error) return reject(new Error(report.error));
                resolve({ ...report, exitCode: err ? (err.code ?? 1) : 0 });
            });
    }));
    app.get('/api/validate-config', async (req, res) => {
        try {
            res.json(redactDeep(await runValidateConfig()));
        } catch (e) {
            res.status(500).json({ error: `validate-config falhou: ${e.message}` });
        }
    });
    app.get('/api/watcher/prefs', (req, res) => res.json(readPrefs()));

    // Tela "Este computador" (onboarding.js): ferramentas, configuração mínima e teste só leitura.
    // Chave salva para o repo em uso passa a valer neste processo e entra na lista do redact.
    const onboarding = createOnboarding({
        repoRoot, prismaRoot, env: consumerEnv, redact: redactDeep,
        envFile: options.onboardingEnvFile || path.join(__dirname, '.env'),
        repoPathLocked: !!options.repoPathLocked,
        listAccounts: () => listAccounts(),
        probeUsage: args => probeUsage(args),
        validateConfig: () => runValidateConfig(),
        onSaved: updates => {
            for (const [k, v] of Object.entries(updates)) {
                consumerEnv[k] = v;
                if (SECRET_KEY_RE.test(k) && v.length >= 6) secretValues.push(v);
            }
        },
        ...(options.onboardingExec ? { exec: options.onboardingExec } : {}),
        ...(options.onboardingFetch ? { fetchFn: options.onboardingFetch } : {}),
    });
    onboarding.mount(app);

    // Notificação via webhook (scripts/notify.js): o painel mostra se está configurada e
    // dispara um payload dummy pra conferir o webhook sem rodar ciclo. Nunca devolve a
    // URL (o token do Slack/Discord mora no caminho) — só o host.
    const sendNotification = options.sendNotification || (payload => notify.sendNotification(payload, { webhookUrl: notify.webhookUrlFromEnv(consumerEnv) }));
    const notifyHost = () => {
        const u = notify.webhookUrlFromEnv(consumerEnv);
        if (!u) return null;
        try { return new URL(u).host || null; } catch { return null; }
    };
    app.get('/api/notify/status', (req, res) => {
        res.json({ configured: !!notify.webhookUrlFromEnv(consumerEnv), host: notifyHost() });
    });
    app.post('/api/notify/test', async (req, res) => {
        if (!notify.webhookUrlFromEnv(consumerEnv)) {
            return res.json({ configured: false, sent: false, status: null, error: 'NOTIFY_WEBHOOK_URL não configurada no .env' });
        }
        const r = await sendNotification(notify.slackPayload({
            title: '🔔 Teste de notificação — Graph Engineering',
            message: 'Disparado pelo botão "Testar Notificação" do dashboard. Se chegou aqui, o webhook está funcionando.',
            color: 'good',
        }));
        res.json({ configured: true, host: notifyHost(), sent: !!r?.sent, status: r?.status ?? null, error: r?.error || null });
    });

    // Backfill de horas Redmine M&O (scripts/backfill-redmine-hours.js / lib/redmine-hours-sync.js).
    // Dry-run por padrão; apply exige confirmApply. Progresso via GET status (polling).
    const hoursBackfill = options.hoursBackfillJob || createHoursBackfillJob({
        runsDir: memoryDir,
        env: consumerEnv,
        persistPath: path.join(memoryDir, '.redmine-hours-backfill-last.json'),
        runBackfillFn: options.runHoursBackfill,
        redmineFetch: options.hoursBackfillFetch,
    });
    hoursBackfill.mount(app);
    app.put('/api/watcher/prefs', (req, res) => {
        const body = req.body || {};
        const patch = {};
        if ('auto_start' in body) {
            if (typeof body.auto_start !== 'boolean') return res.status(400).json({ error: 'auto_start deve ser boolean' });
            patch.auto_start = body.auto_start;
        }
        if ('claude_config_dir' in body) {
            // Só conta que existe na máquina — nunca um caminho arbitrário vindo do cliente.
            if (!listAccounts().some(a => a.id === body.claude_config_dir)) return res.status(400).json({ error: 'conta do Claude desconhecida' });
            patch.claude_config_dir = body.claude_config_dir;
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'nada para salvar (auto_start ou claude_config_dir)' });
        const prefs = { ...readPrefs(), ...patch };
        try { fs.mkdirSync(path.dirname(prefsFile), { recursive: true }); fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2)); } catch (e) { return res.status(500).json({ error: e.message }); }
        res.json(prefs);
    });

    // Conta do Claude que os agentes usam (scripts/lib/claude-account.js lê o
    // claude_config_dir deste prefs a cada spawn — troca vale no próximo nó, sem
    // restart) e o uso/limite dela. A sondagem de uso gasta um pouco da cota, então só
    // roda com ?refresh=1 (ou sem nada em cache); o resto do tempo devolve o cache.
    const listAccounts = options.listClaudeAccounts || (() => claudeAccount.listClaudeAccounts());
    const probeUsage = options.probeClaudeUsage || claudeUsage.probeUsage;
    function currentAccount() {
        const accounts = listAccounts();
        const { dir, source } = claudeAccount.resolveClaudeAccount(consumerEnv, { prefsFile });
        const acc = dir ? accounts.find(a => a.dir === dir || claudeAccount.expandHome(a.id) === dir) : accounts.find(a => a.id === claudeAccount.DEFAULT_ACCOUNT);
        return { accounts, dir, source, id: acc?.id || null, label: acc?.label || (dir ? path.basename(dir) : 'padrão') };
    }
    app.get('/api/claude/accounts', (req, res) => {
        const cur = currentAccount();
        res.json({ accounts: cur.accounts.map(({ id, label }) => ({ id, label })), selected: cur.id, source: cur.source, label: cur.label });
    });
    const usageCache = new Map();   // dir ('' = padrão) → último resultado
    const usageInFlight = new Map();
    app.get('/api/claude/usage', async (req, res) => {
        const cur = currentAccount();
        const key = cur.dir || '';
        const account = { id: cur.id, label: cur.label, source: cur.source };
        const cached = usageCache.get(key);
        if (cached && req.query.refresh !== '1') return res.json({ ...cached, account, cached: true });
        if (!usageInFlight.has(key)) {
            usageInFlight.set(key, probeUsage({ configDir: cur.dir }).then(r => {
                if (r.ok || !usageCache.has(key)) usageCache.set(key, r);
                return r;
            }).finally(() => usageInFlight.delete(key)));
        }
        const r = await usageInFlight.get(key);
        res.json({ ...r, account, cached: false });
    });

    // SSE: buffer inteiro na conexão, depois uma mensagem por linha nova. O cliente
    // (EventSource) reconecta sozinho; como o buffer vem de novo, cada linha leva seq
    // pra ele descartar o que já tem.
    const sseClients = new Set();
    app.get('/api/watcher/log-stream', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();
        const send = entry => res.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`);
        res.write('retry: 3000\n\n');
        // seq recomeça quando o dashboard reinicia: instance avisa o cliente pra zerar.
        res.write(`event: hello\ndata: ${JSON.stringify({ instance: `${process.pid}-${startedAt}` })}\n\n`);
        for (const entry of watcherManager.getLogBuffer()) send(entry);
        const off = watcherManager.onLine(send);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        const client = { res, cleanup: () => { clearInterval(ping); off(); sseClients.delete(client); } };
        sseClients.add(client);
        req.on('close', client.cleanup);
    });

    // ---------------------------------------------------------------------------
    // Preview de ambiente (scripts/preview-manager.js). Atrás do filtro de localhost:
    // builda e sobe processo. Criado no primeiro uso: o main carrega o .env (portas,
    // PREVIEW_JAVA_HOME) depois de createDashboard().
    let previewManager = options.previewManager || null;
    const preview = () => {
        if (!previewManager) {
            previewManager = createPreviewManager({ repoRoot, worktreesDir, env: consumerEnv, ...options.previewOptions });
            // Sem isto, derrubar o dashboard deixava java/grunt do preview órfãos.
            process.once('exit', () => previewManager.killSync());
        }
        return previewManager;
    };
    const previewAction = (status, fn) => async (req, res) => {
        try { res.status(status).json(await fn(req.params.ticketId, req)); } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    };
    app.post('/api/preview/:ticketId/start', previewAction(202, (id, req) => preview().start(id, { db: req.body?.db })));
    app.post('/api/preview/:ticketId/stop', previewAction(200, id => preview().stop(id)));
    app.post('/api/preview/:ticketId/clean', previewAction(200, id => preview().clean(id)));
    app.get('/api/preview/:ticketId/status', previewAction(200, id => preview().status(id)));

    // "Usar na minha máquina" (scripts/local-checkout.js): checkouts principais no commit
    // do worktree do ticket (detached) e volta pra ref anterior. Atrás do filtro de localhost.
    const localCheckout = options.localCheckout || createLocalCheckout({ repoRoot, worktreesDir, env: consumerEnv, ...options.localCheckoutOptions });
    const localAction = (status, fn) => async (req, res) => {
        try { res.status(status).json(await fn(req)); } catch (e) {
            res.status(e.status || 500).json({ error: e.message, repo: e.repo, rollbackErrors: e.rollbackErrors });
        }
    };
    app.get('/api/local-checkout', localAction(200, req => localCheckout.status(req.query.ticket)));
    app.post('/api/local-checkout/restore', localAction(200, () => localCheckout.restore()));
    app.post('/api/local-checkout/:ticketId/use', localAction(200, req => localCheckout.use(req.params.ticketId)));
    // SSE: buffer do ticket + fase atual na conexão, depois `log` a cada linha e
    // `phase` a cada mudança de fase. Mesmo esquema de seq/hello do log do watcher.
    app.get('/api/preview/:ticketId/log-stream', (req, res) => {
        const id = req.params.ticketId;
        let initial;
        try { initial = { buffer: preview().getLogBuffer(id), status: preview().status(id) }; } catch (e) {
            return res.status(e.status || 500).json({ error: e.message });
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();
        const sendLog = entry => res.write(`id: ${entry.seq}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`);
        const sendPhase = st => res.write(`event: phase\ndata: ${JSON.stringify(st)}\n\n`);
        res.write('retry: 3000\n\n');
        res.write(`event: hello\ndata: ${JSON.stringify({ instance: `${process.pid}-${startedAt}` })}\n\n`);
        for (const entry of initial.buffer) sendLog(entry);
        sendPhase(initial.status);
        const offLog = preview().on('log', (ticketId, entry) => { if (ticketId === id) sendLog(entry); });
        const offPhase = preview().on('phase', (ticketId, st) => { if (ticketId === id) sendPhase(st); });
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        const client = { res, cleanup: () => { clearInterval(ping); offLog(); offPhase(); sseClients.delete(client); } };
        sseClients.add(client);
        req.on('close', client.cleanup);
    });

    // SSE do log do agente em tempo real (memory/runs/<ticketId>.log, ver
    // ticketLogPath). Diferente dos dois SSE acima (watcher/preview, buffer em
    // memória porque o dashboard controla esses processos direto): o processo
    // `claude` é filho do watcher, dois níveis abaixo do dashboard, e roda
    // desacoplado mesmo (modo detached é o padrão) — por isso a fonte aqui é o
    // arquivo em disco (tail por polling), não um buffer/EventEmitter em memória.
    // Fecha quando o run deixa de estar "running" ou depois de agentLogStreamTimeoutMs
    // (30min em produção), o que vier primeiro (nunca fica aberto pra sempre).
    app.get('/api/runs/:taskId/agent-log/stream', (req, res) => {
        const run = withRun(req, res);
        if (!run) return;
        const logPath = ticketLogPath(ticketIdOf(run.taskId, readRunState(run)));

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();
        let seq = 0;
        const sendLine = line => res.write(`id: ${++seq}\nevent: log\ndata: ${JSON.stringify(redact(line))}\n\n`);
        res.write('retry: 3000\n\n');
        res.write(`event: hello\ndata: ${JSON.stringify({ instance: `${process.pid}-${startedAt}` })}\n\n`);

        if (!logPath) {
            sendLine('(task sem ticket Redmine — nenhum agente foi despachado pelo watcher para ela; sem log.)');
            res.end();
            return;
        }

        let offset = 0;
        try {
            const initial = fs.readFileSync(logPath, 'utf8');
            offset = Buffer.byteLength(initial, 'utf8');
            for (const line of initial.split('\n')) if (line) sendLine(line);
        } catch { /* arquivo ainda não existe — tail abaixo pega quando for criado */ }

        let pending = '';
        function pump() {
            let stat;
            try { stat = fs.statSync(logPath); } catch { return; }
            if (stat.size === offset) return;
            if (stat.size < offset) { offset = 0; pending = ''; } // arquivo truncado/recriado: reinicia a leitura
            const fd = fs.openSync(logPath, 'r');
            const buf = Buffer.alloc(stat.size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            offset = stat.size;
            pending += buf.toString('utf8');
            const parts = pending.split('\n');
            pending = parts.pop();
            for (const line of parts) sendLine(line);
        }

        let closed = false;
        const close = () => { if (closed) return; closed = true; cleanup(); res.end(); };
        const tailInterval = setInterval(pump, agentLogPollMs);
        const statusInterval = setInterval(() => { if (runStatus(readRunState(run)) !== 'running') close(); }, agentLogStatusPollMs);
        const hardTimeout = setTimeout(close, agentLogStreamTimeoutMs);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        function cleanup() { clearInterval(tailInterval); clearInterval(statusInterval); clearTimeout(hardTimeout); clearInterval(ping); }
        req.on('close', () => { closed = true; cleanup(); });
    });

    app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

    // ---------------------------------------------------------------------------
    // WebSocket: push de mudanças, sem polling no cliente.
    function broadcast(data) {
        const msg = JSON.stringify(data);
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
    }

    wss.on('connection', ws => ws.send(JSON.stringify({ type: 'hello', runs: listRuns() })));

    const watcher = chokidar.watch([], {
        ignoreInitial: true,
        depth: 1,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
        ignored: (p, stats) => stats?.isFile() && !WATCHED_FILES.has(path.basename(p)) && !SPEC_GATE_FILE_RE.test(path.basename(p)),
    });
    const watchedRoots = new Set();
    // Root novo (worktree criada depois do start) é lido do disco aqui, e o chokidar
    // não emite nada pro que já existia dentro dele (ignoreInitial) — sem o broadcast,
    // um run criado antes do próximo tick deste timer ficava fora da tela aberta até
    // recarregar. Caso real: #43584, worktree recriada pelo watcher e run criado pelo
    // /fetch-ticket segundos depois.
    // Root que ainda não existe (checkout novo sem memory/runs) não entra: o chokidar não
    // passa a observá-lo quando é criado e o cache vazio nunca seria relido. Entra no
    // primeiro sync depois de criado (request ou rootsTimer), como as worktrees.
    let rootsReady = false;
    function syncWatchedRoots() {
        let added = false;
        for (const root of runRoots()) {
            if (watchedRoots.has(root.dir) || !fs.existsSync(root.dir)) continue;
            watchedRoots.add(root.dir);
            cacheRoot(root);
            watcher.add(root.dir);
            added = added || runsCache.get(root.dir)?.names.size > 0;
        }
        if (added && rootsReady) broadcast({ type: 'runs_changed' });
    }
    syncWatchedRoots();
    rootsReady = true;
    scanArchivedOpen().catch(() => {});
    const archivedTimer = setInterval(() => scanArchivedOpen().catch(() => {}), ISSUE_TTL_OPEN_MS);
    // Worktrees novas (ticket novo despachado pelo watcher) entram sem reiniciar.
    const rootsTimer = setInterval(syncWatchedRoots, 10000);

    function onFileEvent(event, filePath) {
        const file = path.basename(filePath);
        // Gate file do checkout principal: pendência pré-task entrou/saiu/mudou.
        if (SPEC_GATE_FILE_RE.test(file)) {
            if (path.resolve(path.dirname(filePath)) === path.resolve(memoryDir)) broadcast({ type: 'runs_changed' });
            return;
        }
        if (!WATCHED_FILES.has(file)) return;
        if (event !== 'unlink') lastFileChange = new Date().toISOString();
        const taskId = path.basename(path.dirname(filePath));
        const run = resolveRun(taskId);
        // Evento numa cópia velha de outro worktree não é o run que o dashboard mostra.
        if (!run || path.resolve(run.dir) !== path.resolve(path.dirname(filePath))) return;
        if (archivedAway(taskId, candidatesOf(taskId))) return;
        const summary = summarize(run);
        if (file === 'state.json') {
            if (event === 'unlink') broadcast({ type: 'runs_changed' });
            else if (summary.state) broadcast({ type: 'state_update', taskId, state: summary.state, run: summary });
        } else if (file === 'context.md') {
            broadcast({ type: 'context_update', taskId });
        } else if (file === OPENAPI_CONTRACT_FILE) {
            // Summary novo (hasOpenApiContract) liga/desliga o botão do detalhe.
            if (summary.state) broadcast({ type: 'state_update', taskId, state: summary.state, run: summary });
        } else {
            broadcast({ type: 'human_input', taskId, pending: summary.pendingHumanInput });
        }
    }
    watcher.on('add', p => onFileEvent('add', p));
    watcher.on('change', p => onFileEvent('change', p));
    watcher.on('unlink', p => onFileEvent('unlink', p));
    // Só diretório de run direto num root conta (screenshots/ e outros subdirs de um
    // run não, nem _archive).
    watcher.on('addDir', p => {
        const cached = runsCache.get(path.dirname(p));
        const name = path.basename(p);
        if (!cached || !isRunDirName(name)) return;
        cached.names.add(name);
        broadcast({ type: 'runs_changed' });
    });
    watcher.on('unlinkDir', p => {
        if (runsCache.has(p)) { // o próprio root sumiu (worktree removida)
            runsCache.delete(p); watchedRoots.delete(p); watcher.unwatch(p);
            broadcast({ type: 'runs_changed' });
            return;
        }
        const cached = runsCache.get(path.dirname(p));
        if (cached?.names.delete(path.basename(p))) broadcast({ type: 'runs_changed' });
    });

    return {
        app, server, wss, watcher, memoryDir, worktreesDir, watcherManager, readPrefs,
        get previewManager() { return previewManager; },
        coordinationStatusPath: coordination.statusPath,
        // Sem root nenhum no disco o chokidar não tem o que observar e nunca emite 'ready'.
        ready: Promise.all([watchedRoots.size ? new Promise(resolve => watcher.on('ready', resolve)) : null, coordination.ready]),
        close: async () => {
            await watcherManager.stop?.();
            for (const c of [...sseClients]) { c.cleanup(); c.res.end(); }
            await previewManager?.stopAll().catch(() => {});
            clearInterval(rootsTimer);
            clearInterval(archivedTimer);
            await watcher.close();
            await coordination.close();
            wss.clients.forEach(c => c.terminate());
            wss.close();
            await new Promise(resolve => server.close(resolve));
        },
    };
}

if (require.main === module) {
    // REPO_PATH do ambiente (launcher do consumidor) trava a pasta; sem ele, vale a gravada
    // pela tela "Este computador" no dashboard/.env do Prisma.
    const repoPathLocked = !!process.env.REPO_PATH;
    loadDotEnv(path.join(__dirname, '.env'), ['REPO_PATH']);
    const consumerRoot = path.resolve(process.env.REPO_PATH || process.cwd());
    loadDotEnv(path.join(consumerRoot, 'dashboard', '.env'));
    // Fallback: mesmas credenciais que o watcher já lê do .env do repo (uma fonte só,
    // sem cópia pra ficar stale). Só as chaves das integrações (+ preview e a palavra de
    // aprovação da spec) — nada mais desse arquivo.
    const repoKeys = [...INTEGRATION_KEYS, ...PREVIEW_KEYS, ...APPROVAL_KEYS, ...PRE_BUILD_KEYS, ...NOTIFY_KEYS,
        'WATCHER_SIBLING_REPOS', 'WATCHER_MAIN_REPO_NAME', 'BITBUCKET_PR_REPOS', 'BITBUCKET_ACCOUNT_ID', 'REDMINE_USER_ID'];
    loadDotEnv(path.join(consumerRoot, '.env'), key => repoKeys.includes(key) || AUTHORIZATION_KEYS(key));
    // Default do operador só neste processo. Testes que criam o servidor sem
    // COORD_STATUS_PATH ficam num arquivo temporário (coordination.js).
    applyCoordinationDefault(process.env);
    const PORT = Number(process.env.PORT) || 3333;
    const HOST = process.env.HOST || '127.0.0.1';
    // Reinício pedido pelo painel Versão: mesmo caminho do SIGTERM (para o watcher e sai).
    // Se parar watcher/previews travar, sai assim mesmo: o processo novo espera este PID.
    const dashboard = createDashboard({ repoPathLocked, requestExit: () => {
        setTimeout(() => process.exit(0), 15000).unref();
        process.kill(process.pid, 'SIGTERM');
    } });
    if (!fs.existsSync(dashboard.memoryDir)) {
        console.warn(`[dashboard] MEMORY_DIR não existe: ${dashboard.memoryDir}`);
    }
    dashboard.server.listen(PORT, HOST, () => {
        console.log(`[dashboard] http://localhost:${PORT}`);
        console.log(`[dashboard] runs: ${dashboard.memoryDir} + ${dashboard.worktreesDir}/*/memory/runs`);
        const redmine = process.env.REDMINE_URL && process.env.REDMINE_API_KEY ? 'configurado' : 'não configurado';
        const bitbucket = process.env.BITBUCKET_API_TOKEN ? 'configurado' : 'não configurado';
        console.log(`[dashboard] Redmine: ${redmine} · Bitbucket: ${bitbucket}`);
        // Opt-in explícito no painel (dashboard-prefs.json). Sem isso, nunca sobe sozinho.
        if (dashboard.readPrefs().auto_start) {
            console.log('[dashboard] auto-start do watcher ligado — iniciando');
            dashboard.watcherManager.start({ reason: 'auto-start' }).catch(e => console.error('[dashboard] auto-start falhou:', e.message));
        }
    });
    // Ctrl+C/kill no dashboard: para o watcher (SIGTERM, 5s, SIGKILL) antes de sair,
    // em vez de deixar o tick órfão.
    let shuttingDown = false;
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, async () => {
            if (shuttingDown) process.exit(1);
            shuttingDown = true;
            await Promise.all([
                dashboard.watcherManager.stop({ reason: 'dashboard encerrado' }).catch(() => {}),
                dashboard.previewManager?.stopAll().catch(() => {}),
            ]);
            process.exit(0);
        });
    }
}

module.exports = { preBuildOf, specDecisionsOf, createDashboard, NODES, extractPrs, extractPrIdFromUrl, deriveRunKind };
