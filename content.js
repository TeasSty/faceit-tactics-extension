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
    "mirage", "inferno", "dust2", "dust ii", "ancient", "nuke", "overpass", "vertigo", "anubis", "train"
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

  // FACEIT отдаёт этот эндпоинт только с реальной сессией браузера (нужны
  // cookies) — фоновый воркер расширения их не видит, поэтому запрос идёт
  // прямо из content-script на том же происхождении, что и сама страница.
  // При любой проблеме (403, смена формата и т.п.) тихо возвращаем null, и
  // вызывающий код падает на сегменты публичного Data API, ничего не ломая.
  async function fetchInternalGameStats(playerId) {
    try {
      const res = await fetch(`https://www.faceit.com/api/stats/v1/stats/users/${playerId}/games/cs2`, {
        credentials: "include"
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  function beautifyMapName(raw) {
    const stripped = String(raw || "").replace(/^de_/i, "");
    return stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase();
  }

  // Раскодировано вручную по легенде stats/v1/stats/configuration/cs2 (см.
  // историю чата) — k5=Average K/D Ratio, k6=Win Rate % (уже 0-100, не доля),
  // k8=Average Headshots %, k9=Average K/R Ratio, k17=ADR, k18=Entry Success
  // Rate, k19=Entry Rate, k26=Utility Damage per Round, k29=Sniper Kill Rate,
  // m1=Matches, m2=Wins, s1=Current Win Streak, s2=Longest Win Streak. Все
  // остальные коды из легенды (k20-k28 и т.п.) не используем.
  function decodeInternalStatObject(obj) {
    if (!obj) return null;
    return {
      kd: num(obj.k5),
      wr: num(obj.k6),
      hs: num(obj.k8),
      kr: num(obj.k9),
      adr: num(obj.k17),
      entrySuccessRate: num(obj.k18),
      entryRate: num(obj.k19),
      utilityDmgPerRound: num(obj.k26),
      sniperKillRate: num(obj.k29),
      matches: num(obj.m1),
      wins: num(obj.m2),
      currentStreak: num(obj.s1),
      longestStreak: num(obj.s2)
    };
  }

  // stats/v1/stats/users/{id}/games/cs2 отдаёт "lifetime" (сумма по всем
  // режимам, включая 1v1) и "segments" — по каждому режиму отдельно, а внутри
  // 5v5 ещё и по каждой карте (segmentId "csgo_map"). Именно карты 5v5 —
  // точный, без гадания пула, список для рекомендаций по банам и "Подробнее".
  function buildInternalGameStats(raw) {
    if (!raw) return { overall: null, fiveVFive: null, mapIndex: new Map() };
    const overall = decodeInternalStatObject(raw.lifetime);
    let fiveVFive = null;
    const mapIndex = new Map(); // normalizedLabel -> { label, matches, wr, kd, hs, kr, adr }

    for (const seg of Array.isArray(raw.segments) ? raw.segments : []) {
      const id = seg._id || {};
      if (id.gameMode !== "5v5") continue;
      const inner = seg.segments || {};
      if (id.segmentId === "competitions") {
        const only = Object.values(inner)[0];
        if (only) fiveVFive = decodeInternalStatObject(only);
      } else if (id.segmentId === "csgo_map") {
        for (const [mapKey, stats] of Object.entries(inner)) {
          const decoded = decodeInternalStatObject(stats);
          if (!decoded || !decoded.matches) continue;
          const label = beautifyMapName(mapKey);
          mapIndex.set(normalizeMapLabel(label), { label, ...decoded });
        }
      }
    }

    return { overall, fiveVFive, mapIndex };
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
  // internalMapIndex (см. buildInternalGameStats) — точнее и без гадания пула,
  // используется, когда доступен; сегменты публичного Data API — запасной путь.
  function getPlayerMapList(segments, internalMapIndex) {
    if (internalMapIndex && internalMapIndex.size) {
      return Array.from(internalMapIndex.values())
        .filter((m) => m.matches >= 3)
        .sort((a, b) => b.wr - a.wr);
    }
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

  // Рендер списка карт барами для карточки игрока в "Подробнее" — свой winrate
  // без сравнения с соперником (тот расчёт — только в командном блоке рекомендаций).
  function buildMapBarsHtml(mapList, { limit = 5 } = {}) {
    if (!mapList.length) return "";
    const list = mapList.slice(0, limit);
    let html = `<div class="fta-maps">`;
    list.forEach((m) => {
      const wr = m.wr != null ? m.wr : m.avgWr;
      const matchesLabel = m.matches ? `<span class="fta-map-matches">${m.matches}</span>` : "";
      html += `<div class="fta-map-row">
        <span class="fta-map-label">${escapeHtml(m.label)}</span>
        <div class="fta-bar"><div class="fta-bar-fill" style="width:${Math.min(wr, 100)}%"></div></div>
        <span class="fta-map-pct">${wr.toFixed(0)}%</span>
        ${matchesLabel}
      </div>`;
    });
    html += `</div>`;
    return html;
  }

  // ---------- tactic generation ----------
  //
  // Тактика — это анализ КОНКРЕТНОГО СОПЕРНИКА (карточка которого открыта), но
  // совет всегда адресован пользователю, который открыл страницу: "что МНЕ
  // делать против этого игрока", а не инструкция самому сопернику. Показывается
  // только на карточках вражеской команды (см. историю чата).
  //
  // Собирается из независимых блоков (общая оценка / поведение / статистика /
  // карта / приоритет), а не из одного связного текста — иначе при разных
  // цифрах получается один и тот же шаблон. Внутри каждого блока — банк
  // формулировок с одинаковым смыслом; порядок блоков в готовом тексте
  // перемешивается заново при каждой генерации.

  // Каждый пул формулировок помнит, что уже использовано В ЭТОМ МАТЧЕ (см.
  // resetTacticVariety, вызывается при загрузке нового матча) — так у 5 разных
  // карточек соперников не повторяются одни и те же фразы. Когда пул
  // исчерпан, начинает выдавать повторы (лучше повтор, чем совсем ничего).
  let tacticPoolUsage = new Map(); // poolKey -> Set of used indices

  function resetTacticVariety() {
    tacticPoolUsage = new Map();
  }

  function pickFromPool(poolKey, items, ctx) {
    let used = tacticPoolUsage.get(poolKey);
    if (!used) {
      used = new Set();
      tacticPoolUsage.set(poolKey, used);
    }
    let candidates = items.map((_, i) => i).filter((i) => !used.has(i));
    if (!candidates.length) {
      used.clear();
      candidates = items.map((_, i) => i);
    }
    const idx = candidates[Math.floor(Math.random() * candidates.length)];
    used.add(idx);
    const item = items[idx];
    return typeof item === "function" ? item(ctx) : item;
  }

  // ---- Блок 1: общая оценка (без цифр, только впечатление по уровню/форме) ----
  const TACTIC_TIER_PHRASES = {
    strong: [
      "Один из самых опасных игроков в этом составе.",
      "Лучше не недооценивать — статистика выше среднего по всем фронтам.",
      "Может неожиданно выдать очень сильную игру.",
      "Играет заметно увереннее среднего игрока лобби.",
      "По цифрам — один из ключевых игроков этой команды.",
      "Стабильно один из лучших в составе по статистике."
    ],
    weak: [
      "Слабое звено команды по статистике.",
      "Не является главным источником угрозы.",
      "По цифрам — один из самых уязвимых в составе.",
      "Статистика заметно ниже среднего по лобби.",
      "Наименее опасный игрок в этом составе."
    ],
    hot: [
      "Сейчас находится в хорошей форме.",
      "Играет заметно увереннее, чем обычно, судя по последним матчам.",
      "Недавно набрал хороший темп — жди уверенной игры.",
      "Последние результаты говорят о явном подъёме формы."
    ],
    cold: [
      "Последние игры провёл неудачно.",
      "Форма сейчас явно не на пике.",
      "В последних матчах заметен спад.",
      "Сейчас не в лучшем состоянии — можно этим воспользоваться."
    ],
    neutral: [
      "Игрок среднего уровня без явных перекосов.",
      "Ничем не выделяется по статистике — крепкий средний уровень.",
      "Ни явных сильных, ни явных слабых сторон по цифрам.",
      "Очень нестабильный соперник — то сильная игра, то провал.",
      "Результаты скачут от матча к матчу, предсказать сложно."
    ]
  };

  // ---- Блок 2: поведение — что делать при встрече с ним ----
  const TACTIC_AGGRESSIVE_ADVICE = [
    "Форси контакт — статистика на твоей стороне.",
    "Играй агрессивнее именно против него.",
    "Не давай ему разыграться — дави с первых раундов.",
    "Провоцируй на ошибку.",
    "Старайся первым находить контакт именно с ним.",
    "Не бойся навязывать перестрелки."
  ];
  const TACTIC_CAUTIOUS_ADVICE = [
    "Ищи размены, а не чистую дуэль.",
    "Не выходи против него в одиночку.",
    "Не отдавай первые пики.",
    "Не принимай ненужные дуэли.",
    "Дави гранатами перед контактом.",
    "Не давай ему занимать удобные позиции."
  ];
  const TACTIC_SITUATIONAL_ADVICE = [
    "Лучше оставить его напоследок.",
    "Если у тебя преимущество — добивай именно его.",
    "Играй медленнее против него, не форсируй зря.",
    "Не давай занимать удобные позиции с самого начала раунда."
  ];

  // ---- Блок 5: приоритет цели ----
  const TACTIC_PRIORITY_HIGH = [
    "Это главная цель твоей команды на этот матч.",
    "Если выбираешь, с кем вступать в контакт — начинай с него.",
    "Не позволяй ему разыграться в начале матча.",
    "При возможности ищи контакт именно с ним — обезвредить его первым выгодно всей команде."
  ];
  const TACTIC_PRIORITY_LOW = [
    "Можно оставить его на потом.",
    "Не трать лишние ресурсы только ради него.",
    "Не самый приоритетный соперник в этом составе."
  ];

  // Роль соперника угадывается по частоте входов/использования снайперки/урону
  // утилити — реальные поля из легенды stats/v1/stats/configuration/cs2 (k18
  // Entry Success Rate, k19 Entry Rate, k26 Utility Damage per Round, k29
  // Sniper Kill Rate), а не выдумка. Пороги подобраны на глаз по одному
  // аккаунту — это эвристика, поэтому формулировки осторожные ("похоже").
  // Возвращает null, если внутренний API недоступен или сигнал неочевиден.
  function detectOpponentRoleHint(internal) {
    if (!internal) return null;
    const { sniperKillRate, entryRate, entrySuccessRate, utilityDmgPerRound, kd } = internal;

    if (sniperKillRate && sniperKillRate >= 0.15) {
      return pickFromPool("role-awp", [
        "Часто играет от снайперки — не пересекай его вероятные линии в одиночку, заходи со флешкой или обходи угол.",
        "Похоже, это его AWP — держись вне открытых коридоров, где он может держать угол издалека.",
        "Берёт снайперку заметно чаще среднего — сначала выбей его позицию гранатой, потом заходи."
      ]);
    }
    if (entryRate && entryRate >= 0.22) {
      const succ = entrySuccessRate ? ` (успешность входов ${(entrySuccessRate * 100).toFixed(0)}%)` : "";
      return pickFromPool("role-entry", [
        (c) => `Часто заходит первым${c.succ} — держи ранний контакт под кроссом, не давай ему зайти без сопротивления.`,
        (c) => `Любит открывать раунды сам${c.succ} — жди его на входе с заранее занятой позицией, а не разбирайся по ситуации.`,
        (c) => `Обычно именно он идёт первым${c.succ} — можно заранее готовить кросс-файр на его входе.`
      ], { succ });
    }
    if (entryRate && entryRate <= 0.1 && kd > 0.9) {
      return pickFromPool("role-lurker", [
        "Почти не открывает раунды сам — играет на поздний тайминг, будь готов, что он появится не сразу, а в конце раунда.",
        "Редко идёт первым — типичный лёркер, проверяй тылы перед ротацией, не расслабляйся под конец раунда.",
        "Не любит открывать раунд — жди его позже, отдельно от основного пуша команды."
      ]);
    }
    if (utilityDmgPerRound && utilityDmgPerRound >= 5) {
      return pickFromPool("role-support", [
        "Часто помогает команде утилити — сначала выбивай его гранаты и зрение, потом уже заходи.",
        "Урон от гранат выше среднего — он скорее поддержит вход, чем сам будет фрагать, приоритетнее убрать его гранаты, чем самого игрока.",
        "Активно использует утилити — рассчитывай на дым/флеш перед его входами, береги HP заранее."
      ]);
    }
    return null;
  }

  // Тир игрока определяет, из какого пула брать блок 1 (общая оценка) и блок 5
  // (приоритет), и склоняет блок 2 (поведение) к агрессивной или осторожной
  // стороне. "neutral" — честный случай, когда явного сигнала нет (не пытаемся
  // выдумать нестабильность, которую не можем измерить).
  function computeTacticTier(kd, adr, recentInfo, curStreak) {
    if (recentInfo && recentInfo.sample >= 5) {
      const wr30 = recentInfo.wins / recentInfo.sample;
      if (wr30 >= 0.6) return "hot";
      if (wr30 <= 0.35) return "cold";
    } else if (curStreak >= 3) {
      return "hot";
    }
    if (kd >= 1.15 || (adr && adr >= 85)) return "strong";
    if (kd > 0 && kd <= 0.85 && (!adr || adr <= 65)) return "weak";
    return "neutral";
  }

  function generateTactic(lifetime, mapSegment, mapName, recentInfo, internalMapIndex, internalRoleStats) {
    lifetime = lifetime || {};
    const kd = num(lifetime["Average K/D Ratio"]);
    const hs = num(lifetime["Average Headshots %"]);
    const curStreak = num(lifetime["Current Win Streak"]);
    const adr = internalRoleStats && internalRoleStats.adr;

    const tier = computeTacticTier(kd, adr, recentInfo, curStreak);
    const parts = [];

    // ---- блок 1: общая оценка ----
    parts.push(pickFromPool(`tier-${tier}`, TACTIC_TIER_PHRASES[tier]));

    // ---- блок "роль" (контригра), не всегда доступен ----
    const roleHint = detectOpponentRoleHint(internalRoleStats);
    if (roleHint) parts.push(roleHint);

    // ---- блок 2: поведение — агрессивный или осторожный пул по тиру ----
    const behaviorPool =
      tier === "strong" || tier === "hot"
        ? TACTIC_CAUTIOUS_ADVICE
        : tier === "weak" || tier === "cold"
        ? TACTIC_AGGRESSIVE_ADVICE
        : Math.random() < 0.5
        ? TACTIC_AGGRESSIVE_ADVICE
        : TACTIC_CAUTIOUS_ADVICE;
    const behaviorKey =
      behaviorPool === TACTIC_AGGRESSIVE_ADVICE ? "behavior-aggressive" : "behavior-cautious";
    parts.push(pickFromPool(behaviorKey, behaviorPool));
    if (Math.random() < 0.35) parts.push(pickFromPool("behavior-situational", TACTIC_SITUATIONAL_ADVICE));

    // ---- блок 3: вывод по статистике — берём 1-2 случайных из того, что реально triggers ----
    const statCandidates = [];
    if (kd >= 1.15) {
      statCandidates.push(() => pickFromPool("stat-kd-high", [
        (c) => `K/D ${c.kd} — стабильно выигрывает большинство перестрелок.`,
        (c) => `K/D ${c.kd} говорит, что выходит победителем из дуэлей чаще, чем большинство соперников.`,
        (c) => `С K/D ${c.kd} фрагует много и уверенно — статистика дуэлей явно в его пользу.`
      ], { kd: kd.toFixed(2) }));
    } else if (kd > 0 && kd <= 0.85) {
      statCandidates.push(() => pickFromPool("stat-kd-low", [
        (c) => `K/D ${c.kd} — часто проигрывает первые контакты.`,
        (c) => `С K/D ${c.kd} нечасто выходит победителем из перестрелок.`,
        (c) => `K/D ${c.kd} ниже среднего — не самый страшный визави один на один.`
      ], { kd: kd.toFixed(2) }));
    }
    if (adr && adr >= 85) {
      statCandidates.push(() => pickFromPool("stat-adr-high", [
        (c) => `ADR ${c.adr} — даже проигрывая дуэль, обычно успевает нанести много урона.`,
        (c) => `При ADR ${c.adr} он опасен даже в проигрышных перестрелках, учитывай это при добивании.`,
        (c) => `ADR ${c.adr} выше среднего — после размена с ним жди мало HP.`
      ], { adr: adr.toFixed(0) }));
    } else if (adr && adr <= 65) {
      statCandidates.push(() => pickFromPool("stat-adr-low", [
        (c) => `ADR ${c.adr} — редко наносит серьёзный урон за раунд.`,
        (c) => `По урону не самый опасный (ADR ${c.adr}) — можно смелее переигрывать в перестрелке.`
      ], { adr: adr.toFixed(0) }));
    }
    if (hs >= 52) {
      statCandidates.push(() => pickFromPool("stat-hs-high", [
        (c) => `HS% ${c.hs} — не подставляй голову без необходимости.`,
        (c) => `При HS% ${c.hs} он метко бьёт в голову — сокращай дистанцию, чтобы снизить его преимущество.`,
        (c) => `HS% ${c.hs} говорит, что он опасен на дальней дистанции — используй укрытия.`
      ], { hs: hs.toFixed(0) }));
    } else if (hs > 0 && hs < 35) {
      statCandidates.push(() => pickFromPool("stat-hs-low", [
        (c) => `HS% ${c.hs} — чаще играет через спрей, чем через быстрые хедшоты.`,
        (c) => `Дальние перестрелки не его конёк (HS% ${c.hs}) — не так страшен издалека.`
      ], { hs: hs.toFixed(0) }));
    }
    if (recentInfo && recentInfo.sample >= 5) {
      const wr30 = recentInfo.wins / recentInfo.sample;
      if (wr30 >= 0.6) {
        statCandidates.push(() => pickFromPool("stat-wr30-high", [
          "Последние матчи проводит очень уверенно.",
          "Форма сейчас на подъёме — не жди случайных ошибок.",
          "В последних играх выигрывает чаще, чем проигрывает."
        ]));
      } else if (wr30 <= 0.35) {
        statCandidates.push(() => pickFromPool("stat-wr30-low", [
          "Последние результаты оставляют пространство для давления.",
          "Форма просела — психологическое давление может сработать.",
          "В недавних матчах чаще проигрывает, чем побеждает."
        ]));
      }
    }
    if (statCandidates.length) {
      // перемешиваем и берём 1-2, чтобы не перегружать текст всеми сразу
      for (let i = statCandidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [statCandidates[i], statCandidates[j]] = [statCandidates[j], statCandidates[i]];
      }
      statCandidates.slice(0, Math.min(2, statCandidates.length)).forEach((fn) => parts.push(fn()));
    }

    // ---- блок 4: карта ----
    const internalMapEntry = mapName && internalMapIndex && internalMapIndex.get(normalizeMapLabel(mapName));
    if (mapName && (internalMapEntry || (mapSegment && mapSegment.stats))) {
      const mwr = internalMapEntry ? internalMapEntry.wr : num(mapSegment.stats["Win Rate %"]);
      const mMatches = internalMapEntry ? internalMapEntry.matches : num(mapSegment.stats["Matches"]);
      if (mMatches >= 5) {
        if (mwr >= 55) {
          parts.push(pickFromPool("map-good", [
            (c) => `На ${c.map} чувствует себя значительно увереннее (winrate ${c.wr}%) — не давай ему свободно закрепиться.`,
            (c) => `${c.map} — одна из лучших карт в его пуле (${c.wr}% из ${c.matches}), жди агрессии с его стороны.`,
            (c) => `Здесь у него стабильно хорошие показатели побед (${c.wr}%) — карта явно его.`
          ], { map: mapName, wr: mwr.toFixed(0), matches: mMatches }));
        } else if (mwr > 0 && mwr <= 40) {
          parts.push(pickFromPool("map-bad", [
            (c) => `На ${c.map} результаты ниже среднего (winrate ${c.wr}%) — можно давить с самого начала раунда.`,
            (c) => `${c.map} ему явно не подходит (${c.wr}%) — самое время играть первым номером против него здесь.`,
            (c) => `Статистика на ${c.map} заметно слабее обычного (${c.wr}%), карта не его.`
          ], { map: mapName, wr: mwr.toFixed(0) }));
        }
      } else {
        parts.push(pickFromPool("map-low-sample", [
          (c) => `На ${c.map} играет редко — статистика не показательна.`,
          (c) => `Опыта на ${c.map} у него немного, не изобретай под него специально.`
        ], { map: mapName }));
      }
    }

    // ---- блок 5: приоритет (только при явном сигнале, не выдумываем на ровном месте) ----
    if ((tier === "strong" || tier === "hot") && Math.random() < 0.7) {
      parts.push(pickFromPool("priority-high", TACTIC_PRIORITY_HIGH));
    } else if ((tier === "weak" || tier === "cold") && Math.random() < 0.7) {
      parts.push(pickFromPool("priority-low", TACTIC_PRIORITY_LOW));
    }

    if (parts.length < 2) {
      parts.push(pickFromPool("fallback", [
        "По остальным показателям ничего выделяющегося — играй стандартно, без специальной подготовки под него.",
        "Явных слабых мест по цифрам не видно — придётся разбираться по игре, а не по статистике."
      ]));
    }

    // Порядок блоков каждый раз перемешивается — иначе даже с разными
    // формулировками текст будет читаться как один и тот же шаблон.
    for (let i = parts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [parts[i], parts[j]] = [parts[j], parts[i]];
    }

    return parts.join(" ");
  }

  // ---------- data loading ----------

  async function loadPlayerData(playerId) {
    const [pRes, sRes, internalRaw] = await Promise.all([
      bg({ type: "FETCH_PLAYER", playerId }),
      bg({ type: "FETCH_PLAYER_STATS", playerId, game: "cs2" }),
      fetchInternalGameStats(playerId)
    ]);
    const internal = buildInternalGameStats(internalRaw);
    return {
      player: pRes.data || null,
      stats: sRes.data || null,
      error: pRes.error || sRes.error,
      internalMapIndex: internal.mapIndex,
      internalOverall: internal.overall,
      internalFiveVFive: internal.fiveVFive,
      internalLongestStreak: (internal.overall && internal.overall.longestStreak) || 0
    };
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

  // ---------- map ban/pick recommendations ----------

  // Суммарный winrate*matches команды по каждой карте — не среднее по игрокам,
  // а взвешенное по числу сыгранных матчей, чтобы игрок с 40 матчами на карте
  // значил больше, чем игрок с 3.
  function computeTeamMapTotals(rosterData) {
    const byMap = new Map(); // label -> { wrSum, matches }
    const addEntry = (label, wr, m) => {
      if (!m) return;
      if (!byMap.has(label)) byMap.set(label, { wrSum: 0, matches: 0 });
      const entry = byMap.get(label);
      entry.wrSum += wr * m;
      entry.matches += m;
    };
    for (const rd of rosterData) {
      if (rd.internalMapIndex && rd.internalMapIndex.size) {
        for (const m of rd.internalMapIndex.values()) addEntry(m.label, m.wr, m.matches);
        continue;
      }
      const segs = (rd.stats && rd.stats.segments) || [];
      for (const s of segs) {
        if (!isCompetitiveMap(s.label)) continue;
        addEntry(s.label, num(s.stats && s.stats["Win Rate %"]), num(s.stats && s.stats["Matches"]));
      }
    }
    return byMap;
  }

  // Средний winrate команды за последние 30 матчей (все карты) — форма прямо
  // сейчас, а не lifetime-статистика.
  function computeTeamRecentAvg(rosterData, recentByPlayerId) {
    if (!recentByPlayerId) return null;
    const vals = [];
    for (const rd of rosterData) {
      const r = recentByPlayerId.get(rd.roster.player_id);
      if (r && r.sample >= 3) vals.push((r.wins / r.sample) * 100);
    }
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  // Вероятность (0-100), что карта выгодна ИМЕННО команде пользователя — не
  // просто её собственный winrate, а разница между "силой" своей команды и
  // команды соперника на этой карте. Сила команды на карте — winrate по карте,
  // сглаженный (shrinkage) к общему приоритету команды (lifetime winrate + форма
  // за 30 матчей), чтобы маленькая выборка на карте не давала ложной уверенности.
  function computeMapRecommendations(ownData, enemyData, ownRecentByPlayerId, enemyRecentByPlayerId) {
    const SHRINK_K = 8; // "вес" приоритета в матчах-эквивалентах

    const ownAvgs = computeTeamAverages(ownData);
    const enemyAvgs = computeTeamAverages(enemyData);
    const ownRecentAvg = computeTeamRecentAvg(ownData, ownRecentByPlayerId);
    const enemyRecentAvg = computeTeamRecentAvg(enemyData, enemyRecentByPlayerId);

    const blendPrior = (lifetimeWr, recentWr) => {
      if (lifetimeWr != null && recentWr != null) return (lifetimeWr + recentWr) / 2;
      if (lifetimeWr != null) return lifetimeWr;
      if (recentWr != null) return recentWr;
      return 50;
    };
    const ownPrior = blendPrior(ownAvgs.wr, ownRecentAvg);
    const enemyPrior = blendPrior(enemyAvgs.wr, enemyRecentAvg);

    const ownByMap = computeTeamMapTotals(ownData);
    const enemyByMap = computeTeamMapTotals(enemyData);

    const maps = new Set([...ownByMap.keys(), ...enemyByMap.keys()]);
    const list = [];
    for (const label of maps) {
      const o = ownByMap.get(label);
      const e = enemyByMap.get(label);
      const ownScore = o ? (o.wrSum + ownPrior * SHRINK_K) / (o.matches + SHRINK_K) : ownPrior;
      const enemyScore = e ? (e.wrSum + enemyPrior * SHRINK_K) / (e.matches + SHRINK_K) : enemyPrior;
      const probability = Math.min(95, Math.max(5, 50 + (ownScore - enemyScore)));
      list.push({ label, probability, sample: (o ? o.matches : 0) + (e ? e.matches : 0) });
    }

    list.sort((a, b) => b.probability - a.probability);
    return list;
  }

  function mapRecoTier(probability) {
    if (probability >= 62) return { tier: "good", key: "map_reco_keep" };
    if (probability <= 38) return { tier: "bad", key: "map_reco_ban" };
    return { tier: "neutral", key: "map_reco_neutral" };
  }

  // Форма за последние 30 матчей одной команды — используется и для своей
  // команды (WR30 в карточке, тактика), и для соперника (расчёт рекомендаций
  // по картам).
  async function fetchRecentForm(rosterData) {
    const recent = new Map(); // playerId -> { wins, losses, sample }
    await Promise.all(
      rosterData.map(async (rd) => {
        const playerId = rd.roster.player_id;
        const res = await bg({ type: "FETCH_PLAYER_HISTORY", playerId, game: "cs2", limit: 30 });
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
            if (players.some((p) => p.player_id === playerId)) ownFactionKey = fKey;
          }
          if (!ownFactionKey) continue;

          const winnerFaction = item.results && item.results.winner;
          if (winnerFaction === ownFactionKey) wins += 1;
          else losses += 1;
        }

        if (wins + losses > 0) recent.set(playerId, { wins, losses, sample: wins + losses });
      })
    );
    return recent;
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

  // Грубая проверка "это фирменный оранжевый FACEIT или нет" — с допуском по
  // диапазону, а не точным совпадением hex, потому что мы не знаем точный код
  // цвета подсветки собственного ника в живой вёрстке FACEIT, только то, что
  // он оранжевый.
  function isFaceitOrange(colorStr) {
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(colorStr || "");
    if (!m) return false;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    return r >= 200 && g >= 40 && g <= 150 && b <= 70;
  }

  // FACEIT подсвечивает ник самого пользователя в списке составов фирменным
  // оранжевым (в отличие от обычного белого/серого текста у остальных
  // игроков) — более прямой сигнал, чем поиск в шапке ниже: сам ник в
  // ростере, а не догадка по аккаунт-меню. Ищем среди всех 10 ников матча
  // элемент с таким цветом текста.
  function findOwnNicknameByColor(allNicknames) {
    const target = new Set(allNicknames.map((n) => (n || "").trim().toLowerCase()).filter(Boolean));
    if (!target.size) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (el.closest && el.closest(`.${INLINE_CLASS}`)) return NodeFilter.FILTER_REJECT;
        if (el.children.length > 0) return NodeFilter.FILTER_SKIP;
        const text = (el.textContent || "").trim().toLowerCase();
        return target.has(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      if (isFaceitOrange(getComputedStyle(node).color)) return (node.textContent || "").trim();
    }
    return null;
  }

  // Определяем, за какую команду "болеет" пользователь, открывший страницу —
  // ищем его собственный ник в шапке/аккаунт-меню сайта (единственное место на
  // странице, где виден ник владельца сессии вне ростеров обеих команд). Тот же
  // приём точного совпадения текста в конкретной области, что и для остальных
  // best-effort поисков. Если не нашли — вызывающий код падает на прежнее
  // допущение (первая команда в ответе API считается "своей").
  function findOwnNicknameOnPage(allNicknames) {
    if (!allNicknames.length) return null;
    const target = new Set(allNicknames.map((n) => (n || "").trim().toLowerCase()).filter(Boolean));
    const scopes = document.querySelectorAll(
      "header, nav, [class*='header' i], [class*='topbar' i], [class*='navbar' i], [class*='usermenu' i], [class*='accountmenu' i], [class*='profile' i]"
    );
    for (const scope of scopes) {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
        acceptNode(el) {
          if (el.closest && el.closest(`.${INLINE_CLASS}`)) return NodeFilter.FILTER_REJECT;
          if (el.children.length > 0) return NodeFilter.FILTER_SKIP;
          const t = (el.textContent || "").trim().toLowerCase();
          return target.has(t) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      });
      const node = walker.nextNode();
      if (node) return (node.textContent || "").trim();
    }
    return null;
  }

  // Тот же приём точного совпадения текста, что и для ника пользователя выше —
  // используется, чтобы найти название карты прямо в родной панели Pick/Ban
  // FACEIT и приклеить к нему бейдж с рекомендацией. usedSet не даёт зацепиться
  // дважды за один и тот же узел, если в вёрстке есть повторы.
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

  // Рекомендации по банам встраиваются прямо в родную панель Pick/Ban FACEIT —
  // маленький бейдж (процент + метка) сразу после названия каждой карты в её
  // списке, а не отдельный блок где-то ещё. Бейдж только добавляется рядом с
  // найденным текстом и никогда не трогает сам элемент карты — сломать
  // интерактивность вето он не может, а просто не найти место — может (нет
  // доступа к реальной вёрстке live-виджета, только best-effort поиск по тексту).
  let mapRecoBadgeNodes = [];

  function clearMapRecoBadges() {
    mapRecoBadgeNodes.forEach((el) => el.isConnected && el.remove());
    mapRecoBadgeNodes = [];
  }

  function ensureMapRecoBadges() {
    if (!lastMatchState.ready || !lastMatchState.settings || !lastMatchState.settings.showSummary) return;
    if (lastMatchState.mapName) {
      // Карта уже выбрана — стадия банов позади, бейджи больше не нужны.
      if (mapRecoBadgeNodes.length) clearMapRecoBadges();
      return;
    }
    if (mapRecoBadgeNodes.some((el) => el.isConnected)) return;

    const { own, enemy, ownRecentByPlayerId, enemyRecentByPlayerId } = lastMatchState;
    const recos = computeMapRecommendations(own, enemy, ownRecentByPlayerId, enemyRecentByPlayerId);
    if (recos.length < 2) return;

    clearMapRecoBadges();
    const used = new Set();
    for (const m of recos) {
      const el = findTextElement(m.label, used);
      if (!el) continue;
      used.add(el);
      const { tier, key } = mapRecoTier(m.probability);
      const badge = document.createElement("span");
      badge.className = `${INLINE_CLASS} fta-map-badge fta-tier-${tier}`;
      badge.innerHTML = `<span class="fta-map-badge-dot"></span><span class="fta-map-badge-pct">${m.probability.toFixed(0)}%</span><span class="fta-map-badge-label">${ftaT(key)}</span>`;
      el.insertAdjacentElement("afterend", badge);
      mapRecoBadgeNodes.push(badge);
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

  function buildStatCard(rd, mapName, teamKind, settings, recentInfo) {
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
    const kills = num(lt["Average Kills"]);
    const deaths = num(lt["Average Deaths"]);
    const assists = num(lt["Average Assists"]);
    const mvps = num(lt["Average MVPs"]);
    const streak = num(lt["Current Win Streak"]);
    const mapSeg = findMapSegment(rd.stats && rd.stats.segments, mapName);
    const sideStats = extractSideStats(mapSeg);
    const mapList = getPlayerMapList(rd.stats && rd.stats.segments, rd.internalMapIndex);
    const recentForm = getRecentForm(lt);
    const tactic =
      teamKind === "enemy" ? generateTactic(lt, mapSeg, mapName, recentInfo, rd.internalMapIndex, rd.internalFiveVFive || rd.internalOverall) : null;

    // Ник, ELO и Level уже показывает сама FACEIT прямо над местом вставки —
    // дублировать не нужно. Строка статистики — сразу под аватаркой/ником.
    const stats = [];
    if (kd) stats.push([ftaT("card_kd"), kd.toFixed(2)]);
    if (hs) stats.push([ftaT("card_hs"), `${hs.toFixed(0)}%`]);
    if (wr) stats.push([ftaT("card_winrate"), `${wr.toFixed(0)}%`]);
    if (matches) stats.push([ftaT("card_matches"), matches]);
    if (kills && deaths) stats.push([ftaT("card_kda"), `${kills.toFixed(1)}/${deaths.toFixed(1)}${assists ? "/" + assists.toFixed(1) : ""}`]);
    if (mvps) stats.push([ftaT("card_mvp"), mvps.toFixed(2)]);
    if (streak) stats.push([ftaT("card_streak"), streak]);
    if (rd.internalLongestStreak) stats.push([ftaT("card_best_streak"), rd.internalLongestStreak]);
    // ADR/K-R — из внутреннего API FACEIT, декодировано по официальной легенде
    // stats/v1/stats/configuration/cs2 (k17=ADR, k9=Average K/R Ratio); K/R
    // есть только в разрезе 5v5-сегмента, ADR — в общем lifetime.
    const adr = rd.internalOverall && rd.internalOverall.adr;
    const kr = (rd.internalFiveVFive && rd.internalFiveVFive.kr) || (rd.internalOverall && rd.internalOverall.kr);
    if (adr) stats.push([ftaT("card_adr"), adr.toFixed(0)]);
    if (kr) stats.push([ftaT("card_kr"), kr.toFixed(2)]);
    if (recentInfo && recentInfo.sample >= 5) {
      stats.push([ftaT("card_wr30"), `${Math.round((recentInfo.wins / recentInfo.sample) * 100)}%`]);
    }

    let html = "";
    if (stats.length) {
      html += `<div class="fta-stat-strip">${stats
        .map(([label, value]) => `<div class="fta-stat"><b>${value}</b><span>${label}</span></div>`)
        .join("")}</div>`;
    }
    html += buildRecentFormHtml(recentForm);

    // ---- "Подробнее": this player's own map breakdown, not raw API leftovers ----
    const moreParts = [];
    if (mapList.length) moreParts.push(buildMapBarsHtml(mapList, { limit: 4 }));
    if (sideStats) {
      const parts = [];
      if (sideStats.ct !== null) parts.push(`CT ${sideStats.ct.toFixed(0)}%`);
      if (sideStats.t !== null) parts.push(`T ${sideStats.t.toFixed(0)}%`);
      moreParts.push(`<div class="fta-row fta-row-sm"><span class="fta-row-label">${ftaT("card_side")} (${escapeHtml(mapName)})</span><span>${parts.join(" · ")}</span></div>`);
    }
    if (recentInfo) {
      moreParts.push(`<div class="fta-row fta-row-sm"><span class="fta-row-label">${ftaT("card_history", { n: recentInfo.sample })}</span><span><span class="fta-w">${recentInfo.wins}W</span> · <span class="fta-l">${recentInfo.losses}L</span></span></div>`);
    }
    if (moreParts.length) {
      html += `<details class="fta-extra"><summary>${ftaT("card_more")}</summary>${moreParts.join("")}</details>`;
    }

    if (teamKind === "enemy" && settings.showTactics) {
      html += `
        <details class="fta-tactic-wrap">
          <summary>${ftaT("tactic_summary")}</summary>
          <div class="fta-tactic-text">${escapeHtml(tactic)}</div>
          <button class="fta-insert-btn">${ftaT("tactic_insert")}</button>
        </details>
      `;
    }

    card.innerHTML = html;

    if (teamKind === "enemy" && settings.showTactics) {
      const btn = card.querySelector(".fta-insert-btn");
      if (btn) btn.addEventListener("click", () => insertToChat(tactic));
    }

    // Карточка игрока у FACEIT кликабельна целиком (ведёт на профиль) — клик
    // по "Подробнее"/"Тактика" внутри неё всплывает и срабатывает как переход
    // на профиль вместо обычного раскрытия <details>. Гасим всплытие клика на
    // уровне всей нашей вставки, чтобы она вела себя как обычный интерактивный
    // блок, а не часть кликабельной карточки.
    card.addEventListener("click", (e) => e.stopPropagation());

    return card;
  }


  function injectPlayer(rd, mapName, teamKind, settings, recentInfo) {
    const anchor = findNicknameElement(rd.roster.nickname);
    if (!anchor) return null;
    const container = getInjectionContainer(anchor);
    const card = buildStatCard(rd, mapName, teamKind, settings, recentInfo);
    container.appendChild(card);
    return { card, container };
  }

  // FACEIT — React-приложение: при перерисовке списка составов React может
  // переиспользовать существующий DOM-узел под ДРУГОГО игрока (если ключи
  // списка нестабильны), просто заменив текст ника внутри него. Наша карточка
  // при этом остаётся физически подключена к DOM (isConnected === true), но
  // теперь висит под чужим именем — снаружи это выглядит как "перепутал
  // соперника с тиммейтом". Поэтому мало проверить, что узел всё ещё в DOM —
  // нужно перепроверять, что в контейнере всё ещё есть текст именно ЭТОГО
  // игрока, и при расхождении переустанавливать карточку.
  function isCardStillAnchored(rd) {
    if (!rd.injectedNode || !rd.injectedNode.isConnected) return false;
    if (!rd.injectedContainer || !rd.injectedContainer.isConnected) return false;
    const nickname = (rd.roster.nickname || "").trim();
    if (!nickname) return false;
    return (rd.injectedContainer.textContent || "").includes(nickname);
  }

  function reinjectPlayer(rd, mapName, teamKind, settings, recentInfo) {
    if (rd.injectedNode && rd.injectedNode.isConnected) rd.injectedNode.remove();
    const result = injectPlayer(rd, mapName, teamKind, settings, recentInfo);
    rd.injectedNode = result ? result.card : null;
    rd.injectedContainer = result ? result.container : null;
  }

  function ensureInjected() {
    if (!lastMatchState.ready) return;
    const { own, enemy, mapName, settings, ownRecentByPlayerId, enemyRecentByPlayerId } = lastMatchState;
    for (const rd of own) {
      if (isCardStillAnchored(rd)) continue;
      reinjectPlayer(rd, mapName, "own", settings, ownRecentByPlayerId.get(rd.roster.player_id));
    }
    for (const rd of enemy) {
      if (isCardStillAnchored(rd)) continue;
      reinjectPlayer(rd, mapName, "enemy", settings, enemyRecentByPlayerId.get(rd.roster.player_id));
    }
    ensureMapRecoBadges();
  }

  function clearInjected() {
    document.querySelectorAll(`.${INLINE_CLASS}`).forEach((el) => el.remove());
    mapRecoBadgeNodes = [];
  }

  // ---------- main flow ----------

  async function loadMatch(matchId) {
    lastMatchState = { ready: false };
    resetTacticVariety();

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

    const factionARoster = (teams[factionKeys[0]] && teams[factionKeys[0]].roster) || [];
    const factionBRoster = (teams[factionKeys[1]] && teams[factionKeys[1]].roster) || [];

    const settings = await chrome.storage.sync.get({ showTactics: true, showSummary: true, myNickname: "" });
    const allNicknames = [...factionARoster, ...factionBRoster].map((r) => r.nickname);

    // Анализ всегда строится от лица пользователя, который открыл страницу — а не
    // произвольно от "первой" команды в ответе API. Порядок попыток, от самого
    // надёжного к самому слабому: 1) ник из настроек расширения (100% точно,
    // если задан); 2) собственный ник подсвечен у FACEIT фирменным оранжевым
    // прямо в ростере — сигнал прямее, чем шапка; 3) поиск в шапке/аккаунт-меню
    // сайта; 4) если вообще ничего не сработало — прежнее допущение (первая
    // команда считается "своей"). Пункты 2 и 3 — best-effort, живая вёрстка
    // FACEIT нам недоступна для проверки.
    let ownRoster = factionARoster;
    let enemyRoster = factionBRoster;
    const manualNickname = (settings.myNickname || "").trim();
    const manualMatches = manualNickname && allNicknames.some((n) => (n || "").toLowerCase() === manualNickname.toLowerCase());
    const viewerNickname =
      (manualMatches ? manualNickname : null) || findOwnNicknameByColor(allNicknames) || findOwnNicknameOnPage(allNicknames);
    if (viewerNickname) {
      const viewerLower = viewerNickname.toLowerCase();
      const viewerInB = factionBRoster.some((r) => (r.nickname || "").toLowerCase() === viewerLower);
      if (viewerInB) {
        ownRoster = factionBRoster;
        enemyRoster = factionARoster;
      }
    }

    const [ownData, enemyData] = await Promise.all([
      Promise.all(ownRoster.map(async (roster) => ({ roster, ...(await loadPlayerData(roster.player_id)) }))),
      Promise.all(enemyRoster.map(async (roster) => ({ roster, ...(await loadPlayerData(roster.player_id)) })))
    ]);

    lastMatchState = {
      ready: true,
      mapName,
      own: ownData,
      enemy: enemyData,
      settings,
      viewerNickname,
      ownRecentByPlayerId: new Map(),
      enemyRecentByPlayerId: new Map()
    };

    ensureInjected();

    if (settings.showSummary) {
      const [ownRecent, enemyRecent] = await Promise.all([fetchRecentForm(ownData), fetchRecentForm(enemyData)]);
      if (currentMatchId === matchId) {
        lastMatchState.ownRecentByPlayerId = ownRecent;
        lastMatchState.enemyRecentByPlayerId = enemyRecent;
        rebuildInjected([...ownData, ...enemyData]);
      }
    }
  }

  function rebuildInjected(rosterData) {
    for (const rd of rosterData) {
      if (rd.injectedNode && rd.injectedNode.isConnected) rd.injectedNode.remove();
      rd.injectedNode = null;
      rd.injectedContainer = null;
    }
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
      if (area === "sync" && (changes.showTactics || changes.showSummary || changes.myNickname) && currentMatchId) {
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
    checkAndLoad();
  }

  init();
})();
