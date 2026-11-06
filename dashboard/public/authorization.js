// Caixa "Autorização humana" no detalhe do run (PRI-180): pedido estruturado
// (state.pending_authorization, scripts/lib/authorization.js) com resumo, SQL com o
// conteúdo e o hash, e os botões Aprovar / Recusar / Já apliquei manualmente; e o
// desfecho "Devolver ao QA" (scripts/lib/qa-handback.js) para run blocked/pendente.
// Sem aprovador nem senha (decisão do Richard em 2026-11-06, até existirem roles): quem
// tem acesso local ao Dashboard decide, e a autoria é o usuário do sistema operacional.
// O banco alvo é escolhido aqui, na lista da allowlist (alias, rótulo, host/banco
// mascarados).
// O SQL e o pedido aparecem INTEGRAIS (sem redação); a tela mostra o request_hash do
// pedido para o banco escolhido e o devolve na aprovação — o servidor recusa se o
// pedido mudou (REQUEST_CHANGED). Antes de aprovar mostra o ticket e a nota da devolução.
// Script clássico carregado depois do principal; usa os globais runs, selected, esc,
// api, when, StateVersion e $. renderDetail() reescreve o #detail a cada atualização:
// html(r) devolve a caixa a partir do cache e wire(r) busca o detalhe quando a versão
// do run muda.
(() => {
  const cache = new Map(); // taskId → { version, data, loading, error, msg, msgCls, busy, opIds, handbackOpen }
  // Bancos da allowlist já carregados e o alvo escolhido.
  const cred = { targets: null, chosen: '' };
  const STATUS = 'authorization-pending';

  function ui(taskId) {
    if (!cache.has(taskId)) cache.set(taskId, { opIds: {} });
    return cache.get(taskId);
  }
  // Mesmo operation_id em todas as tentativas da mesma decisão até dar certo (um 502 do
  // handback pode ter gravado no Redmine; o servidor confere antes de repostar).
  function opId(u, action) {
    return (u.opIds[action] = u.opIds[action] || StateVersion.newOperationId());
  }
  function relevant(r) {
    const s = r?.state || {};
    return !r?.archived && !r?.pretask && (s.status === STATUS || s.status === 'blocked' || !!s.pending_authorization);
  }

  async function load(taskId, force) {
    const r = runs.get(taskId);
    const u = ui(taskId);
    const target = cred.chosen || '';
    if (!r || u.loading || (!force && u.version === r.stateVersion && u.target === target && u.data)) return;
    u.loading = true;
    try {
      u.data = await api(`/api/runs/${encodeURIComponent(taskId)}/authorization${target ? `?target=${encodeURIComponent(target)}` : ''}`);
      u.target = target;
      u.error = null;
      u.version = r.stateVersion;
    } catch (e) { u.error = e.message; }
    u.loading = false;
    rerender(taskId);
  }
  function rerender(taskId) {
    const box = $('authorizationBox');
    const r = runs.get(taskId);
    if (box && r && selected === taskId) box.innerHTML = inner(r);
  }

  const PHASE = {
    pending: 'aguardando sua decisão', executing: 'em execução', failed: 'falhou (nada foi aplicado ou a verificação não bateu)',
    uncertain: 'resultado INCERTO — confira no banco', handback: 'SQL ok — devolvendo ao QA', handback_failed: 'SQL ok — devolução ao QA falhou',
  };

  function pendingHtml(u, d) {
    const p = d.pending;
    const a = d.artifact || {};
    const ex = d.executor || { ok: true };
    const chosen = (cred.targets || []).find(t => t.alias === cred.chosen && t.selectable);
    const hashFor = d.request && (d.request.canonical.target || '') === (cred.chosen || '') ? d.request.request_hash : null;
    const problems = d.problems || [];
    const canApprove = p.phase === 'pending' && a.matches === true && !problems.length && !!chosen && !!hashFor && ex.ok && !u.busy;
    const canDecide = ['pending', 'failed', 'uncertain'].includes(p.phase) && !u.busy;
    const why = p.phase !== 'pending' ? '' : a.content == null ? (a.error || 'artefato indisponível') : a.matches !== true ? 'o conteúdo do SQL mudou depois do pedido — peça um novo pedido'
      : problems.length ? 'O SQL foi recusado pelas checagens (abaixo): não dá para aprovar.' : !ex.ok ? ex.error
        : !cred.targets ? 'Carregue os bancos para escolher o alvo.' : !chosen ? 'Escolha o banco alvo.' : !hashFor ? 'Atualizando o hash do pedido…' : '';
    const hb = p.then === 'handback_qa' ? d.handback?.preview : null;
    const hint = p.target_hint ? [p.target_hint.alias, p.target_hint.datasource && `datasource ${p.target_hint.datasource}`, p.target_hint.env].filter(Boolean).join(' · ') : '—';
    return `
      <h4>🔐 Autorização ${esc(p.id)} — ${esc(PHASE[p.phase] || p.phase)}</h4>
      <p>Ticket <b>#${esc(d.ticketId ?? '?')}</b> — ${esc(p.summary)}</p>
      <div class="approval-meta">
        <span>Tipo <b>${esc(p.kind)}</b></span>
        <span>Sugestão do agente <b>${esc(hint)}</b></span>
        ${p.target ? `<span>Alvo aprovado <b>${esc(p.target.alias)}</b></span>` : ''}
        <span>Pedido <b>${esc(when(p.requested_at) || '—')}</b> pelo nó <b>${esc(p.requested_by)}</b></span>
        <span>Depois <b>${esc(p.then === 'handback_qa' ? 'devolver ao QA' : p.then.replace('resume:', 'retomar em '))}</b></span>
      </div>
      <dl class="spec-change">
        <dt>Artefato</dt><dd><code>${esc(p.artifact)}</code>${a.matches === false ? ' <b class="err">— MUDOU depois do pedido</b>' : ''}</dd>
        <dt>sha256</dt><dd><code>${esc(p.artifact_sha256)}</code></dd>
        <dt>Verificação</dt><dd><pre class="draft-diff">${esc(p.verify_sql)}</pre></dd>
        <dt>Esperado</dt><dd>${esc(p.expected)}${p.expected_contains ? ` (saída deve conter <code>${esc(p.expected_contains)}</code>)` : ''}</dd>
        ${p.error ? `<dt>Erro</dt><dd class="err">${esc(p.error)}</dd>` : ''}
        ${p.last_result?.outputs ? `<dt>Saídas</dt><dd><code>memory/runs/${esc(d.taskId)}/${esc(p.last_result.outputs)}/</code></dd>` : ''}
        <dt>Hash do pedido</dt><dd><code>${esc(hashFor || '—')}</code> ${chosen ? `(para ${esc(chosen.label)})` : '(escolha o banco)'}</dd>
      </dl>
      <div class="auth-sql"><p><b>SQL que será executado — integral</b> (${esc(a.bytes ?? '?')} bytes; transação única, lock_timeout 5s, statement_timeout 60s)</p>
        ${a.content != null ? `<pre class="draft-diff" aria-label="Conteúdo do SQL">${esc(a.content)}</pre>` : `<p class="approval-msg err">${esc(a.error || 'artefato indisponível')}</p>`}
      </div>
      ${problems.length ? `<ul class="approval-msg err">${problems.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${hb ? `<details class="auth-handback-preview" open><summary>Depois do SQL: devolução ao QA no ticket #${esc(hb.ticketId ?? '?')} (Ag Teste)</summary><pre class="draft-diff">${esc(hb.notes || '')}</pre></details>` : ''}
      ${p.phase === 'pending' ? targetPicker() : ''}
      <div class="approval-actions">
        <button type="button" class="send" data-auth="approve" ${canApprove ? '' : 'disabled'} title="${esc(why || 'Executa o SQL no alvo da allowlist e confere antes/depois')}">${u.busy === 'approve' ? 'Executando…' : 'Aprovar e executar'}</button>
        <button type="button" class="ghost-btn" data-auth="reject" ${canDecide ? '' : 'disabled'}>Recusar</button>
        <button type="button" class="ghost-btn" data-auth="manual" ${canDecide ? '' : 'disabled'}>${u.busy === 'manual' ? 'Registrando…' : 'Já apliquei manualmente'}</button>
      </div>
      ${why ? `<p class="approval-msg">${esc(why)}</p>` : ''}`;
  }

  function credHtml() {
    return `<div class="approval-actions auth-cred" role="group" aria-label="Banco alvo">
        <button type="button" class="ghost-btn" data-auth="targets">Carregar bancos</button>
      </div>`;
  }
  function targetPicker() {
    if (!cred.targets) return '';
    const opts = cred.targets.map(t => `<option value="${esc(t.alias)}" ${t.selectable ? '' : 'disabled'} ${cred.chosen === t.alias ? 'selected' : ''}>${esc(t.label)} — ${esc(t.env)}${t.production ? ' · PRODUÇÃO' : ''} (${esc(t.database)} @ ${esc(t.host)})${t.selectable ? '' : ' — indisponível'}</option>`).join('');
    return `<label class="auth-field">Banco alvo (allowlist)<select id="authTarget"><option value="">— escolha —</option>${opts}</select></label>`;
  }

  function handbackHtml(u, d) {
    if (!d.handback?.available) return '';
    const pv = d.handback.preview || {};
    if (!u.handbackOpen) {
      return `<div class="approval-actions"><button type="button" class="ghost-btn" data-auth="handback-open" ${u.busy ? 'disabled' : ''}>↩ Devolver ao QA sem código</button>
        <span class="approval-msg">Ticket vai para Ag Teste com o resumo e o run é arquivado. Nenhum agente é despachado.</span></div>`;
    }
    return `
      <h4>↩ Devolver ao QA (ticket #${esc(pv.ticketId ?? '?')})</h4>
      <label class="auth-field">Nota no ticket<textarea id="authNotes" rows="6">${esc(pv.notes || '')}</textarea></label>
      <label class="auth-field">Apontamentos Desenvolvedor<textarea id="authApont" rows="6">${esc(pv.apontamentos || '')}</textarea></label>
      <div class="approval-actions">
        <button type="button" class="send" data-auth="handback" ${u.busy ? 'disabled' : ''}>${u.busy === 'handback' ? 'Enviando…' : 'Confirmar devolução'}</button>
        <button type="button" class="ghost-btn" data-auth="handback-close" ${u.busy ? 'disabled' : ''}>Cancelar</button>
      </div>`;
  }

  function historyHtml(d) {
    const h = d.history || [];
    if (!h.length) return '';
    return `<details class="auth-history"><summary>Histórico de autorizações (${h.length})</summary><ul>${h.slice(-20).map(e =>
      `<li><code>${esc(e.id)}</code> ${esc(e.event)} — ${esc(e.by || '?')}${e.via ? ` via ${esc(e.via)}` : ''} · ${esc(when(e.at) || e.at || '')}${e.reason ? ` · ${esc(e.reason)}` : ''}${e.error ? ` · ${esc(e.error)}` : ''}</li>`).join('')}</ul></details>`;
  }

  function inner(r) {
    const u = ui(r.taskId);
    const d = u.data;
    if (!d) return u.error ? `<div class="approval-box"><p class="approval-msg err">Autorização: ${esc(u.error)}</p></div>` : '';
    if (!d.pending && !d.handback?.available && !(d.history || []).length) return '';
    return `
      <div class="approval-box auth-box" role="note">
        ${credHtml()}
        ${d.pending ? pendingHtml(u, d) : ''}
        ${handbackHtml(u, d)}
        ${u.msg ? `<p class="approval-msg ${esc(u.msgCls || '')}" role="status">${esc(u.msg)}</p>` : ''}
        ${historyHtml(d)}
      </div>`;
  }

  function readCred() {
    cred.chosen = $('authTarget')?.value ?? cred.chosen;
  }
  function body(taskId, extra) {
    return JSON.stringify(StateVersion.casBody(runs.get(taskId), { ...extra }));
  }
  async function loadTargets(taskId) {
    const u = ui(taskId);
    try {
      const res = await fetch('/api/authorization/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      cred.targets = out.targets || [];
      const hint = u.data?.pending?.target_hint?.alias;
      if (!cred.chosen && hint && cred.targets.some(t => t.alias === hint && t.selectable)) cred.chosen = hint;
      u.msg = out.error ? out.error : cred.targets.length ? '' : 'Allowlist vazia: cadastre com scripts/lib/db-targets.js add.';
      u.msgCls = out.error ? 'err' : '';
    } catch (e) { cred.targets = null; u.msg = `Falha: ${e.message}`; u.msgCls = 'err'; }
    await load(taskId, true); // hash do pedido para o banco escolhido
  }
  async function post(taskId, pathSuffix, extra, action) {
    const u = ui(taskId);
    u.busy = action; u.msg = ''; rerender(taskId);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(taskId)}/${pathSuffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(taskId, { ...extra, operation_id: opId(u, action) }) });
      const out = await res.json().catch(() => ({}));
      if (StateVersion.isConflict(res.status, out)) markStale(selected);
      // Repetir com o mesmo id só quando o servidor pede (desfecho incerto).
      if (res.ok || !out.retry_same_operation) delete u.opIds[action];
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      u.msgCls = 'ok';
      return out;
    } catch (e) {
      u.msgCls = 'err'; u.msg = `Falha: ${e.message}`;
      return null;
    } finally {
      u.busy = null;
      await load(taskId, true);
    }
  }

  async function onClick(taskId, act) {
    const u = ui(taskId);
    const p = u.data?.pending;
    readCred();
    if (act === 'targets') return loadTargets(taskId);
    if (act === 'handback-open' || act === 'handback-close') { u.handbackOpen = act === 'handback-open'; return rerender(taskId); }
    if (act === 'approve') {
      const t = (cred.targets || []).find(x => x.alias === cred.chosen);
      const hash = u.data?.request?.canonical?.target === t?.alias ? u.data.request.request_hash : null;
      if (!t || !hash) return;
      if (!confirm(`Aprovar ${p.id} (ticket #${u.data.ticketId}) e executar o SQL agora em "${t.label}" (${t.env}${t.production ? ', PRODUÇÃO' : ''})?\n\nArquivo: ${p.artifact}\nHash do pedido: ${hash}\n\nO macOS vai pedir para liberar a senha do banco no Keychain: clique "Permitir" (nunca "Sempre Permitir").`)) return;
      const out = await post(taskId, 'authorization/approve', { authorization_id: p.id, request_hash: hash, target_alias: t.alias }, 'approve');
      if (out) u.msg = out.handback?.archived ? 'SQL aplicado e conferido; ticket devolvido ao QA e run arquivado.' : out.node ? `SQL aplicado e conferido; run retomado em ${out.node}.` : 'SQL aplicado.';
    } else if (act === 'reject') {
      const reason = prompt(`Motivo da recusa de ${p.id} (vai para o agente):`, '');
      if (reason === null) return;
      const out = await post(taskId, 'authorization/reject', { authorization_id: p.id, reason }, 'reject');
      if (out) u.msg = 'Pedido recusado. O run voltou para bloqueado: responda ao agente para seguir de outro jeito.';
    } else if (act === 'manual') {
      const t = (cred.targets || []).find(x => x.alias === cred.chosen && x.selectable);
      if (!confirm(`Confirmar que VOCÊ aplicou ${p.artifact} manualmente${t ? ` em "${t.label}"` : ''}?\n\n${t ? 'O Prisma roda só o verify_sql nesse banco para conferir' : 'Sem banco escolhido, não há conferência automática'}; depois segue "${p.then}".`)) return;
      const hash = (u.data?.request?.canonical?.target || null) === (t?.alias || null) ? u.data.request.request_hash : null;
      if (!hash) { u.msg = 'Escolha o banco de novo (ou nenhum) e espere o hash do pedido atualizar.'; u.msgCls = 'err'; return rerender(taskId); }
      const out = await post(taskId, 'authorization/manual', { authorization_id: p.id, request_hash: hash, ...(t ? { target_alias: t.alias } : {}) }, 'manual');
      if (out) u.msg = out.handback?.archived ? 'Aplicação manual registrada; ticket devolvido ao QA e run arquivado.' : 'Aplicação manual registrada.';
    } else if (act === 'handback') {
      if (!confirm('Devolver o ticket ao QA (Ag Teste) com a nota e os apontamentos acima e arquivar o run?')) return;
      const out = await post(taskId, 'handback-qa', { notes: $('authNotes')?.value, apontamentos: $('authApont')?.value }, 'handback');
      if (out) { u.msg = `Ticket #${out.ticketId} devolvido ao QA; run arquivado.`; u.handbackOpen = false; }
    }
    rerender(taskId);
  }

  window.Authorization = {
    html(r) {
      if (!relevant(r)) return '';
      return `<div id="authorizationBox">${inner(r)}</div>`;
    },
    wire(r) {
      if (!relevant(r)) return;
      // Re-render (WebSocket) recria os campos: o que foi digitado fica em cred.
      $('authorizationBox')?.addEventListener('input', readCred);
      $('authorizationBox')?.addEventListener('change', e => {
        readCred();
        if (e.target?.id === 'authTarget') load(r.taskId, true); else rerender(r.taskId);
      });
      $('authorizationBox')?.addEventListener('click', e => {
        const act = e.target.closest('[data-auth]')?.dataset.auth;
        if (act && !e.target.closest('[data-auth]').disabled) onClick(r.taskId, act);
      });
      load(r.taskId, false);
    },
  };
})();
