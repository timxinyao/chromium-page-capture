const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHarness, event, extension } = require("./capture-harness.cjs");
const sourceDirectory = process.env.CAPTURE_TEST_SOURCE_DIRECTORY || extension;

// Each state page has an independent VM. Chrome's debugger ownership outlives all of them.
function leaseHarness() {
  const clockHost = createHarness();
  const hosts = new Map();
  const tabs = new Map([[7, { id: 7, url: "https://customer.test/page", title: "Synthetic page" }]]);
  const local = {};
  const sessionStorage = {};
  const owned = new Set();
  const operations = [];
  const messages = [];
  const debuggerEvent = event();
  const debuggerDetach = event();
  const removed = event();
  const updated = event();
  let receivers = new Set();
  let connects = new Set();
  let attachRelease;
  let detachRelease;
  let holdAttach = false;
  let holdDetach = false;
  let failDetach = false;
  let lostLeaseReply = false;
  let stallProbe = false;
  const debuggerApi = {
    onEvent: debuggerEvent, onDetach: debuggerDetach,
    async attach(target) {
      operations.push({ kind: "attach", target });
      if (owned.has(target.tabId)) throw new Error("Another debugger is already attached to the tab with id: " + target.tabId);
      if (holdAttach) await new Promise((resolve) => { attachRelease = resolve; });
      owned.add(target.tabId);
    },
    async detach(target) {
      operations.push({ kind: "detach", target });
      if (failDetach) throw new Error("cleanup blocked");
      if (holdDetach) await new Promise((resolve) => { detachRelease = resolve; });
      if (!owned.has(target.tabId)) throw new Error("Debugger is not attached to the tab with id: " + target.tabId);
      owned.delete(target.tabId);
      debuggerDetach.emit(target, "canceled_by_user");
    },
    async sendCommand(target, method, params) {
      operations.push({ kind: "command", target, method, params });
      if (!owned.has(target.tabId)) throw new Error("Debugger is not attached");
      if (method === "Browser.getVersion") return { product: "Chrome/130.0.0.0" };
      if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 800, height: 1200 } };
      if (method === "Page.captureScreenshot") return { data: "AA==" };
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ url: "https://customer.test/page", title: "Synthetic page" }] };
      if (method === "Network.getResponseBody") return { body: '{"value":1}', base64Encoded: false };
      return {};
    }
  };
  function storage(data) {
    return {
      get: async (key) => ({ [key]: data[key] ? JSON.parse(JSON.stringify(data[key])) : undefined }),
      set: async (values) => { for (const [key, value] of Object.entries(values)) data[key] = JSON.parse(JSON.stringify(value)); },
      remove: async (key) => { delete data[key]; }
    };
  }
  const chrome = {
    runtime: {
      id: "self", getURL: (name) => "chrome-extension://self/" + name,
      onMessage: { addListener(fn) { receivers.add(fn); } },
      onConnect: { addListener(fn) { connects.add(fn); } },
      async sendMessage(message) {
        if (stallProbe && message.channel === "page-capture-owner-probe") return new Promise(() => {});
        const owner = hosts.get(message.hostId);
        return owner ? owner.h.receive(message) : undefined;
      }
    },
    storage: { session: storage(sessionStorage), local: storage(local) },
    debugger: debuggerApi,
    tabs: {
      onRemoved: removed, onUpdated: updated,
      get: async (id) => { if (tabs.has(id)) return { ...tabs.get(id) }; throw new Error("tab missing"); },
      query: async (query) => query.active ? [{ ...tabs.get(7) }] : [...tabs.values()].map((tab) => ({ ...tab })),
      create: async () => { throw new Error("test creates independent host VMs explicitly"); },
      update: async () => {}
    },
    windows: { update: async () => {} }
  };
  function loadWorker() {
    receivers = new Set();
    connects = new Set();
    // Old worker event callbacks disappear on suspension.
    removedListeners.splice(0).forEach((fn) => removed.removeListener(fn));
    updatedListeners.splice(0).forEach((fn) => updated.removeListener(fn));
    vm.runInNewContext(fs.readFileSync(path.join(sourceDirectory, "background.js"), "utf8"), {
      chrome, setTimeout: clockHost.clock.setTimeout, clearTimeout: clockHost.clock.clearTimeout,
      Date: vm.runInContext("Date", clockHost.context)
    });
  }
  const removedListeners = [];
  const updatedListeners = [];
  const addRemoved = removed.addListener;
  const addUpdated = updated.addListener;
  removed.addListener = (fn) => { removedListeners.push(fn); addRemoved(fn); };
  updated.addListener = (fn) => { updatedListeners.push(fn); addUpdated(fn); };
  function dispatch(message, sender = { id: "self" }) {
    messages.push({ ...message });
    return new Promise((resolve) => {
      for (const receiver of receivers) {
        const pending = receiver(message, sender, (response) => {
          if (lostLeaseReply && message.channel === "page-capture-lease") {
            lostLeaseReply = false;
            resolve(undefined);
          } else resolve(response);
        });
        if (pending === true) return;
      }
      resolve(undefined);
    });
  }
  function addHost(id = 99) {
    const owner = { id, h: null, ports: [], subscriptions: [] };
    tabs.set(id, { id, url: "chrome-extension://self/capture.html", windowId: 1 });
    const sender = { id: "self", url: "chrome-extension://self/capture.html", tab: { id } };
    const api = { ...debuggerApi };
    for (const [name, source] of [["onEvent", debuggerEvent], ["onDetach", debuggerDetach]]) {
      api[name] = {
        addListener(fn) { source.addListener(fn); owner.subscriptions.push(() => source.removeListener(fn)); },
        removeListener(fn) { source.removeListener(fn); }
      };
    }
    owner.h = createHarness({
      hostId: id, debugger: api, debuggerEvents: debuggerEvent, debuggerDetach,
      transport: (message) => dispatch(message, sender),
      connect(settings) {
        const client = { onDisconnect: event() };
        const server = { name: settings.name, sender, onDisconnect: event() };
        owner.ports.push({ client, server });
        for (const connect of connects) connect(server);
        return client;
      }
    });
    hosts.set(id, owner);
    local.captureHostId = id;
    return owner;
  }
  function removeHost(owner, mode = "close") {
    hosts.delete(owner.id);
    owner.h.unload();
    owner.subscriptions.forEach((unsubscribe) => unsubscribe());
    if (mode === "close") tabs.delete(owner.id);
    if (mode === "navigate") tabs.set(owner.id, { id: owner.id, url: "https://other.test/" });
    for (const { client, server } of owner.ports) { server.onDisconnect.emit(); client.onDisconnect.emit(); }
    if (mode === "close") removed.emit(owner.id);
    else updated.emit(owner.id, { status: "loading", ...(mode === "navigate" ? { url: "https://other.test/" } : {}) });
  }
  async function flush() { for (let i = 0; i < 8; i++) await clockHost.flush(); }
  async function start(owner) {
    const reply = await dispatch({ channel: "page-capture-router", command: "start", tabId: 7, commandId: "start-" + Math.random() });
    assert.equal(reply.ok, true);
    await flush();
    return reply;
  }
  loadWorker();
  return { addHost, removeHost, dispatch, start, flush, clock: clockHost.clock, operations, messages, owned, sessionStorage,
    holdAttach(value) { holdAttach = value; }, releaseAttach() { attachRelease(); },
    holdDetach(value) { holdDetach = value; }, releaseDetach() { detachRelease(); },
    failDetach(value) { failDetach = value; },
    loseNextLeaseReply() { lostLeaseReply = true; },
    stallProbe(value) { stallProbe = value; },
    async suspendWorker() {
      loadWorker();
      for (const owner of hosts.values()) for (const { client } of owner.ports.splice(0)) client.onDisconnect.emit();
      for (const owner of hosts.values()) await owner.h.clock.advance(100);
      await flush();
    },
    disconnectControl(owner) {
      const port = owner.ports[owner.ports.length - 1];
      port.server.onDisconnect.emit(); port.client.onDisconnect.emit();
    },
    replayConnect(owner) {
      for (const connect of connects) connect(owner.ports[0].server);
    }
  };
}

test("closing the recording host releases the extension-owned connection before another host starts", async () => {
  const r = leaseHarness();
  const first = r.addHost();
  await r.start(first);
  assert.equal(r.owned.has(7), true);
  r.removeHost(first);
  assert.equal(r.owned.has(7), true, "destroying the page itself must not clear mock Chrome ownership");
  const second = r.addHost(100);
  await r.start(second);
  assert.equal(r.owned.has(7), true);
  assert.equal(r.operations.filter((item) => item.kind === "attach").length, 2);
  assert.equal(r.operations.filter((item) => item.kind === "detach").length, 1);
  assert.equal((await second.h.command("status")).view.phase, "initial");
  const lease = r.sessionStorage.captureConnectionLease;
  assert.deepEqual(Object.keys(lease).sort(), ["batchId", "hostId", "ownerToken", "state", "targetTabId"]);
});

test("host reload replaces its document token, and stale release or disconnect cannot detach the new batch", async () => {
  const r = leaseHarness();
  const first = r.addHost();
  await r.start(first);
  const stale = r.messages.find((message) => message.channel === "page-capture-lease" && message.command === "acquire");
  r.removeHost(first, "reload");
  const second = r.addHost();
  await r.start(second);
  const before = r.operations.filter((item) => item.kind === "detach").length;
  await r.dispatch({ ...stale, command: "release" });
  r.replayConnect(first);
  const staleAcquire = await r.dispatch(stale);
  assert.equal(staleAcquire.ok, false);
  r.disconnectControl(first);
  await r.flush();
  assert.equal(r.operations.filter((item) => item.kind === "detach").length, before);
  assert.equal(r.owned.has(7), true);
  assert.equal((await second.h.command("status")).view.phase, "initial");
});

test("a host closed during pending attach is drained before a waiting new owner can acquire", async () => {
  const r = leaseHarness();
  const first = r.addHost();
  r.holdAttach(true);
  await r.start(first);
  r.removeHost(first);
  const second = r.addHost(100);
  await r.start(second);
  second.h.request("old-root-event");
  second.h.emit("Target.attachedToTarget", { sessionId: "old-child", targetInfo: { type: "iframe" } });
  assert.equal((await second.h.command("status")).view.unsavedCount, 0);
  assert.equal(r.operations.filter((item) => item.kind === "attach").length, 1);
  r.holdAttach(false);
  r.releaseAttach();
  await r.flush();
  assert.equal(r.operations.filter((item) => item.kind === "attach").length, 2);
  assert.equal(r.operations.filter((item) => item.kind === "detach").length, 1);
  const ordered = r.operations.filter((item) => ["attach", "detach"].includes(item.kind)).map((item) => item.kind);
  assert.deepEqual(ordered, ["attach", "detach", "attach"]);
  assert.equal((await second.h.command("status")).view.phase, "initial");
});

test("new ownership waits for a delayed old detach and a replayed acquire does not attach twice", async () => {
  const r = leaseHarness();
  const first = r.addHost();
  await r.start(first);
  r.holdDetach(true);
  r.removeHost(first, "navigate");
  const second = r.addHost(100);
  await r.start(second);
  assert.equal(r.operations.filter((item) => item.kind === "attach").length, 1);
  r.holdDetach(false);
  r.releaseDetach();
  await r.flush();
  const acquire = r.messages.filter((message) => message.channel === "page-capture-lease" && message.command === "acquire").at(-1);
  await r.dispatch(acquire);
  assert.equal(r.operations.filter((item) => item.kind === "attach").length, 2);
  assert.equal(r.operations.filter((item) => item.kind === "detach").length, 1);
});

test("worker suspension and control reconnection preserve a live host and its active recording", async () => {
  const r = leaseHarness();
  const owner = r.addHost();
  await r.start(owner);
  owner.h.emit("Page.loadEventFired");
  await owner.h.clock.advance(2600);
  assert.equal((await owner.h.command("status")).view.phase, "recording");
  await r.suspendWorker();
  owner.h.request("after-worker-suspend");
  await owner.h.complete("after-worker-suspend");
  await owner.h.command("save");
  const file = (await owner.h.files(2)).find((item) => item.filename.endsWith("/page.json"));
  assert.equal(JSON.parse(file.text).entries.length, 1);
  assert.equal(r.operations.filter((item) => item.kind === "attach").length, 1);
  assert.equal(r.operations.filter((item) => item.kind === "detach").length, 0);
  await owner.h.command("end");
  await r.flush();
  assert.equal(r.owned.size, 0);
});

test("an uncertain owner probe cannot turn control-channel loss into a destructive cleanup", async () => {
  const r = leaseHarness();
  const owner = r.addHost();
  await r.start(owner);
  r.stallProbe(true);
  r.disconnectControl(owner);
  await r.clock.advance(3000);
  assert.equal(r.owned.has(7), true);
  assert.equal(r.operations.filter((item) => item.kind === "detach").length, 0);
  r.stallProbe(false);
  await r.flush();
});

test("a lost lease acknowledgement can be retried without a second attachment", async () => {
  const r = leaseHarness();
  const owner = r.addHost();
  r.loseNextLeaseReply();
  await r.start(owner);
  assert.equal(r.operations.filter((item) => item.kind === "attach").length, 1);
  assert.equal(r.operations.filter((item) => item.kind === "detach").length, 0);
  assert.equal((await owner.h.command("status")).view.phase, "initial");
});

test("failed orphan cleanup preserves ownership and blocks a new attach until an explicit later start can clean it", async () => {
  const r = leaseHarness();
  const first = r.addHost();
  await r.start(first);
  r.failDetach(true);
  r.removeHost(first);
  const second = r.addHost(100);
  await r.start(second);
  assert.equal((await second.h.command("status")).view.phase, "interrupted");
  assert.match((await second.h.command("status")).view.warning, /cleanup blocked/);
  assert.equal(r.operations.filter((item) => item.kind === "attach").length, 1);
  assert.equal(r.owned.has(7), true);
  r.failDetach(false);
  await second.h.command("recover");
  await r.flush();
  await r.start(second);
  assert.equal((await second.h.command("status")).view.phase, "initial");
  assert.equal(r.operations.filter((item) => item.kind === "attach").length, 2);
});
