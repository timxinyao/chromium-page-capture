const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./capture-harness.cjs");

async function begin(h) {
  await h.command("start", { tabId: 7, note: "首份" });
  await h.flush();
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
  assert.equal((await h.command("status")).view.phase, "recording");
}
async function page(h, sequence) {
  const file = (await h.files(sequence)).find((item) => item.filename.endsWith("/page.json"));
  assert.ok(file, "page.json for snapshot " + sequence);
  return JSON.parse(file.text);
}

test("one initial reload then three independent incremental snapshots and an empty manual snapshot", async () => {
  const h = createHarness();
  await begin(h);
  for (const index of [2, 3, 4]) {
    h.request("same-" + index, { method: "POST" });
    await h.complete("same-" + index);
    h.setScreenshot("frame-" + index);
    await h.command("save", { note: "备注" + index });
    await h.flush();
    assert.equal((await page(h, index)).length, 1);
    assert.equal((await page(h, index))[0].request.method, "POST");
    assert.equal((await h.files(index)).find((item) => item.filename.endsWith(".png")).text, "frame-" + index);
  }
  await h.command("save");
  assert.deepEqual(await page(h, 5), []);
  assert.equal(h.operations.filter((item) => item.method === "Page.reload").length, 1);
  assert.ok(h.operations.findIndex((item) => item.method === "Network.enable") < h.operations.findIndex((item) => item.method === "Page.reload"));
  const count = h.downloads.length;
  await h.command("end");
  assert.equal((await h.command("status")).view.phase, "ended");
  assert.equal(h.downloads.length, count);
});

test("fixed five second cohort keeps late and newly arriving requests for the next snapshot", async () => {
  const h = createHarness();
  await begin(h);
  h.request("slow");
  await h.command("save");
  h.request("new");
  await h.complete("new");
  await h.clock.advance(4999);
  assert.equal(h.downloads.length, 3);
  await h.clock.advance(1);
  assert.deepEqual(await page(h, 2), []);
  assert.match((await h.files(2)).find((file) => file.filename.endsWith(".txt")).text, /未完成请求: 1/);
  await h.complete("slow");
  await h.command("save");
  assert.equal((await page(h, 3)).length, 2);
});

test("partial download failure retains the frozen frame and retries only failed files", async () => {
  const h = createHarness({ autoComplete: false });
  await h.command("start", { tabId: 7 });
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
  assert.equal(h.downloads.length, 3);
  h.finishDownload(1);
  h.finishDownload(2, "interrupted");
  h.finishDownload(3);
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "retry");
  const captureCount = h.operations.filter((item) => item.method === "Page.captureScreenshot").length;
  h.setScreenshot("changed");
  h.request("during-retry");
  await h.complete("during-retry");
  assert.equal((await h.command("save")).ok, false);
  assert.equal((await h.command("end")).ok, false);
  await h.command("retry");
  await h.command("retry");
  assert.equal(h.downloads.length, 4);
  assert.equal(h.downloads[1].filename, h.downloads[3].filename);
  assert.equal(await h.downloads[1].blob.text(), await h.downloads[3].blob.text());
  assert.equal(h.operations.filter((item) => item.method === "Page.captureScreenshot").length, captureCount);
  h.finishDownload(4);
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "recording");
  await h.command("save");
  assert.equal((await page(h, 2)).length, 1);
});

test("ending has a fixed twenty second cutoff and exports unfinished request metadata", async () => {
  const h = createHarness();
  await begin(h);
  h.request("unfinished", { method: "PATCH" });
  await h.command("end");
  h.request("outside-cutoff");
  await h.complete("outside-cutoff");
  await h.clock.advance(19999);
  assert.equal(h.downloads.length, 3);
  await h.clock.advance(1);
  const rows = await page(h, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request.method, "PATCH");
  assert.equal(rows[0].response.status, 0);
  assert.match((await h.files(2)).find((item) => item.filename.endsWith(".txt")).text, /未返回|尚未完成/);
  assert.equal((await h.command("status")).view.phase, "ended");
});

test("viewport fallback and fully missing screenshot commit the required files", async () => {
  const h = createHarness();
  h.failScreenshots(true);
  await begin(h);
  assert.match((await h.files(1)).find((item) => item.filename.endsWith(".txt")).text, /当前视口/);
  h.failScreenshots(true, true);
  h.request("missing-frame");
  await h.complete("missing-frame");
  await h.command("save");
  assert.equal((await h.files(2)).length, 2);
  assert.match((await h.command("status")).view.message, /接口已保存，截图失败/);
  await h.command("end");
  assert.equal(h.downloads.length, 5);
  assert.match((await h.command("status")).view.warning, /接口已保存，截图失败/);
});

test("recursive iframe sessions do not collide with the root or each other", async () => {
  const h = createHarness();
  await begin(h);
  h.emit("Target.attachedToTarget", { sessionId: "child-a", targetInfo: { type: "iframe" } });
  await h.flush();
  h.emit("Target.attachedToTarget", { sessionId: "child-b", targetInfo: { type: "iframe" } }, "child-a");
  await h.flush();
  h.request("collision");
  h.request("collision", { sessionId: "child-a", method: "POST" });
  h.request("collision", { sessionId: "child-b", method: "PUT" });
  await h.complete("collision");
  await h.complete("collision", { sessionId: "child-a" });
  await h.complete("collision", { sessionId: "child-b" });
  await h.command("save");
  assert.deepEqual((await page(h, 2)).map((entry) => entry.request.method).sort(), ["GET", "POST", "PUT"]);
  assert.deepEqual(h.operations.filter((item) => item.method === "Network.getResponseBody").map((item) => item.target.sessionId || "root").sort(), ["child-a", "child-b", "root"]);
  assert.ok(h.operations.some((item) => item.method === "Target.setAutoAttach" && item.target.sessionId === "child-b"));
});

test("interruption stops recording without reconnecting and allows an incomplete supplemental export", async () => {
  const h = createHarness();
  await begin(h);
  h.request("received");
  h.interrupt();
  h.request("after-detach");
  assert.equal((await h.command("status")).view.phase, "interrupted");
  await h.command("recover");
  assert.equal((await page(h, 2)).length, 1);
  assert.equal((await h.files(2)).length, 2);
  assert.equal((await h.command("status")).view.phase, "ended");
  assert.equal(h.operations.filter((item) => item.kind === "attach").length, 1);
  assert.equal(h.operations.filter((item) => item.method === "Page.reload").length, 1);
});

test("duplicate commands, child load events and initial timeout never create a second initial snapshot", async () => {
  const h = createHarness();
  await h.command("start", { tabId: 7, commandId: "start-once" });
  await h.command("start", { tabId: 7, commandId: "start-once" });
  assert.equal((await h.command("start", { tabId: 7 })).ok, false);
  h.emit("Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe" } });
  await h.flush();
  h.emit("Page.loadEventFired", {}, "child");
  await h.clock.advance(2600);
  assert.equal(h.downloads.length, 0);
  h.request("still-pending");
  await h.clock.advance(17400);
  assert.equal(h.downloads.length, 3);
  assert.deepEqual(await page(h, 1), []);
  const first = (await h.files(1)).find((item) => item.filename.endsWith(".txt")).text;
  assert.match(first, /未完成请求: 1/);
  assert.match(first, /首次准备 20 秒/);
  await h.complete("still-pending");
  await h.command("save", { commandId: "save-once" });
  await h.command("save", { commandId: "save-once" });
  assert.equal(h.downloads.length, 6);
  assert.equal((await page(h, 2)).length, 1);
  assert.equal(h.operations.filter((item) => item.method === "Page.reload").length, 1);
});

test("a redirect remains in the original fixed cohort and retains both redirect segments", async () => {
  const h = createHarness();
  await begin(h);
  h.request("redirect", { url: "https://customer.test/api/old" });
  await h.command("save");
  h.request("redirect", { url: "https://customer.test/api/new", params: { redirectResponse: { status: 302, headers: { location: "https://customer.test/api/new" }, mimeType: "text/html" } } });
  await h.clock.advance(1000);
  assert.equal(h.downloads.length, 3, "the completed redirect segment must not end the cohort before its continuation");
  await h.complete("redirect");
  assert.equal((await page(h, 2)).length, 2);
  assert.deepEqual((await page(h, 2)).map((entry) => entry.response.status), [302, 200]);
  await h.command("save");
  assert.deepEqual(await page(h, 3), []);
});

test("ending retries retain the same cutoff and require explicit confirmation to abandon", async () => {
  const h = createHarness({ autoComplete: false });
  await h.command("start", { tabId: 7 });
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
  for (const download of h.downloads) h.finishDownload(download.id);
  await h.flush();
  h.request("last");
  await h.complete("last");
  await h.command("end");
  assert.equal(h.downloads.length, 6);
  h.finishDownload(4);
  h.finishDownload(5, "interrupted");
  h.finishDownload(6);
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "retry");
  assert.match((await h.command("status")).view.message, /截止新请求.*原末份/);
  h.request("after-cutoff");
  await h.complete("after-cutoff");
  assert.equal((await h.command("abandon")).ok, false);
  await h.command("retry");
  h.finishDownload(7);
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "ended");
  assert.equal(h.downloads.length, 7);
  assert.equal((await page(h, 2)).length, 1);

  const abandon = createHarness({ autoComplete: false });
  await abandon.command("start", { tabId: 7 });
  abandon.emit("Page.loadEventFired");
  await abandon.clock.advance(2600);
  abandon.finishDownload(1);
  abandon.finishDownload(2, "interrupted");
  abandon.finishDownload(3);
  await abandon.flush();
  await abandon.command("abandon", { confirmed: true });
  assert.equal((await abandon.command("status")).view.phase, "ended");
  assert.equal(abandon.downloads.length, 3, "already downloaded files are retained");
  assert.equal((await abandon.command("status")).view.unsavedCount, 0);
});

test("a timed-out download that completes late is queried and never downloaded twice", async () => {
  const h = createHarness({ autoComplete: false });
  await h.command("start", { tabId: 7 });
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
  h.finishDownload(1);
  h.finishDownload(3);
  await h.clock.advance(120000);
  assert.equal((await h.command("status")).view.phase, "retry");
  await h.command("retry");
  assert.equal(h.downloads.length, 3, "retry waits on an existing in-progress ID");
  h.finishDownload(2);
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "recording");
  assert.equal(h.downloads.length, 3);
  assert.equal(h.objects.size, 0);
});

test("responses resolving during screenshot capture after the five second deadline enter the next snapshot", async () => {
  const h = createHarness();
  await begin(h);
  h.request("late");
  let releaseScreenshot;
  h.setCommandHook((target, method) => {
    if (method === "Page.captureScreenshot") return new Promise((resolve) => { releaseScreenshot = resolve; });
  });
  await h.command("save");
  await h.clock.advance(5000);
  await h.complete("late");
  releaseScreenshot({ data: "AA==" });
  await h.flush();
  assert.deepEqual(await page(h, 2), []);
  h.setCommandHook(null);
  await h.command("save");
  assert.equal((await page(h, 3)).length, 1);
});

test("disconnect during save keeps its snapshot, then permits a separate supplemental export", async () => {
  const h = createHarness({ autoComplete: false });
  await h.command("start", { tabId: 7 });
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
  h.request("while-saving");
  await h.complete("while-saving");
  h.interrupt();
  h.finishDownload(1);
  h.finishDownload(2);
  h.finishDownload(3);
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "interrupted");
  await h.command("recover");
  assert.equal((await h.files(2)).length, 2);
  h.finishDownload(4);
  h.finishDownload(5);
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "ended");
  assert.equal((await page(h, 2)).length, 1);
});

test("child setup failure or detach surfaces incomplete coverage, while old kernels retain root recording", async () => {
  const h = createHarness();
  await begin(h);
  h.setCommandHook((target, method) => {
    if (target.sessionId === "bad-child" && method === "Network.enable") return Promise.reject(new Error("child blocked"));
  });
  h.emit("Target.attachedToTarget", { sessionId: "bad-child", targetInfo: { type: "iframe" }, waitingForDebugger: true });
  await h.flush();
  assert.match((await h.command("status")).view.warning, /iframe 子页面监听失败/);
  assert.ok(h.operations.some((item) => item.method === "Runtime.runIfWaitingForDebugger" && item.target.sessionId === "bad-child"));
  h.emit("Target.attachedToTarget", { sessionId: "good-child", targetInfo: { type: "iframe" } });
  await h.flush();
  h.request("pending-child", { sessionId: "good-child" });
  h.emit("Target.detachedFromTarget", { sessionId: "good-child" });
  await h.command("save");
  assert.equal((await page(h, 2)).length, 1);
  assert.match((await h.files(2)).find((item) => item.filename.endsWith(".txt")).text, /缺少完整返回/);
  const old = createHarness({ major: 105 });
  await begin(old);
  old.request("root");
  await old.complete("root");
  await old.command("save");
  assert.equal((await page(old, 2)).length, 1);
  assert.match((await old.command("status")).view.warning, /旧内核/);
  assert.equal(old.operations.filter((item) => item.method === "Target.setAutoAttach").length, 0);
});

test("body limits are per record and uncommitted batch; successful snapshots release body memory", async () => {
  const h = createHarness();
  await begin(h);
  const twoMiB = "x".repeat(2 * 1024 * 1024);
  for (let index = 0; index < 13; index++) {
    h.bodies.set("root:limit-" + index, twoMiB);
    h.request("limit-" + index);
    await h.complete("limit-" + index, { response: { mimeType: "text/plain" } });
  }
  assert.equal((await h.command("status")).view.totalBodyBytes, 24 * 1024 * 1024);
  await h.command("save");
  const rows = await page(h, 2);
  assert.equal(rows.length, 13);
  assert.equal(rows.filter((entry) => typeof entry.response.content.text === "string").length, 12);
  assert.match((await h.files(2)).find((item) => item.filename.endsWith(".txt")).text, /响应正文累计大小超过保存上限/);
  assert.equal((await h.command("status")).view.totalBodyBytes, 0);
  assert.equal((await h.command("status")).view.metadataBytes, 0);
  h.bodies.set("root:oversized", twoMiB + "x");
  h.request("oversized");
  await h.complete("oversized", { response: { mimeType: "text/plain" } });
  await h.command("save");
  assert.equal(Object.hasOwn((await page(h, 3))[0].response.content, "text"), false);
  assert.match((await h.files(3)).find((item) => item.filename.endsWith(".txt")).text, /单条保存上限/);
});

test("record and metadata resource limits stop new collection while preserving supplemental export", async () => {
  const h = createHarness();
  await begin(h);
  for (let index = 0; index <= 2000; index++) h.request("pending-" + index);
  const limited = (await h.command("status")).view;
  assert.equal(limited.phase, "interrupted");
  assert.equal(limited.unsavedCount, 2000);
  assert.match(limited.warning, /2000/);
  h.request("after-limit");
  assert.equal((await h.command("status")).view.unsavedCount, 2000);
  await h.command("recover");
  assert.equal((await page(h, 2)).length, 2000);
  assert.equal((await h.command("status")).view.unsavedCount, 0);
  const meta = createHarness();
  await begin(meta);
  for (let index = 0; index < 20; index++) meta.request("headers-" + index, { request: { headers: { "X-Application-Data": "x".repeat(512 * 1024) } } });
  const metaView = (await meta.command("status")).view;
  assert.equal(metaView.phase, "interrupted");
  assert.match(metaView.warning, /8 MiB/);
  assert.ok(metaView.metadataBytes <= 8 * 1024 * 1024);
  assert.ok(metaView.unsavedCount > 0);
});

test("request identity ledger and child-session caches are explicitly bounded", async () => {
  const h = createHarness();
  await begin(h);
  for (let index = 0; index <= 10000; index++) h.request("extension-" + index, { url: "chrome-extension://other/a.js" });
  const view = (await h.command("status")).view;
  assert.equal(view.phase, "interrupted");
  assert.equal(view.requestKeyCount, 10000);
  assert.match(view.warning, /请求标识/);
  const frames = createHarness();
  await begin(frames);
  for (let index = 0; index <= 128; index++) frames.emit("Target.attachedToTarget", {
    sessionId: "frame-" + index, targetInfo: { type: "iframe" }, waitingForDebugger: true
  });
  await frames.flush();
  assert.equal((await frames.command("status")).view.phase, "interrupted");
  assert.match((await frames.command("status")).view.warning, /128/);
  assert.ok(frames.operations.some((item) => item.method === "Runtime.runIfWaitingForDebugger" && item.target.sessionId === "frame-128"));
});

test("a failed ordinary snapshot commits identities only after retry and excludes them from the next snapshot", async () => {
  const h = createHarness({ autoComplete: false });
  await h.command("start", { tabId: 7 });
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
  for (const file of h.downloads) h.finishDownload(file.id);
  await h.flush();
  h.request("first", { url: "https://customer.test/api/data?call=first" });
  await h.complete("first");
  await h.command("save", { note: "原备注" });
  h.request("next", { url: "https://customer.test/api/data?call=next" });
  await h.complete("next");
  h.finishDownload(4);
  h.finishDownload(5);
  h.finishDownload(6, "interrupted");
  await h.flush();
  assert.equal((await h.command("status")).view.unsavedCount, 2);
  const originalFrame = await h.downloads[5].blob.text();
  h.setScreenshot("new-screen");
  await h.command("retry", { note: "不能替换原备注" });
  assert.equal(h.downloads.length, 7);
  assert.equal(await h.downloads[6].blob.text(), originalFrame);
  h.finishDownload(7);
  await h.flush();
  assert.equal((await h.command("status")).view.unsavedCount, 1);
  await h.command("save");
  assert.deepEqual((await page(h, 3)).map((row) => new URL(row.request.url).searchParams.get("call")), ["next"]);
  const originalNotes = (await h.files(2)).find((item) => item.filename.endsWith(".txt")).text;
  assert.match(originalNotes, /原备注/);
  assert.equal(originalNotes.includes("不能替换"), false);
});

test("fully missing screenshot does not commit the records until JSON and notes both complete", async () => {
  const h = createHarness({ autoComplete: false });
  h.failScreenshots(true, true);
  await h.command("start", { tabId: 7 });
  h.request("api");
  await h.complete("api");
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
  assert.equal(h.downloads.length, 2);
  h.finishDownload(1);
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "saving");
  assert.equal((await h.command("status")).view.unsavedCount, 1);
  h.finishDownload(2);
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "recording");
  assert.equal((await h.command("status")).view.unsavedCount, 0);
  assert.match((await h.command("status")).view.message, /接口已保存，截图失败/);
});

test("stale batch commands cannot save or end the next batch in a reused state page", async () => {
  const h = createHarness();
  await begin(h);
  const old = (await h.command("status")).view.batchId;
  await h.command("end");
  await h.command("start", { tabId: 7 });
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
  const current = (await h.command("status")).view;
  assert.notEqual(current.batchId, old);
  for (const command of ["save", "end", "recover", "retry", "abandon"]) {
    assert.equal((await h.command(command, { batchId: old, confirmed: true })).ok, false);
  }
  assert.equal((await h.command("status")).view.phase, "recording");
  assert.equal(h.downloads.length, 6);
});

test("an interrupted pending attach is cleaned up before a new batch is allowed", async () => {
  const h = createHarness();
  let attach;
  h.chrome.debugger.attach = () => new Promise((resolve) => { attach = resolve; });
  await h.command("start", { tabId: 7 });
  h.chrome.tabs.onRemoved.emit(7);
  await h.command("recover");
  assert.equal((await h.command("status")).view.phase, "ending");
  assert.equal((await h.command("start", { tabId: 7 })).ok, false);
  attach();
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "ended");
  assert.equal(h.operations.filter((item) => item.kind === "detach").length, 1);
  assert.equal(h.operations.filter((item) => item.method === "Page.reload").length, 0);
});

test("ending waits for the same delayed detach once and blocks overlapping commands", async () => {
  const h = createHarness();
  await begin(h);
  let release;
  let detaches = 0;
  h.chrome.debugger.detach = () => {
    detaches++;
    return new Promise((resolve) => { release = resolve; });
  };
  await h.command("end");
  assert.equal((await h.command("status")).view.phase, "ending");
  await h.clock.advance(10000);
  assert.equal((await h.command("status")).view.phase, "ending", "a pending real detach must not be bypassed by a local timeout");
  assert.equal((await h.command("end")).ok, false);
  assert.equal((await h.command("start", { tabId: 7 })).ok, false);
  h.interrupt("canceled_by_user");
  release();
  await h.flush();
  assert.equal((await h.command("status")).view.phase, "ended");
  assert.equal(detaches, 1);
});

test("existing nested iframe sessions enable their listeners before the only initial reload", async () => {
  const h = createHarness();
  h.setCommandHook((target, method, params) => {
    if (method !== "Target.setAutoAttach" || !params.autoAttach) return;
    if (!target.sessionId) h.emit("Target.attachedToTarget", { sessionId: "existing", targetInfo: { type: "iframe" } });
    else if (target.sessionId === "existing") h.emit("Target.attachedToTarget", { sessionId: "nested-existing", targetInfo: { type: "iframe" } }, "existing");
  });
  await h.command("start", { tabId: 7 });
  await h.flush();
  const reloadIndex = h.operations.findIndex((item) => item.method === "Page.reload");
  for (const id of ["existing", "nested-existing"]) {
    const childIndex = h.operations.findIndex((item) => item.method === "Network.enable" && item.target.sessionId === id);
    assert.ok(childIndex >= 0 && childIndex < reloadIndex, id + " must be recording before reload");
  }
  assert.ok(h.operations.filter((item) => item.method === "Target.setAutoAttach" && item.params.autoAttach)
    .every((item) => item.params.waitForDebuggerOnStart === false), "never pause business scripts to attach child listeners");
  h.request("same-id", { sessionId: "existing", method: "POST" });
  h.request("same-id", { sessionId: "nested-existing", method: "PUT" });
  await h.complete("same-id", { sessionId: "existing" });
  await h.complete("same-id", { sessionId: "nested-existing" });
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
  assert.equal((await page(h, 1)).length, 2);
});

test("ending freezes redirect segments and body results before a delayed screenshot finishes", async () => {
  const h = createHarness();
  await begin(h);
  h.request("late-redirect");
  await h.command("end");
  let release;
  h.setCommandHook((target, method) => {
    if (method === "Page.captureScreenshot") return new Promise((resolve) => { release = resolve; });
  });
  await h.clock.advance(20000);
  h.request("late-redirect", { url: "https://customer.test/api/redirected", params: {
    redirectResponse: { status: 302, headers: {}, mimeType: "text/html" }
  } });
  await h.complete("late-redirect");
  release({ data: "AA==" });
  await h.flush();
  const view = (await h.command("status")).view;
  assert.equal(view.phase, "ended");
  assert.equal(view.unsavedCount, 0);
  assert.equal(view.totalBodyBytes, 0);
  assert.equal((await page(h, 2)).length, 1);
  assert.equal((await page(h, 2))[0].response.status, 0);
  assert.equal(h.operations.filter((item) => item.method === "Network.getResponseBody").length, 0);
});

test("cross-origin page metadata comes from CDP when activeTab no longer exposes the tab URL or title", async () => {
  const h = createHarness();
  await begin(h);
  const folder = (await h.command("status")).view.folder;
  h.chrome.tabs.get = async () => ({ id: 7, windowId: 1 });
  h.setCommandHook((target, method) => {
    if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [
      { id: 2, url: "https://other.test/new?token=private", title: "新域名页面" }
    ] };
  });
  h.emit("Page.frameNavigated", { frame: { id: "root", url: "https://other.test/new?token=private" } });
  h.request("new-origin", { url: "https://other.test/api/data" });
  await h.complete("new-origin");
  await h.command("save");
  h.request("last-origin", { url: "https://other.test/api/last" });
  await h.complete("last-origin");
  await h.command("end");
  for (const index of [2, 3]) {
    const note = (await h.files(index)).find((file) => file.filename.endsWith(".txt")).text;
    assert.match(note, /页面标题: 新域名页面/);
    assert.match(note, /最终页面地址: https:\/\/other.test\/new/);
    assert.equal(note.includes("token=private"), false);
    assert.equal(note.includes("最终页面地址: https://customer.test/page"), false);
  }
  assert.equal((await h.command("status")).view.folder, folder);
});

test("unavailable current page metadata is explicitly unknown instead of copied from the starting page", async () => {
  const h = createHarness();
  await begin(h);
  h.chrome.tabs.get = async () => ({ id: 7 });
  h.setCommandHook((target, method) => {
    if (method === "Page.getNavigationHistory") return Promise.reject(new Error("metadata unavailable"));
  });
  h.emit("Page.frameNavigated", { frame: { id: "root", url: "https://other.test/new" } });
  h.emit("Page.frameStartedLoading", { frameId: "root" });
  await h.command("save");
  const note = (await h.files(2)).find((file) => file.filename.endsWith(".txt")).text;
  assert.match(note, /最终页面地址: .*未知/);
  assert.match(note, /页面标题: .*未知/);
  assert.equal(note.includes("最终页面地址: https://customer.test/page"), false);
});

test("sealed ending records ignore body promises resolving during screenshots or after the batch ended", async () => {
  for (const afterEnd of [false, true]) {
    const h = createHarness();
    await begin(h);
    h.request("late-body");
    await h.command("end");
    await h.clock.advance(19500);
    let body;
    let screenshot;
    h.setCommandHook((target, method) => {
      if (method === "Network.getResponseBody") return new Promise((resolve) => { body = resolve; });
      if (method === "Page.captureScreenshot") return new Promise((resolve) => { screenshot = resolve; });
    });
    await h.complete("late-body");
    await h.clock.advance(500);
    if (!afterEnd) body({ body: '{"late":true}', base64Encoded: false });
    await h.flush();
    assert.equal((await h.command("status")).view.totalBodyBytes, 0);
    screenshot({ data: "AA==" });
    await h.flush();
    if (afterEnd) body({ body: '{"late":true}', base64Encoded: false });
    await h.flush();
    const view = (await h.command("status")).view;
    assert.equal(view.phase, "ended");
    assert.equal(view.totalBodyBytes, 0);
    assert.equal(view.unsavedCount, 0);
    assert.equal(Object.hasOwn((await page(h, 2))[0].response.content, "text"), false);
  }
});

test("child setup callbacks finishing after the ending snapshot cannot reopen collection or body budgets", async () => {
  const h = createHarness();
  await begin(h);
  let childSetup;
  h.setCommandHook((target, method) => {
    if (target.sessionId === "delayed-child" && method === "Network.enable") return new Promise((resolve) => { childSetup = resolve; });
  });
  h.emit("Target.attachedToTarget", { sessionId: "delayed-child", targetInfo: { type: "iframe" } });
  h.request("last");
  await h.complete("last");
  await h.command("end");
  assert.equal((await h.command("status")).view.phase, "ended");
  childSetup({});
  await h.flush();
  h.request("late-child", { sessionId: "delayed-child" });
  await h.complete("late-child", { sessionId: "delayed-child" });
  const view = (await h.command("status")).view;
  assert.equal(view.phase, "ended");
  assert.equal(view.totalBodyBytes, 0);
  assert.equal(view.unsavedCount, 0);
  assert.equal((await page(h, 2)).length, 1);
});

test("child frame navigation cannot replace current root page metadata", async () => {
  const h = createHarness();
  await begin(h);
  h.chrome.tabs.get = async () => ({ id: 7 });
  h.setCommandHook((target, method) => {
    if (method === "Page.getNavigationHistory") return Promise.reject(new Error("history unavailable"));
  });
  h.emit("Page.frameNavigated", { frame: { id: "root", url: "https://root.test/current" } });
  h.emit("Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe" } });
  await h.flush();
  h.emit("Page.frameNavigated", { frame: { id: "child-root", url: "https://child.test/frame" } }, "child");
  h.emit("Page.navigatedWithinDocument", { frameId: "root", url: "https://child.test/wrong" }, "child");
  await h.command("save");
  const note = (await h.files(2)).find((file) => file.filename.endsWith(".txt")).text;
  assert.match(note, /最终页面地址: https:\/\/root.test\/current/);
  assert.equal(note.includes("https://child.test/"), false);
});
