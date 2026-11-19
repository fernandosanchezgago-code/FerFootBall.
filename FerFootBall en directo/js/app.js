/* =========================================================
   FERFOOTBALL — Controlador principal
   ========================================================= */
(function (FF) {
  'use strict';

  const { $, $$, esc, store, ymd, ymdToDate, fmtDay, clockNow, toast, debounce, render, api, auth, cookies } = FF;

  const LIVE_INTERVAL = 30000;   // 30 s con partidos en juego
  const IDLE_INTERVAL = 120000;  // 2 min sin partidos en juego
  const NEWS_INTERVAL = 300000;  // 5 min
  const TICKER_LEAGUES = ['esp.1', 'esp.2', 'esp.copa_del_rey', 'uefa.champions'];
  const LEAGUE_NAMES = {
    'esp.1': 'LaLiga EA Sports', 'esp.2': 'LaLiga Hypermotion', 'esp.copa_del_rey': 'Copa del Rey',
    'uefa.champions': 'Champions League', 'uefa.europa': 'Europa League', 'esp.w.1': 'Liga F'
  };

  const prefs = Object.assign({ theme: 'dark', league: 'esp.1', standingsLeague: 'esp.1' }, store.get('ff_prefs', {}));

  const state = {
    league: prefs.league,
    date: null,
    calendar: [],
    filter: 'all',
    events: [],
    standingsLeague: prefs.standingsLeague,
    standings: [],
    sort: { key: 'rank', dir: 1 },
    query: '',
    news: [],
    newsShown: 7,
    eventIndex: new Map(),  // id -> { ev, league }
    lastScores: new Map(),  // id -> "h-a"
    openMatch: null,        // { id, league, tab }
    timer: null,
    hasLive: false
  };

  /* =======================================================
     Registro de equipos (para selects y favoritos)
     ======================================================= */
  const teamMap = new Map();
  FF.teams = {
    get: (id) => teamMap.get(String(id)) || null,
    list: () => Array.from(teamMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'es')),
    add: (t) => { if (t && t.id && !teamMap.has(t.id)) teamMap.set(t.id, t); }
  };

  async function loadTeams() {
    // El endpoint /teams de ESPN no permite CORS: se construye la lista desde las clasificaciones
    try {
      const res = await Promise.allSettled([api.standings('esp.1'), api.standings('esp.2')]);
      res.forEach((r) => {
        if (r.status === 'fulfilled') r.value.rows.forEach((t) => FF.teams.add({ id: t.id, name: t.name, short: t.short, logo: t.logo }));
      });
      auth.fillTeamSelect($('#registerTeam'), '');
      auth.renderAuthSlot(auth.currentUser());
    } catch (e) {
      console.warn('No se pudieron cargar los equipos', e);
    }
  }

  /* =======================================================
     Modales
     ======================================================= */
  FF.openModal = function (name) {
    const dlg = document.getElementById(`modal-${name}`);
    if (!dlg) return;
    $$('dialog[open]').forEach((d) => { if (d !== dlg) d.close(); });
    if (name === 'profile') auth.renderProfile();
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    const first = dlg.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
    if (first && name !== 'match') setTimeout(() => first.focus(), 50);
  };
  FF.closeModal = function (name) {
    const dlg = document.getElementById(`modal-${name}`);
    if (dlg && dlg.open) dlg.close();
  };

  function bindModals() {
    document.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-open]');
      if (opener) {
        e.preventDefault();
        FF.openModal(opener.dataset.open);
        return;
      }
      if (e.target.closest('[data-close]')) {
        const dlg = e.target.closest('dialog');
        if (dlg) dlg.close();
      }
    });
    $$('dialog.modal').forEach((dlg) => {
      dlg.addEventListener('click', (e) => {
        if (e.target !== dlg) return;
        const r = dlg.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) dlg.close();
      });
    });
    $('#modal-match').addEventListener('close', () => { state.openMatch = null; });
  }

  /* =======================================================
     Tema y navegación
     ======================================================= */
  function savePrefs() {
    if (!cookies.allowed('preferences')) return;
    store.set('ff_prefs', { theme: prefs.theme, league: state.league, standingsLeague: state.standingsLeague });
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('meta[name="theme-color"]').setAttribute('content', theme === 'light' ? '#f4f1ea' : '#090d18');
    prefs.theme = theme;
  }

  function bindNav() {
    const nav = $('#nav');
    const toggle = $('#menuToggle');
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open);
    });
    nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }));

    $('#themeToggle').addEventListener('click', () => {
      applyTheme(prefs.theme === 'dark' ? 'light' : 'dark');
      savePrefs();
    });

    const header = $('#header');
    window.addEventListener('scroll', () => header.classList.toggle('scrolled', window.scrollY > 20), { passive: true });

    if ('IntersectionObserver' in window) {
      const links = $$('#nav a');
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          const id = en.target.id;
          links.forEach((l) => l.classList.toggle('active', l.getAttribute('href') === `#${id}`));
          cookies.track(id);
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      ['inicio', 'resultados', 'clasificacion', 'estadisticas', 'noticias', 'fichajes'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) io.observe(el);
      });
    }
  }

  /* =======================================================
     Calendario / tira de fechas
     ======================================================= */
  function calendarDates(cal) {
    const out = new Set();
    (cal || []).forEach((c) => {
      if (typeof c === 'string') out.add(ymd(new Date(c)));
      else if (c && c.entries) c.entries.forEach((en) => { if (en.startDate) out.add(ymd(new Date(en.startDate))); });
      else if (c && c.startDate) out.add(ymd(new Date(c.startDate)));
    });
    return Array.from(out).sort();
  }

  function pickDefaultDate(dates) {
    const today = ymd(new Date());
    if (!dates.length || dates.includes(today)) return today;
    // Fecha más cercana a hoy (prioriza la siguiente si está a ≤ 2 días)
    const t = ymdToDate(today).getTime();
    const next = dates.find((d) => d > today);
    const prev = [...dates].reverse().find((d) => d < today);
    if (next && (ymdToDate(next).getTime() - t) / 86400000 <= 2) return next;
    return prev || next || today;
  }

  function renderDateStrip() {
    const strip = $('#dateStrip');
    const today = ymd(new Date());
    let dates = state.calendar.slice();
    if (!dates.includes(today)) dates.push(today);
    if (state.date && !dates.includes(state.date)) dates.push(state.date);
    dates.sort();
    const idx = Math.max(0, dates.indexOf(state.date));
    const visible = dates.slice(Math.max(0, idx - 10), idx + 11);
    strip.innerHTML = visible.map((d) => {
      const dt = ymdToDate(d);
      return `<button class="date-pill ${d === state.date ? 'active' : ''} ${d === today ? 'today' : ''}" role="tab" aria-selected="${d === state.date}" data-date="${d}">
        <small>${esc(fmtDay(dt))}</small><strong>${dt.getDate()}</strong><small>${esc(fmtDay(dt, { weekday: undefined, month: 'short' }))}</small>
      </button>`;
    }).join('');
    const active = strip.querySelector('.active');
    if (active) strip.scrollLeft = active.offsetLeft - strip.clientWidth / 2 + active.clientWidth / 2;
  }

  /* =======================================================
     Marcadores
     ======================================================= */
  function indexEvents(events, league) {
    events.forEach((ev) => {
      ev._league = league;
      if (LEAGUE_NAMES[league]) ev.league = LEAGUE_NAMES[league];
      state.eventIndex.set(ev.id, { ev, league });
    });
  }

  function detectGoals(events) {
    const favs = auth.favorites();
    const user = auth.currentUser();
    events.forEach((ev) => {
      if (ev.state === 'pre') return;
      const key = `${ev.home.score}-${ev.away.score}`;
      const prev = state.lastScores.get(ev.id);
      state.lastScores.set(ev.id, key);
      if (prev === undefined || prev === key || ev.state !== 'in') return;
      // ¡Gol!
      $$(`[data-score="${ev.id}"]`).forEach((el) => {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      });
      const msg = `${ev.home.name} ${ev.home.score} - ${ev.away.score} ${ev.away.name}`;
      toast(msg, 'goal', `¡GOL! ${ev.clock || ''}`);
      const fav = favs.includes(ev.home.id) || favs.includes(ev.away.id);
      if (fav && user && user.notify && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('¡GOL! · FerFootBall', { body: msg, icon: ev.home.logo }); } catch (e) { /* ignorado */ }
      }
    });
  }

  function filteredEvents() {
    const favs = auth.favorites();
    return state.events.filter((ev) => {
      if (state.filter === 'all') return true;
      if (state.filter === 'fav') return favs.includes(ev.home.id) || favs.includes(ev.away.id);
      return ev.state === state.filter;
    });
  }

  function renderScores() {
    const box = $('#scoreList');
    const list = filteredEvents();
    if (!state.events.length) {
      box.innerHTML = render.emptyState('No hay partidos este día', 'Elige otra fecha en el calendario o cambia de competición.');
      return;
    }
    if (!list.length) {
      const msg = state.filter === 'fav'
        ? (auth.currentUser() ? 'Tus equipos no juegan este día. Añade favoritos con ☆ en la clasificación.' : 'Inicia sesión y sigue a tus equipos para filtrarlos aquí.')
        : 'No hay partidos con este filtro.';
      box.innerHTML = render.emptyState('Nada por aquí', msg);
      return;
    }
    const favs = auth.favorites();
    const live = list.filter((e) => e.state === 'in');
    const pre = list.filter((e) => e.state === 'pre');
    const post = list.filter((e) => e.state === 'post');
    let html = '';
    if (live.length) html += `<div class="score-group-title">EN DIRECTO · ${live.length}</div>${live.map((e) => render.scoreRow(e, favs)).join('')}`;
    if (pre.length) html += `<div class="score-group-title">PRÓXIMOS · ${pre.length}</div>${pre.map((e) => render.scoreRow(e, favs)).join('')}`;
    if (post.length) html += `<div class="score-group-title">FINALIZADOS · ${post.length}</div>${post.map((e) => render.scoreRow(e, favs)).join('')}`;
    box.innerHTML = html;
    FF.setupReveal();
  }

  async function loadScores({ silent = false } = {}) {
    const box = $('#scoreList');
    const note = $('#refreshNote');
    if (!silent) box.innerHTML = render.scoreSkeleton();
    note.classList.add('spinning');
    try {
      if (!state.date) {
        const first = await api.scoreboard(state.league);
        state.calendar = calendarDates(first.calendar);
        state.date = pickDefaultDate(state.calendar);
        renderDateStrip();
      }
      const data = await api.scoreboard(state.league, state.date);
      if (!state.calendar.length) state.calendar = calendarDates(data.calendar);
      state.events = data.events.sort((a, b) => new Date(a.date) - new Date(b.date));
      indexEvents(state.events, state.league);
      detectGoals(state.events);
      renderScores();
      updateKpiGoals();
      $('#lastUpdate').textContent = clockNow();
    } catch (err) {
      console.error(err);
      if (!silent) box.innerHTML = render.emptyState('No se pudieron cargar los partidos', 'Revisa tu conexión. Lo intentaremos de nuevo automáticamente.', true);
    } finally {
      note.classList.remove('spinning');
    }
  }

  function updateKpiGoals() {
    const played = state.events.filter((e) => e.state !== 'pre');
    if (!played.length) { $('#kpiGoals').textContent = '—'; return; }
    const goals = played
      .reduce((s, e) => s + (Number(e.home.score) || 0) + (Number(e.away.score) || 0), 0);
    $('#kpiGoals').textContent = goals;
  }

  /* =======================================================
     Ticker + hero (partidos de hoy en varias competiciones)
     ======================================================= */
  async function loadToday() {
    const today = ymd(new Date());
    const results = await Promise.allSettled(TICKER_LEAGUES.map((l) => api.scoreboard(l, today)));
    let all = [];
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      indexEvents(r.value.events, TICKER_LEAGUES[i]);
      all = all.concat(r.value.events);
    });
    detectGoals(all);
    const order = { in: 0, pre: 1, post: 2 };
    all.sort((a, b) => order[a.state] - order[b.state] || new Date(a.date) - new Date(b.date));
    $('#tickerTrack').innerHTML = render.tickerItems(all);
    const live = all.filter((e) => e.state === 'in');
    state.hasLive = live.length > 0 || state.events.some((e) => e.state === 'in');
    $('#liveCount').textContent = live.length;
    $('#kpiMatches').textContent = all.length;

    // Partido destacado: en directo de LaLiga > en directo > próximo > último jugado
    const favs = auth.favorites();
    const featured =
      live.find((e) => favs.includes(e.home.id) || favs.includes(e.away.id)) ||
      live.find((e) => e._league === 'esp.1') || live[0] ||
      all.find((e) => e.state === 'pre' && e._league === 'esp.1') || all.find((e) => e.state === 'pre') ||
      all[all.length - 1] ||
      state.events.find((e) => e.state === 'in') || state.events.find((e) => e.state === 'pre') ||
      state.events[state.events.length - 1] || null;
    $('#heroMatch').innerHTML = `<div class="hero-orbit"></div>${render.heroCard(featured)}`;
    $('#refreshNote').textContent = state.hasLive ? 'En directo · actualización cada 30 s' : 'Actualización automática cada 2 min';
  }

  /* =======================================================
     Detalle del partido
     ======================================================= */
  async function openMatch(id, league, tab = 'stats', silent = false) {
    const entry = state.eventIndex.get(String(id));
    league = league || (entry && entry.league) || state.league;
    state.openMatch = { id: String(id), league, tab };
    const box = $('#matchContent');
    if (!silent) {
      box.innerHTML = '<div class="loader"></div>';
      FF.openModal('match');
    }
    try {
      let ev = entry && entry.ev;
      if (!ev) {
        const d = await api.scoreboard(league, state.date);
        indexEvents(d.events, league);
        ev = d.events.find((e) => e.id === String(id));
      }
      const sm = await api.summary(league, id);
      if (!ev && sm.header) throw new Error('Partido no encontrado');
      if (!state.openMatch || state.openMatch.id !== String(id)) return;
      box.innerHTML = render.matchDetail(ev, sm, state.openMatch.tab);
    } catch (err) {
      console.error(err);
      if (!silent) box.innerHTML = render.emptyState('No se pudo cargar el partido', 'Inténtalo de nuevo en unos segundos.', true);
    }
  }

  function bindMatchClicks() {
    const handler = (e) => {
      const el = e.target.closest('[data-event]');
      if (!el) return;
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      openMatch(el.dataset.event, el.dataset.league);
    };
    ['#scoreList', '#tickerTrack', '#heroMatch'].forEach((sel) => {
      $(sel).addEventListener('click', handler);
      $(sel).addEventListener('keydown', handler);
    });
    $('#matchContent').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (!t) return;
      const tab = t.dataset.tab;
      if (state.openMatch) state.openMatch.tab = tab;
      $$('#matchContent .tab').forEach((b) => {
        b.classList.toggle('active', b === t);
        b.setAttribute('aria-selected', b === t);
      });
      $$('#matchContent .tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    });
  }

  /* =======================================================
     Clasificación
     ======================================================= */
  function sortedStandings() {
    const { key, dir } = state.sort;
    return state.standings.slice().sort((a, b) => {
      const va = a[key], vb = b[key];
      if (key === 'rank' || key === 'losses' || key === 'pointsAgainst') return (va - vb) * dir;
      return (vb - va) * dir || a.rank - b.rank;
    });
  }

  function renderStandings() {
    $('#standingsBody').innerHTML = render.standingsRows(sortedStandings(), state.standingsLeague, auth.favorites(), state.query);
    $$('#standingsTable th[data-sort]').forEach((th) => th.classList.toggle('sorted', th.dataset.sort === state.sort.key));
  }

  async function loadStandings() {
    $('#standingsBody').innerHTML = render.standingsSkeleton();
    $('#standingsTitle').textContent = (LEAGUE_NAMES[state.standingsLeague] || '').replace(' EA Sports', '').toUpperCase();
    try {
      const data = await api.standings(state.standingsLeague);
      state.standings = data.rows;
      data.rows.forEach((r) => FF.teams.add({ id: r.id, name: r.name, short: r.short, logo: r.logo }));
      renderStandings();
      if (state.standingsLeague === 'esp.1') {
        const leader = data.rows[0];
        $('#kpiLeader').textContent = leader ? `${leader.short || leader.name} · ${leader.points}` : '—';
        $('#goalsChart').innerHTML = render.goalsChart(data.rows);
        requestAnimationFrame(() => $$('#goalsChart .bar').forEach((b) => { b.style.width = `${b.dataset.w}%`; }));
      }
    } catch (err) {
      console.error(err);
      $('#standingsBody').innerHTML = `<tr><td colspan="11">${render.emptyState('Clasificación no disponible', 'No se pudo conectar con el servidor de datos.', true)}</td></tr>`;
    }
  }

  function bindStandings() {
    $('#standingsSelect').value = state.standingsLeague;
    $('#standingsSelect').addEventListener('change', (e) => {
      state.standingsLeague = e.target.value;
      state.sort = { key: 'rank', dir: 1 };
      savePrefs();
      loadStandings();
    });
    $('#teamSearch').addEventListener('input', debounce((e) => {
      state.query = e.target.value;
      renderStandings();
    }, 150));
    $$('#standingsTable th[data-sort]').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.sort;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: 1 };
      renderStandings();
    }));
    $('#standingsBody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-fav]');
      if (!b) return;
      const added = auth.toggleFavorite(b.dataset.fav);
      const t = FF.teams.get(b.dataset.fav);
      if (added === true) toast(`Ahora sigues a ${t ? t.name : 'este equipo'}.`, 'success');
      else if (added === false && auth.currentUser()) toast(`Has dejado de seguir a ${t ? t.name : 'este equipo'}.`, 'info');
      renderStandings();
      renderScores();
    });
  }

  /* =======================================================
     Líderes estadísticos
     ======================================================= */
  async function loadLeaders() {
    const grid = $('#leadersGrid');
    grid.innerHTML = '<div class="sk sk-card"></div><div class="sk sk-card"></div>';
    try {
      const data = await api.leaders('esp.1');
      const goals = data.goalsLeaders ? data.goalsLeaders.list : [];
      const assists = data.assistsLeaders ? data.assistsLeaders.list : [];
      grid.innerHTML = render.leaderCard('Máximos goleadores', goals, 'goles') + render.leaderCard('Máximos asistentes', assists, 'asistencias');
      $('#kpiScorer').textContent = goals[0] ? `${goals[0].name.split(' ').slice(-1)[0]} · ${goals[0].value}` : '—';
      FF.setupReveal();
    } catch (err) {
      console.error(err);
      grid.innerHTML = render.emptyState('Estadísticas no disponibles', 'No se pudieron cargar los líderes de la temporada.', true);
    }
  }

  /* =======================================================
     Noticias y fichajes
     ======================================================= */
  function renderNews() {
    const grid = $('#newsGrid');
    const list = state.news.slice(0, state.newsShown);
    if (!list.length) {
      grid.innerHTML = render.emptyState('Sin noticias', 'No hay noticias disponibles ahora mismo.');
      return;
    }
    grid.innerHTML = list.map((a, i) => render.newsCard(a, i === 0)).join('');
    $('#moreNews').hidden = state.newsShown >= state.news.length;
    FF.setupReveal();
  }

  function userTips() { return store.get('ff_tips', []); }

  function renderTransfers() {
    const t = render.classifyTransfers(state.news);
    const tips = userTips();
    $('#tConfirmed').innerHTML = render.transferItems(t.confirmed, tips.filter((x) => x.kind === 'confirmado' || x.kind === 'renovacion'));
    $('#tRumour').innerHTML = render.transferItems(t.rumour, tips.filter((x) => x.kind === 'rumor'));
    $('#tInfo').innerHTML = render.transferItems(t.info);
  }

  async function loadNews() {
    if (!state.news.length) $('#newsGrid').innerHTML = render.newsSkeleton();
    try {
      const [a, b] = await Promise.all([api.news('esp.1', 50), api.news('esp.2', 20).catch(() => [])]);
      const seen = new Set();
      state.news = a.concat(b).filter((x) => {
        if (seen.has(x.url)) return false;
        seen.add(x.url);
        return true;
      }).sort((x, y) => new Date(y.date) - new Date(x.date));
      renderNews();
      renderTransfers();
    } catch (err) {
      console.error(err);
      $('#newsGrid').innerHTML = render.emptyState('No se pudieron cargar las noticias', 'Lo intentaremos de nuevo en unos minutos.', true);
    }
  }

  function bindTips() {
    $('#moreNews').addEventListener('click', () => {
      state.newsShown += 6;
      renderNews();
    });
    $('#sendTipBtn').addEventListener('click', () => {
      if (!auth.currentUser()) {
        toast('Inicia sesión para enviar noticias.', 'info');
        FF.openModal('login');
        return;
      }
      FF.openModal('tip');
    });
    const form = $('#tipForm');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = form.elements;
      const user = auth.currentUser();
      let ok = true;
      const setErr = (name, msg) => {
        const field = f[name].closest('.field');
        field.classList.toggle('invalid', !!msg);
        field.querySelector('.err').textContent = msg || '';
        if (msg) ok = false;
      };
      setErr('title', f.title.value.trim().length < 8 ? 'El titular debe tener al menos 8 caracteres.' : '');
      setErr('body', f.body.value.trim().length < 20 ? 'Añade más detalles (mínimo 20 caracteres).' : '');
      if (!ok || !user) return;
      const tips = userTips();
      tips.unshift({ title: f.title.value.trim(), body: f.body.value.trim(), kind: f.kind.value, author: `@${user.username}`, date: new Date().toISOString() });
      store.set('ff_tips', tips.slice(0, 30));
      form.reset();
      FF.closeModal('tip');
      renderTransfers();
      toast('Gracias. Tu noticia aparece en la zona de fichajes.', 'success');
    });
  }

  /* =======================================================
     Controles de resultados
     ======================================================= */
  function bindScoreControls() {
    const sel = $('#leagueSelect');
    sel.value = state.league;
    sel.addEventListener('change', () => {
      state.league = sel.value;
      state.date = null;
      state.calendar = [];
      state.filter = 'all';
      $$('#statusChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'all'));
      savePrefs();
      loadScores();
    });
    $('#dateStrip').addEventListener('click', (e) => {
      const b = e.target.closest('[data-date]');
      if (!b) return;
      state.date = b.dataset.date;
      renderDateStrip();
      loadScores();
    });
    $('#statusChips').addEventListener('click', (e) => {
      const c = e.target.closest('[data-filter]');
      if (!c) return;
      state.filter = c.dataset.filter;
      $$('#statusChips .chip').forEach((x) => x.classList.toggle('active', x === c));
      renderScores();
    });
    $('#refreshBtn').addEventListener('click', async () => {
      api.clearCache();
      await Promise.all([loadScores({ silent: true }), loadToday()]);
      toast('Datos actualizados.', 'success');
    });
  }

  /* =======================================================
     Bucle de actualización en tiempo real
     ======================================================= */
  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(tick, state.hasLive ? LIVE_INTERVAL : IDLE_INTERVAL);
  }

  async function tick() {
    if (document.hidden) return schedule();
    try {
      await Promise.all([loadScores({ silent: true }), loadToday()]);
      if (state.openMatch) {
        const entry = state.eventIndex.get(state.openMatch.id);
        if (entry && entry.ev.state === 'in') openMatch(state.openMatch.id, state.openMatch.league, state.openMatch.tab, true);
      }
    } finally {
      schedule();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      clearTimeout(state.timer);
      tick();
    }
  });

  /* =======================================================
     Arranque
     ======================================================= */
  async function init() {
    applyTheme(prefs.theme);
    $('#year').textContent = new Date().getFullYear();
    bindModals();
    bindNav();
    cookies.init();
    auth.init();
    bindScoreControls();
    bindMatchClicks();
    bindStandings();
    bindTips();

    auth.onChange(() => {
      renderScores();
      renderStandings();
    });
    cookies.onChange((c) => {
      if (c.preferences) savePrefs();
    });

    loadTeams();
    await loadScores();
    await loadToday();
    loadStandings();
    loadLeaders();
    loadNews();
    setInterval(loadNews, NEWS_INTERVAL);
    schedule();
    FF.setupReveal();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window.FF);
