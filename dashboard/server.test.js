// node --test server.test.js
// Servidor contra um repo sintético (memory/runs do checkout principal + worktrees),
// sem tocar nos runs reais.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const tmpBase = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpBase, 'dashboard-'));
const repo = path.join(tmp, 'app-back');
const mainRuns = path.join(repo, 'memory', 'runs');
const wtRuns = id => path.join(repo, '.claude', 'worktrees', id, 'memory', 'runs');

function seed(runsDir, taskId, state, context = '') {
    const dir = path.join(runsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ task_id: taskId, history: [], ...state }));
    if (context) fs.writeFileSync(path.join(dir, 'context.md'), context);
    return dir;
}

const t0 = '2026-09-01T00:00:00Z';
const t1 = '2026-09-20T00:00:00Z';
// Mesmo taskId em 3 lugares: vence a cópia do worktree do ticket, mesmo mais velha.
seed(mainRuns, '90001-ativo', { node: 'plan', status: 'in_progress', updated_at: t1 });
const ownDir = seed(wtRuns('90001'), '90001-ativo', {
    node: 'review', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement'], updated_at: t0,
}, Array.from({ length: 150 }, (_, i) => `linha ${i + 1}`).join('\n'));
seed(wtRuns('outro'), '90001-ativo', { node: 'commit', status: 'committed', updated_at: t1 });
// Sem worktree do ticket: vence a mais recente.
seed(mainRuns, 'avulso', { node: 'plan', status: 'planned', updated_at: t0 });
const avulsoNewer = seed(wtRuns('outro'), 'avulso', { node: 'implement', status: 'blocked', updated_at: t1 });
seed(mainRuns, '90002-segredo', { node: 'test', status: 'spec-invalid', updated_at: t1, api_token: 'nao-vaza' },
    'REDMINE_API_KEY=abcdef1234567890\nX-Redmine-API-Key: zzzsecretzzz\nvalor literal: super-secreto-env\n');
fs.mkdirSync(path.join(mainRuns, '_archive', '90003-velho'), { recursive: true });
fs.writeFileSync(path.join(mainRuns, 'watcher-state.json'), '{}');
// Root observado desde o start (coberto por dash.ready): o teste de arquivar espera
// o unlinkDir do chokidar, que só sai para pasta que ele já rastreava.
fs.mkdirSync(wtRuns('95002'), { recursive: true });

process.env.BITBUCKET_API_TOKEN = 'super-secreto-env';
const { createDashboard } = require('./server');
const dash = createDashboard({ memoryDir: mainRuns });
let base;

test.before(async () => {
    await new Promise(r => dash.server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${dash.server.address().port}`;
    await dash.ready;
});
test.after(() => dash.close());
// Cleanup não pode depender de uma assertion passar: o upstream/dash2 abertos
// por cenários anteriores mantinham a suíte viva após falhas de configuração.
test.after(async () => {
    if (dash2) await dash2.close();
    if (fakeUpstream.listening) await new Promise(r => fakeUpstream.close(r));
});

async function get(p, headers) {
    const res = await fetch(base + p, { headers });
    return { status: res.status, body: await res.json() };
}
async function eventually(fn, ms = 3000) {
    for (const end = Date.now() + ms; ;) {
        const v = await fn();
        if (v || Date.now() > end) return v;
        await new Promise(r => setTimeout(r, 50));
    }
}
async function post(p, body) {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
}

test('GET / serve o index.html', async () => {
    const res = await fetch(base + '/');
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /Enviar ao agente/);
});

test('GET /api/runs lista runs deduplicados, sem _archive nem arquivos soltos', async () => {
    const { body } = await get('/api/runs');
    const ids = body.map(r => r.taskId).sort();
    assert.deepStrictEqual(ids, ['90001-ativo', '90002-segredo', 'avulso']);
    const ativo = body.find(r => r.taskId === '90001-ativo');
    assert.strictEqual(ativo.location, 'worktree:90001');
    assert.strictEqual(ativo.copies, 3);
    assert.strictEqual(ativo.status, 'running');
    assert.deepStrictEqual(ativo.nodes, {
        fetch_ticket: 'done', plan: 'done', implement: 'done', review: 'running', test: 'pending', verify: 'pending', commit: 'pending',
    });
    const avulso = body.find(r => r.taskId === 'avulso');
    assert.strictEqual(avulso.location, 'worktree:outro');
    assert.strictEqual(avulso.status, 'needs_human_review');
    assert.strictEqual(avulso.nodes.implement, 'failed');
    assert.strictEqual(body.find(r => r.taskId === '90002-segredo').status, 'failed');
});

test('GET /api/runs/:taskId devolve state + context; /log devolve as últimas N linhas', async () => {
    const { body } = await get('/api/runs/90001-ativo');
    assert.strictEqual(body.state.node, 'review');
    assert.match(body.context, /^linha 1\n/);
    const log = await get('/api/runs/90001-ativo/log');
    const lines = log.body.log.split('\n');
    assert.strictEqual(lines.length, 100);
    assert.strictEqual(lines[0], 'linha 51');
    assert.strictEqual((await get('/api/runs/90001-ativo/log?lines=3')).body.log, 'linha 148\nlinha 149\nlinha 150');
    assert.strictEqual((await get('/api/runs/nao-existe')).status, 404);
});

test('credenciais não saem pela API', async () => {
    const { body } = await get('/api/runs/90002-segredo');
    const all = JSON.stringify(body);
    for (const secret of ['abcdef1234567890', 'zzzsecretzzz', 'super-secreto-env', 'nao-vaza']) {
        assert.ok(!all.includes(secret), `vazou ${secret}`);
    }
    assert.match(body.context, /REDMINE_API_KEY=\*\*\*/);
});

test('POST /message appenda human-input.md na cópia resolvida do run', async () => {
    assert.strictEqual((await post('/api/runs/90001-ativo/message', {})).status, 400);
    const r1 = await post('/api/runs/90001-ativo/message', { message: 'primeira' });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.body.location, 'worktree:90001');
    await post('/api/runs/90001-ativo/message', { message: 'segunda' });
    const content = fs.readFileSync(path.join(ownDir, 'human-input.md'), 'utf8');
    assert.match(content, /## Human input — .*\n\nprimeira\n[\s\S]*## Human input — .*\n\nsegunda\n/);
    assert.ok(!fs.existsSync(path.join(mainRuns, '90001-ativo', 'human-input.md')));
    assert.strictEqual((await get('/api/runs')).body.find(r => r.taskId === '90001-ativo').pendingHumanInput, true);
});

test('não sai de memory/runs: taskId com path traversal é rejeitado', async () => {
    for (const bad of ['..', '..%2F..%2Fsrc', '%2E%2E', '_archive', 'a%2Fb']) {
        const r = await post(`/api/runs/${bad}/message`, { message: 'x' });
        assert.ok([400, 404].includes(r.status), `${bad} => ${r.status}`);
    }
    assert.ok(!fs.existsSync(path.join(repo, 'memory', 'human-input.md')));
    assert.ok(!fs.existsSync(path.join(repo, 'human-input.md')));
});

test('Host/Origin não-locais são recusados (DNS rebinding / página de terceiros)', async () => {
    const status = headers => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: dash.server.address().port, path: '/api/runs', headers }, res => {
            res.resume(); resolve(res.statusCode);
        }).on('error', reject);
    });
    assert.strictEqual(await status({ Host: 'evil.example:3333' }), 403);
    assert.strictEqual(await status({ Host: 'localhost', Origin: 'https://evil.example' }), 403);
    const port = dash.server.address().port;
    assert.strictEqual(await status({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` }), 200, 'mesma origem passa');
    // Revisão do Checkpoint B (MAJOR-1): outra porta do localhost é outra origem.
    assert.strictEqual(await status({ Host: `localhost:${port}`, Origin: `http://localhost:${port === 5173 ? 5174 : 5173}` }), 403);
    assert.strictEqual(await status({ Host: 'localhost', Origin: `http://127.0.0.1:${port}` }), 200, 'localhost e 127.0.0.1 na mesma porta');
});

test('escrita com Sec-Fetch-Site cross-site/same-site é recusada; navegação GET por link continua', async () => {
    const port = dash.server.address().port;
    const req = (method, headers) => new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path: '/api/runs', method, headers: { Host: `localhost:${port}`, ...headers } }, res => { res.resume(); resolve(res.statusCode); });
        r.on('error', reject);
        r.end();
    });
    assert.strictEqual(await req('POST', { 'Sec-Fetch-Site': 'same-site' }), 403);
    assert.strictEqual(await req('POST', { 'Sec-Fetch-Site': 'cross-site' }), 403);
    assert.strictEqual(await req('GET', { 'Sec-Fetch-Site': 'cross-site' }), 200, 'abrir por link não é escrita');
});

test('WebSocket: mudança em state.json chega como state_update em ≤3s', async () => {
    const ws = new WebSocket(base.replace('http', 'ws'));
    const messages = [];
    ws.on('message', d => messages.push(JSON.parse(d)));
    await new Promise(r => ws.on('open', r));
    const waitFor = async pred => {
        for (let i = 0; i < 60; i++) {
            const m = messages.find(pred);
            if (m) return m;
            await new Promise(r => setTimeout(r, 50));
        }
        return null;
    };
    assert.ok(await waitFor(m => m.type === 'hello'));
    const started = Date.now();
    fs.writeFileSync(path.join(ownDir, 'state.json'), JSON.stringify({
        task_id: '90001-ativo', node: 'test', status: 'in_progress', history: ['fetch_ticket', 'plan', 'implement', 'review'], updated_at: t1,
    }));
    const upd = await waitFor(m => m.type === 'state_update' && m.taskId === '90001-ativo');
    assert.ok(upd, 'sem state_update');
    assert.ok(Date.now() - started <= 3000);
    assert.strictEqual(upd.state.node, 'test');
    assert.strictEqual(upd.run.nodes.review, 'done');

    // Cópia velha em outro worktree não gera evento pro run exibido.
    messages.length = 0;
    fs.writeFileSync(path.join(wtRuns('outro'), '90001-ativo', 'state.json'), JSON.stringify({ node: 'x', status: 'committed' }));
    await new Promise(r => setTimeout(r, 800));
    assert.ok(!messages.some(m => m.type === 'state_update' && m.taskId === '90001-ativo'));
    ws.close();
});

// ---------------------------------------------------------------------------------
// Fase 2: kind / pr_url / formatos de pull_request

const { extractPrs, deriveRunKind } = require('./server');

test('extractPrs entende todos os formatos reais e os da spec', () => {
    assert.deepStrictEqual(extractPrs({ 'app-front': { url: 'https://bitbucket.org/ws/app-front/pull-requests/6057', id: 6057 }, 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/7632' } }, 'app-back')
        .map(p => [p.repo, p.workspace, p.id]), [['app-back', 'ws', 7632], ['app-front', 'ws', 6057]]);
    assert.strictEqual(extractPrs({ 'app-back': 'https://bitbucket.org/ws/app-back/pull-requests/7649' })[0].id, 7649);
    assert.strictEqual(extractPrs({ 'app-core': { pr_url: 'https://bitbucket.org/ws/app-core/pull-requests/3846', pushed: true } })[0].id, 3846);
    const bb = extractPrs({ id: 12, title: 'x', links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/12' } } })[0];
    assert.deepStrictEqual([bb.repo, bb.id, bb.url], ['repo', 12, 'https://bitbucket.org/ws/repo/pull-requests/12']);
    assert.strictEqual(extractPrs({ url: 'https://example.com/pr', number: 5 })[0].id, 5);
    assert.strictEqual(extractPrs({ 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/1', state: 'merged' } })[0].state, 'MERGED');
    assert.deepStrictEqual(extractPrs({ 'app-back': { url: 'javascript:alert(1)' } }), [], 'só http(s)');
    assert.deepStrictEqual(extractPrs(null), []);
});

test('deriveRunKind: PR conclui, mas run bloqueado/andando com PR continua ativo', () => {
    const pr = { 'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/1' } };
    assert.strictEqual(deriveRunKind({ status: 'committed', pull_request: pr }), 'has_pr');
    assert.strictEqual(deriveRunKind({ status: 'committed' }), 'completed');
    assert.strictEqual(deriveRunKind({ status: 'blocked', pull_request: pr }), 'active');
    assert.strictEqual(deriveRunKind({ status: 'in_progress', pull_request: pr }), 'active');
    assert.strictEqual(deriveRunKind({ status: 'failed' }), 'failed');
    assert.strictEqual(deriveRunKind({ status: 'planned' }), 'active');
    assert.strictEqual(deriveRunKind({ status: 'spec-pending-approval', pull_request: pr }), 'active');
    assert.strictEqual(deriveRunKind(null), 'unknown');
});

// ---------------------------------------------------------------------------------
// Fases 3 e 4: proxies Redmine / Bitbucket com servidores falsos

const REDMINE_KEY = 'redmine-key-super-secreta';
const BB_TOKEN = 'bitbucket-token-super-secreto';
const upstreamCalls = [];
const fakeUpstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    upstreamCalls.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    // Comentário de aprovação da spec: Redmine responde 204 sem corpo; 93004 simula falha.
    if (req.method === 'PUT' && ['/issues/93003.json', '/issues/93005.json', '/issues/93009.json', '/issues/93051.json'].includes(req.url)) {
        if (req.headers['x-redmine-api-key'] !== REDMINE_KEY) return send(401, {});
        res.writeHead(204); return res.end();
    }
    if (req.method === 'PUT' && req.url === '/issues/93004.json') return send(500, { errors: [REDMINE_KEY] });
    if (req.url === '/issues/93001.json') {
        if (req.headers['x-redmine-api-key'] !== REDMINE_KEY) return send(401, {});
        return send(200, { issue: {
            id: 93001, subject: 'Monitor', status: { name: 'Em Desenvolvimento' }, assigned_to: { name: 'Dev' },
            tracker: { name: 'Melhoria' }, priority: { name: 'Normal' }, estimated_hours: 8, done_ratio: 40, updated_on: t1,
            api_key_echo: REDMINE_KEY,
        } });
    }
    if (req.url.startsWith('/bb/repositories/ws/app-back/pullrequests/7001')) {
        if (req.headers.authorization !== `Bearer ${BB_TOKEN}`) return send(401, {});
        return send(200, {
            id: 7001, title: 'Melhoria #93001', state: 'MERGED', author: { display_name: 'Autor' }, created_on: t0, updated_on: t1,
            links: { html: { href: 'https://bitbucket.org/ws/app-back/pull-requests/7001' } },
            source: { branch: { name: '93001' } }, destination: { branch: { name: 'development' } },
            reviewers: [{ display_name: 'Rev A' }, { display_name: 'Rev B' }],
            participants: [{ approved: true, user: { display_name: 'Rev A' } }, { approved: false, user: { display_name: 'Rev B' } }],
        });
    }
    send(404, {});
});
let upstreamBase, dash2, base2;
const logged = [];
const dashboardEnv = overrides => ({
    REDMINE_URL: upstreamBase + '/',
    REDMINE_API_KEY: REDMINE_KEY,
    BITBUCKET_API_TOKEN: BB_TOKEN,
    ...overrides,
});
async function startDash2(env = dashboardEnv()) {
    if (dash2) await dash2.close();
    dash2 = createDashboard({ env, memoryDir: mainRuns, bitbucketApi: `${upstreamBase}/bb` });
    await new Promise(r => dash2.server.listen(0, '127.0.0.1', r));
    base2 = `http://localhost:${dash2.server.address().port}`;
    await dash2.ready;
}

test('proxies: sobe servidor falso e dashboard apontando pra ele', async () => {
    await new Promise(r => fakeUpstream.listen(0, '127.0.0.1', r));
    upstreamBase = `http://127.0.0.1:${fakeUpstream.address().port}`;
    seed(wtRuns('93001'), '93001-monitor', {
        node: 'commit', status: 'committed', updated_at: t1, redmine_ticket: { id: 93001 }, affectedServices: ['backend/ms-pedidos'],
        pull_request: {
            'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/7001', id: 7001 },
            'app-front': { url: 'https://bitbucket.org/ws/app-front/pull-requests/404' },
        },
    });
    seed(mainRuns, 'sem-ticket', { node: 'plan', status: 'in_progress', updated_at: t1 });
    await startDash2();
    for (const k of ['log', 'error', 'warn']) {
        const orig = console[k];
        console[k] = (...a) => { logged.push(a.join(' ')); orig.apply(console, a); };
    }
});

async function get2(p) {
    const res = await fetch(base2 + p);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
}

test('GET /api/runs traz kind e pr_url', async () => {
    const { body } = await get2('/api/runs');
    const r = body.find(x => x.taskId === '93001-monitor');
    assert.strictEqual(r.kind, 'has_pr');
    assert.strictEqual(r.pr_url, 'https://bitbucket.org/ws/app-back/pull-requests/7001');
    assert.strictEqual(body.find(x => x.taskId === 'sem-ticket').kind, 'active');
});

test('GET /api/runs traz affectedServices (null quando o watcher ainda não calculou)', async () => {
    const { body } = await get2('/api/runs');
    assert.deepStrictEqual(body.find(x => x.taskId === '93001-monitor').affectedServices, ['backend/ms-pedidos']);
    assert.strictEqual(body.find(x => x.taskId === 'sem-ticket').affectedServices, null);
});

test('GET /ticket: proxy do Redmine só com os campos pedidos, sem a key', async () => {
    const r = await get2('/api/runs/93001-monitor/ticket');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, {
        id: 93001, subject: 'Monitor', status: 'Em Desenvolvimento', assigned_to: 'Dev', tracker: 'Melhoria', priority: 'Normal',
        estimated_hours: 8, done_ratio: 40, updated_on: t1, url: `${upstreamBase}/issues/93001`,
    });
    assert.ok(!r.text.includes(REDMINE_KEY));
    assert.strictEqual((await get2('/api/runs/sem-ticket/ticket')).status, 404);
    seed(mainRuns, '93999-sumido', { node: 'plan', status: 'in_progress' });
    const missing = await get2('/api/runs/93999-sumido/ticket');
    assert.strictEqual(missing.status, 404);
    assert.match(missing.body.error, /não encontrado/);
});

test('GET /pr: status real de cada PR, token só no header Bearer', async () => {
    const r = await get2('/api/runs/93001-monitor/pr');
    assert.strictEqual(r.status, 200);
    const [back, front] = r.body.prs;
    assert.strictEqual(back.repo, 'app-back');
    assert.strictEqual(back.state, 'MERGED');
    assert.strictEqual(back.title, 'Melhoria #93001');
    assert.deepStrictEqual(back.participants, ['Rev A']);
    assert.deepStrictEqual(back.reviewers, ['Rev A', 'Rev B']);
    assert.strictEqual(front.repo, 'app-front');
    assert.match(front.error, /não encontrado/);
    assert.ok(!r.text.includes(BB_TOKEN));
    const bbCalls = upstreamCalls.filter(c => c.url.startsWith('/bb/'));
    assert.ok(bbCalls.length >= 2);
    assert.ok(bbCalls.every(c => !c.url.includes(BB_TOKEN)), 'token nunca na URL');
    assert.strictEqual((await get2('/api/runs/sem-ticket/pr')).status, 404);
});

test('GET /pr: PR Matrix — todos os repos, status/last_checked_at do polling do watcher; fully_merged conta como concluído', async () => {
    const checked = '2026-09-22T13:00:00.000Z';
    seed(wtRuns('93002'), '93002-matrix', {
        node: 'commit', status: 'fully_merged', updated_at: t1,
        pull_request: {
            'app-back': { url: 'https://bitbucket.org/ws/app-back/pull-requests/7001', pr_id: 7001, status: 'MERGED', last_checked_at: checked },
            'app-front': { url: 'https://bitbucket.org/ws/app-front/pull-requests/404', status: 'DECLINED', last_checked_at: checked },
            'app-core': { branch: '93002', pushed: true, pr_url: null },
        },
    });
    const r = await get2('/api/runs/93002-matrix/pr');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.prs.map(p => p.repo), ['app-back', 'app-front', 'app-core']);
    const [back, front, core] = r.body.prs;
    assert.strictEqual(back.state, 'MERGED');
    assert.strictEqual(back.status, 'MERGED');
    assert.strictEqual(back.last_checked_at, checked);
    assert.strictEqual(front.status, 'DECLINED', 'status persistido volta mesmo quando o Bitbucket falha');
    assert.match(front.error, /não encontrado/);
    assert.strictEqual(core.id, null);
    assert.match(core.error, /sem URL\/ID/);

    const run = (await get2('/api/runs')).body.find(x => x.taskId === '93002-matrix');
    assert.strictEqual(run.status, 'committed');
    assert.strictEqual(run.kind, 'has_pr');
});

// ---------------------------------------------------------------------------------
// Spec auto-reparada esperando aprovação humana (status spec-pending-approval)

const pendingApproval = draft_path => ({
    comment_id: 555, draft_path, posted_at: t1, reminder_sent: false, missing_sections: ['solucao'], keyword: 'aprovado',
});

test('spec-pending-approval: status awaiting_approval (não failed), kind active, nó atual esperando', async () => {
    fs.mkdirSync(path.join(repo, 'memory', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'memory', 'spec', '93003-spec.draft.md'),
        '<!-- draft gerado por IA -->\n## Solução\nUsar a fila existente.\nREDMINE_API_KEY=abc123segredo\n');
    seed(wtRuns('93003'), '93003-aprovar', {
        node: 'plan', status: 'spec-pending-approval', history: ['fetch_ticket'], updated_at: t1,
        spec_pending_approval: pendingApproval('memory/spec/93003-spec.draft.md'),
    });
    const r = await eventually(async () => (await get2('/api/runs')).body.find(x => x.taskId === '93003-aprovar'));
    assert.strictEqual(r.status, 'awaiting_approval');
    assert.strictEqual(r.kind, 'active');
    assert.strictEqual(r.nodes.fetch_ticket, 'done');
    assert.strictEqual(r.nodes.plan, 'pending');
});

test('GET /spec-draft: conteúdo redigido + metadados; 409 fora do status; traversal => 400; sem arquivo => 404', async () => {
    const r = await get2('/api/runs/93003-aprovar/spec-draft');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.draft_path, 'memory/spec/93003-spec.draft.md');
    assert.match(r.body.content, /## Solução/);
    assert.ok(!r.text.includes('abc123segredo'), 'draft passa por redact()');
    assert.deepStrictEqual(r.body.missing_sections, ['solucao']);
    assert.strictEqual(r.body.comment_id, 555);
    assert.strictEqual(r.body.reminder_sent, false);
    assert.strictEqual(r.body.keyword, 'aprovado');
    assert.strictEqual(r.body.posted_at, t1);

    assert.strictEqual((await get2('/api/runs/93001-monitor/spec-draft')).status, 409);
    for (const [i, bad] of ['../../etc/passwd.draft.md', 'memory/spec/../../x.draft.md', '/etc/x.draft.md', 'memory/spec/93003-spec.md', 'memory/runs/x.draft.md'].entries()) {
        seed(mainRuns, `9310${i}-trav`, { node: 'plan', status: 'spec-pending-approval', spec_pending_approval: pendingApproval(bad) });
        assert.strictEqual((await get2(`/api/runs/9310${i}-trav/spec-draft`)).status, 400, bad);
    }
    seed(mainRuns, '93110-semdraft', { node: 'plan', status: 'spec-pending-approval', spec_pending_approval: pendingApproval('memory/spec/nao-existe.draft.md') });
    assert.strictEqual((await get2('/api/runs/93110-semdraft/spec-draft')).status, 404);
});

async function post2(p, body) {
    const res = await fetch(base2 + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
}

test('POST /api/redmine/comment: SPEC_CHANGE pendente aceita aprovar/rejeitar só depois de publicada; reject fora dela é 409', async () => {
    const pending = { id: 'SC-001', type: 'SPEC_CHANGE', ac_affected: ['AC-02'], previous_behavior: 'a', proposed_behavior: 'b', rationale: 'c', agent: 'implement', timestamp: t1 };
    seed(mainRuns, '93051-spec-change', { node: 'implement', status: 'spec-change-pending-approval', updated_at: t1, spec_change_pending: { ...pending, posted_at: t1, comment_id: 7 } });
    const before = upstreamCalls.length;
    const ok = await post2('/api/redmine/comment', { taskId: '93051-spec-change', action: 'reject' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual(ok.body, { ok: true, ticketId: 93051, action: 'reject' });
    const notes = JSON.parse(upstreamCalls.slice(before).find(c => c.method === 'PUT').body).issue.notes;
    assert.match(notes, /^rejeitado\n\n\(rejeitado pelo dashboard local — decisão humana sobre a SC-001/);
    const approve = await post2('/api/redmine/comment', { taskId: '93051-spec-change' });
    assert.strictEqual(approve.status, 200);
    assert.match(JSON.parse(upstreamCalls[upstreamCalls.length - 1].body).issue.notes, /^aprovado\n/);

    // Antes do watcher publicar a proposta: resposta não contaria — 409.
    seed(mainRuns, '93052-spec-change', { node: 'implement', status: 'spec-change-pending-approval', updated_at: t1, spec_change_pending: pending });
    assert.strictEqual((await post2('/api/redmine/comment', { taskId: '93052-spec-change' })).status, 409);
    // Rejeição só existe para SPEC_CHANGE.
    assert.strictEqual((await post2('/api/redmine/comment', { taskId: '93003-aprovar', action: 'reject' })).status, 409);
});

test('POST /api/redmine/comment: posta só a palavra-chave, key só no header; 404/409/502', async () => {
    const before = upstreamCalls.length;
    const r = await post2('/api/redmine/comment', { taskId: '93003-aprovar', notes: 'texto livre ignorado' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, ticketId: 93003, action: 'approve' });
    const call = upstreamCalls.slice(before).find(c => c.method === 'PUT');
    assert.strictEqual(call.url, '/issues/93003.json');
    assert.strictEqual(call.headers['x-redmine-api-key'], REDMINE_KEY);
    assert.match(call.headers['content-type'], /application\/json/);
    const notes = JSON.parse(call.body).issue.notes;
    assert.match(notes, /^aprovado\n\n/);
    assert.ok(!notes.includes('texto livre'), 'não aceita notes do cliente');
    assert.ok(!call.url.includes(REDMINE_KEY) && !r.text.includes(REDMINE_KEY));

    // Palavra-chave do .env vale.
    await startDash2(dashboardEnv({ SPEC_APPROVAL_KEYWORD: 'OK-SPEC' }));
    try {
        await post2('/api/redmine/comment', { taskId: '93003-aprovar' });
        assert.match(JSON.parse(upstreamCalls[upstreamCalls.length - 1].body).issue.notes, /^OK-SPEC\n/);
    } finally { await startDash2(); }

    assert.strictEqual((await post2('/api/redmine/comment', {})).status, 404);
    assert.strictEqual((await post2('/api/redmine/comment', { taskId: 'nao-existe' })).status, 404);
    assert.strictEqual((await post2('/api/redmine/comment', { taskId: '93001-monitor' })).status, 409);
    seed(mainRuns, 'sem-ticket-aprov', { node: 'plan', status: 'spec-pending-approval', updated_at: t1 });
    assert.strictEqual((await post2('/api/redmine/comment', { taskId: 'sem-ticket-aprov' })).status, 404);

    seed(mainRuns, '93004-falha', { node: 'plan', status: 'spec-pending-approval', updated_at: t1 });
    const fail = await post2('/api/redmine/comment', { taskId: '93004-falha' });
    assert.strictEqual(fail.status, 502);
    assert.match(fail.body.error, /^Redmine: HTTP 500/);
    assert.ok(!fail.text.includes(REDMINE_KEY));

    await startDash2(dashboardEnv({ REDMINE_API_KEY: undefined }));
    try {
        const nc = await post2('/api/redmine/comment', { taskId: '93003-aprovar' });
        assert.strictEqual(nc.status, 503);
        assert.deepStrictEqual(nc.body, { error: 'Redmine not configured' });
    } finally { await startDash2(); }

    // Filtro de localhost cobre o endpoint (Host não-local => 403).
    const { port } = dash2.server.address();
    const remote = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/redmine/comment', method: 'POST',
            headers: { host: 'evil.example.com', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end(JSON.stringify({ taskId: '93003-aprovar' }));
    });
    assert.strictEqual(remote, 403);
});

test('pré-task: gate file com draft pendente vira run sintético só leitura; some quando há run real', async () => {
    const draftRel = 'memory/spec/93005-spec.draft.md';
    fs.writeFileSync(path.join(repo, draftRel), '## Solução\nSugestão da IA.\n');
    const gate = (status, extra = {}) => JSON.stringify({ ticket_id: 0, subject: 'Ticket pré-task', status, checked_at: t1, ...extra });
    fs.writeFileSync(path.join(mainRuns, '93005-spec-gate.json'), gate('spec-pending-approval', { spec_pending_approval: pendingApproval(draftRel) }));
    // Ticket que já tem run de verdade: a pendência vive no state.json dele, não duplica.
    fs.writeFileSync(path.join(mainRuns, '93003-spec-gate.json'), gate('spec-pending-approval', { spec_pending_approval: pendingApproval('memory/spec/93003-spec.draft.md') }));
    // Gate sem pendência (aceito/válido) não aparece.
    fs.writeFileSync(path.join(mainRuns, '93006-spec-gate.json'), gate('accepted'));

    const list = (await get2('/api/runs')).body;
    const r = list.find(x => x.taskId === '93005-spec-gate');
    assert.ok(r, 'run pré-task listado');
    assert.strictEqual(r.pretask, true);
    assert.strictEqual(r.status, 'awaiting_approval');
    assert.strictEqual(r.kind, 'active');
    assert.deepStrictEqual(r.ticket, { id: 93005, subject: 'Ticket pré-task' });
    assert.ok(!list.some(x => x.taskId === '93003-spec-gate'));
    assert.ok(!list.some(x => x.taskId === '93006-spec-gate'));

    const detail = await get2('/api/runs/93005-spec-gate');
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.context, '');
    const draft = await get2('/api/runs/93005-spec-gate/spec-draft');
    assert.strictEqual(draft.status, 200);
    assert.match(draft.body.content, /Sugestão da IA/);

    const before = upstreamCalls.length;
    const ok = await post2('/api/redmine/comment', { taskId: '93005-spec-gate' });
    assert.deepStrictEqual(ok.body, { ok: true, ticketId: 93005, action: 'approve' });
    assert.strictEqual(upstreamCalls.slice(before).find(c => c.method === 'PUT').url, '/issues/93005.json');

    assert.strictEqual((await post2('/api/runs/93005-spec-gate/message', { message: 'oi' })).status, 409);
    assert.strictEqual((await post2('/api/runs/93005-spec-gate/archive', { force: true })).status, 409);
    assert.ok(!fs.existsSync(path.join(mainRuns, '93005-spec-gate')), 'nada criado em disco');

    seed(wtRuns('93005'), '93005-comecou', { node: 'plan', status: 'in_progress', history: ['fetch_ticket'], updated_at: t1 });
    await eventually(async () => !(await get2('/api/runs')).body.some(x => x.taskId === '93005-spec-gate'));
    assert.strictEqual((await get2('/api/runs/93005-spec-gate')).status, 404);
});

test('PRI-233 T9: admissão recusada por roteamento ON inválido aparece como pré-task bloqueada, só leitura', async () => {
    const marker = path.join(mainRuns, 'routing-admission-blocked.json');
    fs.writeFileSync(marker, JSON.stringify({
        signature: 'POLICY_HASH_MISMATCH|expected:ff', cause: 'POLICY_HASH_MISMATCH', detail: 'expected:ff',
        transient: false, transient_count: 0, tickets: [93210, 93003], first_blocked_at: t1, notified_at: t1,
    }));
    try {
        const list = (await get2('/api/runs')).body;
        const r = list.find(x => x.taskId === '93210-spec-gate');
        assert.ok(r, 'ticket barrado listado');
        assert.deepStrictEqual([r.pretask, r.status, r.node], [true, 'needs_human_review', 'fetch_ticket']);
        assert.deepStrictEqual(r.routingBlocked, {
            scope: 'admission', cause: 'POLICY_HASH_MISMATCH', detail: 'expected:ff', transient: false,
            firstBlockedAt: t1, notifiedAt: t1, configFile: '.claude/model-routing.json',
        });
        // Ticket com run de verdade não ganha a pré-task duplicada.
        assert.ok(!list.some(x => x.taskId === '93003-spec-gate'));
        assert.strictEqual((await post2('/api/runs/93210-spec-gate/message', { message: 'oi' })).status, 409);
        assert.ok(!fs.existsSync(path.join(mainRuns, '93210-spec-gate')), 'nada criado em disco');
        // Marcador malformado não derruba a listagem nem inventa run.
        fs.writeFileSync(marker, '{ x');
        assert.ok(!(await get2('/api/runs')).body.some(x => x.taskId === '93210-spec-gate'));
    } finally {
        fs.rmSync(marker, { force: true });
    }
    // Sem marcador (config corrigida), a pré-task some.
    assert.ok(!(await get2('/api/runs')).body.some(x => x.taskId === '93210-spec-gate'));
    // Runs normais não ganham o campo.
    assert.ok((await get2('/api/runs')).body.every(x => x.routingBlocked === null));
});

test('pré-task: spec rascunho (draft: true) do watcher aparece aguardando revisão, com "Ver spec"', async () => {
    fs.mkdirSync(path.join(repo, 'memory/spec'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'memory/spec/93009-spec.md'), '---\nticket: 93009\ndraft: true\n---\n# Ticket #93009 — Frete zerado\n\n## Problema\nFrete some.\n');
    fs.writeFileSync(path.join(mainRuns, '93009-spec-gate.json'), JSON.stringify({
        ticket_id: 93009, subject: 'Frete zerado', status: 'spec-draft',
        spec_draft: { spec_path: 'memory/spec/93009-spec.md', since: t1 }, checked_at: t1,
    }));

    const r = (await get2('/api/runs')).body.find(x => x.taskId === '93009-spec-gate');
    assert.ok(r, 'run pré-task listado');
    assert.strictEqual(r.pretask, true);
    assert.strictEqual(r.status, 'awaiting_approval');
    assert.strictEqual(r.kind, 'active');
    assert.deepStrictEqual(r.ticket, { id: 93009, subject: 'Frete zerado' });

    const spec = await get2('/api/runs/93009-spec-gate/spec-draft');
    assert.strictEqual(spec.status, 200);
    assert.strictEqual(spec.body.kind, 'spec-draft');
    assert.strictEqual(spec.body.draft_path, 'memory/spec/93009-spec.md');
    assert.match(spec.body.content, /## Problema\nFrete some\./);

    // "Aprovar spec": posta a palavra-chave; o watcher troca para draft: false.
    const before = upstreamCalls.length;
    const ok = await post2('/api/redmine/comment', { taskId: '93009-spec-gate' });
    assert.deepStrictEqual(ok.body, { ok: true, ticketId: 93009, action: 'approve' });
    assert.strictEqual(upstreamCalls.slice(before).find(c => c.method === 'PUT').url, '/issues/93009.json');
});

test('pré-task: /fetch-ticket despachado sem state.json aparece rodando; some com o run real ou vencido o timeout', async () => {
    const now = new Date().toISOString();
    const dispatch = (started_at, timeout_ms = 3600000) => JSON.stringify({ ticket_id: 93007, subject: 'Recém-despachado', status: 'valid', fetch_dispatch: { started_at, timeout_ms } });
    fs.writeFileSync(path.join(mainRuns, '93007-spec-gate.json'), dispatch(now));
    fs.writeFileSync(path.join(mainRuns, '93008-spec-gate.json'), dispatch(new Date(Date.now() - 7200000).toISOString()));

    const list = (await get2('/api/runs')).body;
    const r = list.find(x => x.taskId === '93007-spec-gate');
    assert.ok(r, 'ticket despachado listado antes de existir state.json');
    assert.strictEqual(r.pretask, true);
    assert.strictEqual(r.status, 'running');
    assert.strictEqual(r.node, 'fetch_ticket');
    assert.strictEqual(r.nodes.fetch_ticket, 'running');
    assert.deepStrictEqual(r.ticket, { id: 93007, subject: 'Recém-despachado' });
    assert.strictEqual(r.state.node_started_at, now, 'relógio do fetch_ticket conta desde o despacho');
    assert.strictEqual(r.state.node_timeout_ms, 3600000);
    assert.ok(!list.some(x => x.taskId === '93008-spec-gate'), 'marcador vencido não aparece');
    assert.strictEqual((await post2('/api/runs/93007-spec-gate/message', { message: 'oi' })).status, 409);

    const created = new Date(Date.parse(now) + 60000).toISOString();
    seed(wtRuns('93007'), '93007-criado', { node: 'plan', status: 'in_progress', history: ['fetch_ticket'], started_at: created, updated_at: created });
    await eventually(async () => !(await get2('/api/runs')).body.some(x => x.taskId === '93007-spec-gate'));
    const real = (await get2('/api/runs')).body.find(x => x.taskId === '93007-criado');
    assert.ok(real);
    // Plan do mesmo despacho: relógio desde a criação da task, prazo final = o do despacho.
    assert.strictEqual(real.state.status, 'running');
    assert.strictEqual(real.state.node_started_at, created);
    assert.strictEqual(real.state.node_timeout_ms, 3600000 - 60000);
    // Agente saiu (marcador removido): volta ao state.json cru.
    fs.writeFileSync(path.join(mainRuns, '93007-spec-gate.json'), JSON.stringify({ ticket_id: 93007, status: 'valid' }));
    await eventually(async () => !(await get2('/api/runs')).body.find(x => x.taskId === '93007-criado').state.node_started_at);
});

test('não configurado => 503 com mensagem curta, sem stack', async () => {
    await startDash2(dashboardEnv({ REDMINE_API_KEY: undefined, BITBUCKET_API_TOKEN: undefined }));
    try {
        const t = await get2('/api/runs/93001-monitor/ticket');
        assert.strictEqual(t.status, 503);
        assert.deepStrictEqual(t.body, { error: 'Redmine not configured' });
        const p = await get2('/api/runs/93001-monitor/pr');
        assert.strictEqual(p.status, 503);
        assert.deepStrictEqual(p.body, { error: 'Bitbucket not configured' });
    } finally { await startDash2(); }
});

test('upstream fora do ar => 502 amigável, e nada de credencial em log', async () => {
    await startDash2(dashboardEnv({ REDMINE_URL: 'http://127.0.0.1:1' }));
    try {
        const r = await get2('/api/runs/93001-monitor/ticket');
        assert.strictEqual(r.status, 502);
        assert.ok(!/at .*\.js:\d+/.test(r.text), 'sem stack trace');
    } finally { await startDash2(); }
    const all = logged.join('\n');
    assert.ok(!all.includes(BB_TOKEN) && !all.includes(REDMINE_KEY));
    const html = await (await fetch(base2 + '/')).text();
    assert.ok(!html.includes(BB_TOKEN) && !html.includes(REDMINE_KEY));
});

test('task-id com data no começo não vira número de ticket', async () => {
    seed(mainRuns, '2026-09-19-algo', { node: 'plan', status: 'in_progress' });
    const res = await fetch(base + '/api/runs/2026-09-19-algo/ticket');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'no ticket_id in state' });
});

test('risk_level/risk_reason do /verify chegam intactos na lista e no detalhe (badge HIGH-RISK)', async () => {
    const reason = 'Motor de frete legado: track/calculofrete/GrupoDTO.java';
    seed(mainRuns, '90004-risco', { node: 'commit', status: 'in_progress', risk_level: 'high', risk_reason: reason });
    seed(mainRuns, '90005-sem-risco', { node: 'commit', status: 'in_progress' });
    // Lista vem do cache mantido pelo chokidar (addDir): run recém-criado aparece em ms, não na hora.
    const body = await eventually(async () => {
        const list = (await get('/api/runs')).body;
        return list.some(r => r.taskId === '90005-sem-risco') && list;
    });
    const risco = body.find(r => r.taskId === '90004-risco');
    assert.strictEqual(risco.state.risk_level, 'high');
    assert.strictEqual(risco.state.risk_reason, reason);
    assert.strictEqual(body.find(r => r.taskId === '90005-sem-risco').state.risk_level, undefined);
    assert.strictEqual((await get('/api/runs/90004-risco')).body.state.risk_reason, reason);
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /state\?\.risk_level === 'high'/);
    assert.match(html, /Motivo do risco/);
});

// ---------------------------------------------------------------------------------
// /api/status, screenshots, falha de escrita, addDir filtrado

function rawGet(p, headers = {}) {
    const { port } = dash.server.address();
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p, headers: { host: `localhost:${port}`, ...headers } }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

test('GET /api/status: uptime, clientes WS, última mudança, runs — acessível mesmo com Host não-local', async () => {
    const { status, body } = await get('/api/status');
    assert.strictEqual(status, 200);
    assert.ok(Number.isInteger(body.uptime_ms) && body.uptime_ms >= 0);
    assert.ok(Number.isInteger(body.ws_clients));
    assert.ok(body.last_file_change === null || !Number.isNaN(Date.parse(body.last_file_change)));
    assert.ok(body.runs_tracked >= 3);
    assert.deepStrictEqual(Object.keys(body).sort(), ['last_file_change', 'runs_tracked', 'uptime_ms', 'ws_clients']);
    const remote = await rawGet('/api/status', { host: 'evil.example.com' });
    assert.strictEqual(remote.status, 200);
    // O resto da API continua só localhost.
    assert.strictEqual((await rawGet('/api/runs', { host: 'evil.example.com' })).status, 403);
});

test('screenshots: lista vazia sem diretório; só imagens regulares; serve com Content-Type; path traversal => 400', async () => {
    assert.deepStrictEqual((await get('/api/runs/TASK-123/screenshots')).body, { screenshots: [] });
    assert.deepStrictEqual((await get('/api/runs/avulso/screenshots')).body, { screenshots: [] });

    const shots = path.join(ownDir, 'screenshots');
    fs.mkdirSync(shots, { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    fs.writeFileSync(path.join(shots, 'tela-1.png'), png);
    fs.writeFileSync(path.join(shots, 'notas.txt'), 'x');
    fs.symlinkSync('/etc/hosts', path.join(shots, 'link.png'));

    const list = await get('/api/runs/90001-ativo/screenshots');
    assert.deepStrictEqual(list.body.screenshots.map(s => s.filename), ['tela-1.png']);
    assert.strictEqual(list.body.screenshots[0].size, png.length);

    const img = await rawGet('/api/runs/90001-ativo/screenshots/tela-1.png');
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.type, 'image/png');
    assert.ok(img.body.equals(png));

    assert.strictEqual((await rawGet('/api/runs/90001-ativo/screenshots/nao-existe.png')).status, 404);
    assert.strictEqual((await rawGet('/api/runs/90001-ativo/screenshots/link.png')).status, 404, 'symlink não é servido');
    assert.strictEqual((await rawGet('/api/runs/90001-ativo/screenshots/notas.txt')).status, 400);
    assert.strictEqual((await rawGet('/api/runs/90001-ativo/screenshots/..%2F..%2F..%2Fetc%2Fpasswd')).status, 400);
    assert.strictEqual((await rawGet('/api/runs/90001-ativo/screenshots/../../etc/passwd')).status, 400);
    assert.strictEqual((await rawGet('/api/runs/..%2F..%2Fetc/screenshots/a.png')).status, 400);
});

test('POST /message: falha ao gravar => 500 JSON, servidor continua de pé', async () => {
    const dir = seed(mainRuns, '90006-ro', { node: 'plan', status: 'in_progress' });
    fs.mkdirSync(path.join(dir, 'human-input.md')); // appendFileSync => EISDIR
    const r = await post('/api/runs/90006-ro/message', { message: 'oi' });
    assert.strictEqual(r.status, 500);
    assert.deepStrictEqual(r.body, { ok: false, error: 'Falha ao gravar mensagem' });
    assert.strictEqual((await get('/api/status')).status, 200);
});

test('addDir: subdiretório de um run (screenshots/) não dispara runs_changed; run novo dispara', async () => {
    const ws = new WebSocket(base.replace('http', 'ws'));
    const messages = [];
    ws.on('message', d => messages.push(JSON.parse(d)));
    await new Promise(r => ws.on('open', r));
    await eventually(() => messages.some(m => m.type === 'hello'));
    await new Promise(r => setTimeout(r, 400)); // addDir atrasado do teste anterior (90006-ro)
    messages.length = 0;
    fs.mkdirSync(path.join(mainRuns, 'avulso', 'screenshots'));
    await new Promise(r => setTimeout(r, 600));
    assert.ok(!messages.some(m => m.type === 'runs_changed'), 'subdir de run não é run novo');
    seed(mainRuns, '90007-novo', { node: 'plan', status: 'in_progress' });
    assert.ok(await eventually(() => messages.some(m => m.type === 'runs_changed')));
    assert.ok(await eventually(async () => (await get('/api/runs')).body.some(r => r.taskId === '90007-novo')));
    fs.rmSync(path.join(mainRuns, '90007-novo'), { recursive: true });
    assert.ok(await eventually(async () => !(await get('/api/runs')).body.some(r => r.taskId === '90007-novo')), 'unlinkDir tira do cache');
    ws.close();
});

// ---------------------------------------------------------------------------------
// Arquivar / restaurar pelo dashboard

test('arquivar: move só a cópia resolvida, esconde as velhas e restaura', async () => {
    const own = seed(wtRuns('95001'), '95001-feito', { node: 'commit', status: 'committed', updated_at: t1 });
    const stale = seed(mainRuns, '95001-feito', { node: 'plan', status: 'in_progress', updated_at: t0 });
    const listed = async () => (await get('/api/runs')).body.map(r => r.taskId);
    assert.ok((await eventually(async () => (await listed()).includes('95001-feito'))));

    const r = await post('/api/runs/95001-feito/archive', {});
    assert.strictEqual(r.status, 200);
    assert.ok(!fs.existsSync(own));
    assert.ok(fs.existsSync(path.join(wtRuns('95001'), '_archive', '95001-feito', 'state.json')));
    assert.ok(fs.existsSync(stale), 'cópia velha em outro root não é tocada');
    assert.ok(!(await listed()).includes('95001-feito'), 'nem a cópia velha aparece');

    const arch = (await get('/api/archive')).body.dashboard.find(a => a.taskId === '95001-feito');
    assert.ok(arch && arch.exists);

    const back = await post('/api/archive/95001-feito/restore', {});
    assert.strictEqual(back.status, 200);
    assert.ok(fs.existsSync(path.join(own, 'state.json')));
    assert.ok(await eventually(async () => (await listed()).includes('95001-feito')));
    assert.ok(!(await get('/api/archive')).body.dashboard.some(a => a.taskId === '95001-feito'));
});

test('GET /api/archive: rotação em memory/archive/ agrupada por mês; summary só conta', async () => {
    const archive = path.join(repo, 'memory', 'archive');
    seed(path.join(archive, '2026-07'), '95101-julho', { node: 'commit', status: 'committed', updated_at: '2026-07-05T00:00:00Z', redmine_ticket: { id: 95101, subject: 'Julho' } });
    seed(path.join(archive, '2026-08'), '95102-agosto', { node: 'commit', status: 'committed', updated_at: '2026-08-02T00:00:00Z' });
    seed(path.join(archive, '2026-08'), '95103-escalado', { node: 'escalated', status: 'escalated', updated_at: '2026-08-20T00:00:00Z' });
    seed(path.join(archive, '2026-08'), '95103-escalado__wt-95103', { node: 'escalated', status: 'escalated', updated_at: '2026-08-10T00:00:00Z' });
    fs.mkdirSync(path.join(archive, 'nao-e-mes', '95104-x'), { recursive: true });

    const full = (await get('/api/archive')).body;
    assert.ok(Array.isArray(full.dashboard));
    assert.deepStrictEqual(full.months.map(m => [m.month, m.count]), [['2026-08', 2], ['2026-07', 1]]);
    assert.strictEqual(full.total, 3);
    const [ago, jul] = full.months;
    assert.deepStrictEqual(ago.runs.map(r => r.taskId), ['95103-escalado', '95102-agosto'], 'mais recente primeiro');
    const esc = ago.runs[0];
    assert.strictEqual(esc.copies, 2);
    assert.strictEqual(esc.path, path.join('memory', 'archive', '2026-08', '95103-escalado'), 'cópia mais recente');
    assert.strictEqual(esc.status, 'escalated');
    assert.deepStrictEqual(jul.runs[0].ticket, { id: 95101, subject: 'Julho' });

    const summary = (await get('/api/archive?summary=1')).body;
    assert.deepStrictEqual(summary.months, [{ month: '2026-08', count: 2 }, { month: '2026-07', count: 1 }]);
    assert.strictEqual(summary.total, 3);
    fs.rmSync(archive, { recursive: true });
    assert.deepStrictEqual((await get('/api/archive')).body.months, []);
});

test('arquivar run ativo exige force; run que volta a andar reaparece', async t => {
    const dir = seed(wtRuns('95002'), '95002-andando', { node: 'implement', status: 'in_progress', updated_at: t0 });
    assert.ok(await eventually(async () => (await get('/api/runs')).body.some(r => r.taskId === '95002-andando')));
    const no = await post('/api/runs/95002-andando/archive', {});
    assert.strictEqual(no.status, 409);
    assert.ok(fs.existsSync(dir));
    // O unlinkDir da pasta movida precisa chegar antes de recriar o mesmo path;
    // sem isso o backend FSEvents pode coalescer delete+create num único evento.
    let unlinked = false;
    const onUnlinkDir = p => { if (path.basename(p) === '95002-andando') unlinked = true; };
    dash.watcher.on('unlinkDir', onUnlinkDir);
    t.after(() => dash.watcher.off('unlinkDir', onUnlinkDir));
    assert.strictEqual((await post('/api/runs/95002-andando/archive', { force: true })).status, 200);
    assert.ok(!(await get('/api/runs')).body.some(r => r.taskId === '95002-andando'));
    assert.ok(await eventually(() => unlinked), 'unlinkDir do run arquivado não chegou ao watcher');
    // O agente recria a pasta com updated_at novo: volta a aparecer.
    seed(wtRuns('95002'), '95002-andando', { node: 'review', status: 'in_progress', updated_at: new Date(Date.now() + 1000).toISOString() });
    assert.ok(await eventually(async () => (await get('/api/runs')).body.some(r => r.taskId === '95002-andando')));
});

test('arquivar/restaurar recusam ids fora do padrão', async () => {
    for (const bad of ['..', '_archive', '%2E%2E', 'a%2Fb']) {
        assert.ok([400, 404].includes((await post(`/api/runs/${bad}/archive`, { force: true })).status));
        assert.ok([400, 404].includes((await post(`/api/archive/${bad}/restore`, {})).status));
    }
});

test('worktree criada depois do start com run dentro avisa o navegador (runs_changed)', async () => {
    const ws = new WebSocket(base.replace('http', 'ws'));
    const messages = [];
    ws.on('message', d => messages.push(JSON.parse(d)));
    await new Promise(r => ws.on('open', r));
    await eventually(() => messages.some(m => m.type === 'hello'));
    messages.length = 0;
    // Cria root + run de uma vez (o chokidar não vê nada disso: o root ainda não é observado).
    seed(wtRuns('96001'), '96001-novo', { node: 'plan', status: 'in_progress', updated_at: new Date().toISOString() });
    // Qualquer listagem sincroniza os roots (o timer de 10s faz o mesmo sozinho).
    await get('/api/runs');
    assert.ok(await eventually(() => messages.some(m => m.type === 'runs_changed')), 'sem runs_changed');
    assert.ok((await get('/api/runs')).body.some(r => r.taskId === '96001-novo'));
    ws.close();
});

// ---------------------------------------------------------------------------------
// Portão de build pré-implement (watcher > runPreBuildGate): preBuild no resumo do run.

test('preBuildOf / deriveRunKind: pre-build-failed é falha; campos normalizados', () => {
    const { preBuildOf } = require('./server');
    assert.strictEqual(preBuildOf({ status: 'in_progress' }), null);
    assert.strictEqual(preBuildOf(null), null);
    assert.deepStrictEqual(preBuildOf({ preBuildStatus: 'passed', preBuildDurationMs: 4200, preBuildAt: t0 }),
        { status: 'passed', errors: [], durationMs: 4200, at: t0, accepted: null, skipReason: null });
    assert.deepStrictEqual(preBuildOf({ preBuildStatus: 'failed', preBuildErrors: ['A.java:3 — x', 7], preBuildAccepted: { by: 'Dev' } }).errors, ['A.java:3 — x']);
    assert.strictEqual(preBuildOf({ preBuildStatus: 'failed', preBuildAccepted: { by: 'Dev' } }).accepted, 'Dev');
    assert.strictEqual(deriveRunKind({ status: 'pre-build-failed' }), 'failed');
});

test('GET /api/runs: run parado no pré-build sai como failed com preBuild.errors; passed também aparece', async () => {
    const r2 = path.join(fs.mkdtempSync(path.join(tmpBase, 'dashboard-pb-')), 'app-back');
    const runs2 = path.join(r2, 'memory', 'runs');
    const wt = id => path.join(r2, '.claude', 'worktrees', id, 'memory', 'runs');
    const errors = ['src/main/java/br/Foo.java:12 — cannot find symbol (symbol: variable total)'];
    fs.mkdirSync(runs2, { recursive: true });
    seed(wt('94001'), '94001-quebrado', {
        node: 'implement', status: 'pre-build-failed', history: ['fetch_ticket', 'plan'], updated_at: t1,
        preBuildStatus: 'failed', preBuildErrors: errors, preBuildDurationMs: 31000,
    });
    seed(wt('94003'), '94003-jdk', { node: 'review', status: 'in_progress', history: ['plan', 'implement'], preBuildStatus: 'skipped', preBuildSkipReason: 'JDK incompatível' });
    const preBuildSkip = () => body.find(r => r.taskId === '94003-jdk').preBuild.skipReason;
    let body;
    seed(wt('94002'), '94002-ok', {
        node: 'implement', status: 'in_progress', history: ['fetch_ticket', 'plan'], updated_at: t1,
        preBuildStatus: 'passed', preBuildDurationMs: 42000,
    });
    const d2 = createDashboard({ memoryDir: runs2 });
    await new Promise(r => d2.server.listen(0, '127.0.0.1', r));
    await d2.ready;
    try {
        const res = await fetch(`http://localhost:${d2.server.address().port}/api/runs`);
        body = await res.json();
        const broken = body.find(r => r.taskId === '94001-quebrado');
        assert.strictEqual(broken.status, 'failed');
        assert.strictEqual(broken.kind, 'failed');
        assert.strictEqual(broken.preBuild.status, 'failed');
        assert.deepStrictEqual(broken.preBuild.errors, errors);
        assert.strictEqual(broken.preBuild.durationMs, 31000);
        const ok = body.find(r => r.taskId === '94002-ok');
        assert.strictEqual(ok.status, 'running');
        assert.deepStrictEqual(ok.preBuild, { status: 'passed', errors: [], durationMs: 42000, at: null, accepted: null, skipReason: null, retrying: false, aiFix: null });
        assert.strictEqual(preBuildSkip(), 'JDK incompatível');
    } finally {
        d2.close();
    }
});

test('specDecisionsOf: conta entradas de "## Decisões de Implementação"; ignora código, comentário e seção ausente', () => {
    const { specDecisionsOf } = require('./server');
    const base = '# Spec\n\n## Problema\nx\n\n## Critérios de Aceite\n- a\n- b\n';
    assert.strictEqual(specDecisionsOf(null), null);
    assert.strictEqual(specDecisionsOf(base), null);
    assert.strictEqual(specDecisionsOf(base + '\n```markdown\n## Decisões de Implementação\n### implement · x\n```\n'), null);
    assert.strictEqual(specDecisionsOf(base + '\n<!--\n## Decisões de Implementação\n-->\n'), null);
    const entry = ts => `\n### implement · ${ts} · 12345\n- **Decisão**: BigDecimal em vez de double\n- **Motivo**: precisão\n- **Impacto no spec**: Critério de aceite #3 ajustado\n`;
    const one = base + '\n## Decisões de Implementação\n' + entry('2026-09-24T10:00Z');
    assert.deepStrictEqual(specDecisionsOf(one), { entries: 1 });
    // Sem acento/caixa diferente também vale; "###" depois de outra seção "##" não conta.
    const two = base + '\n## Decisoes de implementação\n' + entry('a') + entry('b') + '\n## Notas\n### outra coisa\n';
    assert.deepStrictEqual(specDecisionsOf(two), { entries: 2 });
});

test('GET /api/runs: specDecisions vem da spec do worktree do ticket; spec sem a seção => null', async () => {
    const r3 = path.join(fs.mkdtempSync(path.join(tmpBase, 'dashboard-spec-')), 'app-back');
    const runs3 = path.join(r3, 'memory', 'runs');
    const wtRoot = id => path.join(r3, '.claude', 'worktrees', id, 'memory');
    fs.mkdirSync(runs3, { recursive: true });
    const spec = '## Problema\nx\n\n## Critérios de Aceite\n- a\n- b\n';
    for (const [id, extra] of [['95001', '\n## Decisões de Implementação\n\n### implement · 2026-09-24T10:00Z · 95001\n- **Decisão**: BigDecimal\n- **Motivo**: dinheiro\n- **Impacto no spec**: AC3 ajustado\n'], ['95002', '']]) {
        seed(path.join(wtRoot(id), 'runs'), `${id}-t`, { node: 'review', status: 'in_progress', updated_at: t1, redmine_ticket: { id: Number(id) } });
        fs.mkdirSync(path.join(wtRoot(id), 'spec'), { recursive: true });
        fs.writeFileSync(path.join(wtRoot(id), 'spec', `${id}-spec.md`), spec + extra);
    }
    const d3 = createDashboard({ memoryDir: runs3 });
    await new Promise(r => d3.server.listen(0, '127.0.0.1', r));
    await d3.ready;
    try {
        const port = d3.server.address().port;
        const body = await (await fetch(`http://localhost:${port}/api/runs`)).json();
        assert.deepStrictEqual(body.find(r => r.taskId === '95001-t').specDecisions, { entries: 1 });
        assert.strictEqual(body.find(r => r.taskId === '95002-t').specDecisions, null);
        const detail = await (await fetch(`http://localhost:${port}/api/runs/95001-t`)).json();
        assert.deepStrictEqual(detail.specDecisions, { entries: 1 });
    } finally {
        d3.close();
    }
});

test('POST /pre-build/ai-fix: despacha o agente no worktree, transmite os passos e o build-validator dá o veredito', async () => {
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    const r4 = path.join(fs.mkdtempSync(path.join(tmpBase, 'dashboard-aifix-')), 'app-back');
    const runs4 = path.join(r4, 'memory', 'runs');
    fs.mkdirSync(runs4, { recursive: true });
    const wt = id => path.join(r4, '.claude', 'worktrees', id, 'memory', 'runs');
    const failed = { node: 'implement', status: 'pre-build-failed', history: ['fetch_ticket', 'plan'], preBuildStatus: 'failed', preBuildErrors: ['src/A.java:3 — cannot find symbol'] };
    const dOk = seed(wt('97001'), '97001-ok', failed);
    const dStop = seed(wt('97002'), '97002-stop', failed);
    seed(wt('97003'), '97003-andando', { node: 'review', status: 'in_progress', history: ['plan', 'implement'], preBuildStatus: 'passed' });
    const spawned = [];
    const aiFixSpawn = (bin, args, opts) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.pid = process.pid; // "vivo" pro pidAlive
        const close = code => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code)); };
        child.kill = () => close(null);
        child.finish = () => {
            child.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(opts.cwd, 'src/A.java') } }] } }) + '\n');
            child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Import faltando em A.java. Build passou. token=abc123secret', total_cost_usd: 0.42, num_turns: 5 }) + '\n');
            close(0);
        };
        spawned.push({ bin, args, opts, child });
        return child;
    };
    const validateCalls = [];
    const validateBuild = async worktree => { validateCalls.push(worktree); return { success: true, errors: [], duration: 800, javaHome: '/jdk25' }; };
    const d4 = createDashboard({ env: { PRE_BUILD_COMMAND: 'mvn compile' }, memoryDir: runs4, validateBuild, aiFixSpawn });
    await new Promise(r => d4.server.listen(0, '127.0.0.1', r));
    await d4.ready;
    const b4 = `http://localhost:${d4.server.address().port}`;
    const post4 = p => fetch(b4 + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(async r => ({ status: r.status, body: await r.json() }));
    const ws = new WebSocket(b4.replace('http', 'ws'));
    const messages = [];
    ws.on('message', m => messages.push(JSON.parse(m)));
    await new Promise(r => ws.on('open', r));
    const read = d => JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
    try {
        assert.strictEqual((await post4('/api/runs/97003-andando/pre-build/ai-fix')).status, 409);
        assert.strictEqual((await post4('/api/runs/nao-existe/pre-build/ai-fix')).status, 404);
        assert.strictEqual((await post4('/api/runs/97001-ok/pre-build/ai-fix/cancel')).status, 409, 'nada rodando');

        assert.strictEqual((await post4('/api/runs/97001-ok/pre-build/ai-fix')).status, 202);
        assert.strictEqual((await post4('/api/runs/97001-ok/pre-build/ai-fix')).status, 409, 'clique duplo');
        assert.strictEqual((await post4('/api/runs/97001-ok/pre-build/retry')).status, 409, 'recompilar no meio da correção');
        const [agent] = spawned;
        assert.strictEqual(agent.bin, 'claude');
        assert.strictEqual(agent.opts.cwd, path.join(r4, '.claude', 'worktrees', '97001'));
        assert.match(agent.args[1], /src\/A\.java:3 — cannot find symbol/);
        assert.strictEqual(read(dOk).preBuildAiFix.status, 'running');
        const during = (await (await fetch(`${b4}/api/runs`)).json()).find(r => r.taskId === '97001-ok');
        assert.strictEqual(during.preBuild.aiFix.status, 'running');

        agent.child.finish();
        assert.ok(await eventually(() => read(dOk).preBuildAiFix?.status === 'passed'), 'veredito gravado');
        const ok = read(dOk);
        assert.strictEqual(ok.status, 'in_progress');
        assert.strictEqual(ok.preBuildStatus, 'passed');
        assert.strictEqual(ok.preBuildAiFix.costUsd, 0.42);
        assert.match(ok.preBuildAiFix.summary, /token=\*\*\*/);
        assert.deepStrictEqual(validateCalls, [path.join(r4, '.claude', 'worktrees', '97001')]);
        assert.match(fs.readFileSync(path.join(dOk, 'context.md'), 'utf8'), /Correção do build pré-implement por IA/);

        assert.ok(await eventually(() => messages.some(m => m.type === 'prebuild_ai_event' && m.taskId === '97001-ok' &&
            m.event.kind === 'tool' && m.event.text === 'Editando src/A.java')), 'evento tool não chegou ao WebSocket');
        assert.ok(await eventually(() => messages.some(m => m.type === 'prebuild_ai_event' && m.taskId === '97001-ok' &&
            m.event.kind === 'build' && m.event.ok === true)), 'evento build não chegou ao WebSocket');
        const liveFinal = messages.filter(m => m.type === 'prebuild_ai_event' && m.taskId === '97001-ok').map(m => m.event);
        assert.ok(liveFinal.every(e => !e.text.includes('abc123secret')), 'secret redigido no WS');
        const hist = (await (await fetch(`${b4}/api/runs/97001-ok/pre-build/ai-fix`)).json());
        assert.strictEqual(hist.aiFix.status, 'passed');
        assert.deepStrictEqual(hist.events.map(e => e.kind), liveFinal.map(e => e.kind), 'GET devolve o mesmo histórico do WS');

        // Cancelar: não valida, marca cancelled e continua pre-build-failed.
        assert.strictEqual((await post4('/api/runs/97002-stop/pre-build/ai-fix')).status, 202);
        assert.strictEqual((await post4('/api/runs/97002-stop/pre-build/ai-fix/cancel')).status, 200);
        assert.ok(await eventually(() => read(dStop).preBuildAiFix?.status === 'cancelled'));
        assert.strictEqual(read(dStop).status, 'pre-build-failed');
        assert.strictEqual(validateCalls.length, 1);
    } finally {
        ws.close();
        d4.close();
    }
});

test('POST /pre-build/retry: recompila no worktree do ticket e grava o resultado (passou => in_progress; falhou => erros novos)', async () => {
    const r3 = path.join(fs.mkdtempSync(path.join(tmpBase, 'dashboard-retry-')), 'app-back');
    const runs3 = path.join(r3, 'memory', 'runs');
    fs.mkdirSync(runs3, { recursive: true });
    const wt = id => path.join(r3, '.claude', 'worktrees', id, 'memory', 'runs');
    const failed = { node: 'implement', status: 'pre-build-failed', history: ['fetch_ticket', 'plan'], preBuildStatus: 'failed', preBuildErrors: ['velho'] };
    const dOk = seed(wt('95001'), '95001-ok', failed);
    const dFail = seed(wt('95002'), '95002-fail', failed);
    seed(wt('95003'), '95003-andando', { node: 'review', status: 'in_progress', history: ['plan', 'implement'], preBuildStatus: 'passed' });
    const calls = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const validateBuild = async (worktree, opts) => {
        calls.push({ worktree, opts });
        await gate;
        return worktree.endsWith('95001')
            ? { success: true, errors: [], duration: 1200, javaHome: '/jdk25' }
            : { success: false, errors: ['src/F.java:3 — novo erro'], duration: 900, javaHome: '/jdk25' };
    };
    const d3 = createDashboard({ memoryDir: runs3, validateBuild });
    await new Promise(r => d3.server.listen(0, '127.0.0.1', r));
    await d3.ready;
    const b3 = `http://localhost:${d3.server.address().port}`;
    const post3 = p => fetch(b3 + p, { method: 'POST' }).then(async r => ({ status: r.status, body: await r.json() }));
    try {
        assert.strictEqual((await post3('/api/runs/95003-andando/pre-build/retry')).status, 409);
        assert.strictEqual((await post3('/api/runs/nao-existe/pre-build/retry')).status, 404);

        assert.strictEqual((await post3('/api/runs/95001-ok/pre-build/retry')).status, 202);
        assert.strictEqual((await post3('/api/runs/95001-ok/pre-build/retry')).status, 409, 'clique duplo enquanto recompila');
        assert.strictEqual((await post3('/api/runs/95002-fail/pre-build/retry')).status, 202);
        const during = await (await fetch(`${b3}/api/runs`)).json();
        assert.strictEqual(during.find(r => r.taskId === '95001-ok').preBuild.retrying, true);
        assert.strictEqual(calls[0].worktree, path.join(r3, '.claude', 'worktrees', '95001'));

        release();
        const read = d => JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
        assert.ok(await eventually(() => read(dOk).preBuildStatus === 'passed' && read(dFail).preBuildErrors?.[0] === 'src/F.java:3 — novo erro'));
        const ok = read(dOk);
        assert.strictEqual(ok.status, 'in_progress');
        assert.strictEqual(ok.preBuildErrors, undefined);
        assert.strictEqual(ok.preBuildJavaHome, '/jdk25');
        const bad = read(dFail);
        assert.strictEqual(bad.status, 'pre-build-failed');
        assert.match(bad.events.at(-1).detail, /retentativa pelo dashboard/);
        const after = await eventually(async () => {
            const list = await (await fetch(`${b3}/api/runs`)).json();
            return list.find(r => r.taskId === '95001-ok').preBuild.retrying === false && list;
        });
        assert.ok(after);
    } finally {
        d3.close();
    }
});

// ---------------------------------------------------------------------------------
// Bolinhas das etapas: /test, /verify e /commit não gravam em history (ticket 43812)

test('nodes: run commitado marca todas as etapas; node_end dos events conta como concluído', async () => {
    const endOf = node => [{ type: 'node_start', node }, { type: 'node_end', node }];
    seed(wtRuns('96001'), '96001-commitado', {
        node: 'commit', status: 'committed', updated_at: t1,
        history: ['fetch_ticket', 'plan', 'implement', 'review'],
        events: [...endOf('test'), ...endOf('verify'), { type: 'node_start', node: 'commit' }],
    });
    seed(wtRuns('96002'), '96002-verificando', {
        node: 'verify', status: 'running', updated_at: t1,
        history: ['fetch_ticket', 'plan', 'implement', 'review'], events: endOf('test'),
    });
    const ids = ['96001-commitado', '96002-verificando'];
    const body = await eventually(async () => {
        const runs = (await get('/api/runs')).body;
        return ids.every(id => runs.some(r => r.taskId === id)) && runs;
    });
    const all = Object.fromEntries(['fetch_ticket', 'plan', 'implement', 'review', 'test', 'verify', 'commit'].map(n => [n, 'done']));
    assert.deepStrictEqual(body.find(r => r.taskId === '96001-commitado').nodes, all);
    assert.deepStrictEqual(body.find(r => r.taskId === '96002-verificando').nodes, { ...all, verify: 'running', commit: 'pending' });
});

test('POST /churn/accept: churn-escalation volta pra in_progress com as contagens atuais como baseline', async () => {
    const churn = require('../scripts/lib/churn-detector');
    const { execFileSync } = require('child_process');
    const r5 = path.join(fs.mkdtempSync(path.join(tmpBase, 'dashboard-churn-')), 'app-back');
    const runs5 = path.join(r5, 'memory', 'runs');
    fs.mkdirSync(runs5, { recursive: true });
    const wt = path.join(r5, '.claude', 'worktrees', '98001');
    fs.mkdirSync(wt, { recursive: true });
    const g = (...a) => execFileSync('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(wt, 'A.java'), 'v0\n');
    g('add', '.'); g('commit', '-q', '-m', 'base');
    churn.ensureAnchor(wt, '98001-churn');
    for (const v of ['v1', 'v2', 'v3']) {
        fs.writeFileSync(path.join(wt, 'A.java'), `${v}\n`);
        churn.recordRound(wt, '98001-churn', `rodada ${v}`);
    }
    const escalated = { node: 'implement', status: 'churn-escalation', history: ['plan', 'implement', 'review', 'implement'],
        churnReport: { detectedAt: t1, threshold: 3, files: [{ path: 'A.java', modificationCount: 3, commits: [], threshold: 3 }] } };
    const dChurn = seed(path.join(wt, 'memory', 'runs'), '98001-churn', escalated);
    seed(path.join(r5, '.claude', 'worktrees', '98002', 'memory', 'runs'), '98002-andando', { node: 'review', status: 'in_progress' });
    const d5 = createDashboard({ memoryDir: runs5 });
    await new Promise(r => d5.server.listen(0, '127.0.0.1', r));
    await d5.ready;
    const b5 = `http://localhost:${d5.server.address().port}`;
    const post5 = p => fetch(b5 + p, { method: 'POST' }).then(async r => ({ status: r.status, body: await r.json() }));
    try {
        assert.strictEqual((await post5('/api/runs/98002-andando/churn/accept')).status, 409, 'sem churn');
        assert.strictEqual((await post5('/api/runs/nao-existe/churn/accept')).status, 404);
        assert.strictEqual((await post5('/api/runs/98001-churn/churn/accept')).status, 200);
        const st = JSON.parse(fs.readFileSync(path.join(dChurn, 'state.json'), 'utf8'));
        assert.strictEqual(st.status, 'in_progress');
        assert.strictEqual(st.churnAccepted.by, 'dashboard');
        assert.deepStrictEqual(st.churnAccepted.counts, { 'A.java': 3 });
        assert.ok(st.churnReport, 'relatório mantido pro histórico');
        assert.strictEqual((await post5('/api/runs/98001-churn/churn/accept')).status, 409, 'clique duplo');
    } finally {
        await d5.close();
    }
});
