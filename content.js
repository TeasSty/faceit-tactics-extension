(() => {
  const PANEL_ID = "fta-panel";
  const STORAGE_COLLAPSED = "fta_collapsed";
  let currentMatchId = null;
  let currentMap = null;

  // ---------- helpers ----------

  function bg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => resolve(res || { error: "NO_RESPONSE" }));
    });
  }

  function num(v, def = 0) {
    const n = parseFloat(v);
    return Number.isNaN(n) ? def : n;
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
      toast("Текст вставлен в чат — проверь и нажми отправить.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("Поле чата не найдено на странице — текст скопирован (Ctrl+V в чат).");
    } catch {
      toast("Не удалось найти чат. Скопируй текст вручную из карточки игрока.");
    }
  }

  // ---------- tactic generation ----------

  function findMapSegment(segments, mapName) {
    if (!segments || !mapName) return null;
    return segments.find((s) => (s.label || "").toLowerCase() === mapName.toLowerCase()) || null;
  }

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

  // ---------- rendering ----------

  function renderPlayerCard(rd, mapName, teamKind) {
    const nickname = rd.roster.nickname;
    const avatar = rd.roster.avatar || "";
    const err = rd.error;
    const lt = (rd.stats && rd.stats.lifetime) || {};
    const level = (rd.player && rd.player.games && rd.player.games.cs2 && rd.player.games.cs2.skill_level) || "?";
    const elo = (rd.player && rd.player.games && rd.player.games.cs2 && rd.player.games.cs2.faceit_elo) || "?";
    const kd = num(lt["Average K/D Ratio"]);
    const wr = num(lt["Win Rate %"]);
    const hs = num(lt["Average Headshots %"]);
    const matches = num(lt["Matches"]);
    const mapSeg = findMapSegment(rd.stats && rd.stats.segments, mapName);
    const tactic = generateTactic(nickname, lt, mapSeg, mapName);

    const card = document.createElement("div");
    card.className = "fta-card";

    if (err === "NO_API_KEY" || err === "BAD_API_KEY") {
      card.innerHTML = `
        <div class="fta-card-head">
          <img class="fta-avatar" src="${avatar}" onerror="this.style.visibility='hidden'"/>
          <div class="fta-nick">${nickname}</div>
        </div>
        <div class="fta-error">Статистика недоступна: настрой API-ключ FACEIT в настройках расширения.</div>
      `;
      return card;
    }

    card.innerHTML = `
      <div class="fta-card-head">
        <img class="fta-avatar" src="${avatar}" onerror="this.style.visibility='hidden'"/>
        <div class="fta-nick-wrap">
          <div class="fta-nick">${nickname}</div>
          <div class="fta-sub">Lvl ${level} · ${elo} ELO</div>
        </div>
      </div>
      <div class="fta-stats-row">
        <div class="fta-stat"><span class="fta-stat-val">${kd ? kd.toFixed(2) : "—"}</span><span class="fta-stat-label">K/D</span></div>
        <div class="fta-stat"><span class="fta-stat-val">${wr ? wr.toFixed(0) + "%" : "—"}</span><span class="fta-stat-label">Winrate</span></div>
        <div class="fta-stat"><span class="fta-stat-val">${hs ? hs.toFixed(0) + "%" : "—"}</span><span class="fta-stat-label">HS%</span></div>
        <div class="fta-stat"><span class="fta-stat-val">${matches || "—"}</span><span class="fta-stat-label">Матчей</span></div>
      </div>
      ${teamKind === "own" ? `
      <div class="fta-tactic">${tactic}</div>
      <button class="fta-btn fta-insert-btn">Вставить тактику в чат</button>
      ` : ""}
    `;

    if (teamKind === "own") {
      const btn = card.querySelector(".fta-insert-btn");
      btn.addEventListener("click", () => insertToChat(tactic));
    }

    return card;
  }

  function renderPanel(state) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }
    panel.innerHTML = "";

    const collapsed = localStorage.getItem(STORAGE_COLLAPSED) === "1";
    if (collapsed) panel.classList.add("fta-collapsed");
    else panel.classList.remove("fta-collapsed");

    const header = document.createElement("div");
    header.className = "fta-header";
    header.innerHTML = `
      <span class="fta-title">FACEIT Tactics Assistant</span>
      <button class="fta-toggle">${collapsed ? "▸" : "▾"}</button>
    `;
    header.querySelector(".fta-toggle").addEventListener("click", () => {
      const isCollapsed = panel.classList.toggle("fta-collapsed");
      localStorage.setItem(STORAGE_COLLAPSED, isCollapsed ? "1" : "0");
      header.querySelector(".fta-toggle").textContent = isCollapsed ? "▸" : "▾";
    });
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "fta-body";
    panel.appendChild(body);

    if (state.loading) {
      body.innerHTML = `<div class="fta-loading">Загружаю данные матча…</div>`;
      return;
    }

    if (state.noApiKey) {
      body.innerHTML = `
        <div class="fta-error">
          Не настроен API-ключ FACEIT Data API.<br/>
          Открой настройки расширения и вставь ключ с
          <a href="https://developers.faceit.com/apps" target="_blank" rel="noopener">developers.faceit.com</a>.
        </div>
        <button class="fta-btn" id="fta-open-options">Открыть настройки</button>
      `;
      body.querySelector("#fta-open-options").addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      });
      return;
    }

    if (state.error) {
      body.innerHTML = `<div class="fta-error">Не удалось загрузить матч: ${state.error}</div>`;
      return;
    }

    if (state.mapName) {
      const mapEl = document.createElement("div");
      mapEl.className = "fta-map-banner";
      mapEl.textContent = `Карта: ${state.mapName}`;
      body.appendChild(mapEl);
    }

    if (state.bestMaps && state.bestMaps.length) {
      const bm = document.createElement("div");
      bm.className = "fta-summary";
      bm.innerHTML = `<b>Сильные карты команды:</b> ${state.bestMaps.join(", ")}`;
      body.appendChild(bm);
    }

    if (state.weakestEnemy) {
      const we = document.createElement("div");
      we.className = "fta-summary fta-target";
      we.innerHTML = `<b>Слабое звено у соперника:</b> ${state.weakestEnemy.roster.nickname} — приоритетная цель для давления.`;
      body.appendChild(we);
    }

    const tabs = document.createElement("div");
    tabs.className = "fta-tabs";
    tabs.innerHTML = `
      <button class="fta-tab fta-tab-active" data-team="own">Моя команда</button>
      <button class="fta-tab" data-team="enemy">Соперник</button>
    `;
    body.appendChild(tabs);

    const listOwn = document.createElement("div");
    listOwn.className = "fta-list";
    const listEnemy = document.createElement("div");
    listEnemy.className = "fta-list fta-hidden";

    for (const rd of state.own) listOwn.appendChild(renderPlayerCard(rd, state.mapName, "own"));
    for (const rd of state.enemy) listEnemy.appendChild(renderPlayerCard(rd, state.mapName, "enemy"));

    body.appendChild(listOwn);
    body.appendChild(listEnemy);

    tabs.querySelectorAll(".fta-tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        tabs.querySelectorAll(".fta-tab").forEach((b) => b.classList.remove("fta-tab-active"));
        tabBtn.classList.add("fta-tab-active");
        if (tabBtn.dataset.team === "own") {
          listOwn.classList.remove("fta-hidden");
          listEnemy.classList.add("fta-hidden");
        } else {
          listEnemy.classList.remove("fta-hidden");
          listOwn.classList.add("fta-hidden");
        }
      });
    });
  }

  // ---------- main flow ----------

  async function loadMatch(matchId) {
    renderPanel({ loading: true });

    const matchRes = await bg({ type: "FETCH_MATCH", matchId });

    if (matchRes.error === "NO_API_KEY") {
      renderPanel({ noApiKey: true });
      return;
    }
    if (matchRes.error) {
      renderPanel({ error: `${matchRes.error} (проверь ключ API или доступность матча)` });
      return;
    }

    const match = matchRes.data;
    const mapName = pickCurrentMap(match);
    currentMap = mapName;

    const teams = match.teams || {};
    const factionKeys = Object.keys(teams);
    if (factionKeys.length < 2) {
      renderPanel({ error: "Не удалось определить составы команд." });
      return;
    }

    // Best-effort: assume faction1 is "own" team (FACEIT usually orders the viewer's team first
    // when data is fetched with a matching auth context; otherwise both tabs are still available).
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

    renderPanel({
      mapName,
      own: ownData,
      enemy: enemyData,
      bestMaps,
      weakestEnemy
    });
  }

  async function checkAndLoad() {
    const href = location.href;
    const matchId = extractMatchId(href);
    if (!matchId) {
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.remove();
      currentMatchId = null;
      return;
    }
    if (matchId === currentMatchId) return;
    currentMatchId = matchId;
    await loadMatch(matchId);
  }

  function init() {
    patchHistoryForNavEvents();
    window.addEventListener("fta-locationchange", () => setTimeout(checkAndLoad, 300));
    const observer = new MutationObserver(() => {
      if (extractMatchId(location.href) !== currentMatchId) checkAndLoad();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    checkAndLoad();
  }

  init();
})();
