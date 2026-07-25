// Адрес твоего прокси-сервера (Cloudflare Worker) — см. server/README.md.
// FACEIT API ключ хранится ТОЛЬКО там, в этот файл он никогда не попадает.
// После деплоя воркера замени WORKER_BASE_URL и EXTENSION_SHARED_KEY ниже.
const FTA_CONFIG = {
  WORKER_BASE_URL: "https://faceit-tactics-proxy.YOUR-SUBDOMAIN.workers.dev/api",
  EXTENSION_SHARED_KEY: "REPLACE_WITH_YOUR_SHARED_SECRET",
  // Необязательно: ссылка-приглашение в Discord-сервер, если появится.
  DISCORD_URL: "",
  GITHUB_URL: "https://github.com/TeasSty/faceit-tactics-extension"
};
