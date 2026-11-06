const titleNode = document.getElementById("title");
const statusNode = document.getElementById("status");
const detailsNode = document.getElementById("details");
const closeCaptureButton = document.getElementById("closeCapture");
const CAPTURE_VERSION = "0.1.4";

const MAX_CAPTURE_MS = 20000;
const SETTLE_MS = 2600;
const MAX_TEXT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BODY_BYTES = 24 * 1024 * 1024;
const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|passwd|session|csrf|api[_-]?key|signature)/i;
const QUERY_PART = /([?&])([^=&#\s]+)=([^&#\s]*)/g;

let session = null;

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

function isExcludedRequest(targetSession, requestId) {
  const visited = new Set();
  while (requestId && !visited.has(requestId)) {
    if (targetSession.excludedExtensionRequestIds.has(requestId)) return true;
    visited.add(requestId);
    requestId = targetSession.requestParents.get(requestId);
  }
  return false;
}

function excludeExtensionRequest(targetSession, requestId) {
  targetSession.excludedExtensionRequestIds.add(requestId);
  for (const pendingId of targetSession.pending.keys()) {
    if (isExcludedRequest(targetSession, pendingId)) {
      targetSession.excludedExtensionRequestIds.add(pendingId);
      targetSession.pending.delete(pendingId);
    }
  }
  if (targetSession.loadSeen && !targetSession.pending.size && !targetSession.inflight.size) {
    scheduleFinish(targetSession, SETTLE_MS);
  }
}

function isSensitiveKey(name) {
  const value = String(name || "").replace(/\+/g, " ");
  if (SENSITIVE_KEY.test(value)) return true;
  try {
    return SENSITIVE_KEY.test(decodeURIComponent(value));
  } catch (_) {
    return false;
  }
}

function redactQueryValuesInText(text) {
  return String(text).replace(QUERY_PART, (match, separator, key, value) => {
    return isSensitiveKey(key) ? separator + key + "=[REDACTED]" : match;
  });
}

function setStatus(title, message, kind) {
  titleNode.textContent = title;
  statusNode.textContent = message;
  document.body.classList.remove("done", "error");
  if (kind) document.body.classList.add(kind);
  closeCaptureButton.hidden = kind !== "done" && kind !== "error";
}

async function closeCaptureAndReturn() {
  if (closeCaptureButton.hidden) return;
  closeCaptureButton.disabled = true;
  try {
    const currentTab = await chrome.tabs.getCurrent();
    if (session && typeof session.tabId === "number" &&
        (!currentTab || currentTab.id !== session.tabId)) {
      try {
        const originalTab = await chrome.tabs.get(session.tabId);
        await chrome.tabs.update(originalTab.id, { active: true });
        if (chrome.windows && typeof originalTab.windowId === "number") {
          try { await chrome.windows.update(originalTab.windowId, { focused: true }); } catch (_) {}
        }
      } catch (_) {}
    }
    if (currentTab && typeof currentTab.id === "number") {
      await chrome.tabs.remove(currentTab.id);
    } else {
      window.close();
    }
  } catch (error) {
    statusNode.textContent = "无法关闭采集页面：" +
      (error && error.message ? error.message : String(error));
    closeCaptureButton.disabled = false;
  }
}

closeCaptureButton.addEventListener("click", closeCaptureAndReturn);

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
    for (const key of Array.from(u.searchParams.keys())) {
      if (isSensitiveKey(key)) u.searchParams.set(key, "[REDACTED]");
    }
    return u.href;
  } catch (_) {
    return rawUrl;
  }
}

function redactJsonValue(value) {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? "[REDACTED]" : redactJsonValue(child);
    }
    return out;
  }
  return value;
}

function sanitizeBody(text, mimeType) {
  if (typeof text !== "string") return text;
  if (/json/i.test(mimeType || "")) {
    try {
      return JSON.stringify(redactJsonValue(JSON.parse(text)));
    } catch (_) {}
  }
  if (/application\/x-www-form-urlencoded/i.test(mimeType || "")) {
    try {
      const params = new URLSearchParams(text);
      for (const key of Array.from(params.keys())) {
        if (isSensitiveKey(key)) params.set(key, "[REDACTED]");
      }
      return params.toString();
    } catch (_) {}
  }
  return text;
}

function queryToHar(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return Array.from(u.searchParams.entries()).map(([name, value]) => ({
      name,
      value: isSensitiveKey(name) ? "[REDACTED]" : value
    }));
  } catch (_) {
    return [];
  }
}

function contentTypeFromHeaders(headers) {
  if (!headers || typeof headers !== "object") return "";
  const pair = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type");
  return pair ? String(pair[1]).split(";")[0] : "";
}

function isTextApiMime(mimeType) {
  return /(json|xml|text\/plain|graphql|x-www-form-urlencoded)/i.test(mimeType || "");
}

function createEntry(params) {
  const request = params.request || {};
  const url = safeUrl(request.url || "");
  const started = params.wallTime
    ? new Date(params.wallTime * 1000).toISOString()
    : new Date().toISOString();
  const headers = headersToHar(request.headers);
  const mimeType = contentTypeFromHeaders(request.headers);
  let postData;
  let postDataOmittedReason = "";
  if (typeof request.postData === "string" && request.postData.length) {
    if (/multipart\/form-data/i.test(mimeType)) {
      postDataOmittedReason = "multipart/form-data body omitted for privacy";
    } else if (/json|application\/x-www-form-urlencoded/i.test(mimeType)) {
      const clean = sanitizeBody(request.postData, mimeType);
      postData = {
        mimeType: mimeType || "text/plain",
        text: clean,
        params: []
      };
    } else {
      postDataOmittedReason = "opaque request body omitted";
    }
  }
  const entry = {
    startedDateTime: started,
    time: 0,
    request: {
      method: request.method || "GET",
      url,
      httpVersion: "unknown",
      cookies: [],
      headers,
      queryString: queryToHar(request.url || ""),
      headersSize: -1,
      bodySize: typeof request.postData === "string" && !postDataOmittedReason
        ? new TextEncoder().encode(request.postData).length
        : -1,
      ...(postData ? { postData } : {})
    },
    response: {
      status: 0,
      statusText: "",
      httpVersion: "",
      cookies: [],
      headers: [],
      content: {
        size: 0,
        mimeType: "x-unknown"
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      send: -1,
      wait: -1,
      receive: -1,
      ssl: -1
    },
    _requestId: params.requestId || "",
    _requestType: params.type || "",
    _bodyOmitted: "",
    _requestTimestamp: Number(params.timestamp) || 0,
    _responseTiming: null,
    _decodedDataLength: 0,
    _encodedBodyBytes: 0,
    _totalEncodedTransferSize: -1
  };
  if (postDataOmittedReason) entry.request._postDataOmittedReason = postDataOmittedReason;
  return entry;
}

function normalizeProtocol(protocol) {
  const value = String(protocol || "").toLowerCase();
  if (value === "h2") return "HTTP/2";
  if (value === "h3") return "HTTP/3";
  if (value.startsWith("http/")) return value.toUpperCase();
  return value ? value.toUpperCase() : "unknown";
}

function applyResponse(entry, response) {
  const headers = response && response.headers ? response.headers : {};
  const mimeType = response && response.mimeType ? response.mimeType : contentTypeFromHeaders(headers);
  const protocol = normalizeProtocol(response && response.protocol);
  entry._responseTiming = response && response.timing ? response.timing : null;
  entry.request.httpVersion = protocol;
  entry.response = {
    status: Number(response && response.status) || 0,
    statusText: response && response.statusText ? response.statusText : "",
    httpVersion: protocol,
    cookies: [],
    headers: headersToHar(headers),
    content: {
      size: entry._decodedDataLength || 0,
      mimeType: mimeType || "x-unknown"
    },
    redirectURL: headers.location ? safeUrl(headers.location) : "",
    headersSize: -1,
    bodySize: -1
  };
}

function responseBodyTransferSize(entry) {
  if (String(entry.request.method).toUpperCase() === "HEAD") return 0;
  if (entry._encodedBodyBytes > 0) return entry._encodedBodyBytes;
  const status = Number(entry.response.status) || 0;
  if (status === 204 || status === 304 || (status >= 100 && status < 200)) return 0;
  const contentLength = entry.response.headers.find(
    (header) => header.name.toLowerCase() === "content-length"
  );
  if (contentLength && /^\d+$/.test(contentLength.value)) return Number(contentLength.value);
  return -1;
}

function applyFinalTiming(entry, finishTimestamp) {
  const timing = entry._responseTiming;
  const requestTime = timing && Number.isFinite(timing.requestTime)
    ? timing.requestTime
    : entry._requestTimestamp;
  const total = finishTimestamp > 0 && requestTime > 0
    ? Math.max(0, (finishTimestamp - requestTime) * 1000)
    : -1;
  const delta = (end, start) => Number.isFinite(end) && Number.isFinite(start) &&
      end >= 0 && start >= 0 && end >= start
    ? Math.max(0, end - start)
    : -1;
  let dns = timing ? delta(timing.dnsEnd, timing.dnsStart) : -1;
  let ssl = timing ? delta(timing.sslEnd, timing.sslStart) : -1;
  let connect = timing ? delta(timing.connectEnd, timing.connectStart) : -1;
  const send = timing ? delta(timing.sendEnd, timing.sendStart) : -1;
  let wait = timing ? delta(timing.receiveHeadersEnd, timing.sendEnd) : -1;
  let receive = timing && total >= 0 && Number.isFinite(timing.receiveHeadersEnd) &&
      timing.receiveHeadersEnd >= 0
    ? Math.max(0, total - timing.receiveHeadersEnd)
    : -1;
  const roundPhase = (value) => value >= 0 ? Math.round(value) : -1;
  let dnsMs = roundPhase(dns);
  let connectMs = roundPhase(connect);
  const sslMs = roundPhase(ssl);
  let sendMs = roundPhase(send);
  let waitMs = roundPhase(wait);
  let receiveMs = roundPhase(receive);
  const totalMs = total >= 0 ? Math.round(total) : -1;
  const sumKnown = () => [dnsMs, connectMs, sendMs, waitMs, receiveMs]
    .filter((value) => value >= 0)
    .reduce((sum, value) => sum + value, 0);

  if (totalMs >= 0) {
    if (sumKnown() > totalMs) {
      dnsMs = -1;
      connectMs = -1;
    }
    if (sumKnown() > totalMs) {
      let excess = sumKnown() - totalMs;
      for (const key of ["receive", "wait", "send"]) {
        const value = key === "receive" ? receiveMs : key === "wait" ? waitMs : sendMs;
        if (value < 0 || excess <= 0) continue;
        const reduction = Math.min(value, excess);
        if (key === "receive") receiveMs -= reduction;
        if (key === "wait") waitMs -= reduction;
        if (key === "send") sendMs -= reduction;
        excess -= reduction;
      }
    }
  }

  const knownPhases = [dnsMs, connectMs, sendMs, waitMs, receiveMs]
    .filter((value) => value >= 0)
    .reduce((sum, value) => sum + value, 0);
  const blockedMs = totalMs >= 0 ? Math.max(0, totalMs - knownPhases) : -1;
  entry.time = totalMs >= 0 ? totalMs : 0;
  entry.timings = {
    blocked: blockedMs,
    dns: dnsMs,
    connect: connectMs,
    send: sendMs,
    wait: waitMs,
    receive: receiveMs,
    ssl: sslMs
  };
}

function decodedBodyBytes(text, base64Encoded) {
  if (typeof text !== "string") return 0;
  if (base64Encoded) {
    try { return atob(text).length; } catch (_) { return 0; }
  }
  return new TextEncoder().encode(text).length;
}

function scheduleFinish(targetSession, delay) {
  if (!targetSession || targetSession.finishing || targetSession.finished) return;
  clearTimeout(targetSession.finishTimer);
  targetSession.finishTimer = setTimeout(() => {
    if (targetSession.pending.size || targetSession.inflight.size) return;
    void finishCapture(targetSession, false);
  }, delay);
}

async function completeRequest(targetSession, requestId, finishTimestamp, encodedTransferSize) {
  const entry = targetSession.pending.get(requestId);
  if (!entry) return;
  targetSession.pending.delete(requestId);

  const response = entry.response;
  const mimeType = response && response.content ? response.content.mimeType : "";
  if (response) {
    if (Number.isFinite(encodedTransferSize)) entry._totalEncodedTransferSize = Math.max(0, encodedTransferSize);
    response.content.size = Math.max(0, entry._decodedDataLength);
    response.bodySize = responseBodyTransferSize(entry);
  }
  if (response && isCaptureRequestType(entry._requestType) && isTextApiMime(mimeType) &&
      entry._decodedDataLength <= MAX_TEXT_BODY_BYTES &&
      targetSession.totalBodyBytes < MAX_TOTAL_BODY_BYTES) {
    try {
      let timeoutId;
      const bodyResult = await Promise.race([
        chrome.debugger.sendCommand(targetSession.target, "Network.getResponseBody", { requestId }),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("response body timeout")), 5000);
        })
      ]).finally(() => clearTimeout(timeoutId));
      if (isExcludedRequest(targetSession, requestId)) return;
      if (bodyResult && typeof bodyResult.body === "string") {
        const originalBytes = decodedBodyBytes(bodyResult.body, bodyResult.base64Encoded);
        const clean = bodyResult.base64Encoded
          ? bodyResult.body
          : sanitizeBody(bodyResult.body, mimeType);
        if (originalBytes > MAX_TEXT_BODY_BYTES) {
          entry._bodyOmitted = "response body size limit reached";
        } else if (targetSession.totalBodyBytes + originalBytes <= MAX_TOTAL_BODY_BYTES) {
          response.content.text = clean;
          if (bodyResult.base64Encoded) response.content.encoding = "base64";
          response.content.size = originalBytes;
          targetSession.totalBodyBytes += originalBytes;
        } else {
          entry._bodyOmitted = "total text body limit reached";
        }
      }
    } catch (_) {
      entry._bodyOmitted = "response body unavailable";
    }
  } else if (response) {
    entry._bodyOmitted = !isCaptureRequestType(entry._requestType)
      ? "resource type not exported"
      : isTextApiMime(mimeType)
      ? "response body size limit reached"
      : "non-API or binary response body omitted";
  }

  if (isExcludedRequest(targetSession, requestId)) return;
  applyFinalTiming(entry, finishTimestamp);
  targetSession.entries.push(entry);
  if (targetSession.loadSeen && !targetSession.finishing &&
      !targetSession.pending.size && !targetSession.inflight.size) {
    scheduleFinish(targetSession, SETTLE_MS);
  }
}

function queueCompleteRequest(targetSession, requestId, finishTimestamp, encodedTransferSize) {
  if (targetSession.inflight.has(requestId)) return;
  const task = completeRequest(targetSession, requestId, finishTimestamp, encodedTransferSize);
  targetSession.inflight.set(requestId, task);
  task.then(
    () => {
      if (targetSession.inflight.get(requestId) === task) targetSession.inflight.delete(requestId);
      if (targetSession.loadSeen && !targetSession.finishing &&
          !targetSession.pending.size && !targetSession.inflight.size) {
        scheduleFinish(targetSession, SETTLE_MS);
      }
    },
    () => {
      if (targetSession.inflight.get(requestId) === task) targetSession.inflight.delete(requestId);
      if (targetSession.loadSeen && !targetSession.finishing &&
          !targetSession.pending.size && !targetSession.inflight.size) {
        scheduleFinish(targetSession, SETTLE_MS);
      }
    }
  );
}

function finishStreamingRequest(targetSession, requestId, response, timestamp) {
  const entry = targetSession.pending.get(requestId);
  if (!entry) return;
  if (response) applyResponse(entry, response);
  entry._bodyOmitted = "stream frames are not captured";
  entry.response.content.size = Math.max(0, entry._decodedDataLength);
  entry.response.bodySize = responseBodyTransferSize(entry);
  targetSession.pending.delete(requestId);
  applyFinalTiming(entry, timestamp);
  targetSession.entries.push(entry);
  if (targetSession.loadSeen && !targetSession.finishing &&
      !targetSession.pending.size && !targetSession.inflight.size) {
    scheduleFinish(targetSession, SETTLE_MS);
  }
}

function onDebuggerEvent(source, method, params) {
  if (!session || source.tabId !== session.tabId || session.finishing || session.finished) return;

  if (method === "Page.loadEventFired") {
    session.loadSeen = true;
    setStatus("页面已加载", "正在等待页面上的短时接口请求结束…");
    scheduleFinish(session, SETTLE_MS);
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const parentRequestId = params.initiator && params.initiator.requestId;
    if (parentRequestId && parentRequestId !== params.requestId) {
      session.requestParents.set(params.requestId, parentRequestId);
    }
    if (isExtensionRequest(params) || isExcludedRequest(session, params.requestId)) {
      excludeExtensionRequest(session, params.requestId);
      return;
    }
    const old = session.pending.get(params.requestId);
    if (old && params.redirectResponse) {
      if (params.type) old._requestType = params.type;
      applyResponse(old, params.redirectResponse);
      old._totalEncodedTransferSize = Number(params.redirectResponse.encodedDataLength) || -1;
      old.response.bodySize = responseBodyTransferSize(old);
      session.pending.delete(params.requestId);
      applyFinalTiming(old, params.timestamp);
      session.entries.push(old);
    }
    session.pending.set(params.requestId, createEntry(params));
    if (session.loadSeen) scheduleFinish(session, SETTLE_MS);
    return;
  }

  if (params.requestId && isExcludedRequest(session, params.requestId)) return;

  if (method === "Network.responseReceived") {
    const entry = session.pending.get(params.requestId);
    if (entry) {
      if (params.type) entry._requestType = params.type;
      applyResponse(entry, params.response);
      if (entry._requestType === "WebSocket" || /text\/event-stream/i.test(params.response.mimeType || "")) {
        finishStreamingRequest(session, params.requestId, params.response, params.timestamp);
      }
    }
    return;
  }

  if (method === "Network.dataReceived") {
    const entry = session.pending.get(params.requestId);
    if (entry) {
      entry._decodedDataLength += Math.max(0, Number(params.dataLength) || 0);
      entry._encodedBodyBytes += Math.max(0, Number(params.encodedDataLength) || 0);
      entry.response.content.size = entry._decodedDataLength;
    }
    return;
  }

  if (method === "Network.webSocketHandshakeResponseReceived") {
    finishStreamingRequest(session, params.requestId, params.response, params.timestamp);
    return;
  }

  if (method === "Network.loadingFinished") {
    const entry = session.pending.get(params.requestId);
    if (entry) {
      entry._totalEncodedTransferSize = Math.max(0, Number(params.encodedDataLength) || 0);
      queueCompleteRequest(session, params.requestId, Number(params.timestamp) || 0, entry._totalEncodedTransferSize);
    }
    return;
  }

  if (method === "Network.loadingFailed") {
    const entry = session.pending.get(params.requestId);
    if (entry) {
      entry.response.status = 0;
      entry.response.statusText = params.errorText || "request failed";
      entry._bodyOmitted = "request failed";
      entry.response.content.size = Math.max(0, entry._decodedDataLength);
      entry.response.bodySize = responseBodyTransferSize(entry);
      applyFinalTiming(entry, Number(params.timestamp) || 0);
      session.pending.delete(params.requestId);
      session.entries.push(entry);
      if (session.loadSeen && !session.finishing &&
          !session.pending.size && !session.inflight.size) {
        scheduleFinish(session, SETTLE_MS);
      }
    }
  }
}

function safeSegment(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 72);
  return cleaned || fallback;
}

function describeBodyOmission(reason) {
  const descriptions = {
    "multipart/form-data body omitted for privacy": "multipart 表单正文已省略",
    "opaque request body omitted": "无法按已支持格式脱敏的请求正文已省略",
    "response body size limit reached": "响应正文超过单条保存上限",
    "total text body limit reached": "响应正文累计大小超过保存上限",
    "response body unavailable": "浏览器未能提供响应正文",
    "resource type not exported": "请求类别不在导出范围",
    "non-API or binary response body omitted": "响应正文类型不在保存范围",
    "stream frames are not captured": "流式消息正文未记录",
    "request failed": "请求失败，未保存响应正文",
    "request did not finish before capture limit": "采集时限到达时请求尚未完成"
  };
  return descriptions[reason] || reason;
}

function makePageExport(targetSession, details = {}) {
  const entries = targetSession.entries
    .filter((entry) => {
      if (!isExcludedRequest(targetSession, entry._requestId)) return true;
      targetSession.excludedExtensionRequestIds.add(entry._requestId);
      return false;
    })
    .filter((entry) => isCaptureRequestType(entry._requestType))
    .sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
  targetSession.exportedRequestCount = entries.length;
  const records = entries.map((entry) => {
    const request = { ...entry.request };
    delete request._postDataOmittedReason;
    return { request, response: { ...entry.response } };
  });
  const screenshotMode = details.hasScreenshot === false
    ? "截图失败"
    : targetSession.screenshotFallback ? "当前视口（整页截图失败后回退）" : "整页 PNG";
  const notes = [
    "页面采集说明",
    "扩展版本: " + CAPTURE_VERSION,
    "页面标题: " + (details.pageTitle || targetSession.pageTitle || ""),
    "原始页面地址: " + safeUrl(targetSession.pageUrl),
    "最终页面地址: " + safeUrl(details.finalUrl || targetSession.pageUrl),
    "采集时间: " + targetSession.startedAt,
    "",
    "用户备注:",
    targetSession.note || "(未填写)",
    "",
    "采集范围: Fetch / XHR",
    "HTTP 方法: 不限，仅记录实际发生的请求",
    "导出接口数: " + records.length,
    "排除扩展请求数: " + targetSession.excludedExtensionRequestIds.size,
    "网络记录状态: " + (targetSession.incomplete ? "不完整" : "未触发不完整标记"),
    "不完整原因: " + (targetSession.incompleteReason || "无"),
    "截图: " + screenshotMode,
    "截图说明: 只捕捉当前已渲染内容，不自动滚动触发懒加载。",
    details.screenshotError ? "截图错误: " + details.screenshotError : null,
    "",
    "正文保存规则: JSON、XML、纯文本和 GraphQL 响应正文会保存；二进制及其他类型正文省略。",
    "正文大小上限: 单条 " + (MAX_TEXT_BODY_BYTES / 1024 / 1024) +
      " MiB，累计 " + (MAX_TOTAL_BODY_BYTES / 1024 / 1024) + " MiB。",
    "脱敏规则: 认证类请求头、URL 查询参数及 JSON/URL 编码表单中的常见令牌字段会脱敏；multipart 和其他不支持的请求正文会省略；普通文本正文不做字段级脱敏。",
    "计时说明: blocked 记录未分类的剩余耗时；ssl 包含在 connect 内，总和不重复计算 ssl。",
    "大小说明: page.json 的 response.bodySize 为已知正文传输字节数，未知时为 -1；下方总传输量可能包含响应头。",
    "",
    "接口诊断（序号与 page.json 数组对应，从 1 开始）:"
  ].filter((line) => line !== null);
  if (!entries.length) notes.push("(本次没有符合条件的接口记录)");
  entries.forEach((entry, index) => {
    notes.push("", "[" + (index + 1) + "] " + entry.request.method + " " + entry.request.url);
    notes.push("  请求类别: " + entry._requestType);
    notes.push("  请求时间: " + entry.startedDateTime);
    notes.push("  总耗时(ms): " + entry.time);
    notes.push("  阶段耗时(ms): " + JSON.stringify(entry.timings));
    notes.push("  总传输量(字节，可能含响应头): " +
      (entry._totalEncodedTransferSize >= 0 ? entry._totalEncodedTransferSize : "未知"));
    if (entry.request._postDataOmittedReason) {
      notes.push("  请求正文说明: " + describeBodyOmission(entry.request._postDataOmittedReason));
    }
    if (entry._bodyOmitted) {
      notes.push("  响应正文说明: " + describeBodyOmission(entry._bodyOmitted));
    }
  });
  return { records, noteText: notes.join("\r\n") };
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

async function downloadBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    await waitForDownload(downloadId, 120000);
    URL.revokeObjectURL(objectUrl);
    return downloadId;
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function waitForDownload(downloadId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
    };
    const settle = (error, item) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(item);
    };
    const inspect = async () => {
      try {
        const items = await chrome.downloads.search({ id: downloadId });
        const item = items && items[0];
        if (!item) return;
        if (item.state === "complete") settle(null, item);
        else if (item.state === "interrupted") {
          settle(new Error("下载中断: " + (item.error || "未知原因")));
        }
      } catch (error) {
        settle(error);
      }
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === "complete") void inspect();
      if (delta.state && delta.state.current === "interrupted") {
        settle(new Error("下载中断: " + (delta.error && delta.error.current || "浏览器或策略阻止")));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => settle(new Error("等待下载完成超时")), timeoutMs);
    void inspect();
  });
}

async function captureScreenshot(targetSession) {
  const metrics = await chrome.debugger.sendCommand(targetSession.target, "Page.getLayoutMetrics");
  const size = metrics.cssContentSize || metrics.contentSize;
  if (!size || !size.width || !size.height) throw new Error("页面尺寸不可用");
  try {
    return await chrome.debugger.sendCommand(targetSession.target, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        scale: 1
      }
    });
  } catch (_) {
    targetSession.screenshotFallback = true;
    return await chrome.debugger.sendCommand(targetSession.target, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    });
  }
}

async function finishCapture(targetSession, timeLimitReached) {
  if (!targetSession || targetSession.finishing || targetSession.finished) return;
  targetSession.finishing = true;
  clearTimeout(targetSession.finishTimer);
  clearTimeout(targetSession.maxTimer);
  setStatus("正在整理文件", "正在完成网络记录 JSON、整页截图和备注文件…");

  while (targetSession.inflight.size) {
    await Promise.allSettled(Array.from(targetSession.inflight.values()));
  }
  if (timeLimitReached && (!targetSession.loadSeen || targetSession.pending.size)) {
    targetSession.incomplete = true;
    const reason = targetSession.loadSeen
      ? "采集时限到达时仍有请求未完成"
      : "采集时限到达前页面未触发 load 事件";
    targetSession.incompleteReason = targetSession.incompleteReason
      ? targetSession.incompleteReason + "；" + reason
      : reason;
  }
  for (const [requestId, entry] of targetSession.pending.entries()) {
    entry._bodyOmitted = "request did not finish before capture limit";
    entry.response.content.size = Math.max(0, entry._decodedDataLength);
    entry.response.bodySize = responseBodyTransferSize(entry);
    applyFinalTiming(entry, 0);
    targetSession.entries.push(entry);
    targetSession.pending.delete(requestId);
  }

  let screenshot;
  let screenshotError = "";
  try {
    screenshot = await captureScreenshot(targetSession);
  } catch (error) {
    screenshotError = error && error.message ? error.message : String(error);
  }

  let tabInfo = {};
  try {
    tabInfo = await chrome.tabs.get(targetSession.tabId);
  } catch (_) {}

  const title = tabInfo.title || targetSession.pageTitle || "page";
  const finalUrl = safeUrl(tabInfo.url || targetSession.pageUrl);
  const folderName = new Date().toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  const folder = "PageCapture/" + folderName + "_" +
    safeSegment(new URL(finalUrl).hostname, "site") + "_" +
    safeSegment(title, "page");
  const exportData = makePageExport(targetSession, {
    pageTitle: title,
    finalUrl,
    hasScreenshot: Boolean(screenshot && screenshot.data),
    screenshotError
  });
  const pageText = JSON.stringify(exportData.records, null, 2);

  targetSession.finished = true;
  try {
    await chrome.debugger.detach(targetSession.target);
  } catch (_) {}
  chrome.debugger.onEvent.removeListener(onDebuggerEvent);

  const jobs = [
    downloadBlob(
      new Blob([pageText], { type: "application/json;charset=utf-8" }),
      folder + "/page.json"
    ),
    downloadBlob(
      new Blob([exportData.noteText], { type: "text/plain;charset=utf-8" }),
      folder + "/note.txt"
    )
  ];
  if (screenshot && screenshot.data) {
    jobs.push(downloadBlob(
      base64ToBlob(screenshot.data, "image/png"),
      folder + "/screenshot-full.png"
    ));
  }
  const results = await Promise.allSettled(jobs);
  const successfulDownloads = results.filter((result) => result.status === "fulfilled").length;
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason && result.reason.message ? result.reason.message : String(result.reason));

  if (failures.length) {
    setStatus("部分文件未保存", failures.join("；"), "error");
  } else if (targetSession.incomplete) {
    setStatus("采集已保存，但网络记录不完整", targetSession.incompleteReason, "error");
  } else if (!screenshot || !screenshot.data) {
    setStatus("采集完成，但截图失败", "网络记录和备注已保存；" + (screenshotError || "截图数据为空"), "error");
  } else {
    setStatus("采集完成", "请到浏览器下载目录查看 PageCapture 文件夹。" +
      (targetSession.screenshotFallback ? " 页面过长，截图已回退为当前视口。" : ""), "done");
  }
  detailsNode.textContent = "页面：" + title + " · 请求记录：" + targetSession.exportedRequestCount +
    " · 已保存文件：" + successfulDownloads + "/" + jobs.length;
}

async function beginCapture(draft) {
  const targetSession = {
    tabId: draft.tabId,
    target: { tabId: draft.tabId },
    note: draft.note || "",
    reload: Boolean(draft.reload),
    startedAt: new Date().toISOString(),
    pageUrl: "",
    pageTitle: "",
    incomplete: !draft.reload,
    incompleteReason: draft.reload ? "" : "未重载页面，页面加载前的请求可能缺失",
    entries: [],
    pending: new Map(),
    inflight: new Map(),
    requestParents: new Map(),
    excludedExtensionRequestIds: new Set(),
    exportedRequestCount: 0,
    totalBodyBytes: 0,
    loadSeen: false,
    finishing: false,
    finished: false,
    screenshotFallback: false,
    finishTimer: null,
    maxTimer: null,
    error: ""
  };
  session = targetSession;
  chrome.debugger.onEvent.addListener(onDebuggerEvent);

  try {
    const tab = await chrome.tabs.get(draft.tabId);
    if (!tab.url || !/^https?:/i.test(tab.url)) {
      throw new Error("目标标签页不是普通 HTTP/HTTPS 网页。");
    }
    targetSession.pageUrl = tab.url;
    targetSession.pageTitle = tab.title || "";
    setStatus("正在连接页面", "浏览器会请求调试器权限，并只连接当前标签页。");
    await chrome.debugger.attach(targetSession.target, "1.3");
    await chrome.debugger.sendCommand(targetSession.target, "Page.enable");
    await chrome.debugger.sendCommand(targetSession.target, "Network.enable", {
      maxTotalBufferSize: 67108864,
      maxResourceBufferSize: 4194304
    });

    targetSession.maxTimer = setTimeout(() => finishCapture(targetSession, true), MAX_CAPTURE_MS);
    if (targetSession.reload) {
      setStatus("正在重载页面", "正在记录页面加载请求；页面加载后会自动截图并保存。");
      await chrome.debugger.sendCommand(targetSession.target, "Page.reload", { ignoreCache: false });
    } else {
      setStatus("正在采集", "只会记录开始采集后的请求；初次页面加载请求可能缺失。");
      scheduleFinish(targetSession, SETTLE_MS);
    }
  } catch (error) {
    chrome.debugger.onEvent.removeListener(onDebuggerEvent);
    try { await chrome.debugger.detach(targetSession.target); } catch (_) {}
    setStatus("无法开始采集", error && error.message ? error.message : String(error), "error");
  }
}

(async function init() {
  const captureStorage = chrome.storage.session || chrome.storage.local;
  const data = await captureStorage.get("pendingCapture");
  const draft = data.pendingCapture;
  await captureStorage.remove("pendingCapture");
  if (!draft || typeof draft.tabId !== "number") {
    setStatus("没有待采集页面", "请回到目标页面，点击扩展按钮后再开始。", "error");
    return;
  }
  await beginCapture(draft);
})();
