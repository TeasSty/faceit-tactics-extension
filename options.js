const input = document.getElementById("apiKey");
const status = document.getElementById("status");

chrome.storage.sync.get("faceitApiKey").then(({ faceitApiKey }) => {
  if (faceitApiKey) input.value = faceitApiKey;
});

document.getElementById("save").addEventListener("click", async () => {
  const value = input.value.trim();
  await chrome.storage.sync.set({ faceitApiKey: value });
  status.textContent = value ? "Сохранено." : "Ключ очищен.";
  setTimeout(() => (status.textContent = ""), 2500);
});
