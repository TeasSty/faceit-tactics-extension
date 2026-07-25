# FACEIT Tactics Assistant — прокси-сервер

Cloudflare Worker, который держит FACEIT API ключ на сервере и проксирует
запросы расширения к `open.faceit.com`. Ключ никогда не попадает в код
расширения и не виден пользователю.

Бесплатного тарифа Cloudflare Workers (100 000 запросов/день) с большим
запасом хватает для личного использования / небольшой команды.

## Деплой (один раз, 5 минут)

1. Установи Wrangler (CLI Cloudflare), если ещё нет:
   ```bash
   npm install -g wrangler
   ```
2. Авторизуйся (откроется браузер):
   ```bash
   wrangler login
   ```
3. Перейди в папку `server` и задеплой:
   ```bash
   cd server
   wrangler deploy
   ```
   В выводе появится адрес воркера вида
   `https://faceit-tactics-proxy.<твой-поддомен>.workers.dev`.
4. Задай секреты (значения вводятся в интерактивном промпте, никуда не
   логируются):
   ```bash
   wrangler secret put FACEIT_API_KEY
   wrangler secret put EXTENSION_SHARED_KEY
   ```
   - `FACEIT_API_KEY` — твой Server-side ключ с https://developers.faceit.com/apps
   - `EXTENSION_SHARED_KEY` — любая случайная строка (например, результат
     `openssl rand -hex 20`), просто общий пароль между расширением и
     воркером от случайного трафика.

## Подключение расширения к воркеру

Открой `config.js` в корне расширения и пропиши:

```js
const FTA_CONFIG = {
  WORKER_BASE_URL: "https://faceit-tactics-proxy.<твой-поддомен>.workers.dev/api",
  EXTENSION_SHARED_KEY: "тот же секрет, что и в шаге 4"
};
```

Перезагрузи расширение в `chrome://extensions` — готово, ключ пользователю
вводить не нужно никогда.

## Обновление ключа в будущем

Если понадобится сменить FACEIT API ключ (например, истёк или скомпрометирован):

```bash
wrangler secret put FACEIT_API_KEY
```

Значение обновится мгновенно, пересобирать и переустанавливать расширение не нужно.

## Что проксируется

Воркер пропускает только `GET /api/matches/*` и `GET /api/players/*` —
ровно то, что нужно расширению. Все остальные пути и все запросы не с
`chrome-extension://`-origin отклоняются с 403.
