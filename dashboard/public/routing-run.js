// Bloco "Roteamento" no detalhe da Run (telas de roteamento, PRI-205; T7): snapshot da
// Run, overrides gravadas, recusas NOT_STARTED e o formulário de override humano.
//
// Só leitura, exceto o formulário, que chama o writer EXISTENTE
// (POST /api/runs/:taskId/routing-override → authorization.recordRoutingOverride:
// CAS e operation_id; sem aprovador desde 2026-11-06, autoria = usuário do sistema
// operacional que roda o Dashboard). A tela não é a guarda: as opções vêm do
// snapshot da Run (GET /api/routing?task=), e qualquer recusa do writer aparece com o
// código como veio. Mesmo operation_id em todas as tentativas da mesma decisão até a
// resposta chegar (resultado incerto nunca vira gravação dupla); mudar o formulário
// gera outro.
//
// Script clássico carregado depois do principal, no padrão de authorization.js: usa os
// globais runs, selected, esc, api, when, StateVersion e $. renderDetail() reescreve o
// #detail a cada atualização: html(r) devolve a caixa a partir do cache e wire(r)
// busca os dados quando a versão da Run muda.
(() => {
  const cache = new Map(); // taskId → { version, data, reader, loading, error, msg, msgCls, busy, op, form }
  // Nós aceitos como escopo "nó". O writer aceita qualquer nome; a lista só guia a escolha.
  const NODES = ['plan', 'implement', 'review', 'test', 'verify', 'commit'];
  const SCOPES = [['node', 'Só um nó'], ['ticket', 'Toda a Run (ticket)']];
  const CODE_HINT = {
    OVERRIDE_INELIGIBLE: 'fora do conjunto elegível do snapshot desta Run',
    ROUTING_OFF: 'a Run foi admitida sem roteamento',
    ROUTING_UNVERIFIABLE: 'o snapshot desta Run não pôde ser verificado',
    OVERRIDE_INVALID: 'pedido incompleto ou inválido',
  };

  function ui(taskId) {
    if (!cache.has(taskId)) cache.set(taskId, { form: { scope: 'node', node: 'implement', model: '', effort: '' } });
    return cache.get(taskId);
  }
  function relevant(r) {
    return !!r && !r.archived && !r.pretask && !!r.state?.routing_snapshot;
  }

  async function load(taskId, force) {
    const r = runs.get(taskId);
    const u = ui(taskId);
    if (!r || u.loading || (!force && u.version === r.stateVersion && u.data !== undefined)) return;
    u.loading = true;
    try {
      const out = await api(`/api/routing?task=${encodeURIComponent(taskId)}`);
      u.data = (out.runs || [])[0] || null;
      u.reader = out.reader;
      u.error = null;
      u.version = r.stateVersion;
    } catch (e) { u.error = e.message; }
    u.loading = false;
    rerender(taskId);
  }
  function rerender(taskId) {
    const box = $('routingRunBox');
    const r = runs.get(taskId);
    if (box && r && selected === taskId) box.innerHTML = inner(r);
  }

  const opt = (value, label, cur) => `<option value="${esc(value)}"${value === cur ? ' selected' : ''}>${esc(label)}</option>`;

  function blockedReason(r, d) {
    if (d.mode !== 'ON') return 'Roteamento desta Run desconhecido agora: o writer decide se aceita.';
    if (d.snapshot?.integrity !== 'ok') return `Snapshot da Run não verificado (${d.snapshot?.integrity || 'desconhecido'}): o writer recusaria.`;
    if (!d.snapshot.eligible_models?.length) return 'O snapshot desta Run não lista modelos elegíveis.';
    if (r.state?.status === 'running') return 'Há um nó rodando nesta Run: o writer recusa até ele terminar.';
    return '';
  }

  function formHtml(r, u, d) {
    const f = u.form;
    const models = d.snapshot?.eligible_models || [];
    const efforts = d.snapshot?.efforts || [];
    if (!f.model && models.length) f.model = models[models.length - 1];
    if (!f.effort && efforts.length) f.effort = efforts.includes('alto') ? 'alto' : efforts[0];
    const why = blockedReason(r, d);
    const disabled = !!why || !!u.busy;
    return `
      <fieldset class="rtr-form">
        <legend>Override de modelo</legend>
        <div class="approval-actions" role="group" aria-label="Override">
          <label>Escopo <select id="rtrScope">${SCOPES.map(([v, l]) => opt(v, l, f.scope)).join('')}</select></label>
          ${f.scope === 'node' ? `<label>Nó <select id="rtrNode">${NODES.map(n => opt(n, n, f.node)).join('')}</select></label>` : ''}
          <label>Modelo <select id="rtrModel">${models.map(m => opt(m, m, f.model)).join('')}</select></label>
          <label>Esforço <select id="rtrEffort">${efforts.map(e => opt(e, e, f.effort)).join('')}</select></label>
        </div>
        <p class="approval-msg">Modelos e esforços vêm do snapshot desta Run. O esforço fica registrado, mas não vai ao despacho enquanto o esforço não for aplicado (SP-1). A override vale a partir do próximo limite de nó.</p>
        <div class="approval-actions">
          <button type="button" class="send" data-rtr="save" ${disabled ? 'disabled' : ''}${why ? ` title="${esc(why)}"` : ''}>${u.busy ? 'Gravando…' : 'Gravar override'}</button>
        </div>
        ${why ? `<p class="approval-msg">${esc(why)}</p>` : ''}
      </fieldset>`;
  }

  function inner(r) {
    const u = ui(r.taskId);
    const d = u.data;
    const msg = u.msg ? `<p class="approval-msg rtr-msg ${esc(u.msgCls || '')}" role="status">${esc(u.msg)}</p>` : '';
    if (u.error) return `<div class="approval-box"><p class="approval-msg err">Roteamento: ${esc(u.error)}</p>${msg}</div>`;
    if (d === undefined || (u.loading && !d)) return '<div class="approval-box"><p class="approval-msg">Carregando roteamento…</p></div>';
    if (!d) return `<div class="approval-box"><p class="approval-msg">Roteamento: esta Run não apareceu na leitura agora.</p>${msg}</div>`;
    const s = d.snapshot || {};
    const drift = d.policy_drift?.status === 'DIFFERENT'
      ? `<p class="approval-msg">${d.policy_drift.current ? `Vigente hoje: ${esc(d.policy_drift.current.version)}.` : `Configuração vigente: ${esc(d.policy_drift.current_mode)}.`} Esta Run segue o próprio snapshot, sem religação.</p>` : '';
    const ns = d.not_started === 'UNKNOWN'
      ? '<p class="approval-msg">Recusas não verificadas: o leitor de roteamento não respondeu.</p>'
      : Array.isArray(d.not_started) && d.not_started.length
        ? `<ul class="rtr-list">${d.not_started.map(n => `<li>‖ <b>${esc(n.node)}</b> não iniciou: <code>${esc(n.cause)}</code>${n.detail ? ` · ${esc(n.detail)}` : ''} · ${esc(when(n.at) || 'quando: desconhecido')}</li>`).join('')}</ul>` : '';
    const ovs = (d.overrides || []).length
      ? `<details class="auth-history" open><summary>Overrides (${d.overrides.length})</summary><ul>${d.overrides.map(o =>
        `<li><code>${esc(o.ref)}</code> ${esc(o.scope)}${o.node ? `:${esc(o.node)}` : ''} → ${esc(o.value.model_id)} / ${esc(o.value.effort)} · ${esc(o.by)} · ${esc(when(o.recorded_at) || o.recorded_at)} · <b>${o.status === 'APPLIED' ? 'aplicada' : 'ainda não aplicada'}</b></li>`).join('')}</ul></details>` : '';
    return `
      <div class="approval-box rtr-box" role="note">
        <h4>Roteamento de modelo</h4>
        <p>Snapshot <code>${esc(s.sha_short || '?')}</code>${s.policy_ref ? ` · policy <b>${esc(s.policy_ref.id)}@${esc(s.policy_ref.version)}</b>` : ''} · ${s.integrity === 'ok' ? 'íntegro' : `integridade: ${esc(s.integrity || 'desconhecida')}`}</p>
        ${drift}${ns}${ovs}
        ${formHtml(r, u, d)}
        ${msg}
      </div>`;
  }

  function readForm(taskId) {
    const u = ui(taskId);
    const f = u.form;
    for (const [id, key] of [['rtrScope', 'scope'], ['rtrNode', 'node'], ['rtrModel', 'model'], ['rtrEffort', 'effort']]) {
      const v = $(id)?.value;
      if (typeof v === 'string' && v) f[key] = v;
    }
  }

  async function save(taskId) {
    const u = ui(taskId);
    const f = u.form;
    const decision = { scope: f.scope, ...(f.scope === 'node' ? { node: f.node } : {}), model_id: f.model, effort: f.effort };
    const target = f.scope === 'node' ? `nó ${f.node}` : 'toda a Run';
    if (!confirm(`Gravar override de roteamento em ${taskId} (${target}): ${f.scope === 'node' ? f.node : 'ticket'} → ${f.model} / ${f.effort}?\n\nVale a partir do próximo limite de nó. O writer confere o modelo e o esforço contra o snapshot desta Run.`)) return;
    // Mesmo operation_id enquanto a decisão for a mesma e o desfecho for incerto.
    const key = JSON.stringify(decision);
    if (!u.op || u.op.key !== key) u.op = { key, id: StateVersion.newOperationId() };
    u.busy = true; u.msg = ''; rerender(taskId);
    try {
      const body = StateVersion.casBody(runs.get(taskId), { ...decision, operation_id: u.op.id });
      let res, out;
      try {
        res = await fetch(`/api/runs/${encodeURIComponent(taskId)}/routing-override`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        out = await res.json().catch(() => ({}));
      } catch (e) {
        u.msgCls = 'err';
        u.msg = `Resultado incerto (${e.message}): a override pode ter sido gravada. Tente de novo sem mudar nada; a mesma operação é reaproveitada e não grava duas vezes.`;
        return;
      }
      // O operation_id só morre com desfecho CERTO: 2xx ou recusa do writer com código
      // (4xx + code). 5xx é incerto (pode ter gravado antes de falhar): mantém a mesma
      // operação para o reenvio (revisão do Checkpoint B, MAJOR-2).
      if (res.status >= 500) {
        u.msgCls = 'err';
        u.msg = `Resultado incerto (HTTP ${res.status}): a override pode ter sido gravada. Tente de novo sem mudar nada; a mesma operação é reaproveitada e não grava duas vezes.`;
        return;
      }
      if (res.ok || out.code) u.op = null;
      if (!res.ok) {
        const hint = CODE_HINT[out.code];
        u.msgCls = 'err';
        u.msg = `Recusado${out.code ? ` (${out.code})` : ` (HTTP ${res.status})`}: ${out.error || hint || 'sem detalhe'}${hint && out.error ? ` — ${hint}` : ''}`;
        return;
      }
      u.msgCls = 'ok';
      u.msg = out.status === 'already_processed'
        ? 'Esta override já tinha sido gravada antes (mesma operação): nada foi gravado de novo.'
        : `Override ${out.override?.ref || ''} gravada: ${target} → ${f.model} / ${f.effort}. Vale a partir do próximo limite de nó.`;
    } finally {
      u.busy = false;
      await load(taskId, true);
    }
  }

  window.RoutingRun = {
    html(r) {
      if (!relevant(r)) return '';
      return `<div id="routingRunBox">${inner(r)}</div>`;
    },
    wire(r) {
      if (!relevant(r)) return;
      const box = $('routingRunBox');
      box?.addEventListener('input', () => readForm(r.taskId));
      box?.addEventListener('change', () => { readForm(r.taskId); rerender(r.taskId); });
      box?.addEventListener('click', e => {
        const b = e.target.closest('[data-rtr]');
        if (!b || b.disabled) return;
        readForm(r.taskId);
        if (b.dataset.rtr === 'save') save(r.taskId);
      });
      load(r.taskId, false);
    },
  };
})();
