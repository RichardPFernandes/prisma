'use strict';
// Projeção de leitura do roteamento de modelo (SPEC das telas de roteamento, T1).
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectConfig, findPathLike } = require('./routing-projection');

const SHA = '02923a43' + 'a'.repeat(56);

// Policy no formato da aprovada routing-pri205@p1-2026-11-06 (sintética).
function approvedPolicy(overrides = {}) {
    return {
        id: 'routing-pri205',
        version: 'p1-2026-11-06',
        mode: 'ROUTED',
        status: 'APROVADA',
        approval: { by: 'Richard Fernandes', at: '2026-11-06', via: 'sessão local /Users/x/tmp', from_proposal_sha256: 'f'.repeat(64) },
        classifier: { provider: 'cheap_rule' },
        class_to_tier: {
            C1: { tier: 'T1', effort: 'baixo' },
            C2: { tier: 'T2', effort: 'médio' },
            C3: { tier: 'T3', effort: 'alto' },
            C4: { tier: 'T3', effort: 'alto' },
            C5: { tier: 'T3', effort: 'máximo' },
        },
        tiers: {
            T1: { models: ['claude-sonnet-5-5'] },
            T2: { models: ['claude-sonnet-5-5'] },
            T3: { models: ['claude-opus-5-5'] },
        },
        default_route: { model_id: 'claude-opus-5-5', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
        effort_applied: false,
        design_ref: { source: 'prisma-evidence/pri-205/desenho.md' },
        note: 'texto livre',
        ...overrides,
    };
}

function onResult(policy = approvedPolicy()) {
    return {
        status: 'ON',
        policy,
        policy_ref: { id: policy.id, version: policy.version, sha256: SHA, path: '.claude/routing/policy.json' },
        policy_hash: SHA,
    };
}

test('mode ausente: OFF absent, sem policy e sem números', () => {
    const out = projectConfig({ status: 'OFF', source: 'absent' });
    assert.deepEqual(out, { mode: 'OFF', source: 'absent', invalid: null, policy: null });
});

test('mode OFF declarado', () => {
    const out = projectConfig({ status: 'OFF', source: 'declared' });
    assert.equal(out.mode, 'OFF');
    assert.equal(out.source, 'declared');
    assert.equal(out.policy, null);
});

test('INVALID projeta cause, detail e transient', () => {
    const out = projectConfig({ status: 'INVALID', cause: 'POLICY_HASH_MISMATCH', detail: `expected:${SHA}`, transient: false });
    assert.equal(out.mode, 'INVALID');
    assert.deepEqual(out.invalid, { cause: 'POLICY_HASH_MISMATCH', detail: `expected:${SHA}`, transient: false });
    assert.equal(out.policy, null);
});

test('INVALID com detail fora do formato de código vira UNKNOWN (nunca texto livre)', () => {
    const out = projectConfig({ status: 'INVALID', cause: 'ROUTING_CONFIG_UNREADABLE', detail: 'EACCES: /Users/x/.claude/model-routing.json', transient: true });
    assert.equal(out.invalid.detail, 'UNKNOWN');
    assert.equal(out.invalid.transient, true);
});

test('entrada ilegível ou desconhecida: mode UNKNOWN, nunca OFF', () => {
    for (const raw of [null, undefined, 42, {}, { status: 'LIGADO' }]) {
        const out = projectConfig(raw);
        assert.equal(out.mode, 'UNKNOWN', JSON.stringify(raw));
        assert.equal(out.policy, null);
    }
});

test('policy aprovada p1: C1/C2 Sonnet, C3–C5 e default_route Opus, esforço não aplicado', () => {
    const out = projectConfig(onResult());
    assert.equal(out.mode, 'ON');
    assert.equal(out.invalid, null);
    const p = out.policy;
    assert.equal(p.id, 'routing-pri205');
    assert.equal(p.version, 'p1-2026-11-06');
    assert.equal(p.sha256, SHA);
    assert.equal(p.sha_short, '02923a43');
    assert.equal(p.status, 'APROVADA');
    assert.deepEqual(p.approval, { by: 'Richard Fernandes', at: '2026-11-06' });
    assert.equal(p.classifier_provider, 'cheap_rule');
    assert.deepEqual(p.classes, [
        { class: 'C1', tier: 'T1', effort: 'baixo', models: ['claude-sonnet-5-5'] },
        { class: 'C2', tier: 'T2', effort: 'médio', models: ['claude-sonnet-5-5'] },
        { class: 'C3', tier: 'T3', effort: 'alto', models: ['claude-opus-5-5'] },
        { class: 'C4', tier: 'T3', effort: 'alto', models: ['claude-opus-5-5'] },
        { class: 'C5', tier: 'T3', effort: 'máximo', models: ['claude-opus-5-5'] },
    ]);
    assert.deepEqual(p.default_route, { model_id: 'claude-opus-5-5', effort: 'alto', tier: 'T3' });
    assert.equal(p.effort_applied, false);
});

test('ON: nunca projeta path, via, design_ref nem nota livre', () => {
    const out = projectConfig(onResult());
    const text = JSON.stringify(out);
    assert.ok(!text.includes('policy.json'));
    assert.ok(!text.includes('/Users/'));
    assert.ok(!text.includes('design_ref'));
    assert.ok(!text.includes('texto livre'));
    assert.deepEqual(findPathLike(out), []);
});

test('campos ausentes na policy viram UNKNOWN, nunca 0 nem vazio', () => {
    const policy = approvedPolicy({ status: undefined, approval: undefined, effort_applied: undefined, classifier: undefined });
    const out = projectConfig(onResult(policy));
    assert.equal(out.policy.status, 'UNKNOWN');
    assert.equal(out.policy.approval, null);
    assert.equal(out.policy.effort_applied, 'UNKNOWN');
    assert.equal(out.policy.classifier_provider, 'UNKNOWN');
});

test('tier de classe sem modelos declarados: models vazio explícito e tier preservado', () => {
    const policy = approvedPolicy({ tiers: { T1: { models: [] }, T2: { models: ['claude-sonnet-5-5'] }, T3: { models: ['claude-opus-5-5'] } } });
    const out = projectConfig(onResult(policy));
    assert.deepEqual(out.policy.classes[0], { class: 'C1', tier: 'T1', effort: 'baixo', models: [] });
});

test('default_route com modelo fora dos tiers: tier UNKNOWN', () => {
    const policy = approvedPolicy({ default_route: { model_id: 'claude-fable-5-1', effort: 'alto' } });
    const out = projectConfig(onResult(policy));
    assert.deepEqual(out.policy.default_route, { model_id: 'claude-fable-5-1', effort: 'alto', tier: 'UNKNOWN' });
});

test('string com cara de caminho dentro da policy vira UNKNOWN', () => {
    const policy = approvedPolicy({ tiers: { T1: { models: ['/Users/x/model'] }, T2: { models: ['claude-sonnet-5-5'] }, T3: { models: ['claude-opus-5-5'] } } });
    const out = projectConfig(onResult(policy));
    assert.deepEqual(out.policy.classes[0].models, ['UNKNOWN']);
    assert.deepEqual(findPathLike(out), []);
});

test('contrato com o dono: saída real do readRoutingConfig (consumidor sintético) projeta sem path', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { readRoutingConfig, sha256Bytes } = require('../scripts/lib/model-routing-policy');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-proj-'));
    try {
        fs.mkdirSync(path.join(root, '.claude', 'routing'), { recursive: true });
        const bytes = Buffer.from(JSON.stringify(approvedPolicy()));
        fs.writeFileSync(path.join(root, '.claude', 'routing', 'policy.json'), bytes);
        const ref = { id: 'routing-pri205', version: 'p1-2026-11-06', sha256: sha256Bytes(bytes), path: '.claude/routing/policy.json' };
        fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'), JSON.stringify({ mode: 'ON', policy_ref: ref }));
        const loaded = readRoutingConfig(root);
        assert.equal(loaded.status, 'ON', JSON.stringify(loaded));
        const out = projectConfig(loaded);
        assert.equal(out.mode, 'ON');
        assert.equal(out.policy.sha256, ref.sha256);
        assert.deepEqual(findPathLike(out), []);
        assert.ok(!JSON.stringify(out).includes(root));

        fs.writeFileSync(path.join(root, '.claude', 'model-routing.json'), JSON.stringify({ mode: 'ON', policy_ref: { ...ref, sha256: 'b'.repeat(64) } }));
        const bad = projectConfig(readRoutingConfig(root));
        assert.equal(bad.mode, 'INVALID');
        assert.equal(bad.invalid.cause, 'POLICY_HASH_MISMATCH');
        assert.deepEqual(findPathLike(bad), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('findPathLike encontra caminhos POSIX, Windows, home e .claude/', () => {
    const found = findPathLike({ a: '/Users/x', b: ['C:\\x'], c: { d: '~/x' }, e: 'repo/.claude/x', ok: 'claude-opus-5-5', date: '2026-11-06' });
    assert.deepEqual(found.sort(), ['$.a', '$.b[0]', '$.c.d', '$.e'].sort());
});

// ── T2: Runs roteadas ──────────────────────────────────────────────────────────
const { projectRun } = require('./routing-projection');

const RUN_SHA = 'c'.repeat(64);
const ATTEMPT = '0f8fad5b-d9cb-469f-a165-70867728950e';

function snapshotOk(policyOverrides = {}) {
    return {
        mode: 'ON', ok: true,
        snapshot: {
            mode: 'ON',
            policy_ref: { id: 'routing-pri205', version: 'p1-2026-11-06', sha256: SHA, path: '.claude/routing/policy.json' },
            policy: approvedPolicy(policyOverrides),
            default_route: { model_id: 'claude-opus-5-5', effort: 'alto' },
            eligible_set: { provider: 'anthropic', models: ['claude-sonnet-5-5', 'claude-opus-5-5'] },
            eligible_set_ref: 'd'.repeat(64),
            sha256: RUN_SHA,
        },
    };
}

function decision(selection_source, override_ref = null) {
    return {
        node: 'implement', snapshot_sha256: RUN_SHA, selection_source, override_ref,
        chosen: { model_id: 'claude-sonnet-5-5', effort: 'baixo', tier: 'T1' },
        plugin_proof: { settings_path: '/Users/x/.prisma/settings.json', settings_sha256: 'e'.repeat(64) },
    };
}

function routedState({ decisions = [], overrides } = {}) {
    return {
        task_id: '9001-x', routing_snapshot: { attempt_id: ATTEMPT, sha256: RUN_SHA },
        ...(overrides ? { routing_overrides: overrides } : {}),
        cost_tracking: {
            nodes: {
                implement: { attempts: decisions.map(d => ({ routing_decision: d, selection_source: d.selection_source })) },
                review: { attempts: [{ routing_decision: 'UNAVAILABLE', selection_source: 'DEFAULT_INHERITED' }] },
            },
        },
    };
}

const CURRENT_P1 = projectConfig(onResult());

test('T2: Run sem routing_snapshot é OFF, sem contagens de roteamento', () => {
    const out = projectRun({ taskId: '9001-x', ticketId: 9001, state: { task_id: '9001-x', cost_tracking: { nodes: {} } }, snapshotResult: { mode: 'OFF' }, current: CURRENT_P1 });
    assert.equal(out.mode, 'OFF');
    assert.equal(out.snapshot, null);
    assert.equal(out.selection_sources, null);
    assert.equal(out.policy_drift, null);
    assert.deepEqual(out.overrides, []);
});

test('T2: snapshot íntegro projeta sha, policy da Run e integridade ok, sem caminhos', () => {
    const out = projectRun({ taskId: '9001-x', ticketId: 9001, state: routedState(), snapshotResult: snapshotOk(), current: CURRENT_P1 });
    assert.equal(out.mode, 'ON');
    assert.equal(out.task_id, '9001-x');
    assert.equal(out.ticket_id, 9001);
    assert.deepEqual(out.snapshot, {
        attempt_id: ATTEMPT, sha256: RUN_SHA, sha_short: 'cccccccc', integrity: 'ok',
        policy_ref: { id: 'routing-pri205', version: 'p1-2026-11-06', sha256: SHA, sha_short: '02923a43' },
        eligible_models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
        efforts: ['baixo', 'médio', 'alto', 'máximo'],
    });
    assert.deepEqual(out.policy_drift, { status: 'SAME', current_mode: 'ON', current: { id: 'routing-pri205', version: 'p1-2026-11-06', sha_short: '02923a43' } });
    assert.deepEqual(findPathLike(out), []);
});

test('T2: snapshot adulterado ou ilegível: ON com integrity = detalhe, policy UNKNOWN', () => {
    for (const detail of ['snapshot_hash_mismatch', 'snapshot_unreadable', 'snapshot_binding_mismatch']) {
        const out = projectRun({ taskId: '9001-x', ticketId: 9001, state: routedState(), snapshotResult: { mode: 'ON', ok: false, detail }, current: CURRENT_P1 });
        assert.equal(out.mode, 'ON');
        assert.equal(out.snapshot.integrity, detail);
        assert.equal(out.snapshot.policy_ref, null);
        assert.equal(out.snapshot.sha256, RUN_SHA, 'sha da ligação continua visível');
        assert.deepEqual(out.policy_drift, { status: 'UNKNOWN', current_mode: 'ON', current: { id: 'routing-pri205', version: 'p1-2026-11-06', sha_short: '02923a43' } });
    }
});

test('T2: com ligação mas sem leitura do snapshot: UNKNOWN, nunca OFF', () => {
    const out = projectRun({ taskId: '9001-x', ticketId: 9001, state: routedState(), snapshotResult: undefined, current: CURRENT_P1 });
    assert.equal(out.mode, 'UNKNOWN');
    assert.equal(out.snapshot.integrity, 'UNKNOWN');
});

test('T2: policy vigente diferente: a Run mostra a do snapshot e marca DIFFERENT', () => {
    const p2 = projectConfig(onResult(approvedPolicy({ version: 'p2-2026-12-01' })));
    const changedSha = { ...p2, policy: { ...p2.policy, sha256: 'f'.repeat(64), sha_short: 'ffffffff' } };
    const out = projectRun({ taskId: '9001-x', ticketId: 9001, state: routedState(), snapshotResult: snapshotOk(), current: changedSha });
    assert.equal(out.snapshot.policy_ref.version, 'p1-2026-11-06');
    assert.deepEqual(out.policy_drift, { status: 'DIFFERENT', current_mode: 'ON', current: { id: 'routing-pri205', version: 'p2-2026-12-01', sha_short: 'ffffffff' } });
});

test('T2: config vigente OFF ou INVALID com Run ON: DIFFERENT sem policy vigente', () => {
    for (const current of [projectConfig({ status: 'OFF', source: 'declared' }), projectConfig({ status: 'INVALID', cause: 'POLICY_MISSING', detail: 'not_found' })]) {
        const out = projectRun({ taskId: '9001-x', ticketId: 9001, state: routedState(), snapshotResult: snapshotOk(), current });
        assert.deepEqual(out.policy_drift, { status: 'DIFFERENT', current_mode: current.mode, current: null });
    }
});

test('T2: contagem de selection_source só das RoutingDecisions; valor desconhecido passa como veio', () => {
    const state = routedState({ decisions: [decision('RULES'), decision('RULES'), decision('PLAN_RAISED'), decision('CONSERVATIVE_DEFAULT'), decision('NOVO_VALOR')] });
    const out = projectRun({ taskId: '9001-x', ticketId: 9001, state, snapshotResult: snapshotOk(), current: CURRENT_P1 });
    assert.deepEqual(out.selection_sources, { RULES: 2, PLAN_RAISED: 1, CONSERVATIVE_DEFAULT: 1, NOVO_VALOR: 1 });
    assert.equal(out.decisions_total, 5);
    assert.equal(out.attempts_without_decision, 1);
    assert.deepEqual(findPathLike(out), [], 'settings_path da decisão não vaza');
});

test('T2: Run ON sem nenhum Attempt ainda: contagens vazias explícitas, não null', () => {
    const state = routedState();
    state.cost_tracking = undefined;
    const out = projectRun({ taskId: '9001-x', ticketId: 9001, state, snapshotResult: snapshotOk(), current: CURRENT_P1 });
    assert.deepEqual(out.selection_sources, {});
    assert.equal(out.decisions_total, 0);
    assert.equal(out.attempts_without_decision, 0);
});

test('T2: override aplicada (citada numa decisão) × ainda não aplicada', () => {
    const overrides = [
        { ref: 'RO-1', scope: 'ticket', value: { model_id: 'claude-opus-5-5', effort: 'alto' }, by: 'Richard', via: 'dashboard', recorded_at: '2026-11-06T10:00:00.000Z', operation_id: 'op-1' },
        { ref: 'RO-2', scope: 'node', node: 'implement', value: { model_id: 'claude-sonnet-5-5', effort: 'baixo' }, by: 'Richard', via: 'dashboard', recorded_at: '2026-11-06T11:00:00.000Z', operation_id: 'op-2' },
    ];
    const state = routedState({ overrides, decisions: [decision('HUMAN_OVERRIDE', { ref: 'RO-1', scope: 'ticket' })] });
    const out = projectRun({ taskId: '9001-x', ticketId: 9001, state, snapshotResult: snapshotOk(), current: CURRENT_P1 });
    assert.deepEqual(out.overrides, [
        { ref: 'RO-1', scope: 'ticket', node: null, subtask_key: null, value: { model_id: 'claude-opus-5-5', effort: 'alto' }, by: 'Richard', recorded_at: '2026-11-06T10:00:00.000Z', status: 'APPLIED' },
        { ref: 'RO-2', scope: 'node', node: 'implement', subtask_key: null, value: { model_id: 'claude-sonnet-5-5', effort: 'baixo' }, by: 'Richard', recorded_at: '2026-11-06T11:00:00.000Z', status: 'NOT_APPLIED' },
    ]);
});

test('T2: override malformada não derruba a projeção; campos viram UNKNOWN', () => {
    const state = routedState({ overrides: [null, 'x', { scope: 'nave', value: null }] });
    const out = projectRun({ taskId: '9001-x', ticketId: 9001, state, snapshotResult: snapshotOk(), current: CURRENT_P1 });
    assert.equal(out.overrides.length, 1);
    assert.deepEqual(out.overrides[0], { ref: 'UNKNOWN', scope: 'UNKNOWN', node: null, subtask_key: null, value: { model_id: 'UNKNOWN', effort: 'UNKNOWN' }, by: 'UNKNOWN', recorded_at: 'UNKNOWN', status: 'NOT_APPLIED' });
});

test('T2: ticket_id ausente vira null; task_id sempre presente', () => {
    const out = projectRun({ taskId: '9001-x', ticketId: undefined, state: routedState(), snapshotResult: snapshotOk(), current: CURRENT_P1 });
    assert.equal(out.ticket_id, null);
});

test('T2: contrato com o dono: loadRunSnapshot real (DOM-06 sintético), íntegro e adulterado', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const mr = require('../scripts/lib/model-routing');
    const { loadRunSnapshot } = require('../scripts/lib/routing-run');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-run-proj-'));
    try {
        const snap = mr.buildRoutingSnapshot({ status: 'ON', policy: approvedPolicy(), policy_ref: { id: 'routing-pri205', version: 'p1-2026-11-06', sha256: SHA, path: '.claude/routing/policy.json' } });
        const attemptsDir = path.join(dir, 'dom06', 'attempts');
        fs.mkdirSync(attemptsDir, { recursive: true });
        const file = path.join(attemptsDir, `${ATTEMPT}.json`);
        fs.writeFileSync(file, JSON.stringify({ snapshot: { routing: snap } }));
        const state = { task_id: '9001-x', routing_snapshot: { attempt_id: ATTEMPT, sha256: snap.sha256 } };

        const ok = projectRun({ taskId: '9001-x', ticketId: 9001, state, snapshotResult: loadRunSnapshot(state, dir), current: CURRENT_P1 });
        assert.equal(ok.snapshot.integrity, 'ok');
        assert.equal(ok.snapshot.policy_ref.version, 'p1-2026-11-06');
        assert.equal(ok.policy_drift.status, 'SAME');
        assert.deepEqual(findPathLike(ok), []);
        assert.ok(!JSON.stringify(ok).includes(dir));

        fs.writeFileSync(file, JSON.stringify({ snapshot: { routing: { ...snap, default_route: { model_id: 'claude-sonnet-5-5', effort: 'baixo' } } } }));
        const bad = projectRun({ taskId: '9001-x', ticketId: 9001, state, snapshotResult: loadRunSnapshot(state, dir), current: CURRENT_P1 });
        assert.equal(bad.mode, 'ON');
        assert.equal(bad.snapshot.integrity, 'snapshot_hash_mismatch');
        assert.equal(bad.snapshot.policy_ref, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── T3: recusas, modelos, mistura e sombra × real ──────────────────────────────
const { projectAdmissionBlocked, projectNotStarted, projectAttemptModels, buildMix, projectShadowVsReal } = require('./routing-projection');

test('T3: sem marcador de admissão: null', () => {
    assert.equal(projectAdmissionBlocked(null), null);
    assert.equal(projectAdmissionBlocked({ tickets: [1] }), null, 'sem cause não é marcador válido');
});

test('T3: marcador de admissão: causa, tickets e estado do aviso', () => {
    const base = { signature: 'POLICY_MISSING|not_found', cause: 'POLICY_MISSING', detail: 'not_found', transient: false, transient_count: 0, tickets: [101, 102, 'x'], first_blocked_at: '2026-11-06T09:00:00.000Z', notified_at: null };
    assert.deepEqual(projectAdmissionBlocked(base), {
        cause: 'POLICY_MISSING', detail: 'not_found', transient: false, transient_count: 0,
        tickets: [101, 102], first_blocked_at: '2026-11-06T09:00:00.000Z',
        notice: { status: 'PENDING', at: null, attempts: null, local_notified: false },
    });
    assert.deepEqual(projectAdmissionBlocked({ ...base, notified_at: '2026-11-06T09:01:00.000Z', notice_attempts: 2, local_notified_at: '2026-11-06T09:00:30.000Z' }).notice,
        { status: 'SENT', at: '2026-11-06T09:01:00.000Z', attempts: 2, local_notified: true });
    assert.equal(projectAdmissionBlocked({ ...base, notice_failed_at: '2026-11-06T09:05:00.000Z' }).notice.status, 'FAILED');
    assert.equal(projectAdmissionBlocked({ ...base, notice_uncertain_at: '2026-11-06T09:05:00.000Z' }).notice.status, 'UNCERTAIN');
});

test('T3: detail do marcador com caminho vira UNKNOWN', () => {
    const out = projectAdmissionBlocked({ cause: 'ROUTING_CONFIG_UNREADABLE', detail: '/Users/x/.claude/model-routing.json', tickets: [] });
    assert.equal(out.detail, 'UNKNOWN');
    assert.deepEqual(findPathLike(out), []);
});

test('T3: NOT_STARTED do DOM-06: só os recusados, com nó, causa, detalhe e quando; sem snapshot nem settings_path', () => {
    const attempts = [
        { attempt_id: ATTEMPT, node: 'implement', result: 'NOT_STARTED', not_started: { cause: 'CONFIG_UNVERIFIABLE', detail: 'PLUGIN_NOT_PROVEN_OFF' }, created_at: '2026-11-06T12:00:00.000Z',
          routing: { class: 'C2', chosen: { model_id: 'claude-sonnet-5-5', tier: 'T2' }, plugin_proof: { settings_path: '/Users/x/s.json' } } },
        { attempt_id: 'b'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12), node: 'review', result: 'ADMITTED', created_at: '2026-11-06T11:00:00.000Z' },
        { attempt_id: 'bad', node: 'test', result: 'NOT_STARTED', not_started: { cause: 'PROVIDER_NOT_ELIGIBLE', detail: null } },
        null,
    ];
    assert.deepEqual(projectNotStarted(attempts), [
        { attempt_id: ATTEMPT, node: 'implement', cause: 'CONFIG_UNVERIFIABLE', detail: 'PLUGIN_NOT_PROVEN_OFF', at: '2026-11-06T12:00:00.000Z', class: 'C2', would_model: 'claude-sonnet-5-5' },
        { attempt_id: 'UNKNOWN', node: 'test', cause: 'PROVIDER_NOT_ELIGIBLE', detail: null, at: 'UNKNOWN', class: null, would_model: null },
    ]);
});

function usage(model, role = 'main') { return { model, role }; }
function costAttempt({ id = ATTEMPT, requested = { model: 'UNAVAILABLE', effort: 'UNAVAILABLE' }, usage: u = [], cost = null, unpriced = [], decision: d = 'UNAVAILABLE', would_route = 'UNAVAILABLE' }) {
    return { admission: { attempt_id: id }, requested, observed: { usage: u }, cost: { usd: cost, unpriced_models: unpriced }, routing_decision: d, selection_source: isObjT(d) ? d.selection_source : 'DEFAULT_INHERITED', would_route };
}
const isObjT = v => v != null && typeof v === 'object';

test('T3: modelos por Attempt: pedido × observado, mismatch só quando dá para saber', () => {
    const ct = { nodes: {
        implement: { attempts: [
            costAttempt({ requested: { model: 'claude-sonnet-5-5', effort: 'UNAVAILABLE' }, usage: [usage('claude-sonnet-5-5'), usage('claude-haiku-5-5', 'subagent')], cost: 0.42, decision: decision('RULES') }),
            costAttempt({ requested: { model: 'claude-sonnet-5-5', effort: 'UNAVAILABLE' }, usage: [usage('claude-opus-5-5')], cost: null, unpriced: ['claude-opus-5-5'], decision: decision('RULES') }),
            costAttempt({ requested: { model: 'claude-sonnet-5-5', effort: 'UNAVAILABLE' }, usage: [], cost: null, decision: decision('RULES') }),
        ] },
        review: { attempts: [costAttempt({ usage: [usage('claude-opus-5-5')], cost: 1.5 })] },
    } };
    const rows = projectAttemptModels(ct);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], { node: 'implement', attempt_id: ATTEMPT, requested_model: 'claude-sonnet-5-5', requested_effort: 'UNAVAILABLE', routed: true, selection_source: 'RULES',
        observed_main: ['claude-sonnet-5-5'], observed_subagent: ['claude-haiku-5-5'], cost_usd: 0.42, unpriced_models: [], mismatch: false });
    assert.equal(rows[1].mismatch, true);
    assert.equal(rows[1].cost_usd, null);
    assert.deepEqual(rows[1].unpriced_models, ['claude-opus-5-5']);
    assert.equal(rows[2].mismatch, 'UNKNOWN', 'sem uso observado não dá para comparar');
    assert.equal(rows[3].routed, false);
    assert.equal(rows[3].requested_model, 'UNAVAILABLE');
    assert.equal(rows[3].mismatch, null, 'não roteado: comparação não se aplica');
});

test('T3: mistura por modelo pedido: custo null não vira 0, completude explícita', () => {
    const rows = [
        { requested_model: 'claude-sonnet-5-5', routed: true, cost_usd: 0.4 },
        { requested_model: 'claude-sonnet-5-5', routed: true, cost_usd: null },
        { requested_model: 'claude-opus-5-5', routed: true, cost_usd: 1.6 },
        { requested_model: 'UNAVAILABLE', routed: false, cost_usd: 2 },
    ];
    const mix = buildMix(rows);
    assert.deepEqual(mix.totals, { attempts: 4, priced_attempts: 3, cost_usd: 4 });
    assert.deepEqual(mix.by_requested, [
        { model: 'claude-sonnet-5-5', attempts: 2, priced_attempts: 1, unpriced_attempts: 1, cost_usd: 0.4, share_attempts: 0.5, share_cost: 0.1 },
        { model: 'claude-opus-5-5', attempts: 1, priced_attempts: 1, unpriced_attempts: 0, cost_usd: 1.6, share_attempts: 0.25, share_cost: 0.4 },
        { model: 'NOT_ROUTED', attempts: 1, priced_attempts: 1, unpriced_attempts: 0, cost_usd: 2, share_attempts: 0.25, share_cost: 0.5 },
    ]);
});

test('T3: mistura vazia e mistura sem nenhum preço: shares null, nunca 0', () => {
    assert.deepEqual(buildMix([]), { totals: { attempts: 0, priced_attempts: 0, cost_usd: null }, by_requested: [] });
    const mix = buildMix([{ requested_model: 'claude-opus-5-5', routed: true, cost_usd: null }]);
    assert.equal(mix.totals.cost_usd, null);
    assert.equal(mix.by_requested[0].cost_usd, null);
    assert.equal(mix.by_requested[0].share_cost, null);
    assert.equal(mix.by_requested[0].share_attempts, 1);
});

function shadow(decisions, extra = {}) {
    return { status: 'SHADOW', policy_version: 's3-shadow@1', decisions, applied: false, ...extra };
}

test('T3: sombra × real: classe/tier máximos da sombra contra a decisão real; qualidade não medida', () => {
    const real = (cls, tier) => ({ ...decision('RULES'), class: cls, chosen: { model_id: tier === 'T3' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', tier } });
    const ct = { nodes: { implement: { attempts: [
        costAttempt({ decision: real('C2', 'T2'), would_route: shadow([{ class: 'C1', tier: 'T1' }, { class: 'C2', tier: 'T2' }]) }),
        costAttempt({ decision: real('C3', 'T3'), would_route: shadow([{ class: 'C1', tier: 'T1' }]) }),
        costAttempt({ decision: real('C1', 'T1'), would_route: shadow([{ class: 'C4', tier: 'T3' }]) }),
        costAttempt({ decision: real('C4', 'T3'), would_route: shadow([], { status: 'NO_DECISION', cause: 'CLASSIFIER_OFF' }) }),
        costAttempt({ decision: real('C4', 'T3') }),
        costAttempt({ would_route: shadow([{ class: 'C1', tier: 'T1' }]) }),
        costAttempt({}),
    ] } } };
    const out = projectShadowVsReal(ct);
    assert.deepEqual(out.summary, { SAME: 1, REAL_HIGHER: 1, REAL_LOWER: 1, UNKNOWN: 3 });
    assert.equal(out.rows.length, 6, 'Attempt sem sombra nem decisão fica de fora');
    assert.deepEqual(out.rows[0], { node: 'implement', attempt_id: ATTEMPT,
        shadow: { status: 'SHADOW', policy_version: 's3-shadow@1', class: 'C2', tier: 'T2', subtasks: 2 },
        real: { class: 'C2', tier: 'T2', model_id: 'claude-sonnet-5-5' },
        comparison: 'SAME', quality_effect: 'NOT_MEASURED' });
    assert.equal(out.rows[1].comparison, 'REAL_HIGHER');
    assert.equal(out.rows[2].comparison, 'REAL_LOWER');
    assert.deepEqual(out.rows[3].shadow, { status: 'NO_DECISION', policy_version: 's3-shadow@1', class: null, tier: null, subtasks: 0 });
    assert.equal(out.rows[3].comparison, 'UNKNOWN');
    assert.equal(out.rows[4].shadow, 'UNAVAILABLE');
    assert.equal(out.rows[5].real, 'UNAVAILABLE');
    for (const r of out.rows) assert.equal(r.quality_effect, 'NOT_MEASURED');
});

test('T3: cost_tracking ausente ou malformado: listas vazias, sem lançar', () => {
    for (const ct of [null, undefined, {}, { nodes: null }, { nodes: { implement: { attempts: 'x' } } }]) {
        assert.deepEqual(projectAttemptModels(ct), []);
        assert.deepEqual(projectShadowVsReal(ct), { summary: { SAME: 0, REAL_HIGHER: 0, REAL_LOWER: 0, UNKNOWN: 0 }, rows: [] });
    }
    assert.deepEqual(projectNotStarted(null), []);
});

test('T3: contrato com o dono: NOT_STARTED gravado pelo dom06.beginAttempt real e lido por listAttempts', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dom06 = require('../scripts/lib/dom06-attempt');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-ns-proj-'));
    try {
        dom06.beginAttempt(dir, {
            node: 'implement', cause: 'dispatch',
            admission: { status: 'NOT_STARTED', cause: 'CONFIG_UNVERIFIABLE', detail: 'PLUGIN_NOT_PROVEN_OFF' },
            routing: { ...decision('RULES'), class: 'C2', chosen: { model_id: 'claude-sonnet-5-5', tier: 'T2' } },
        });
        const out = projectNotStarted(dom06.listAttempts(dir));
        assert.equal(out.length, 1);
        assert.equal(out[0].node, 'implement');
        assert.equal(out[0].cause, 'CONFIG_UNVERIFIABLE');
        assert.equal(out[0].detail, 'PLUGIN_NOT_PROVEN_OFF');
        assert.equal(out[0].class, 'C2');
        assert.equal(out[0].would_model, 'claude-sonnet-5-5');
        assert.notEqual(out[0].attempt_id, 'UNKNOWN');
        assert.notEqual(out[0].at, 'UNKNOWN');
        assert.deepEqual(findPathLike(out), []);
        assert.ok(!JSON.stringify(out).includes(dir));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Checkpoint A: caminhos plantados em todo campo de entrada não saem em nenhuma projeção', () => {
    const P = '/Users/x/segredo/.claude/a.json';
    const loaded = onResult(approvedPolicy({ status: P, approval: { by: P, at: P }, classifier: { provider: P }, default_route: { model_id: P, effort: P } }));
    loaded.policy_ref = { id: P, version: P, sha256: P, path: P };
    const cfg = projectConfig(loaded);
    const state = routedState({
        decisions: [{ ...decision(P, { ref: P }), class: P, chosen: { model_id: P, tier: P } }],
        overrides: [{ ref: P, scope: P, node: P, subtask_key: P, value: { model_id: P, effort: P }, by: P, recorded_at: P, operation_id: P, via: P }],
    });
    state.routing_snapshot = { attempt_id: P, sha256: P };
    const snapRes = { mode: 'ON', ok: true, snapshot: { policy_ref: { id: P, version: P, sha256: P, path: P } } };
    const ct = { nodes: { [P]: { attempts: [costAttempt({ id: P, requested: { model: P, effort: P }, usage: [usage(P), usage(P, 'subagent')], unpriced: [P],
        decision: { ...decision(P), class: P, chosen: { model_id: P, tier: P } }, would_route: shadow([{ class: P, tier: P }], { status: P, policy_version: P }) })] } } };
    const outputs = {
        cfg,
        run: projectRun({ taskId: P, ticketId: 1, state, snapshotResult: snapRes, current: cfg }),
        runBad: projectRun({ taskId: P, ticketId: 1, state, snapshotResult: { mode: 'ON', ok: false, detail: P }, current: cfg }),
        blocked: projectAdmissionBlocked({ cause: P, detail: P, tickets: [P], first_blocked_at: P, notified_at: P }),
        notStarted: projectNotStarted([{ attempt_id: P, node: P, result: 'NOT_STARTED', not_started: { cause: P, detail: P }, created_at: P, routing: { class: P, chosen: { model_id: P } } }]),
        models: projectAttemptModels(ct),
        mix: buildMix(projectAttemptModels(ct)),
        shadow: projectShadowVsReal(ct),
    };
    assert.deepEqual(findPathLike(outputs), []);
    assert.ok(!JSON.stringify(outputs).includes('segredo'));
});

// ── T7: o formulário de override usa o conjunto elegível DO SNAPSHOT da Run ─────
test('T7: snapshot íntegro expõe modelos elegíveis e esforços do próprio snapshot', () => {
    const p2 = projectConfig(onResult(approvedPolicy({ tiers: { T1: { models: ['claude-haiku-5-5'] }, T2: { models: ['claude-sonnet-5-5'] }, T3: { models: ['claude-opus-5-5'] } } })));
    const out = projectRun({ taskId: '9001-x', ticketId: 9001, state: routedState(), snapshotResult: snapshotOk(), current: p2 });
    assert.deepEqual(out.snapshot.eligible_models, ['claude-sonnet-5-5', 'claude-opus-5-5'], 'vem do snapshot, nunca da policy vigente');
    assert.deepEqual(out.snapshot.efforts, ['baixo', 'médio', 'alto', 'máximo']);
});

test('T7: snapshot adulterado ou não lido: sem listas para o formulário (null)', () => {
    for (const snapshotResult of [{ mode: 'ON', ok: false, detail: 'snapshot_hash_mismatch' }, undefined]) {
        const out = projectRun({ taskId: '9001-x', ticketId: 9001, state: routedState(), snapshotResult, current: CURRENT_P1 });
        assert.equal(out.snapshot.eligible_models, null);
        assert.equal(out.snapshot.efforts, null);
    }
});

test('T7: valores com cara de caminho nas listas do snapshot viram UNKNOWN', () => {
    const res = snapshotOk();
    res.snapshot.eligible_set = { provider: 'anthropic', models: ['/Users/x/m', 'claude-opus-5-5'] };
    res.snapshot.policy.effort_map = { '/tmp/x': 'low', alto: 'high' };
    const out = projectRun({ taskId: '9001-x', ticketId: 9001, state: routedState(), snapshotResult: res, current: CURRENT_P1 });
    assert.deepEqual(out.snapshot.eligible_models, ['UNKNOWN', 'claude-opus-5-5']);
    assert.deepEqual(out.snapshot.efforts, ['UNKNOWN', 'alto']);
    assert.deepEqual(findPathLike(out), []);
});
