# 通用请求与完整响应导出

状态：待用户确认的规格草案。基线为 v0.2.1 / 96c40b1，目标版本为 v0.3.0。2026-11-09 用户已确认完整响应正文、请求调用信息、移除 note.txt、按备注命名每次保存目录，并要求完整性优先。本草案中的具体 JSON 容器和保真规则供集中确认后实施。

## 1. 目标与已确认范围

采集结果用于理解接口如何调用，以及请求与服务端返回的对应关系。处理适用于不同系统，完整性优先于缩小文件。以通用协议和数据格式处理内容，不根据接口名称、数据字段名称或返回内容猜测业务价值。

- 保留全部符合现有 Fetch/XHR 范围的请求及对应响应，HTTP 方法不限。重复调用分别保留，可识别的扩展请求仍按既有过滤规则处理。
- 请求保留方法、完整地址、查询参数、可观察到的请求头和请求正文。响应保留 HTTP 状态、可观察到的响应头和完整正文。
- JSON 正文保留全部字段和层级。HTML、XML、普通文本等文本响应完整保存，JSON 的标量、空值、空对象、空数组和错误响应同样保留。
- JSON 可直接展开阅读，同时保留用于核对的正文文本。认证信息按已有规则使用脱敏占位符，字段名保留。
- 一份正常快照输出 page.json 和 screenshot-full.png。取消 note.txt。
- 用户备注用于本次快照子目录名。相同备注自动加 _2、_3 等后缀，未填备注使用 001、002 等序号。
- 首次开始监听后唯一一次刷新并自动保存、后续手动增量保存、结束立即丢弃未保存缓存、中断后显式补导出，继续遵循批次采集既有规则。

## 2. 具体导出合同

取消 note.txt 后，建议 page.json 顶层采用 formatVersion、capture、entries 三个字段。capture 仅保存页面与快照对应关系、完整备注、截图范围和实际异常。entries 中每项为一对 request/response。

这是相对旧版顶层数组的显式格式变化。formatVersion 使用 2，方便后续程序识别。完整响应正文独立放在 response.body 与 response.bodyText 中，采集器说明放在其外层。

capture 保留 pageUrl、pageTitle、capturedAt、note、screenshot 和 warnings。warnings 只记录实际发生的请求未完成、记录触限、子页面覆盖受限、正文遗漏及截图失败等情况。没有异常时为空数组。没有接口记录但快照覆盖不完整时，也能从 capture.warnings 识别。

请求保留 method、url、headers、query、mimeType、bodyStatus，以及存在的 body、bodyText、bodyError 和 bodyWarnings。响应保留 status、statusText、headers、mimeType、bodyStatus，以及存在的 body、bodyText、bodyError、bodyWarnings、网络错误及重定向目标。可观察到的有用字段优先保留，固定空 cookies、固定未知 headersSize、重复协议包装和详细阶段计时从默认导出移除。

headers 与 query 使用有序 name/value 数组，保留重复名称和多值。URL 也包含实际查询串。对浏览器合并返回的多值 header 保留其原始可观察文本，不伪造不可取得的逐行来源。

### 合成示例

```json
{
  "formatVersion": 2,
  "capture": {
    "pageUrl": "https://example.test/customers",
    "pageTitle": "客户查询",
    "capturedAt": "2026-11-09T02:00:00.000Z",
    "note": "在职客户",
    "screenshot": { "file": "screenshot-full.png", "scope": "full-page" },
    "warnings": []
  },
  "entries": [
    {
      "request": {
        "method": "POST",
        "url": "https://example.test/api/query?tag=a&tag=b",
        "headers": [
          { "name": "Content-Type", "value": "application/json" },
          { "name": "Authorization", "value": "[REDACTED]" }
        ],
        "query": [
          { "name": "tag", "value": "a" },
          { "name": "tag", "value": "b" }
        ],
        "mimeType": "application/json",
        "bodyStatus": "captured",
        "body": { "page": 1, "enabled": true },
        "bodyText": "{\"page\":1,\"enabled\":true}"
      },
      "response": {
        "status": 200,
        "statusText": "OK",
        "headers": [{ "name": "Content-Type", "value": "application/json" }],
        "mimeType": "application/json",
        "bodyStatus": "captured",
        "body": {
          "success": true,
          "items": [{ "id": "C001", "name": "示例客户" }],
          "total": 1,
          "extra": null
        },
        "bodyText": "{\"success\":true,\"items\":[{\"id\":\"C001\",\"name\":\"示例客户\"}],\"total\":1,\"extra\":null}"
      }
    }
  ]
}
```

## 3. 正文完整性

bodyText 保存浏览器提供的正文文本，按已确认的敏感名称规则脱敏，保留其他字段、值及文本内容。JSON 安全展开时，body 提供完整结构化内容作为阅读视图。HTML、XML、普通文本以正文字符串展示，可省略重复的 body 阅读视图。

不能通过普通 JSON.parse/JSON.stringify 链先改写正文，再声称文本完整。保留大整数、精确小数、重复 JSON 键及 JSON 原有字段名等信息。结构化展开会损失精度、重复键或其他内容时，以 bodyText 为准，省略有损 body 视图并标记原因。敏感名称字段的文本级脱敏也必须保护其他数值与重复键。保留正文文本是用户“宁愿多也不能缺”原则下的具体取舍。

请求支持浏览器可提供的 JSON、URL 编码表单、XML、GraphQL 和普通文本等正文。表单或查询参数的重复名称不能被转换成对象后覆盖。首个网络事件缺少正文、但浏览器声明存在正文时，尝试通过现有调试协议补取，取不到时记录明确原因。不得通过重发业务请求补取数据。

multipart 中可取得的文本字段及文件字段描述保留，描述包括字段名，以及可取得的文件名、类型和大小。文件原始二进制正文按已确认范围省略，并标明 multipart 的部分保留情况。浏览器未提供的文件或文本内容不能推测为完整。

响应覆盖 JSON、所有 text/*、XML、GraphQL、URL 编码表单和可确认的其他文本。遇到 MIME 不规范时，保留可取得且可确认为文本的正文，再按可验证格式解析。结构化展开失败时保留符合脱敏规则的文本及格式说明，不能仅因展开失败丢弃响应。CDP 的 base64 文本按可确认编码解码，编码无法确认或解码有损时，仅保留符合下述脱敏规则的可用表示，并标明表示和编码。

所有文本、base64 和其他回退表示均适用对应格式的同一脱敏规则。JSON 与 URL 编码表单需要可靠识别敏感名称并替换其值；结构化展开失败时可以采用保真文本处理，若无法可靠解码、识别或完成脱敏，则省略该正文并记录明确原因。base64 不能用作绕过脱敏的导出路径。multipart 可解析文本字段按字段名脱敏，无法可靠处理的部分单独省略并记录原因，文件二进制按既定范围省略。

HTML、XML、普通文本及 GraphQL 原文的字段级脱敏不在现有规则覆盖范围。此类正文按原文保存，bodyWarnings 和 capture.warnings 明示该范围，不能标为已完成字段级脱敏。能可靠识别为 JSON 或 URL 编码表单的正文按对应规则处理，不仅依赖 MIME 标签。未知编码或格式无法可靠适用其脱敏规则时，正文标为省略或不可得。

bodyStatus 区分 captured、empty、absent、omitted、unavailable、incomplete。empty 只表示实际取得空正文，absent 只表示可确认没有请求正文。JSON null、空字符串、0、false、[] 和 {} 的业务值按实际内容保留。缺少正文时用 bodyError 记录稳定原因和可读说明，状态和可取得的响应信息仍保留。

二进制响应按已确认范围保存类型和正文省略原因，bodyStatus 标为 omitted。HTTP 4xx/5xx 正文与普通响应一样处理。网络失败、尚未完成和正文取得失败分别标明，不伪造响应成功或把缺失正文当成空响应。

正文沿用单条 2 MiB、未成功留档累计 24 MiB 的留存预算。单条上限针对每个请求或响应的解码正文文本 UTF-8 字节数，脱敏后变长也须检查上限，body 阅读视图不重复计入单条正文大小。保留编码表示时，需标明编码及其字节计量方式。这些是留存内容预算，不宣称为 JavaScript 实际堆内存或最终 JSON 文件大小的精确上限。

正文文本优先。采集阶段优先保存 bodyText，结构化 body 阅读视图可在冻结导出时按剩余预算生成。阅读视图计入累计留存预算，但不足时先省略可重建视图，必要时释放已有视图，不能因阅读视图占用预算而优先丢弃仍可保留的后续正文文本。仅正文文本本身触及单条或累计上限时，才省略相应正文，并在已纳入记录的请求/响应 bodyError 与 capture.warnings 中说明。

记录数量、元数据、请求标识和子会话的上限沿用现有规则。此类触限可能使工具停止纳入新请求，使用 capture.warnings 记录触限原因和可确定的停止时间或覆盖边界，不承诺未纳入请求存在对应 entry。正文缺失与请求覆盖中断分开标记。完整取得的结论以浏览器提供且在明示资源边界内为前提，存在省略或覆盖缺口时明确记录。若后续要放宽资源上限，另行确定目标和验证。

## 4. 备注与目录

外层批次目录继续按开始时间、网站和页面标题确定。开始本批时的备注用于首份快照目录，后续每次保存使用本次备注。

```text
PageCapture/<本批目录>/
  客户列表/page.json
  客户列表/screenshot-full.png
  在职员工/page.json
  在职员工/screenshot-full.png
  在职员工_2/page.json
  在职员工_2/screenshot-full.png
  004/page.json
  004/screenshot-full.png
```

每批维护已经分配的最终目录名集合，按大小写不敏感规则检查冲突，包括备注名与默认序号、后缀名之间的交叉冲突。重复时寻找第一个未占用后缀。浏览器的 conflictAction: uniquify 只作为文件级兜底，不能代替快照目录命名。

目录名处理 Windows 非法字符、保留设备名、尾部空格或点、空白备注、相对路径片段和目录分隔符。过长名称按现有安全段长度规则截短，后缀和路径预算需预留。清理、截短后再次检查重名，完整用户备注保存在 capture.note。清理后为空的名称使用默认快照序号。

快照准备完成时冻结目录名，与截图、请求响应和备注一起保留。下载失败重试复用同一目录，成功文件不主动重复下载。正常快照由 JSON 和 PNG 都完成后提交增量；完全缺图时按已有缺图留档规则，以 JSON 完成且包含截图失败说明后提交。

## 5. 验收

- 合成接口覆盖 JSON 对象/数组/标量、空响应、错误响应、HTML/XML/文本、MIME 不规范、base64 文本、明确二进制和正文取得失败。
- 对请求地址、重复查询参数、重复表单字段、请求头、JSON/表单/XML/文本请求正文验证字段和值的保留。验证请求声明有正文但初始事件没提供正文的处理。
- 用合成的大整数、精确小数、重复 JSON 键和敏感字段验证正文保真、脱敏及阅读视图回退。测试只能使用合成资料。
- 对没有匹配记录但触发覆盖限制的快照，验证 page.json 仍保留必要异常信息。已纳入记录的正文遗漏须对应到具体请求/响应；停止记录后的覆盖缺口通过 capture.warnings 表达。
- 用多份合成 JSON 验证正文累计未触限而双份展示触限时，先省略可重建 body 阅读视图，保留 bodyText。验证单条预算与累计预算各自的判定对象。
- 验证无法可靠解码或完成脱敏的 JSON/表单不会通过 base64 或其他原始表示导出；验证 HTML/XML/普通文本与 multipart 的脱敏范围、警告和部分省略行为。
- 验证取消 note.txt 后正常两文件提交、部分失败只重试失败文件、缺图单文件提交、未提交增量及结束立即丢弃规则。
- 验证相同备注、不同备注清理后重名、大小写冲突、备注名与默认序号碰撞、_2 后缀碰撞、非法/设备名/过长名称和失败后重试目录冻结。
- 执行 npm test、npm run check、npm run package，核对版本及打包内容。按当前可用浏览器能力验证正常入口；真实扩展入口、旧内核和客户环境未实测时分别记录，模拟与 VM 验证不能替代这些证据。
- 更新 README 和项目内导出规则，替换已过时的 note.txt 与三文件成功条件。全局规则、共享 Skill、外部上传与真实客户资料均不在本次写入范围。

## 6. 实施与批准

本轮沿用项目本地 Markdown 跟踪和现有领域布局，不拆票。任务使用 feature/readable-export 分支与独立普通 Git worktree，主检出保持 main。当前聊天目录位于目标仓库之外，因此显式使用目标任务路径执行操作。

当前阶段为具体规格确认。用户确认本规格及实施范围后开发，再按影响验证、neat-freak 和独立审查收尾。任务分支提交和 push 按现有授权执行，合入 main 前汇报对应版本、全部审查发现及验证边界，并取得该版本的明确批准。
