'use strict';
// GET /api/routing — read model das telas de roteamento (T4). Só leitura, sem caminhos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDashboard } = require('./server');
const { findPathLike } = require('./routing-projection');
const { sha256Bytes } = require('../scripts/lib/model-routing-policy');
const mr = require('../scripts/lib/model-routing');
const dom06 = require('../scripts/lib/dom06-attempt');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'routing-api-'));

function policy(overrides = {}) {
    return {
        id: 'routing-pri205', version: 'p1-2026-11-06', mode: 'ROUTED', status: 'APROVADA',
        approval: { by: 'Richard Fernandes', at: '2026-11-06' },
        classifier: { provider: 'cheap_rule' },
        class_to_tier: {
            C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' },
            C3: { tier: 'T3', effort: 'alto' }, C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
        },
        tiers: { T1: { models: ['claude-sonnet-5-5'] }, T2: { models: ['claude-sonnet-5-5'] }, T3: { models: ['claude-opus-5-5'] } },
        default_route: { model_id: 'claude-opus-5-5', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
        effort_applied: false,
        ...overrides,
    };
}

/** Consumidor sintético: `mode` ON (policy válida), INVALID (hash errado) ou OFF (sem arquivo). */
function makeConsumer(name, mode) {
    const repo = path.join(tmp, name);
    const runs = path.join(repo, 'memory', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.mkdirSync(path.join(repo, '.claude', 'routing'), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(policy()));
    fs.writeFileSync(path.join(repo, '.claude', 'routing', 'policy.json'), bytes);
    const ref = { id: 'routing-pri205', version: 'p1-2026-11-06', sha256: sha256Bytes(bytes), path: '.claude/routing/policy.json' };
    if (mode === 'ON') fs.writeFileSync(path.join(repo, '.claude', 'model-routing.json'), JSON.stringify({ mode: 'ON', policy_ref: ref }));
    if (mode === 'INVALID') fs.writeFileSync(path.join(repo, '.claude', 'model-routing.json'), JSON.stringify({ mode: 'ON', policy_ref: { ...ref, sha256: 'b'.repeat(64) } }));
    return { repo, runs, ref };
}

function writeState(runs, taskId, state) {
    const dir = path.join(runs, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        task_id: taskId, node: 'implement', status: 'running', history: ['plan', 'implement'],
        started_at: '2026-11-06T10:00:00.000Z', updated_at: '2026-11-06T12:00:00.000Z', ...state,
    }));
    return dir;
}

function routedDecision(sha, extra = {}) {
    return {
        node: 'implement', snapshot_sha256: sha, class: 'C2', selection_source: 'RULES', override_ref: null,
        chosen: { model_id: 'claude-sonnet-5-5', effort: 'médio', cli_effort: 'medium', tier: 'T2' },
        plugin_proof: { settings_path: '/Users/x/.prisma/routing-settings.json', settings_sha256: 'e'.repeat(64) },
        effort_applied: false, ...extra,
    };
}

function seedRoutedRun(c, taskId, { tamper = false } = {}) {
    const snap = mr.buildRoutingSnapshot({ status: 'ON', policy: policy(), policy_ref: c.ref });
    const fetchDir = path.join(c.runs, '_dom06');
    const admission = dom06.beginAttempt(fetchDir, {
        node: 'fetch_ticket', cause: 'dispatch',
        admission: { status: 'ADMITTED', owner: 'watcher', snapshot: { routing: tamper ? { ...snap, default_route: { model_id: 'x', effort: 'y' } } : snap }, obligations: [] },
    });
    const attemptId = admission.attempt_id || admission.attempt?.attempt_id;
    const dir = writeState(c.runs, taskId, {
        routing_snapshot: { attempt_id: attemptId, sha256: snap.sha256 },
        routing_overrides: [{ ref: 'RO-1', scope: 'node', node: 'implement', value: { model_id: 'claude-opus-5-5', effort: 'alto' }, by: 'Richard', via: 'dashboard', recorded_at: '2026-11-06T11:00:00.000Z', operation_id: 'op-1' }],
        cost_tracking: { nodes: {
            implement: { attempts: [{
                admission: { attempt_id: '11111111-1111-4111-8111-111111111111' },
                requested: { model: 'claude-sonnet-5-5', effort: 'UNAVAILABLE' },
                observed: { usage: [{ model: 'claude-sonnet-5-5', role: 'main' }] },
                cost: { usd: 0.5, unpriced_models: [] },
                selection_source: 'RULES',
                routing_decision: routedDecision(snap.sha256),
                would_route: { status: 'SHADOW', policy_version: 's3-shadow@1', applied: false, decisions: [{ class: 'C1', tier: 'T1' }, { class: 'C2', tier: 'T2' }] },
            }] },
            review: { attempts: [{
                admission: { attempt_id: '22222222-2222-4222-8222-222222222222' },
                requested: { model: 'claude-opus-5-5', effort: 'UNAVAILABLE' },
                observed: { usage: [{ model: 'claude-opus-5-5', role: 'main' }] },
                cost: { usd: null, unpriced_models: ['claude-opus-5-5'] },
                selection_source: 'FIXED_NODE',
                routing_decision: routedDecision(snap.sha256, { node: 'review', class: null, selection_source: 'FIXED_NODE', chosen: { model_id: 'claude-opus-5-5', effort: 'alto', tier: 'T3' } }),
            }] },
        } },
    });
    return { dir, snap };
}

async function withDashboard(c, fn, extra = {}) {
    const dash = createDashboard({ repoRoot: c.repo, memoryDir: c.runs, worktreesDir: path.join(c.repo, '.claude', 'worktrees'), env: {}, ...extra });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${dash.server.address().port}`;
    try {
        return await fn(async p => {
            const res = await fetch(base + p);
            return { status: res.status, body: await res.json() };
        });
    } finally {
        await dash.close();
    }
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('GET /api/routing com mode ON: config, Runs roteada e OFF, NOT_STARTED, mix e sombra, sem caminhos', async () => {
    const c = makeConsumer('on', 'ON');
    seedRoutedRun(c, '9101-roteada');
    writeState(c.runs, '9102-off', { cost_tracking: { nodes: { implement: { attempts: [{ admission: { attempt_id: '33333333-3333-4333-8333-333333333333' }, requested: { model: 'UNAVAILABLE', effort: 'UNAVAILABLE' }, observed: { usage: [] }, cost: { usd: 2 }, routing_decision: 'UNAVAILABLE' }] } } } });
    const blocked = seedRoutedRun(c, '9103-bloqueada');
    dom06.beginAttempt(blocked.dir, {
        node: 'implement', cause: 'dispatch',
        admission: { status: 'NOT_STARTED', cause: 'CONFIG_UNVERIFIABLE', detail: 'PLUGIN_NOT_PROVEN_OFF' },
        routing: routedDecision(blocked.snap.sha256),
    });
    const st = JSON.parse(fs.readFileSync(path.join(blocked.dir, 'state.json'), 'utf8'));
    fs.writeFileSync(path.join(blocked.dir, 'state.json'), JSON.stringify({ ...st, status: 'blocked' }));

    await withDashboard(c, async get => {
        const { status, body } = await get('/api/routing');
        assert.equal(status, 200);
        assert.equal(body.config.mode, 'ON');
        assert.equal(body.config.policy.version, 'p1-2026-11-06');
        assert.equal(body.admission_blocked, null);

        const byId = Object.fromEntries(body.runs.map(r => [r.task_id, r]));
        assert.equal(byId['9101-roteada'].mode, 'ON');
        assert.equal(byId['9101-roteada'].snapshot.integrity, 'ok');
        assert.equal(byId['9101-roteada'].policy_drift.status, 'SAME');
        assert.deepEqual(byId['9101-roteada'].selection_sources, { RULES: 1, FIXED_NODE: 1 });
        assert.equal(byId['9101-roteada'].overrides[0].status, 'NOT_APPLIED');
        assert.equal(byId['9101-roteada'].models.length, 2);
        assert.deepEqual(byId['9101-roteada'].not_started, []);
        assert.equal(byId['9102-off'].mode, 'OFF');
        assert.equal(byId['9102-off'].not_started, null);
        assert.equal(byId['9103-bloqueada'].not_started.length, 1);
        assert.equal(byId['9103-bloqueada'].not_started[0].cause, 'CONFIG_UNVERIFIABLE');

        assert.equal(body.mix.totals.attempts, 5);
        assert.equal(body.mix.totals.priced_attempts, 3, 'review sem preço não soma 0');
        const shadowRows = body.shadow_vs_real.rows.filter(r => r.task_id === '9101-roteada');
        assert.equal(shadowRows.find(r => r.node === 'implement').comparison, 'SAME');
        assert.equal(shadowRows.find(r => r.node === 'review').shadow, 'UNAVAILABLE');

        assert.deepEqual(findPathLike(body), []);
        const text = JSON.stringify(body);
        assert.ok(!text.includes(c.repo), 'raiz do consumidor não vaza');
        assert.ok(!text.includes('settings_path'), 'settings_path não vaza');
        assert.ok(!text.includes('policy.json'));
    });
});

test('GET /api/routing com snapshot adulterado: integridade com o detalhe, Run continua ON', async () => {
    const c = makeConsumer('tamper', 'ON');
    seedRoutedRun(c, '9201-adulterada', { tamper: true });
    await withDashboard(c, async get => {
        const { body } = await get('/api/routing');
        const run = body.runs.find(r => r.task_id === '9201-adulterada');
        assert.equal(run.mode, 'ON');
        assert.equal(run.snapshot.integrity, 'snapshot_hash_mismatch');
        assert.equal(run.policy_drift.status, 'UNKNOWN');
    });
});

test('GET /api/routing com mode OFF (sem arquivo): desligado, sem policy', async () => {
    const c = makeConsumer('off', 'OFF');
    writeState(c.runs, '9301-x', {});
    await withDashboard(c, async get => {
        const { status, body } = await get('/api/routing');
        assert.equal(status, 200);
        assert.deepEqual(body.config, { mode: 'OFF', source: 'absent', invalid: null, policy: null });
        assert.equal(body.runs[0].mode, 'OFF');
        assert.equal(body.runs[0].selection_sources, null);
        assert.deepEqual(body.mix.totals, { attempts: 0, priced_attempts: 0, cost_usd: null });
    });
});

test('GET /api/routing com config INVALID e marcador de admissão: recusa projetada', async () => {
    const c = makeConsumer('invalid', 'INVALID');
    fs.writeFileSync(path.join(c.runs, 'routing-admission-blocked.json'), JSON.stringify({
        signature: 'POLICY_HASH_MISMATCH|x', cause: 'POLICY_HASH_MISMATCH', detail: `expected:${'b'.repeat(64)}`, transient: false, transient_count: 0,
        tickets: [9401, 9402], first_blocked_at: '2026-11-06T09:00:00.000Z', notified_at: null, notice_uncertain_at: '2026-11-06T09:02:00.000Z',
    }));
    await withDashboard(c, async get => {
        const { body } = await get('/api/routing');
        assert.equal(body.config.mode, 'INVALID');
        assert.equal(body.config.invalid.cause, 'POLICY_HASH_MISMATCH');
        assert.deepEqual(body.admission_blocked.tickets, [9401, 9402]);
        assert.equal(body.admission_blocked.notice.status, 'UNCERTAIN');
        assert.deepEqual(findPathLike(body), []);
    });
});

test('GET /api/routing: state.json ilegível não derruba a resposta; ?limit limita a lista de Runs', async () => {
    const c = makeConsumer('broken', 'OFF');
    for (let i = 0; i < 4; i += 1) writeState(c.runs, `950${i}-ok`, { updated_at: `2026-11-06T1${i}:00:00.000Z` });
    const bad = path.join(c.runs, '9599-ruim');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'state.json'), '{nao-e-json');
    await withDashboard(c, async get => {
        const all = await get('/api/routing');
        assert.equal(all.status, 200);
        assert.deepEqual(all.body.runs.find(r => r.task_id === '9599-ruim'),
            { task_id: '9599-ruim', ticket_id: 9599, mode: 'UNKNOWN', error: 'STATE_UNREADABLE', updated_at: null },
            'Run ilegível aparece como UNKNOWN, nunca como OFF');
        const lim = await get('/api/routing?limit=2');
        assert.equal(lim.status, 200);
        assert.equal(lim.body.runs.length, 2);
        assert.equal(lim.body.runs[0].task_id, '9503-ok', 'mais recente primeiro');
        assert.equal(lim.body.runs_total, all.body.runs_total);
        const badLimit = await get('/api/routing?limit=abc');
        assert.equal(badLimit.status, 400);
    });
});

test('GET /api/routing: cache de NOT_STARTED enxerga Attempt gravado depois da 1ª leitura', async () => {
    const c = makeConsumer('cache', 'ON');
    const r = seedRoutedRun(c, '9601-cache');
    await withDashboard(c, async get => {
        const first = await get('/api/routing');
        assert.deepEqual(first.body.runs.find(x => x.task_id === '9601-cache').not_started, []);
        dom06.beginAttempt(r.dir, {
            node: 'implement', cause: 'dispatch',
            admission: { status: 'NOT_STARTED', cause: 'PROVIDER_NOT_ELIGIBLE', detail: 'no_eligible_candidate' },
        });
        const second = await get('/api/routing');
        const ns = second.body.runs.find(x => x.task_id === '9601-cache').not_started;
        assert.equal(ns.length, 1);
        assert.equal(ns[0].cause, 'PROVIDER_NOT_ELIGIBLE');
    });
});

test('GET /api/routing com o leitor fora do ar: config e Runs roteadas UNKNOWN, nunca OFF', async () => {
    const c = makeConsumer('reader-down', 'ON');
    const r = seedRoutedRun(c, '9701-roteada');
    // Com a pasta de Attempts do DOM-06 presente, só o leitor sabe se há NOT_STARTED.
    dom06.beginAttempt(r.dir, { node: 'implement', cause: 'dispatch', admission: { status: 'NOT_STARTED', cause: 'PROVIDER_NOT_ELIGIBLE', detail: 'x' } });
    writeState(c.runs, '9702-off', {});
    await withDashboard(c, async get => {
        const { status, body } = await get('/api/routing');
        assert.equal(status, 200);
        assert.equal(body.reader, 'FAILED');
        assert.equal(body.config.mode, 'UNKNOWN');
        const routed = body.runs.find(r => r.task_id === '9701-roteada');
        assert.equal(routed.mode, 'UNKNOWN');
        assert.equal(routed.not_started, 'UNKNOWN');
        assert.equal(body.runs.find(r => r.task_id === '9702-off').mode, 'OFF', 'sem ligação continua OFF pelo próprio state');
        assert.deepEqual(findPathLike(body), []);
    }, { routingReadScript: path.join(tmp, 'nao-existe.js') });
});

test('GET /api/routing: leitor OK reporta reader OK', async () => {
    const c = makeConsumer('reader-ok', 'OFF');
    await withDashboard(c, async get => {
        const { body } = await get('/api/routing');
        assert.equal(body.reader, 'OK');
    });
});

test('GET /api/routing?task=: só aquela Run, com elegíveis do snapshot; task inexistente devolve lista vazia', async () => {
    const c = makeConsumer('task-filter', 'ON');
    seedRoutedRun(c, '9801-a');
    seedRoutedRun(c, '9802-b');
    await withDashboard(c, async get => {
        const one = await get('/api/routing?task=9801-a');
        assert.equal(one.status, 200);
        assert.deepEqual(one.body.runs.map(r => r.task_id), ['9801-a']);
        assert.deepEqual(one.body.runs[0].snapshot.eligible_models, ['claude-sonnet-5-5', 'claude-opus-5-5']);
        assert.deepEqual(one.body.runs[0].snapshot.efforts, ['baixo', 'médio', 'alto', 'máximo']);
        assert.equal(one.body.mix.totals.attempts, 2, 'mix só da Run pedida');
        const none = await get('/api/routing?task=9999-nao-existe');
        assert.deepEqual(none.body.runs, []);
        const bad = await get('/api/routing?task=../etc');
        assert.equal(bad.status, 400);
    });
});

test('revisão do Checkpoint B (MINOR-1): adulterar o Attempt de admissão depois da 1ª leitura aparece na leitura seguinte', async () => {
    const c = makeConsumer('cache-snap', 'ON');
    seedRoutedRun(c, '9901-snap');
    await withDashboard(c, async get => {
        const first = await get('/api/routing?task=9901-snap');
        assert.equal(first.body.runs[0].snapshot.integrity, 'ok');
        const attemptsDir = path.join(c.runs, '_dom06', 'dom06', 'attempts');
        for (const f of fs.readdirSync(attemptsDir)) {
            const file = path.join(attemptsDir, f);
            const a = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (a.snapshot?.routing) {
                a.snapshot.routing.default_route = { model_id: 'adulterado', effort: 'x' };
                fs.writeFileSync(file, JSON.stringify(a) + '\n');
            }
        }
        const second = await get('/api/routing?task=9901-snap');
        assert.equal(second.body.runs[0].snapshot.integrity, 'snapshot_hash_mismatch');
        assert.deepEqual(findPathLike(second.body), []);
    });
});

test('revisão do Checkpoint B (MINOR-8): ?task= com elegíveis passa na varredura anti-caminho', async () => {
    const c = makeConsumer('task-scan', 'ON');
    seedRoutedRun(c, '9902-scan');
    await withDashboard(c, async get => {
        const out = await get('/api/routing?task=9902-scan');
        assert.ok(out.body.runs[0].snapshot.eligible_models.length > 0);
        assert.deepEqual(findPathLike(out.body), []);
        assert.ok(!JSON.stringify(out.body).includes(c.repo));
    });
});
