const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHarness, extension } = require("./capture-harness.cjs");

async function ready(host) {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (host.operations.some((item) => item.method === "Page.reload")) return;
    await host.flush();
  }
  assert.fail("initial reload was not issued");
}

function routerHarness() {
  const host = createHarness();
  const tabs = new Map([[7, host.tab]]);
  const local = {};
  const messages = [];
  let receiver;
  let createCount = 0;
  let delayReplies = false;
  let batchId;
  const chrome = {
    runtime: {
      id: "self", getURL: (name) => "chrome-extension://self/" + name,
      onMessage: { addListener(fn) { receiver = fn; } },
      onConnect: { addListener() {} },
      async sendMessage(message) {
        messages.push(message);
        if (!tabs.has(message.hostId)) return undefined;
        const result = await host.receive(message);
        return delayReplies ? undefined : result;
      }
    },
    storage: { local: {
      get: async (key) => ({ [key]: local[key] }),
      set: async (value) => Object.assign(local, value),
      remove: async (key) => { delete local[key]; }
    } },
    tabs: {
      get: async (id) => { if (tabs.has(id)) return { ...tabs.get(id) }; throw new Error("tab missing"); },
      query: async (query) => query.active ? [{ ...host.tab }] : [...tabs.values()].map((tab) => ({ ...tab })),
      create: async ({ url }) => {
        createCount++;
        const tab = { id: 99, url, windowId: 1 };
        tabs.set(99, tab);
        return tab;
      },
      update: async () => {}
    },
    debugger: host.chrome.debugger,
    windows: { update: async () => {} }
  };
  chrome.tabs.onRemoved = { addListener() {} };
  chrome.tabs.onUpdated = { addListener() {} };
  function reloadRouter() {
    vm.runInNewContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), {
      chrome, setTimeout: host.clock.setTimeout, clearTimeout: host.clock.clearTimeout, Date: vm.runInContext("Date", host.context)
    });
  }
  reloadRouter();
  host.setTransport((message) => new Promise((resolve) => receiver(message, { id: "self", url: "chrome-extension://self/capture.html" }, resolve)));
  function route(command, args = {}) {
    return new Promise((resolve) => {
      assert.equal(receiver({ channel: "page-capture-router", command, batchId, ...args }, { id: "self" }, (result) => {
        if (result.view?.batchId) batchId = result.view.batchId;
        resolve(result);
      }), true);
    });
  }
  return { host, route, tabs, local, messages, chrome, reloadRouter,
    createCount: () => createCount,
    loseReplies(value) { delayReplies = value; },
    fireWithoutResponse(message) { receiver({ batchId, ...message }, { id: "self" }, () => {}); }
  };
}

test("simultaneous start dispatches share one host and idempotent command, even when replies are lost", async () => {
  const r = routerHarness();
  const results = await Promise.all(Array.from({ length: 8 }, () => r.route("start", { commandId: "same-start", tabId: 7 })));
  assert.equal(results.filter((result) => result.ok).length, 8);
  assert.equal(r.createCount(), 1);
  assert.equal(r.host.operations.filter((operation) => operation.kind === "attach").length, 1);
  assert.equal(r.host.operations.filter((operation) => operation.method === "Page.reload").length, 1);
  r.host.emit("Page.loadEventFired");
  await r.host.clock.advance(2600);
  assert.equal((await r.route("status")).view.phase, "recording");
  r.loseReplies(true);
  r.fireWithoutResponse({ channel: "page-capture-router", command: "save", commandId: "lost-save" });
  await r.host.flush();
  r.loseReplies(false);
  assert.equal(r.host.downloads.length, 4, "host saving must survive the vanished popup response");
  const retry = await r.route("save", { commandId: "lost-save" });
  assert.equal(retry.duplicate, true);
  assert.equal(r.host.downloads.length, 4);
});

test("router restarts rediscover the exact host, and stale ended pages cannot answer its messages", async () => {
  const r = routerHarness();
  await r.route("start", { tabId: 7 });
  await ready(r.host);
  r.host.emit("Page.loadEventFired");
  await r.host.clock.advance(2600);
  r.tabs.set(88, { id: 88, url: "chrome-extension://self/capture.html" });
  r.reloadRouter();
  const result = await r.route("status");
  assert.equal(result.view.hostId, 99);
  assert.ok(r.messages.every((message) => message.hostId === 99));
  const stale = await r.host.receive({ channel: "page-capture-host", hostId: 88, command: "save" });
  assert.equal(stale, undefined);
  const stranger = await r.host.receive({ channel: "page-capture-host", hostId: 99, command: "save" }, { id: "other-extension" });
  assert.equal(stranger, undefined);
});

test("missing host status explains lost cache and does not create or reconnect a new host", async () => {
  const r = routerHarness();
  r.local.captureHostId = 123;
  const result = await r.route("status");
  assert.equal(result.view.phase, "idle");
  assert.match(result.view.message, /未保存缓存无法恢复/);
  assert.equal(r.createCount(), 0);
  assert.equal(r.host.operations.filter((item) => item.kind === "attach").length, 0);
  assert.equal((await r.route("save")).ok, false);
  assert.equal(r.createCount(), 0);
});

test("popup reopen displays an existing batch and its save/end controls without resetting it", async () => {
  const r = routerHarness();
  await r.route("start", { tabId: 7 });
  await ready(r.host);
  r.host.emit("Page.loadEventFired");
  await r.host.clock.advance(2600);
  const nodes = new Map();
  const intervals = new Map();
  const handlers = {};
  let closed = 0;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", value: "", hidden: false, disabled: false,
      addEventListener(event, fn) { handlers[id + ":" + event] = fn; } });
    return nodes.get(id);
  }
  const context = vm.createContext({
    document: { getElementById: node },
    chrome: { runtime: { sendMessage: (message) => r.route(message.command, message) } },
    Date, Math, setInterval(fn) { intervals.set(1, fn); return 1; },
    clearInterval(id) { intervals.delete(id); },
    window: { close() { closed++; }, addEventListener(name, fn) { handlers["window:" + name] = fn; } }
  });
  vm.runInContext(fs.readFileSync(path.join(extension, "popup.js"), "utf8"), context);
  await r.route("status");
  await r.host.flush();
  assert.equal(node("phase").textContent, "记录中");
  assert.equal(node("save").hidden, false);
  assert.equal(node("start").hidden, true);
  node("note").value = "小面板补充备注";
  await handlers["save:click"]();
  assert.equal(JSON.parse((await r.host.files(2)).find((item) => item.filename.endsWith(".json")).text).capture.note, "小面板补充备注");
  handlers["window:unload"]();
  assert.equal(intervals.size, 0);
  r.host.request("after-popup-closed");
  await r.host.complete("after-popup-closed");
  assert.equal((await r.route("status")).view.unsavedCount, 1);
  assert.equal(closed, 0);
  assert.equal(r.createCount(), 1);
});
