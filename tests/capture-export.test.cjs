const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../extension");
const expectedVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")).version;
const source = fs.readFileSync(path.join(root, "capture.js"), "utf8");
let bodyCommandCount = 0;
let commandImplementation = async () => ({ body: "{}", base64Encoded: false });
let closeHandler;
let closeWindowCount = 0;
let originalTabMissing = false;
let tabRemovalFails = false;
const tabOperations = [];
const captureNodes = {
  title: { textContent: "" },
  status: { textContent: "" },
  details: { textContent: "" },
  closeCapture: {
    hidden: true, disabled: false,
    addEventListener(name, fn) { closeHandler = fn; }
  }
};
const context = vm.createContext({
  document: {
    getElementById: (id) => captureNodes[id],
    body: { classList: { add() {}, remove() {} } }
  },
  chrome: {
    storage: { session: { get: () => new Promise(() => {}), remove: async () => {} } },
    debugger: {
      detach: async () => {},
      onEvent: { addListener() {}, removeListener() {} },
      sendCommand: async (...args) => {
        bodyCommandCount++;
        return commandImplementation(...args);
      }
    },
    tabs: {
      getCurrent: async () => { tabOperations.push("current"); return { id: 99 }; },
      get: async (id) => {
        tabOperations.push("get:" + id);
        if (originalTabMissing) throw new Error("tab closed");
        return { id, windowId: 3 };
      },
      update: async (id, options) => {
        assert.equal(options.active, true);
        tabOperations.push("activate:" + id);
      },
      remove: async (id) => {
        tabOperations.push("remove:" + id);
        if (tabRemovalFails) throw new Error("remove failed");
      }
    },
    windows: {
      update: async (id, options) => {
        assert.equal(options.focused, true);
        tabOperations.push("focus:" + id);
      }
    }
  },
  URL, URLSearchParams, TextEncoder, Blob,
  atob: (value) => Buffer.from(value, "base64").toString("binary"),
  setTimeout: () => 1,
  clearTimeout() {},
  window: { close() { closeWindowCount++; } }
});
vm.runInContext(source + "\nglobalThis.captureChecks = { isCaptureRequestType, isExtensionUrl, isExtensionRequest, onDebuggerEvent, createEntry, completeRequest, makePageExport, setStatus, closeCaptureAndReturn, setSession(value) { session = value; }, async finishOffline(value) { const files = []; const previousScreenshot = captureScreenshot; const previousDownload = downloadBlob; captureScreenshot = async () => ({ data: 'AA==' }); downloadBlob = async (blob, filename) => { files.push({ filename, content: await blob.text() }); return files.length; }; try { await finishCapture(value, false); return files; } finally { captureScreenshot = previousScreenshot; downloadBlob = previousDownload; } } };", context);
const api = context.captureChecks;

function makeSession() {
  return {
    tabId: 7, target: { tabId: 7 }, pending: new Map(), inflight: new Map(),
    requestParents: new Map(), excludedExtensionRequestIds: new Set(),
    entries: [], totalBodyBytes: 0, exportedRequestCount: 0,
    loadSeen: false, finishing: false, finished: false,
    pageUrl: "https://customer.test/page", note: "", startedAt: new Date(1000).toISOString()
  };
}

function request(requestId, overrides = {}) {
  return {
    requestId, timestamp: 1, wallTime: 1, type: "Fetch",
    documentURL: "https://customer.test/page",
    request: { method: "GET", url: "https://customer.test/api/data", headers: {} },
    initiator: { type: "script", stack: { callFrames: [{ url: "https://customer.test/app.js" }] } },
    ...overrides
  };
}

async function main() {
  for (const url of [
    "chrome-extension://abc/a.js", "edge-extension://abc/a.js",
    "moz-extension://abc/a.js", "blob:chrome-extension://abc/object"
  ]) assert.equal(api.isExtensionUrl(url), true, url);
  assert.equal(api.isExtensionUrl("https://customer.test/?name=chrome-extension"), false);

  assert.equal(api.isExtensionRequest(request("normal")), false);
  assert.equal(api.isExtensionRequest(request("document", {
    documentURL: "chrome-extension://abc/capture.html"
  })), true);
  assert.equal(api.isExtensionRequest(request("module", {
    initiator: { type: "script", url: "chrome-extension://abc/module.js" }
  })), true);
  assert.equal(api.isExtensionRequest(request("stack", {
    initiator: { type: "script", stack: { callFrames: [{ url: "chrome-extension://abc/content.js" }] } }
  })), true);
  assert.equal(api.isExtensionRequest(request("async", {
    initiator: { type: "script", stack: {
      callFrames: [], parent: { callFrames: [{ url: "chrome-extension://abc/content.js" }] }
    } }
  })), true);
  assert.equal(api.isExtensionRequest(request("page-with-wrapper", {
    initiator: { type: "script", stack: { callFrames: [
      { url: "https://customer.test/app.js" }, { url: "chrome-extension://abc/wrapper.js" }
    ] } }
  })), false, "A page-attributed API must not be removed because a lower stack frame is an extension.");

  let state = makeSession();
  api.setSession(state);
  api.onDebuggerEvent({ tabId: 7 }, "Network.requestWillBeSent", request("extension", {
    request: { method: "GET", url: "chrome-extension://abc/content.js", headers: {} }
  }));
  assert.equal(state.pending.size, 0);
  assert.equal(state.excludedExtensionRequestIds.has("extension"), true);
  for (const method of ["Network.responseReceived", "Network.dataReceived", "Network.loadingFinished", "Network.loadingFailed"]) {
    api.onDebuggerEvent({ tabId: 7 }, method, { requestId: "extension" });
  }
  assert.equal(bodyCommandCount, 0, "Excluded responses must not retrieve bodies.");
  api.onDebuggerEvent({ tabId: 8 }, "Network.requestWillBeSent", request("other-tab"));
  assert.equal(state.pending.size, 0);
  api.onDebuggerEvent({ tabId: 7 }, "Network.requestWillBeSent", request("business"));
  assert.equal(state.pending.has("business"), true);

  state = makeSession();
  api.setSession(state);
  api.onDebuggerEvent({ tabId: 7 }, "Network.requestWillBeSent", request("preflight", {
    initiator: { type: "preflight", requestId: "extension-fetch" }
  }));
  assert.equal(state.pending.size, 1);
  api.onDebuggerEvent({ tabId: 7 }, "Network.requestWillBeSent", request("extension-fetch", {
    initiator: { type: "script", stack: { callFrames: [{ url: "chrome-extension://abc/content.js" }] } }
  }));
  assert.equal(state.pending.size, 0, "An earlier preflight must be removed when its extension parent is identified.");
  assert.equal(state.excludedExtensionRequestIds.has("preflight"), true);

  state = makeSession();
  api.setSession(state);
  const kept = api.createEntry(request("kept"));
  const completedPreflight = api.createEntry(request("completed-preflight"));
  state.entries.push(kept, completedPreflight);
  state.requestParents.set("completed-preflight", "late-extension-parent");
  state.excludedExtensionRequestIds.add("late-extension-parent");
  const output = api.makePageExport(state, { pageTitle: "Page" });
  assert.equal(output.records.length, 1);
  assert.equal(output.records[0].request.url, "https://customer.test/api/data");
  assert.equal(Object.hasOwn(output.records[0], "_requestId"), false);
  assert.equal(state.exportedRequestCount, 1);
  assert.match(output.noteText, /排除扩展请求数: 2/);

  state = makeSession();
  const pendingBody = api.createEntry(request("body-child"));
  pendingBody.response.content.mimeType = "application/json";
  state.pending.set("body-child", pendingBody);
  state.requestParents.set("body-child", "body-parent");
  let releaseBody;
  commandImplementation = () => new Promise((resolve) => { releaseBody = resolve; });
  const completing = api.completeRequest(state, "body-child", 1.1, 10);
  state.excludedExtensionRequestIds.add("body-parent");
  releaseBody({ body: '{"value":1}', base64Encoded: false });
  await completing;
  assert.equal(state.entries.length, 0);
  assert.equal(state.totalBodyBytes, 0);

  commandImplementation = async () => ({ body: '{"value":1}', base64Encoded: false });
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  state = makeSession();
  for (const type of ["Fetch", "XHR"]) {
    assert.equal(api.isCaptureRequestType(type), true);
    for (const method of methods) {
      state.entries.push(api.createEntry(request(type + "-" + method, {
        type, request: { method, url: "https://customer.test/api/data", headers: {} }
      })));
    }
  }
  for (const type of ["Document", "Script", "Stylesheet", "Image", "Font", "Media",
    "Manifest", "Preflight", "WebSocket", "EventSource", "Ping", "Other", ""]) {
    assert.equal(api.isCaptureRequestType(type), false);
    state.entries.push(api.createEntry(request("skip-" + type, { type })));
  }
  const filtered = api.makePageExport(state, { pageTitle: "Only API" });
  assert.equal(filtered.records.length, methods.length * 2);
  assert.match(filtered.noteText, /采集范围: Fetch \/ XHR/);
  for (const method of methods) {
    assert.equal(filtered.records.filter((entry) => entry.request.method === method).length, 2);
  }
  assert.equal(filtered.records.some((entry) => Object.hasOwn(entry, "_requestType")), false);

  state = makeSession();
  api.setSession(state);
  api.onDebuggerEvent({ tabId: 7 }, "Network.requestWillBeSent", request("reclassified", { type: "Other" }));
  api.onDebuggerEvent({ tabId: 7 }, "Network.responseReceived", {
    requestId: "reclassified", type: "XHR",
    response: { status: 200, mimeType: "application/json", headers: {}, protocol: "h2" }
  });
  api.onDebuggerEvent({ tabId: 7 }, "Network.loadingFinished", {
    requestId: "reclassified", timestamp: 1.1, encodedDataLength: 30
  });
  await Promise.all(Array.from(state.inflight.values()));
  const reclassified = api.makePageExport(state, { pageTitle: "XHR" });
  assert.equal(reclassified.records.length, 1);
  assert.match(reclassified.noteText, /请求类别: XHR/);
  assert.equal(reclassified.records[0].response.content.text, '{"value":1}');

  state = makeSession();
  const script = api.createEntry(request("non-api-json", { type: "Script" }));
  script.response.content.mimeType = "application/json";
  state.pending.set("non-api-json", script);
  const commandsBeforeScript = bodyCommandCount;
  await api.completeRequest(state, "non-api-json", 1.1, 10);
  assert.equal(bodyCommandCount, commandsBeforeScript, "Non-Fetch/XHR bodies must not be read.");
  assert.equal(api.makePageExport(state, { pageTitle: "Script" }).records.length, 0);

  state = makeSession();
  api.setSession(state);
  api.onDebuggerEvent({ tabId: 7 }, "Network.requestWillBeSent", request("redirect", { type: "Other" }));
  api.onDebuggerEvent({ tabId: 7 }, "Network.requestWillBeSent", request("redirect", {
    type: "Fetch", timestamp: 1.05,
    redirectResponse: { status: 302, mimeType: "text/html", headers: {}, protocol: "http/1.1" }
  }));
  api.onDebuggerEvent({ tabId: 7 }, "Network.responseReceived", {
    requestId: "redirect", type: "Fetch",
    response: { status: 200, mimeType: "application/json", headers: {}, protocol: "h2" }
  });
  api.onDebuggerEvent({ tabId: 7 }, "Network.loadingFinished", {
    requestId: "redirect", timestamp: 1.1, encodedDataLength: 30
  });
  await Promise.all(Array.from(state.inflight.values()));
  assert.equal(api.makePageExport(state, { pageTitle: "Redirect" }).records.length, 2);

  state = makeSession();
  state.pageUrl = "https://customer.test/page?access_token=private";
  state.note = "保留我的备注";
  state.incomplete = true;
  state.incompleteReason = "接口超时";
  state.excludedExtensionRequestIds.add("ignored-request");
  const businessRecord = api.createEntry(request("business-payload"));
  businessRecord.request._postDataOmittedReason = "multipart/form-data body omitted for privacy";
  businessRecord.response.status = 200;
  businessRecord.response.content.text = '{"_capture":{"business":true},"value":7}';
  businessRecord._bodyOmitted = "total text body limit reached";
  businessRecord._totalEncodedTransferSize = 1234;
  businessRecord.time = 125;
  state.entries.push(businessRecord);
  const clean = api.makePageExport(state, {
    pageTitle: "业务页面",
    finalUrl: "https://customer.test/final",
    hasScreenshot: false,
    screenshotError: "截图受限"
  });
  assert.deepEqual(Array.from(Object.keys(clean.records[0])).sort(), ["request", "response"]);
  for (const key of ["_capture", "log", "creator", "pages", "_requestId", "_resourceType", "_transferSize", "timings", "time", "startedDateTime"]) {
    assert.equal(Object.hasOwn(clean.records[0], key), false, key);
  }
  assert.equal(Object.hasOwn(clean.records[0].request, "_postDataOmittedReason"), false);
  assert.equal(clean.records[0].response.content.text, '{"_capture":{"business":true},"value":7}');
  for (const expected of [
    "扩展版本: " + expectedVersion, "页面标题: 业务页面", "最终页面地址: https://customer.test/final",
    "采集时间: " + state.startedAt, "保留我的备注", "HTTP 方法: 不限", "导出接口数: 1",
    "排除扩展请求数: 1", "网络记录状态: 不完整", "不完整原因: 接口超时",
    "截图: 截图失败", "截图错误: 截图受限", "总耗时(ms): 125",
    "总传输量(字节，可能含响应头): 1234", "请求正文说明: multipart 表单正文已省略",
    "响应正文说明: 响应正文累计大小超过保存上限"
  ]) assert.equal(clean.noteText.includes(expected), true, expected);
  assert.equal(clean.noteText.includes("access_token=private"), false);
  assert.match(clean.noteText, /\r\n\r\n用户备注:\r\n保留我的备注/);
  assert.equal(businessRecord._requestId, "business-payload", "Export must not mutate source entries.");
  const repeated = api.makePageExport(state, {
    pageTitle: "业务页面", finalUrl: "https://customer.test/final",
    hasScreenshot: false, screenshotError: "截图受限"
  });
  assert.equal(JSON.stringify(repeated.records), JSON.stringify(clean.records));
  assert.equal(repeated.noteText, clean.noteText);
  const empty = api.makePageExport(makeSession(), { pageTitle: "Empty" });
  assert.equal(empty.records.length, 0);
  assert.match(empty.noteText, /导出接口数: 0/);

  state = makeSession();
  state.loadSeen = true;
  state.entries.push(api.createEntry(request("download-wiring")));
  state.note = "文件对应检查";
  api.setSession(state);
  const files = await api.finishOffline(state);
  assert.equal(files.length, 3);
  const pageFile = files.find((file) => file.filename.endsWith("/page.json"));
  const noteFile = files.find((file) => file.filename.endsWith("/note.txt"));
  const screenshotFile = files.find((file) => file.filename.endsWith("/screenshot-full.png"));
  assert.ok(pageFile && noteFile && screenshotFile);
  const pageData = JSON.parse(pageFile.content);
  assert.equal(Array.isArray(pageData), true);
  assert.deepEqual(Object.keys(pageData[0]).sort(), ["request", "response"]);
  assert.equal(Object.hasOwn(pageData, "_capture"), false);
  assert.match(noteFile.content, /文件对应检查/);
  assert.match(noteFile.content, /采集范围: Fetch \/ XHR/);

  tabOperations.length = 0;
  api.setSession(makeSession());
  api.setStatus("正在采集", "等待", undefined);
  assert.equal(captureNodes.closeCapture.hidden, true);
  await closeHandler();
  assert.equal(tabOperations.length, 0, "The close action must not run during capture.");
  api.setStatus("完成", "已保存", "done");
  assert.equal(captureNodes.closeCapture.hidden, false);
  await closeHandler();
  assert.deepEqual(tabOperations, ["current", "get:7", "activate:7", "focus:3", "remove:99"]);
  assert.equal(closeWindowCount, 0);

  tabOperations.length = 0;
  captureNodes.closeCapture.disabled = false;
  originalTabMissing = true;
  await closeHandler();
  assert.deepEqual(tabOperations, ["current", "get:7", "remove:99"]);
  originalTabMissing = false;

  tabOperations.length = 0;
  captureNodes.closeCapture.disabled = false;
  tabRemovalFails = true;
  await closeHandler();
  assert.equal(captureNodes.closeCapture.disabled, false);
  assert.match(captureNodes.status.textContent, /无法关闭采集页面/);
  tabRemovalFails = false;

  tabOperations.length = 0;
  api.setSession(null);
  api.setStatus("无待采集页面", "结束", "error");
  await closeHandler();
  assert.deepEqual(tabOperations, ["current", "remove:99"]);

  let clickHandler;
  let savedDraft;
  let createdTab = 0;
  let closedPopup = 0;
  const popupNodes = {
    note: { value: "测试备注" },
    reload: { checked: true, addEventListener() {} },
    reloadHint: { textContent: "" },
    status: { textContent: "" },
    start: { disabled: false, addEventListener(name, fn) { clickHandler = fn; } }
  };
  const popupContext = vm.createContext({
    document: { getElementById: (id) => popupNodes[id] },
    chrome: {
      tabs: {
        query: async () => [{ id: 7, url: "https://customer.test/page" }],
        create: async () => { createdTab++; }
      },
      storage: { session: {
        set: async (data) => { savedDraft = data.pendingCapture; },
        remove: async () => {}
      } },
      runtime: { getURL: (value) => "chrome-extension://self/" + value }
    },
    window: {
      confirm() { throw new Error("The removed confirmation must not be called."); },
      close() { closedPopup++; }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "popup.js"), "utf8"), popupContext);
  await clickHandler();
  assert.equal(savedDraft.reload, true);
  assert.equal(savedDraft.note, "测试备注");
  assert.equal(createdTab, 1);
  assert.equal(closedPopup, 1);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.version, expectedVersion);
  const captureVersion = source.match(/CAPTURE_VERSION = "([^"]+)"/);
  assert.ok(captureVersion, "Capture version must be declared.");
  assert.equal(captureVersion[1], expectedVersion);
  console.log("PASS: metadata separated into notes, clean request/response arrays, omission diagnostics preserved, business fields retained, download file wiring, Fetch/XHR/extension filters, close/return flows, version consistency.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
