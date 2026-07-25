const CHANGELOG = {
  ru: [
    { v: "0.3.0", text: "Статистика и тактика теперь встроены прямо в страницу FACEIT. Popup стал единственным местом настроек, добавлены язык, аналитика завершённого матча и приоритетная цель в тактике." },
    { v: "0.2.0", text: "FACEIT API ключ перенесён на собственный сервер — пользователю больше не нужно ничего вводить." },
    { v: "0.1.0", text: "Первая версия: статистика игроков, персональная тактика, сводка по команде." }
  ],
  en: [
    { v: "0.3.0", text: "Stats and tactics now live inside the FACEIT page itself. The popup is the single settings surface — added language switch, finished-match analytics, and a priority-target tactic." },
    { v: "0.2.0", text: "The FACEIT API key moved to a private server — nothing to enter anymore." },
    { v: "0.1.0", text: "First version: player stats, personal tactics, team summary." }
  ]
};

const cfg = typeof FTA_CONFIG !== "undefined" ? FTA_CONFIG : {};

function applyStaticTexts() {
  document.getElementById("label-match").textContent = ftaT("popup_section_match");
  document.getElementById("match-empty-text").textContent = ftaT("popup_match_empty");
  document.getElementById("label-finished").textContent = ftaT("popup_finished_title");
  document.getElementById("label-features").textContent = ftaT("popup_section_features");
  document.getElementById("label-tactic").textContent = ftaT("popup_toggle_tactic");
  document.getElementById("label-summary").textContent = ftaT("popup_toggle_summary");
  document.getElementById("label-language").textContent = ftaT("popup_section_language");
  document.getElementById("label-more").textContent = ftaT("popup_section_more");
  document.getElementById("label-about").textContent = ftaT("popup_link_about");
  document.getElementById("label-changelog").textContent = ftaT("popup_link_changelog");
  document.getElementById("label-premium").textContent = ftaT("popup_link_premium");
  document.getElementById("premium-badge").textContent = ftaT("popup_premium_badge");
  document.getElementById("label-report").textContent = ftaT("popup_link_report");
  document.getElementById("label-version").textContent = ftaT("popup_version");
}

function renderChangelog() {
  const lang = window.__ftaLang || "ru";
  const entries = CHANGELOG[lang] || CHANGELOG.ru;
  const body = document.getElementById("changelog-body");
  body.innerHTML = entries
    .map((e) => `<div class="changelog-entry"><span class="changelog-version">v${e.v}</span>${escapeHtml(e.text)}</div>`)
    .join("");
}

function escapeHtml(str) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => map[c]);
}

function updateLangButtons() {
  const lang = window.__ftaLang || "ru";
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === lang);
  });
}

async function main() {
  await ftaInitLang();
  applyStaticTexts();
  updateLangButtons();
  renderChangelog();

  // version
  const manifest = chrome.runtime.getManifest();
  document.getElementById("version-tag").textContent = manifest.version;

  // server status
  const statusDot = document.getElementById("server-status-dot");
  const statusText = document.getElementById("server-status-text");
  statusText.textContent = ftaT("popup_status_checking");
  chrome.runtime.sendMessage({ type: "PING_SERVER" }, (res) => {
    if (res && res.ok) {
      statusDot.className = "status-dot ok";
      statusText.textContent = ftaT("popup_status_online");
    } else {
      statusDot.className = "status-dot down";
      statusText.textContent = ftaT("popup_status_offline");
    }
  });

  // settings
  const showTacticsInput = document.getElementById("showTactics");
  const showSummaryInput = document.getElementById("showSummary");
  const { showTactics, showSummary } = await chrome.storage.sync.get({ showTactics: true, showSummary: true });
  showTacticsInput.checked = showTactics;
  showSummaryInput.checked = showSummary;
  showTacticsInput.addEventListener("change", () => {
    chrome.storage.sync.set({ showTactics: showTacticsInput.checked });
  });
  showSummaryInput.addEventListener("change", () => {
    chrome.storage.sync.set({ showSummary: showSummaryInput.checked });
  });

  // language switch
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const lang = btn.dataset.lang;
      await chrome.storage.sync.set({ lang });
      window.__ftaLang = lang;
      applyStaticTexts();
      updateLangButtons();
      renderChangelog();
    });
  });

  // changelog toggle
  document.getElementById("changelog-toggle").addEventListener("click", () => {
    const body = document.getElementById("changelog-body");
    body.hidden = !body.hidden;
  });

  // premium
  document.getElementById("premium-link").addEventListener("click", () => {
    document.getElementById("update-status").textContent = ftaT("popup_premium_soon");
  });

  // links
  const aboutLink = document.getElementById("about-link");
  const reportLink = document.getElementById("report-link");
  if (cfg.GITHUB_URL) {
    aboutLink.href = cfg.GITHUB_URL;
    reportLink.href = `${cfg.GITHUB_URL}/issues/new`;
  } else {
    aboutLink.addEventListener("click", (e) => e.preventDefault());
    reportLink.addEventListener("click", (e) => e.preventDefault());
  }

  // current match summary
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "GET_MATCH_SUMMARY" }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ready) return;
      renderMatchSummary(res);
    });
  });
}

function renderMatchSummary(state) {
  const lines = [];
  if (state.mapName) lines.push([ftaT("popup_match_map"), escapeHtml(state.mapName)]);
  if (state.bestMaps && state.bestMaps.length) lines.push([ftaT("popup_match_bestmaps"), escapeHtml(state.bestMaps.join(", "))]);
  if (state.weakestEnemy) lines.push([ftaT("popup_match_weakest"), escapeHtml(state.weakestEnemy)]);
  if (state.headToHead && state.headToHead.length) {
    const h2h = state.headToHead.map((e) => `${escapeHtml(e.nickname)} ${e.wins}-${e.losses}`).join(" · ");
    lines.push([ftaT("popup_match_h2h"), h2h]);
  }

  const matchBody = document.getElementById("match-body");
  if (lines.length) {
    matchBody.innerHTML = lines.map(([label, value]) => `<div class="match-line"><span>${label}</span><b>${value}</b></div>`).join("");
  }

  if (state.finished && (state.finished.mvp || state.finished.weak)) {
    const section = document.getElementById("finished-section");
    const body = document.getElementById("finished-body");
    const flines = [];
    if (state.finished.mvp) flines.push([ftaT("popup_finished_mvp"), escapeHtml(state.finished.mvp)]);
    if (state.finished.weak) flines.push([ftaT("popup_finished_weak"), escapeHtml(state.finished.weak)]);
    body.innerHTML = flines.map(([label, value]) => `<div class="match-line"><span>${label}</span><b>${value}</b></div>`).join("");
    section.hidden = false;
  }
}

main();
