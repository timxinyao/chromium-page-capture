const CAPTURE_VERSION = "0.3.1";
const MAX_CAPTURE_MS = 20000;
const SETTLE_MS = 2600;
const SAVE_WAIT_MS = 5000;
const MAX_TEXT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BODY_BYTES = 24 * 1024 * 1024;
const MAX_RECORDS = 2000;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_KEYS = 10000;
const MAX_CHILD_SESSIONS = 128;
const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|passwd|session|csrf|api[_-]?key|signature)/i;
const QUERY_PART = /([?&])([^=&#\s]+)=([^&#\s]*)/g;

let session = null;
let hostId = null;
let batchSequence = 0;
const ownerToken = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
let ownerPort = null;
let pageClosing = false;
const handledCommands = new Map();
const node = (id) => document.getElementById(id);
const errorText = (error) => String(error && error.message ? error.message : error).slice(0, 2000);
const clone = (value) => JSON.parse(JSON.stringify(value));

function isCaptureRequestType(type) {
  return type === "Fetch" || type === "XHR";
}

function isExtensionUrl(value) {
  if (typeof value !== "string") return false;
  let url = value.trim();
  while (/^blob:/i.test(url)) url = url.slice(5);
  return /^(?:(?:chrome|edge|moz|safari-web)-extension|extension):/i.test(url);
}

function firstInitiatorStackUrl(stack) {
  const visited = new Set();
  while (stack && typeof stack === "object" && !visited.has(stack)) {
    visited.add(stack);
    const frames = Array.isArray(stack.callFrames) ? stack.callFrames : [];
    const frame = frames.find((item) => item && typeof item.url === "string" && item.url.trim());
    if (frame) return frame.url;
    stack = stack.parent;
  }
  return "";
}

function isExtensionRequest(params) {
  const request = params.request || {};
  const initiator = params.initiator || {};
  return isExtensionUrl(request.url) ||
    isExtensionUrl(params.documentURL) ||
    isExtensionUrl(initiator.url) ||
    isExtensionUrl(firstInitiatorStackUrl(initiator.stack));
}


function isSensitiveKey(name) {
  const value = String(name || "");
  if (SENSITIVE_KEY.test(value)) return true;
  // Match the browser's forgiving name decoding without splitting literal ampersands.
  const decoded = new URLSearchParams("name=" + value.replace(/&/g, "%26")).get("name");
  return SENSITIVE_KEY.test(decoded);
}

function redactQueryValuesInText(text) {
  return String(text).replace(QUERY_PART, (match, separator, key, value) => {
    return isSensitiveKey(key) ? separator + key + "=[REDACTED]" : match;
  });
}


function headersToHar(headers) {
  const out = [];
  if (!headers || typeof headers !== "object") return out;
  for (const [name, rawValue] of Object.entries(headers)) {
    const value = SENSITIVE_KEY.test(name)
      ? "[REDACTED]"
      : redactQueryValuesInText(rawValue);
    out.push({ name, value });
  }
  return out;
}

function safeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return redactQueryValuesInText(u.href);
  } catch (_) {
    return redactQueryValuesInText(rawUrl);
  }
}

function queryToHar(rawUrl) {
  try {
    return Array.from(new URL(rawUrl).searchParams.entries()).map(([name, value]) => ({
      name, value: isSensitiveKey(name) ? "[REDACTED]" : value
    }));
  } catch (_) { return []; }
}

function headerValue(headers, name) {
  const pair = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return pair ? String(pair[1]) : "";
}

function contentTypeFromHeaders(headers) {
  return headerValue(headers, "content-type");
}

function bodyFromText(text, contentType, options = {}) {
  return BodyExport.prepare(text, contentType, isSensitiveKey, { maxBytes: MAX_TEXT_BODY_BYTES, ...options });
}

function createEntry(params) {
  const request = params.request || {};
  const contentType = contentTypeFromHeaders(request.headers);
  const hasText = typeof request.postData === "string";
  const hasBody = hasText || request.hasPostData === true || Boolean(request.postDataEntries?.length);
  const requestBody = hasText ? bodyFromText(request.postData, contentType)
    : hasBody ? BodyExport.missing("incomplete", "request-body-pending", "浏览器声明存在请求正文，正在补取。")
      : { bodyStatus: "absent" };
  return {
    startedDateTime: params.wallTime ? new Date(params.wallTime * 1000).toISOString() : new Date().toISOString(),
    request: {
      method: request.method || "GET", url: safeUrl(request.url || ""), headers: headersToHar(request.headers),
      query: queryToHar(request.url || ""), mimeType: contentType.split(";")[0].trim(), ...requestBody
    },
    response: { status: 0, statusText: "", headers: [], mimeType: "", ...BodyExport.missing(
      "incomplete", "response-pending", "请求尚未完成，尚未取得完整响应正文。") },
    _requestId: params.requestId || "", _requestType: params.type || "",
    _requestContentType: contentType, _responseContentType: "", _needsRequestBody: hasBody && !hasText,
    _decodedDataLength: 0, _encodedBodyBytes: 0, _networkDone: false
  };
}

function applyResponse(entry, response = {}) {
  const headers = response.headers || {};
  entry._responseContentType = contentTypeFromHeaders(headers) || response.mimeType || "";
  entry.response = {
    status: Number(response.status) || 0, statusText: response.statusText || "", headers: headersToHar(headers),
    mimeType: response.mimeType || entry._responseContentType.split(";")[0].trim(),
    ...BodyExport.missing("incomplete", "response-pending", "响应尚未完成，尚未取得完整正文。")
  };
  const location = headerValue(headers, "location");
  if (location) entry.response.redirectURL = safeUrl(location);
}

function truncateSegment(value, length) {
  return value.slice(0, length).replace(/[\uD800-\uDBFF]$/, "").replace(/[. ]+$/g, "");
}

function safeSegment(value, fallback, length = 72) {
  let cleaned = String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  cleaned = truncateSegment(cleaned, length);
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(cleaned)) {
    cleaned = truncateSegment("_" + cleaned, length);
  }
  return cleaned || fallback;
}

function allocateSnapshotName(batch, note, sequence) {
  // Reserve the longest filename and the separators within a 240 UTF-16-unit relative path.
  const maximum = Math.min(72, 240 - batch.folder.length - "/screenshot-full.png".length - 1);
  const base = safeSegment(note, sequence, maximum);
  let candidate = base;
  let suffix = 2;
  while (batch.snapshotNames.has(candidate.toLowerCase())) {
    const ending = "_" + suffix++;
    candidate = safeSegment(base, sequence, maximum - ending.length) + ending;
  }
  batch.snapshotNames.add(candidate.toLowerCase());
  return candidate;
}

function makePageExport(targetSession, details = {}) {
  const entries = targetSession.entries.filter((entry) =>
    !isExcludedRequest(targetSession, entry._base || entry._requestId) && isCaptureRequestType(entry._requestType))
    .sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
  const warnings = targetSession.issues.map((message) => ({ code: "capture-incomplete", message, observedAt: targetSession.issueTimes.get(message) }));
  if (details.pendingCount) warnings.push({ code: "pending-requests", message: "本次等待截止时仍有请求尚未完成。", count: details.pendingCount });
  if (!details.hasScreenshot) warnings.push({ code: "screenshot-failed", message: "截图失败，快照仅包含接口数据。", detail: details.screenshotError });
  else if (targetSession.screenshotFallback) warnings.push({ code: "screenshot-viewport", message: "整页截图失败，画面回退为当前视口。" });
  let viewBudget = Math.max(0, MAX_TOTAL_BODY_BYTES - targetSession.totalBodyBytes);
  const records = entries.map((entry, index) => {
    const record = clone({ request: entry.request, response: entry.response });
    for (const side of ["request", "response"]) {
      const part = record[side];
      viewBudget -= BodyExport.addReadingView(part, viewBudget, isSensitiveKey);
      if (part.bodyError) warnings.push({ code: part.bodyError.code, message: part.bodyError.message, entry: index + 1, side });
      for (const item of part.bodyWarnings || []) warnings.push({ ...item, entry: index + 1, side });
    }
    return record;
  });
  return {
    formatVersion: 2,
    capture: {
      pageUrl: safeUrl(details.finalUrl || targetSession.pageUrl), pageTitle: details.pageTitle,
      capturedAt: details.capturedAt, note: targetSession.note,
      screenshot: { file: details.hasScreenshot ? "screenshot-full.png" : null,
        scope: !details.hasScreenshot ? "missing" : targetSession.screenshotFallback ? "viewport" : "full-page" },
      warnings
    },
    entries: records
  };
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const chunks = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const slice = binary.slice(offset, offset + chunkSize);
    const bytes = new Uint8Array(slice.length);
    for (let i = 0; i < slice.length; i++) bytes[i] = slice.charCodeAt(i);
    chunks.push(bytes);
  }
  return new Blob(chunks, { type });
}

// The page, rather than the popup or service worker, owns all live batch data.
// A record has a unique segment key. Only a completed immutable snapshot commits it.
function requestBase(source, requestId) {
  return JSON.stringify([source.tabId, source.sessionId || "", requestId]);
}

function isExcludedRequest(batch, base) {
  const visited = new Set();
  while (base && !visited.has(base)) {
    if (batch.excludedExtensionRequestIds.has(base)) return true;
    visited.add(base);
    base = batch.requestParents.get(base);
  }
  return false;
}

function addIssue(batch, reason) {
  reason = String(reason).slice(0, 2000);
  if (!batch.issues.includes(reason) && batch.issues.length < 20) {
    batch.issues.push(reason);
    batch.issueTimes.set(reason, new Date().toISOString());
  }
  batch.incomplete = true;
  batch.incompleteReason = batch.issues.join("；");
}

function withTimeout(task, ms, message) {
  let timer;
  return Promise.race([
    task,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

function cdp(target, method, params, ms = 5000) {
  if (pageClosing) return Promise.reject(new Error("记录状态页已关闭或正在重载"));
  return withTimeout(chrome.debugger.sendCommand(target, method, params), ms, method + " 超时");
}

function connectOwner() {
  if (ownerPort || pageClosing || hostId === null) return;
  try {
    const port = chrome.runtime.connect({ name: "page-capture-owner:" + JSON.stringify({ hostId, ownerToken }) });
    ownerPort = port;
    port.onDisconnect.addListener(() => {
      if (ownerPort !== port) return;
      ownerPort = null;
      // This reconnects only the ownership control channel, never the business-page debugger.
      if (!pageClosing) setTimeout(connectOwner, 100);
    });
  } catch (_) { if (!pageClosing) setTimeout(connectOwner, 1000); }
}

async function connectionCommand(batch, command) {
  connectOwner();
  const message = {
    channel: "page-capture-lease", command, hostId, ownerToken,
    batchId: batch.id, targetTabId: batch.tabId
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply;
    try { reply = await chrome.runtime.sendMessage(message); }
    catch (error) { if (attempt) throw error; continue; }
    if (!reply) { if (!attempt) continue; throw new Error("调试连接控制器未响应，请重新打开面板查看状态。"); }
    if (!reply.ok) throw new Error(reply.error || "调试连接操作失败");
    return;
  }
}

function getView() {
  const batch = session;
  if (!batch) return { phase: "idle", message: "开始本批后会自动刷新一次；请保持记录状态页打开。", hostId };
  return {
    phase: batch.phase, message: batch.message, hostId, batchId: batch.id, tabId: batch.tabId,
    pageTitle: batch.pageTitle, folder: batch.folder,
    savedCount: batch.savedCount, pendingCount: [...batch.records.values()].filter((entry) => !entry._done).length,
    unsavedCount: batch.records.size, totalBodyBytes: batch.totalBodyBytes,
    metadataBytes: batch.metadataBytes, requestKeyCount: batch.requestKeys.size,
    warning: [batch.incompleteReason, batch.missingScreenshots
      ? "本批有 " + batch.missingScreenshots + " 份接口已保存，截图失败（缺图快照）。" : ""].filter(Boolean).join("；"),
    frameCoverage: batch.frameCoverage,
    interrupted: batch.interrupted,
    files: batch.snapshot ? batch.snapshot.files.map((file) => ({ name: file.name, status: file.status, error: file.error || "" })) : [],
    lastSaved: batch.lastSaved || ""
  };
}

const PHASE_NAMES = {
  idle: "未开始", initial: "首次准备", recording: "记录中", saving: "保存中",
  retry: "等待重试", ending: "结束中", interrupted: "已中断", ended: "已结束"
};

function render() {
  const view = getView();
  document.body.dataset.phase = view.phase;
  node("title").textContent = PHASE_NAMES[view.phase];
  node("status").textContent = view.message;
  node("details").textContent = view.folder
    ? "页面：" + view.pageTitle + " · 已保存：" + view.savedCount + " 份 · 未留档记录：" + view.unsavedCount +
      " · 未完成：" + view.pendingCount + "\n" + view.folder +
      (view.files.length ? "\n" + view.files.map((file) => file.name + "：" +
        ({ complete: "完成", failed: "失败", pending: "待下载", downloading: "下载中" }[file.status] || file.status) +
        (file.error ? "（" + file.error + "）" : "")).join("；") : "")
    : "";
  node("warning").textContent = [view.warning, view.frameCoverage].filter(Boolean).join("\n");
  node("save").hidden = view.phase !== "recording";
  node("end").hidden = view.phase !== "recording";
  node("retry").hidden = view.phase !== "retry";
  node("recover").hidden = view.phase !== "interrupted";
  node("abandon").hidden = !["retry", "interrupted"].includes(view.phase);
  node("closeCapture").hidden = view.phase !== "ended" && view.phase !== "idle";
  node("returnPage").textContent = session && session.collecting ? "返回业务页面，保持记录" : "返回业务页面";
  node("note").disabled = !["recording", "interrupted", "idle", "ended"].includes(view.phase);
  document.body.classList.remove("done", "error");
  if (view.phase === "ended") document.body.classList.add("done");
  if (view.warning || ["retry", "interrupted"].includes(view.phase)) document.body.classList.add("error");
}

function update(batch, phase, message) {
  if (session !== batch) return;
  batch.phase = phase;
  batch.message = message;
  render();
}

function notifyRecords(batch) {
  for (const check of [...batch.waiters]) check();
  if (batch.phase === "initial") scheduleInitial(batch);
  render();
}

function removeRecord(batch, key) {
  const entry = batch.records.get(key);
  if (!entry) return;
  batch.totalBodyBytes = Math.max(0, batch.totalBodyBytes - (entry._bodyBytes || 0));
  batch.metadataBytes = Math.max(0, batch.metadataBytes - (entry._metadataBytes || 0));
  batch.records.delete(key);
  if (batch.current.get(entry._base) === key) batch.current.delete(entry._base);
  entry._discarded = true;
}

function excludeExtensionRequest(batch, base) {
  batch.excludedExtensionRequestIds.add(base);
  for (const [key, entry] of batch.records) {
    if (isExcludedRequest(batch, entry._base)) {
      batch.excludedExtensionRequestIds.add(entry._base);
      removeRecord(batch, key);
    }
  }
  notifyRecords(batch);
}

function metadataSize(entry) {
  const value = { ...entry, request: { ...entry.request }, response: { ...entry.response } };
  delete value.request.bodyText;
  delete value.response.bodyText;
  // Reserve later bounded status and diagnostic fields.
  return BodyExport.byteLength(JSON.stringify(value)) + 2048;
}

function refreshMetadata(batch, entry) {
  const next = metadataSize(entry);
  if (batch.metadataBytes - (entry._metadataBytes || 0) + next > MAX_METADATA_BYTES) {
    interruptBatch(batch, "未保存元数据达到 8 MiB 上限，已停止记录");
    return false;
  }
  batch.metadataBytes += next - (entry._metadataBytes || 0);
  entry._metadataBytes = next;
  return true;
}

function rememberRequestKey(batch, base) {
  if (batch.requestKeys.has(base)) return true;
  const bytes = new TextEncoder().encode(base).length;
  if (batch.requestKeys.size >= MAX_REQUEST_KEYS || batch.keyBytes + bytes > MAX_METADATA_BYTES / 2) {
    interruptBatch(batch, "批次请求标识达到缓存上限，已停止记录");
    return false;
  }
  batch.requestKeys.add(base);
  batch.keyBytes += bytes;
  return true;
}

function addRecord(batch, source, params, base) {
  if (batch.records.size >= MAX_RECORDS) {
    interruptBatch(batch, "未保存记录达到 2000 条上限，已停止记录");
    return null;
  }
  const entry = createEntry(params);
  entry._key = base + ":" + ++batch.recordSequence;
  entry._base = base;
  entry._source = { tabId: source.tabId, ...(source.sessionId ? { sessionId: source.sessionId } : {}) };
  entry._done = false;
  entry._bodyBytes = 0;
  entry._requestBodyBytes = 0;
  entry._responseBodyBytes = 0;
  const bytes = BodyExport.byteLength(entry.request.bodyText || "");
  if (batch.totalBodyBytes + bytes <= MAX_TOTAL_BODY_BYTES) entry._bodyBytes = entry._requestBodyBytes = bytes;
  else {
    for (const key of ["bodyText", "bodyWarnings", "bodyError"]) delete entry.request[key];
    Object.assign(entry.request, BodyExport.missing("omitted", "total-body-limit", "正文累计大小超过 24 MiB 保存上限。"));
  }
  if (!refreshMetadata(batch, entry)) return null;
  batch.totalBodyBytes += entry._bodyBytes;
  batch.records.set(entry._key, entry);
  batch.current.set(base, entry._key);
  if (entry._needsRequestBody) void readRequestBody(batch, entry);
  return entry;
}

function canUpdateBody(batch, entry) {
  return !entry._discarded && !entry._sealed && batch.records.has(entry._key) && !isExcludedRequest(batch, entry._base);
}

function replaceBody(batch, entry, side, body) {
  if (!canUpdateBody(batch, entry)) return;
  const countKey = side === "request" ? "_requestBodyBytes" : "_responseBodyBytes";
  const oldBytes = entry[countKey] || 0;
  let bytes = BodyExport.byteLength(body.bodyText || "");
  if (batch.totalBodyBytes - oldBytes + bytes > MAX_TOTAL_BODY_BYTES) {
    body = BodyExport.missing("omitted", "total-body-limit", "正文累计大小超过 24 MiB 保存上限。");
    bytes = 0;
  }
  const previous = entry[side];
  const part = { ...previous };
  for (const key of ["bodyText", "bodyWarnings", "bodyError", "body", "bodyRepresentation"]) delete part[key];
  entry[side] = { ...part, ...body };
  if (!refreshMetadata(batch, entry)) {
    entry[side] = { ...part, ...BodyExport.missing("omitted", "body-metadata-limit", "正文说明所需元数据触限，已省略正文并停止记录。") };
    entry[countKey] = 0;
    entry._bodyBytes -= oldBytes;
    batch.totalBodyBytes -= oldBytes;
    return;
  }
  entry[countKey] = bytes;
  entry._bodyBytes += bytes - oldBytes;
  batch.totalBodyBytes += bytes - oldBytes;
}

async function readRequestBody(batch, entry) {
  entry._readingRequestBody = true;
  try {
    const result = await cdp(entry._source, "Network.getRequestPostData", { requestId: entry._requestId });
    if (!result || typeof result.postData !== "string") throw new Error("body unavailable");
    replaceBody(batch, entry, "request", bodyFromText(result.postData, entry._requestContentType));
  } catch (_) {
    replaceBody(batch, entry, "request", BodyExport.missing("unavailable", "request-body-unavailable", "浏览器声明存在请求正文，但补取失败或未提供正文。"));
  } finally {
    if (canUpdateBody(batch, entry)) {
      entry._readingRequestBody = false;
      if (entry._networkDone) finishEntry(batch, entry);
      else notifyRecords(batch);
    }
  }
}

function finishEntry(batch, entry, timestamp, notify = true) {
  if (!canUpdateBody(batch, entry)) return;
  entry._networkDone = true;
  entry._readingBody = false;
  entry._done = !entry._readingRequestBody;
  if (entry._done && !isCaptureRequestType(entry._requestType)) removeRecord(batch, entry._key);
  if (notify) notifyRecords(batch);
}

async function completeEntry(batch, entry, params) {
  entry._readingBody = true;
  const mime = entry._responseContentType || entry.response.mimeType;
  if (!isCaptureRequestType(entry._requestType) || BodyExport.isBinaryMime(mime)) {
    replaceBody(batch, entry, "response", BodyExport.missing("omitted", "binary-body", "二进制或范围外的响应正文已省略。"));
  } else {
    try {
      const body = await cdp(entry._source, "Network.getResponseBody", { requestId: entry._requestId });
      if (!canUpdateBody(batch, entry) || entry._networkDone) return;
      if (!body || typeof body.body !== "string") throw new Error("body unavailable");
      replaceBody(batch, entry, "response", bodyFromText(body.body, mime, { base64Encoded: body.base64Encoded === true }));
    } catch (_) {
      if (!canUpdateBody(batch, entry) || entry._networkDone) return;
      replaceBody(batch, entry, "response", BodyExport.missing("unavailable", "response-body-unavailable", "浏览器未能提供响应正文。"));
    }
  }
  finishEntry(batch, entry, params.timestamp);
}

function applyBoundedResponse(batch, entry, response) {
  const oldResponse = entry.response;
  const oldContentType = entry._responseContentType;
  applyResponse(entry, response);
  if (!refreshMetadata(batch, entry)) {
    entry.response = oldResponse;
    entry._responseContentType = oldContentType;
    return false;
  }
  return true;
}

function onDebuggerEvent(source, method, params = {}) {
  const batch = session;
  if (!batch || !batch.attached || source.tabId !== batch.tabId || batch.phase === "ended" || batch.interrupted || batch.detaching) return;
  const sessionId = source.sessionId || "";
  if (sessionId && !batch.children.has(sessionId)) return;
  if (!sessionId && method === "Page.frameNavigated" && params.frame && !params.frame.parentId) {
    batch.rootFrameId = params.frame.id;
    batch.currentPage = { url: params.frame.url ? safeUrl(params.frame.url) : null, title: null };
    return;
  }
  if (!sessionId && method === "Page.navigatedWithinDocument" && params.frameId === batch.rootFrameId) {
    batch.currentPage = { url: params.url ? safeUrl(params.url) : null, title: null };
    return;
  }
  if (!sessionId && method === "Page.frameStartedLoading" && params.frameId === batch.rootFrameId) {
    batch.currentPage = { url: null, title: null };
    return;
  }
  if (batch.resultsFrozen && method.startsWith("Network.")) return;
  if (method === "Target.attachedToTarget") {
    if ((batch.collecting || batch.phase === "initial") && batch.flatSessions) {
      const task = attachChild(batch, source, params);
      batch.childTasks.add(task);
      task.then(() => batch.childTasks.delete(task), () => batch.childTasks.delete(task));
    }
    else if (params.waitingForDebugger) void cdp({ tabId: batch.tabId, sessionId: params.sessionId }, "Runtime.runIfWaitingForDebugger").catch(() => {});
    return;
  }
  if (method === "Target.detachedFromTarget") {
    detachChild(batch, params.sessionId);
    return;
  }
  if (method === "Page.loadEventFired" && !sessionId && batch.initialTimer) {
    batch.loadSeen = true;
    scheduleInitial(batch);
    return;
  }
  const base = params.requestId ? requestBase(source, params.requestId) : "";
  let entry = batch.records.get(batch.current.get(base));
  if (method === "Network.requestWillBeSent") {
    const redirect = entry && params.redirectResponse;
    // A redirect continues an already admitted request even after the ending cutoff.
    if (!batch.collecting && !(redirect && batch.operation && !batch.operation.frozen && batch.operation.keys.has(entry._key))) return;
    if (!rememberRequestKey(batch, base)) return;
    const parent = params.initiator && params.initiator.requestId;
    if (parent && parent !== params.requestId) {
      const parentBase = requestBase(source, parent);
      if (!rememberRequestKey(batch, parentBase)) return;
      batch.requestParents.set(base, parentBase);
    }
    if (isExtensionRequest(params) || isExcludedRequest(batch, base)) {
      excludeExtensionRequest(batch, base);
      return;
    }
    let admittedRedirect = false;
    if (redirect) {
      admittedRedirect = Boolean(batch.operation && !batch.operation.frozen && batch.operation.keys.has(entry._key));
      if (params.type) entry._requestType = params.type;
      if (!applyBoundedResponse(batch, entry, params.redirectResponse)) return;
      replaceBody(batch, entry, "response", BodyExport.missing("unavailable", "redirect-body-unavailable", "浏览器未提供重定向阶段的正文。"));
      finishEntry(batch, entry, params.timestamp, false);
    }
    entry = addRecord(batch, source, params, base);
    if (entry && admittedRedirect) batch.operation.keys.add(entry._key);
    notifyRecords(batch);
    return;
  }
  if (!entry || entry._done || entry._sealed || entry._networkDone || isExcludedRequest(batch, base)) return;
  if (method === "Network.responseReceived") {
    if (params.type) entry._requestType = params.type;
    if (!applyBoundedResponse(batch, entry, params.response)) return;
    if (/text\/event-stream/i.test(entry.response.mimeType)) {
      replaceBody(batch, entry, "response", BodyExport.missing("incomplete", "stream-not-captured", "流式消息正文未记录。"));
      finishEntry(batch, entry, params.timestamp);
    }
  } else if (method === "Network.dataReceived") {
    entry._decodedDataLength += Math.max(0, Number(params.dataLength) || 0);
    entry._encodedBodyBytes += Math.max(0, Number(params.encodedDataLength) || 0);
  } else if (method === "Network.loadingFinished" && !entry._readingBody) {
    void completeEntry(batch, entry, params);
  } else if (method === "Network.loadingFailed") {
    entry.response.networkError = String(params.errorText || "request failed").slice(0, 1000);
    replaceBody(batch, entry, "response", BodyExport.missing("unavailable", "network-failed", "请求失败，无法取得完整响应正文。"));
    finishEntry(batch, entry, params.timestamp);
  }
}

async function configureTarget(batch, target) {
  await cdp(target, "Network.enable", { maxTotalBufferSize: 33554432, maxResourceBufferSize: 4194304 });
  await cdp(target, "Page.enable");
  if (batch.flatSessions) {
    await cdp(target, "Target.setAutoAttach", {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }]
    });
  }
}

async function attachChild(batch, source, params) {
  if (!params.sessionId || batch.children.has(params.sessionId)) return;
  const target = { tabId: batch.tabId, sessionId: params.sessionId };
  const isFrame = params.targetInfo && params.targetInfo.type === "iframe";
  try {
    if (!isFrame) return;
    if (batch.children.size >= MAX_CHILD_SESSIONS) {
      interruptBatch(batch, "iframe 子会话达到 128 个上限，已停止记录");
      return;
    }
    batch.children.set(params.sessionId, { parent: source.sessionId || "" });
    if (batch.collecting) {
      addIssue(batch, "动态 iframe 从创建到网络监听就绪之间的请求可能缺失；未暂停业务脚本");
      render();
    }
    await configureTarget(batch, target);
  } catch (error) {
    addIssue(batch, "iframe 子页面监听失败：" + errorText(error));
    render();
  } finally {
    // Always release targets paused by auto-attach, including failed setup or ending.
    if (params.waitingForDebugger) {
      try { await cdp(target, "Runtime.runIfWaitingForDebugger"); }
      catch (error) { addIssue(batch, "iframe 子页面恢复失败：" + errorText(error)); render(); }
    }
  }
}

function detachChild(batch, sessionId) {
  if (!batch.children.has(sessionId)) return;
  const removed = new Set([sessionId]);
  for (let previous = -1; previous !== removed.size;) {
    previous = removed.size;
    for (const [id, child] of batch.children) if (removed.has(child.parent)) removed.add(id);
  }
  for (const id of removed) batch.children.delete(id);
  addIssue(batch, "iframe 子页面连接已断开，覆盖可能不完整");
  for (const entry of batch.records.values()) {
    if (removed.has(entry._source.sessionId) && !entry._done) {
      entry._sealed = true;
      entry._done = true;
      entry._unfinished = true;
      for (const side of ["request", "response"]) {
        if (entry[side].bodyStatus === "incomplete" && !entry[side].bodyText) {
          Object.assign(entry[side], BodyExport.missing("incomplete", "child-session-detached", "iframe 子页面连接断开，缺少完整返回。"));
        }
      }
    }
  }
  notifyRecords(batch);
}

function clearInitial(batch) {
  clearTimeout(batch.initialTimer);
  clearTimeout(batch.idleTimer);
}

function scheduleInitial(batch) {
  if (batch.phase !== "initial" || !batch.initialTimer) return;
  clearTimeout(batch.idleTimer);
  if (!batch.loadSeen || [...batch.records.values()].some((entry) => !entry._done)) return;
  batch.idleTimer = setTimeout(() => startSnapshot(batch, "initial", batch.firstNote), SETTLE_MS);
}

function interruptBatch(batch, reason) {
  if (session !== batch || batch.phase === "ended" || batch.interrupted) return;
  batch.interrupted = true;
  batch.collecting = false;
  clearInitial(batch);
  addIssue(batch, reason);
  if (!batch.operation && !batch.snapshot) update(batch, "interrupted", reason + "。可补导出已收到的数据，或明确放弃并结束。");
  else {
    batch.message = reason + "。当前快照保留；保存或重试后可补导出其余数据。";
    render();
  }
  for (const check of [...batch.waiters]) check();
  void stopDebugger(batch);
}

function stopDebugger(batch) {
  if (batch.detachTask) return batch.detachTask;
  if (!batch.leaseRequested) return Promise.resolve();
  batch.detaching = true;
  batch.attached = false;
  batch.detachTask = (async () => {
    // Do not open a new batch while an old detach can still complete against this tab.
    try { await connectionCommand(batch, "release"); batch.leaseRequested = false; }
    catch (error) { addIssue(batch, "断开调试连接返回异常：" + errorText(error)); }
    batch.detaching = false;
    batch.children.clear();
  })();
  return batch.detachTask;
}

async function beginBatch(batch) {
  try {
    const tab = await chrome.tabs.get(batch.tabId);
    if (!tab.url || !/^https?:/i.test(tab.url)) throw new Error("目标标签页不是普通 HTTP/HTTPS 网页");
    if (session !== batch || batch.interrupted) return;
    batch.pageTitle = tab.title || "";
    batch.pageUrl = tab.url;
    const stamp = batch.startedAt.replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
    batch.folder = "PageCapture/" + stamp + "_" + safeSegment(new URL(tab.url).hostname, "site", 48) + "_" + safeSegment(tab.title, "page", 48);
    batch.leaseRequested = true;
    await connectionCommand(batch, "acquire");
    batch.attached = true;
    if (batch.interrupted) { await stopDebugger(batch); return; }
    let major = 0;
    try {
      const version = await cdp(batch.target, "Browser.getVersion");
      major = Number((version.product || "").match(/(?:Chrome|Chromium|Edg)\/(\d+)/)?.[1]) || 0;
    } catch (_) {}
    if (!major) major = Number(navigator.userAgent.match(/(?:Chrome|Chromium|Edg)\/(\d+)/)?.[1]) || 0;
    batch.flatSessions = major >= 125;
    batch.frameCoverage = batch.flatSessions
      ? "已启用递归 iframe 子会话；动态子页面在网络监听就绪前可能缺少请求，不保证完整覆盖。"
      : "当前内核仅启用基础记录；跨进程 iframe 的接口覆盖无法保证（Chrome 125 以下或版本未确认）。";
    if (!batch.flatSessions) addIssue(batch, "旧内核跨进程 iframe 覆盖无法保证");
    try { await configureTarget(batch, batch.target); }
    catch (error) {
      // Unsupported child attachment must not turn a usable root recording into a silent success.
      if (!batch.flatSessions) throw error;
      addIssue(batch, "iframe 自动监听设置失败：" + errorText(error));
      batch.flatSessions = false;
      batch.frameCoverage = "基础记录已开启；iframe 子会话设置失败，覆盖无法保证。";
      await cdp(batch.target, "Network.enable");
      await cdp(batch.target, "Page.enable");
    }
    try {
      await withTimeout((async () => {
        while (batch.childTasks.size && !batch.interrupted) await Promise.allSettled([...batch.childTasks]);
      })(), 5000, "首次 iframe 监听设置超时");
    } catch (error) { addIssue(batch, errorText(error) + "，覆盖可能不完整"); }
    if (batch.interrupted || session !== batch) return;
    batch.collecting = true;
    batch.loadSeen = false;
    batch.initialTimer = setTimeout(() => {
      if (batch.phase !== "initial") return;
      if (!batch.loadSeen) addIssue(batch, "首次准备 20 秒内未收到页面 load 事件");
      startSnapshot(batch, "initial", batch.firstNote);
    }, MAX_CAPTURE_MS);
    update(batch, "initial", "已开启记录，正在自动刷新一次。页面加载后自动保存首份，随后持续记录。");
    await cdp(batch.target, "Page.reload", { ignoreCache: false });
  } catch (error) {
    interruptBatch(batch, "无法完成首次准备：" + errorText(error));
  }
}

function createBatch(tabId, note) {
  return {
    id: Date.now().toString(36) + "-" + ++batchSequence + "-" + Math.random().toString(36).slice(2),
    tabId, target: { tabId }, phase: "initial", message: "正在连接业务页面…",
    startedAt: new Date().toISOString(), pageTitle: "", pageUrl: "", folder: "", currentPage: { url: null, title: null },
    firstNote: note, collecting: false, attached: false, detaching: false,
    interrupted: false, issues: [], issueTimes: new Map(), incomplete: false, incompleteReason: "", frameCoverage: "正在检测",
    records: new Map(), current: new Map(), children: new Map(), requestKeys: new Set(), snapshotNames: new Set(),
    requestParents: new Map(), excludedExtensionRequestIds: new Set(),
    keyBytes: 0, metadataBytes: 0, totalBodyBytes: 0, recordSequence: 0,
    waiters: new Set(), childTasks: new Set(), loadSeen: false, savedCount: 0, missingScreenshots: 0, operation: null, snapshot: null
  };
}

function waitForCohort(batch, operation, maxMs) {
  return new Promise((resolve) => {
    let timer;
    let finished = false;
    const settle = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      batch.waiters.delete(check);
      resolve();
    };
    const check = () => {
      if (batch.interrupted || [...operation.keys].every((key) => !batch.records.has(key) || batch.records.get(key)._done)) settle();
    };
    batch.waiters.add(check);
    timer = setTimeout(settle, maxMs);
    check();
  });
}

function startSnapshot(batch, kind, note) {
  if (batch.operation || batch.snapshot) return;
  clearInitial(batch);
  if (kind === "recover") batch.collecting = false;
  const operation = { kind, ending: kind === "recover", keys: new Set(batch.records.keys()), note, frozen: false };
  batch.operation = operation;
  update(batch, operation.ending ? "ending" : "saving", operation.ending
    ? "已停止记录，正在补导出已收到的数据。"
    : "正在准备本次接口增量和画面；新请求留给下一份。记录状态页需保持打开。");
  void prepareSnapshot(batch, operation).catch((error) => {
    batch.operation = null;
    if (batch.interrupted) update(batch, "interrupted", "快照准备失败：" + errorText(error) + "。可重试补导出或明确放弃。");
    else interruptBatch(batch, "快照准备失败：" + errorText(error));
  });
}

async function captureScreenshot(batch) {
  if (!batch.attached) throw new Error("调试连接不可用，无法取得页面画面");
  let fullError;
  try {
    const metrics = await cdp(batch.target, "Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize;
    if (!size || !size.width || !size.height) throw new Error("页面尺寸不可用");
    const shot = await cdp(batch.target, "Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
    }, 10000);
    if (!shot || !shot.data) throw new Error("整页截图数据为空");
    return { data: shot.data, fallback: false };
  } catch (error) { fullError = errorText(error); }
  try {
    const shot = await cdp(batch.target, "Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: false
    }, 10000);
    if (!shot || !shot.data) throw new Error("视口截图数据为空");
    return { data: shot.data, fallback: true };
  } catch (error) { throw new Error("整页：" + fullError + "；视口：" + errorText(error)); }
}

async function readCurrentPage(batch) {
  const current = batch.attached ? { ...batch.currentPage } : { url: null, title: null };
  if (batch.attached) {
    try {
      const history = await cdp(batch.target, "Page.getNavigationHistory");
      const entry = history.entries && history.entries[history.currentIndex];
      if (entry && typeof entry.url === "string" && entry.url) {
        current.url = safeUrl(entry.url);
        current.title = typeof entry.title === "string" ? (entry.title || "(无标题)") : null;
      }
    } catch (_) {}
  }
  if (!current.url || current.title === null) {
    try {
      const tab = await chrome.tabs.get(batch.tabId);
      if (typeof tab.url === "string" && tab.url) {
        // Only pair a tab title with the same current URL, rather than a stale document.
        if (!current.url || current.url === safeUrl(tab.url)) {
          current.url = safeUrl(tab.url);
          if (typeof tab.title === "string") current.title = tab.title || "(无标题)";
        }
      }
    } catch (_) {}
  }
  if (!current.url || current.title === null) addIssue(batch, "当前页面地址或标题无法确认，导出中明确标记未知");
  batch.currentPage = current;
  return {
    finalUrl: current.url || "未知（浏览器未提供当前页面地址）",
    pageTitle: current.title ?? "未知（浏览器未提供当前页面标题）"
  };
}

async function prepareSnapshot(batch, operation) {
  if (operation.kind === "save") {
    await waitForCohort(batch, operation, SAVE_WAIT_MS);
  }
  // Pin eligibility at the deadline. A response arriving during screenshot capture goes into the next snapshot.
  operation.frozen = true;
  if (operation.ending) batch.resultsFrozen = true;
  const pendingKeys = [...operation.keys].filter((key) => batch.records.has(key) && !batch.records.get(key)._done);
  const keys = [...operation.keys].filter((key) => {
    const entry = batch.records.get(key);
    return entry && !isExcludedRequest(batch, entry._base) && (entry._done || operation.ending);
  });
  if (operation.ending && !keys.length && !batch.issues.length) {
    batch.operation = null;
    await finishBatch(batch, "本批已结束；没有剩余接口，不生成空末份。");
    return;
  }
  const entries = keys.map((key) => {
    const entry = clone(batch.records.get(key));
    if (!entry._done) {
      entry._unfinished = true;
      if (!entry._networkDone) {
        Object.assign(entry.response, BodyExport.missing("incomplete", "request-incomplete", "等待截止时请求尚未完成，缺少完整返回。"));
        delete entry.response.bodyText;
      }
      if (entry._readingRequestBody) Object.assign(entry.request,
        BodyExport.missing("incomplete", "request-body-incomplete", "等待截止时请求正文补取尚未完成。"));
    }
    return entry;
  });
  if (operation.ending) for (const key of keys) batch.records.get(key)._sealed = true;
  let screenshot;
  let screenshotError = "";
  try { screenshot = await captureScreenshot(batch); }
  catch (error) { screenshotError = errorText(error); }
  const page = await readCurrentPage(batch);
  const sequence = String(batch.savedCount + 1).padStart(3, "0");
  const exportSession = {
    ...batch, entries, note: operation.note, screenshotFallback: Boolean(screenshot && screenshot.fallback),
    incomplete: batch.incomplete || pendingKeys.length > 0,
    incompleteReason: [batch.incompleteReason, pendingKeys.length ? "本次等待截止时仍有请求尚未完成" : ""].filter(Boolean).join("；")
  };
  let exported = makePageExport(exportSession, {
    ...page,
    sequence, capturedAt: new Date().toISOString(), pendingCount: pendingKeys.length, hasScreenshot: Boolean(screenshot), screenshotError
  });
  const files = [
    { name: "page.json", blob: new Blob([JSON.stringify(exported, null, 2)], { type: "application/json;charset=utf-8" }) }
  ];
  if (screenshot) files.push({ name: "screenshot-full.png", blob: base64ToBlob(screenshot.data, "image/png") });
  batch.snapshot = {
    keys, sequence, folder: batch.folder + "/" + allocateSnapshotName(batch, operation.note, sequence), ending: operation.ending,
    count: exported.entries.length, missingScreenshot: !screenshot, fallback: Boolean(screenshot && screenshot.fallback),
    files: files.map((file) => ({ ...file, status: "pending", downloadId: null, objectUrl: null, error: "" }))
  };
  // Frozen blobs own the export now. Reading-view objects never reserve later body capacity.
  exported = null;
  batch.operation = null;
  await saveSnapshot(batch);
}

function waitForDownload(downloadId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error); else resolve();
    };
    const inspect = async () => {
      try {
        const items = await chrome.downloads.search({ id: downloadId });
        if (items[0]?.state === "complete") settle();
        else if (items[0]?.state === "interrupted") settle(new Error("下载中断：" + (items[0].error || "未知原因")));
      } catch (error) { settle(error); }
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") settle();
      if (delta.state?.current === "interrupted") settle(new Error("下载中断：" + (delta.error?.current || "浏览器或策略阻止")));
    };
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => settle(new Error("等待下载完成超时")), timeoutMs);
    void inspect();
  });
}

function releaseObjectUrl(file) {
  if (file.objectUrl) URL.revokeObjectURL(file.objectUrl);
  file.objectUrl = null;
}

async function saveFile(snapshot, file) {
  file.status = "downloading";
  file.error = "";
  try {
    if (file.downloadId !== null) {
      const previous = (await chrome.downloads.search({ id: file.downloadId }))[0];
      if (previous?.state === "complete") {
        file.status = "complete";
        releaseObjectUrl(file);
        return;
      }
      // A timed-out download can still complete. Wait on that ID rather than create a duplicate.
      if (previous && previous.state !== "interrupted") {
        await waitForDownload(file.downloadId);
        file.status = "complete";
        releaseObjectUrl(file);
        return;
      }
      releaseObjectUrl(file);
      file.downloadId = null;
    }
    file.objectUrl = URL.createObjectURL(file.blob);
    file.downloadId = await chrome.downloads.download({
      url: file.objectUrl, filename: snapshot.folder + "/" + file.name, saveAs: false, conflictAction: "uniquify"
    });
    await waitForDownload(file.downloadId);
    file.status = "complete";
    releaseObjectUrl(file);
  } catch (error) {
    file.status = "failed";
    file.error = errorText(error);
    if (file.downloadId !== null) {
      try {
        const item = (await chrome.downloads.search({ id: file.downloadId }))[0];
        if (item?.state === "complete") { file.status = "complete"; file.error = ""; releaseObjectUrl(file); }
        else if (!item || item.state === "interrupted") releaseObjectUrl(file);
      } catch (_) {}
    } else releaseObjectUrl(file);
  }
}

async function saveSnapshot(batch) {
  const snapshot = batch.snapshot;
  if (!snapshot || snapshot.running) return;
  snapshot.running = true;
  update(batch, "saving", "快照 " + snapshot.sequence + " 已冻结，正在等待浏览器确认文件下载完成。");
  await Promise.all(snapshot.files.filter((file) => file.status !== "complete").map((file) => saveFile(snapshot, file)));
  snapshot.running = false;
  if (snapshot.files.some((file) => file.status !== "complete")) {
    const recordingState = snapshot.ending
      ? " 已截止新请求，仅重试原末份；重试不会重新开始记录。"
      : batch.interrupted ? " 记录已中断。" : batch.collecting ? " 记录继续进行。" : " 记录已停止。";
    update(batch, "retry", "部分文件未保存。原快照和目录已保留，请重试失败文件或明确放弃未保存数据并结束。" +
      recordingState);
    return;
  }
  // No URL/time watermark: only these record identities are committed after every required file completes.
  for (const key of snapshot.keys) removeRecord(batch, key);
  batch.savedCount++;
  if (snapshot.missingScreenshot) batch.missingScreenshots++;
  batch.lastSaved = "快照 " + snapshot.sequence + "：" + (snapshot.missingScreenshot
    ? "接口已保存，截图失败" : snapshot.fallback ? "已保存，截图回退为当前视口" : "已保存");
  batch.snapshot = null;
  if (snapshot.ending) {
    update(batch, "ending", batch.lastSaved + "。正在释放本批连接。");
    await finishBatch(batch, batch.lastSaved + "。本批已结束。" + (batch.incomplete ? " 网络记录不完整，详见说明。" : ""));
  } else if (batch.interrupted) {
    update(batch, "interrupted", batch.lastSaved + "。记录已中断，可补导出其余已收数据或明确放弃并结束。");
  } else {
    update(batch, "recording", batch.lastSaved + "。继续操作业务页，下一次保存不会刷新页面。" +
      (batch.incomplete ? " 网络记录不完整，详见下方提示。" : ""));
  }
}

async function finishBatch(batch, message) {
  batch.collecting = false;
  clearInitial(batch);
  // An interrupted attach can complete after the user requests supplemental export.
  // Wait for its cleanup before allowing a new batch to attach to the same tab.
  if (batch.startTask) await batch.startTask;
  await stopDebugger(batch);
  update(batch, "ended", message);
}

function executeCommand(message) {
  const command = message.command;
  if (command === "status") return { ok: true, view: getView() };
  if (message.commandId && handledCommands.has(message.commandId)) return { ok: true, duplicate: true, view: getView() };
  const note = String(message.note || "").slice(0, 4000);
  const batch = session;
  let error = "";
  if (command === "start") {
    if (batch && batch.phase !== "ended") error = "已有活动批次，请先结束或明确放弃。";
    else if (typeof message.tabId !== "number" || message.tabId === hostId) error = "请先切换到普通业务网页，再开始本批。";
    else {
      session = createBatch(message.tabId, note);
      render();
      session.startTask = beginBatch(session);
    }
  } else if (!batch) error = "没有活动批次。";
  else if (message.batchId !== batch.id) error = "批次已变化，请重新打开面板确认当前批次。";
  else if (command === "save" && batch.phase === "recording") startSnapshot(batch, "save", note);
  else if (command === "end" && batch.phase === "recording") {
    batch.collecting = false;
    batch.resultsFrozen = true;
    clearInitial(batch);
    for (const key of batch.records.keys()) removeRecord(batch, key);
    // Publish the cutoff before asynchronous lease release, blocking duplicate commands.
    update(batch, "ending", "正在结束本批；未保存数据已丢弃，已下载文件保留。");
    void finishBatch(batch, "本批已结束；未保存数据已丢弃，已下载文件保留。");
  }
  else if (command === "recover" && batch.phase === "interrupted") startSnapshot(batch, "recover", note);
  else if (command === "retry" && batch.phase === "retry") void saveSnapshot(batch);
  else if (command === "abandon" && ["retry", "interrupted"].includes(batch.phase) && message.confirmed === true) {
    batch.collecting = false;
    for (const key of batch.records.keys()) removeRecord(batch, key);
    if (batch.snapshot) for (const file of batch.snapshot.files) releaseObjectUrl(file);
    batch.snapshot = null;
    // Change the state synchronously, so a repeated abandon cannot schedule a second transition.
    update(batch, "ending", "正在放弃未成功留档的数据并结束；已下载文件保留。");
    void finishBatch(batch, "本批已明确放弃未保存数据并结束；已经下载的文件保留。");
  } else error = "当前状态不能执行此操作，请等待当前保存完成或处理失败快照。";
  if (!error && message.commandId) {
    handledCommands.set(message.commandId, true);
    if (handledCommands.size > 128) handledCommands.delete(handledCommands.keys().next().value);
  }
  return { ok: !error, error, view: getView() };
}

async function closeCaptureAndReturn() {
  if (session && session.phase !== "ended") return;
  node("closeCapture").disabled = true;
  try {
    const current = await chrome.tabs.getCurrent();
    if (session) {
      try {
        const original = await chrome.tabs.get(session.tabId);
        await chrome.tabs.update(original.id, { active: true });
        if (chrome.windows && typeof original.windowId === "number") await chrome.windows.update(original.windowId, { focused: true });
      } catch (_) {}
    }
    if (current && typeof current.id === "number") await chrome.tabs.remove(current.id);
    else window.close();
  } catch (error) {
    node("status").textContent = "无法关闭采集页面：" + errorText(error);
    node("closeCapture").disabled = false;
  }
}

chrome.debugger.onEvent.addListener(onDebuggerEvent);
chrome.debugger.onDetach.addListener((source, reason) => {
  if (session && session.attached && source.tabId === session.tabId && !session.detaching && session.phase !== "ended") {
    session.attached = false;
    interruptBatch(session, reason === "target_closed" ? "业务页面已关闭，记录已停止" : "调试连接已断开（" + reason + "），记录已停止");
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session && session.tabId === tabId) interruptBatch(session, "业务页面已关闭，记录已停止");
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message.hostId !== hostId) return;
  if (message.channel === "page-capture-owner-probe") {
    sendResponse({
      alive: Boolean(!pageClosing && message.ownerToken === ownerToken && session && session.id === message.batchId && session.phase !== "ended"),
      ownerToken, batchId: session && session.id
    });
    return;
  }
  if (message.channel !== "page-capture-host") return;
  sendResponse(executeCommand(message));
});
for (const command of ["save", "end", "retry", "recover"]) {
  node(command).addEventListener("click", () => {
    const result = executeCommand({ command, batchId: session && session.id, note: node("note").value });
    if (!result.ok) node("status").textContent = result.error;
    else if (command !== "retry") node("note").value = "";
  });
}
node("abandon").addEventListener("click", () => { node("abandonConfirmation").hidden = false; });
node("cancelAbandon").addEventListener("click", () => { node("abandonConfirmation").hidden = true; });
node("confirmAbandon").addEventListener("click", () => {
  node("abandonConfirmation").hidden = true;
  executeCommand({ command: "abandon", batchId: session && session.id, confirmed: true });
});
node("returnPage").addEventListener("click", async () => {
  if (!session) return;
  try {
    const tab = await chrome.tabs.get(session.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    if (chrome.windows && typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) { node("status").textContent = "原业务页面已经关闭。"; }
});
node("closeCapture").addEventListener("click", closeCaptureAndReturn);
window.addEventListener("pagehide", () => { pageClosing = true; });
void chrome.tabs.getCurrent().then((tab) => { hostId = tab.id; connectOwner(); render(); });
