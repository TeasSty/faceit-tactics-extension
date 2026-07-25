(() => {
  const INLINE_CLASS = "fta-inline";
  const RECHECK_INTERVAL_MS = 3000;

  let currentMatchId = null;
  let lastMatchState = { ready: false };
  let recheckTimer = null;

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
      toast("Тактика вставлена в чат — проверь и нажми отправить.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("Поле чата не найдено — текст скопирован (Ctrl+V в чат).");
    } catch {
      toast("Не удалось найти чат. Скопируй текст вручную.");
    }
  }

  // ---------- stat extraction ----------

  const KNOWN_LIFETIME_KEYS = new Set([
    "Average K/D Ratio",
    "Average Headshots %",
    "Win Rate %",
    "Matches",
    "Wins",
    "Recent Results",
    "Current Win Streak",
    "Longest Win Streak"
  ]);

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

  function findBestWorstMap(segments) {
    if (!segments || !segments.length) return { best: null, worst: null };
    const withEnough = segments
      .map((s) => ({ label: s.label, wr: num(s.stats && s.stats["Win Rate %"]), matches: num(s.stats && s.stats["Matches"]) }))
      .filter((s) => s.matches >= 3);
    if (!withEnough.length) return { best: null, worst: null };
    const sorted = [...withEnough].sort((a, b) => b.wr - a.wr);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best === worst || (best && worst && best.label === worst.label)) return { best, worst: null };
    return { best, worst };
  }

  function getRecentForm(lt) {
    const recent = lt["Recent Results"];
    if (!Array.isArray(recent) || !recent.length) return null;
    return recent.map((r) => (r === "1" ? "W" : "L"));
  }

  function pickExtraStats(lt) {
    const extra = [];
    for (const [key, value] of Object.entries(lt)) {
      if (KNOWN_LIFETIME_KEYS.has(key)) continue;
      if (value == null) continue;
      if (typeof value === "object") continue;
      extra.push([key, value]);
      if (extra.length >= 6) break;
    }
    return extra;
  }

  // ---------- tactic generation ----------

  function generateTactic(nickname, lifetime, mapSegment, mapName) {
    lifetime = lifetime || {};
    const kd = num(lifetime["Average K/D Ratio"]);
    const hs = num(lifetime["Average Headshots %"]);
    const curStreak = num(lifetime["Current Win Streak"]);
    const recent = lifetime["Recent Results"] || [];
    const recentWins = recent.filter((r) => r === "1").length;

    const lines = [];

    if (kd >= 1.15) {
      lines.push(`ты фраг-лидер (K/D ${kd.toFixed(2)}) — бери первый контакт, открывай раунд, команда подстроится под твой вход.`);
    } else if (kd > 0 && kd <= 0.85) {
      lines.push(`K/D ${kd.toFixed(2)} — не форсируй дуэли в одиночку, играй вторым темпом, отдавай инфо и добивай.`);
    } else if (kd > 0) {
      lines.push(`K/D ${kd.toFixed(2)} — играй по ситуации, разменивайся, не лезь в неравные дуэли.`);
    }

    if (hs >= 52) {
      lines.push(`HS% ${hs.toFixed(0)} — доверяй прицелу в упор, спокойно дуэлься на ближней дистанции.`);
    } else if (hs > 0 && hs < 35) {
      lines.push(`HS% ${hs.toFixed(0)} — избегай долгих спрей-файтов издалека, лучше короткие дистанции и утилити перед входом.`);
    }

    if (mapName) {
      if (mapSegment && mapSegment.stats) {
        const mwr = num(mapSegment.stats["Win Rate %"]);
        const mMatches = num(mapSegment.stats["Matches"]);
        if (mMatches >= 5) {
          if (mwr >= 55) {
            lines.push(`на ${mapName} winrate ${mwr.toFixed(0)}% (${mMatches} матчей) — это твоя карта, бери инициативу.`);
          } else if (mwr > 0 && mwr <= 40) {
            lines.push(`на ${mapName} winrate ${mwr.toFixed(0)}% — играй аккуратно, полагайся на коллы и сетапы команды.`);
          } else {
            lines.push(`на ${mapName} статистика средняя (${mwr.toFixed(0)}%) — играй по стандартному плану.`);
          }
        } else {
          lines.push(`на ${mapName} у тебя мало сыгранных матчей — играй по коллам, не изобретай.`);
        }
      }
    }

    if (curStreak >= 3) {
      lines.push(`серия из ${curStreak} побед подряд — ты в форме, не сбавляй темп.`);
    } else if (recent.length >= 4 && recentWins <= 1) {
      lines.push(`последние матчи не идут — не тильтуй, играй проще, без лишнего риска.`);
    }

    if (!lines.length) lines.push("играй по плану команды, разменивайся на входах.");

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

  function suggestBestMaps(rosterData) {
    const counts = {};
    for (const rd of rosterData) {
      const segs = (rd.stats && rd.stats.segments) || [];
      for (const s of segs) {
        const wr = num(s.stats && s.stats["Win Rate %"]);
        const matches = num(s.stats && s.stats["Matches"]);
        if (matches >= 5 && wr >= 55) {
          counts[s.label] = (counts[s.label] || 0) + 1;
        }
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([map, votes]) => `${map} (${votes} сильных игрока)`);
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
    return `<div class="fta-row fta-recent"><span class="fta-row-label">Форма (посл. ${form.length})</span><span class="fta-dots">${dots}</span></div>`;
  }

  function buildStatCard(rd, mapName, teamKind, settings, ownRecentInfo) {
    const nickname = rd.roster.nickname;
    const nicknameSafe = escapeHtml(nickname);
    const err = rd.error;

    const card = document.createElement("div");
    card.className = `${INLINE_CLASS} fta-inline-${teamKind}`;

    if (err) {
      card.innerHTML = `<div class="fta-row fta-muted">${nicknameSafe}: статистика временно недоступна.</div>`;
      return card;
    }

    const lt = (rd.stats && rd.stats.lifetime) || {};
    const level = (rd.player && rd.player.games && rd.player.games.cs2 && rd.player.games.cs2.skill_level) || null;
    const elo = (rd.player && rd.player.games && rd.player.games.cs2 && rd.player.games.cs2.faceit_elo) || null;
    const kd = num(lt["Average K/D Ratio"]);
    const wr = num(lt["Win Rate %"]);
    const hs = num(lt["Average Headshots %"]);
    const matches = num(lt["Matches"]);
    const mapSeg = findMapSegment(rd.stats && rd.stats.segments, mapName);
    const sideStats = extractSideStats(mapSeg);
    const { best, worst } = findBestWorstMap(rd.stats && rd.stats.segments);
    const recentForm = getRecentForm(lt);
    const extraStats = pickExtraStats(lt);
    const tactic = generateTactic(nickname, lt, mapSeg, mapName);

    const chips = [];
    if (kd) chips.push(`<div class="fta-chip"><b>${kd.toFixed(2)}</b><span>K/D</span></div>`);
    if (wr) chips.push(`<div class="fta-chip"><b>${wr.toFixed(0)}%</b><span>Winrate</span></div>`);
    if (hs) chips.push(`<div class="fta-chip"><b>${hs.toFixed(0)}%</b><span>HS%</span></div>`);
    if (matches) chips.push(`<div class="fta-chip"><b>${matches}</b><span>Матчей</span></div>`);
    if (level) chips.push(`<div class="fta-chip"><b>${escapeHtml(level)}</b><span>Level</span></div>`);
    if (elo) chips.push(`<div class="fta-chip"><b>${escapeHtml(elo)}</b><span>ELO</span></div>`);

    let html = `<div class="fta-row fta-head"><span class="fta-nick">${nicknameSafe}</span></div>`;
    if (chips.length) html += `<div class="fta-row fta-chips">${chips.join("")}</div>`;

    if (sideStats) {
      const parts = [];
      if (sideStats.ct !== null) parts.push(`CT ${sideStats.ct.toFixed(0)}%`);
      if (sideStats.t !== null) parts.push(`T ${sideStats.t.toFixed(0)}%`);
      html += `<div class="fta-row"><span class="fta-row-label">Сторона (${escapeHtml(mapName)})</span><span>${parts.join(" · ")}</span></div>`;
    }

    if (mapSeg && mapSeg.stats) {
      const mwr = num(mapSeg.stats["Win Rate %"]);
      const mMatches = num(mapSeg.stats["Matches"]);
      if (mMatches > 0) {
        html += `<div class="fta-row"><span class="fta-row-label">На ${escapeHtml(mapName)}</span><span>${mwr.toFixed(0)}% (${mMatches} матчей)</span></div>`;
      }
    }

    if (best) {
      html += `<div class="fta-row"><span class="fta-row-label">Любимая карта</span><span>${escapeHtml(best.label)} — ${best.wr.toFixed(0)}%</span></div>`;
    }
    if (worst) {
      html += `<div class="fta-row"><span class="fta-row-label">Слабая карта</span><span>${escapeHtml(worst.label)} — ${worst.wr.toFixed(0)}%</span></div>`;
    }

    html += buildRecentFormHtml(recentForm);

    if (ownRecentInfo) {
      html += `<div class="fta-row"><span class="fta-row-label">Последние ${ownRecentInfo.sample} матчей</span><span>${ownRecentInfo.wins}-${ownRecentInfo.losses}</span></div>`;
    }

    if (extraStats.length) {
      html += `<details class="fta-extra"><summary>Ещё статистика</summary>`;
      for (const [key, value] of extraStats) {
        html += `<div class="fta-row fta-row-sm"><span class="fta-row-label">${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>`;
      }
      html += `</details>`;
    } else {
      html += `<div class="fta-row fta-muted fta-row-sm">ADR и рейтинг недоступны в публичном FACEIT API для этого игрока.</div>`;
    }

    if (teamKind === "own" && settings.showTactics) {
      html += `
        <details class="fta-tactic-wrap">
          <summary>Тактика</summary>
          <div class="fta-tactic-text">${escapeHtml(tactic)}</div>
          <button class="fta-insert-btn">Вставить в чат</button>
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

  function injectPlayer(rd, mapName, teamKind, settings, ownRecentInfo) {
    const anchor = findNicknameElement(rd.roster.nickname);
    if (!anchor) return null;
    const container = getInjectionContainer(anchor);
    const card = buildStatCard(rd, mapName, teamKind, settings, ownRecentInfo);
    container.appendChild(card);
    return card;
  }

  function ensureInjected() {
    if (!lastMatchState.ready) return;
    const { own, enemy, mapName, settings, ownRecentByPlayerId } = lastMatchState;
    for (const rd of own) {
      if (rd.injectedNode && rd.injectedNode.isConnected) continue;
      rd.injectedNode = injectPlayer(rd, mapName, "own", settings, ownRecentByPlayerId.get(rd.roster.player_id));
    }
    for (const rd of enemy) {
      if (rd.injectedNode && rd.injectedNode.isConnected) continue;
      rd.injectedNode = injectPlayer(rd, mapName, "enemy", settings, null);
    }
  }

  function clearInjected() {
    document.querySelectorAll(`.${INLINE_CLASS}`).forEach((el) => el.remove());
  }

  // ---------- main flow ----------

  async function loadMatch(matchId) {
    lastMatchState = { ready: false };

    const matchRes = await bg({ type: "FETCH_MATCH", matchId });
    if (matchRes.error) {
      if (matchRes.error !== "NOT_FOUND") toast("Сервер статистики временно недоступен.");
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

    const bestMaps = suggestBestMaps(ownData);
    const weakestEnemy = findWeakestLink(enemyData);
    const settings = await chrome.storage.sync.get({ showTactics: true, showSummary: true });

    lastMatchState = {
      ready: true,
      mapName,
      own: ownData,
      enemy: enemyData,
      bestMaps,
      weakestEnemy: weakestEnemy ? weakestEnemy.roster.nickname : null,
      headToHead: [],
      settings,
      ownRecentByPlayerId: new Map()
    };

    ensureInjected();

    if (settings.showSummary) {
      const { headToHead, ownRecent } = await computeHistoryInsights(ownData, enemyData);
      if (currentMatchId === matchId) {
        lastMatchState.headToHead = headToHead;
        lastMatchState.ownRecentByPlayerId = ownRecent;
        // Rebuild own-team cards so the "last N matches" line picks up history data.
        for (const rd of ownData) {
          if (rd.injectedNode && rd.injectedNode.isConnected) rd.injectedNode.remove();
          rd.injectedNode = null;
        }
        ensureInjected();
      }
    }
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

  // ---------- popup messaging ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "GET_MATCH_SUMMARY") {
      if (!lastMatchState.ready) {
        sendResponse({ ready: false });
        return;
      }
      sendResponse({
        ready: true,
        mapName: lastMatchState.mapName,
        bestMaps: lastMatchState.bestMaps,
        weakestEnemy: lastMatchState.weakestEnemy,
        headToHead: lastMatchState.headToHead
      });
    }
  });

  // ---------- init ----------

  function init() {
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
    });

    recheckTimer = setInterval(ensureInjected, RECHECK_INTERVAL_MS);
    checkAndLoad();
  }

  init();
})();
