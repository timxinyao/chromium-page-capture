const HOST_URL = chrome.runtime.getURL("capture.html");
let routing = Promise.resolve();
let openingHost = null;
const leaseStorage = chrome.storage.session || chrome.storage.local;
const LEASE_KEY = "captureConnectionLease";
let connectionQueue = Promise.resolve();
let leaseLoad;
let connectionLease = null;

// Chrome owns debugger connections per extension, not per extension page.
// Only this queue may attach/detach. Storage contains identities and phase, never captured data.
function withConnection(action) {
  const task = connectionQueue.then(action);
  connectionQueue = task.catch(() => {});
  return task;
}

async function readLease() {
  if (!leaseLoad) leaseLoad = leaseStorage.get(LEASE_KEY).then((data) => { connectionLease = data[LEASE_KEY] || null; });
  await leaseLoad;
  return connectionLease;
}

async function storeLease(lease) {
  connectionLease = lease;
  if (lease) await leaseStorage.set({ [LEASE_KEY]: lease });
  else await leaseStorage.remove(LEASE_KEY);
}

function sameLease(a, b) {
  return a && b && a.hostId === b.hostId && a.ownerToken === b.ownerToken &&
    a.batchId === b.batchId && a.targetTabId === b.targetTabId;
}

async function ownerAlive(lease) {
  let timer;
  const probe = (async () => {
    let tab;
    try { tab = await chrome.tabs.get(lease.hostId); } catch (_) { return false; }
    if (tab.url !== HOST_URL) return false;
    try {
      const reply = await chrome.runtime.sendMessage({
        channel: "page-capture-owner-probe", hostId: lease.hostId,
        ownerToken: lease.ownerToken, batchId: lease.batchId
      });
      // An explicit document/batch mismatch proves replacement. Silence is uncertain.
      if (!reply || typeof reply.alive !== "boolean") return null;
      return reply.alive && reply.ownerToken === lease.ownerToken && reply.batchId === lease.batchId;
    } catch (_) { return null; }
  })();
  try {
    return await Promise.race([probe, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3000); })]);
  } finally { clearTimeout(timer); }
}

async function detachLease(expected) {
  if (!sameLease(await readLease(), expected)) return;
  await storeLease({ ...expected, state: "detaching" });
  try { await chrome.debugger.detach({ tabId: expected.targetTabId }); }
  catch (error) {
    // These are Chrome's explicit no-owned-connection / target-gone responses.
    if (!/Debugger is not attached|No (?:tab|target) with given id/i.test(errorText(error))) throw error;
  }
  await storeLease(null);
}

async function acquireLease(message) {
  const identity = {
    hostId: message.hostId, ownerToken: message.ownerToken,
    batchId: message.batchId, targetTabId: message.targetTabId
  };
  if (typeof identity.hostId !== "number" || typeof identity.targetTabId !== "number" ||
      typeof identity.ownerToken !== "string" || !identity.ownerToken || identity.ownerToken.length > 160 ||
      typeof identity.batchId !== "string" || !identity.batchId || identity.batchId.length > 160 ||
      identity.hostId === identity.targetTabId) throw new Error("调试连接租约参数无效。");
  if (await ownerAlive(identity) !== true) throw new Error("记录状态页的身份尚未确认，请重新打开面板查看状态。");
  const previous = await readLease();
  if (sameLease(previous, identity) && previous.state === "attached") return { ok: true };
  if (previous) {
    if (!sameLease(previous, identity) && await ownerAlive(previous) !== false) {
      throw new Error("已有记录状态页持有调试连接，或其状态尚未确认；请等待原批次结束。");
    }
    await detachLease(previous);
  }
  const lease = { ...identity, state: "attaching" };
  await storeLease(lease);
  try {
    await chrome.debugger.attach({ tabId: identity.targetTabId }, "1.3");
    await storeLease({ ...identity, state: "attached" });
    const alive = await ownerAlive(identity);
    if (alive === false) {
      await detachLease(identity);
      throw new Error("记录状态页已经关闭或重载，旧调试连接已释放。");
    }
    // A busy owner may time out after attach. Preserve the lease instead of guessing it died.
    return { ok: true };
  } catch (error) {
    // An attach can finish after its page closes. Cleanup is still owned by this worker queue.
    await detachLease(identity);
    throw error;
  }
}

function cleanupOwner(hostId, ownerToken) {
  return withConnection(async () => {
    const lease = await readLease();
    if (!lease || lease.hostId !== hostId || (ownerToken && lease.ownerToken !== ownerToken)) return;
    if (await ownerAlive(lease) === false) await detachLease(lease);
  });
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

async function findHost() {
  const stored = await chrome.storage.local.get("captureHostId");
  if (typeof stored.captureHostId === "number") {
    try {
      const tab = await chrome.tabs.get(stored.captureHostId);
      if (tab.url === HOST_URL) return { tab, lost: false };
    } catch (_) {}
  }
  // Extension-owned pages can be located without adding the tabs permission.
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((item) => item.url === HOST_URL);
  if (tab) {
    await chrome.storage.local.set({ captureHostId: tab.id });
    return { tab, lost: false };
  }
  return { tab: null, lost: typeof stored.captureHostId === "number" };
}

async function contactHost(tabId, message, waitForReady = false) {
  const deadline = Date.now() + (waitForReady ? 5000 : 0);
  for (;;) {
    try {
      const result = await chrome.runtime.sendMessage({ ...message, channel: "page-capture-host", hostId: tabId });
      if (result && result.view) return result;
    } catch (_) {}
    if (Date.now() >= deadline) throw new Error("记录状态页没有响应，请打开状态页查看；不要关闭仍在保存的状态页。");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function getOrCreateHost() {
  if (openingHost) return openingHost;
  openingHost = (async () => {
    const found = await findHost();
    if (found.tab) return found.tab;
    const tab = await chrome.tabs.create({ url: HOST_URL, active: false });
    await chrome.storage.local.set({ captureHostId: tab.id });
    return tab;
  })();
  try { return await openingHost; }
  finally { openingHost = null; }
}

async function route(message) {
  const found = await findHost();
  if (message.command === "status" && !found.tab) {
    return { ok: true, view: {
      phase: "idle", hostId: null,
      message: found.lost
        ? "记录状态页已关闭或浏览器已重启，未保存缓存无法恢复；已下载文件保留。可重新开始一批。"
        : "开始本批后自动刷新一次，随后持续记录当前业务页面。"
    } };
  }
  let tab = found.tab;
  if (message.command === "start") {
    if (typeof message.tabId !== "number") {
      const candidates = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      message = { ...message, tabId: candidates[0]?.id };
    }
    const original = typeof message.tabId === "number" ? await chrome.tabs.get(message.tabId) : null;
    if (!original || !/^https?:/i.test(original.url || "")) throw new Error("请先切换到普通 HTTP/HTTPS 业务网页，再开始本批。");
    tab = tab || await getOrCreateHost();
  }
  if (!tab) throw new Error("记录状态页已关闭，未保存缓存无法恢复。请重新开始一批。");
  if (!["start", "status", "openHost"].includes(message.command) && message.ownerId !== undefined && message.ownerId !== tab.id) {
    throw new Error("记录状态页已变化，请重新打开面板确认当前批次。");
  }
  if (message.command === "openHost") {
    await chrome.tabs.update(tab.id, { active: true });
    if (chrome.windows && typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true });
    return contactHost(tab.id, { command: "status" }, true);
  }
  return contactHost(tab.id, message, message.command === "start");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.channel === "page-capture-lease") {
    if (sender.url && sender.url.split("#")[0] !== HOST_URL) return;
    const task = withConnection(async () => {
      if (message.command === "acquire") return acquireLease(message);
      if (message.command === "release") { await detachLease(message); return { ok: true }; }
      throw new Error("未知的调试连接命令。");
    });
    task.then(sendResponse, (error) => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  }
  if (message.channel !== "page-capture-router") return;
  const task = routing.then(() => route(message));
  routing = task.catch(() => {});
  task.then(sendResponse, (error) => sendResponse({ ok: false, error: errorText(error) }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.sender.id !== chrome.runtime.id || !port.name.startsWith("page-capture-owner:")) return;
  let owner;
  try { owner = JSON.parse(port.name.slice("page-capture-owner:".length)); } catch (_) { return; }
  if (typeof owner.hostId !== "number" || typeof owner.ownerToken !== "string" || owner.ownerToken.length > 160) return;
  // A queued old onConnect is not proof of a new document. Probe the current lease owner.
  void cleanupOwner(owner.hostId).catch(() => {});
  port.onDisconnect.addListener(() => {
    // Worker suspension and transport loss are not proof the state page has died.
    void cleanupOwner(owner.hostId, owner.ownerToken).catch(() => {});
  });
});
chrome.tabs.onRemoved.addListener((tabId) => { void cleanupOwner(tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.url) void cleanupOwner(tabId).catch(() => {});
});
