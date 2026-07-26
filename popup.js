const CHANGELOG = {
  ru: [
    { v: "0.7.0", text: "Исправлен баг: командный блок больше не отображается внутри карточки конкретного игрока. Тактика теперь учитывает статистику за последние ~30 матчей, а не только карьерный K/D. Убраны дублирующиеся ELO/Level и ник (FACEIT их и так показывает). Счёт побед/поражений теперь явно подписан W/L. Кнопка «Подробнее»/«Тактика» — нейтральный серый цвет вместо оранжевого." },
    { v: "0.6.0", text: "Карточка игрока: внизу одна горизонтальная строка с K/D, HS%, Winrate, матчами, ELO и Level. Тактика теперь только про самого игрока (роль, сильные стороны, на что обратить внимание) — без советов против соперника. «Подробнее» показывает карты игрока барами вместо бесполезных сырых полей API. Карты фильтруются по актуальному соревновательному маппулу FACEIT. Добавлены best-effort бейджи винрейта карт на этапе банов." },
    { v: "0.5.0", text: "Карточки игроков сжаты примерно вдвое: только ключевые цифры и бар winrate на виду, остальное — за «Подробнее». Итоги матча убраны из карточек игроков и показываются один раз в командном блоке. Добавлены средние по команде и карты с барами и рекомендацией пик/бан." },
    { v: "0.4.0", text: "Сводка по команде и итоги завершённого матча перенесены со страницы popup прямо на страницу FACEIT — popup теперь только настройки." },
    { v: "0.3.0", text: "Статистика и тактика встроены прямо в страницу FACEIT. Добавлены язык, аналитика завершённого матча и приоритетная цель в тактике." },
    { v: "0.2.0", text: "FACEIT API ключ перенесён на собственный сервер — пользователю больше не нужно ничего вводить." },
    { v: "0.1.0", text: "Первая версия: статистика игроков, персональная тактика, сводка по команде." }
  ],
  en: [
    { v: "0.7.0", text: "Fixed a bug where the team block rendered inside a specific player's own card. Tactic now factors in the last ~30 matches, not just career K/D. Removed the duplicate ELO/Level and nickname (FACEIT already shows both). Win/loss counts are now explicitly labeled W/L. The Details/Tactic toggle is neutral gray instead of orange." },
    { v: "0.6.0", text: "Player card: one horizontal row at the bottom with K/D, HS%, Winrate, matches, ELO and Level. Tactic is now about the player themself (role, strengths, what to watch for) — no more opponent-targeting advice. Details now shows the player's own map breakdown with bars instead of raw API leftovers. Maps are filtered to FACEIT's current competitive map pool. Added best-effort map-winrate badges during the ban stage." },
    { v: "0.5.0", text: "Player cards are roughly half the height now: only the key numbers and a winrate bar stay visible, everything else lives under Details. Finished-match results moved out of player cards into the team block. Added team averages and a map list with bars and a pick/ban recommendation." },
    { v: "0.4.0", text: "Team summary and finished-match analytics moved from the popup onto the FACEIT page itself — the popup is settings-only now." },
    { v: "0.3.0", text: "Stats and tactics live inside the FACEIT page. Added language switch, finished-match analytics, and a priority-target tactic." },
    { v: "0.2.0", text: "The FACEIT API key moved to a private server — nothing to enter anymore." },
    { v: "0.1.0", text: "First version: player stats, personal tactics, team summary." }
  ]
};

const cfg = typeof FTA_CONFIG !== "undefined" ? FTA_CONFIG : {};

function applyStaticTexts() {
  document.getElementById("pop-hint").textContent = ftaT("popup_hint");
  document.getElementById("label-features").textContent = ftaT("popup_section_features");
  document.getElementById("label-tactic").textContent = ftaT("popup_toggle_tactic");
  document.getElementById("label-summary").textContent = ftaT("popup_toggle_summary");
  document.getElementById("label-nickname").textContent = ftaT("popup_label_nickname");
  document.getElementById("hint-nickname").textContent = ftaT("popup_hint_nickname");
  document.getElementById("myNickname").placeholder = ftaT("popup_nickname_placeholder");
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
  const myNicknameInput = document.getElementById("myNickname");
  const { showTactics, showSummary, myNickname } = await chrome.storage.sync.get({
    showTactics: true,
    showSummary: true,
    myNickname: ""
  });
  showTacticsInput.checked = showTactics;
  showSummaryInput.checked = showSummary;
  myNicknameInput.value = myNickname;
  showTacticsInput.addEventListener("change", () => {
    chrome.storage.sync.set({ showTactics: showTacticsInput.checked });
  });
  showSummaryInput.addEventListener("change", () => {
    chrome.storage.sync.set({ showSummary: showSummaryInput.checked });
  });
  myNicknameInput.addEventListener("change", () => {
    chrome.storage.sync.set({ myNickname: myNicknameInput.value.trim() });
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
}

main();
