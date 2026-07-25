(() => {
  const INLINE_CLASS = "fta-inline";
  const RECHECK_INTERVAL_MS = 3000;
  const FINISHED_POLL_INTERVAL_MS = 20000;

  let currentMatchId = null;
  let lastMatchState = { ready: false };
  let recheckTimer = null;
  let teamSummaryNode = null;

  // ---------- generic helpers ----------

  function bg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => resolve(res || { error: "NO_RESPONSE" }));
    });
  }

  function num(v, def = 0) {
    const n = parseFloat(v);
    return Number.isNaN(n) ? def : n;
  }

  const HTML_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
  }

  function extractMatchId(href) {
    const m = href.match(/\/room\/([^/?#]+)/) || href.match(/\/lobby\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function toast(msg) {
    let t = document.getElementById("fta-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "fta-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("fta-toast-show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("fta-toast-show"), 3500);
  }

  // ---------- SPA navigation watcher ----------

  function patchHistoryForNavEvents() {
    const fire = () => window.dispatchEvent(new Event("fta-locationchange"));
    const _push = history.pushState;
    history.pushState = function (...args) {
      _push.apply(this, args);
      fire();
    };
    const _replace = history.replaceState;
    history.replaceState = function (...args) {
      _replace.apply(this, args);
      fire();
    };
    window.addEventListener("popstate", fire);
  }

  // ---------- chat input insertion ----------

  function findChatInput() {
    const selectors = [
      '[data-testid*="chat" i] [contenteditable="true"]',
      '[class*="ChatInput" i] [contenteditable="true"]',
      '[class*="chat" i] [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[class*="Chat" i] textarea',
      'textarea[placeholder*="essage" i]',
      'textarea[placeholder*="сообщен" i]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function setNativeValue(el, value) {
    if (el.isContentEditable) {
      el.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    } else {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
    }
  }

  async function insertToChat(text) {
    const input = findChatInput();
    if (input) {
      setNativeValue(input, text);
      toast(ftaT("toast_inserted"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(ftaT("toast_copied"));
    } catch {
      toast(ftaT("toast_failed"));
    }
  }

  // ---------- stat extraction ----------

  // Действующий соревновательный маппул FACEIT для CS2 — сегменты статистики
  // FACEIT иногда содержат и другие карты/режимы (Aim Map, Wingman-карты и т.п.),
  // если игрок в них играл; для анализа матча они бесполезны и только шумят.
  const COMPETITIVE_MAP_POOL = [
    "mirage", "inferno", "dust2", "dust ii", "ancient", "nuke", "overpass", "vertigo", "anubis", "train", "cache"
  ];

  function normalizeMapLabel(label) {
    return String(label || "")
      .toLowerCase()
      .replace(/^de_/, "")
      .replace(/[^a-z0-9]/g, "");
  }

  function isCompetitiveMap(label) {
    const norm = normalizeMapLabel(label);
    return COMPETITIVE_MAP_POOL.some((m) => normalizeMapLabel(m) === norm);
  }

  function findMapSegment(segments, mapName) {
    if (!segments || !mapName) return null;
    return segments.find((s) => (s.label || "").toLowerCase() === mapName.toLowerCase()) || null;
  }

  // Некоторые аккаунты/сегменты FACEIT Data API отдают winrate по стороне CT/T —
  // ищем такие поля мягко, ничего не придумываем, если их нет.
  function extractSideStats(mapSegment) {
    if (!mapSegment || !mapSegment.stats) return null;
    const stats = mapSegment.stats;
    const ctKey = Object.keys(stats).find((k) => /\bct\b.*win rate|win rate.*\bct\b/i.test(k));
    const tKey = Object.keys(stats).find((k) => /(?<!c)\bt\b.*win rate|win rate.*(?<!c)\bt\b/i.test(k));
    const ct = ctKey ? num(stats[ctKey]) : null;
    const t = tKey ? num(stats[tKey]) : null;
    if (ct === null && t === null) return null;
    return { ct, t };
  }

  // Карты игрока по действующему маппулу, отсортированные по winrate — используется
  // и для быстрой строки "любимая/слабая карта", и для баров в "Подробнее".
  function getPlayerMapList(segments) {
    if (!segments || !segments.length) return [];
    return segments
      .filter((s) => isCompetitiveMap(s.label))
      .map((s) => ({ label: s.label, wr: num(s.stats && s.stats["Win Rate %"]), matches: num(s.stats && s.stats["Matches"]) }))
      .filter((s) => s.matches >= 3)
      .sort((a, b) => b.wr - a.wr);
  }

  function getRecentForm(lt) {
    const recent = lt["Recent Results"];
    if (!Array.isArray(recent) || !recent.length) return null;
    return recent.map((r) => (r === "1" ? "W" : "L"));
  }

  // Общий рендер списка карт барами (переиспользуется и в карточке игрока
  // внутри "Подробнее", и в командном блоке; теги "пик"/"бан" — только для команды).
  function buildMapBarsHtml(mapList, { showTags = false, limit = 5 } = {}) {
    if (!mapList.length) return "";
    const list = mapList.slice(0, limit);
    let html = `<div class="fta-maps">`;
    list.forEach((m, i) => {
      const wr = m.wr != null ? m.wr : m.avgWr;
      let tag = "";
      if (showTags) {
        if (i === 0) tag = `<span class="fta-tag fta-tag-pick">${ftaT("team_maps_pick")}</span>`;
        else if (i === list.length - 1 && list.length > 1) tag = `<span class="fta-tag fta-tag-ban">${ftaT("team_maps_ban")}</span>`;
      }
      html += `<div class="fta-map-row">
        <span class="fta-map-label">${escapeHtml(m.label)}</span>
        <div class="fta-bar"><div class="fta-bar-fill" style="width:${Math.min(wr, 100)}%"></div></div>
        <span class="fta-map-pct">${wr.toFixed(0)}%</span>
        ${tag}
      </div>`;
    });
    html += `</div>`;
    return html;
  }

  // ---------- tactic generation ----------

  // Тактика — это персональный совет самому игроку (роль, стиль, на что обратить
  // внимание), а не инструкция против конкретного соперника или гайд по раундам.
  function generateTactic(nickname, lifetime, mapSegment, mapName, ownRecentInfo) {
    lifetime = lifetime || {};
    const kd = num(lifetime["Average K/D Ratio"]);
    const hs = num(lifetime["Average Headshots %"]);
    const curStreak = num(lifetime["Current Win Streak"]);
    const recent = lifetime["Recent Results"] || [];
    const recentWins = recent.filter((r) => r === "1").length;

    const lines = [];

    // роль по сочетанию K/D и HS%
    if (kd >= 1.15 && hs >= 48) {
      lines.push("твой профиль — дуэлянт: высокий K/D и точность в голову. Роль на входах и открытии раунда подойдёт лучше, чем поддержка.");
    } else if (kd >= 1.15) {
      lines.push(`фраговый показатель сильный (K/D ${kd.toFixed(2)}), но точность в голову средняя — тебе выгоднее набирать через размены и добивания, а не долгие дуэли.`);
    } else if (kd > 0 && kd <= 0.85) {
      lines.push(`K/D ${kd.toFixed(2)} ниже среднего — вероятно, тебе комфортнее роль поддержки: отдавай информацию, заходи вторым темпом, не лезь в одиночные дуэли.`);
    } else if (kd > 0) {
      lines.push(`K/D ${kd.toFixed(2)} — играй по ситуации, не форсируй размены там, где нет явного преимущества.`);
    }

    if (hs >= 52) {
      lines.push(`HS% ${hs.toFixed(0)} — твоя сильная сторона это точность на ближней-средней дистанции, доверяй прицелу в упор.`);
    } else if (hs > 0 && hs < 35) {
      lines.push(`HS% ${hs.toFixed(0)} невысокий — тебе стоит избегать долгих спрей-файтов издалека, лучше сокращай дистанцию и используй утилити перед входом.`);
    }

    if (mapName && mapSegment && mapSegment.stats) {
      const mwr = num(mapSegment.stats["Win Rate %"]);
      const mMatches = num(mapSegment.stats["Matches"]);
      if (mMatches >= 5) {
        if (mwr >= 55) {
          lines.push(`на ${mapName} у тебя winrate ${mwr.toFixed(0)}% (${mMatches} матчей) — это твоя карта, можешь смелее брать инициативу на себя.`);
        } else if (mwr > 0 && mwr <= 40) {
          lines.push(`на ${mapName} winrate всего ${mwr.toFixed(0)}% — на этой карте лучше сыграть от команды, полагаясь на коллы, а не на личную инициативу.`);
        }
      } else {
        lines.push(`на ${mapName} у тебя мало сыгранных матчей — не изобретай, играй по коллам, пока не освоишься.`);
      }
    }

    // Форма по полной истории (до ~30 матчей), если она уже подгружена — точнее,
    // чем короткий "Recent Results" из lifetime-статистики, и приоритетнее его.
    if (ownRecentInfo && ownRecentInfo.sample >= 5) {
      const wr30 = ownRecentInfo.wins / ownRecentInfo.sample;
      if (wr30 >= 0.6) {
        lines.push(`в последних ${ownRecentInfo.sample} матчах ${ownRecentInfo.wins}-${ownRecentInfo.losses} — в целом ты выигрываешь чаще, чем проигрываешь, можно играть увереннее.`);
      } else if (wr30 <= 0.35) {
        lines.push(`в последних ${ownRecentInfo.sample} матчах ${ownRecentInfo.wins}-${ownRecentInfo.losses} — результаты слабые, не бери на себя лишний риск, дай команде наиграть уверенность.`);
      }
    } else if (curStreak >= 3) {
      lines.push(`серия из ${curStreak} побед подряд — ты в форме, играй уверенно и не меняй то, что работает.`);
    } else if (recent.length >= 4 && recentWins <= 1) {
      lines.push("последние матчи не идут — постарайся не тильтовать, начни с простой, аккуратной игры без лишнего риска.");
    }

    if (!lines.length) lines.push("стабильная статистика без явных перекосов — играй свою обычную роль в команде.");

    return `${nickname}, ${lines.join(" ")}`;
  }

  // ---------- data loading ----------

  async function loadPlayerData(playerId) {
    const [pRes, sRes] = await Promise.all([
      bg({ type: "FETCH_PLAYER", playerId }),
      bg({ type: "FETCH_PLAYER_STATS", playerId, game: "cs2" })
    ]);
    return { player: pRes.data || null, stats: sRes.data || null, error: pRes.error || sRes.error };
  }

  function pickCurrentMap(matchData) {
    try {
      const voting = matchData.voting;
      if (voting && voting.map && Array.isArray(voting.map.pick) && voting.map.pick.length === 1) {
        return voting.map.pick[0];
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function computeTeamAverages(ownData) {
    const vals = { elo: [], level: [], kd: [], wr: [] };
    for (const rd of ownData) {
      const lt = (rd.stats && rd.stats.lifetime) || {};
      const elo = rd.player && rd.player.games && rd.player.games.cs2 && rd.player.games.cs2.faceit_elo;
      const level = rd.player && rd.player.games && rd.player.games.cs2 && rd.player.games.cs2.skill_level;
      if (elo) vals.elo.push(num(elo));
      if (level) vals.level.push(num(level));
      const kd = num(lt["Average K/D Ratio"]);
      const wr = num(lt["Win Rate %"]);
      if (kd) vals.kd.push(kd);
      if (wr) vals.wr.push(wr);
    }
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    return { elo: avg(vals.elo), level: avg(vals.level), kd: avg(vals.kd), wr: avg(vals.wr) };
  }

  // Средний winrate команды по каждой карте, где хотя бы у одного игрока есть
  // достаточно данных (>=3 матча) — используется для рекомендации пика/бана.
  function computeTeamMapStats(ownData) {
    const byMap = new Map(); // label -> array of per-player winrates

    for (const rd of ownData) {
      const segs = (rd.stats && rd.stats.segments) || [];
      for (const s of segs) {
        if (!isCompetitiveMap(s.label)) continue;
        const wr = num(s.stats && s.stats["Win Rate %"]);
        const m = num(s.stats && s.stats["Matches"]);
        if (m < 3) continue;
        if (!byMap.has(s.label)) byMap.set(s.label, []);
        byMap.get(s.label).push(wr);
      }
    }

    const list = Array.from(byMap.entries())
      .map(([label, wrs]) => ({ label, avgWr: wrs.reduce((a, b) => a + b, 0) / wrs.length }))
      .sort((a, b) => b.avgWr - a.avgWr);

    return list;
  }

  function findWeakestLink(rosterData) {
    let weakest = null;
    let weakestScore = Infinity;
    for (const rd of rosterData) {
      const lt = (rd.stats && rd.stats.lifetime) || {};
      const kd = num(lt["Average K/D Ratio"], 1);
      const wr = num(lt["Win Rate %"], 50);
      const score = kd * wr;
      if (score < weakestScore) {
        weakestScore = score;
        weakest = rd;
      }
    }
    return weakest;
  }

  async function computeHistoryInsights(ownData, enemyData) {
    const enemyIds = new Set(enemyData.map((rd) => rd.roster.player_id));
    const enemyNickById = new Map(enemyData.map((rd) => [rd.roster.player_id, rd.roster.nickname]));
    const headToHeadMap = new Map(); // enemyId -> { nickname, wins, losses }
    const ownRecent = new Map(); // ownId -> { wins, losses, sample }

    await Promise.all(
      ownData.map(async (rd) => {
        const ownId = rd.roster.player_id;
        const res = await bg({ type: "FETCH_PLAYER_HISTORY", playerId: ownId, game: "cs2", limit: 30 });
        if (res.error || !res.data || !Array.isArray(res.data.items)) return;

        let wins = 0;
        let losses = 0;

        for (const item of res.data.items) {
          const teams = item.teams || {};
          const factions = Object.entries(teams);
          if (factions.length < 2) continue;

          let ownFactionKey = null;
          for (const [fKey, fVal] of factions) {
            const players = (fVal && fVal.players) || [];
            if (players.some((p) => p.player_id === ownId)) ownFactionKey = fKey;
          }
          if (!ownFactionKey) continue;

          const winnerFaction = item.results && item.results.winner;
          const ownWon = winnerFaction === ownFactionKey;
          if (ownWon) wins += 1;
          else losses += 1;

          const enemyFactionKey = factions.find(([fKey]) => fKey !== ownFactionKey)?.[0];
          if (!enemyFactionKey) continue;
          const oppPlayers = (teams[enemyFactionKey] && teams[enemyFactionKey].players) || [];
          const matchedEnemies = oppPlayers.filter((p) => enemyIds.has(p.player_id));
          for (const p of matchedEnemies) {
            const nickname = enemyNickById.get(p.player_id) || p.nickname;
            const entry = headToHeadMap.get(p.player_id) || { nickname, wins: 0, losses: 0 };
            if (ownWon) entry.wins += 1;
            else entry.losses += 1;
            headToHeadMap.set(p.player_id, entry);
          }
        }

        if (wins + losses > 0) ownRecent.set(ownId, { wins, losses, sample: wins + losses });
      })
    );

    const headToHead = Array.from(headToHeadMap.values()).sort((a, b) => b.wins + b.losses - (a.wins + a.losses));
    return { headToHead, ownRecent };
  }

  // ---------- finished match stats ----------

  function matchStatValue(obj, patterns) {
    if (!obj) return null;
    for (const key of Object.keys(obj)) {
      if (patterns.some((p) => p.test(key))) return obj[key];
    }
    return null;
  }

  // Структура /matches/{id}/stats не документирована жёстко для всех регионов,
  // поэтому парсим мягко: если формат неожиданный, просто не находим данные
  // и не показываем блок (без ошибок и без выдумывания значений).
  function parseMatchStats(statsData) {
    const byId = new Map();
    try {
      const rounds = statsData.rounds || [];
      for (const round of rounds) {
        const teams = round.teams || [];
        for (const team of teams) {
          const players = team.players || [];
          for (const p of players) {
            if (p.player_id && p.player_stats) byId.set(p.player_id, p.player_stats);
          }
        }
      }
    } catch (e) {
      /* ignore — best-effort */
    }
    return byId;
  }

  async function computeFinishedSummary(matchId, ownData, enemyData) {
    const statsRes = await bg({ type: "FETCH_MATCH_STATS", matchId });
    if (statsRes.error || !statsRes.data) return null;

    const byId = parseMatchStats(statsRes.data);
    if (!byId.size) return null;

    const byPlayerId = new Map();
    let mvp = null;
    let mvpScore = -Infinity;
    let weak = null;
    let weakScore = Infinity;

    for (const rd of [...ownData, ...enemyData]) {
      const stats = byId.get(rd.roster.player_id);
      if (!stats) continue;
      const kd = num(matchStatValue(stats, [/k\/d/i]));
      if (!kd) continue;
      const lt = (rd.stats && rd.stats.lifetime) || {};
      const avg = num(lt["Average K/D Ratio"]);
      byPlayerId.set(rd.roster.player_id, { kd, avg });
    }

    for (const rd of ownData) {
      const entry = byPlayerId.get(rd.roster.player_id);
      if (!entry) continue;
      if (entry.kd > mvpScore) {
        mvpScore = entry.kd;
        mvp = rd.roster.nickname;
      }
      if (entry.kd < weakScore) {
        weakScore = entry.kd;
        weak = rd.roster.nickname;
      }
    }

    if (!byPlayerId.size) return null;
    return { byPlayerId, mvp, weak };
  }

  // ---------- DOM injection ----------

  // FACEIT — SPA с обфусцированными классами, поэтому мы ищем не по CSS-селекторам,
  // а по точному тексту никнейма игрока: это единственное, что стабильно на странице.
  // Хрупко к изменениям вёрстки и совпадениям текста — best-effort, без фолбэка на
  // отдельную панель по требованию дизайна.
  function findNicknameElement(nickname) {
    if (!nickname || nickname.trim().length < 2) return null;
    const target = nickname.trim();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (el.closest && el.closest(`.${INLINE_CLASS}`)) return NodeFilter.FILTER_REJECT;
        if (el.children.length > 0) return NodeFilter.FILTER_SKIP;
        const text = (el.textContent || "").trim();
        return text === target ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    return walker.nextNode();
  }

  // Тот же приём точного совпадения текста, что и для ников — используется для
  // бейджей винрейта рядом с названиями карт на этапе вето. Это самая хрупкая
  // часть расширения: у нас нет доступа к реальной вёрстке live-виджета бана
  // карт, поэтому это best-effort попытка, которая только добавляет маленький
  // бейдж РЯДОМ с найденным текстом и никогда не трогает сам элемент —
  // сломать интерактивность вето она не может, а просто не сработать может.
  function findTextElement(text, usedSet) {
    if (!text) return null;
    const target = text.trim().toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (el.closest && el.closest(`.${INLINE_CLASS}`)) return NodeFilter.FILTER_REJECT;
        if (usedSet && usedSet.has(el)) return NodeFilter.FILTER_SKIP;
        if (el.children.length > 0) return NodeFilter.FILTER_SKIP;
        const t = (el.textContent || "").trim().toLowerCase();
        return t === target ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    return walker.nextNode();
  }

  let vetoBadgeNodes = [];

  function clearVetoBadges() {
    vetoBadgeNodes.forEach((el) => el.isConnected && el.remove());
    vetoBadgeNodes = [];
  }

  function ensureVetoBadges() {
    if (!lastMatchState.ready || !lastMatchState.settings || !lastMatchState.settings.showSummary) return;
    if (lastMatchState.mapName) {
      // Карта уже выбрана — стадия банов позади, бейджи больше не нужны.
      if (vetoBadgeNodes.length) clearVetoBadges();
      return;
    }
    if (vetoBadgeNodes.some((el) => el.isConnected)) return;

    const mapStats = computeTeamMapStats(lastMatchState.own);
    if (mapStats.length < 2) return;

    clearVetoBadges();
    const used = new Set();
    for (const m of mapStats) {
      const el = findTextElement(m.label, used);
      if (!el) continue;
      used.add(el);
      const badge = document.createElement("span");
      badge.className = `${INLINE_CLASS} fta-veto-badge`;
      badge.textContent = `${m.avgWr.toFixed(0)}%`;
      el.insertAdjacentElement("afterend", badge);
      vetoBadgeNodes.push(badge);
    }
  }

  function getInjectionContainer(anchorEl) {
    let el = anchorEl;
    for (let i = 0; i < 3 && el.parentElement; i++) el = el.parentElement;
    return el;
  }

  function buildRecentFormHtml(form) {
    if (!form || !form.length) return "";
    const dots = form
      .slice(0, 10)
      .map((r) => `<span class="fta-dot ${r === "W" ? "fta-dot-w" : "fta-dot-l"}"></span>`)
      .join("");
    return `<div class="fta-row fta-recent"><span class="fta-row-label">${ftaT("card_form", { n: form.length })}</span><span class="fta-dots">${dots}</span></div>`;
  }

  function buildStatCard(rd, mapName, teamKind, settings, ownRecentInfo) {
    const nickname = rd.roster.nickname;
    const nicknameSafe = escapeHtml(nickname);
    const err = rd.error;

    const card = document.createElement("div");
    card.className = `${INLINE_CLASS} fta-inline-${teamKind} fta-compact`;

    if (err) {
      card.innerHTML = `<div class="fta-row fta-muted">${nicknameSafe}: статистика временно недоступна.</div>`;
      return card;
    }

    const lt = (rd.stats && rd.stats.lifetime) || {};
    const kd = num(lt["Average K/D Ratio"]);
    const wr = num(lt["Win Rate %"]);
    const hs = num(lt["Average Headshots %"]);
    const matches = num(lt["Matches"]);
    const mapSeg = findMapSegment(rd.stats && rd.stats.segments, mapName);
    const sideStats = extractSideStats(mapSeg);
    const mapList = getPlayerMapList(rd.stats && rd.stats.segments);
    const recentForm = getRecentForm(lt);
    const tactic = generateTactic(nickname, lt, mapSeg, mapName, ownRecentInfo);

    // Ник, ELO и Level уже показывает сама FACEIT прямо над местом вставки —
    // здесь дублировать их не нужно.
    let html = buildRecentFormHtml(recentForm);

    // ---- main stats, one horizontal strip at the bottom of the visible card ----
    const stats = [];
    if (kd) stats.push([ftaT("card_kd"), kd.toFixed(2)]);
    if (hs) stats.push([ftaT("card_hs"), `${hs.toFixed(0)}%`]);
    if (wr) stats.push([ftaT("card_winrate"), `${wr.toFixed(0)}%`]);
    if (matches) stats.push([ftaT("card_matches"), matches]);
    if (stats.length) {
      html += `<div class="fta-stat-strip">${stats
        .map(([label, value]) => `<div class="fta-stat"><b>${value}</b><span>${label}</span></div>`)
        .join("")}</div>`;
    }

    // ---- "Подробнее": this player's own map breakdown, not raw API leftovers ----
    const moreParts = [];
    if (mapList.length) moreParts.push(buildMapBarsHtml(mapList, { limit: 4 }));
    if (sideStats) {
      const parts = [];
      if (sideStats.ct !== null) parts.push(`CT ${sideStats.ct.toFixed(0)}%`);
      if (sideStats.t !== null) parts.push(`T ${sideStats.t.toFixed(0)}%`);
      moreParts.push(`<div class="fta-row fta-row-sm"><span class="fta-row-label">${ftaT("card_side")} (${escapeHtml(mapName)})</span><span>${parts.join(" · ")}</span></div>`);
    }
    if (ownRecentInfo) {
      moreParts.push(`<div class="fta-row fta-row-sm"><span class="fta-row-label">${ftaT("card_history", { n: ownRecentInfo.sample })}</span><span><span class="fta-w">${ownRecentInfo.wins}W</span> · <span class="fta-l">${ownRecentInfo.losses}L</span></span></div>`);
    }
    if (moreParts.length) {
      html += `<details class="fta-extra"><summary>${ftaT("card_more")}</summary>${moreParts.join("")}</details>`;
    }

    if (teamKind === "own" && settings.showTactics) {
      html += `
        <details class="fta-tactic-wrap">
          <summary>${ftaT("tactic_summary")}</summary>
          <div class="fta-tactic-text">${escapeHtml(tactic)}</div>
          <button class="fta-insert-btn">${ftaT("tactic_insert")}</button>
        </details>
      `;
    }

    card.innerHTML = html;

    if (teamKind === "own" && settings.showTactics) {
      const btn = card.querySelector(".fta-insert-btn");
      if (btn) btn.addEventListener("click", () => insertToChat(tactic));
    }

    return card;
  }

  function buildTeamSummaryCard() {
    const { mapName, weakestEnemy, headToHead, finished, own } = lastMatchState;
    const avgs = computeTeamAverages(own);
    const mapStats = computeTeamMapStats(own);

    const hasContent =
      avgs.elo || avgs.level || avgs.kd || avgs.wr || mapName || mapStats.length >= 2 || weakestEnemy || (headToHead && headToHead.length) || finished;
    if (!hasContent) return null;

    const card = document.createElement("div");
    card.className = `${INLINE_CLASS} fta-inline-summary`;
    let html = `<div class="fta-row fta-head"><span class="fta-nick">${ftaT(finished ? "popup_finished_title" : "team_section_summary")}</span></div>`;

    // ---- team averages, one line ----
    const avgBits = [];
    if (avgs.elo) avgBits.push(`ELO ${avgs.elo.toFixed(0)}`);
    if (avgs.level) avgBits.push(`${ftaT("card_level")} ${avgs.level.toFixed(1)}`);
    if (avgs.kd) avgBits.push(`${ftaT("card_kd")} ${avgs.kd.toFixed(2)}`);
    if (avgs.wr) avgBits.push(`WR ${avgs.wr.toFixed(0)}%`);
    if (avgBits.length) html += `<div class="fta-line">${ftaT("team_avg")}: ${avgBits.join(" · ")}</div>`;

    if (mapName) html += `<div class="fta-line fta-line-muted">${ftaT("popup_match_map")}: ${escapeHtml(mapName)}</div>`;

    // ---- map pick/ban bars ----
    if (mapStats.length >= 2) {
      html += buildMapBarsHtml(mapStats, { showTags: true, limit: 7 });
    }

    if (weakestEnemy) html += `<div class="fta-line">${ftaT("popup_match_weakest")}: ${escapeHtml(weakestEnemy)}</div>`;
    if (headToHead && headToHead.length) {
      const h2h = headToHead
        .map((e) => `${escapeHtml(e.nickname)}: <span class="fta-w">${e.wins}W</span>-<span class="fta-l">${e.losses}L</span>`)
        .join(" · ");
      html += `<div class="fta-line fta-line-muted">${ftaT("popup_match_h2h")}: ${h2h}</div>`;
    }

    if (finished) {
      if (finished.mvp) html += `<div class="fta-line">${ftaT("popup_finished_mvp")}: <b>${escapeHtml(finished.mvp)}</b></div>`;
      if (finished.weak && finished.weak !== finished.mvp) {
        html += `<div class="fta-line">${ftaT("popup_finished_weak")}: <b>${escapeHtml(finished.weak)}</b></div>`;
      }
    }

    card.innerHTML = html;
    return card;
  }

  function ensureTeamSummaryInjected() {
    if (teamSummaryNode && teamSummaryNode.isConnected) return;
    if (!lastMatchState.ready || !lastMatchState.settings || !lastMatchState.settings.showSummary) return;

    // Вставляем перед ВСЕМ контейнером первого найденного игрока (на уровень
    // выше, чем сама карточка), иначе командный блок оказывается внутри
    // того же бордера, что и карточка конкретного игрока, и выглядит так,
    // будто относится только к нему.
    const anchorRd = lastMatchState.own.find((rd) => rd.injectedContainer && rd.injectedContainer.isConnected);
    if (!anchorRd) return;
    const parent = anchorRd.injectedContainer.parentElement;
    if (!parent) return;

    const card = buildTeamSummaryCard();
    if (!card) return;
    parent.insertBefore(card, anchorRd.injectedContainer);
    teamSummaryNode = card;
  }

  function injectPlayer(rd, mapName, teamKind, settings, ownRecentInfo) {
    const anchor = findNicknameElement(rd.roster.nickname);
    if (!anchor) return null;
    const container = getInjectionContainer(anchor);
    const card = buildStatCard(rd, mapName, teamKind, settings, ownRecentInfo);
    container.appendChild(card);
    return { card, container };
  }

  function ensureInjected() {
    if (!lastMatchState.ready) return;
    const { own, enemy, mapName, settings, ownRecentByPlayerId } = lastMatchState;
    for (const rd of own) {
      if (rd.injectedNode && rd.injectedNode.isConnected) continue;
      const result = injectPlayer(rd, mapName, "own", settings, ownRecentByPlayerId.get(rd.roster.player_id));
      rd.injectedNode = result ? result.card : null;
      rd.injectedContainer = result ? result.container : null;
    }
    for (const rd of enemy) {
      if (rd.injectedNode && rd.injectedNode.isConnected) continue;
      const result = injectPlayer(rd, mapName, "enemy", settings, null);
      rd.injectedNode = result ? result.card : null;
      rd.injectedContainer = result ? result.container : null;
    }
    ensureTeamSummaryInjected();
    ensureVetoBadges();
  }

  function clearInjected() {
    document.querySelectorAll(`.${INLINE_CLASS}`).forEach((el) => el.remove());
    teamSummaryNode = null;
    vetoBadgeNodes = [];
  }

  // ---------- main flow ----------

  async function loadMatch(matchId) {
    lastMatchState = { ready: false };

    const matchRes = await bg({ type: "FETCH_MATCH", matchId });
    if (matchRes.error) {
      if (matchRes.error !== "NOT_FOUND") {
        const detail = matchRes.status ? `${matchRes.error} ${matchRes.status}` : matchRes.error;
        toast(`${ftaT("toast_server_down")} (${detail})`);
        console.warn("[FACEIT Tactics Assistant] FETCH_MATCH failed:", matchRes);
      }
      return;
    }

    const match = matchRes.data;
    const mapName = pickCurrentMap(match);

    const teams = match.teams || {};
    const factionKeys = Object.keys(teams);
    if (factionKeys.length < 2) return;

    // Best-effort: assume faction1 is "own" team (both tabs' data is still fetched either way).
    const ownFaction = teams[factionKeys[0]];
    const enemyFaction = teams[factionKeys[1]];
    const ownRoster = ownFaction.roster || [];
    const enemyRoster = enemyFaction.roster || [];

    const [ownData, enemyData] = await Promise.all([
      Promise.all(ownRoster.map(async (roster) => ({ roster, ...(await loadPlayerData(roster.player_id)) }))),
      Promise.all(enemyRoster.map(async (roster) => ({ roster, ...(await loadPlayerData(roster.player_id)) })))
    ]);

    const weakestEnemy = findWeakestLink(enemyData);
    const settings = await chrome.storage.sync.get({ showTactics: true, showSummary: true });

    lastMatchState = {
      ready: true,
      mapName,
      own: ownData,
      enemy: enemyData,
      weakestEnemy: weakestEnemy ? weakestEnemy.roster.nickname : null,
      headToHead: [],
      settings,
      ownRecentByPlayerId: new Map(),
      finished: null
    };

    ensureInjected();

    if (settings.showSummary) {
      const { headToHead, ownRecent } = await computeHistoryInsights(ownData, enemyData);
      if (currentMatchId === matchId) {
        lastMatchState.headToHead = headToHead;
        lastMatchState.ownRecentByPlayerId = ownRecent;
        rebuildInjected([...ownData, ...enemyData]);
      }
    }

    if (/finished/i.test(match.status || "")) {
      const finished = await computeFinishedSummary(matchId, ownData, enemyData);
      if (currentMatchId === matchId && finished) {
        lastMatchState.finished = finished;
        rebuildInjected([...ownData, ...enemyData]);
      }
    }
  }

  // FACEIT обычно оставляет пользователя на той же странице комнаты после
  // окончания матча (matchId в URL не меняется), поэтому переход в статус
  // FINISHED не поймать через слежение за навигацией — опрашиваем статус
  // отдельным нечастым таймером, пока итоги ещё не получены.
  async function pollFinishedStatus() {
    if (!currentMatchId || !lastMatchState.ready || lastMatchState.finished) return;
    const matchId = currentMatchId;
    const matchRes = await bg({ type: "FETCH_MATCH", matchId });
    if (matchRes.error || !matchRes.data) return;
    if (!/finished/i.test(matchRes.data.status || "")) return;

    const finished = await computeFinishedSummary(matchId, lastMatchState.own, lastMatchState.enemy);
    if (finished && currentMatchId === matchId) {
      lastMatchState.finished = finished;
      rebuildInjected([...lastMatchState.own, ...lastMatchState.enemy]);
    }
  }

  // Best-effort проверка живого состояния вето (какие карты уже забанены), чтобы
  // рекомендация пик/бан обновлялась по ходу банов, а не считалась один раз по
  // всему пулу. Публичный FACEIT Data API не документирует такое поле — voting
  // в примерах ответа просто null, подтверждённым можно считать только финальный
  // voting.map.pick (уже используется в pickCurrentMap). Поэтому здесь СОЗНАТЕЛЬНО
  // ничего не считываем и не выдумываем — функция всегда мгновенно завершается
  // без эффекта, пока кто-то не подтвердит реальную форму этого поля на живом
  // матче во время вето (DevTools → Network во время реального бана карт) и не
  // допишет реальное извлечение вместо этой заглушки.
  async function pollVetoState() {
    if (!currentMatchId || !lastMatchState.ready || lastMatchState.mapName) return;
    const matchRes = await bg({ type: "FETCH_MATCH", matchId: currentMatchId });
    if (matchRes.error || !matchRes.data) return;

    const voting = matchRes.data.voting;
    const bannedMaps = null; // TODO: заменить на реальное поле, когда оно будет подтверждено
    if (!voting || !bannedMaps) return;

    // Не должно выполняться сегодня — оставлено для будущей реализации.
    lastMatchState.bannedMaps = bannedMaps;
    ensureVetoBadges();
  }

  function rebuildInjected(rosterData) {
    for (const rd of rosterData) {
      if (rd.injectedNode && rd.injectedNode.isConnected) rd.injectedNode.remove();
      rd.injectedNode = null;
      rd.injectedContainer = null;
    }
    if (teamSummaryNode && teamSummaryNode.isConnected) teamSummaryNode.remove();
    teamSummaryNode = null;
    ensureInjected();
  }

  async function checkAndLoad() {
    const href = location.href;
    const matchId = extractMatchId(href);
    if (!matchId) {
      if (currentMatchId) {
        clearInjected();
        currentMatchId = null;
        lastMatchState = { ready: false };
      }
      return;
    }
    if (matchId === currentMatchId) return;
    clearInjected();
    currentMatchId = matchId;
    await loadMatch(matchId);
  }

  // ---------- init ----------

  async function init() {
    await ftaInitLang();

    patchHistoryForNavEvents();
    window.addEventListener("fta-locationchange", () => setTimeout(checkAndLoad, 300));
    const observer = new MutationObserver(() => {
      if (extractMatchId(location.href) !== currentMatchId) checkAndLoad();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && (changes.showTactics || changes.showSummary) && currentMatchId) {
        clearInjected();
        loadMatch(currentMatchId);
      }
      if (area === "sync" && changes.lang && currentMatchId) {
        window.__ftaLang = changes.lang.newValue;
        clearInjected();
        loadMatch(currentMatchId);
      }
    });

    recheckTimer = setInterval(ensureInjected, RECHECK_INTERVAL_MS);
    setInterval(pollFinishedStatus, FINISHED_POLL_INTERVAL_MS);
    setInterval(pollVetoState, FINISHED_POLL_INTERVAL_MS);
    checkAndLoad();
  }

  init();
})();
