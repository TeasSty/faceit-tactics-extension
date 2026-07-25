const API_BASE = "https://open.faceit.com/data/v4";

async function getApiKey() {
  // Ключ хранится в storage.local (не синхронизируется через аккаунт Google) —
  // это личный секрет пользователя, ему незачем покидать устройство.
  const { faceitApiKey } = await chrome.storage.local.get("faceitApiKey");
  return faceitApiKey || "";
}

async function apiGet(path) {
  const key = await getApiKey();
  if (!key) {
    return { error: "NO_API_KEY" };
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { error: "BAD_API_KEY", status: res.status };
      }
      if (res.status === 404) {
        return { error: "NOT_FOUND", status: res.status };
      }
      return { error: "HTTP_ERROR", status: res.status };
    }
    const data = await res.json();
    return { data };
  } catch (e) {
    return { error: "NETWORK_ERROR", message: String(e) };
  }
}

// Открываем страницу настроек только один раз — сразу после первой установки,
// чтобы пользователь сразу увидел, куда вставить API-ключ. При апдейтах и
// перезапусках браузера страница настроек сама больше никогда не выскакивает.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    switch (msg.type) {
      case "OPEN_OPTIONS": {
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        break;
      }
      case "FETCH_MATCH": {
        sendResponse(await apiGet(`/matches/${msg.matchId}`));
        break;
      }
      case "FETCH_PLAYER": {
        sendResponse(await apiGet(`/players/${msg.playerId}`));
        break;
      }
      case "FETCH_PLAYER_STATS": {
        sendResponse(await apiGet(`/players/${msg.playerId}/stats/${msg.game || "cs2"}`));
        break;
      }
      case "FETCH_PLAYER_HISTORY": {
        const limit = msg.limit || 30;
        sendResponse(await apiGet(`/players/${msg.playerId}/history?game=${msg.game || "cs2"}&offset=0&limit=${limit}`));
        break;
      }
      default:
        sendResponse({ error: "UNKNOWN_MESSAGE" });
    }
  })();

  return true; // keep the message channel open for the async response
});
