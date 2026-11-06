// Aba "Medição de modelo": GET /api/would-route-metrics — agrega would_route em sombra.
// Padrão Coordination/Watcher: módulo próprio, load()/render() DOM, plugado em Views.
// Estilos: screens/would-route.css. Só mede a sombra; nunca altera o despacho. Embutida na aba "Sombra × real" de Roteamento (routing.js).
(() => {
  let data, error, loading = false, reload = false;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const money = n => n == null
    ? 'sem medição'
    : `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  const num = n => (n == null ? '—' : String(n));

  async function load() {
    if (loading) { reload = true; return; }
    loading = true;
    try {
      data = await api('/api/would-route-metrics');
      error = null;
    } catch (e) {
      data = null;
      error = e?.message || 'Não foi possível carregar a medição de roteamento em sombra.';
    } finally {
      loading = false;
      window.Views?.refresh();
      if (reload) { reload = false; load(); }
    }
  }

  function kpi(label, value, hint) {
    const box = el('div', null, 'kpi wr-kpi');
    box.append(el('span', label, 'kpi-label'), el('span', value, 'kpi-value mono'));
    if (hint) box.append(el('span', hint, 'wr-kpi-hint'));
    return box;
  }

  function render() {
    if (!data && !error && !loading) load();
    const root = el('section', null, 'would-route');
    const head = el('div', null, 'vhead wr-head');
    const title = el('div', null, 'wr-title');
    title.append(
      el('p', 'Operação · somente leitura · sombra', 'label'),
      el('h2', 'Medição em sombra (S3)', 't-title'),
      el('p', 'O que o roteamento em sombra teria escolhido (leve / médio / Opus), sem trocar o modelo no despacho.'),
    );
    const actions = el('div', null, 'wr-actions');
    const button = el('button', loading ? 'Carregando…' : 'Atualizar', 'btn lg');
    button.type = 'button';
    button.disabled = loading;
    button.addEventListener('click', load);
    actions.append(button);
    head.append(title, actions);
    root.append(head);

    const banner = el('p', null, 'wr-banner');
    banner.setAttribute('role', 'status');
    banner.append(
      el('strong', 'Só medição em sombra. '),
      document.createTextNode('Esta seção mede would_route e nunca altera o despacho. O roteamento real (por projeto, com o snapshot de cada Run) está na aba Hoje.'),
    );
    root.append(banner);

    if (error || !data) {
      root.append(el('p', error || 'Carregando…', 'vempty wr-empty'));
      return root;
    }

    const c = data.counts || {};
    const by = c.by_faixa || {};
    const sav = data.savings_vs_opus_only || {};

    const summary = el('section', null, 'wr-summary');
    summary.setAttribute('aria-label', 'Contagem por faixa');
    const counts = el('div', null, 'kpis wr-counts');
    const diag = data.diagnosis || {};
    const semDecisaoHint = diag.code === 'CLASSIFIER_OFF'
      ? 'provider=off (esperado)'
      : diag.primary_cause
        ? String(diag.primary_cause)
        : 'sem decisões sombra';
    counts.append(
      kpi('Leve (T1)', num(by.leve), 'sairia do Opus'),
      kpi('Médio (T2)', num(by.medio), 'sairia do Opus'),
      kpi('Opus (T3)', num(by.opus), 'permaneceria'),
      kpi('Sem decisão', num(c.no_decision), semDecisaoHint),
    );
    summary.append(counts);
    summary.append(el('p',
      `Decisões sombra: ${num(c.decisions)} · sairiam do Opus: ${num(c.leaves_opus_tier)} · Attempts com would_route: ${num(c.attempts_with_would_route)}.`,
      'source-note'));
    root.append(summary);

    if (diag.title_pt) {
      const panel = el('section', null, 'panel wr-diagnosis');
      const head = el('div', null, 'panel-head');
      head.append(el('h3', 'Diagnóstico dos zeros', 't-heading'));
      panel.append(head);
      const body = el('div', null, 'wr-savings-body');
      body.append(el('p', diag.title_pt, 'wr-diagnosis-title'));
      if (diag.explanation_pt) body.append(el('p', diag.explanation_pt));
      if (diag.next_step_pt) {
        const next = el('p', null);
        next.append(el('strong', 'O que falta: '), document.createTextNode(diag.next_step_pt));
        body.append(next);
      }
      const causeBits = Object.entries(c.causes || {}).map(([k, v]) => `${k}=${v}`);
      if (causeBits.length) {
        body.append(el('p', `Causas nos Attempts sem decisão: ${causeBits.join(' · ')}.`, 'source-note'));
      }
      if (diag.policy_file) {
        body.append(el('p', `Arquivo da policy de sombra: ${diag.policy_file}`, 'source-note'));
      }
      body.append(el('p', 'A sombra não altera o despacho: o modelo real de cada Run aparece na aba Hoje.', 'source-note'));
      panel.append(body);
      root.append(panel);
    }

    const savings = el('section', null, 'panel wr-savings');
    const savHead = el('div', null, 'panel-head');
    savHead.append(el('h3', 'Economia potencial vs Opus-only — hipótese de preço, não custo real', 't-heading'));
    savings.append(savHead);
    const savBody = el('div', null, 'wr-savings-body');
    const grid = el('div', null, 'kpis wr-counts');
    grid.append(
      kpi('Custo Opus-only (observado)', money(sav.opus_only_usd), 'soma das cotas dos Attempts com decisão'),
      kpi('Custo se usasse a faixa sombra', money(sav.potential_usd), 'hipótese de preço por faixa'),
      kpi('Economia potencial', money(sav.potential_savings_usd), 'não é desembolso real'),
    );
    savBody.append(grid);
    if (sav.unknown_when) savBody.append(el('p', sav.unknown_when, 'wr-unknown'));
    const hyp = data.pricing_hypothesis;
    if (hyp) {
      savBody.append(el('p',
        `${hyp.description} Razões vs Opus: T1=${hyp.cost_ratio_vs_opus?.T1}, T2=${hyp.cost_ratio_vs_opus?.T2}, T3=${hyp.cost_ratio_vs_opus?.T3}. Fonte: ${hyp.source}.`,
        'source-note'));
    }
    savings.append(savBody);
    root.append(savings);

    const recent = el('section', null, 'panel wr-recent');
    const recentHead = el('div', null, 'panel-head');
    recentHead.append(el('h3', 'Lista recente', 't-heading'));
    recent.append(recentHead);
    const rows = Array.isArray(data.recent) ? data.recent : [];
    if (!rows.length) {
      recent.append(el('p', 'Nenhuma decisão sombra ainda. Com a policy em cheap_rule, feche novos Implements (Attempts antigos com CLASSIFIER_OFF não reclassificam).', 'wr-empty muted'));
    } else {
      const wrap = el('div', null, 'table-wrap wr-table-wrap');
      const table = el('table', null, 'table wr-table');
      const caption = el('caption', 'Decisões sombra recentes por subtarefa');
      table.append(caption);
      const thead = el('thead');
      const hr = el('tr');
      for (const h of ['Quando', 'Run', 'Subtarefa', 'Classe', 'Faixa', 'Regra', 'Sai do Opus?', 'Economia cotada']) {
        hr.append(el('th', h));
      }
      thead.append(hr);
      table.append(thead);
      const tbody = el('tbody');
      for (const r of rows) {
        const tr = el('tr');
        const when = r.observed_at ? new Date(r.observed_at).toLocaleString('pt-BR') : '—';
        tr.append(el('td', when));
        const runCell = el('td');
        const open = el('button', r.task_id, 'linkish wr-open');
        open.type = 'button';
        open.dataset.open = r.task_id;
        runCell.append(open);
        tr.append(runCell);
        tr.append(el('td', r.subtask_key || '—'));
        tr.append(el('td', r.class || '—'));
        const faixa = el('td', r.faixa_label || '—');
        faixa.className = `wr-faixa wr-faixa-${r.faixa || 'unknown'}`;
        tr.append(faixa);
        tr.append(el('td', r.rule || '—'));
        tr.append(el('td', r.leaves_opus_tier ? 'sim' : 'não'));
        const savCell = el('td', money(r.potential_savings_usd));
        savCell.className = 'n';
        tr.append(savCell);
        tbody.append(tr);
      }
      table.append(tbody);
      wrap.append(table);
      recent.append(wrap);
    }
    root.append(recent);

    if (c.applied_true_anomaly > 0) {
      root.append(el('p',
        `Atenção: ${c.applied_true_anomaly} registro(s) com applied=true — anomalia em S3 (sombra não deve aplicar).`,
        'wr-anomaly'));
    }

    root.append(el('p', data.note || '', 'source-note wr-foot'));
    return root;
  }

  window.WouldRouteMetricsView = { render, load };
})();
