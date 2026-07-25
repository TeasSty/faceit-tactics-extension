const input = document.getElementById("apiKey");
const status = document.getElementById("status");
const showTacticsInput = document.getElementById("showTactics");

chrome.storage.local.get({ faceitApiKey: "" }).then(({ faceitApiKey }) => {
  if (faceitApiKey) input.value = faceitApiKey;
});
chrome.storage.sync.get({ showTactics: true }).then(({ showTactics }) => {
  showTacticsInput.checked = showTactics;
});

document.getElementById("save").addEventListener("click", async () => {
  const value = input.value.trim();
  await chrome.storage.local.set({ faceitApiKey: value });
  status.textContent = value ? "Сохранено." : "Ключ очищен.";
  setTimeout(() => (status.textContent = ""), 2500);
});

showTacticsInput.addEventListener("change", async () => {
  await chrome.storage.sync.set({ showTactics: showTacticsInput.checked });
});
