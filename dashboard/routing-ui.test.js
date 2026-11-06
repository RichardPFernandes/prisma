// node --test routing-ui.test.js
// T5 (telas de roteamento): view "Roteamento de modelo", aba Hoje, no harness de DOM do
// dashboard (vm, sem browser). O /api/routing é servido com fixtures: o contrato da API
// é testado em routing-api.test.js; aqui só a renderização dos estados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

function element(tag = 'div') {
    return {
        tag, children: [], attributes: {}, listeners: {}, dataset: {}, className: '', textContent: '',
        disabled: false, type: '', title: '', hidden: false, scrollTop: 0, html: '', tabIndex: 0,
        classList: { add() {}, remove() {} },
        append(...kids) { this.children.push(...kids.map(k => (typeof k === 'string' ? { textContent: k, children: [] } : k))); },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name]; },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn({ target: this }); },
        replaceChildren(...kids) { this.children = kids; },
        querySelector() { return null; },
        closest() { return null; },
        focus() {},
        scrollIntoView() {},
        set innerHTML(value) { this.html = String(value); },
        get innerHTML() { return this.html; },
    };
}
function walk(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    out.push(node);
    for (const child of node.children || []) walk(child, out);
    return out;
}
function flatText(node) {
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return '';
    return `${node.textContent || ''} ${(node.children || []).map(flatText).join(' ')}`;
}
async function until(fn, ms = 4000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (fn()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('timeout esperando a view Roteamento');
}

const SHA = '02923a43' + 'a'.repeat(56);
const P1 = {
    id: 'routing-pri205', version: 'p1-2026-11-06', sha256: SHA, sha_short: '02923a43', status: 'APROVADA',
    approval: { by: 'Richard Fernandes', at: '2026-11-06' }, classifier_provider: 'cheap_rule',
    classes: [
        { class: 'C1', tier: 'T1', effort: 'baixo', models: ['claude-sonnet-5-5'] },
        { class: 'C2', tier: 'T2', effort: 'médio', models: ['claude-sonnet-5-5'] },
        { class: 'C3', tier: 'T3', effort: 'alto', models: ['claude-opus-5-5'] },
        { class: 'C4', tier: 'T3', effort: 'alto', models: ['claude-opus-5-5'] },
        { class: 'C5', tier: 'T3', effort: 'máximo', models: ['claude-opus-5-5'] },
    ],
    default_route: { model_id: 'claude-opus-5-5', effort: 'alto', tier: 'T3' },
    effort_applied: false,
};
const ON_RUN = {
    task_id: '9101-roteada', ticket_id: 9101, mode: 'ON', updated_at: '2026-11-06T12:00:00.000Z',
    snapshot: { attempt_id: 'x', sha256: 'c'.repeat(64), sha_short: 'cccccccc', integrity: 'ok', policy_ref: { id: 'routing-pri205', version: 'p1-2026-11-06', sha256: SHA, sha_short: '02923a43' } },
    policy_drift: { status: 'DIFFERENT', current_mode: 'ON', current: { id: 'routing-pri205', version: 'p2-2026-12-01', sha_short: 'ffffffff' } },
    selection_sources: { RULES: 1, FIXED_NODE: 1 }, decisions_total: 2, attempts_without_decision: 0,
    overrides: [{ ref: 'RO-1', scope: 'node', node: 'implement', subtask_key: null, value: { model_id: 'claude-opus-5-5', effort: 'alto' }, by: 'Richard', recorded_at: '2026-11-06T11:00:00.000Z', status: 'NOT_APPLIED' }],
    models: [
        { node: 'implement', attempt_id: 'a1', requested_model: 'claude-sonnet-5-5', requested_effort: 'UNAVAILABLE', routed: true, selection_source: 'RULES', observed_main: ['claude-sonnet-5-5'], observed_subagent: [], cost_usd: 0.5, unpriced_models: [], mismatch: false },
        { node: 'review', attempt_id: 'a2', requested_model: 'claude-opus-5-5', requested_effort: 'UNAVAILABLE', routed: true, selection_source: 'FIXED_NODE', observed_main: ['claude-sonnet-5-5'], observed_subagent: [], cost_usd: null, unpriced_models: ['claude-opus-5-5'], mismatch: true },
    ],
    not_started: [],
};
const BLOCKED_RUN = {
    ...ON_RUN, task_id: '9103-bloqueada', ticket_id: 9103, overrides: [], policy_drift: { status: 'SAME', current_mode: 'ON', current: null },
    not_started: [{ attempt_id: 'n1', node: 'implement', cause: 'CONFIG_UNVERIFIABLE', detail: 'PLUGIN_NOT_PROVEN_OFF', at: '2026-11-06T12:30:00.000Z', class: 'C2', would_model: 'claude-sonnet-5-5' }],
};
const OFF_RUN = { task_id: '9102-off', ticket_id: 9102, mode: 'OFF', snapshot: null, policy_drift: null, selection_sources: null, decisions_total: null, attempts_without_decision: null, overrides: [], models: [], not_started: null, updated_at: '2026-11-06T10:00:00.000Z' };
const UNKNOWN_RUN = { task_id: '9104-ruim', ticket_id: 9104, mode: 'UNKNOWN', error: 'STATE_UNREADABLE', updated_at: null };

function body(overrides = {}) {
    return {
        generated_at: '2026-11-06T13:00:00.000Z', reader: 'OK',
        config: { mode: 'ON', source: 'declared', invalid: null, policy: P1 },
        admission_blocked: null, runs_total: 4,
        runs: [BLOCKED_RUN, ON_RUN, OFF_RUN, UNKNOWN_RUN],
        mix: {
            totals: { attempts: 3, priced_attempts: 2, cost_usd: 2.5 },
            by_requested: [
                { model: 'claude-sonnet-5-5', attempts: 1, priced_attempts: 1, unpriced_attempts: 0, cost_usd: 0.5, share_attempts: 0.333333, share_cost: 0.2 },
                { model: 'claude-opus-5-5', attempts: 1, priced_attempts: 0, unpriced_attempts: 1, cost_usd: null, share_attempts: 0.333333, share_cost: null },
                { model: 'NOT_ROUTED', attempts: 1, priced_attempts: 1, unpriced_attempts: 0, cost_usd: 2, share_attempts: 0.333333, share_cost: 0.8 },
            ],
        },
        shadow_vs_real: { summary: { SAME: 1, REAL_HIGHER: 0, REAL_LOWER: 0, UNKNOWN: 0 }, rows: [] },
        ...overrides,
    };
}

// Resposta mínima do /api/would-route-metrics (contrato próprio, testado em would-route-metrics*.test.js).
const WOULD_ROUTE = {
    counts: { by_faixa: { leve: 1, medio: 0, opus: 1 }, no_decision: 0, decisions: 2, leaves_opus_tier: 1, attempts_with_would_route: 1 },
    savings_vs_opus_only: { opus_only_usd: 1, potential_usd: 0.6, potential_savings_usd: 0.4 },
    pricing_hypothesis: { description: 'Razões de preço de entrada.', cost_ratio_vs_opus: { T1: 0.2, T2: 0.6, T3: 1 }, source: 'model-pricing.json' },
    recent: [], note: '',
};

const SHADOW_ROWS = [
    { task_id: '9101-roteada', node: 'implement', attempt_id: 'a1', shadow: { status: 'SHADOW', policy_version: 's3-shadow-p1-0', class: 'C2', tier: 'T2', subtasks: 2 }, real: { class: 'C2', tier: 'T2', model_id: 'claude-sonnet-5-5' }, comparison: 'SAME', quality_effect: 'NOT_MEASURED' },
    { task_id: '9103-bloqueada', node: 'implement', attempt_id: 'a3', shadow: { status: 'SHADOW', policy_version: 's3-shadow-p1-0', class: 'C1', tier: 'T1', subtasks: 1 }, real: { class: 'C3', tier: 'T3', model_id: 'claude-opus-5-5' }, comparison: 'REAL_HIGHER', quality_effect: 'NOT_MEASURED' },
    { task_id: '9101-roteada', node: 'review', attempt_id: 'a2', shadow: 'UNAVAILABLE', real: { class: null, tier: 'T3', model_id: 'claude-opus-5-5' }, comparison: 'UNKNOWN', quality_effect: 'NOT_MEASURED' },
];

function boot(initial, { classifier = null } = {}) {
    let payload = initial;
    let hits = 0;
    const posts = [];
    const confirms = [];
    const server = http.createServer(async (req, res) => {
        // Seletor do classificador (contrato da sessão do Jev): fixture por teste; padrão 404.
        if (req.url.startsWith('/api/routing/classifier')) {
            const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (!classifier) { res.writeHead(404); res.end(); return; }
            if (req.method === 'GET') { const g = classifier.get(); send(g.status || 200, g.body); return; }
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            posts.push(body);
            const out = await classifier.post(body);
            if (out.destroy) { req.socket.destroy(); return; }
            send(out.status, out.body);
            return;
        }
        if (req.method === 'GET' && req.url.startsWith('/api/routing')) {
            hits += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
            return;
        }
        if (req.method === 'GET' && req.url.startsWith('/api/would-route-metrics')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(WOULD_ROUTE));
            return;
        }
        res.writeHead(404); res.end();
    });
    const elements = new Map();
    const dollar = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
    const location = { hash: '', pathname: '/' };
    const window = { addEventListener() {} };
    let base;
    const context = {
        window, location, prefs: {}, selected: null, runs: new Map(), NODES: [],
        visibleRuns: () => [], isHidden: () => false, needsYou: () => false,
        history: { replaceState(_s, _t, url) { location.hash = url.startsWith('#') ? url : ''; } },
        document: { head: element('head'), body: { dataset: {}, appendChild() {} }, activeElement: { dataset: {} }, createElement: tag => element(tag), createTextNode: t => ({ textContent: t, children: [] }) },
        $: dollar, persist() {}, requestAnimationFrame: cb => { setTimeout(cb, 0); }, setTimeout, clearTimeout, Date, URL, Intl,
        async api(url) {
            const res = await globalThis.fetch(new URL(url, base));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        fetch: (url, opts) => globalThis.fetch(new URL(url, base), opts),
        confirm(msg) { confirms.push(msg); return true; },
        localStorage: { getItem: () => null, setItem() {} },
    };
    return {
        set(next) { payload = next; },
        hits: () => hits,
        posts, confirms,
        async open() {
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            base = `http://127.0.0.1:${server.address().port}`;
            vm.createContext(context);
            vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'would-route-metrics.js'), 'utf8'), context, { filename: 'would-route-metrics.js' });
            vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'routing.js'), 'utf8'), context, { filename: 'routing.js' });
            vm.runInContext(fs.readFileSync(path.join(__dirname, 'public', 'views.js'), 'utf8'), context, { filename: 'views.js' });
        },
        tabsHtml: () => dollar('tabs').innerHTML,
        setView: name => window.Views.setView(name),
        text: () => flatText(dollar('view')),
        nodes: () => walk(dollar('view')),
        async close() { await new Promise(resolve => server.close(resolve)); },
    };
}

const loaded = ui => until(() => ui.text().includes('Configuração do projeto'));
const filter = (ui, key) => ui.nodes().find(n => n.dataset?.tfilter === `routing-${key}`);
const runCards = ui => ui.nodes().filter(n => String(n.className).split(' ').includes('rt-run'));

test('T5: item Roteamento de modelo em Operação; abre e carrega o /api/routing', async () => {
    const ui = boot(body());
    try {
        await ui.open();
        assert.match(ui.tabsHtml(), /data-view="roteamento"/);
        assert.match(ui.tabsHtml(), /Roteamento de modelo/);
        ui.setView('roteamento');
        await loaded(ui);
        assert.match(ui.tabsHtml(), /data-view="roteamento" aria-selected="true"/);
        assert.ok(ui.hits() >= 1);
    } finally { await ui.close(); }
});

test('T5: ON mostra policy p1, tabela C1–C5 e aviso de esforço não aplicado', async () => {
    const ui = boot(body());
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        const t = ui.text();
        assert.match(t, /routing-pri205@p1-2026-11-06/);
        assert.match(t, /02923a43/);
        assert.match(t, /APROVADA/);
        assert.match(t, /C1[\s\S]*T1[\s\S]*claude-sonnet-5-5/);
        assert.match(t, /C5[\s\S]*T3[\s\S]*claude-opus-5-5/);
        assert.match(t, /Padrão \(default_route\)[\s\S]*claude-opus-5-5/);
        assert.match(t, /Esforço declarado, não aplicado/);
        const region = ui.nodes().find(n => n.attributes?.role === 'region' && /classe/i.test(n.attributes['aria-label'] || ''));
        assert.ok(region, 'tabela da policy numa região rolável rotulada');
        assert.equal(region.attributes.tabindex, '0');
    } finally { await ui.close(); }
});

test('T5: OFF mostra "Roteamento desligado" e nenhum número de roteamento', async () => {
    const ui = boot(body({
        config: { mode: 'OFF', source: 'absent', invalid: null, policy: null },
        runs: [OFF_RUN], runs_total: 1,
        mix: { totals: { attempts: 0, priced_attempts: 0, cost_usd: null }, by_requested: [] },
    }));
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        const t = ui.text();
        assert.match(t, /Roteamento desligado/);
        assert.match(t, /sem \.claude\/model-routing\.json/);
        assert.doesNotMatch(t, /\b0 ?%/);
        assert.doesNotMatch(t, /US\$ 0,00/);
        assert.match(t, /Nenhum Attempt nesta janela/);
    } finally { await ui.close(); }
});

test('T5: INVALID e admissão recusada aparecem com causa, tickets e estado do aviso', async () => {
    const ui = boot(body({
        config: { mode: 'INVALID', source: null, invalid: { cause: 'POLICY_HASH_MISMATCH', detail: 'expected:bbb', transient: false }, policy: null },
        admission_blocked: { cause: 'POLICY_HASH_MISMATCH', detail: 'expected:bbb', transient: false, transient_count: 0, tickets: [9401, 9402], first_blocked_at: '2026-11-06T09:00:00.000Z', notice: { status: 'UNCERTAIN', at: '2026-11-06T09:02:00.000Z', attempts: 2, local_notified: true } },
        runs: [], runs_total: 0,
    }));
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        const t = ui.text();
        assert.match(t, /Configuração inválida/);
        assert.match(t, /POLICY_HASH_MISMATCH/);
        assert.match(t, /Admissão recusada/);
        assert.match(t, /9401[\s\S]*9402/);
        assert.match(t, /resultado incerto/i);
    } finally { await ui.close(); }
});

test('T5: leitor fora do ar: aviso e valores desconhecidos, nunca OFF', async () => {
    const ui = boot(body({ reader: 'FAILED', config: { mode: 'UNKNOWN', source: null, invalid: null, policy: null }, runs: [{ ...ON_RUN, mode: 'UNKNOWN', not_started: 'UNKNOWN', snapshot: { ...ON_RUN.snapshot, integrity: 'UNKNOWN', policy_ref: null } }] }));
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        const t = ui.text();
        assert.match(t, /leitor de roteamento não respondeu/i);
        assert.match(t, /Estado desconhecido/);
        assert.doesNotMatch(t, /Roteamento desligado/);
        assert.match(t, /recusas não verificadas/i);
    } finally { await ui.close(); }
});

test('T5: lista de Runs com filtros, drift, override, NOT_STARTED, pedido × observado e custo sem preço', async () => {
    const ui = boot(body());
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        assert.equal(runCards(ui).length, 4);
        const t = ui.text();
        assert.match(t, /usa p1-2026-11-06; vigente p2-2026-12-01/);
        assert.match(t, /RO-1[\s\S]*ainda não aplicada/);
        assert.match(t, /CONFIG_UNVERIFIABLE[\s\S]*PLUGIN_NOT_PROVEN_OFF/);
        assert.match(t, /pedido claude-opus-5-5[\s\S]*observado claude-sonnet-5-5[\s\S]*diferente do pedido/);
        assert.match(t, /sem preço/);
        assert.match(t, /STATE_UNREADABLE/);
        const open = ui.nodes().find(n => n.dataset?.open === '9101-roteada');
        assert.ok(open, 'link para abrir a Run');

        filter(ui, 'refused').click();
        await until(() => runCards(ui).length === 1);
        assert.match(ui.text(), /9103-bloqueada/);
        filter(ui, 'override').click();
        await until(() => runCards(ui).length === 1 && ui.text().includes('9101-roteada'));
        filter(ui, 'off').click();
        await until(() => runCards(ui).length === 1 && ui.text().includes('9102-off'));
        filter(ui, 'unknown').click();
        await until(() => runCards(ui).length === 1 && ui.text().includes('9104-ruim'));
        filter(ui, 'all').click();
        await until(() => runCards(ui).length === 4);
        assert.equal(filter(ui, 'all').attributes['aria-pressed'], 'true');
        assert.match(flatText(filter(ui, 'on')), /2/);
    } finally { await ui.close(); }
});

test('T5: mistura de modelos com completude e "não roteado"; custo ausente não vira 0', async () => {
    const ui = boot(body());
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        const t = ui.text();
        assert.match(t, /Mistura de modelos/);
        assert.match(t, /2 de 3 Attempts com preço/);
        assert.match(t, /não roteado/);
        assert.match(t, /claude-opus-5-5[\s\S]*sem preço/);
        assert.match(t, /80%/);
    } finally { await ui.close(); }
});

test('T5: Atualizar recarrega e mostra dado novo', async () => {
    const ui = boot(body());
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        const before = ui.hits();
        ui.set(body({ config: { mode: 'OFF', source: 'declared', invalid: null, policy: null }, runs: [], runs_total: 0 }));
        const btn = ui.nodes().find(n => n.tag === 'button' && /Atualizar/.test(n.textContent));
        btn.click();
        await until(() => ui.text().includes('Roteamento desligado'));
        assert.ok(ui.hits() > before);
    } finally { await ui.close(); }
});

// ── T6: aba Sombra × real (absorve "Medição de modelo") ────────────────────────
const tabBtn = (ui, key) => ui.nodes().find(n => n.dataset?.tfilter === `routing-tab-${key}`);

test('T6: nav sem item próprio de Medição de modelo; abas Hoje e Sombra × real', async () => {
    const ui = boot(body());
    try {
        await ui.open();
        assert.doesNotMatch(ui.tabsHtml(), /data-view="medicao-modelo"/);
        ui.setView('roteamento');
        await loaded(ui);
        assert.equal(tabBtn(ui, 'hoje').attributes['aria-selected'], 'true');
        assert.equal(tabBtn(ui, 'sombra').attributes['aria-selected'], 'false');
        assert.equal(tabBtn(ui, 'sombra').attributes.role, 'tab');
    } finally { await ui.close(); }
});

test('T6: aba Sombra × real: resumo, linhas com rótulo em texto e qualidade não medida', async () => {
    const ui = boot(body({ shadow_vs_real: { summary: { SAME: 1, REAL_HIGHER: 1, REAL_LOWER: 0, UNKNOWN: 1 }, rows: SHADOW_ROWS } }));
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        tabBtn(ui, 'sombra').click();
        await until(() => ui.text().includes('Sombra × real') && ui.text().includes('Efeito na qualidade'));
        assert.equal(tabBtn(ui, 'sombra').attributes['aria-selected'], 'true');
        const t = ui.text();
        assert.match(t, /1 igual/);
        assert.match(t, /1 real acima da sombra/);
        assert.match(t, /0 real abaixo da sombra/);
        assert.match(t, /1 sem comparação/);
        assert.match(t, /Efeito na qualidade: não medido/);
        assert.match(t, /sombra C1 · T1[\s\S]*real C3 · T3 · claude-opus-5-5[\s\S]*real acima da sombra/);
        assert.match(t, /sem sombra registrada/);
        assert.match(t, /s3-shadow-p1-0/);
        assert.doesNotMatch(t, /Hoje é configurado|Configuração do projeto/, 'a aba Hoje não é renderizada junto');
    } finally { await ui.close(); }
});

test('T6: a medição em sombra (S3) aparece embutida, com a economia rotulada como hipótese', async () => {
    const ui = boot(body());
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        tabBtn(ui, 'sombra').click();
        await until(() => ui.text().includes('Economia potencial'));
        const t = ui.text();
        assert.match(t, /Economia potencial vs Opus-only — hipótese de preço, não custo real/);
        assert.match(t, /Leve \(T1\)/);
    } finally { await ui.close(); }
});

test('T6: sem linhas de sombra: mensagem explícita, sem contagens inventadas', async () => {
    const ui = boot(body({ shadow_vs_real: { summary: { SAME: 0, REAL_HIGHER: 0, REAL_LOWER: 0, UNKNOWN: 0 }, rows: [] } }));
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        tabBtn(ui, 'sombra').click();
        await until(() => ui.text().includes('Nenhum Attempt com sombra'));
    } finally { await ui.close(); }
});

test('T6: atalho #medicao-modelo abre Roteamento na aba Sombra × real', async () => {
    const ui = boot(body({ shadow_vs_real: { summary: { SAME: 1, REAL_HIGHER: 1, REAL_LOWER: 0, UNKNOWN: 1 }, rows: SHADOW_ROWS } }));
    try {
        await ui.open();
        ui.setView('medicao-modelo');
        await until(() => ui.text().includes('Efeito na qualidade'));
        assert.match(ui.tabsHtml(), /data-view="roteamento" aria-selected="true"/);
        assert.equal(tabBtn(ui, 'sombra').attributes['aria-selected'], 'true');
    } finally { await ui.close(); }
});

// ── T7b: seletor do classificador (contrato GET/POST /api/routing/classifier) ──
function classifierState({ version = 0, choice = null, mode = null, source = 'POLICY', provider = 'cheap_rule', jevShadow = { allowed: false, refusal: 'CLASSIFIER_SCOPE_NOT_AUTHORIZED', detail: 'sem Authority Ref para o projeto' }, history = [] } = {}) {
    return {
        project: 'consumidor-sintetico', routing_mode: 'ON',
        current: { version, choice, provider, mode, source, by: source === 'SELECTION' ? 'richard' : null, at: source === 'SELECTION' ? '2026-11-06T14:00:00.000Z' : null, reason: source === 'SELECTION' ? 'teste' : null },
        options: [
            { choice: 'policy_only', allowed: true },
            { choice: 'policy_jev', modes: { shadow: jevShadow, active: { allowed: false, refusal: 'CLASSIFIER_NOT_CALIBRATED' } } },
        ],
        history,
    };
}
const clsNode = (ui, key) => ui.nodes().find(n => n.dataset?.clsOption === key);
const clsField = (ui, key) => ui.nodes().find(n => n.dataset?.clsField === key);
const clsSend = ui => ui.nodes().find(n => n.dataset?.clsAction === 'send');
function pick(ui, key) { const n = clsNode(ui, key); n.checked = true; for (const fn of n.listeners.change || []) fn({ target: n }); }
function type(ui, key, value) { const n = clsField(ui, key); n.value = value; for (const fn of n.listeners.input || []) fn({ target: n }); }
const clsLoaded = ui => until(() => ui.text().includes('Classificador (núcleo 2)') && !ui.text().includes('Carregando o classificador'));

test('T7b: estado atual da policy, aviso de Runs novas e opções recusadas com o motivo da API', async () => {
    const st = classifierState();
    const ui = boot(body(), { classifier: { get: () => ({ body: st }), post: async () => ({ status: 500, body: {} }) } });
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        await clsLoaded(ui);
        const t = ui.text();
        assert.match(t, /Atual: definido pela policy \(cheap_rule\)/);
        assert.match(t, /versão 0/);
        assert.match(t, /Vale só para Runs novas/);
        assert.equal(clsNode(ui, 'policy_only').disabled, false);
        assert.equal(clsNode(ui, 'policy_jev:shadow').disabled, true);
        assert.match(t, /CLASSIFIER_SCOPE_NOT_AUTHORIZED[\s\S]*sem Authority Ref/);
        assert.equal(clsNode(ui, 'policy_jev:active').disabled, true);
        assert.match(t, /CLASSIFIER_NOT_CALIBRATED/);
        assert.equal(clsSend(ui).disabled, true, 'sem escolha e sem motivo, nada a enviar');
    } finally { await ui.close(); }
});

test('T7b: endpoint ausente: seletor indisponível, sem inventar estado', async () => {
    const ui = boot(body());
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        await until(() => ui.text().includes('Seletor do classificador indisponível'));
        assert.doesNotMatch(ui.text(), /Atual: Só policy/);
        assert.equal(clsSend(ui), undefined);
    } finally { await ui.close(); }
});

test('T7b: troca: "enviado" até a resposta, "aplicado" só depois do 200, corpo no contrato', async () => {
    let st = classifierState({ jevShadow: { allowed: true, refusal: null, detail: null } });
    let release;
    const gate = new Promise(r => { release = r; });
    const ui = boot(body(), { classifier: {
        get: () => ({ body: st }),
        post: async b => {
            await gate;
            st = classifierState({ version: 1, choice: b.choice, mode: b.mode, source: 'SELECTION', provider: 'jev', jevShadow: { allowed: true, refusal: null, detail: null }, history: [{ version: 1, choice: b.choice, mode: b.mode, by: 'richard', at: '2026-11-06T15:00:00.000Z', reason: b.reason }] });
            return { status: 200, body: { ok: true, status: 'applied', current: st.current } };
        },
    } });
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        await clsLoaded(ui);
        pick(ui, 'policy_jev:shadow');
        type(ui, 'reason', 'medir o Jev em sombra');
        await until(() => clsSend(ui) && clsSend(ui).disabled === false);
        clsSend(ui).click();
        await until(() => /Enviado/.test(ui.text()));
        assert.doesNotMatch(ui.text(), /Aplicado/);
        assert.equal(ui.confirms.length, 1);
        assert.match(ui.confirms[0], /Policy \+ Jev \(sombra\)[\s\S]*Runs novas/);
        release();
        await until(() => /Aplicado/.test(ui.text()));
        assert.match(ui.text(), /Atual: Policy \+ Jev \(sombra\)/);
        assert.match(ui.text(), /versão 1/);
        const p = ui.posts[0];
        assert.deepEqual({ choice: p.choice, mode: p.mode, expected_version: p.expected_version, reason: p.reason }, { choice: 'policy_jev', mode: 'shadow', expected_version: 0, reason: 'medir o Jev em sombra' });
        assert.match(p.operation_id, /^[\w:.@-]{8,100}$/);
        assert.ok(!('approver' in p) && !('approver_password' in p), 'sem aprovador nem senha (decisão de 2026-11-06)');
        assert.equal(clsField(ui, 'password'), undefined, 'sem campo de senha');
    } finally { release(); await ui.close(); }
});

test('T7b: recusa do writer projetada com o código; nada de "aplicado"', async () => {
    const st = classifierState({ jevShadow: { allowed: true, refusal: null, detail: null } });
    const ui = boot(body(), { classifier: { get: () => ({ body: st }), post: async () => ({ status: 422, body: { ok: false, code: 'CLASSIFIER_LOCKED_BY_EXPERIMENT', error: 'unidade S6 ativa no escopo' } }) } });
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        await clsLoaded(ui);
        pick(ui, 'policy_jev:shadow');
        type(ui, 'reason', 'x');
        clsSend(ui).click();
        await until(() => /CLASSIFIER_LOCKED_BY_EXPERIMENT/.test(ui.text()));
        assert.match(ui.text(), /unidade S6 ativa no escopo/);
        assert.doesNotMatch(ui.text(), /Aplicado/);
    } finally { await ui.close(); }
});

test('T7b: resposta perdida: reenvio com o mesmo operation_id; o writer devolve already_processed', async () => {
    let st = classifierState();
    let n = 0;
    const ui = boot(body(), { classifier: {
        get: () => ({ body: st }),
        post: async b => {
            n += 1;
            st = classifierState({ version: 1, choice: b.choice, source: 'SELECTION', provider: 'off' });
            if (n === 1) return { destroy: true };
            return { status: 200, body: { ok: true, status: 'already_processed', current: st.current } };
        },
    } });
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        await clsLoaded(ui);
        pick(ui, 'policy_only');
        type(ui, 'reason', 'só a policy');
        clsSend(ui).click();
        await until(() => /Resultado incerto/.test(ui.text()));
        clsSend(ui).click();
        await until(() => /já estava registrada/i.test(ui.text()));
        assert.equal(ui.posts.length, 2);
        assert.equal(ui.posts[1].operation_id, ui.posts[0].operation_id);
        assert.equal(ui.posts[1].expected_version, ui.posts[0].expected_version, 'reenvio igual, sem trocar a versão esperada');
    } finally { await ui.close(); }
});

test('T7b: a opção que já é a atual não pode ser reenviada', async () => {
    const st = classifierState({ version: 2, choice: 'policy_only', source: 'SELECTION', provider: 'off' });
    const ui = boot(body(), { classifier: { get: () => ({ body: st }), post: async () => ({ status: 500, body: {} }) } });
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        await clsLoaded(ui);
        assert.match(ui.text(), /Atual: Só policy/);
        pick(ui, 'policy_only');
        type(ui, 'reason', 'de novo');
        assert.equal(clsSend(ui).disabled, true);
        assert.match(ui.text(), /já é a escolha atual/);
    } finally { await ui.close(); }
});

test('T7b: registro ilegível (source INVALID, version null): projeta o motivo, sem fingir estado', async () => {
    const st = { ...classifierState(), current: { version: null, choice: null, provider: 'off', mode: null, source: 'INVALID', by: null, at: null, reason: 'CLASSIFIER_SELECTION_INVALID' }, registry_git_ignored: true };
    const ui = boot(body(), { classifier: { get: () => ({ body: st }), post: async b => ({ status: 409, body: { ok: false, code: 'CLASSIFIER_SELECTION_INVALID', error: 'registro ilegível', echo: b.expected_version } }) } });
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        await clsLoaded(ui);
        const t = ui.text();
        assert.match(t, /Registro de seleção ilegível/);
        assert.match(t, /CLASSIFIER_SELECTION_INVALID/);
        assert.doesNotMatch(t, /Atual: Só policy|versão 0/);
        pick(ui, 'policy_only');
        type(ui, 'reason', 'corrigir');
        clsSend(ui).click();
        await until(() => /Recusado \(CLASSIFIER_SELECTION_INVALID\)/.test(ui.text()));
        assert.equal(ui.posts[0].expected_version, null, 'manda a versão como a API declarou; o writer decide');
    } finally { await ui.close(); }
});

test('T7b: registry_git_ignored false: aviso de que o registro pode entrar no git do consumidor', async () => {
    const st = { ...classifierState(), registry_git_ignored: false };
    const ui = boot(body(), { classifier: { get: () => ({ body: st }), post: async () => ({ status: 500, body: {} }) } });
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        await clsLoaded(ui);
        assert.match(ui.text(), /não está ignorado pelo git/);
        assert.match(ui.text(), /memory\/routing\/classifier-selection\.json/);
    } finally { await ui.close(); }
});

test('T7b: registry_git_ignored true ou ausente: sem aviso de git', async () => {
    for (const flag of [true, undefined]) {
        const st = { ...classifierState(), ...(flag === undefined ? {} : { registry_git_ignored: flag }) };
        const ui = boot(body(), { classifier: { get: () => ({ body: st }), post: async () => ({ status: 500, body: {} }) } });
        try {
            await ui.open();
            ui.setView('roteamento');
            await loaded(ui);
            await clsLoaded(ui);
            assert.doesNotMatch(ui.text(), /não está ignorado pelo git/);
        } finally { await ui.close(); }
    }
});

test('T7b (MAJOR-2): 5xx é incerto: mantém o operation_id; reenvio devolve already_processed', async () => {
    let st = classifierState();
    let n = 0;
    const ui = boot(body(), { classifier: {
        get: () => ({ body: st }),
        post: async b => {
            n += 1;
            st = classifierState({ version: 1, choice: b.choice, source: 'SELECTION', provider: 'off' });
            if (n === 1) return { status: 500, body: { error: 'falhou depois de gravar' } };
            return { status: 200, body: { ok: true, status: 'already_processed', current: st.current } };
        },
    } });
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        await clsLoaded(ui);
        pick(ui, 'policy_only');
        type(ui, 'reason', 'só a policy');
        clsSend(ui).click();
        await until(() => /Resultado incerto \(HTTP 500\)/.test(ui.text()));
        assert.doesNotMatch(ui.text(), /Recusado \(/, "5xx não vira recusa");
        clsSend(ui).click();
        await until(() => /já estava registrada/i.test(ui.text()));
        assert.equal(ui.posts[1].operation_id, ui.posts[0].operation_id);
    } finally { await ui.close(); }
});

test('revisão do Checkpoint B (MINOR-5): Run ON com recusas não verificadas não aparece como ✓', async () => {
    const ui = boot(body({ runs: [{ ...ON_RUN, overrides: [], not_started: 'UNKNOWN' }], runs_total: 1 }));
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        assert.match(ui.text(), /roteada, recusas desconhecidas/);
        assert.match(flatText(filter(ui, 'unknown')), /1/);
    } finally { await ui.close(); }
});

test('revisão do Checkpoint B (MINOR-6): sombra sem nenhuma decisão real não mostra contagens zeradas', async () => {
    const rows = [{ task_id: '9102-off', node: 'implement', attempt_id: 'x', shadow: { status: 'SHADOW', policy_version: 's3', class: 'C1', tier: 'T1', subtasks: 1 }, real: 'UNAVAILABLE', comparison: 'UNKNOWN', quality_effect: 'NOT_MEASURED' }];
    const ui = boot(body({ shadow_vs_real: { summary: { SAME: 0, REAL_HIGHER: 0, REAL_LOWER: 0, UNKNOWN: 1 }, rows } }));
    try {
        await ui.open();
        ui.setView('roteamento');
        await loaded(ui);
        tabBtn(ui, 'sombra').click();
        await until(() => ui.text().includes('Sem comparação: nenhuma decisão real'));
        assert.doesNotMatch(ui.text(), /0 igual|0 real acima/);
    } finally { await ui.close(); }
});
