// View "Roteamento de modelo" (telas de roteamento, PRI-205; T5): GET /api/routing.
// Padrão das views de Operação (Coordenação, Medição de modelo): módulo próprio,
// load()/render() em DOM, plugado em Views. Estilos: screens/routing.css.
// Só projeta o que o servidor devolve: nunca calcula classe nem resolve modelo, e
// ausência de dado aparece como desconhecida ou "sem preço", nunca como 0 ou OFF.
(() => {
  let data, error, loading = false, reload = false;
  let runFilter = 'all';
  // Aba atual. 'sombra' também é pedida pelo atalho #medicao-modelo (views.js deixa
  // window.RoutingTabRequest, consumido no próximo render; não depende da ordem dos scripts).
  let tab = 'hoje';
  const TABS = [['hoje', 'Hoje'], ['sombra', 'Sombra × real']];
  function showTab(key) {
    if (!TABS.some(([k]) => k === key)) return;
    tab = key;
    if (key === 'sombra') window.WouldRouteMetricsView?.load();
    window.Views?.refresh();
  }

  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const txt = t => document.createTextNode(t);
  const money = n => (n == null ? 'sem preço' : `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`);
  const pct = n => (n == null ? '—' : `${Math.round(n * 100)}%`);
  const when = iso => {
    if (!iso || iso === 'UNKNOWN') return 'quando: desconhecido';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'quando: desconhecido' : d.toLocaleString('pt-BR');
  };
  const known = v => v != null && v !== 'UNKNOWN';

  async function load() {
    if (loading) { reload = true; return; }
    loading = true;
    window.Views?.refresh();
    try {
      data = await api('/api/routing');
      error = null;
    } catch (e) {
      data = null;
      error = e?.message || 'Não foi possível carregar o roteamento de modelo.';
    } finally {
      loading = false;
      window.Views?.refresh();
      if (reload) { reload = false; load(); }
    }
  }

  // ── estado da Run (glifo + texto: nunca só cor) ────────────────────────────────
  const refused = r => Array.isArray(r.not_started) && r.not_started.length > 0;
  const brokenSnapshot = r => r.mode === 'ON' && r.snapshot && r.snapshot.integrity !== 'ok';
  function runState(r) {
    if (r.mode === 'UNKNOWN') return { k: 'unknown', glyph: '?', label: 'desconhecido' };
    if (r.mode === 'OFF') return { k: 'off', glyph: '○', label: 'sem roteamento' };
    if (refused(r) || brokenSnapshot(r)) return { k: 'refused', glyph: '‖', label: 'roteada, com recusa' };
    // Recusas não verificadas (leitor fora do ar) não podem virar "✓" (revisão do Checkpoint B, MINOR-5).
    if (r.not_started === 'UNKNOWN') return { k: 'unknown', glyph: '?', label: 'roteada, recusas desconhecidas' };
    return { k: 'on', glyph: '✓', label: 'roteada' };
  }
  const FILTERS = [
    ['all', 'Todas', () => true],
    ['on', 'Roteadas', r => r.mode === 'ON'],
    ['off', 'Sem roteamento', r => r.mode === 'OFF'],
    ['refused', 'Com recusa', r => refused(r) || brokenSnapshot(r)],
    ['override', 'Com override', r => Array.isArray(r.overrides) && r.overrides.length > 0],
    ['unknown', 'Desconhecidas', r => r.mode === 'UNKNOWN' || r.not_started === 'UNKNOWN'],
  ];

  // ── configuração e policy ──────────────────────────────────────────────────────
  function configCard(cfg, reader) {
    const panel = el('section', null, 'panel rt-config');
    panel.setAttribute('aria-labelledby', 'rtConfigTitle');
    const head = el('div', null, 'panel-head');
    const h = el('h3', 'Configuração do projeto', 't-heading');
    h.id = 'rtConfigTitle';
    head.append(h);
    panel.append(head);
    const body = el('div', null, 'rt-body');
    panel.append(body);
    const mode = cfg?.mode || 'UNKNOWN';
    if (mode === 'OFF') {
      body.append(el('p', 'Roteamento desligado', 'rt-state rt-state-off'));
      body.append(el('p', cfg.source === 'absent'
        ? 'O projeto está sem .claude/model-routing.json: todo despacho segue o modelo herdado da conta, como antes.'
        : 'O projeto declara mode OFF: todo despacho segue o modelo herdado da conta, como antes.', 'rt-muted'));
      return panel;
    }
    if (mode === 'INVALID') {
      body.append(el('p', 'Configuração inválida', 'rt-state rt-state-refused'));
      const p = el('p', null);
      p.append(el('code', cfg.invalid?.cause || 'UNKNOWN'), txt(cfg.invalid?.detail ? ` · ${cfg.invalid.detail}` : ''));
      body.append(p);
      body.append(el('p', `Runs novas não são admitidas até corrigir .claude/model-routing.json (ou usar mode OFF). Runs já admitidas mantêm o próprio snapshot.${cfg.invalid?.transient ? ' A falha parece passageira (leitura de disco).' : ''}`, 'rt-muted'));
      return panel;
    }
    if (mode !== 'ON' || !cfg.policy) {
      body.append(el('p', 'Estado desconhecido', 'rt-state rt-state-unknown'));
      body.append(el('p', reader === 'FAILED'
        ? 'Não deu para ler a configuração agora. Nada aqui significa roteamento desligado.'
        : 'A configuração não pôde ser interpretada.', 'rt-muted'));
      return panel;
    }
    const p = cfg.policy;
    body.append(el('p', 'Roteamento ligado', 'rt-state rt-state-on'));
    const meta = el('dl', null, 'rt-meta');
    const item = (k, v) => { const d = el('div'); d.append(el('dt', k), el('dd', v)); meta.append(d); };
    item('Policy', `${p.id}@${p.version}`);
    item('SHA-256', p.sha_short);
    item('Status', p.status);
    item('Aprovação', p.approval ? `${p.approval.by} · ${p.approval.at}` : 'não registrada');
    item('Classificador', p.classifier_provider);
    body.append(meta);

    const wrap = el('div', null, 'rt-scroll');
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Policy: classe, tier, modelo e esforço');
    wrap.setAttribute('tabindex', '0');
    const table = el('table', null, 'table rt-table');
    table.append(el('caption', 'Classe → tier → modelo → esforço declarado'));
    const thead = el('thead');
    const hr = el('tr');
    for (const c of ['Classe', 'Tier', 'Modelo', 'Esforço declarado']) { const th = el('th', c); th.setAttribute('scope', 'col'); hr.append(th); }
    thead.append(hr);
    const tbody = el('tbody');
    for (const row of p.classes || []) {
      const tr = el('tr');
      const th = el('th', row.class); th.setAttribute('scope', 'row');
      tr.append(th, el('td', row.tier), el('td', row.models?.length ? row.models.join(', ') : 'nenhum modelo declarado'), el('td', row.effort));
      tbody.append(tr);
    }
    const dr = el('tr', null, 'rt-default');
    const drh = el('th', 'Padrão (default_route)'); drh.setAttribute('scope', 'row');
    dr.append(drh, el('td', p.default_route?.tier), el('td', p.default_route?.model_id), el('td', p.default_route?.effort));
    tbody.append(dr);
    table.append(thead, tbody);
    wrap.append(table);
    body.append(wrap);
    if (p.effort_applied === false) {
      body.append(el('p', 'Esforço declarado, não aplicado: o despacho leva só --model (SP-1). O esforço da tabela fica registrado para quando houver mecanismo verificado.', 'rt-note'));
    } else if (p.effort_applied !== true) {
      body.append(el('p', 'Se o esforço é aplicado: desconhecido.', 'rt-note'));
    }
    return panel;
  }

  // ── admissão recusada ──────────────────────────────────────────────────────────
  const NOTICE = {
    SENT: 'aviso enviado ao Redmine',
    FAILED: 'aviso ao Redmine falhou',
    UNCERTAIN: 'aviso com resultado incerto (não será repetido às cegas)',
    PENDING: 'aviso ainda não enviado',
  };
  function admissionCard(b) {
    const panel = el('section', null, 'panel rt-admission');
    panel.setAttribute('aria-labelledby', 'rtAdmTitle');
    const head = el('div', null, 'panel-head');
    const h = el('h3', 'Admissão recusada', 't-heading');
    h.id = 'rtAdmTitle';
    head.append(h);
    panel.append(head);
    const body = el('div', null, 'rt-body');
    const cause = el('p', null);
    cause.append(el('span', '‖ ', 'rt-glyph rt-state-refused'), el('code', b.cause), txt(b.detail ? ` · ${b.detail}` : ''));
    body.append(cause);
    body.append(el('p', `Tickets barrados: ${b.tickets.length ? b.tickets.map(t => `#${t}`).join(', ') : 'nenhum listado'}.`));
    body.append(el('p', `Desde ${when(b.first_blocked_at)} · ${NOTICE[b.notice?.status] || 'estado do aviso desconhecido'}${b.notice?.attempts != null ? ` (${b.notice.attempts} tentativa(s))` : ''}${b.transient ? ' · falha passageira' : ''}.`, 'rt-muted'));
    panel.append(body);
    return panel;
  }

  // ── Runs ───────────────────────────────────────────────────────────────────────
  const OVERRIDE_STATUS = { APPLIED: 'aplicada', NOT_APPLIED: 'ainda não aplicada' };
  function runCard(r) {
    const st = runState(r);
    const card = el('li', null, `rt-run rt-run-${st.k}`);
    const head = el('div', null, 'rt-run-head');
    const glyph = el('span', st.glyph, `rt-glyph rt-state-${st.k}`);
    glyph.setAttribute('role', 'img');
    glyph.setAttribute('aria-label', st.label);
    const open = el('button', r.task_id, 'linkish rt-open');
    open.type = 'button';
    open.dataset.open = r.task_id;
    head.append(glyph, open, el('span', `${st.label}${r.ticket_id != null ? ` · #${r.ticket_id}` : ''}`, 'rt-muted'));
    card.append(head);

    if (r.mode === 'UNKNOWN' && r.error) {
      card.append(el('p', `Não deu para ler esta Run (${r.error}).`, 'rt-muted'));
      return card;
    }
    if (r.snapshot) {
      const s = r.snapshot;
      const line = el('p', null, 'rt-line');
      line.append(txt(`Snapshot ${s.sha_short}`), txt(s.policy_ref ? ` · policy ${s.policy_ref.id}@${s.policy_ref.version}` : ''),
        txt(s.integrity === 'ok' ? ' · íntegro' : ` · integridade: ${s.integrity}`));
      card.append(line);
      const d = r.policy_drift;
      if (d?.status === 'DIFFERENT') {
        card.append(el('p', d.current
          ? `Esta Run usa ${s.policy_ref?.version || 'policy desconhecida'}; vigente ${d.current.version}. Sem religação: a Run segue o próprio snapshot.`
          : `A configuração vigente está ${d.current_mode}; esta Run segue o próprio snapshot.`, 'rt-note'));
      } else if (d?.status === 'UNKNOWN') {
        card.append(el('p', 'Comparação com a policy vigente: desconhecida.', 'rt-muted'));
      }
    }
    if (r.selection_sources) {
      const parts = Object.entries(r.selection_sources).map(([k, v]) => `${k} ${v}`);
      card.append(el('p', `Decisões: ${parts.length ? parts.join(' · ') : 'nenhuma ainda'}${r.attempts_without_decision ? ` · ${r.attempts_without_decision} Attempt(s) sem decisão` : ''}`, 'rt-line'));
    }
    if (r.not_started === 'UNKNOWN') {
      card.append(el('p', 'Recusas não verificadas: o leitor de roteamento não respondeu.', 'rt-muted'));
    } else if (refused(r)) {
      const ul = el('ul', null, 'rt-sublist');
      for (const n of r.not_started) {
        const li = el('li');
        li.append(el('span', '‖ ', 'rt-glyph rt-state-refused'), txt(`${n.node} não iniciou: `), el('code', n.cause),
          txt(`${n.detail ? ` · ${n.detail}` : ''} · ${when(n.at)}${n.would_model ? ` · iria para ${n.would_model}` : ''}`));
        ul.append(li);
      }
      card.append(ul);
    }
    if (Array.isArray(r.overrides) && r.overrides.length) {
      const ul = el('ul', null, 'rt-sublist');
      for (const o of r.overrides) {
        ul.append(el('li', `${o.ref} · ${o.scope}${o.node ? `:${o.node}` : ''} → ${o.value.model_id} / ${o.value.effort} · por ${o.by} · ${when(o.recorded_at)} · ${OVERRIDE_STATUS[o.status] || o.status}`));
      }
      card.append(el('p', 'Overrides', 'label'), ul);
    }
    if (Array.isArray(r.models) && r.models.length) {
      const ul = el('ul', null, 'rt-sublist rt-models');
      for (const m of r.models) {
        const li = el('li');
        const observed = m.observed_main.length ? m.observed_main.join(', ') : 'não observado';
        li.append(el('strong', m.node), txt(m.routed ? ` · pedido ${m.requested_model} · observado ${observed}` : ` · não roteado · observado ${observed}`));
        if (m.mismatch === true) li.append(el('span', ' · diferente do pedido', 'rt-warn'));
        else if (m.mismatch === 'UNKNOWN') li.append(el('span', ' · comparação desconhecida', 'rt-muted'));
        li.append(txt(` · ${money(m.cost_usd)}`));
        ul.append(li);
      }
      card.append(ul);
    }
    return card;
  }

  function runsSection(runs, total) {
    const panel = el('section', null, 'panel rt-runs');
    panel.setAttribute('aria-labelledby', 'rtRunsTitle');
    const head = el('div', null, 'panel-head');
    const h = el('h3', 'Runs', 't-heading');
    h.id = 'rtRunsTitle';
    head.append(h);
    panel.append(head);
    const bar = el('div', null, 'rt-filters');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Filtrar Runs');
    for (const [key, label, fn] of FILTERS) {
      const b = el('button', null, 'btn rt-filter');
      b.type = 'button';
      b.dataset.tfilter = `routing-${key}`;
      b.setAttribute('aria-pressed', String(runFilter === key));
      b.append(txt(`${label} `), el('span', String(runs.filter(fn).length), 'rt-count'));
      b.addEventListener('click', () => { runFilter = key; window.Views?.refresh(); });
      bar.append(b);
    }
    panel.append(bar);
    const fn = (FILTERS.find(f => f[0] === runFilter) || FILTERS[0])[2];
    const shown = runs.filter(fn);
    if (!shown.length) {
      panel.append(el('p', runs.length ? 'Nenhuma Run neste filtro.' : 'Nenhuma Run ativa.', 'rt-empty'));
    } else {
      const list = el('ul', null, 'rt-run-list');
      for (const r of shown) list.append(runCard(r));
      panel.append(list);
    }
    if (total > runs.length) panel.append(el('p', `Mostrando as ${runs.length} Runs mais recentes de ${total}.`, 'rt-muted rt-foot'));
    return panel;
  }

  // ── mistura de modelos ─────────────────────────────────────────────────────────
  function mixSection(mix) {
    const panel = el('section', null, 'panel rt-mix');
    panel.setAttribute('aria-labelledby', 'rtMixTitle');
    const head = el('div', null, 'panel-head');
    const h = el('h3', 'Mistura de modelos', 't-heading');
    h.id = 'rtMixTitle';
    head.append(h);
    panel.append(head);
    const body = el('div', null, 'rt-body');
    panel.append(body);
    const t = mix?.totals;
    if (!t || !t.attempts) {
      body.append(el('p', 'Nenhum Attempt nesta janela.', 'rt-empty'));
      return panel;
    }
    const ul = el('ul', null, 'rt-mix-list');
    for (const g of mix.by_requested) {
      const li = el('li', null, 'rt-mix-row');
      li.append(el('span', g.model === 'NOT_ROUTED' ? 'não roteado' : g.model, 'rt-mix-model'),
        el('span', `${g.attempts} Attempt(s) · ${pct(g.share_attempts)}`, 'rt-mix-n'),
        el('span', `${money(g.cost_usd)}${g.share_cost != null ? ` · ${pct(g.share_cost)} do custo com preço` : ''}${g.unpriced_attempts ? ` · ${g.unpriced_attempts} sem preço` : ''}`, 'rt-mix-cost'));
      ul.append(li);
    }
    body.append(ul);
    body.append(el('p', `${t.priced_attempts} de ${t.attempts} Attempts com preço · total com preço ${money(t.cost_usd)}. Custo do Attempt inteiro, agrupado pelo modelo pedido; o classificador fica fora da conta.`, 'rt-muted'));
    return panel;
  }

  // ── seletor do classificador (T7b; SPEC §3.5) ──────────────────────────────────
  // Contrato da sessão do Jev: GET/POST /api/routing/classifier. A tela só projeta: as
  // opções e os motivos de recusa vêm de options[], e quem valida é o writer. "Enviado"
  // até a resposta; "aplicado" só depois do 200. Mesmo operation_id no reenvio enquanto
  // o pedido for o mesmo e o desfecho for incerto.
  const cls = { data: undefined, error: null, loading: false, missing: false, form: { option: null, reason: '' }, op: null, busy: false, msg: '', msgCls: '' };
  const CLS_OPTIONS = [
    ['policy_only', 'policy_only', null, 'Só policy', 'Só o núcleo 1 (as regras da policy). O Jev não é chamado.'],
    ['policy_jev:shadow', 'policy_jev', 'shadow', 'Policy + Jev (sombra)', 'O Jev opina e a opinião fica registrada, sem efeito no modelo escolhido.'],
    ['policy_jev:active', 'policy_jev', 'active', 'Policy + Jev (ativo)', 'A opinião do Jev pode mudar a classe. Só com calibração aprovada (D20).'],
  ];
  const CLS_HINT = {
    CLASSIFIER_VERSION_CONFLICT: 'a escolha mudou desde que a tela carregou; a tela foi atualizada',
  };
  const newOpId = () => (globalThis.crypto?.randomUUID?.() || `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const optionLabel = (choice, mode) => (CLS_OPTIONS.find(o => o[1] === choice && (o[2] === mode || (o[2] === null && choice === 'policy_only'))) || [])[3];

  async function loadClassifier() {
    if (cls.loading) return;
    cls.loading = true;
    try {
      const res = await fetch('/api/routing/classifier');
      cls.missing = res.status === 404;
      if (cls.missing) { cls.data = null; cls.error = null; }
      else if (!res.ok) throw new Error(`HTTP ${res.status}`);
      else { cls.data = await res.json(); cls.error = null; }
    } catch (e) { cls.error = e.message; cls.data = null; }
    cls.loading = false;
    window.Views?.refresh();
  }

  // Estado de cada opção, só a partir do que a API declarou.
  function optionState(d, key) {
    const [, choice, mode] = CLS_OPTIONS.find(o => o[0] === key);
    const opt = (d.options || []).find(o => o.choice === choice);
    if (!opt) return { allowed: false, refusal: null, detail: 'opção não oferecida pela API' };
    if (choice === 'policy_only') return { allowed: opt.allowed === true, refusal: opt.refusal || null, detail: opt.detail || null };
    const m = opt.modes?.[mode];
    if (!m) return { allowed: false, refusal: null, detail: 'modo não oferecido pela API' };
    return { allowed: m.allowed === true, refusal: m.refusal || null, detail: m.detail || null };
  }
  function isCurrent(d, key) {
    const c = d.current || {};
    if (c.source !== 'SELECTION') return false;
    const [, choice, mode] = CLS_OPTIONS.find(o => o[0] === key);
    return c.choice === choice && (choice === 'policy_only' || c.mode === mode);
  }
  function sendBlock(d) {
    const key = cls.form.option;
    if (cls.busy) return 'Enviado. Aguardando a resposta do writer…';
    if (!key) return 'Escolha uma opção.';
    if (!optionState(d, key).allowed) return 'Esta opção está recusada pela API agora (motivo ao lado).';
    if (isCurrent(d, key)) return 'Esta opção já é a escolha atual.';
    if (!cls.form.reason.trim()) return 'Escreva o motivo da troca (vai para o histórico).';
    return '';
  }

  function classifierCard() {
    const panel = el('section', null, 'panel rt-classifier');
    panel.setAttribute('aria-labelledby', 'rtClsTitle');
    const head = el('div', null, 'panel-head');
    const h = el('h3', 'Classificador (núcleo 2)', 't-heading');
    h.id = 'rtClsTitle';
    head.append(h);
    panel.append(head);
    const body = el('div', null, 'rt-body');
    panel.append(body);
    if (cls.data === undefined && !cls.loading && !cls.error && !cls.missing) loadClassifier();
    if (cls.missing) {
      body.append(el('p', 'Seletor do classificador indisponível neste Dashboard: o endpoint /api/routing/classifier ainda não existe. Nada aqui foi alterado.', 'rt-muted'));
      return panel;
    }
    if (cls.error) {
      body.append(el('p', `Não deu para ler o classificador (${cls.error}). Estado desconhecido.`, 'rt-muted'));
      return panel;
    }
    if (!cls.data) {
      body.append(el('p', 'Carregando o classificador…', 'rt-muted'));
      return panel;
    }
    const d = cls.data;
    const c = d.current || {};
    if (c.source === 'INVALID') {
      // Registro ilegível: a API declara o motivo; a tela não deduz qual é a escolha.
      const p = el('p', null, 'rt-state rt-state-refused');
      p.append(txt('Registro de seleção ilegível: '), el('code', c.reason || 'CLASSIFIER_SELECTION_INVALID'),
        txt(` · classificador efetivo informado pela API: ${c.provider || 'desconhecido'}. O writer decide se aceita uma troca agora.`));
      body.append(p);
    } else {
      const curLabel = c.source === 'POLICY'
        ? `definido pela policy (${c.provider || 'desconhecido'})`
        : optionLabel(c.choice, c.mode) || `desconhecido (${c.choice || '?'}/${c.mode || '?'})`;
      body.append(el('p', `Atual: ${curLabel} · versão ${c.version ?? '?'}${c.by ? ` · por ${c.by}` : ''}${c.at ? ` · ${when(c.at)}` : ''}${c.reason ? ` · “${c.reason}”` : ''}`, 'rt-state'));
    }
    body.append(el('p', 'Vale só para Runs novas. Runs já admitidas mantêm o classificador do próprio snapshot.', 'rt-note'));
    if (d.registry_git_ignored === false) {
      body.append(el('p', 'Atenção: o registro memory/routing/classifier-selection.json não está ignorado pelo git do projeto consumidor. A escolha pode entrar num commit do consumidor; inclua-o no .gitignore.', 'rt-banner'));
    }
    if (d.routing_mode === 'OFF') body.append(el('p', 'O roteamento deste projeto está desligado: a escolha fica registrada, mas não muda nenhum despacho enquanto ele estiver OFF.', 'rt-muted'));

    const group = el('div', null, 'rt-cls-options');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Classificador para Runs novas');
    const hint = el('p', null, 'rt-muted rt-cls-hint');
    hint.setAttribute('role', 'status');
    const send = el('button', null, 'btn rt-cls-send');
    send.type = 'button';
    send.dataset.clsAction = 'send';
    const refresh = () => {
      const why = sendBlock(d);
      send.disabled = !!why;
      send.textContent = cls.busy ? 'Enviado…' : 'Enviar troca';
      hint.textContent = why;
    };
    for (const [key, , , label, desc] of CLS_OPTIONS) {
      const st = optionState(d, key);
      const row = el('label', null, `rt-cls-option${st.allowed ? '' : ' is-disabled'}`);
      const input = el('input');
      input.type = 'radio';
      input.name = 'rtClsOption';
      input.value = key;
      input.dataset.clsOption = key;
      input.disabled = !st.allowed || cls.busy;
      input.checked = cls.form.option === key;
      input.addEventListener('change', () => { cls.form.option = key; refresh(); });
      const text = el('span', null, 'rt-cls-text');
      text.append(el('strong', `${label}${isCurrent(d, key) ? ' · atual' : ''}`), el('span', desc, 'rt-muted'));
      if (!st.allowed) {
        const why = el('span', null, 'rt-cls-refusal');
        why.append(txt('Recusado agora: '), el('code', st.refusal || 'sem código'), txt(st.detail ? ` · ${st.detail}` : ''));
        text.append(why);
      }
      row.append(input, text);
      group.append(row);
    }
    body.append(group);

    const reason = el('textarea', null, 'rt-cls-reason');
    reason.dataset.clsField = 'reason';
    reason.rows = 2;
    reason.value = cls.form.reason;
    reason.setAttribute('aria-label', 'Motivo da troca');
    reason.addEventListener('input', e => { cls.form.reason = e.target.value; refresh(); });
    const reasonLabel = el('label', 'Motivo (vai para o histórico)', 'rt-cls-field');
    reasonLabel.append(reason);
    const creds = el('div', null, 'rt-cls-creds');
    creds.append(send);
    body.append(reasonLabel, creds, hint);
    send.addEventListener('click', () => { if (!send.disabled) sendClassifier(d); });
    refresh();
    if (cls.msg) {
      const m = el('p', cls.msg, `rt-cls-msg ${cls.msgCls === 'ok' ? 'rt-state-on' : cls.msgCls === 'err' ? 'rt-warn' : ''}`);
      m.setAttribute('role', 'status');
      body.append(m);
    }
    const hist = Array.isArray(d.history) ? d.history : [];
    if (hist.length) {
      const det = el('details', null, 'rt-cls-history');
      det.append(el('summary', `Histórico (${hist.length})`));
      const ul = el('ul', null, 'rt-sublist');
      for (const v of hist) ul.append(el('li', `versão ${v.version} · ${optionLabel(v.choice, v.mode) || v.choice} · ${v.by || '?'} · ${when(v.at)}${v.reason ? ` · “${v.reason}”` : ''}`));
      det.append(ul);
      body.append(det);
    }
    return panel;
  }

  async function sendClassifier(d) {
    const key = cls.form.option;
    const [, choice, mode, label] = CLS_OPTIONS.find(o => o[0] === key);
    if (!confirm(`Trocar o classificador do projeto para "${label}"?\n\nVale só para Runs novas; Runs já admitidas não mudam. O writer confere autorização, calibração e versão antes de gravar.`)) return;
    const request = { choice, ...(mode ? { mode } : {}), expected_version: d.current && 'version' in d.current ? d.current.version : null, reason: cls.form.reason.trim() };
    const opKey = JSON.stringify(request);
    if (!cls.op || cls.op.key !== opKey) cls.op = { key: opKey, id: newOpId() };
    cls.busy = true; cls.msg = 'Enviado. Aguardando a resposta do writer…'; cls.msgCls = '';
    window.Views?.refresh();
    let res, out;
    try {
      res = await fetch('/api/routing/classifier', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, operation_id: cls.op.id }) });
      out = await res.json().catch(() => ({}));
    } catch (e) {
      cls.busy = false;
      cls.msgCls = 'err';
      cls.msg = `Resultado incerto (${e.message}): a troca pode ter sido gravada. Reenvie sem mudar nada; a mesma operação é reaproveitada e não grava duas vezes.`;
      window.Views?.refresh();
      return;
    }
    cls.busy = false;
    // Só desfecho CERTO encerra a operação: 2xx ou recusa do writer com código. 5xx é
    // incerto e mantém o mesmo operation_id para o reenvio (revisão do Checkpoint B, MAJOR-2).
    if (res.status >= 500) {
      cls.msgCls = 'err';
      cls.msg = `Resultado incerto (HTTP ${res.status}): a troca pode ter sido gravada. Reenvie sem mudar nada; a mesma operação é reaproveitada e não grava duas vezes.`;
      window.Views?.refresh();
      return;
    }
    if (res.ok || out.code) cls.op = null;
    if (res.ok && out.ok) {
      cls.msgCls = 'ok';
      cls.msg = out.status === 'already_processed'
        ? 'Esta troca já estava registrada (mesma operação): nada foi gravado de novo.'
        : `Aplicado: ${optionLabel(out.current?.choice, out.current?.mode) || label} (versão ${out.current?.version ?? '?'}). Vale para Runs novas.`;
      if (out.current && cls.data) cls.data = { ...cls.data, current: out.current };
      cls.form = { option: null, reason: '' };
    } else {
      const hint = CLS_HINT[out.code];
      cls.msgCls = 'err';
      cls.msg = `Recusado${out.code ? ` (${out.code})` : ` (HTTP ${res.status})`}: ${out.error || hint || 'sem detalhe'}${out.detail ? ` · ${out.detail}` : ''}${hint && out.error ? ` — ${hint}` : ''}`;
    }
    window.Views?.refresh();
    await loadClassifier();
  }

  // ── sombra S3 × despacho real ──────────────────────────────────────────────────
  const COMPARISON = {
    SAME: { glyph: '=', label: 'igual', k: 'on' },
    REAL_HIGHER: { glyph: '↑', label: 'real acima da sombra', k: 'unknown' },
    REAL_LOWER: { glyph: '↓', label: 'real abaixo da sombra', k: 'refused' },
    UNKNOWN: { glyph: '?', label: 'sem comparação', k: 'off' },
  };
  function shadowSection(svr) {
    const panel = el('section', null, 'panel rt-shadow');
    panel.setAttribute('aria-labelledby', 'rtShadowTitle');
    const head = el('div', null, 'panel-head');
    const h = el('h3', 'Sombra × real', 't-heading');
    h.id = 'rtShadowTitle';
    head.append(h);
    panel.append(head);
    const body = el('div', null, 'rt-body');
    panel.append(body);
    body.append(el('p', 'Por Attempt: a classe e o tier que a sombra S3 (would_route) teria escolhido, pela mesma regra do despacho (máximo dos grupos), contra a RoutingDecision real. A comparação é de tier, que é o que muda o modelo.', 'rt-muted'));
    body.append(el('p', 'Efeito na qualidade: não medido. Saber se a escolha da sombra daria o mesmo resultado exige rodar as duas, e isso é contrafactual.', 'rt-note'));
    const rows = Array.isArray(svr?.rows) ? svr.rows : [];
    if (!rows.length) {
      body.append(el('p', 'Nenhum Attempt com sombra ou decisão real ainda.', 'rt-empty'));
      return panel;
    }
    const sum = svr.summary || {};
    // Sem nenhuma decisão real, não há o que comparar: nada de "0 igual · 0 acima" (critério 1;
    // revisão do Checkpoint B, MINOR-6).
    if (!rows.some(r => r.real && typeof r.real === 'object')) {
      body.append(el('p', 'Sem comparação: nenhuma decisão real (roteamento desligado ou nenhum Attempt roteado ainda). A sombra aparece abaixo, Attempt por Attempt.', 'rt-muted'));
    } else {
      const counts = el('ul', null, 'rt-shadow-sum');
      counts.setAttribute('aria-label', 'Resumo da comparação');
      for (const key of ['SAME', 'REAL_HIGHER', 'REAL_LOWER', 'UNKNOWN']) {
        const c = COMPARISON[key];
        const li = el('li', null, `rt-shadow-n rt-state-${c.k}`);
        const g = el('span', c.glyph, 'rt-glyph');
        g.setAttribute('aria-hidden', 'true');
        li.append(g, txt(`${Number.isInteger(sum[key]) ? sum[key] : '?'} ${c.label}`));
        counts.append(li);
      }
      body.append(counts);
    }
    const list = el('ul', null, 'rt-sublist rt-shadow-list');
    for (const r of rows) {
      const c = COMPARISON[r.comparison] || COMPARISON.UNKNOWN;
      const li = el('li', null, 'rt-shadow-row');
      const open = el('button', r.task_id, 'linkish rt-open');
      open.type = 'button';
      open.dataset.open = r.task_id;
      const shadow = r.shadow && typeof r.shadow === 'object'
        ? (r.shadow.tier ? `sombra ${r.shadow.class || '?'} · ${r.shadow.tier}${r.shadow.policy_version ? ` (${r.shadow.policy_version})` : ''}` : `sombra sem decisão (${r.shadow.status})`)
        : 'sem sombra registrada';
      const real = r.real && typeof r.real === 'object'
        ? `real ${r.real.class || '?'} · ${r.real.tier || '?'} · ${r.real.model_id || '?'}`
        : 'sem decisão real (não roteado)';
      const g = el('span', `${c.glyph} `, `rt-glyph rt-state-${c.k}`);
      g.setAttribute('aria-hidden', 'true');
      li.append(open, txt(` · ${r.node} · ${shadow} · ${real} · `), g, el('strong', c.label));
      list.append(li);
    }
    body.append(list);
    return panel;
  }

  function tabBar() {
    const bar = el('div', null, 'rt-tabs');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Abas do roteamento');
    for (const [key, label] of TABS) {
      const b = el('button', label, 'rt-tab');
      b.type = 'button';
      b.id = `rtTab-${key}`;
      b.dataset.tfilter = `routing-tab-${key}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(tab === key));
      b.setAttribute('aria-controls', 'rtPanel');
      b.addEventListener('click', () => showTab(key));
      bar.append(b);
    }
    return bar;
  }

  function render() {
    if (window.RoutingTabRequest) {
      const req = window.RoutingTabRequest;
      window.RoutingTabRequest = null;
      if (TABS.some(([k]) => k === req)) tab = req;
    }
    if (!data && !error && !loading) load();
    const root = el('section', null, 'routing');
    const head = el('div', null, 'vhead rt-head');
    const title = el('div', null, 'rt-title');
    title.append(
      el('p', 'Operação · somente leitura', 'label'),
      el('h2', 'Roteamento de modelo', 't-title'),
      el('p', 'Para onde cada Run foi roteada e por quê: policy vigente, snapshot de cada Run, recusas e modelos usados.'),
    );
    const button = el('button', loading ? 'Carregando…' : 'Atualizar', 'btn lg');
    button.type = 'button';
    button.disabled = loading;
    button.addEventListener('click', () => { load(); loadClassifier(); if (tab === 'sombra') window.WouldRouteMetricsView?.load(); });
    head.append(title, button);
    root.append(head);
    root.append(tabBar());
    const panel = el('div', null, 'rt-panel');
    panel.id = 'rtPanel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `rtTab-${tab}`);
    root.append(panel);

    if (error || !data) {
      panel.append(el('p', error || 'Carregando…', 'vempty rt-empty'));
      return root;
    }
    if (data.reader === 'FAILED') {
      const b = el('p', null, 'rt-banner');
      b.setAttribute('role', 'status');
      b.append(el('strong', 'O leitor de roteamento não respondeu. '), txt('Configuração, snapshots e recusas aparecem como desconhecidos até a próxima atualização.'));
      panel.append(b);
    }
    if (tab === 'sombra') {
      panel.append(shadowSection(data.shadow_vs_real));
      // Medição em sombra S3 (antiga aba "Medição de modelo"), embutida sem reescrever.
      const s3 = window.WouldRouteMetricsView?.render();
      if (s3) {
        const wrap = el('section', null, 'rt-s3');
        wrap.setAttribute('aria-label', 'Medição em sombra (S3)');
        wrap.append(s3);
        panel.append(wrap);
      }
    } else {
      panel.append(configCard(data.config, data.reader));
      panel.append(classifierCard());
      if (data.admission_blocked) panel.append(admissionCard(data.admission_blocked));
      const runs = Array.isArray(data.runs) ? data.runs : [];
      panel.append(runsSection(runs, known(data.runs_total) ? data.runs_total : runs.length));
      panel.append(mixSection(data.mix));
    }
    root.append(el('p', `Atualizado em ${when(data.generated_at)}. Esta tela só lê: quem decide o modelo é o watcher, pelo snapshot de cada Run.`, 'source-note rt-foot'));
    return root;
  }

  window.RoutingView = { render, load, showTab };
})();
