const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./capture-harness.cjs");

async function begin(h, note = "") {
  await h.command("start", { tabId: 7, note });
  h.emit("Page.loadEventFired");
  await h.clock.advance(2600);
}

async function exported(h, sequence = 2) {
  const files = await h.files(sequence);
  const file = files.find((item) => item.filename.endsWith("/page.json"));
  assert.ok(file);
  return JSON.parse(file.text);
}

async function response(h, id, text, mimeType = "application/json", status = 200) {
  h.bodies.set("root:" + id, text);
  h.request(id);
  await h.complete(id, { response: { mimeType, status } });
}

test("v2 keeps all JSON business values, empty text, error statuses and duplicate ordered parameters", async () => {
  const h = createHarness();
  await begin(h);
  const values = [null, false, 0, "", [], {}, { data: [], extra: { value: "完整" } }];
  for (const [index, value] of values.entries()) await response(h, "json-" + index, JSON.stringify(value), "application/json", index % 2 ? 404 : 500);
  await response(h, "empty", "", "text/plain", 204);
  h.request("parameters", { method: "PATCH", url: "https://customer.test/api?tag=a&tag=b&token=one&token=two", request: {
    headers: { Authorization: "synthetic-secret", "X-Multi": "a\nb", "Content-Type": "application/x-www-form-urlencoded" },
    postData: "tag=a&tag=b&token=one&token=two&v=%E4%B8%AD%E6%96%87"
  } });
  await h.complete("parameters");
  await h.command("save", { note: "  完整备注  " });
  const doc = await exported(h);
  assert.deepEqual(Object.keys(doc), ["formatVersion", "capture", "entries"]);
  assert.equal(doc.formatVersion, 2);
  assert.equal(doc.capture.note, "  完整备注  ");
  assert.equal(doc.capture.screenshot.scope, "full-page");
  assert.ok(!Number.isNaN(Date.parse(doc.capture.capturedAt)));
  for (const [index, value] of values.entries()) {
    assert.deepEqual(doc.entries[index].response.body, value);
    assert.equal(doc.entries[index].response.bodyText, JSON.stringify(value));
    assert.equal(doc.entries[index].response.bodyStatus, "captured");
    assert.equal(doc.entries[index].response.status, index % 2 ? 404 : 500);
    assert.equal(doc.entries[index].request.bodyStatus, "absent");
  }
  assert.equal(doc.entries[7].response.bodyStatus, "empty");
  assert.equal(doc.entries[7].response.bodyText, "");
  const request = doc.entries[8].request;
  assert.equal(request.method, "PATCH");
  assert.deepEqual(request.query, [{ name: "tag", value: "a" }, { name: "tag", value: "b" },
    { name: "token", value: "[REDACTED]" }, { name: "token", value: "[REDACTED]" }]);
  assert.equal(new URL(request.url).searchParams.getAll("token").length, 2);
  assert.equal(request.headers.find((item) => item.name === "X-Multi").value, "a\nb");
  assert.equal(request.bodyText, "tag=a&tag=b&token=%5BREDACTED%5D&token=%5BREDACTED%5D&v=%E4%B8%AD%E6%96%87");
  assert.deepEqual(doc.capture.warnings, []);
  assert.deepEqual((await h.files(2)).map((file) => file.filename.split("/").pop()).sort(), ["page.json", "screenshot-full.png"]);
});

test("text/plain forms with empty segments and bare fields redact both body sides without rewriting other fields", async () => {
  const h = createHarness();
  await begin(h);
  const cases = [
    { input: "token=synthetic-secret&tag=one&", expected: "token=%5BREDACTED%5D&tag=one&" },
    { input: "token=synthetic-secret&flag", expected: "token=%5BREDACTED%5D&flag" },
    { input: "flag&&token=synthetic-secret&tag=one&token=synthetic-repeat&tag=two&", expected: "flag&&token=%5BREDACTED%5D&tag=one&token=%5BREDACTED%5D&tag=two&" },
    { input: "tag=one&tag=two&flag&", expected: "tag=one&tag=two&flag&" },
    { input: "token=synthetic-secret&value=%FF&flag", omitted: true },
    { input: "ordinary text with spaces & flag", plainText: true }
  ];
  for (const [index, item] of cases.entries()) {
    const id = "form-" + index;
    h.request(id, { method: "POST", request: { headers: { "Content-Type": "text/plain" }, postData: item.input } });
    h.bodies.set("root:" + id, item.input);
    await h.complete(id, { response: { mimeType: "text/plain" } });
  }
  await h.command("save");
  const doc = await exported(h);
  for (const [index, item] of cases.entries()) for (const side of ["request", "response"]) {
    const part = doc.entries[index][side];
    if (item.omitted) {
      assert.equal(part.bodyStatus, "omitted");
      assert.equal(part.bodyError.code, "form-redaction-failed");
      assert.equal(Object.hasOwn(part, "bodyText"), false);
    } else {
      assert.equal(part.bodyStatus, "captured");
      assert.equal(part.bodyText, item.expected ?? item.input);
      assert.equal(Boolean(part.bodyWarnings?.some((warning) => warning.code === "field-redaction-unsupported")), Boolean(item.plainText));
    }
  }
  assert.equal(JSON.stringify(doc).includes("synthetic-"), false);
});

test("partially malformed encoded sensitive names redact URL and query consistently while preserving duplicate parameters", async () => {
  const h = createHarness();
  await begin(h);
  const url = "https://customer.test/api?%74oken%ZZ=synthetic-secret&tag=one&%74oken%ZZ=synthetic-repeat&flag&%ZZ%74oken=synthetic-prefix&%74oken%FF=synthetic-utf8&label%26key=one%20two&broken%ZZ=ordinary%2Bvalue";
  h.request("encoded-name", { url });
  await h.complete("encoded-name");
  await h.command("save");
  const doc = await exported(h);
  const request = doc.entries[0].request;
  assert.equal(request.url, url.replace(/synthetic-(?:secret|repeat|prefix|utf8)/g, "[REDACTED]"));
  assert.deepEqual(request.query, [
    { name: "token%ZZ", value: "[REDACTED]" },
    { name: "tag", value: "one" },
    { name: "token%ZZ", value: "[REDACTED]" },
    { name: "flag", value: "" },
    { name: "%ZZtoken", value: "[REDACTED]" },
    { name: "token\uFFFD", value: "[REDACTED]" },
    { name: "label&key", value: "one two" },
    { name: "broken%ZZ", value: "ordinary+value" }
  ]);
  const urlQuery = [...new URL(request.url).searchParams].map(([name, value]) => ({ name, value }));
  assert.deepEqual(urlQuery, request.query);
  assert.equal(JSON.stringify(doc).includes("synthetic-"), false);
});

test("JSON redaction preserves whitespace, number spelling, duplicate keys and escaped names", async () => {
  const h = createHarness();
  await begin(h);
  const raw = '{\n "id":90071992547409931234, "decimal":0.123456789012345678901, "same":1,"same":2, "\\u0074oken":{"secret":"synthetic"}, "password":4,"password":5, "__proto__":{"ok":true}\n}';
  const expected = raw.replace('{"secret":"synthetic"}', '"[REDACTED]"').replace('"password":4', '"password":"[REDACTED]"').replace('"password":5', '"password":"[REDACTED]"');
  h.request("lossless", { method: "POST", request: { headers: { "Content-Type": "application/json" }, postData: raw } });
  h.bodies.set("root:lossless", raw);
  await h.complete("lossless");
  await h.command("save");
  const doc = await exported(h);
  for (const side of ["request", "response"]) {
    const part = doc.entries[0][side];
    assert.equal(part.bodyText, expected);
    assert.equal(Object.hasOwn(part, "body"), false);
    assert.deepEqual(part.bodyWarnings.map((item) => item.code).sort(), ["duplicate-json-keys", "json-number-precision"]);
  }
  assert.equal(JSON.stringify(doc).includes("synthetic"), false);
});

test("safe JSON views preserve proto names while precise numbers and duplicate decoded keys suppress views", async () => {
  const h = createHarness();
  await begin(h);
  const texts = ['{"__proto__":{"business":true},"v":1.25e2}', '{"n":1e400}', '{"n":-0}', '{"n":9007199254740992}', '{"a":1,"\\u0061":2}', '\uFEFF{"safe":1}'];
  for (const [index, text] of texts.entries()) await response(h, String(index), text);
  await h.command("save");
  const rows = (await exported(h)).entries;
  assert.equal(rows[0].response.body.__proto__.business, true);
  assert.equal(Object.hasOwn(rows[0].response.body, "__proto__"), true);
  for (const index of [1, 2, 3, 4]) {
    assert.equal(rows[index].response.bodyText, texts[index]);
    assert.equal(Object.hasOwn(rows[index].response, "body"), false);
  }
  assert.equal(rows[5].response.bodyText, texts[5]);
  assert.deepEqual(rows[5].response.body, { safe: 1 });
});

test("text MIME variants and mislabeled JSON retain content with accurate redaction warnings", async () => {
  const h = createHarness();
  await begin(h);
  const cases = [["text/html", "<html><p>完整页面</p></html>"], ["application/xml", "<root token='plain'/>"],
    ["text/css", ".a { color: red; }"], ["text/csv", "a,b\n1,2"], ["application/graphql", "{ customer { id name } }"],
    ["application/x-custom", "ordinary text"], ["application/octet-stream", '{"token":"synthetic-secret","ok":true}'],
    ["text/plain", "token=synthetic-form&tag=1&tag=2"]];
  for (const [index, [mime, text]] of cases.entries()) {
    h.request(String(index), { method: "PUT", request: { headers: { "Content-Type": mime }, postData: text } });
    h.bodies.set("root:" + index, text);
    await h.complete(String(index), { response: { mimeType: mime } });
  }
  await h.command("save");
  const doc = await exported(h);
  for (const index of [0, 1, 2, 3, 4, 5]) for (const side of ["request", "response"]) {
    assert.equal(doc.entries[index][side].bodyText, cases[index][1]);
    assert.ok(doc.entries[index][side].bodyWarnings.some((item) => item.code === "field-redaction-unsupported"));
    assert.ok(doc.capture.warnings.some((item) => item.entry === index + 1 && item.side === side && item.code === "field-redaction-unsupported"));
  }
  assert.deepEqual(doc.entries[6].response.body, { token: "[REDACTED]", ok: true });
  assert.equal(doc.entries[7].request.bodyText, "token=%5BREDACTED%5D&tag=1&tag=2");
  assert.equal(JSON.stringify(doc).includes("synthetic-"), false);
});

test("base64 uses strict decoding and cannot bypass JSON or form redaction", async () => {
  const h = createHarness();
  await begin(h);
  const cases = [
    { mime: "application/json", text: '{"token":"synthetic-secret","v":"中文"}', status: "captured" },
    { mime: "application/json", text: '{"token":"synthetic-broken"', status: "omitted" },
    { mime: "application/x-www-form-urlencoded", text: "token=synthetic-form&v=%FF", status: "omitted" },
    { mime: "application/json; charset=not-a-charset", text: '{"token":"synthetic-charset"}', status: "omitted" },
    { mime: "application/json", bytes: Buffer.from([0xff, 0x7b, 0x7d]), status: "omitted" },
    { mime: "text/html", text: "<b>中文</b>", status: "captured" }
  ];
  h.setCommandHook((target, method, params) => {
    if (method !== "Network.getResponseBody") return;
    const item = cases[Number(params.requestId)];
    return { body: (item.bytes || Buffer.from(item.text)).toString("base64"), base64Encoded: true };
  });
  for (const [index, item] of cases.entries()) { h.request(String(index)); await h.complete(String(index), { response: { mimeType: item.mime } }); }
  await h.command("save");
  const doc = await exported(h);
  for (const [index, item] of cases.entries()) {
    const part = doc.entries[index].response;
    assert.equal(part.bodyStatus, item.status);
    if (item.status === "omitted") {
      assert.equal(Object.hasOwn(part, "bodyText"), false);
      assert.equal(Object.hasOwn(part, "body"), false);
      assert.ok(part.bodyError.code);
      if (item.text) assert.equal(JSON.stringify(doc).includes(Buffer.from(item.text).toString("base64")), false);
    }
  }
  assert.deepEqual(doc.entries[0].response.body, { token: "[REDACTED]", v: "中文" });
  assert.equal(doc.entries[5].response.bodyText, cases[5].text);
  assert.equal(JSON.stringify(doc).includes("synthetic-"), false);
});

test("request bodies declared without initial text are fetched once without replaying business requests", async () => {
  const h = createHarness();
  await begin(h);
  h.setCommandHook((target, method, params) => {
    if (method === "Network.getRequestPostData") {
      if (params.requestId === "missing") throw new Error("synthetic missing");
      return { postData: params.requestId === "empty" ? "" : '{"token":"synthetic-secret","v":2}' };
    }
  });
  for (const id of ["fetched", "missing", "empty"]) {
    h.request(id, { method: "POST", request: { hasPostData: true, headers: { "Content-Type": "application/json" } } });
    await h.complete(id);
  }
  h.request("present-empty", { method: "POST", request: { postData: "" } });
  await h.complete("present-empty");
  await h.command("save");
  const rows = (await exported(h)).entries;
  assert.deepEqual(rows[0].request.body, { token: "[REDACTED]", v: 2 });
  assert.equal(rows[1].request.bodyStatus, "unavailable");
  assert.equal(rows[1].request.bodyError.code, "request-body-unavailable");
  for (const index of [2, 3]) assert.equal(rows[index].request.bodyStatus, "empty");
  assert.equal(h.operations.filter((item) => item.method === "Network.getRequestPostData").length, 3);
  assert.equal(h.operations.filter((item) => item.method === "Page.reload").length, 1);
});

test("late request-body callbacks cannot revive discarded or sealed supplemental records", async () => {
  for (const kind of ["end", "recover"]) {
    const h = createHarness();
    await begin(h);
    let resolve;
    h.setCommandHook((target, method) => {
      if (method === "Network.getRequestPostData") return new Promise((done) => { resolve = done; });
    });
    h.request("late", { method: "POST", request: { hasPostData: true, headers: { "Content-Type": "application/json" } } });
    await h.complete("late");
    if (kind === "recover") h.interrupt();
    await h.command(kind);
    const frozen = kind === "recover" ? await exported(h) : null;
    resolve({ postData: '{"late":"synthetic-late"}' });
    await h.flush();
    assert.equal((await h.command("status")).view.totalBodyBytes, 0);
    assert.equal((await h.command("status")).view.unsavedCount, 0);
    if (frozen) {
      assert.equal(frozen.entries[0].request.bodyStatus, "incomplete");
      assert.deepEqual(await exported(h), frozen);
    }
  }
});

test("a late response-body read cannot overwrite a network failure while request-body retrieval is pending", async () => {
  const h = createHarness();
  await begin(h);
  let requestBody;
  let responseBody;
  h.setCommandHook((target, method) => {
    if (method === "Network.getRequestPostData") return new Promise((resolve) => { requestBody = resolve; });
    if (method === "Network.getResponseBody") return new Promise((resolve) => { responseBody = resolve; });
  });
  h.request("failed-read", { method: "POST", request: { hasPostData: true } });
  await h.complete("failed-read");
  h.emit("Network.loadingFailed", { requestId: "failed-read", errorText: "net::ERR_SYNTHETIC" });
  responseBody({ body: '{"late":true}', base64Encoded: false });
  requestBody({ postData: "request text" });
  await h.flush();
  await h.command("save");
  const part = (await exported(h)).entries[0].response;
  assert.equal(part.status, 200);
  assert.equal(part.networkError, "net::ERR_SYNTHETIC");
  assert.equal(part.bodyStatus, "unavailable");
  assert.equal(part.bodyError.code, "network-failed");
  assert.equal(Object.hasOwn(part, "bodyText"), false);
});

test("multipart keeps repeated text and file descriptions while omitting binary and undecodable parts", async () => {
  const h = createHarness();
  await begin(h);
  const raw = '--xx\r\nContent-Disposition: form-data; name="tag"\r\n\r\none\r\n' +
    '--xx\r\nContent-Disposition: form-data; name="tag"\r\n\r\ntwo\r\n' +
    '--xx\r\nContent-Disposition: form-data; name="token"\r\n\r\nsynthetic-token\r\n' +
    '--xx\r\nContent-Disposition: form-data; name="file"; filename="report.txt"\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nFILEBYTES\r\n' +
    '--xx\r\nContent-Disposition: form-data; name="encoded"\r\nContent-Transfer-Encoding: base64\r\n\r\nZW5jb2RlZC1zZWNyZXQ=\r\n' +
    '--xx\r\nInvalid Header\r\n\r\nsynthetic-invalid-part\r\n--xx--\r\n';
  h.request("multipart", { method: "POST", request: { headers: { "Content-Type": "multipart/form-data; boundary=xx" }, postData: raw } });
  await h.complete("multipart");
  await h.command("save");
  const doc = await exported(h);
  const part = doc.entries[0].request;
  assert.equal(part.bodyStatus, "incomplete");
  assert.match(part.bodyText, /one\r\n[\s\S]*two\r\n/);
  assert.equal(part.bodyText.split('name="tag"').length, 3);
  assert.ok(part.bodyText.includes("[REDACTED]"));
  assert.ok(part.bodyText.includes("report.txt"));
  const file = part.bodyWarnings.find((item) => item.code === "multipart-file-omitted");
  assert.equal(file.fieldName, "file");
  assert.equal(file.filename, "report.txt");
  assert.equal(file.mimeType, "text/plain");
  assert.equal(file.size, "9");
  const encoded = JSON.stringify(doc);
  for (const secret of ["synthetic-token", "FILEBYTES", "ZW5jb2RlZC1zZWNyZXQ=", "synthetic-invalid-part"]) assert.equal(encoded.includes(secret), false, secret);
  for (const code of ["multipart-partial", "multipart-field-omitted", "multipart-part-omitted"]) assert.ok(doc.capture.warnings.some((item) => item.code === code));
});

test("ambiguous multipart field names are omitted without leaking the field value", async () => {
  const h = createHarness();
  await begin(h);
  const raw = '--xx\r\nContent-Disposition: form-data; name="safe"; name="token"\r\n\r\nsynthetic-ambiguous\r\n--xx--\r\n';
  h.request("multipart", { method: "POST", request: { headers: { "Content-Type": "multipart/form-data; boundary=xx" }, postData: raw } });
  await h.complete("multipart");
  await h.command("save");
  const doc = await exported(h);
  assert.equal(JSON.stringify(doc).includes("synthetic-ambiguous"), false);
  assert.ok(doc.entries[0].request.bodyWarnings.some((item) => item.code === "multipart-part-omitted"));
});

test("per-body limits apply to decoded UTF-8 and to redaction expansion, independently for each side", async () => {
  const h = createHarness();
  await begin(h);
  const limit = 2 * 1024 * 1024;
  const body = "x".repeat(limit);
  h.request("both", { method: "POST", request: { headers: { "Content-Type": "text/plain" }, postData: body } });
  h.bodies.set("root:both", body);
  await h.complete("both", { response: { mimeType: "text/plain" } });
  await response(h, "unicode", "中".repeat(Math.floor(limit / 3) + 1), "text/plain");
  h.request("expansion", { method: "POST", request: { headers: { "Content-Type": "application/x-www-form-urlencoded" },
    postData: "token=a&v=" + "x".repeat(limit - "token=a&v=".length) } });
  await h.complete("expansion");
  await h.command("save");
  const rows = (await exported(h)).entries;
  for (const side of ["request", "response"]) assert.equal(rows[0][side].bodyText.length, limit);
  assert.equal(rows[1].response.bodyError.code, "body-size-limit");
  assert.equal(rows[2].request.bodyError.code, "body-size-limit");
});

test("body text wins over duplicate reading views within the cumulative budget", async () => {
  const h = createHarness();
  await begin(h);
  const text = JSON.stringify({ value: "x".repeat(2 * 1024 * 1024 - 12) });
  for (let index = 0; index < 9; index++) await response(h, String(index), text);
  const retained = 9 * Buffer.byteLength(text);
  assert.equal((await h.command("status")).view.totalBodyBytes, retained);
  await h.command("save");
  const doc = await exported(h);
  assert.ok(doc.entries.every((entry) => entry.response.bodyText === text));
  const withView = doc.entries.filter((entry) => Object.hasOwn(entry.response, "body"));
  const viewBytes = withView.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.response.body)), 0);
  assert.ok(retained + viewBytes <= 24 * 1024 * 1024);
  assert.ok(withView.length < doc.entries.length);
  assert.ok(doc.capture.warnings.some((item) => item.code === "body-view-budget"));
});

test("frozen reading views never consume subsequent body capacity or change retry blobs", async () => {
  const h = createHarness({ autoComplete: false });
  await begin(h);
  for (const item of h.downloads) h.finishDownload(item.id);
  await h.flush();
  const text = JSON.stringify({ v: "x".repeat(2 * 1024 * 1024 - 8) });
  for (let index = 0; index < 6; index++) await response(h, "before-" + index, text);
  await h.command("save", { note: "冻结" });
  const original = await h.downloads[2].blob.text();
  h.finishDownload(3, "interrupted");
  h.finishDownload(4);
  await h.flush();
  for (let index = 0; index < 6; index++) await response(h, "after-" + index, text);
  assert.equal((await h.command("status")).view.totalBodyBytes, 24 * 1024 * 1024);
  await h.command("retry", { note: "不能改名" });
  assert.equal(h.downloads[4].filename, h.downloads[2].filename);
  assert.equal(await h.downloads[4].blob.text(), original);
  h.finishDownload(5);
  await h.flush();
  assert.equal((await h.command("status")).view.totalBodyBytes, 12 * 1024 * 1024);
  await h.command("save");
  assert.equal((await exported(h, 3)).entries.length, 6);
  assert.ok((await exported(h, 3)).entries.every((entry) => entry.response.bodyText === text));
});

test("coverage limits remain visible with zero exported entries and retain the observed boundary", async () => {
  const h = createHarness();
  await begin(h);
  h.request("metadata-limit", { request: { headers: { "X-Synthetic": "x".repeat(9 * 1024 * 1024) } } });
  assert.equal((await h.command("status")).view.phase, "interrupted");
  assert.equal((await h.command("status")).view.unsavedCount, 0);
  await h.command("recover");
  const doc = await exported(h);
  assert.deepEqual(doc.entries, []);
  assert.ok(doc.capture.warnings.some((item) => /8 MiB/.test(item.message) && !Number.isNaN(Date.parse(item.observedAt))));
});

test("snapshot names resolve case, cleaned names, default numbers and suffix cross-collisions", async () => {
  const h = createHarness();
  await begin(h, "003");
  const notes = ["Name", "", "name", "Name_2", "Name", "a/b", "a\\b"];
  for (const note of notes) await h.command("save", { note });
  const folders = [...new Set(h.downloads.map((item) => item.filename.split("/").slice(-2, -1)[0]))];
  assert.deepEqual(folders, ["003", "Name", "003_2", "name_2", "Name_2_2", "Name_3", "a_b", "a_b_2"]);
  for (const [index, note] of ["003", ...notes].entries()) assert.equal((await exported(h, index + 1)).capture.note, note);
});

test("snapshot names handle devices, empty fragments, long Unicode and the full relative path budget", async () => {
  const h = createHarness();
  h.tab.title = "标题".repeat(100);
  h.tab.url = "https://" + "a".repeat(60) + ".test/page";
  await begin(h, "CON.txt");
  for (const note of ["Lpt1", "..", "  ", "a<>:\"/\\|?* . ", "x".repeat(71) + "🌱", "x".repeat(71) + "🌱"]) await h.command("save", { note });
  const folders = [...new Set(h.downloads.map((item) => item.filename.split("/").slice(-2, -1)[0]))];
  assert.equal(folders[0], "_CON.txt");
  assert.equal(folders[1], "_Lpt1");
  assert.equal(folders[2], "003");
  assert.equal(folders[3], "004");
  for (const folder of folders) {
    assert.ok(folder.length <= 72);
    assert.doesNotMatch(folder, /[<>:"/\\|?*]|[. ]$|[\uD800-\uDBFF]$/);
  }
  assert.equal(new Set(folders.map((item) => item.toLowerCase())).size, folders.length);
  assert.ok(h.downloads.every((item) => item.filename.length <= 240));
});
