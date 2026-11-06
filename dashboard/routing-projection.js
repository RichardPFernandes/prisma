'use strict';
// Read model das telas de roteamento de modelo (SPEC das telas de roteamento; PRI-205).
//
// Projeção pura: recebe o que os donos já leram (readRoutingConfig, loadRunSnapshot,
// cost_tracking, DOM-06) e devolve só campos permitidos. Não lê disco, não resolve
// modelo, não calcula classe (desenho v9 §5.7: o Dashboard é projeção). Ausência de
// dado vira 'UNKNOWN' ou null com motivo, nunca 0. Nenhum caminho local sai daqui:
// policy_ref.path, plugin_proof.settings_path e attempt_ref ficam de fora por
// construção (lista de campos permitidos), e findPathLike existe para os testes.

const UNKNOWN = 'UNKNOWN';
const TIER_ORDER = ['T1', 'T2', 'T3'];
const CLASS_ORDER = ['C1', 'C2', 'C3', 'C4', 'C5'];
const MODES = new Set(['OFF', 'ON', 'INVALID']);
const OFF_SOURCES = new Set(['absent', 'declared']);
// Códigos do loader (cause e detail): só [A-Za-z0-9_:.-]. Texto livre ou mensagem
// de erro de sistema nunca passa (pode citar caminho).
const CODE_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
const PATH_LIKE = [/^\//, /^~[/\\]/, /^[A-Za-z]:[\\/]/, /\\/, /(^|\/)\.claude\//, /(^|\/)\.\.?\//];

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

function looksLikePath(s) {
    return PATH_LIKE.some(re => re.test(s));
}

/** String curta e sem cara de caminho; senão UNKNOWN. */
function text(v) {
    return typeof v === 'string' && v.length > 0 && v.length <= 200 && !looksLikePath(v) ? v : UNKNOWN;
}

function code(v) {
    return typeof v === 'string' && CODE_RE.test(v) && !looksLikePath(v) ? v : UNKNOWN;
}

function sha(v) {
    return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : UNKNOWN;
}

function tierOfModel(tiers, modelId) {
    for (const t of TIER_ORDER) {
        if (isObj(tiers?.[t]) && Array.isArray(tiers[t].models) && tiers[t].models.includes(modelId)) return t;
    }
    return UNKNOWN;
}

function projectPolicy(loaded) {
    const policy = loaded.policy;
    const ref = isObj(loaded.policy_ref) ? loaded.policy_ref : {};
    const full = sha(ref.sha256);
    const tiers = isObj(policy.tiers) ? policy.tiers : {};
    const classMap = isObj(policy.class_to_tier) ? policy.class_to_tier : {};
    const classes = CLASS_ORDER.map(c => {
        const row = isObj(classMap[c]) ? classMap[c] : {};
        const tier = TIER_ORDER.includes(row.tier) ? row.tier : UNKNOWN;
        const models = tier !== UNKNOWN && isObj(tiers[tier]) && Array.isArray(tiers[tier].models)
            ? tiers[tier].models.map(text)
            : [];
        return { class: c, tier, effort: text(row.effort), models };
    });
    const dr = isObj(policy.default_route) ? policy.default_route : {};
    const drModel = text(dr.model_id);
    const approval = isObj(policy.approval) ? { by: text(policy.approval.by), at: text(policy.approval.at) } : null;
    return {
        id: text(ref.id ?? policy.id),
        version: text(ref.version ?? policy.version),
        sha256: full,
        sha_short: full === UNKNOWN ? UNKNOWN : full.slice(0, 8),
        status: text(policy.status),
        approval,
        classifier_provider: text(policy.classifier?.provider),
        classes,
        default_route: { model_id: drModel, effort: text(dr.effort), tier: drModel === UNKNOWN ? UNKNOWN : tierOfModel(tiers, drModel) },
        effort_applied: typeof policy.effort_applied === 'boolean' ? policy.effort_applied : UNKNOWN,
    };
}

/**
 * Config de roteamento do consumidor, a partir do retorno de readRoutingConfig.
 * @param {any} loaded
 */
function projectConfig(loaded) {
    if (!isObj(loaded) || !MODES.has(loaded.status)) {
        return { mode: UNKNOWN, source: null, invalid: null, policy: null };
    }
    if (loaded.status === 'OFF') {
        return { mode: 'OFF', source: OFF_SOURCES.has(loaded.source) ? loaded.source : UNKNOWN, invalid: null, policy: null };
    }
    if (loaded.status === 'INVALID') {
        return {
            mode: 'INVALID', source: null,
            invalid: { cause: code(loaded.cause), detail: code(loaded.detail), transient: loaded.transient === true },
            policy: null,
        };
    }
    if (!isObj(loaded.policy)) return { mode: UNKNOWN, source: null, invalid: null, policy: null };
    return { mode: 'ON', source: 'declared', invalid: null, policy: projectPolicy(loaded) };
}

const ATTEMPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z?$/;

function instant(v) {
    return typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v)) ? v : UNKNOWN;
}

function shortRef(ref) {
    const full = sha(ref?.sha256);
    return { id: text(ref?.id), version: text(ref?.version), sha256: full, sha_short: full === UNKNOWN ? UNKNOWN : full.slice(0, 8) };
}

/** RoutingDecisions gravadas no cost_tracking bruto (só objetos; 'UNAVAILABLE' = sem decisão). */
function routingDecisions(costTracking) {
    const decisions = [];
    let without = 0;
    const nodes = isObj(costTracking?.nodes) ? costTracking.nodes : {};
    for (const node of Object.values(nodes)) {
        if (!isObj(node) || !Array.isArray(node.attempts)) continue;
        for (const a of node.attempts) {
            if (isObj(a?.routing_decision)) decisions.push(a.routing_decision);
            else without += 1;
        }
    }
    return { decisions, without };
}

function projectOverride(o, appliedRefs) {
    const value = isObj(o.value) ? o.value : {};
    const ref = text(o.ref);
    return {
        ref,
        scope: ['ticket', 'node', 'subtask'].includes(o.scope) ? o.scope : UNKNOWN,
        node: typeof o.node === 'string' ? text(o.node) : null,
        subtask_key: typeof o.subtask_key === 'string' ? text(o.subtask_key) : null,
        value: { model_id: text(value.model_id), effort: text(value.effort) },
        by: text(o.by),
        recorded_at: instant(o.recorded_at),
        // APPLIED: alguma RoutingDecision cita esta override. Senão ainda não aplicada
        // (pendente até o próximo limite de nó, ou superada por outra mais específica).
        status: ref !== UNKNOWN && appliedRefs.has(ref) ? 'APPLIED' : 'NOT_APPLIED',
    };
}

function policyDrift(snapshotRef, current) {
    const currentMode = isObj(current) && typeof current.mode === 'string' ? current.mode : UNKNOWN;
    const cur = currentMode === 'ON' && isObj(current.policy)
        ? { id: current.policy.id, version: current.policy.version, sha_short: current.policy.sha_short }
        : null;
    if (currentMode !== 'ON') {
        return { status: currentMode === UNKNOWN ? UNKNOWN : 'DIFFERENT', current_mode: currentMode, current: null };
    }
    if (!snapshotRef || snapshotRef.sha256 === UNKNOWN || current.policy.sha256 === UNKNOWN) {
        return { status: UNKNOWN, current_mode: currentMode, current: cur };
    }
    return { status: snapshotRef.sha256 === current.policy.sha256 ? 'SAME' : 'DIFFERENT', current_mode: currentMode, current: cur };
}

/**
 * Uma Run, do ponto de vista do roteamento. `snapshotResult` é o retorno de
 * routing-run.loadRunSnapshot (ou undefined se não foi lido); `current` é a saída de
 * projectConfig para a config vigente. A Run mostra sempre a policy do SEU snapshot;
 * a vigente só entra para avisar a diferença (sem rebind).
 * @param {{ taskId: string, ticketId?: number|null, state: any, snapshotResult?: any, current?: any }} input
 */
function projectRun({ taskId, ticketId, state, snapshotResult, current }) {
    const base = { task_id: text(taskId), ticket_id: Number.isInteger(ticketId) ? ticketId : null };
    const binding = isObj(state) ? state.routing_snapshot : null;
    if (!binding) {
        return { ...base, mode: 'OFF', snapshot: null, policy_drift: null, selection_sources: null, decisions_total: null, attempts_without_decision: null, overrides: [] };
    }
    let mode = UNKNOWN;
    let integrity = UNKNOWN;
    let policyRef = null;
    // Opções do formulário de override: só do snapshot íntegro da Run (o writer confere
    // contra o mesmo snapshot). Sem snapshot íntegro, null: a tela não oferece opção.
    let eligibleModels = null;
    let efforts = null;
    if (isObj(snapshotResult) && snapshotResult.mode === 'ON') {
        mode = 'ON';
        if (snapshotResult.ok === true && isObj(snapshotResult.snapshot)) {
            integrity = 'ok';
            const snap = snapshotResult.snapshot;
            policyRef = shortRef(snap.policy_ref);
            eligibleModels = Array.isArray(snap.eligible_set?.models) ? snap.eligible_set.models.map(text) : [];
            efforts = isObj(snap.policy?.effort_map) ? Object.keys(snap.policy.effort_map).map(text) : [];
        } else {
            integrity = code(snapshotResult.detail);
        }
    }
    const bound = sha(binding.sha256);
    const { decisions, without } = routingDecisions(state.cost_tracking);
    const selection_sources = {};
    const appliedRefs = new Set();
    for (const d of decisions) {
        const src = code(d.selection_source);
        selection_sources[src] = (selection_sources[src] || 0) + 1;
        if (isObj(d.override_ref) && typeof d.override_ref.ref === 'string') appliedRefs.add(d.override_ref.ref);
    }
    const overrides = (Array.isArray(state.routing_overrides) ? state.routing_overrides : [])
        .filter(isObj)
        .map(o => projectOverride(o, appliedRefs));
    return {
        ...base,
        mode,
        snapshot: {
            attempt_id: typeof binding.attempt_id === 'string' && ATTEMPT_ID_RE.test(binding.attempt_id) ? binding.attempt_id : UNKNOWN,
            sha256: bound,
            sha_short: bound === UNKNOWN ? UNKNOWN : bound.slice(0, 8),
            integrity,
            policy_ref: policyRef,
            eligible_models: eligibleModels,
            efforts,
        },
        policy_drift: policyDrift(policyRef, current),
        selection_sources,
        decisions_total: decisions.length,
        attempts_without_decision: without,
        overrides,
    };
}

/** Caminhos JSON ($.a.b[0]) de strings com cara de caminho local. Para testes e guarda. */
function findPathLike(value, at = '$', out = []) {
    if (typeof value === 'string') {
        if (looksLikePath(value)) out.push(at);
    } else if (Array.isArray(value)) {
        value.forEach((v, i) => findPathLike(v, `${at}[${i}]`, out));
    } else if (isObj(value)) {
        for (const [k, v] of Object.entries(value)) findPathLike(v, `${at}.${k}`, out);
    }
    return out;
}

// ── Recusas ────────────────────────────────────────────────────────────────────

/**
 * Marcador memory/runs/routing-admission-blocked.json (routing-run.blockedNotice).
 * Estado do aviso: SENT (notified_at) > FAILED > UNCERTAIN > PENDING.
 */
function projectAdmissionBlocked(marker) {
    if (!isObj(marker) || typeof marker.cause !== 'string') return null;
    let status = 'PENDING';
    let at = null;
    if (instant(marker.notified_at) !== UNKNOWN) { status = 'SENT'; at = marker.notified_at; }
    else if (instant(marker.notice_failed_at) !== UNKNOWN) { status = 'FAILED'; at = marker.notice_failed_at; }
    else if (instant(marker.notice_uncertain_at) !== UNKNOWN) { status = 'UNCERTAIN'; at = marker.notice_uncertain_at; }
    return {
        cause: code(marker.cause),
        detail: marker.detail == null ? null : code(marker.detail),
        transient: marker.transient === true,
        transient_count: Number.isInteger(marker.transient_count) && marker.transient_count >= 0 ? marker.transient_count : UNKNOWN,
        tickets: (Array.isArray(marker.tickets) ? marker.tickets : []).filter(Number.isInteger),
        first_blocked_at: instant(marker.first_blocked_at),
        notice: {
            status, at,
            attempts: Number.isInteger(marker.notice_attempts) ? marker.notice_attempts : null,
            local_notified: instant(marker.local_notified_at) !== UNKNOWN,
        },
    };
}

/** Attempts NOT_STARTED do DOM-06 (dom06-attempt.listAttempts). Só campos permitidos. */
function projectNotStarted(attempts) {
    return (Array.isArray(attempts) ? attempts : [])
        .filter(a => isObj(a) && a.result === 'NOT_STARTED')
        .map(a => {
            const ns = isObj(a.not_started) ? a.not_started : {};
            const r = isObj(a.routing) ? a.routing : null;
            return {
                attempt_id: typeof a.attempt_id === 'string' && ATTEMPT_ID_RE.test(a.attempt_id) ? a.attempt_id : UNKNOWN,
                node: text(a.node),
                cause: code(ns.cause),
                detail: ns.detail == null ? null : code(ns.detail),
                at: instant(a.created_at),
                class: r && typeof r.class === 'string' ? code(r.class) : null,
                would_model: r && isObj(r.chosen) ? text(r.chosen.model_id) : null,
            };
        });
}

// ── Modelos, mistura e sombra × real (cost_tracking bruto) ─────────────────────

function eachAttempt(costTracking, fn) {
    const nodes = isObj(costTracking?.nodes) ? costTracking.nodes : {};
    for (const [nodeKey, node] of Object.entries(nodes)) {
        if (!isObj(node) || !Array.isArray(node.attempts)) continue;
        for (const a of node.attempts) if (isObj(a)) fn(nodeKey, a);
    }
}

function attemptIdOf(a) {
    const id = a.admission?.attempt_id;
    return typeof id === 'string' && ATTEMPT_ID_RE.test(id) ? id : UNKNOWN;
}

function usd(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

const uniq = list => [...new Set(list)];

/**
 * Por Attempt: modelo pedido (RoutingDecision fixada no despacho) × modelos observados.
 * O custo é o do Attempt inteiro; o usage bruto não traz custo por modelo, então
 * nada é rateado aqui. mismatch: null = não roteado (não se aplica); 'UNKNOWN' = sem
 * uso principal observado; true/false = algum modelo principal ≠ pedido.
 */
function projectAttemptModels(costTracking) {
    const rows = [];
    eachAttempt(costTracking, (nodeKey, a) => {
        const req = isObj(a.requested) ? a.requested : {};
        const requested = text(req.model);
        const routed = isObj(a.routing_decision) && requested !== UNKNOWN && requested !== 'UNAVAILABLE';
        const usage = Array.isArray(a.observed?.usage) ? a.observed.usage.filter(isObj) : [];
        const main = uniq(usage.filter(u => u.role === 'main').map(u => text(u.model)));
        const sub = uniq(usage.filter(u => u.role !== 'main').map(u => text(u.model)));
        let mismatch = null;
        if (routed) mismatch = main.length === 0 ? UNKNOWN : main.some(m => m !== requested);
        rows.push({
            node: text(nodeKey),
            attempt_id: attemptIdOf(a),
            requested_model: requested,
            requested_effort: text(req.effort),
            routed,
            selection_source: code(a.selection_source),
            observed_main: main,
            observed_subagent: sub,
            cost_usd: usd(a.cost?.usd),
            unpriced_models: (Array.isArray(a.cost?.unpriced_models) ? a.cost.unpriced_models : []).map(text),
            mismatch,
        });
    });
    return rows;
}

const round6 = n => Math.round(n * 1e6) / 1e6;

/**
 * Mistura por modelo pedido. Attempt não roteado entra como NOT_ROUTED. Custo null
 * nunca soma como 0: conta em unpriced_attempts e o share de custo usa só os com preço.
 * @param {Array<{ requested_model: string, routed: boolean, cost_usd: number|null }>} rows
 */
function buildMix(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const groups = new Map();
    let priced = 0;
    let total = null;
    for (const r of list) {
        const key = r.routed ? r.requested_model : 'NOT_ROUTED';
        const g = groups.get(key) || { model: key, attempts: 0, priced_attempts: 0, unpriced_attempts: 0, cost_usd: null };
        g.attempts += 1;
        if (r.cost_usd == null) g.unpriced_attempts += 1;
        else {
            g.priced_attempts += 1;
            g.cost_usd = round6((g.cost_usd ?? 0) + r.cost_usd);
            priced += 1;
            total = round6((total ?? 0) + r.cost_usd);
        }
        groups.set(key, g);
    }
    const by_requested = [...groups.values()].map(g => ({
        ...g,
        share_attempts: round6(g.attempts / list.length),
        share_cost: g.cost_usd != null && total ? round6(g.cost_usd / total) : null,
    }));
    return { totals: { attempts: list.length, priced_attempts: priced, cost_usd: total }, by_requested };
}

const TIER_RANK = { T1: 1, T2: 2, T3: 3 };
const CLASS_RANK = { C1: 1, C2: 2, C3: 3, C4: 4, C5: 5 };

function maxBy(values, rank) {
    let best = null;
    for (const v of values) if (rank[v] && (!best || rank[v] > rank[best])) best = v;
    return best;
}

/**
 * Sombra S3 (would_route) × RoutingDecision real, por Attempt. A sombra do Implement
 * vira um valor pela mesma regra do despacho (classe/tier máximos dos grupos). A
 * comparação é de tier (o que muda o modelo). O efeito na qualidade é contrafactual:
 * sempre NOT_MEASURED.
 */
function projectShadowVsReal(costTracking) {
    const summary = { SAME: 0, REAL_HIGHER: 0, REAL_LOWER: 0, UNKNOWN: 0 };
    const rows = [];
    eachAttempt(costTracking, (nodeKey, a) => {
        const wr = isObj(a.would_route) ? a.would_route : null;
        const d = isObj(a.routing_decision) ? a.routing_decision : null;
        if (!wr && !d) return;
        let shadowOut = 'UNAVAILABLE';
        if (wr) {
            const decisions = Array.isArray(wr.decisions) ? wr.decisions.filter(isObj) : [];
            shadowOut = {
                status: code(wr.status),
                policy_version: wr.policy_version == null ? null : text(String(wr.policy_version)),
                class: maxBy(decisions.map(x => x.class), CLASS_RANK),
                tier: maxBy(decisions.map(x => x.tier), TIER_RANK),
                subtasks: decisions.length,
            };
        }
        const realOut = d ? {
            class: typeof d.class === 'string' ? code(d.class) : null,
            tier: isObj(d.chosen) && TIER_RANK[d.chosen.tier] ? d.chosen.tier : null,
            model_id: isObj(d.chosen) ? text(d.chosen.model_id) : null,
        } : 'UNAVAILABLE';
        let comparison = UNKNOWN;
        const st = isObj(shadowOut) ? shadowOut.tier : null;
        const rt = isObj(realOut) ? realOut.tier : null;
        if (st && rt) {
            comparison = TIER_RANK[rt] === TIER_RANK[st] ? 'SAME' : TIER_RANK[rt] > TIER_RANK[st] ? 'REAL_HIGHER' : 'REAL_LOWER';
        }
        summary[comparison] += 1;
        rows.push({ node: text(nodeKey), attempt_id: attemptIdOf(a), shadow: shadowOut, real: realOut, comparison, quality_effect: 'NOT_MEASURED' });
    });
    return { summary, rows };
}

module.exports = {
    projectConfig, projectRun, projectAdmissionBlocked, projectNotStarted,
    projectAttemptModels, buildMix, projectShadowVsReal, findPathLike, UNKNOWN,
};
