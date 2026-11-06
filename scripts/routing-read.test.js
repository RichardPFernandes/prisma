'use strict';
// scripts/routing-read.js: leitor de roteamento para o Dashboard (fronteira G3, opção A).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256Bytes } = require('./lib/model-routing-policy');
const mr = require('./lib/model-routing');
const dom06 = require('./lib/dom06-attempt');

const CLI = path.join(__dirname, 'routing-read.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-read-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function policy() {
    return {
        id: 'routing-pri205', version: 'p1-2026-11-06', mode: 'ROUTED', status: 'APROVADA',
        classifier: { provider: 'cheap_rule' },
        class_to_tier: {
            C1: { tier: 'T1', effort: 'baixo' }, C2: { tier: 'T2', effort: 'médio' },
            C3: { tier: 'T3', effort: 'alto' }, C4: { tier: 'T3', effort: 'alto' }, C5: { tier: 'T3', effort: 'máximo' },
        },
        tiers: { T1: { models: ['claude-sonnet-5-5'] }, T2: { models: ['claude-sonnet-5-5'] }, T3: { models: ['claude-opus-5-5'] } },
        default_route: { model_id: 'claude-opus-5-5', effort: 'alto' },
        effort_map: { baixo: 'low', 'médio': 'medium', alto: 'high', 'máximo': 'max' },
        effort_applied: false,
    };
}

function consumer(name, { on = true } = {}) {
    const repo = path.join(tmp, name);
    const runs = path.join(repo, 'memory', 'runs');
    fs.mkdirSync(path.join(repo, '.claude', 'routing'), { recursive: true });
    fs.mkdirSync(runs, { recursive: true });
    const bytes = Buffer.from(JSON.stringify(policy()));
    fs.writeFileSync(path.join(repo, '.claude', 'routing', 'policy.json'), bytes);
    const ref = { id: 'routing-pri205', version: 'p1-2026-11-06', sha256: sha256Bytes(bytes), path: '.claude/routing/policy.json' };
    if (on) fs.writeFileSync(path.join(repo, '.claude', 'model-routing.json'), JSON.stringify({ mode: 'ON', policy_ref: ref }));
    return { repo, runs, ref };
}

function run(input, args = ['--json']) {
    const r = spawnSync(process.execPath, [CLI, ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
    let body = null;
    try { body = JSON.parse(r.stdout); } catch { /* saída não JSON */ }
    return { code: r.status, body, stdout: r.stdout, stderr: r.stderr };
}

test('ON: config pelo readRoutingConfig, snapshot pelo loadRunSnapshot e NOT_STARTED mínimos', () => {
    const c = consumer('on');
    const snap = mr.buildRoutingSnapshot({ status: 'ON', policy: policy(), policy_ref: c.ref });
    const adm = dom06.beginAttempt(path.join(c.runs, '_dom06'), {
        node: 'fetch_ticket', cause: 'dispatch',
        admission: { status: 'ADMITTED', owner: 'watcher', snapshot: { routing: snap }, obligations: [] },
    });
    const runDir = path.join(c.runs, '9001-x');
    fs.mkdirSync(runDir, { recursive: true });
    dom06.beginAttempt(runDir, {
        node: 'implement', cause: 'dispatch',
        admission: { status: 'NOT_STARTED', cause: 'CONFIG_UNVERIFIABLE', detail: 'PLUGIN_NOT_PROVEN_OFF' },
        routing: { class: 'C2', chosen: { model_id: 'claude-sonnet-5-5', tier: 'T2' }, plugin_proof: { settings_path: '/Users/x/s.json' } },
    });
    const out = run({
        repo_root: c.repo,
        runs: [
            { key: '9001-x', run_dir: runDir, binding: { attempt_id: adm.attempt.attempt_id, sha256: snap.sha256 }, not_started: true },
            { key: '9002-off', run_dir: path.join(c.runs, '9002-off'), binding: null, not_started: false },
        ],
    });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.config.status, 'ON');
    const r1 = out.body.runs['9001-x'];
    assert.equal(r1.snapshot.ok, true);
    assert.equal(r1.snapshot.snapshot.sha256, snap.sha256);
    assert.equal(r1.attempts.length, 1);
    assert.deepEqual(Object.keys(r1.attempts[0]).sort(), ['attempt_id', 'created_at', 'node', 'not_started', 'result', 'routing']);
    assert.deepEqual(r1.attempts[0].routing, { class: 'C2', chosen: { model_id: 'claude-sonnet-5-5' } });
    assert.ok(!out.stdout.includes('settings_path'), 'settings_path não sai da CLI');
    assert.deepEqual(out.body.runs['9002-off'], { snapshot: { mode: 'OFF' } });
});

test('snapshot adulterado: devolve o detalhe do dono, sem lançar', () => {
    const c = consumer('tamper');
    const snap = mr.buildRoutingSnapshot({ status: 'ON', policy: policy(), policy_ref: c.ref });
    const adm = dom06.beginAttempt(path.join(c.runs, '_dom06'), {
        node: 'fetch_ticket', cause: 'dispatch',
        admission: { status: 'ADMITTED', owner: 'watcher', snapshot: { routing: { ...snap, default_route: { model_id: 'x', effort: 'y' } } }, obligations: [] },
    });
    const out = run({ repo_root: c.repo, runs: [{ key: 'k', run_dir: path.join(c.runs, 'k'), binding: { attempt_id: adm.attempt.attempt_id, sha256: snap.sha256 }, not_started: false }] });
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(out.body.runs.k.snapshot, { mode: 'ON', ok: false, detail: 'snapshot_hash_mismatch' });
});

test('config OFF (sem arquivo) e lista vazia', () => {
    const c = consumer('off', { on: false });
    const out = run({ repo_root: c.repo, runs: [] });
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(out.body, { ok: true, config: { status: 'OFF', source: 'absent' }, runs: {} });
});

test('uso incorreto: sem --json, stdin inválido ou caminhos relativos → saída 2 com erro em JSON', () => {
    const c = consumer('usage', { on: false });
    assert.equal(run({ repo_root: c.repo, runs: [] }, []).code, 2);
    const bad = run('{nao json');
    assert.equal(bad.code, 2);
    assert.equal(bad.body.ok, false);
    assert.equal(run({ repo_root: 'relativo', runs: [] }).code, 2);
    assert.equal(run({ repo_root: c.repo, runs: [{ key: 'k', run_dir: 'rel', binding: null }] }).code, 2);
    assert.equal(run({ repo_root: c.repo, runs: 'x' }).code, 2);
});

test('chave duplicada é recusada (saída 2), sem sobrescrever leitura', () => {
    const c = consumer('dup', { on: false });
    const d = path.join(c.runs, 'a');
    const out = run({ repo_root: c.repo, runs: [{ key: 'a', run_dir: d, binding: null }, { key: 'a', run_dir: d, binding: null }] });
    assert.equal(out.code, 2);
});
