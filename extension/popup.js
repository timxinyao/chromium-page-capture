const noteField = document.getElementById("note");
const reloadBox = document.getElementById("reload");
const reloadHint = document.getElementById("reloadHint");
const statusNode = document.getElementById("status");
const startButton = document.getElementById("start");

reloadBox.addEventListener("change", () => {
  reloadHint.textContent = reloadBox.checked
    ? "开始后会重新加载当前页面，以便记录页面加载请求。请勿在正在提交或会改变数据的页面使用。"
    : "关闭后不重载页面，只能记录按下开始之后产生的请求，页面刚打开时的请求可能缺失。";
});

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  statusNode.textContent = "正在准备采集窗口…";
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== "number" || !tab.url || !/^https?:/i.test(tab.url)) {
      throw new Error("请先切换到普通网页标签页，再开始采集。");
    }

    const captureStorage = chrome.storage.session || chrome.storage.local;
    await captureStorage.set({
      pendingCapture: {
        tabId: tab.id,
        note: noteField.value.trim(),
        reload: reloadBox.checked,
        requestedAt: new Date().toISOString()
      }
    });
    await chrome.tabs.create({
      url: chrome.runtime.getURL("capture.html"),
      active: true
    });
    window.close();
  } catch (error) {
    const captureStorage = chrome.storage.session || chrome.storage.local;
    try { await captureStorage.remove("pendingCapture"); } catch (_) {}
    statusNode.textContent = error && error.message ? error.message : String(error);
    startButton.disabled = false;
  }
});
