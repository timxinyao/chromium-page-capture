const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHarness, extension } = require("./capture-harness.cjs");

async function begin(h) {
  await h.command("start", { tabId: 7 });
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
}
async function output(h, sequence = 2) {
  const files = await h.files(sequence);
  return {
    rows: JSON.parse(files.find((file) => file.filename.endsWith("/page.json")).text).entries,
    capture: JSON.parse(files.find((file) => file.filename.endsWith("/page.json")).text).capture
  };
}

test("export keeps only Fetch/XHR methods and separates diagnostics from the business data", async () => {
  const h = createHarness();
  await begin(h);
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  for (const type of ["Fetch", "XHR"]) for (const method of methods) {
    const id = type + method;
    h.request(id, { type, method });
    await h.complete(id, { type });
  }
  for (const type of ["Document", "Script", "Stylesheet", "Image", "Font", "Media", "Manifest", "Preflight", "WebSocket", "EventSource", "Ping", "Other"]) {
    h.request(type, { type });
    await h.complete(type, { type });
  }
  h.request("reclassified", { type: "Other" });
  await h.complete("reclassified", { type: "XHR" });
  await h.command("save", { note: "文件对应检查" });
  const { rows, capture } = await output(h);
  assert.equal(rows.length, 15);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["request", "response"]);
  for (const method of methods) assert.ok(rows.some((row) => row.request.method === method));
  assert.equal(capture.note, "文件对应检查");
  assert.deepEqual(capture.warnings, []);
  assert.equal(h.operations.filter((operation) => operation.method === "Network.getResponseBody").length, 15);
});

test("extension attribution and associated preflights are scoped to their child session", async () => {
  const h = createHarness();
  await begin(h);
  h.emit("Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe" }, waitingForDebugger: true });
  await h.flush();
  h.request("preflight", { type: "Other", initiator: { type: "preflight", requestId: "extension" } });
  h.request("extension", { initiator: { url: "chrome-extension://abc/content.js" } });
  h.request("extension", { sessionId: "child" });
  await h.complete("extension", { sessionId: "child" });
  for (const [id, details] of [
    ["doc", { params: { documentURL: "chrome-extension://abc/" } }],
    ["url", { url: "blob:edge-extension://abc/data" }],
    ["stack", { initiator: { stack: { callFrames: [], parent: { callFrames: [{ url: "chrome-extension://abc/async.js" }] } } } }],
    ["business", { initiator: { stack: { callFrames: [{ url: "https://customer.test/page.js" }, { url: "chrome-extension://abc/wrapper.js" }] } } }]
  ]) {
    h.request(id, details);
    await h.complete(id);
  }
  await h.command("save");
  const { rows, capture } = await output(h);
  assert.equal(rows.length, 2);
  assert.match(JSON.stringify(capture.warnings), /动态 iframe/);
  assert.equal((await h.command("status")).view.unsavedCount, 0);
  assert.equal(h.operations.filter((item) => item.method === "Network.getResponseBody").length, 2);
  assert.ok(h.operations.some((item) => item.method === "Runtime.runIfWaitingForDebugger" && item.target.sessionId === "child"));
});

test("privacy, supported body formats and original business fields survive frozen exports", async () => {
  const h = createHarness();
  await begin(h);
  h.bodies.set("root:json", JSON.stringify({ token: "response-secret", nested: { password: "hidden", value: 7 }, _capture: { business: true } }));
  h.request("json", {
    method: "POST", url: "https://customer.test/api/data?access_token=url-secret&view=7#token",
    request: { headers: { Authorization: "header-secret", "Content-Type": "application/json", Referer: "https://customer.test/?token=referer-secret" },
      postData: '{"password":"request-secret","value":7,"__proto__":{"business":true}}' }
  });
  await h.complete("json");
  h.request("form", { method: "POST", request: { headers: { "Content-Type": "application/x-www-form-urlencoded" }, postData: "token=form-secret&value=7" } });
  await h.complete("form");
  for (const [id, mime, body] of [["multipart", "multipart/form-data; boundary=xx", "password=secret"], ["opaque", "text/plain", "opaque-secret"]]) {
    h.request(id, { method: "POST", request: { headers: { "Content-Type": mime }, postData: body } });
    await h.complete(id);
  }
  h.setCommandHook((target, method, params) => {
    if (method === "Network.getResponseBody" && params.requestId === "base64") {
      return { body: Buffer.from('{"token":"base64-secret","value":"中文"}').toString("base64"), base64Encoded: true };
    }
  });
  h.request("base64");
  await h.complete("base64");
  await h.command("save");
  const { rows, capture } = await output(h);
  const encoded = JSON.stringify(rows);
  for (const secret of ["response-secret", "request-secret", "header-secret", "url-secret", "referer-secret", "form-secret", "base64-secret"]) assert.equal(encoded.includes(secret), false, secret);
  assert.equal(JSON.parse(rows[0].response.bodyText)._capture.business, true);
  assert.equal(JSON.parse(rows[0].request.bodyText).__proto__.business, true);
  assert.equal(rows[1].request.bodyText, "token=%5BREDACTED%5D&value=7");
  assert.equal(Object.hasOwn(rows[2].request, "bodyText"), false);
  assert.equal(rows[3].request.bodyText, "opaque-secret");
  assert.equal(JSON.parse(rows[4].response.bodyText).value, "中文");
  assert.match(JSON.stringify(capture.warnings), /multipart 无法可靠解析和脱敏/);
  assert.match(JSON.stringify(capture.warnings), /原文未做字段级脱敏/);
});

test("network failure, unsupported MIME, missing body and streaming omissions remain diagnosable", async () => {
  const h = createHarness();
  await begin(h);
  h.request("failed");
  h.emit("Network.loadingFailed", { requestId: "failed", errorText: "net::ERR_CONNECTION_RESET" });
  h.request("binary");
  await h.complete("binary", { response: { mimeType: "image/png" } });
  h.setCommandHook((target, method, params) => {
    if (method === "Network.getResponseBody" && params.requestId === "unavailable") return Promise.reject(new Error("not available"));
  });
  h.request("unavailable");
  await h.complete("unavailable");
  h.request("stream");
  h.emit("Network.responseReceived", { requestId: "stream", type: "Fetch", response: { status: 200, mimeType: "text/event-stream", headers: {} } });
  await h.command("save");
  const { rows, capture } = await output(h);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].response.status, 0);
  assert.match(rows[0].response.networkError, /ERR_CONNECTION_RESET/);
  for (const text of ["请求失败", "二进制", "浏览器未能提供响应正文", "流式消息正文未记录"]) assert.ok(JSON.stringify(capture.warnings).includes(text), text);
});

test("terminal close returns to the business tab and cannot close an active batch", async () => {
  const h = createHarness();
  await begin(h);
  await h.node("closeCapture").handlers.click();
  assert.equal(h.operations.filter((item) => item.kind === "tabRemove").length, 0);
  await h.command("end");
  await h.node("closeCapture").handlers.click();
  assert.ok(h.operations.some((item) => item.kind === "tabUpdate" && item.id === 7 && item.props.active));
  assert.ok(h.operations.some((item) => item.kind === "tabRemove" && item.id === 99));
  const missing = createHarness();
  await begin(missing);
  await missing.command("end");
  missing.tab.closed = true;
  await missing.node("closeCapture").handlers.click();
  assert.ok(missing.operations.some((item) => item.kind === "tabRemove" && item.id === 99));
});

test("version, permission and minimum browser declarations remain consistent", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(extension, "../package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
  const source = fs.readFileSync(path.join(extension, "capture.js"), "utf8");
  assert.equal(manifest.version, pkg.version);
  assert.equal(source.match(/CAPTURE_VERSION = "([^"]+)"/)[1], pkg.version);
  assert.equal(manifest.minimum_chrome_version, "105");
  assert.deepEqual(manifest.permissions, ["activeTab", "debugger", "downloads", "storage"]);
  assert.equal(manifest.background.service_worker, "background.js");
  for (const filename of ["capture.html", "popup.html"]) {
    const html = fs.readFileSync(path.join(extension, filename), "utf8");
    const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    const js = fs.readFileSync(path.join(extension, filename.replace("html", "js")), "utf8");
    for (const match of js.matchAll(/node\("([^"]+)"\)/g)) assert.ok(declared.has(match[1]), filename + ": " + match[1]);
  }
});

test("extension attribution arriving while a response body is being read discards the body and record", async () => {
  const h = createHarness();
  await begin(h);
  let releaseBody;
  h.setCommandHook((target, method) => {
    if (method === "Network.getResponseBody") return new Promise((resolve) => { releaseBody = resolve; });
  });
  h.request("body-child", { initiator: { type: "preflight", requestId: "late-parent" } });
  await h.complete("body-child");
  h.request("late-parent", { url: "chrome-extension://other/loader.js" });
  releaseBody({ body: '{"value":1}', base64Encoded: false });
  await h.flush();
  await h.command("save");
  assert.deepEqual((await output(h)).rows, []);
  assert.equal((await h.command("status")).view.totalBodyBytes, 0);
});

test("events from another browser tab cannot enter the bound batch", async () => {
  const h = createHarness();
  await begin(h);
  h.chrome.debugger.onEvent.emit({ tabId: 8 }, "Network.requestWillBeSent", {
    requestId: "other-tab", type: "Fetch", request: { method: "POST", url: "https://other.test/api", headers: {} }
  });
  h.chrome.debugger.onEvent.emit({ tabId: 8 }, "Page.loadEventFired", {});
  h.chrome.debugger.onDetach.emit({ tabId: 8 }, "target_closed");
  await h.command("save");
  assert.deepEqual((await output(h)).rows, []);
  assert.equal((await h.command("status")).view.phase, "recording");
});

test("a failed close restores its button so the user can retry", async () => {
  const h = createHarness();
  await begin(h);
  await h.command("end");
  h.chrome.tabs.remove = async () => { throw new Error("remove failed"); };
  await h.node("closeCapture").handlers.click();
  assert.equal(h.node("closeCapture").disabled, false);
  assert.match(h.node("status").textContent, /无法关闭采集页面.*remove failed/);
});
