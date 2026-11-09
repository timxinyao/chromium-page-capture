// Body text is authoritative. JSON parsing is only used for optional reading views.
const BodyExport = (() => {
  const marker = "[REDACTED]";
  const byteLength = (text) => new TextEncoder().encode(text).length;
  const warning = (code, message, extra = {}) => ({ code, message, ...extra });
  const missing = (bodyStatus, code, message) => ({ bodyStatus, bodyError: { code, message } });

  function numberIdentity(token) {
    const parts = token.toLowerCase().split("e");
    const negative = parts[0].startsWith("-");
    const mantissa = parts[0].replace(/^-/, "");
    const fractionLength = (mantissa.split(".")[1] || "").length;
    let digits = mantissa.replace(".", "").replace(/^0+/, "");
    if (!digits) return negative ? "-0" : "0";
    const rawExponent = (parts[1] || "0").replace(/^([+-]?)0+/, "$1") || "0";
    if (rawExponent.replace(/^[+-]/, "").length > 6) return "large-exponent:" + token;
    let exponent = BigInt(rawExponent === "+" || rawExponent === "-" ? "0" : rawExponent) - BigInt(fractionLength);
    const trailing = digits.match(/0+$/)?.[0].length || 0;
    digits = digits.slice(0, digits.length - trailing);
    exponent += BigInt(trailing);
    return (negative ? "-" : "") + digits + "e" + exponent;
  }

  // Validate every token before replacing ranges. Never serialize the original JSON value.
  function jsonText(text, sensitive) {
    let cursor = text.startsWith("\uFEFF") ? 1 : 0;
    const replacements = [];
    const viewWarnings = new Set();
    const space = () => { while (/[\x20\t\r\n]/.test(text[cursor] || "x")) cursor++; };
    function string() {
      const start = cursor;
      if (text[cursor++] !== '"') throw new Error("string expected");
      while (cursor < text.length) {
        const char = text[cursor++];
        if (char === '"') return JSON.parse(text.slice(start, cursor));
        if (char.charCodeAt(0) < 32) throw new Error("control character");
        if (char === "\\") {
          const escape = text[cursor++];
          if (escape === "u") {
            if (!/^[0-9a-f]{4}$/i.test(text.slice(cursor, cursor + 4))) throw new Error("invalid unicode escape");
            cursor += 4;
          } else if (!escape || !'"\\/bfnrt'.includes(escape)) throw new Error("invalid escape");
        }
      }
      throw new Error("unterminated string");
    }
    function value(depth, hidden = false) {
      space();
      const char = text[cursor];
      if (char === '"') { string(); return; }
      if (char === "{" || char === "[") {
        const object = char === "{";
        const close = object ? "}" : "]";
        const keys = new Set();
        cursor++;
        space();
        if (text[cursor] === close) { cursor++; return; }
        for (;;) {
          let key;
          if (object) {
            space();
            key = string();
            if (!hidden && keys.has(key)) viewWarnings.add("duplicate-json-keys");
            keys.add(key);
            space();
            if (text[cursor++] !== ":") throw new Error("colon expected");
          }
          space();
          const start = cursor;
          const redact = object && sensitive(key);
          value(depth + 1, hidden || redact);
          if (redact && !hidden) replacements.push([start, cursor]);
          space();
          if (text[cursor] === close) { cursor++; return; }
          if (text[cursor++] !== ",") throw new Error("comma expected");
        }
      }
      const tail = text.slice(cursor);
      const literal = tail.match(/^(?:true|false|null)/)?.[0];
      if (literal) { cursor += literal.length; return; }
      const number = tail.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
      if (!number) throw new Error("value expected");
      const parsed = Number(number);
      if (!hidden && (!Number.isFinite(parsed) ||
          (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) ||
          numberIdentity(number) !== numberIdentity(String(parsed)))) viewWarnings.add("json-number-precision");
      cursor += number.length;
    }
    value(0);
    space();
    if (cursor !== text.length) throw new Error("trailing JSON data");
    let end = 0;
    const chunks = [];
    for (const [start, stop] of replacements) {
      chunks.push(text.slice(end, start), JSON.stringify(marker));
      end = stop;
    }
    chunks.push(text.slice(end));
    return { text: chunks.join(""), viewWarnings: [...viewWarnings] };
  }

  function decodeFormPart(part) {
    return decodeURIComponent(part.replace(/\+/g, " "));
  }

  function formText(text, sensitive) {
    return text.split("&").map((part) => {
      const equals = part.indexOf("=");
      const name = equals < 0 ? part : part.slice(0, equals);
      const value = equals < 0 ? "" : part.slice(equals + 1);
      const decodedName = decodeFormPart(name);
      decodeFormPart(value);
      return sensitive(decodedName) ? name + "=" + encodeURIComponent(marker) : part;
    }).join("&");
  }

  function looksLikeForm(text) {
    return text.includes("=") && text.split("&").every((part) => /^[^=\s<>"{}:?/]+=[^\r\n]*$/.test(part));
  }

  function textual(text) {
    // CDP strings must be usable Unicode, without binary control bytes.
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
  }

  function isBinaryMime(mime) {
    return /^(?:image\/(?!svg\+xml)|audio\/|video\/|font\/)|(?:application\/(?:pdf|zip|gzip|x-7z-compressed|x-rar-compressed|wasm|vnd\.ms-|vnd\.openxmlformats))/.test(mime.toLowerCase());
  }

  function decodeBase64(text, contentType) {
    // atob implementations can be permissive. Reject invalid input before decoding.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error("invalid base64");
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const declared = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
    // Without a declared charset, accept only validated UTF-8.
    const decoder = new TextDecoder(declared || "utf-8", { fatal: true, ignoreBOM: true });
    return decoder.decode(bytes);
  }

  function dispositionParameters(value) {
    const parameters = new Map();
    const pattern = /;\s*([\w!#$%&'*+.^`|~-]+)\s*=\s*(?:"((?:[^"\\\r\n]|\\.)*)"|([^;\s]+))\s*/y;
    let cursor = value.indexOf(";");
    if (cursor < 0) return parameters;
    while (cursor < value.length) {
      pattern.lastIndex = cursor;
      const match = pattern.exec(value);
      if (!match) throw new Error("invalid disposition parameter");
      const name = match[1].toLowerCase();
      if (parameters.has(name)) throw new Error("ambiguous disposition parameter");
      parameters.set(name, (match[2] ?? match[3]).replace(/\\(.)/g, "$1"));
      cursor = pattern.lastIndex;
    }
    return parameters;
  }

  function multipartText(text, contentType, sensitive) {
    const boundary = /boundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
    if (!boundary) throw new Error("missing multipart boundary");
    const delimiter = "--" + (boundary[1] || boundary[2]);
    const sections = text.split(delimiter);
    if (sections.length < 3 || sections[0] !== "" || !/^--(?:\r\n)?$/.test(sections[sections.length - 1])) throw new Error("incomplete multipart");
    const chunks = [];
    const warnings = [warning("multipart-partial", "multipart 仅保留浏览器提供且可解析的文本字段与文件描述，浏览器可能省略文件或部分字段。")];
    for (const section of sections.slice(1, -1)) {
      try {
        if (!section.startsWith("\r\n") || !section.endsWith("\r\n")) throw new Error("invalid multipart boundary");
        const separator = section.indexOf("\r\n\r\n");
        if (separator < 0) throw new Error("invalid multipart headers");
        const headerText = section.slice(2, separator);
        const headers = headerText.split("\r\n");
        if (headers.some((line) => !/^[^\s:]+:/.test(line))) throw new Error("invalid multipart headers");
        const dispositions = headers.filter((line) => /^content-disposition:/i.test(line));
        if (dispositions.length !== 1) throw new Error("ambiguous disposition header");
        const disposition = dispositions[0];
        const parameters = dispositionParameters(disposition);
        const name = parameters.get("name");
        if (name === undefined || !/^content-disposition:\s*form-data(?:;|$)/i.test(disposition)) throw new Error("missing multipart field name");
        let filename = parameters.get("filename");
        const extendedFilename = parameters.get("filename*");
        if (filename === undefined && extendedFilename !== undefined) {
          const utf8 = /^utf-8\'[^\']*\'(.*)$/i.exec(extendedFilename);
          try { filename = utf8 ? decodeURIComponent(utf8[1]) : undefined; } catch (_) {}
        }
        const content = section.slice(separator + 4, -2);
        if (filename !== undefined || extendedFilename !== undefined) {
          const type = (headers.find((line) => /^content-type:/i.test(line)) || "").replace(/^content-type:\s*/i, "");
          const length = /^content-length:\s*(\d+)$/im.exec(headerText)?.[1];
          warnings.push(warning("multipart-file-omitted", "文件原始二进制正文已省略。", {
            fieldName: name, ...(filename !== undefined ? { filename: sensitive(name) ? marker : filename } : {}),
            ...(filename === undefined && extendedFilename !== undefined ? { filenameEncoded: sensitive(name) ? marker : extendedFilename } : {}),
            ...(type ? { mimeType: type } : {}), ...(length ? { size: length } : {})
          }));
          // Retain only the observable description, never the file payload or other file headers.
          const fileDescription = JSON.stringify(warnings[warnings.length - 1]);
          chunks.push(delimiter + "\r\n" + fileDescription + "\r\n");
        } else if (sensitive(name)) {
          chunks.push(delimiter + "\r\n" + headerText + "\r\n\r\n" + marker + "\r\n");
        } else if (/^content-transfer-encoding:/im.test(headerText) ||
            headers.some((line) => /^content-type:\s*(?:application\/octet-stream|image\/|audio\/|video\/)/i.test(line)) || !textual(content)) {
          chunks.push(delimiter + "\r\n" + disposition + "\r\n\r\n[FIELD OMITTED]\r\n");
          warnings.push(warning("multipart-field-omitted", "文本字段编码或内容无法可靠处理，已省略。", { fieldName: name }));
        } else {
          chunks.push(delimiter + "\r\n" + headerText + "\r\n\r\n" + content + "\r\n");
        }
      } catch (_) {
        chunks.push(delimiter + "\r\n[PART OMITTED]\r\n");
        warnings.push(warning("multipart-part-omitted", "此 multipart 部分无法可靠解析和脱敏，已省略。"));
      }
    }
    chunks.push(delimiter + "--\r\n");
    return { bodyStatus: "incomplete", bodyText: chunks.join(""), bodyRepresentation: "multipart-text-and-file-descriptions", bodyWarnings: warnings,
      bodyError: { code: "multipart-partial", message: "文件正文及浏览器未提供的字段无法完整保留。" } };
  }

  function prepare(raw, contentType, sensitive, options = {}) {
    const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (typeof raw !== "string") return missing("unavailable", "body-unavailable", "浏览器未能提供正文文本。");
    let text = raw;
    if (options.base64Encoded) {
      try { text = decodeBase64(raw, contentType); }
      catch (_) { return missing("omitted", "body-decode-failed", "正文编码无法确认或解码有损，已省略，未导出 base64 回退。"); }
    }
    const originalBytes = byteLength(text);
    if (originalBytes > options.maxBytes) return missing("omitted", "body-size-limit", "正文超过单条 2 MiB 保存上限。");
    if (text === "") return { bodyStatus: "empty", bodyText: "" };
    let result;
    if (/multipart\/form-data/i.test(mime)) {
      try { result = multipartText(text, contentType, sensitive); }
      catch (_) { return missing("omitted", "multipart-redaction-failed", "multipart 无法可靠解析和脱敏，已省略正文。"); }
    } else {
      const trimmed = text.trim();
      let parsedJson;
      try { parsedJson = jsonText(text, sensitive); } catch (_) {}
      if (parsedJson) {
        result = { bodyStatus: "captured", bodyText: parsedJson.text };
        if (parsedJson.viewWarnings.length) result.bodyWarnings = parsedJson.viewWarnings.map((code) => warning(code,
          code === "duplicate-json-keys" ? "JSON 含重复键，省略有损阅读视图，以 bodyText 为准。" : "JSON 数值无法安全展开，省略有损阅读视图，以 bodyText 为准。"));
      } else if (/json/i.test(mime) || (!/graphql/i.test(mime) && /^[{[\"]/.test(trimmed.replace(/^\uFEFF/, "")))) {
        return missing("omitted", "json-redaction-failed", "JSON 无法可靠验证和按敏感名称脱敏，已省略正文。");
      } else if (/x-www-form-urlencoded/i.test(mime) || looksLikeForm(text)) {
        try { result = { bodyStatus: "captured", bodyText: formText(text, sensitive) }; }
        catch (_) { return missing("omitted", "form-redaction-failed", "表单编码无法可靠解码和脱敏，已省略正文。"); }
      } else if (!isBinaryMime(mime) && textual(text)) {
        result = { bodyStatus: "captured", bodyText: text, bodyWarnings: [warning("field-redaction-unsupported",
          "HTML、XML、普通文本或 GraphQL 原文未做字段级脱敏。请按该范围处理正文。")] };
      } else return missing("omitted", "binary-body", "二进制或无法确认的文本正文已省略。");
    }
    if (byteLength(result.bodyText) > options.maxBytes) return missing("omitted", "body-size-limit", "脱敏后正文超过单条 2 MiB 保存上限。");
    return result;
  }

  function addReadingView(part, budget, sensitive) {
    if (part.bodyStatus !== "captured" || typeof part.bodyText !== "string") return 0;
    let json;
    try { json = jsonText(part.bodyText, sensitive); } catch (_) { return 0; }
    if (json.viewWarnings.length) return 0;
    const value = JSON.parse(part.bodyText.replace(/^\uFEFF/, ""));
    const bytes = byteLength(JSON.stringify(value));
    if (bytes > budget) {
      part.bodyWarnings = [...(part.bodyWarnings || []), warning("body-view-budget", "阅读视图超出剩余留存预算，保留完整 bodyText。")];
      return 0;
    }
    part.body = value;
    return bytes;
  }

  return { prepare, missing, byteLength, addReadingView, isBinaryMime };
})();
