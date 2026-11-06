#!/usr/bin/env node
// Leitor de roteamento de modelo para o Dashboard (telas de roteamento, PRI-205; T4).
//
// A regra G3 (no-dashboard-scripts-internals) não deixa o dashboard importar
// scripts/lib. Este script expõe, por processo (como replay-cycle.js e
// readmine-watcher.js --health-check), os MESMOS leitores que o watcher usa:
//   - config e policy vigentes: model-routing-policy.readRoutingConfig;
//   - snapshot da Run: routing-run.loadRunSnapshot (nunca a config corrente);
//   - Attempts NOT_STARTED: dom06-attempt.listAttempts.
// Só lê. Não projeta para a tela (isso é dashboard/routing-projection.js), mas já
// corta dos Attempts tudo que não é preciso (snapshot, obrigações, plugin_proof).
//
//   echo '<json>' | node scripts/routing-read.js --json
//
// Entrada (stdin): { "repo_root": "<abs>", "runs": [ { "key": "<task-id>",
//   "run_dir": "<abs>", "binding": {attempt_id, sha256} | null, "not_started": bool } ] }
// Saída (stdout): { ok: true, config, runs: { <key>: { snapshot, attempts? } } }
// Código de saída: 0 ok · 1 falha de leitura inesperada · 2 uso incorreto.

const path = require('path');
const { readRoutingConfig } = require('./lib/model-routing-policy');
const { loadRunSnapshot } = require('./lib/routing-run');
const { listAttempts } = require('./lib/dom06-attempt');

class UsageError extends Error {}

function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', c => chunks.push(c));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}

function parseInput(text) {
    let input;
    try { input = JSON.parse(text); } catch { throw new UsageError('stdin não é JSON'); }
    if (!input || typeof input !== 'object') throw new UsageError('stdin deve ser um objeto');
    if (typeof input.repo_root !== 'string' || !path.isAbsolute(input.repo_root)) throw new UsageError('repo_root deve ser caminho absoluto');
    if (!Array.isArray(input.runs)) throw new UsageError('runs deve ser lista');
    const keys = new Set();
    for (const r of input.runs) {
        if (!r || typeof r.key !== 'string' || !r.key) throw new UsageError('run sem key');
        if (keys.has(r.key)) throw new UsageError(`key duplicada: ${r.key}`);
        keys.add(r.key);
        if (typeof r.run_dir !== 'string' || !path.isAbsolute(r.run_dir)) throw new UsageError(`run_dir deve ser absoluto (${r.key})`);
        if (r.binding != null && typeof r.binding !== 'object') throw new UsageError(`binding inválido (${r.key})`);
    }
    return input;
}

/** Só o necessário para a tela; snapshot, obrigações e plugin_proof não saem. */
function minimalNotStarted(a) {
    const routing = a.routing && typeof a.routing === 'object'
        ? {
            class: a.routing.class ?? null,
            chosen: a.routing.chosen && typeof a.routing.chosen === 'object' ? { model_id: a.routing.chosen.model_id ?? null } : null,
        }
        : null;
    return {
        attempt_id: a.attempt_id ?? null, node: a.node ?? null, result: a.result,
        not_started: a.not_started ?? null, created_at: a.created_at ?? null, routing,
    };
}

function readRun(r) {
    // Mesmo diretório de admissão que o watcher e o writer de override usam.
    const fetchRunDir = path.join(path.dirname(path.resolve(r.run_dir)), '_dom06');
    const out = { snapshot: loadRunSnapshot(r.binding ? { routing_snapshot: r.binding } : {}, fetchRunDir) };
    if (r.not_started === true) {
        out.attempts = listAttempts(r.run_dir)
            .filter(a => a && a.result === 'NOT_STARTED')
            .map(minimalNotStarted);
    }
    return out;
}

async function main(argv) {
    if (!argv.includes('--json')) throw new UsageError('uso: node scripts/routing-read.js --json < entrada.json');
    const input = parseInput(await readStdin());
    const runs = {};
    for (const r of input.runs) runs[r.key] = readRun(r);
    return { ok: true, config: readRoutingConfig(input.repo_root), runs };
}

if (require.main === module) {
    main(process.argv.slice(2)).then(
        out => { process.stdout.write(JSON.stringify(out)); },
        err => {
            process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
            process.exitCode = err instanceof UsageError ? 2 : 1;
        },
    );
}

module.exports = { parseInput, minimalNotStarted };
