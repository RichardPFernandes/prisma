// Visões extras do dashboard (abas): Quadro, Tabela, Linha do tempo, Métricas,
// Tickets e PRs, Grafo (esta em graph.js). Script clássico carregado depois do principal: usa os globais de lá
// (runs, NODES, NODE_LABEL, STATUS, esc, ago, when, titleOf, isHidden, isDone,
// needsYou, visibleRuns, extractPrs, prBadge, prState, ticketIdOfRun, ticketCache,
// prCache, apiStatus, select, setGroupOpen, GROUPS, prefs, persist, $,
// ticketStatusBadge, retryQaRejection, refreshRuns, toast).
(() => {
  const VIEWS = [
    ['runs', 'Runs'], ['quadro', 'Quadro'], ['tabela', 'Tabela'],
    ['timeline', 'Linha do tempo'], ['metricas', 'Métricas'], ['tickets', 'Tickets e PRs'],
    ['redmine', 'Redmine'], ['grafo', 'Grafo'], ['padroes', 'Padrões'], ['prs', 'PRs'],
    ['coordenacao', 'Coordenação'], ['roteamento', 'Roteamento de modelo'],
    ['versao', 'Versão'], ['computador', 'Este computador'],
  ];
  // Etapas agrupadas em 4 fases pra linha do tempo: 7 tons de um matiz não ficam
  // distinguíveis (validado), 4 ficam. O nome exato da etapa vai no tooltip.
  const PHASES = [
    { key: 'prep', label: 'Preparação', nodes: ['fetch_ticket', 'plan'] },
    { key: 'build', label: 'Construção', nodes: ['implement'] },
    { key: 'check', label: 'Validação', nodes: ['review', 'test', 'verify'] },
    { key: 'ship', label: 'Entrega', nodes: ['commit'] },
  ];
  const phaseOf = node => PHASES.findIndex(p => p.nodes.includes(node));
  const DAY = 86400000;

  // "Meus Tickets" virou "Redmine" (redmine.js): hash/pref antigos caem na aba nova.
  // #medicao-modelo virou a aba "Sombra × real" de Roteamento (telas de roteamento, T6).
  const alias = v => {
    if (v === 'my-tickets') return 'redmine';
    if (v === 'medicao-modelo') { window.RoutingTabRequest = 'sombra'; return 'roteamento'; }
    return v;
  };
  let view = VIEWS.some(([k]) => k === alias(location.hash.slice(1))) ? alias(location.hash.slice(1))
    : location.hash.startsWith('#run/') ? 'runs' : (VIEWS.some(([k]) => k === alias(prefs.view)) ? alias(prefs.view) : 'runs');
  const table = Object.assign({ sort: 'updated', dir: -1, status: 'all', node: 'all', pr: 'all', hidden: false }, prefs.table || {});
  const tl = Object.assign({ range: 30 }, prefs.timeline || {});
  const tk = Object.assign({ filter: 'all' }, prefs.tickets || {});
  let bulk = { running: false, done: 0, total: 0 };

  // ------------------------------------------------------------------ helpers
  const shownRuns = (includeHidden = false) => visibleRuns().filter(r => includeHidden || !isHidden(r));
  const ticketOf = r => { const t = titleOf(r); return { num: t.num, text: t.text, id: ticketIdOfRun(r) }; };
  const statusLabel = r => STATUS[r.status] || r.status;
  // Estado no design Espectro: glifo + cor, nunca só o matiz (✓ ◐ ‖ ✕ ○). O texto
  // continua o de STATUS (domínio); só a forma de mostrar muda.
  const STATE_GLYPH = { done: '✓', running: '◐', waiting: '‖', failed: '✕', queued: '○' };
  const stateKey = r => (r.status === 'committed' || isDone(r) ? 'done' : r.status === 'failed' ? 'failed'
    : needsYou(r) ? 'waiting' : r.status === 'running' ? 'running' : 'queued');
  const glyphOf = r => {
    const k = stateKey(r);
    return `<span class="rv-glyph ${k}" role="img" aria-label="${esc(statusLabel(r))}" title="${esc(statusLabel(r))}">${STATE_GLYPH[k]}</span>`;
  };
  const pillOf = r => { const k = stateKey(r); return `<span class="pill ${k}"><span aria-hidden="true">${STATE_GLYPH[k]}</span>${esc(statusLabel(r))}</span>`; };
  // Cabeçalho das visões: título, texto de apoio e ferramentas (filtros/ações) à direita.
  const vhead = (title, sub, tools = '') => `<header class="rv-head"><div class="rv-head-text"><h2 class="t-title">${title}</h2><p class="rv-sub">${sub}</p></div>${
    tools ? `<div class="rv-tools">${tools}</div>` : ''}</header>`;
  const stageOf = r => {
    if (r.status === 'committed' || isDone(r)) return 'done';
    if (NODES.some(([k]) => k === r.node)) return r.node;
    const h = (r.state?.history || []).filter(n => NODES.some(([k]) => k === n));
    return h.length ? h[h.length - 1] : 'fetch_ticket';
  };
  const retriesOf = r => Object.values(r.state?.retries || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const msgsOf = r => (r.state?.human_inputs || []).length;
  // Tokens totais (entrada + saída) de state.json.cost_tracking; null = sem medição
  // (run anterior ao rastreamento de custo, ou agente não reportou) — nunca 0.
  const usdOf = r => costOf(r)?.totals.cost_usd ?? null;
  const moneyTip = usd => (usd == null ? '' : `${fmtUsd(usd)}${fx?.rate ? ` · ${fmtBrl(usd)}` : ''}`);
  const tokensOf = r => {
    const t = costOf(r)?.totals;
    if (!t || (t.input_tokens == null && t.output_tokens == null)) return null;
    return (t.input_tokens || 0) + (t.output_tokens || 0);
  };
  function dur(ms) {
    if (!(ms >= 0)) return '—';
    const m = ms / 60000;
    if (m < 1) return '< 1 min';
    if (m < 60) return `${Math.round(m)} min`;
    const h = m / 60;
    if (h < 24) return `${h < 10 ? h.toFixed(1).replace('.', ',') : Math.round(h)} h`;
    const d = h / 24;
    return `${d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)} d`;
  }
  const prsOf = r => extractPrs(r.state?.pull_request);
  const openAttr = r => `data-open="${esc(r.taskId)}"`;

  function openRun(taskId) {
    const r = runs.get(taskId);
    if (r) {
      const g = GROUPS.find(x => (x.hidden ? isHidden(r) : !isHidden(r) && x.match(r)));
      if (g) setGroupOpen(g.key, true);
    }
    setView('runs');
    select(taskId);
  }

  // ------------------------------------------------------------------ tabs
  // Navegação lateral (design Espectro, AppNav): grupos com ícone por visão. Lista, Quadro,
  // Tabela e Linha do tempo são a mesma tela (Runs) e trocam pelo segmento do topo.
  const RUN_VIEWS = [['runs', 'Lista', 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
    ['quadro', 'Quadro', 'M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v7h-4z'], ['tabela', 'Tabela', 'M3 5h18v14H3zM3 10h18M9 10v9'],
    ['timeline', 'Linha do tempo', 'M3 6h8M7 12h10M5 18h14']];
  const NAV = [
    ['Trabalho', [
      ['runs', 'Runs', 'M3 12h4l3-8 4 16 3-8h4'],
      ['metricas', 'Métricas', 'M4 20V10M10 20V4M16 20v-7M22 20H2'],
      ['tickets', 'Tickets e PRs', 'M4 7h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4zM10 7v12'],
      ['redmine', 'Redmine', 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3'],
      ['prs', 'Pull requests', 'M6 3v12M18 9a3 3 0 0 1-3 3H9a3 3 0 0 0-3 3M6 18h.01M18 6h.01'],
    ]],
    ['Operação', [
      ['coordenacao', 'Coordenação', 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h4v6h-4zM19 16h2'],
      ['roteamento', 'Roteamento de modelo', 'M6 3v6a6 6 0 0 0 6 6h6M15 12l3 3-3 3M6 21h.01'],
      ['padroes', 'Padrões de falha', 'M12 3l9 16H3zM12 10v4M12 17h.01'],
    ]],
    ['Conhecimento', [['grafo', 'Grafo', 'M6 6.5h.01M18 5.5h.01M12 18.5h.01M7 7.5l4 9.2M17 6.8l-4 9.9M7.5 6l9-.2']]],
    ['Plataforma', [['versao', 'Versão', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2'], ['computador', 'Este computador', 'M4 5h16v11H4zM2 19h20']]],
  ];
  const navKeyOf = v => (RUN_VIEWS.some(([k]) => k === v) ? 'runs' : v);
  const icon = d => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

  // refresh() chama renderTabs a cada evento ao vivo: só reescreve o HTML quando ele muda,
  // e devolve o foco ao mesmo item, para não derrubar o foco do teclado nem um clique em curso.
  const lastHtml = new Map();
  function paint(id, html) {
    if (lastHtml.get(id) === html) return;
    lastHtml.set(id, html);
    const focused = document.activeElement?.closest?.(`#${id} [data-view]`)?.dataset.view;
    $(id).innerHTML = html;
    if (focused) $(id).querySelector(`[data-view="${focused}"]`)?.focus();
  }

  function renderTabs() {
    const cur = navKeyOf(view);
    // Mesmo total do título da aba (updateTitle): não varia com a busca.
    const waiting = [...runs.values()].filter(r => !isHidden(r) && needsYou(r)).length;
    // Atributos na ordem data-view, aria-selected: version-ui.test.js procura esse par.
    paint('tabs', NAV.map(([group, items]) => `<div class="nav-group" role="presentation">
      <span class="nav-group-label label" role="presentation">${group}</span>
      ${items.map(([k, label, d]) => `<button type="button" role="tab" class="nav-item" data-view="${k}" aria-selected="${k === cur}">${icon(d)}<span>${label}</span>${
        k === 'runs' && waiting ? `<span class="nav-count" title="${waiting} pedem você">${waiting}</span>` : ''}</button>`).join('')}
    </div>`).join(''));
    const [group, items] = NAV.find(([, its]) => its.some(([k]) => k === cur)) || NAV[0];
    $('crumbGroup').textContent = group;
    $('crumbView').textContent = (items.find(([k]) => k === cur) || [, 'Runs'])[1];
    renderRunViews();
  }
  // Segmento Lista · Quadro · Tabela · Linha do tempo no topo, só nas visões de Runs.
  function renderRunViews() {
    const seg = $('runViews');
    seg.hidden = navKeyOf(view) !== 'runs';
    paint('runViews', RUN_VIEWS.map(([k, label, d]) =>
      `<button type="button" role="tab" data-view="${k}" aria-selected="${k === view}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>${label}</button>`).join(''));
  }
  function setView(v) {
    v = alias(v);
    view = v; prefs.view = v; persist();
    const want = v === 'runs' ? (selected ? `#run/${encodeURIComponent(selected)}` : '') : `#${v}`;
    if (location.hash !== want) history.replaceState(null, '', want || location.pathname);
    document.body.dataset.view = v;
    renderTabs();
    refresh();
    if (v === 'tickets' && !bulk.running && !bulk.loadedOnce) loadAll(false);
    if (v === 'redmine') window.RedmineView?.load(false);
    if (v === 'coordenacao') window.CoordinationView?.load();
    if (v === 'roteamento') window.RoutingView?.load();
    if (v === 'versao') window.VersionView?.load(false);
    if (v === 'computador') window.OnboardingView?.load();
  }
  $('tabs').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  $('runViews').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  window.addEventListener('hashchange', () => { const v = alias(location.hash.slice(1)) || 'runs'; if (VIEWS.some(([k]) => k === v)) setView(v); });
  // #run/<id> é tratado em ux.js.

  $('view').addEventListener('click', e => {
    if (e.target.closest('a')) return;
    const o = e.target.closest('[data-open]');
    if (o) { openRun(o.dataset.open); return; }
    const act = e.target.closest('[data-vact]');
    if (act) handleAction(act.dataset.vact, act);
  });
  $('view').addEventListener('keydown', e => {
    const o = e.target.closest('[data-open]');
    if (o && e.target === o && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openRun(o.dataset.open); }
  });
  $('view').addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.tfilter) { table[el.dataset.tfilter] = el.type === 'checkbox' ? el.checked : el.value; prefs.table = table; persist(); refresh(); }
  });

  function handleAction(a, el) {
    if (a === 'sort') {
      const k = el.dataset.key;
      table.dir = table.sort === k ? -table.dir : (k === 'updated' || k === 'started' ? -1 : 1);
      table.sort = k; prefs.table = table; persist(); refresh();
    } else if (a === 'range') { tl.range = Number(el.dataset.range); prefs.timeline = tl; persist(); refresh(); }
    else if (a === 'tkfilter') { tk.filter = el.dataset.filter; prefs.tickets = tk; persist(); refresh(); }
    else if (a === 'loadall') loadAll(true);
    else if (a === 'toggledone') { prefs.boardDone = !prefs.boardDone; persist(); refresh(); }
  }

  // ------------------------------------------------------------------ tooltip
  const tip = document.createElement('div');
  tip.className = 'viz-tip'; tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  function showTip(el, x, y) {
    // data-tip="${esc(html)}": o esc é escape de atributo — dataset.tip já volta como o
    // HTML original (com <strong>), por isso innerHTML aqui. Não tirar o esc de quem monta.
    tip.innerHTML = el.dataset.tip; tip.classList.add('show');
    const r = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, x + 14), innerWidth - r.width - 8);
    const top = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }
  $('view').addEventListener('mousemove', e => {
    const el = e.target.closest('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY); else tip.classList.remove('show');
  });
  $('view').addEventListener('mouseleave', () => tip.classList.remove('show'));
  $('view').addEventListener('focusin', e => {
    const el = e.target.closest('[data-tip]');
    if (el) { const b = el.getBoundingClientRect(); showTip(el, b.left + b.width / 2, b.top); }
  });
  $('view').addEventListener('focusout', () => tip.classList.remove('show'));

  // ------------------------------------------------------------------ Quadro
  function renderBoard() {
    const list = shownRuns();
    const cols = [...NODES.map(([k, label]) => ({ key: k, label })), { key: 'done', label: 'Concluído' }];
    const by = Object.fromEntries(cols.map(c => [c.key, []]));
    for (const r of list) by[stageOf(r)].push(r);
    for (const k in by) by[k].sort((a, b) => (needsYou(b) - needsYou(a)) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    const showDone = !!prefs.boardDone;
    const card = r => {
      const t = ticketOf(r);
      const prs = prsOf(r);
      const retries = retriesOf(r);
      const k = stateKey(r);
      const meta = [
        retries ? `<span class="rv-meta-item" title="Tentativas extras">↻ ${retries}</span>` : '',
        r.pendingHumanInput ? '<span class="rv-mail">✉ na fila</span>' : '',
        prs.slice(0, 2).map(p => prBadge(r.taskId, p)).join(''),
        prs.length > 2 ? `<span class="pr-more">+${prs.length - 2}</span>` : '',
      ].join('');
      return `<div class="rv-card ${k}" role="button" tabindex="0" ${openAttr(r)}>
        <div class="rv-card-top"><span class="rv-g ${k}" aria-hidden="true">${STATE_GLYPH[k]}</span><span class="rv-card-num">${esc(t.num || '')}</span><span class="rv-card-when">${esc(ago(r.updatedAt))}</span></div>
        <div class="rv-card-title">${esc(t.text)}</div>
        <div class="rv-card-state ${k}">${esc(statusLabel(r))}</div>
        ${meta ? `<div class="rv-card-meta">${meta}</div>` : ''}
      </div>`;
    };
    return `${vhead('Quadro por etapa', 'Cada run fica na etapa que vai rodar em seguida. Os parados esperando você têm borda âmbar (vermelha quando falharam) e vêm primeiro.',
      `<button class="btn" type="button" data-vact="toggledone" aria-pressed="${showDone}">${showDone ? 'Esconder concluídos' : `Mostrar concluídos (${by.done.length})`}</button>`)}
      <div class="rv-board">${cols.filter(c => c.key !== 'done' || showDone).map(c => `
        <section class="rv-col" aria-label="${esc(c.label)}: ${by[c.key].length} run${by[c.key].length === 1 ? '' : 's'}">
          <header class="rv-col-head"><span>${esc(c.label)}</span><span class="rv-count">${by[c.key].length}</span></header>
          <div class="rv-col-body">${by[c.key].map(card).join('') || '<p class="rv-col-empty">Nenhum run</p>'}</div>
        </section>`).join('')}
      </div>`;
  }

  // ------------------------------------------------------------------ Tabela
  const TABLE_COLS = [
    ['ticket', 'Ticket'], ['subject', 'Assunto'], ['stage', 'Etapa'], ['status', 'Status'], ['pr', 'PR'],
    ['retries', 'Tentativas'], ['tokens', 'Tokens'], ['cost', 'Custo'], ['msgs', 'Mensagens'], ['started', 'Iniciado'], ['updated', 'Atualizado'],
  ];
  const STAGE_ORDER = [...NODES.map(([k]) => k), 'done'];
  const STATUS_ORDER = ['needs_human_review', 'awaiting_approval', 'failed', 'running', 'pending', 'unknown', 'committed'];
  function sortValue(r, k) {
    switch (k) {
      case 'ticket': return ticketOf(r).id || 0;
      case 'subject': return ticketOf(r).text.toLowerCase();
      case 'stage': return STAGE_ORDER.indexOf(stageOf(r));
      case 'status': return STATUS_ORDER.indexOf(r.status);
      case 'pr': return prsOf(r).length;
      case 'retries': return retriesOf(r);
      case 'tokens': return tokensOf(r) ?? -1;
      case 'cost': return usdOf(r) ?? -1;
      case 'msgs': return msgsOf(r) + (r.pendingHumanInput ? 0.5 : 0);
      case 'started': return Date.parse(r.state?.started_at) || 0;
      default: return Date.parse(r.updatedAt) || 0;
    }
  }
  function statusGroup(r) {
    if (isDone(r)) return 'done';
    if (needsYou(r)) return 'attention';
    return r.status === 'running' ? 'running' : 'other';
  }
  function renderTable() {
    let list = shownRuns(table.hidden);
    if (table.status !== 'all') list = list.filter(r => statusGroup(r) === table.status);
    if (table.node !== 'all') list = list.filter(r => stageOf(r) === table.node);
    if (table.pr !== 'all') list = list.filter(r => (prsOf(r).length > 0) === (table.pr === 'with'));
    list.sort((a, b) => {
      const va = sortValue(a, table.sort), vb = sortValue(b, table.sort);
      return (va < vb ? -1 : va > vb ? 1 : 0) * table.dir || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    });
    const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    const NUM_COLS = new Set(['retries', 'tokens', 'cost', 'msgs']);
    const head = TABLE_COLS.map(([k, label]) => {
      const sorted = table.sort === k;
      return `<th class="${NUM_COLS.has(k) ? 'rv-n' : ''}" aria-sort="${sorted ? (table.dir > 0 ? 'ascending' : 'descending') : 'none'}">
        <button type="button" data-vact="sort" data-key="${k}">${label}<span class="sort-ind" aria-hidden="true">${sorted ? (table.dir > 0 ? '↑' : '↓') : ''}</span></button></th>`;
    }).join('');
    const none = '<span class="muted">—</span>';
    const rows = list.map(r => {
      const t = ticketOf(r);
      const prs = prsOf(r);
      const stage = stageOf(r);
      return `<tr ${openAttr(r)} tabindex="0" class="${isHidden(r) ? 'hidden-run' : ''}">
        <td class="rv-mono rv-nowrap">${esc(t.num || '—')}</td>
        <td class="rv-subj"><span class="rv-subj-title">${esc(t.text)}</span><span class="rv-subj-id">${esc(r.taskId)}</span>${svcChips(r) ? `<span class="svcs">${svcChips(r, { max: 3 })}</span>` : ''}</td>
        <td class="rv-nowrap">${esc(stage === 'done' ? 'Concluído' : NODE_LABEL[stage] || stage)}</td>
        <td>${pillOf(r)}</td>
        <td class="rv-nowrap">${prs.map(p => prBadge(r.taskId, p)).join(' ') || none}</td>
        <td class="rv-n">${retriesOf(r) || '<span class="muted">0</span>'}</td>
        <td class="rv-n" ${costOf(r) ? `title="${esc(`${fmtMs(costOf(r).totals.duration_ms)} medidos · ${costOf(r).totals.loop_count} reexecução(ões)`)}"` : ''}>${tokensOf(r) == null ? none : esc(fmtTok(tokensOf(r)))}</td>
        <td class="rv-n">${usdOf(r) == null ? none : `${esc(fmtUsd(usdOf(r)))}${fx?.rate ? `<small class="rv-brl">${esc(fmtBrl(usdOf(r)))}</small>` : ''}`}</td>
        <td class="rv-n">${msgsOf(r) || '<span class="muted">0</span>'}${r.pendingHumanInput ? ' <span class="rv-mail">+ fila</span>' : ''}</td>
        <td class="rv-date">${esc(when(r.state?.started_at) || '—')}</td>
        <td class="rv-date">${esc(ago(r.updatedAt) || '—')}</td>
      </tr>`;
    }).join('');
    return `${vhead('Tabela', 'Clique no cabeçalho para ordenar e na linha para abrir o run. A busca do topo também filtra aqui.')}
      <div class="rv-filters">
        <label>Status <select data-tfilter="status">${opt('all', table.status, 'Todos')}${opt('attention', table.status, 'Precisa de você')}${opt('running', table.status, 'Em andamento')}${opt('other', table.status, 'Planejados e outros')}${opt('done', table.status, 'Concluídos')}</select></label>
        <label>Etapa <select data-tfilter="node">${opt('all', table.node, 'Todas')}${NODES.map(([k, l]) => opt(k, table.node, l)).join('')}${opt('done', table.node, 'Concluído')}</select></label>
        <label>PR <select data-tfilter="pr">${opt('all', table.pr, 'Todos')}${opt('with', table.pr, 'Com PR')}${opt('without', table.pr, 'Sem PR')}</select></label>
        <label class="rv-check"><input type="checkbox" data-tfilter="hidden" ${table.hidden ? 'checked' : ''}> Incluir removidos da lista</label>
        <span class="rv-total">${list.length} run${list.length === 1 ? '' : 's'}</span>
      </div>
      <div class="panel rv-table-wrap"><table class="dtable rv-table"><thead><tr>${head}</tr></thead><tbody>${rows ||
        `<tr><td colspan="${TABLE_COLS.length}" class="empty">Nenhum run com esses filtros.</td></tr>`}</tbody></table></div>`;
  }

  // ------------------------------------------------------------------ Linha do tempo
  // Segmentos a partir de agent_log: o trecho entre um despacho e o seguinte é
  // atribuído às etapas que o despacho seguinte registrou (divididas por igual).
  function segmentsOf(r) {
    const s = r.state || {};
    const log = (s.agent_log || []).filter(a => Date.parse(a.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const start = Date.parse(s.started_at) || (log[0] && Date.parse(log[0].at)) || Date.parse(r.updatedAt);
    const segs = [];
    let prev = start;
    for (const a of log) {
      const at = Date.parse(a.at);
      const nodes = (a.nodes || []).filter(n => NODES.some(([k]) => k === n));
      if (!nodes.length) { prev = Math.max(prev, at); continue; }
      const span = Math.max(0, at - prev) / nodes.length;
      nodes.forEach((n, i) => segs.push({ node: n, from: prev + span * i, to: prev + span * (i + 1), note: a.note }));
      prev = Math.max(prev, at);
    }
    const active = !isDone(r) && r.status !== 'committed';
    const end = active ? Date.now() : Math.max(prev, Date.parse(r.updatedAt) || prev);
    return { start, segs, tail: active ? { from: prev, to: end, blocked: needsYou(r) } : null, end };
  }

  function renderTimeline() {
    const list = shownRuns().map(r => ({ r, ...segmentsOf(r) })).filter(x => x.start);
    const now = Date.now();
    const maxEnd = Math.max(now, ...list.map(x => x.end));
    const minStart = tl.range ? maxEnd - tl.range * DAY : Math.min(...list.map(x => x.start));
    const inRange = list.filter(x => x.end >= minStart).sort((a, b) => b.start - a.start);
    const span = Math.max(maxEnd - minStart, DAY);
    const pct = t => ((Math.min(Math.max(t, minStart), maxEnd) - minStart) / span) * 100;
    const days = Math.ceil(span / DAY);
    const step = days <= 10 ? 1 : days <= 35 ? 5 : days <= 120 ? 15 : 30;
    const ticks = [];
    const d0 = new Date(minStart); d0.setHours(0, 0, 0, 0);
    for (let t = d0.getTime() + DAY, i = 0; t < maxEnd; t += DAY, i++) {
      if (i % step === 0) ticks.push(t);
    }
    const fmtDay = t => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const nowLine = `<span class="rv-now" style="left:${pct(now)}%" aria-hidden="true"></span>`;
    const lanes = inRange.map(({ r, segs, tail }) => {
      const t = ticketOf(r);
      const bars = segs.filter(s => s.to >= minStart).map(s => {
        const ph = phaseOf(s.node);
        const left = pct(s.from), width = Math.max(pct(s.to) - left, 0.6);
        const txt = `<strong>${esc(t.num)} ${esc(NODE_LABEL[s.node])}</strong><br>${esc(when(new Date(s.from).toISOString()))} → ${esc(when(new Date(s.to).toISOString()))}<br>${esc(dur(s.to - s.from))} · fase ${esc(PHASES[ph].label)}`;
        return `<span class="rv-seg ph${ph}" style="left:${left}%;width:${width}%" data-tip="${esc(txt)}" tabindex="0" aria-label="${esc(`${NODE_LABEL[s.node]}, ${dur(s.to - s.from)}`)}"></span>`;
      }).join('');
      const tailHtml = tail && tail.to > minStart ? (() => {
        const left = pct(tail.from), width = Math.max(pct(tail.to) - left, 0.6);
        const label = tail.blocked ? 'Parado esperando você'
          : r.status === 'pending' ? 'Planejado, ainda sem execução' : `Aguardando ${NODE_LABEL[r.node] || 'próximo passo'}`;
        return `<span class="rv-seg rv-tail ${tail.blocked ? 'blocked' : ''}" style="left:${left}%;width:${width}%" tabindex="0"
          data-tip="${esc(`<strong>${esc(t.num)} ${esc(label)}</strong><br>há ${esc(dur(tail.to - tail.from))}`)}" aria-label="${esc(label)}"></span>`;
      })() : '';
      return `<div class="rv-lane ${stateKey(r)}">
        <div class="rv-lane-label" role="button" tabindex="0" ${openAttr(r)}>${glyphOf(r)}<span class="rv-lane-text"><span class="rv-lane-num">${esc(t.num || '')}</span><span class="rv-lane-title">${esc(t.text)}</span></span></div>
        <div class="rv-track">${tailHtml}${bars}${nowLine}</div>
      </div>`;
    }).join('');
    const rangeBtn = (n, label) => `<button type="button" data-vact="range" data-range="${n}" aria-pressed="${tl.range === n}">${label}</button>`;
    const legend = `<div class="rv-legend" aria-label="Legenda">${PHASES.map((p, i) => `<span><i class="rv-sw ph${i}" aria-hidden="true"></i>${p.label} <small>(${p.nodes.map(n => NODE_LABEL[n]).join(', ')})</small></span>`).join('')}
      <span><i class="rv-sw rv-tail" aria-hidden="true"></i>Esperando</span><span><i class="rv-sw rv-tail blocked" aria-hidden="true"></i>Parado esperando você</span></div>`;
    return `${vhead('Linha do tempo', 'Uma faixa por run. Cada trecho é o tempo até o agente registrar uma etapa (pelo agent_log); a faixa tracejada é quanto tempo o run está esperando agora.',
      `<div class="seg" role="group" aria-label="Período">${rangeBtn(7, '7 dias')}${rangeBtn(30, '30 dias')}${rangeBtn(0, 'Tudo')}</div>`)}
      ${inRange.length ? `<div class="panel rv-timeline">
        ${legend}
        <div class="rv-tl-scroll"><div class="rv-tl-grid">
          <div class="rv-lane rv-axis" aria-hidden="true"><span class="rv-axis-label">${tl.range ? `últimos ${tl.range} dias` : 'todo o período'}</span><div class="rv-track">${ticks.map(t => `<span class="rv-tick" style="left:${pct(t)}%">${fmtDay(t)}</span>`).join('')}<span class="rv-tick now" style="left:${pct(now)}%">agora</span></div></div>
          <div class="rv-lanes">${lanes}</div>
        </div></div></div>` : '<div class="empty">Nenhum run com atividade nesse período.</div>'}`;
  }

  // ------------------------------------------------------------------ Métricas
  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function barChart(rows, { fmt = v => String(v), unit = '', empty = 'Sem dados.' } = {}) {
    const max = Math.max(...rows.map(r => r.value), 0);
    if (!max) return `<p class="rv-chart-empty">${empty}</p>`;
    return `<div class="rv-bars">${rows.map(r => `
      <div class="rv-bar-row" tabindex="0" data-tip="${esc(r.tip || `<strong>${esc(r.label)}</strong><br>${esc(fmt(r.value))}${unit}`)}">
        <span class="rv-bar-label">${esc(r.label)}</span>
        <span class="rv-bar-track"><span class="rv-bar ${r.cls || ''}" style="width:${r.value ? Math.max((r.value / max) * 100, 1.5) : 0}%"></span></span>
        <span class="rv-bar-val">${r.value ? esc(fmt(r.value)) : '<span class="muted">0</span>'}</span>
      </div>`).join('')}</div>`;
  }
  function renderMetrics() {
    const list = shownRuns();
    const count = f => list.filter(f).length;
    // [rótulo, valor, estado, fonte] — a fonte vai na legenda do indicador.
    const tiles = [
      ['Precisa de você', count(r => !isDone(r) && needsYou(r)), 'waiting', 'status · state.json'],
      ['Em andamento', count(r => !isDone(r) && !needsYou(r) && r.status === 'running'), '', 'status · state.json'],
      ['Planejados e outros', count(r => !isDone(r) && !needsYou(r) && r.status !== 'running'), '', 'status · state.json'],
      ['Concluídos', count(isDone), '', 'tipo do run · servidor'],
      ['PRs', list.reduce((a, r) => a + prsOf(r).length, 0), '', 'state.json · pull_request'],
      ['Mensagens ao agente', list.reduce((a, r) => a + msgsOf(r), 0), '', 'state.json · human_inputs'],
    ];
    const active = list.filter(r => !isDone(r));
    const byStage = NODES.map(([k, label]) => ({ label, value: active.filter(r => stageOf(r) === k).length }));
    // Tempo por etapa: run com cost_tracking usa a duração MEDIDA pelo watcher
    // (duration_ms / runs = média por passagem); runs antigos seguem estimados pelo
    // agent_log. O custo de fetch_ticket fica dentro de plan (mesmo despacho).
    const durations = Object.fromEntries(NODES.map(([k]) => [k, []]));
    const measured = Object.fromEntries(NODES.map(([k]) => [k, 0]));
    for (const r of list) {
      const c = costOf(r);
      if (c) {
        for (const [k, n] of Object.entries(c.nodes)) {
          if (!durations[k] || !(n.duration_ms >= 0)) continue;
          const runsN = Math.max(n.runs || 1, 1);
          for (let i = 0; i < runsN; i++) durations[k].push(n.duration_ms / runsN);
          measured[k] += runsN;
        }
      } else {
        for (const s of segmentsOf(r).segs) durations[s.node].push(s.to - s.from);
      }
    }
    const timeRows = NODES.map(([k, label]) => {
      const m = median(durations[k]);
      const src = measured[k] ? ` (${measured[k]} medida(s) pelo watcher)` : '';
      return { label, value: m || 0, tip: `<strong>${esc(label)}</strong><br>mediana ${esc(dur(m))} em ${durations[k].length} passagem(ns)${esc(src)}` };
    });
    // Tokens: só runs com cost_tracking. Por etapa = soma; por tipo de ticket = média
    // por run (é o que responde "que tipo de ticket custa mais").
    const costed = list.filter(r => tokensOf(r) != null);
    const nodeTok = n => (n.input_tokens == null && n.output_tokens == null) ? 0 : (n.input_tokens || 0) + (n.output_tokens || 0);
    const tokenRows = NODES.map(([k, label]) => {
      let sum = 0, inp = 0, out = 0, runsN = 0, silent = 0;
      for (const r of costed) {
        const n = costOf(r).nodes[k];
        if (!n) continue;
        sum += nodeTok(n); inp += n.input_tokens || 0; out += n.output_tokens || 0; runsN += n.runs || 1;
        silent += n.runs_without_tokens || 0;
      }
      const silentTxt = silent ? `<br>${silent} execução(ões) sem tokens reportados (não contam como 0)` : '';
      return { label, value: sum, tip: `<strong>${esc(label)}</strong><br>${esc(fmtTok(inp))} entrada · ${esc(fmtTok(out))} saída<br>${runsN} execução(ões)${silentTxt}` };
    });
    const byTracker = new Map();
    for (const r of costed) {
      const key = r.ticket?.tracker || 'Sem tipo';
      const g = byTracker.get(key) || { tok: 0, ms: 0, loops: 0, n: 0 };
      const t = costOf(r).totals;
      g.tok += tokensOf(r); g.ms += t.duration_ms || 0; g.loops += t.loop_count || 0; g.n += 1;
      byTracker.set(key, g);
    }
    const trackerRows = [...byTracker.entries()].sort((a, b) => b[1].tok / b[1].n - a[1].tok / a[1].n).map(([label, g]) => ({
      label, value: Math.round(g.tok / g.n),
      tip: `<strong>${esc(label)}</strong><br>média ${esc(fmtTok(Math.round(g.tok / g.n)))} tokens · ${esc(dur(g.ms / g.n))} por run<br>${g.n} run(s) · ${g.loops} reexecução(ões) no total`,
    }));
    const totalTok = costed.reduce((a, r) => a + tokensOf(r), 0);
    const priced = list.filter(r => usdOf(r) != null);
    const totalUsd = priced.reduce((a, r) => a + usdOf(r), 0);
    const usdRows = NODES.map(([k, label]) => {
      let usd = 0, runsN = 0;
      for (const r of priced) { const n = costOf(r).nodes[k]; if (n?.cost_usd != null) { usd += n.cost_usd; runsN += n.runs || 1; } }
      return { label, value: usd, tip: `<strong>${esc(label)}</strong><br>${esc(moneyTip(usd))}<br>${runsN} execução(ões)` };
    });
    const usdByTracker = new Map();
    for (const r of priced) {
      const key = r.ticket?.tracker || 'Sem tipo';
      const g = usdByTracker.get(key) || { usd: 0, n: 0, loops: 0 };
      g.usd += usdOf(r); g.n += 1; g.loops += costOf(r).totals.loop_count || 0;
      usdByTracker.set(key, g);
    }
    const usdTrackerRows = [...usdByTracker.entries()].sort((a, b) => b[1].usd / b[1].n - a[1].usd / a[1].n).map(([label, g]) => ({
      label, value: g.usd / g.n,
      tip: `<strong>${esc(label)}</strong><br>média ${esc(moneyTip(g.usd / g.n))} por run<br>${g.n} run(s) · total ${esc(moneyTip(g.usd))} · ${g.loops} reexecução(ões)`,
    }));
    const totalLoops = list.reduce((a, r) => a + (costOf(r)?.totals.loop_count || 0), 0);
    const retryRows = NODES.map(([k, label]) => ({ label, value: list.reduce((a, r) => a + (Number(r.state?.retries?.[k]) || 0), 0) }));
    const prStates = { OPEN: 0, MERGED: 0, DECLINED: 0, SUPERSEDED: 0, '': 0 };
    for (const r of list) for (const p of prsOf(r)) prStates[prState(r.taskId, p) || ''] += 1;
    const prRows = [['OPEN', 'Abertos'], ['MERGED', 'Mergeados'], ['DECLINED', 'Recusados'], ['SUPERSEDED', 'Substituídos'], ['', 'Estado desconhecido']]
      .map(([k, label]) => ({ label: k ? `${label} (${k})` : label, value: prStates[k], cls: `pr-${k || 'unknown'}` }));
    const liveKnown = list.some(r => prCache.get(r.taskId)?.data);
    // Faixa "custo por etapa" (design: barra empilhada de participação). Mesmos dados de
    // usdRows; a parte é sobre a soma por etapa (não sobre totals, que pode divergir).
    const nodeUsd = usdRows.reduce((a, x) => a + x.value, 0);
    const pctTxt = p => `${p < 1 ? '< 1' : Math.round(p)}%`;
    const shareParts = nodeUsd > 0 ? usdRows.filter(x => x.value > 0).map(x => ({ ...x, pct: (x.value / nodeUsd) * 100 })) : [];
    const share = shareParts.length ? `<section class="rv-share" aria-label="Participação de cada etapa no custo estimado">
        <span class="rv-share-cap">Custo por etapa · participação no custo estimado de ${priced.length} run${priced.length > 1 ? 's' : ''} · state.json.cost_tracking</span>
        <span class="rv-share-bar" role="img" aria-label="${esc(`Custo por etapa: ${shareParts.map(p => `${p.label} ${pctTxt(p.pct)}`).join(', ')}`)}">${shareParts.map(p =>
          `<span class="${p.pct >= 20 ? 'hi' : ''}" style="flex:${p.value} 1 0" data-tip="${esc(`<strong>${esc(p.label)}</strong><br>${esc(moneyTip(p.value))} · ${pctTxt(p.pct)}`)}"></span>`).join('')}</span>
        <span class="rv-share-legend">${shareParts.map(p => `<span>${esc(p.label)} ${pctTxt(p.pct)}</span>`).join('')}</span>
      </section>` : '';
    const chart = (title, sub, body) => `<section class="panel rv-chart"><h3 class="rv-chart-title">${title}</h3><p class="rv-chart-sub">${sub}</p>${body}</section>`;
    return `${vhead('Métricas', 'Números dos runs visíveis (a busca do topo filtra). Tempos vêm da medição do watcher quando o run tem cost_tracking; senão, são estimados pelos horários do agent_log.')}
      <div class="kpis rv-kpis">${[...tiles, ...(costed.length ? [
        [`Tokens (${costed.length} run${costed.length > 1 ? 's' : ''} medido${costed.length > 1 ? 's' : ''})`, fmtTok(totalTok), '', 'state.json · cost_tracking'],
        ...(priced.length ? [[`Custo estimado${fx?.rate ? ` · ${esc(fmtBrl(totalUsd))}` : ''}`, esc(fmtUsd(totalUsd)), '', 'preço de API por modelo']] : []),
        ['Reexecuções de etapa', totalLoops, '', 'cost_tracking · loop_count'],
      ] : [])].map(([l, v, k, src]) => {
        const on = k && Number(v) > 0;
        return `<div class="kpi rv-kpi ${on ? k : ''}"><span class="kpi-label">${l}</span><span class="kpi-value">${on ? `<span aria-hidden="true">${STATE_GLYPH[k]} </span>` : ''}${v}</span><span class="kpi-hint">${src}</span></div>`;
      }).join('')}</div>
      ${share}
      <div class="rv-charts">
        ${chart('Runs ativos por etapa', 'Onde os runs em aberto estão agora.', barChart(byStage, { fmt: v => `${v} run${v > 1 ? 's' : ''}` }))}
        ${chart('Tempo por etapa', 'Mediana de cada passagem pela etapa.', barChart(timeRows, { fmt: dur, empty: 'Nenhum agent_log com horários ainda.' }))}
        ${chart('Tokens por etapa', 'Soma de entrada + saída medida pelo watcher (state.json.cost_tracking). Plan inclui o fetch_ticket.', barChart(tokenRows, { fmt: fmtTok, empty: 'Nenhum run com custo medido ainda.' }))}
        ${chart('Custo por etapa', `US$ a preço de API por modelo (equivalente, se for assinatura).${fx?.rate ? ` Em R$ no tooltip — ${esc(fxNote())}` : ''}`, barChart(usdRows, { fmt: fmtUsd, empty: 'Nenhum run com custo em US$ ainda.' }))}
        ${chart('Custo por tipo de ticket', priced.length ? 'Média em US$ por run, por tipo do Redmine.' : 'Média de tokens por run, por tipo do Redmine (sem custo em US$ ainda).', priced.length
          ? barChart(usdTrackerRows, { fmt: fmtUsd })
          : barChart(trackerRows, { fmt: fmtTok, empty: 'Nenhum run com custo medido ainda.' }))}
        ${chart('Retrabalho', 'Tentativas extras registradas em state.json.retries.', barChart(retryRows, { fmt: v => `${v} tentativa${v > 1 ? 's' : ''}`, empty: 'Nenhuma tentativa extra registrada.' }))}
        ${chart('Pull requests por estado', liveKnown ? 'Estado do Bitbucket onde já foi consultado; senão, o gravado no state.json.' : 'Estado gravado no state.json. Consulte o Bitbucket para o estado real.',
          `${barChart(prRows, { fmt: v => `${v} PR${v > 1 ? 's' : ''}`, empty: 'Nenhum PR registrado.' })}
          <button class="btn rv-chart-action" type="button" data-vact="loadall" ${bulk.running ? 'disabled' : ''}>${bulk.running ? `Consultando… ${bulk.done}/${bulk.total}` : '↻ Consultar Redmine e Bitbucket'}</button>`)}
      </div>`;
  }

  // ------------------------------------------------------------------ Tickets e PRs
  // Busca em lote (sob demanda: ao abrir a visão ou no botão), 4 por vez, reaproveitando
  // os mesmos caches e endpoints do painel do run.
  async function pool(tasks, n) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
      while (i < tasks.length) { const t = tasks[i++]; await t(); bulk.done++; refresh(); }
    }));
  }
  async function loadAll(force) {
    if (bulk.running) return;
    // Sem runs ainda (página aberta direto em #tickets, antes do /api/runs chegar):
    // não marca como carregado — refresh() tenta de novo quando os runs chegarem.
    if (!runs.size) return;
    const list = shownRuns();
    const byTicket = new Map();
    for (const r of list) { const id = ticketIdOfRun(r); if (id && !byTicket.has(id)) byTicket.set(id, r.taskId); }
    const tasks = [];
    for (const taskId of byTicket.values()) {
      if (!force && ticketCache.get(taskId)?.data) continue;
      tasks.push(async () => {
        try {
          const res = await apiStatus(`/api/runs/${encodeURIComponent(taskId)}/ticket`);
          if (res.ok) ticketCache.set(taskId, { data: res.body });
          else ticketErrors.set(taskId, res.status);
        } catch { ticketErrors.set(taskId, 0); }
      });
    }
    for (const r of list) {
      if (!prsOf(r).length) continue;
      const c = prCache.get(r.taskId);
      if (!force && c?.data && Date.now() - c.at < 60000) continue;
      tasks.push(async () => {
        try {
          const res = await apiStatus(`/api/runs/${encodeURIComponent(r.taskId)}/pr`);
          if (res.ok) prCache.set(r.taskId, { data: res.body, at: Date.now() });
          else prErrors.set(r.taskId, res.status);
        } catch { prErrors.set(r.taskId, 0); }
      });
    }
    bulk = { running: true, done: 0, total: tasks.length, loadedOnce: true };
    refresh();
    // finally: erro inesperado no lote não pode deixar o botão "Atualizar" travado.
    try {
      await pool(tasks, 4);
    } finally {
      bulk.running = false;
      renderSidebar();
      refresh();
    }
  }
  const ticketErrors = new Map();
  const prErrors = new Map();
  const CLOSED_RE = /conclu|encerr|fechad|closed|rejeit|cancel/i;

  function ticketFor(runsOfTicket) {
    for (const r of runsOfTicket) { const c = ticketCache.get(r.taskId); if (c?.data) return c.data; }
    return null;
  }
  function livePrs(r) {
    const live = prCache.get(r.taskId)?.data?.prs;
    return prsOf(r).map(p => {
      const l = live?.find(x => x.id === p.id && (!p.repo || x.repo === p.repo));
      return { ...p, state: (l?.state || p.state || '').toUpperCase(), title: l?.title, approvals: l?.participants || [], created_on: l?.created_on, error: l?.error };
    });
  }
  function alertsFor(ticket, rs, prs) {
    const out = [];
    // Run sem state.json legível (unknown) não conta como ativo nem como concluído.
    const known = rs.filter(r => r.status !== 'unknown');
    const anyActive = known.some(r => !isDone(r));
    const allDone = known.length > 0 && known.every(r => isDone(r));
    if (ticket && CLOSED_RE.test(ticket.status || '') && anyActive) out.push(`Ticket está “${ticket.status}” no Redmine, mas há run ativo.`);
    for (const p of prs) {
      if (p.state === 'DECLINED' && allDone) out.push(`PR ${p.repo || ''} #${p.id} foi recusado no Bitbucket, mas o run está concluído.`);
      if (p.state === 'DECLINED' && anyActive) out.push(`PR ${p.repo || ''} #${p.id} foi recusado no Bitbucket.`);
      if (p.state === 'OPEN' && !p.approvals.length && p.created_on && Date.now() - Date.parse(p.created_on) > 7 * DAY) {
        out.push(`PR ${p.repo || ''} #${p.id} está aberto há ${dur(Date.now() - Date.parse(p.created_on))} sem aprovação.`);
      }
    }
    if (ticket && prs.length && prs.every(p => p.state === 'MERGED') && !CLOSED_RE.test(ticket.status || '') && allDone) {
      out.push(`Todos os PRs estão mergeados; o ticket segue “${ticket.status}”.`);
    }
    return out;
  }
  function renderTickets() {
    const list = shownRuns();
    const groups = new Map();
    for (const r of list) {
      const id = ticketIdOfRun(r) || 'sem';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(r);
    }
    let items = [...groups.entries()].map(([id, rs]) => {
      const ticket = id === 'sem' ? null : ticketFor(rs);
      const prs = rs.flatMap(r => livePrs(r).map(p => ({ ...p, taskId: r.taskId })));
      const seen = new Set();
      const uniq = prs.filter(p => { const k = `${p.repo}#${p.id || p.url}`; if (seen.has(k)) return false; seen.add(k); return true; });
      const alerts = id === 'sem' ? [] : alertsFor(ticket, rs, uniq);
      const errCode = rs.map(r => ticketErrors.get(r.taskId)).find(x => x !== undefined);
      return { id, rs, ticket, prs: uniq, alerts, errCode, latest: Math.max(...rs.map(r => Date.parse(r.updatedAt) || 0)) };
    });
    const counts = {
      all: items.length, alert: items.filter(i => i.alerts.length).length,
      open: items.filter(i => i.prs.some(p => p.state === 'OPEN')).length, nopr: items.filter(i => !i.prs.length).length,
    };
    if (tk.filter === 'alert') items = items.filter(i => i.alerts.length);
    if (tk.filter === 'open') items = items.filter(i => i.prs.some(p => p.state === 'OPEN'));
    if (tk.filter === 'nopr') items = items.filter(i => !i.prs.length);
    items.sort((a, b) => (a.id === 'sem') - (b.id === 'sem') || (b.alerts.length > 0) - (a.alerts.length > 0)
      || (b.rs.some(needsYou) - a.rs.some(needsYou)) || b.latest - a.latest);
    const chip = (k, label) => `<button type="button" data-vact="tkfilter" data-filter="${k}" aria-pressed="${tk.filter === k}">${label} <span class="num">${counts[k]}</span></button>`;
    const config = [...ticketErrors.values(), ...prErrors.values()].includes(503);
    // Estado do PR → tom de estado do design (o texto do estado continua visível).
    const PR_TONE = { OPEN: 'running', MERGED: 'done', DECLINED: 'failed', SUPERSEDED: 'waiting' };
    const card = i => {
      const t = i.ticket;
      const first = i.rs[0];
      const title = t?.subject || ticketOf(first).text;
      const redmine = i.id === 'sem' ? '<span class="muted">Runs sem número de ticket</span>'
        : t ? `${ticketStatusBadge(t.status) || '<span class="muted">—</span>'}<span>${esc(t.assigned_to || 'sem responsável')}</span>
               ${t.done_ratio != null ? `<span class="rv-ratio"><span class="rv-mono">${t.done_ratio}%</span><span class="meter rv-meter"><i style="width:${Math.max(0, Math.min(100, t.done_ratio))}%"></i></span></span>` : ''}
               ${t.estimated_hours != null ? `<span><span class="rv-mono">${String(t.estimated_hours).replace('.', ',')} h</span> estimadas</span>` : ''}
               <a class="rv-ext" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Redmine ↗</a>`
          : i.errCode === 503 ? '<span class="muted">Redmine não configurado</span>'
            : i.errCode !== undefined ? '<span class="muted">Ticket não encontrado ou Redmine indisponível</span>'
              : `<span class="muted">${bulk.running ? 'Consultando o Redmine…' : 'Ainda não consultado'}</span>`;
      const prs = i.prs.length ? i.prs.map(p => {
        const st = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].includes(p.state) ? p.state : '';
        const label = `${p.repo || 'PR'}${p.id ? ` #${p.id}` : ''}`;
        const inner = `<span class="rv-prst ${PR_TONE[st] || 'queued'}">${esc(st || '?')}</span><span class="rv-pr-id">${esc(label)}</span>${p.approvals.length ? `<span class="rv-approved">✓ ${p.approvals.length}</span>` : ''}`;
        const tipText = [p.title, p.approvals.length ? `Aprovado por ${p.approvals.join(', ')}` : '', p.error || ''].filter(Boolean).join(' — ');
        return p.url ? `<a class="rv-pr" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="${esc(tipText)}">${inner}</a>`
          : `<span class="rv-pr" title="${esc(tipText)}">${inner}</span>`;
      }).join('') : '<span class="muted">Nenhum PR</span>';
      const runsHtml = i.rs.map(r => `<span class="rv-run" role="button" tabindex="0" ${openAttr(r)}>${glyphOf(r)}<span class="rv-run-id">${esc(r.taskId.replace(/^\d{4,6}-/, ''))}</span>
        <small>${esc(stageOf(r) === 'done' ? 'concluído' : NODE_LABEL[stageOf(r)] || '')}</small></span>`).join('');
      return `<article class="panel rv-tk ${i.alerts.length ? 'has-alert' : ''}">
        <header class="rv-tk-head"><span class="rv-tk-id">${i.id === 'sem' ? '—' : `#${esc(i.id)}`}</span><h3 class="rv-tk-title">${esc(i.id === 'sem' ? 'Sem ticket' : title)}</h3></header>
        <dl class="rv-tk-src">
          <div><dt class="label">Redmine</dt><dd>${redmine}</dd></div>
          <div><dt class="label">Bitbucket</dt><dd>${prs}</dd></div>
          <div><dt class="label">Runs</dt><dd>${runsHtml}</dd></div>
        </dl>
        ${i.alerts.length ? `<div class="rv-tk-alert" role="status"><span class="rv-tk-alert-glyph" aria-hidden="true">‖</span><ul>${i.alerts.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
      </article>`;
    };
    return `${vhead('Tickets e PRs', 'Um cartão por ticket do Redmine, com os PRs do Bitbucket e os runs do agente. Alertas apontam quando os três não batem.',
      `<div class="seg" role="group" aria-label="Filtro">${chip('all', 'Todos')}${chip('alert', 'Com alerta')}${chip('open', 'PR aberto')}${chip('nopr', 'Sem PR')}</div>
        <button class="btn" type="button" data-vact="loadall" ${bulk.running ? 'disabled' : ''}>${bulk.running ? `Consultando… ${bulk.done}/${bulk.total}` : '↻ Atualizar Redmine e Bitbucket'}</button>`)}
      ${config ? '<p class="rv-banner" role="status"><span aria-hidden="true">‖</span>Redmine ou Bitbucket não configurado — defina REDMINE_URL/REDMINE_API_KEY e BITBUCKET_API_TOKEN.</p>' : ''}
      <div class="rv-tk-grid">${items.map(card).join('') || '<div class="empty">Nenhum ticket com esse filtro.</div>'}</div>`;
  }

  // ------------------------------------------------------------------ render
  const RENDER = {
    quadro: renderBoard, tabela: renderTable, timeline: renderTimeline, metricas: renderMetrics, tickets: renderTickets,
    // graph.js/patterns.js/prs.js/redmine.js (carregados depois) montam as abas —
    // ver window.GraphView/PatternsView/PrsView/RedmineView.
    grafo: () => (window.GraphView ? window.GraphView.render() : '<div class="vempty">Carregando…</div>'),
    padroes: () => (window.PatternsView ? window.PatternsView.render() : '<div class="vempty">Carregando…</div>'),
    prs: () => (window.PrsView ? window.PrsView.render() : '<div class="vempty">Carregando…</div>'),
    redmine: () => (window.RedmineView ? window.RedmineView.render() : '<div class="vempty">Carregando…</div>'),
  };
  let pending = false;
  function refresh() {
    renderTabs(); // contador "pedem você" do item Runs acompanha os runs
    if (view === 'tickets' && runs.size && !bulk.running && !bulk.loadedOnce) loadAll(false);
    if (view === 'runs' || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (view === 'runs') return;
      const el = $('view');
      const keepY = el.scrollTop;
      const focusKey = document.activeElement?.dataset?.tfilter;
      const domView = {
        coordenacao: window.CoordinationView,
        roteamento: window.RoutingView,
        versao: window.VersionView,
        computador: window.OnboardingView,
      }[view];
      // Visão que devolve sempre o mesmo nó (formulário do onboarding) não é remontada: manter foco e digitação.
      const domNode = domView?.render();
      if (domNode) { if (el.firstChild !== domNode || el.lastChild !== domNode) el.replaceChildren(domNode); }
      else el.innerHTML = view in { coordenacao: 1, roteamento: 1, versao: 1, computador: 1 }
        ? '<div class="vempty">Carregando…</div>' : RENDER[view]();
      el.scrollTop = keepY;
      if (focusKey) el.querySelector(`[data-tfilter="${focusKey}"]`)?.focus();
    });
  }

  window.Views = { refresh, openRun, setView, loadAll, current: () => view };
  renderTabs();
  document.body.dataset.view = view;
  if (view !== 'runs') setView(view);
})();
