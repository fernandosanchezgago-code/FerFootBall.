/* =========================================================
   FERFOOTBALL — Cliente de datos en tiempo real (ESPN)
   ---------------------------------------------------------
   Endpoints públicos con CORS abierto:
   - Marcadores:    /apis/site/v2/sports/soccer/{liga}/scoreboard?dates=AAAAMMDD
   - Partido:       /apis/site/v2/sports/soccer/{liga}/summary?event={id}
   - Clasificación: /apis/v2/sports/soccer/{liga}/standings
   - Noticias:      /apis/site/v2/sports/soccer/{liga}/news
   - Líderes:       site.web.api.espn.com/.../{liga}/statistics
   ========================================================= */
(function (FF) {
  'use strict';

  const BASE = 'https://site.api.espn.com/apis';
  const WEB_BASE = 'https://site.web.api.espn.com/apis';
  const cache = new Map();

  /**
   * Petición con caché en memoria, timeout y reintentos.
   * @param {string} url
   * @param {number} ttl  segundos de vida en caché
   */
  async function getJSON(url, ttl = 20, retries = 2) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < ttl * 1000) return hit.data;
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        cache.set(url, { t: Date.now(), data });
        return data;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
    }
    if (hit) return hit.data; // Devuelve datos antiguos si la red falla
    throw lastErr;
  }

  /* ---------- Normalizadores ---------- */
  function normCompetitor(c) {
    const stats = {};
    (c.statistics || []).forEach((s) => { stats[s.name] = s.displayValue; });
    return {
      id: String(c.team.id),
      name: c.team.displayName || c.team.name,
      short: c.team.shortDisplayName || c.team.abbreviation || c.team.displayName,
      abbr: c.team.abbreviation || '',
      logo: c.team.logo || (c.team.logos && c.team.logos[0] && c.team.logos[0].href) || '',
      color: c.team.color ? `#${c.team.color}` : null,
      score: c.score != null ? (typeof c.score === 'object' ? c.score.displayValue : c.score) : '',
      winner: !!c.winner,
      homeAway: c.homeAway,
      form: c.form || '',
      record: c.records && c.records[0] ? c.records[0].summary : '',
      stats
    };
  }

  function normEvent(e, leagueName) {
    const comp = e.competitions[0];
    const home = comp.competitors.find((c) => c.homeAway === 'home') || comp.competitors[0];
    const away = comp.competitors.find((c) => c.homeAway === 'away') || comp.competitors[1];
    const st = e.status || comp.status;
    const details = (comp.details || []).map((d) => ({
      type: d.type && d.type.text,
      clock: d.clock && d.clock.displayValue,
      teamId: d.team && String(d.team.id),
      scoring: !!d.scoringPlay,
      players: (d.athletesInvolved || []).map((a) => a.displayName)
    }));
    return {
      id: String(e.id),
      date: e.date,
      name: e.name,
      league: leagueName,
      state: st.type.state, // pre | in | post
      statusName: st.type.name,
      statusDetail: st.type.shortDetail || st.type.detail,
      clock: st.displayClock,
      completed: st.type.completed,
      venue: comp.venue ? comp.venue.fullName : '',
      city: comp.venue && comp.venue.address ? comp.venue.address.city : '',
      attendance: comp.attendance || 0,
      broadcast: (comp.broadcasts || []).flatMap((b) => b.names || []).join(', '),
      home: normCompetitor(home),
      away: normCompetitor(away),
      details
    };
  }

  /* ---------- API pública ---------- */
  async function scoreboard(league, date) {
    const q = date ? `?dates=${date}` : '';
    const data = await getJSON(`${BASE}/site/v2/sports/soccer/${league}/scoreboard${q}`, 20);
    const lg = data.leagues && data.leagues[0];
    return {
      league: lg ? { name: lg.name, abbr: lg.abbreviation, logo: lg.logos && lg.logos[0] && lg.logos[0].href, season: lg.season } : null,
      calendar: (lg && lg.calendar) || [],
      day: data.day && data.day.date,
      events: (data.events || []).map((e) => normEvent(e, lg ? lg.name : ''))
    };
  }

  async function summary(league, eventId) {
    const data = await getJSON(`${BASE}/site/v2/sports/soccer/${league}/summary?event=${eventId}`, 20);
    const header = data.header && data.header.competitions && data.header.competitions[0];
    const teams = (data.boxscore && data.boxscore.teams) || [];
    const statsByTeam = {};
    teams.forEach((t) => {
      const m = {};
      (t.statistics || []).forEach((s) => { m[s.name] = { label: s.label, value: s.displayValue }; });
      statsByTeam[String(t.team.id)] = m;
    });
    const rosters = (data.rosters || []).map((r) => ({
      teamId: String(r.team.id),
      team: r.team.displayName,
      logo: r.team.logo || (r.team.logos && r.team.logos[0] && r.team.logos[0].href),
      formation: r.formation || '',
      players: (r.roster || []).map((p) => ({
        name: p.athlete && (p.athlete.displayName || p.athlete.shortName),
        jersey: p.jersey || '',
        starter: !!p.starter,
        pos: p.position && (p.position.abbreviation || p.position.name),
        subbedIn: !!p.subbedIn,
        subbedOut: !!p.subbedOut
      }))
    }));
    const keyEvents = (data.keyEvents || []).map((k) => ({
      type: k.type && k.type.text,
      clock: k.clock && k.clock.displayValue,
      text: k.text || '',
      teamId: k.team && String(k.team.id),
      scoring: !!k.scoringPlay,
      players: (k.participants || []).map((p) => p.athlete && p.athlete.displayName).filter(Boolean)
    }));
    const commentary = (data.commentary || []).map((c) => ({
      clock: c.time && c.time.displayValue,
      text: c.text
    })).reverse();
    const info = data.gameInfo || {};
    return {
      header,
      statsByTeam,
      rosters,
      keyEvents,
      commentary,
      venue: info.venue ? info.venue.fullName : '',
      attendance: info.attendance || 0,
      officials: (info.officials || []).map((o) => o.displayName || o.fullName),
      lastFive: data.lastFiveGames || [],
      headToHead: data.headToHeadGames || []
    };
  }

  async function standings(league) {
    const data = await getJSON(`${BASE}/v2/sports/soccer/${league}/standings`, 120);
    const group = data.children && data.children[0];
    if (!group) return { season: '', rows: [] };
    const rows = group.standings.entries.map((en) => {
      const s = {};
      en.stats.forEach((x) => { s[x.name] = x.value != null ? x.value : x.displayValue; s[x.name + '_d'] = x.displayValue; });
      return {
        id: String(en.team.id),
        name: en.team.displayName,
        short: en.team.shortDisplayName || en.team.abbreviation,
        logo: en.team.logos && en.team.logos[0] ? en.team.logos[0].href : '',
        note: en.note ? { desc: en.note.description, color: en.note.color, rank: en.note.rank } : null,
        rank: Number(s.rank) || 0,
        rankChange: Number(s.rankChange) || 0,
        gamesPlayed: Number(s.gamesPlayed) || 0,
        wins: Number(s.wins) || 0,
        ties: Number(s.ties) || 0,
        losses: Number(s.losses) || 0,
        pointsFor: Number(s.pointsFor) || 0,
        pointsAgainst: Number(s.pointsAgainst) || 0,
        pointDifferential: Number(s.pointDifferential) || 0,
        points: Number(s.points) || 0,
        deductions: Number(s.deductions) || 0
      };
    }).sort((a, b) => a.rank - b.rank);
    return { season: group.standings.seasonDisplayName || data.seasons && data.seasons[0] && data.seasons[0].displayName, name: group.name, rows };
  }

  async function news(league, limit = 30) {
    const data = await getJSON(`${BASE}/site/v2/sports/soccer/${league}/news?limit=${limit}`, 300);
    return (data.articles || []).map((a) => ({
      id: a.id || a.dataSourceIdentifier,
      title: a.headline,
      desc: a.description || '',
      date: a.published,
      type: a.type,
      image: a.images && a.images[0] ? a.images[0].url : '',
      url: a.links && a.links.web ? a.links.web.href : '#',
      byline: a.byline || 'ESPN',
      categories: (a.categories || []).map((c) => c.description).filter(Boolean)
    }));
  }

  async function leaders(league) {
    const data = await getJSON(`${WEB_BASE}/site/v2/sports/soccer/${league}/statistics`, 600);
    const out = {};
    (data.stats || []).forEach((cat) => {
      out[cat.name] = {
        label: cat.displayName || cat.name,
        list: (cat.leaders || []).slice(0, 10).map((l) => {
          const m = /(Goals|Assists):\s*(\d+)/i.exec(l.displayValue || '');
          const games = /Matches:\s*(\d+)/i.exec(l.displayValue || '');
          return {
            name: l.athlete.displayName,
            team: l.athlete.team ? l.athlete.team.displayName : '',
            teamId: l.athlete.team ? String(l.athlete.team.id) : '',
            logo: l.athlete.team && l.athlete.team.logos && l.athlete.team.logos[0] ? l.athlete.team.logos[0].href : '',
            value: m ? Number(m[2]) : Number(l.value) || 0,
            games: games ? Number(games[1]) : null
          };
        })
      };
    });
    return out;
  }

  function clearCache() { cache.clear(); }

  FF.api = { scoreboard, summary, standings, news, leaders, clearCache };
})(window.FF);
