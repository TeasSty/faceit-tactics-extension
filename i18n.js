// Лёгкая своя локализация (не chrome.i18n) — нужна, чтобы пользователь мог
// переключить язык вручную из popup, а не только следовать языку браузера.

const FTA_STRINGS = {
  ru: {
    popup_status_checking: "Проверка…",
    popup_status_online: "Сервер онлайн",
    popup_status_offline: "Сервер недоступен",
    popup_hint: "Статистика и тактика отображаются прямо на странице комнаты матча FACEIT.",
    popup_match_map: "Карта",
    popup_match_weakest: "Слабое звено",
    popup_match_h2h: "Личные встречи",
    popup_finished_title: "Итоги матча",
    popup_finished_mvp: "Лучший в команде",
    popup_finished_weak: "Слабое звено команды",
    team_section_summary: "Сводка команды",
    team_avg: "Средние",
    team_maps_pick: "пик",
    team_maps_ban: "бан",
    popup_section_features: "Функции",
    popup_toggle_tactic: "Тактика в чат",
    popup_toggle_summary: "Сводка по команде",
    popup_section_language: "Язык",
    popup_section_more: "Ещё",
    popup_link_about: "About",
    popup_link_changelog: "Что нового",
    popup_link_premium: "Premium",
    popup_premium_badge: "скоро",
    popup_link_report: "Сообщить о баге",
    popup_premium_soon: "PRO-функции в разработке — пока всё бесплатно.",
    popup_version: "Версия",
    card_kd: "K/D",
    card_winrate: "Winrate",
    card_hs: "HS%",
    card_matches: "Матчей",
    card_level: "Level",
    card_elo: "ELO",
    card_side: "Сторона",
    card_form: "Форма (посл. {n})",
    card_history: "Последние {n} матчей",
    card_more: "Подробнее",
    tactic_summary: "Тактика",
    tactic_insert: "Вставить в чат",
    toast_inserted: "Тактика вставлена в чат — проверь и нажми отправить.",
    toast_copied: "Поле чата не найдено — текст скопирован (Ctrl+V в чат).",
    toast_failed: "Не удалось найти чат. Скопируй текст вручную.",
    toast_server_down: "Сервер статистики временно недоступен."
  },
  en: {
    popup_status_checking: "Checking…",
    popup_status_online: "Server online",
    popup_status_offline: "Server unavailable",
    popup_hint: "Stats and tactics show up right on the FACEIT match room page.",
    popup_match_map: "Map",
    popup_match_weakest: "Weakest link",
    popup_match_h2h: "Head-to-head",
    popup_finished_title: "Match summary",
    popup_finished_mvp: "Team MVP",
    popup_finished_weak: "Team's weak spot",
    team_section_summary: "Team summary",
    team_avg: "Average",
    team_maps_pick: "pick",
    team_maps_ban: "ban",
    popup_section_features: "Features",
    popup_toggle_tactic: "Chat tactic",
    popup_toggle_summary: "Team summary",
    popup_section_language: "Language",
    popup_section_more: "More",
    popup_link_about: "About",
    popup_link_changelog: "What's new",
    popup_link_premium: "Premium",
    popup_premium_badge: "soon",
    popup_link_report: "Report a bug",
    popup_premium_soon: "PRO features are in the works — everything's free for now.",
    popup_version: "Version",
    card_kd: "K/D",
    card_winrate: "Winrate",
    card_hs: "HS%",
    card_matches: "Matches",
    card_level: "Level",
    card_elo: "ELO",
    card_side: "Side",
    card_form: "Form (last {n})",
    card_history: "Last {n} matches",
    card_more: "Details",
    tactic_summary: "Tactic",
    tactic_insert: "Insert into chat",
    toast_inserted: "Tactic inserted into chat — check it and hit send.",
    toast_copied: "Chat box not found — text copied to clipboard (Ctrl+V in chat).",
    toast_failed: "Couldn't find the chat. Copy the text manually.",
    toast_server_down: "Stats server is temporarily unavailable."
  }
};

async function ftaInitLang() {
  const { lang } = await chrome.storage.sync.get({ lang: null });
  if (lang && FTA_STRINGS[lang]) {
    window.__ftaLang = lang;
    return lang;
  }
  const guess = (navigator.language || "ru").toLowerCase().startsWith("ru") ? "ru" : "en";
  await chrome.storage.sync.set({ lang: guess });
  window.__ftaLang = guess;
  return guess;
}

function ftaT(key, vars) {
  const lang = window.__ftaLang || "ru";
  let s = (FTA_STRINGS[lang] && FTA_STRINGS[lang][key]) || FTA_STRINGS.ru[key] || key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, vars[k]);
  }
  return s;
}
