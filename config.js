// Адрес твоего прокси-сервера (Cloudflare Worker) — см. server/README.md.
// FACEIT API ключ хранится ТОЛЬКО там, в этот файл он никогда не попадает.
// После деплоя воркера замени WORKER_BASE_URL и EXTENSION_SHARED_KEY ниже.
const FTA_CONFIG = {
  WORKER_BASE_URL: "https://faceit-tactics-proxy.gwho12345678.workers.dev/api",
  EXTENSION_SHARED_KEY: "50da8904fb0820b92f21665befdb5badc7d3be83",
  GITHUB_URL: "https://github.com/TeasSty/faceit-tactics-extension"
};
