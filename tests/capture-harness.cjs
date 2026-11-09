const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extension = path.resolve(__dirname, "../extension");
function event() {
  const listeners = new Set();
  return {
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    emit(...args) { for (const fn of [...listeners]) fn(...args); }
  };
}
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function createHarness(options = {}) {
  const hostId = options.hostId || 99;
  let transport = options.transport;
  let connectTransport = options.connect;
  let now = 1800000000000;
  let timerId = 0;
  const timers = new Map();
  const clock = {
    setTimeout(fn, ms = 0) { const id = ++timerId; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const until = now + ms;
      await flush();
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = until;
      await flush();
    }
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const nodes = new Map();
  const windowHandlers = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, textContent: "", hidden: false, disabled: false, value: "", dataset: {},
      handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; }
    });
    return nodes.get(id);
  }
  const operations = [];
  const downloads = [];
  const objects = new Map();
  let objectId = 0;
  const bodies = new Map();
  const tab = { id: 7, title: "Synthetic page", url: "https://customer.test/page", windowId: 1 };
  const runtimeMessage = event();
  const debuggerEvent = event();
  const debuggerDetach = event();
  const tabRemoved = event();
  const downloadChanged = event();
  let screenshot = "frame-1";
  let failFull = false;
  let failViewport = false;
  let commandHook;
  let commandId = 0;
  let batchId;
  const storage = {};
  const chrome = {
    runtime: {
      id: "self", onMessage: runtimeMessage,
      getURL: (name) => "chrome-extension://self/" + name,
      sendMessage: async (message) => {
        if (transport) return transport(message);
        if (message.channel === "page-capture-lease") {
          if (message.command === "acquire") await chrome.debugger.attach({ tabId: message.targetTabId });
          else await chrome.debugger.detach({ tabId: message.targetTabId });
          return { ok: true };
        }
        for (const fn of [...runtimeListeners]) {
          let response;
          const returned = fn(message, { id: "self" }, (value) => { response = value; });
          if (returned === true) {
            await flush();
            if (response !== undefined) return response;
          } else if (response !== undefined) return response;
        }
      },
      connect: (settings) => connectTransport ? connectTransport(settings) : { onDisconnect: event() }
    },
    storage: { local: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (values) => Object.assign(storage, values),
      remove: async (key) => { delete storage[key]; }
    } },
    tabs: {
      getCurrent: async () => ({ id: hostId }),
      get: async (id) => { if (id === 7 && !tab.closed) return { ...tab }; throw new Error("tab closed"); },
      query: async () => [{ ...tab }],
      update: async (id, props) => { operations.push({ kind: "tabUpdate", id, props }); },
      remove: async (id) => { operations.push({ kind: "tabRemove", id }); },
      onRemoved: tabRemoved
    },
    windows: { update: async () => {} },
    debugger: {
      onEvent: debuggerEvent, onDetach: debuggerDetach,
      attach: async (target) => { operations.push({ kind: "attach", target }); },
      detach: async (target) => { operations.push({ kind: "detach", target }); debuggerDetach.emit(target, "canceled_by_user"); },
      sendCommand: async (target, method, params) => {
        operations.push({ kind: "command", target: { ...target }, method, params });
        if (commandHook) {
          const result = commandHook(target, method, params);
          if (result !== undefined) return result;
        }
        if (method === "Browser.getVersion") return { product: "Chrome/" + (options.major || 130) + ".0.0.0" };
        if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 800, height: 1800 } };
        if (method === "Page.captureScreenshot") {
          if (params.captureBeyondViewport && failFull) throw new Error("full screenshot failed");
          if (!params.captureBeyondViewport && failViewport) throw new Error("viewport screenshot failed");
          return { data: Buffer.from(screenshot).toString("base64") };
        }
        if (method === "Network.getResponseBody") {
          const key = (target.sessionId || "root") + ":" + params.requestId;
          return { body: bodies.get(key) ?? '{"value":1}', base64Encoded: false };
        }
        return {};
      }
    },
    downloads: {
      onChanged: downloadChanged,
      download: async (settings) => {
        const item = { id: downloads.length + 1, ...settings, blob: objects.get(settings.url), state: "in_progress" };
        downloads.push(item);
        if (options.autoComplete !== false) {
          item.state = "complete";
          downloadChanged.emit({ id: item.id, state: { current: "complete" } });
        }
        return item.id;
      },
      search: async ({ id }) => downloads.filter((item) => item.id === id).map((item) => ({ ...item })),
      cancel: async (id) => { finishDownload(id, "interrupted"); }
    }
  };
  if (options.debugger) chrome.debugger = options.debugger;
  const runtimeListeners = new Set();
  chrome.runtime.onMessage.addListener = (fn) => runtimeListeners.add(fn);
  chrome.runtime.onMessage.removeListener = (fn) => runtimeListeners.delete(fn);
  class FakeURL extends URL {}
  FakeURL.createObjectURL = (blob) => { const url = "blob:synthetic/" + ++objectId; objects.set(url, blob); return url; };
  FakeURL.revokeObjectURL = (url) => objects.delete(url);
  const context = vm.createContext({
    document: { getElementById: node, body: { classList: { add() {}, remove() {} }, dataset: {} } },
    chrome, URL: FakeURL, URLSearchParams, TextEncoder, TextDecoder, Blob, Date: FakeDate,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    navigator: { userAgent: "Chrome/" + (options.major || 130) + ".0" },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    window: { close() {}, addEventListener(name, handler) { windowHandlers.set(name, handler); } }, console
  });
  const source = fs.readFileSync(path.join(options.sourceDirectory || process.env.CAPTURE_TEST_SOURCE_DIRECTORY || extension, "capture.js"), "utf8");
  const bodySource = fs.readFileSync(path.join(options.sourceDirectory || process.env.CAPTURE_TEST_SOURCE_DIRECTORY || extension, "body.js"), "utf8");
  vm.runInContext(bodySource, context, { filename: "body.js" });
  vm.runInContext(source, context, { filename: "capture.js" });
  function emit(method, params = {}, sessionId = "") {
    (options.debuggerEvents || debuggerEvent).emit({ tabId: 7, ...(sessionId ? { sessionId } : {}) }, method, params);
  }
  function request(id, details = {}) {
    emit("Network.requestWillBeSent", {
      requestId: id, timestamp: now / 1000, wallTime: now / 1000, type: details.type || "Fetch",
      documentURL: tab.url,
      request: { method: details.method || "GET", url: details.url || "https://customer.test/api/data", headers: {}, ...details.request },
      initiator: details.initiator || { type: "script", stack: { callFrames: [{ url: "https://customer.test/app.js" }] } },
      ...details.params
    }, details.sessionId);
  }
  async function complete(id, details = {}) {
    emit("Network.responseReceived", {
      requestId: id, type: details.type || "Fetch", timestamp: now / 1000,
      response: { status: details.status || 200, mimeType: "application/json", headers: {}, protocol: "h2", ...details.response }
    }, details.sessionId);
    emit("Network.loadingFinished", { requestId: id, timestamp: now / 1000 + 0.1, encodedDataLength: 30 }, details.sessionId);
    await flush();
  }
  function finishDownload(id, state = "complete") {
    const item = downloads.find((download) => download.id === id);
    item.state = state;
    item.error = state === "interrupted" ? "SYNTHETIC_FAILURE" : undefined;
    downloadChanged.emit({ id, state: { current: state }, error: { current: item.error } });
  }
  async function command(command, args = {}) {
    await flush();
    let response;
    for (const fn of runtimeListeners) fn({ channel: "page-capture-host", hostId, batchId, command, commandId: "cmd-" + ++commandId, ...args }, { id: "self" }, (value) => { response = value; });
    await flush();
    if (!response) throw new Error("Capture host did not answer " + command);
    if (response.view?.batchId) batchId = response.view.batchId;
    return response;
  }
  async function receive(message, sender = { id: "self" }) {
    let response;
    for (const fn of runtimeListeners) fn(message, sender, (value) => { response = value; });
    await flush();
    return response;
  }
  async function files(sequence) {
    const allFolders = [...new Set(downloads.map((item) => item.filename.slice(0, item.filename.lastIndexOf("/"))))];
    const latest = allFolders[allFolders.length - 1] || "";
    const batchRoot = latest.slice(0, latest.lastIndexOf("/"));
    const folders = allFolders.filter((folder) => folder.startsWith(batchRoot + "/"));
    const folder = typeof sequence === "string" ? folders.find((value) => value.endsWith("/" + sequence)) : folders[sequence - 1];
    return Promise.all(downloads.filter((item) => item.filename.startsWith(folder + "/"))
      .map(async (item) => ({ ...item, text: await item.blob.text() })));
  }

  return { context, chrome, nodes, node, operations, downloads, objects, bodies, tab, clock, flush, emit, request, complete, command, receive, files, finishDownload,
    setScreenshot(value) { screenshot = value; },
    failScreenshots(full, viewport = false) { failFull = full; failViewport = viewport; },
    setCommandHook(value) { commandHook = value; },
    setTransport(value) { transport = value; },
    setConnectTransport(value) { connectTransport = value; },
    unload() { windowHandlers.get("pagehide")?.(); runtimeListeners.clear(); },
    interrupt(reason = "canceled_by_user") { (options.debuggerDetach || debuggerDetach).emit({ tabId: 7 }, reason); }
  };
}
module.exports = { createHarness, event, flush, extension };
