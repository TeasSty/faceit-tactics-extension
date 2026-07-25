/**
 * FACEIT Tactics Assistant — прокси-сервер (Cloudflare Worker).
 *
 * Держит настоящий FACEIT Data API ключ в секретах Cloudflare (никогда не
 * попадает в код расширения). Расширение обращается сюда, воркер добавляет
 * Authorization-заголовок и перенаправляет запрос в open.faceit.com.
 *
 * Деплой: см. server/README.md.
 */

const FACEIT_API_BASE = "https://open.faceit.com/data/v4";

// Разрешаем проксировать только конкретные пути FACEIT Data API — расширению
// не нужно ничего больше, а открытый прокси на весь faceit API было бы риском.
const ALLOWED_PATH_PREFIXES = ["/matches/", "/players/"];

// Кэшируем ответы на короткое время: снижает число запросов к FACEIT API
// (у него есть rate limit) и ускоряет повторные открытия одной комнаты.
const CACHE_TTL_SECONDS = 30;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Extension-Key",
    "Access-Control-Max-Age": "86400"
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // Простой health-check без секретов и без обращения к FACEIT API.
    if (url.pathname === "/health") {
      return json({ ok: true }, 200, origin);
    }

    // Разрешаем запросы только со страниц расширения. Origin — это обычный
    // заголовок, его теоретически можно подделать вне браузера, поэтому это
    // не криптографическая защита, а первый фильтр от случайного трафика.
    if (!origin.startsWith("chrome-extension://")) {
      return json({ error: "FORBIDDEN_ORIGIN" }, 403, origin);
    }

    // Второй, более значимый фильтр — общий "секрет" зашитый в код расширения.
    // Он виден любому, кто распакует .crx (это open-source расширение), так
    // что это защита от массового автоматического скрапинга, а не от
    // целенаправленной атаки. Для более серьёзной защиты добавь сюда
    // Cloudflare Turnstile или собственную выдачу коротких токенов.
    if (env.EXTENSION_SHARED_KEY) {
      const provided = request.headers.get("X-Extension-Key") || "";
      if (provided !== env.EXTENSION_SHARED_KEY) {
        return json({ error: "FORBIDDEN_KEY" }, 403, origin);
      }
    }

    if (!url.pathname.startsWith("/api/")) {
      return json({ error: "NOT_FOUND" }, 404, origin);
    }

    const upstreamPath = url.pathname.replace(/^\/api/, "");
    if (!ALLOWED_PATH_PREFIXES.some((p) => upstreamPath.startsWith(p))) {
      return json({ error: "FORBIDDEN_PATH" }, 403, origin);
    }

    if (!env.FACEIT_API_KEY) {
      return json({ error: "SERVER_MISCONFIGURED" }, 500, origin);
    }

    const upstreamUrl = `${FACEIT_API_BASE}${upstreamPath}${url.search}`;
    const cacheKey = new Request(upstreamUrl, request);
    const cache = caches.default;

    let upstreamRes = await cache.match(cacheKey);
    if (!upstreamRes) {
      upstreamRes = await fetch(upstreamUrl, {
        headers: { Authorization: `Bearer ${env.FACEIT_API_KEY}` },
        cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true }
      });
      if (upstreamRes.ok) {
        ctx.waitUntil(cache.put(cacheKey, upstreamRes.clone()));
      }
    }

    const body = await upstreamRes.text();
    return new Response(body, {
      status: upstreamRes.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
    });
  }
};
