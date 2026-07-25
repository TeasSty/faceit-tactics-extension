// ---------- version ----------

const manifest = chrome.runtime.getManifest();
document.getElementById("version-tag").textContent = `v${manifest.version}`;

// ---------- server status ----------

const statusDot = document.getElementById("server-status-dot");
const statusText = document.getElementById("server-status-text");

chrome.runtime.sendMessage({ type: "PING_SERVER" }, (res) => {
  if (res && res.ok) {
    statusDot.className = "status-dot ok";
    statusText.textContent = "Сервер онлайн";
  } else {
    statusDot.className = "status-dot down";
    statusText.textContent = "Сервер недоступен";
  }
});

// ---------- settings ----------

const showTacticsInput = document.getElementById("showTactics");
const showSummaryInput = document.getElementById("showSummary");

chrome.storage.sync.get({ showTactics: true, showSummary: true }).then(({ showTactics, showSummary }) => {
  showTacticsInput.checked = showTactics;
  showSummaryInput.checked = showSummary;
});

showTacticsInput.addEventListener("change", () => {
  chrome.storage.sync.set({ showTactics: showTacticsInput.checked });
});
showSummaryInput.addEventListener("change", () => {
  chrome.storage.sync.set({ showSummary: showSummaryInput.checked });
});

// ---------- current match summary (asks the content script on the active tab) ----------

const matchBody = document.getElementById("match-body");

function escapeHtml(str) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => map[c]);
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "GET_MATCH_SUMMARY" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ready) return; // not on a room page, or not loaded yet
    renderMatchSummary(res);
  });
});

function renderMatchSummary(state) {
  const lines = [];
  if (state.mapName) lines.push(`<div class="match-line">Карта: <b>${escapeHtml(state.mapName)}</b></div>`);
  if (state.bestMaps && state.bestMaps.length) {
    lines.push(`<div class="match-line">Сильные карты: <b>${escapeHtml(state.bestMaps.join(", "))}</b></div>`);
  }
  if (state.weakestEnemy) {
    lines.push(`<div class="match-line">Слабое звено: <b>${escapeHtml(state.weakestEnemy)}</b></div>`);
  }
  if (state.headToHead && state.headToHead.length) {
    const h2h = state.headToHead
      .map((e) => `${escapeHtml(e.nickname)} ${e.wins}-${e.losses}`)
      .join(" · ");
    lines.push(`<div class="match-line">Личные встречи: <b>${h2h}</b></div>`);
  }
  matchBody.innerHTML = lines.length ? lines.join("") : `<p class="muted">Матч загружен, сводка пока пустая.</p>`;
}

// ---------- links ----------

const cfg = typeof FTA_CONFIG !== "undefined" ? FTA_CONFIG : {};

const discordLink = document.getElementById("discord-link");
if (cfg.DISCORD_URL) {
  discordLink.href = cfg.DISCORD_URL;
} else {
  discordLink.addEventListener("click", (e) => e.preventDefault());
  discordLink.style.opacity = "0.5";
  discordLink.title = "Discord-сервер ещё не создан";
}

const aboutLink = document.getElementById("about-link");
if (cfg.GITHUB_URL) {
  aboutLink.href = cfg.GITHUB_URL;
} else {
  aboutLink.addEventListener("click", (e) => e.preventDefault());
}

document.getElementById("premium-link").addEventListener("click", () => {
  const status = document.getElementById("update-status");
  status.textContent = "PRO-функции в разработке — пока всё в расширении бесплатно.";
});

document.getElementById("update-check").addEventListener("click", () => {
  const status = document.getElementById("update-status");
  status.textContent = "Проверяю обновления…";
  chrome.runtime.requestUpdateCheck((s) => {
    if (s === "update_available") status.textContent = "Доступно обновление — перезапусти браузер.";
    else if (s === "no_update") status.textContent = "Установлена последняя версия.";
    else status.textContent = "Не удалось проверить обновления.";
  });
});
