# 通用请求与完整响应导出状态

状态：v0.3.0 候选 b22f1bc 在第 3/3 轮最终审查发现 2 项 P2 脱敏遗漏，已停止自动修复、再审与合入，等待用户处理。Triage: ready-for-human。基线为 v0.2.1 / 96c40b1。权威规格见 [spec.md](spec.md)，规格及实施已于 2026-11-09 获用户明确批准。

## 已确认

- 保留服务端完整响应正文，不猜测 data/list 等业务字段。
- 通用处理请求与响应，JSON 直接展开，其他文本保留原文，正文缺失有明确原因。
- 保留全部 Fetch/XHR 及 HTTP 方法，敏感值脱敏。
- 取消 note.txt，备注命名本次保存的子目录，重复加后缀，重试使用冻结目录。
- 完整性优先，精简外层冗余内容。

## 当前进展

- 已核对当前正文格式、缺失说明、目录和重试实现，以及现有任务/领域文档约定。
- 已建立 feature/readable-export 任务分支和普通 Git worktree，主检出保持 main。
- 已准备并获批准的规格包含实际 JSON 样例、保真、目录冲突和验收边界。
- 用户已集中确认 formatVersion/capture/entries 顶层容器、正文文本与精度回退、资源上限及文本格式的脱敏边界，并授权实施。
- v0.3.0 候选实现已保存在本地 feature/readable-export 的 b22f1bc 提交，主干为 v0.2.1。产品提交因确认阻断项而尚未 push，远端任务分支停留在 21cc4f9 规格提交。
- 第 1 轮规格审查发现 3 项 P2 合同缺口，已补明所有回退表示的脱敏规则、正文优先于可重建视图、正文省略与停止记录覆盖缺口的区分。第 2 轮复核确认三项均已解决，未发现新增可操作问题，可供用户集中审阅。
- 合成 JSON 示例解析及 body/bodyText 对应关系校验通过。新增正文模块、格式 2 导出、请求补取、备注目录和两文件事务已实现，原批次生命周期回归已适配。

## 实际验证

- `npm test`：67/67 通过。覆盖既有生命周期及新增正文、目录、格式和事务边界。实施自检新增两条先失败后通过的回归，修复网络失败后迟到正文覆盖状态、multipart 重复 name/disposition 的脱敏歧义。
- `npm run check`、`npm run package`：通过。ZIP 恰含 extension 下 9 个运行文件，各项与源码逐字节一致，三处版本均为 0.3.0。ZIP SHA256 为 70b38c44b2f52d3e2b256938ab49d2083108220798fbdf880e7b4d216abf5ebe。
- 独立外部 VM 探针：10/10 通过，无失败或跳过。覆盖精度、重复字段、敏感键、补取晚到、MIME、multipart、正文优先、目录与生命周期。长 Unicode 目录检查通过，最长合成相对下载路径为 226 个 UTF-16 单元。
- 最终源码执行前后 SHA256 一致。capture.js 为 a593e144c8907b02648ba25f7e47f264f9258a6364b1fdb72a9a1854aee51590，body.js 为 ac42d71b75888fe07e7bcd602541aa608f916481e2b20f7767a81a69d1316636。
- Edge 158.0.4370.7、1280×800，在最终源码上完成浏览器级模拟。实际产品 HTML/CSS/JS 在合成 HTTP 页面运行，FakeChrome 桥接调试事件与下载。首份备注、同名 _2、POST/JSON、HTML、空结果、两文件、失败仅重试失败文件、冻结目录、结束不新增下载及下一批独立目录均通过。截图已实际查看。
- 首轮 HTTP iframe 因未声明 unload 出现权限策略提示。合成夹具显式添加 `allow="unload"` 后复验控制台无错误；产品未为此更改。最终原生 MV3 popup 只读加载探针显示新文案、unloadAllowed=true，且无控制台错误。该探针没有开始采集或 attach。
- 外部脚本、截图和日志保留在会话 work 下的 readable-export-verification 与 readable-export-browser，使用合成数据。本次浏览器和临时端口服务均已关闭。

## 正文预算与冻结边界

采集期仅保留正文文本。冻结导出时按剩余 24 MiB 预算生成可重建阅读视图，生成 JSON Blob 后释放构建对象。冻结 Blob、备注与目录在后续请求和重试中保持一致。预算按规格表示留存内容，最终文件体积及 JavaScript 实际堆占用单独受表示与序列化开销影响。

## 第 3/3 轮最终审查

Standards 轴未发现可操作问题。Spec 轴确认以下 2 项 P2，均未被现有 67 项仓库回归和 10 项外部探针覆盖，当前保留未修复。

| 发现 | 复现与影响 | 当前状态 |
| --- | --- | --- |
| 表单识别拒绝尾部空段或无等号字段 | text/plain 正文 token=synthetic-secret&tag=one& 或 token=synthetic-secret&flag 被当作普通文本，request/response.bodyText 留下明文 token；位置 extension/body.js:118 | P2，待用户授权后修复与追加验证 |
| URL 与 query 的敏感名称解码不一致 | 查询串 ?%74oken%ZZ=synthetic-secret 的 query 值已脱敏，request.url 却保留明文；位置 extension/capture.js:91，关联第 58–64 行 | P2，待用户授权后修复与追加验证 |

审查使用仓库外 readable-export-spec-review-final/review-probes.cjs 从正常公开命令入口复现，退出码 1，5 个隐私断言失败，对应上述两类问题。结果保留在同目录 review-probes-result.json。探针仅使用 synthetic-secret 等合成数据，产品文件保持冻结。

multipart 文本内嵌 boundary 样本因 RFC 行首规则与 Node FormData 拒绝行为存在争议，本轮未计为确认 finding。深层 JSON 的内部辅助函数异常未在正常采集保存入口复现为整份快照阻断，也未计为确认 finding。

本任务两轮规格审查加本轮并行双轴审查，共三轮。按用户 AGENTS.md 的上限停止自动修复、再审和合并，保留现场，由用户决定后续修复与额外复审范围。

## 未验证与后续

- 真实工具栏和快捷键入口、activeTab 授权、原生 CDP 全链路与原生下载、旧内核及客户环境仍未完成本轮验收。VM、浏览器模拟和原生 popup 只读探针分别报告，不能互相替代。
- 当前已触发第三轮阻断停止规则，候选安装包留在本地 dist 供追溯，不作为已通过验收版本交付。
- 如用户明确授权修复这两项并追加针对性复审，先补复现回归、修复和受影响验证，再汇报具体版本。对应版本合入仍须另行批准。
