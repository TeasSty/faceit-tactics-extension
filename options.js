// ---------- navigation ----------

const navItems = document.querySelectorAll(".nav-item[data-section]");
const panels = document.querySelectorAll(".panel[id^='section-']");

function showSection(name) {
  navItems.forEach((btn) => btn.classList.toggle("active", btn.dataset.section === name));
  panels.forEach((panel) => panel.classList.toggle("active", panel.id === `section-${name}`));
  history.replaceState(null, "", `#${name}`);
}

navItems.forEach((btn) => {
  btn.addEventListener("click", () => showSection(btn.dataset.section));
});

const initialSection = (location.hash || "").replace("#", "");
if ([...navItems].some((b) => b.dataset.section === initialSection)) {
  showSection(initialSection);
}

// ---------- settings toggles ----------

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

// ---------- server status ----------

const statusDot = document.getElementById("server-status-dot");
const statusText = document.getElementById("server-status-text");

async function checkServerStatus() {
  statusDot.className = "status-dot";
  statusText.textContent = "Проверка соединения…";
  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "PING_SERVER" }, (r) => resolve(r || { ok: false }));
  });
  if (res.ok) {
    statusDot.className = "status-dot ok";
    statusText.textContent = "Сервер подключён";
  } else {
    statusDot.className = "status-dot down";
    statusText.textContent = "Сервер недоступен";
  }
}

document.getElementById("recheck-server").addEventListener("click", checkServerStatus);
checkServerStatus();

// ---------- version / links ----------

const manifest = chrome.runtime.getManifest();
document.getElementById("version-tag").textContent = `v${manifest.version}`;
document.getElementById("about-version").textContent = manifest.version;

const githubLink = document.getElementById("github-link");
if (typeof FTA_CONFIG !== "undefined" && FTA_CONFIG.GITHUB_URL) {
  githubLink.href = FTA_CONFIG.GITHUB_URL;
} else {
  githubLink.style.display = "none";
}

if (typeof FTA_CONFIG !== "undefined" && FTA_CONFIG.DISCORD_URL) {
  const discordCard = document.getElementById("discord-card");
  discordCard.innerHTML = `
    <h3>Присоединяйся к сообществу</h3>
    <p>Обсуждение фич, баг-репорты и обновления расширения.</p>
  `;
  const link = document.createElement("a");
  link.className = "btn btn-primary";
  link.href = FTA_CONFIG.DISCORD_URL;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Открыть Discord";
  discordCard.appendChild(link);
}
