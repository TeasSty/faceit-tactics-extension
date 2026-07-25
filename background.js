importScripts("config.js");

const { WORKER_BASE_URL, EXTENSION_SHARED_KEY } = FTA_CONFIG;

async function apiGet(path) {
  try {
    const res = await fetch(`${WORKER_BASE_URL}${path}`, {
      headers: EXTENSION_SHARED_KEY ? { "X-Extension-Key": EXTENSION_SHARED_KEY } : {}
    });
    if (!res.ok) {
      if (res.status === 403) return { error: "FORBIDDEN", status: res.status };
      if (res.status === 404) return { error: "NOT_FOUND", status: res.status };
      if (res.status === 500) return { error: "SERVER_ERROR", status: res.status };
      return { error: "HTTP_ERROR", status: res.status };
    }
    const data = await res.json();
    return { data };
  } catch (e) {
    return { error: "NETWORK_ERROR", message: String(e) };
  }
}

async function pingServer() {
  try {
    const res = await fetch(`${WORKER_BASE_URL.replace(/\/api$/, "")}/health`, {
      headers: EXTENSION_SHARED_KEY ? { "X-Extension-Key": EXTENSION_SHARED_KEY } : {}
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

// Показываем короткую страницу приветствия только один раз, сразу после
// первой установки — дальше всё работает само, без открытия отдельных
// вкладок или страниц настроек.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    switch (msg.type) {
      case "PING_SERVER": {
        sendResponse(await pingServer());
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
      case "FETCH_MATCH_STATS": {
        sendResponse(await apiGet(`/matches/${msg.matchId}/stats`));
        break;
      }
      default:
        sendResponse({ error: "UNKNOWN_MESSAGE" });
    }
  })();

  return true; // keep the message channel open for the async response
});
