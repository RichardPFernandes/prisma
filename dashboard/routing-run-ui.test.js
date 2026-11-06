// node --test routing-run-ui.test.js
// T7 (telas de roteamento): bloco "Roteamento" no detalhe da Run + formulário de override.
// Roda contra o Dashboard REAL (createDashboard), sem aprovador (decisão de 2026-11-06), com uma Run
// roteada de verdade (snapshot no DOM-06): a tela chama o writer existente
// (POST /api/runs/:taskId/routing-override) e só projeta a recusa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createDashboard } = require('./server');
const { sha256Bytes } = require('../scripts/lib/model-routing-policy');
const mr = require('../scripts/lib/model-routing');
const dom06 = require('../scripts/lib/dom06-attempt');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'routing-run-ui-'));

const repo = path.join(tmp, 'consumer');
const runsDir = path.join(repo, 'memory', 'runs');
fs.mkdirSync(path.join(repo, '.claude', 'routing'), { recursive: true });
fs.mkdirSync(runsDir, { recursive: true });
const policy = {
    id: 'routing-pri205', version: 'p1-2026-11-06', mode: 'ROUTED', status: 'APROVADA', classifier: { provider: 'cheap_rule' },
    class_to_tier: { C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' }, C3: { tier: 'T3', effort: 'alto' }, C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' } },
    tiers: { T1: { models: ['claude-sonnet-5-5'] }, T2: { models: ['claude-sonnet-5-5'] }, T3: { models: ['claude-opus-5-5'] } },
    default_route: { model_id: 'claude-opus-5-5', effort: 'alto' },
    effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' }, effort_applied: false,
};
const bytes = Buffer.from(JSON.stringify(policy));
fs.writeFileSync(path.join(repo, '.claude', 'routing', 'policy.json'), bytes);
const ref = { id: policy.id, version: policy.version, sha256: sha256Bytes(bytes), path: '.claude/routing/policy.json' };
fs.writeFileSync(path.join(repo, '.claude', 'model-routing.json'), JSON.stringify({ mode: 'ON', policy_ref: ref }));

function seed(taskId, { routed = true, status = 'blocked' } = {}) {
    const dir = path.join(runsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    const state = {
        task_id: taskId, node: 'implement', status, history: ['plan', 'implement'],
        redmine_ticket: { id: Number(taskId.split('-')[0]) },
        started_at: '2026-11-06T10:00:00.000Z', updated_at: '2026-11-06T12:00:00.000Z',
    };
    if (routed) {
        const snap = mr.buildRoutingSnapshot({ status: 'ON', policy, policy_ref: ref });
        const adm = dom06.beginAttempt(path.join(runsDir, '_dom06'), {
            node: 'fetch_ticket', cause: 'dispatch',
            admission: { status: 'ADMITTED', owner: 'watcher', snapshot: { routing: snap }, obligations: [] },
        });
        state.routing_snapshot = { attempt_id: adm.attempt.attempt_id, sha256: snap.sha256 };
    }
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    return dir;
}
const overridesOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).routing_overrides || [];

// ── DOM mínimo (o bloco é HTML em string, como o Authorization) ─────────────────
function element(id) {
    return {
        id, html: '', value: '', listeners: {},
        set innerHTML(v) { this.html = String(v); },
        get innerHTML() { return this.html; },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    };
}

let dash, base;
test.before(async () => {
    dash = createDashboard({ env: { ...process.env }, repoRoot: repo, memoryDir: runsDir, worktreesDir: path.join(tmp, 'wt'), prefsFile: path.join(tmp, 'prefs.json') });
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${dash.server.address().port}`;
});
test.after(async () => {
    await dash.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function boot(taskId, { loseResponseOnce = false, serverErrorOnce = false } = {}) {
    const elements = new Map();
    const $ = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
    const posted = [];
    let lose = loseResponseOnce;
    let fail500 = serverErrorOnce;
    const runs = new Map();
    const summary = async id => (await (await globalThis.fetch(`${base}/api/runs/${id}`)).json());
    runs.set(taskId, await summary(taskId));
    const confirms = [];
    const context = {
        $, runs, selected: taskId, confirms, URL, JSON, Date, Promise, setTimeout, clearTimeout,
        localStorage: { getItem: () => null, setItem() {} },
        esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        when: iso => (iso ? new Date(iso).toISOString() : ''),
        confirm(msg) { confirms.push(msg); return true; },
        async api(url) {
            const res = await globalThis.fetch(new URL(url, base));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        async fetch(url, opts) {
            if (opts?.method === 'POST') posted.push(JSON.parse(opts.body));
            const res = await globalThis.fetch(new URL(url, base), opts);
            // Resposta "perdida": o servidor gravou, mas a tela não sabe.
            if (lose && opts?.method === 'POST') { lose = false; await res.text(); throw new Error('rede caiu'); }
            // 500 depois de gravar: o writer comitou, mas a resposta virou erro (desfecho incerto).
            if (fail500 && opts?.method === 'POST') { fail500 = false; await res.text(); return new Response(JSON.stringify({ error: 'falhou depois de gravar' }), { status: 500, headers: { 'content-type': 'application/json' } }); }
            return res;
        },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'state-version.js'), 'utf8'), context, { filename: 'state-version.js' });
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'routing-run.js'), 'utf8'), context, { filename: 'routing-run.js' });
    const RR = context.RoutingRun;
    const ui = {
        $, posted, confirms,
        html: () => RR.html(runs.get(taskId)),
        box: () => $('routingRunBox').innerHTML,
        async refreshRun() { runs.set(taskId, await summary(taskId)); },
        async wire() {
            RR.wire(runs.get(taskId));
            await until(() => /rtr-form|rtr-msg|Roteamento/.test(ui.box()) && !/Carregando roteamento/.test(ui.box()));
        },
        fill(values) {
            for (const [k, v] of Object.entries(values)) $(k).value = v;
            for (const fn of $('routingRunBox').listeners.change || []) fn({ target: $(Object.keys(values)[0]) });
        },
        async click(act) {
            const node = { dataset: { rtr: act }, disabled: false };
            for (const fn of $('routingRunBox').listeners.click || []) fn({ target: { closest: () => node } });
            await until(() => !/Gravando…/.test(ui.box()));
        },
    };
    return ui;
}
async function until(fn, ms = 5000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (fn()) return;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('timeout esperando o bloco Roteamento');
}

const OK_FORM = { rtrScope: 'node', rtrNode: 'implement', rtrModel: 'claude-opus-5-5', rtrEffort: 'alto' };

test('T7: Run sem roteamento (OFF) não ganha bloco', async () => {
    seed('9900-off', { routed: false });
    const ui = await boot('9900-off');
    assert.equal(ui.html(), '');
});

test('T7: bloco mostra snapshot e o formulário só com opções do snapshot, e nota de esforço', async () => {
    seed('9901-a');
    const ui = await boot('9901-a');
    assert.match(ui.html(), /id="routingRunBox"/);
    await ui.wire();
    const h = ui.box();
    assert.match(h, /routing-pri205@p1-2026-11-06/);
    assert.match(h, /<option value="claude-sonnet-5-5"/);
    assert.match(h, /<option value="claude-opus-5-5"/);
    assert.doesNotMatch(h, /claude-haiku|claude-fable/);
    assert.match(h, /<option value="máximo"/);
    assert.match(h, /não vai ao despacho enquanto o esforço não for aplicado/);
    assert.match(h, /vale a partir do próximo limite de nó/i);
    assert.doesNotMatch(h, /settings_path|\/Users\/|\.claude\/routing/);
});

test('T7: gravar override pelo writer existente; aparece como ainda não aplicada', async () => {
    const dir = seed('9902-b');
    const ui = await boot('9902-b');
    await ui.wire();
    ui.fill(OK_FORM);
    await ui.click('save');
    assert.equal(ui.confirms.length, 1);
    assert.match(ui.confirms[0], /implement → claude-opus-5-5 \/ alto/);
    assert.match(ui.box(), /Override RO-1 gravada/);
    const list = overridesOf(dir);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].value, { model_id: 'claude-opus-5-5', effort: 'alto' });
    assert.equal(list[0].by, require('node:os').userInfo().username, 'autoria = usuário do SO (sem aprovador)');
    await until(() => /RO-1[\s\S]*ainda não aplicada/.test(ui.box()));
    assert.equal(typeof ui.posted[0].expected_state_version, 'number', 'manda o CAS que a tela carregou');
    assert.ok(!('approver' in ui.posted[0]) && !('approver_password' in ui.posted[0]), 'não manda aprovador nem senha');
});

test('T7: sem aprovador nem senha no formulário (decisão de 2026-11-06)', async () => {
    seed('9903-c');
    const ui = await boot('9903-c');
    await ui.wire();
    assert.doesNotMatch(ui.box(), /Aprovador|Senha|rtrApprover|rtrPassword|type="password"/);
    assert.match(ui.box(), /data-rtr="save"/);
});

test('T7: modelo fora do snapshot: a tela não é a guarda, o writer recusa OVERRIDE_INELIGIBLE', async () => {
    const dir = seed('9904-d');
    const ui = await boot('9904-d');
    await ui.wire();
    ui.fill({ ...OK_FORM, rtrModel: 'claude-mythos' });
    await ui.click('save');
    assert.match(ui.box(), /OVERRIDE_INELIGIBLE/);
    assert.deepEqual(overridesOf(dir), []);
});

test('T7: resposta perdida: o retry reusa o mesmo operation_id e não grava duas vezes', async () => {
    const dir = seed('9905-e');
    const ui = await boot('9905-e', { loseResponseOnce: true });
    await ui.wire();
    ui.fill(OK_FORM);
    await ui.click('save');
    assert.match(ui.box(), /resultado incerto/i);
    assert.equal(overridesOf(dir).length, 1, 'o servidor gravou mesmo sem a resposta chegar');
    await ui.refreshRun();
    await ui.click('save');
    assert.equal(ui.posted.length, 2);
    assert.equal(ui.posted[1].operation_id, ui.posted[0].operation_id);
    assert.match(ui.box(), /já tinha sido gravada/i);
    assert.equal(overridesOf(dir).length, 1);
});

test('T7: mudar o formulário depois de um resultado incerto gera operation_id novo', async () => {
    seed('9906-f');
    const ui = await boot('9906-f', { loseResponseOnce: true });
    await ui.wire();
    ui.fill(OK_FORM);
    await ui.click('save');
    await ui.refreshRun();
    ui.fill({ ...OK_FORM, rtrEffort: 'máximo' });
    await ui.click('save');
    assert.notEqual(ui.posted[1].operation_id, ui.posted[0].operation_id);
});

test('T7: nó rodando: botão desabilitado com o motivo', async () => {
    seed('9907-g', { status: 'running' });
    const ui = await boot('9907-g');
    await ui.wire();
    assert.match(ui.box(), /data-rtr="save"[^>]*disabled/);
    assert.match(ui.box(), /há um nó rodando/i);
});

test('T7 (MAJOR-2): 500 depois de gravar é incerto: reenvio reusa o operation_id e não grava duas vezes', async () => {
    const dir = seed('9908-h');
    const ui = await boot('9908-h', { serverErrorOnce: true });
    await ui.wire();
    ui.fill(OK_FORM);
    await ui.click('save');
    assert.match(ui.box(), /Resultado incerto \(HTTP 500\)/);
    assert.equal(overridesOf(dir).length, 1);
    await ui.refreshRun();
    await ui.click('save');
    assert.equal(ui.posted[1].operation_id, ui.posted[0].operation_id);
    assert.match(ui.box(), /já tinha sido gravada/i);
    assert.equal(overridesOf(dir).length, 1, 'sem RO-2 duplicada');
});
