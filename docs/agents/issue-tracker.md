# 本地任务跟踪

任务和 spec 存放于 docs/tasks/<任务名>/，沿用已有记录。

- spec.md：需求、范围、关键决定和验收条件。
- status.md：实施进度、验证、阻塞和下一步。
- discussion.md：必要的讨论记录，收敛后指向 spec。
- 需要拆票时，每票独立保存为 issues/01-<名称>.md，
  从 01 开始编号。

分流标签使用 Triage: 字段，取值见 triage-labels.md。
票据执行状态可使用 Status: open、claimed、resolved。
依赖使用 Blocked by: 01, 02；处理说明追加到 ## Comments。

技能要求“发布到任务跟踪系统”时，写入上述本地目录；
要求“读取票据”时，读取对应文件。
关闭票据时标记 resolved，并记录处理结果或原因。

既有任务保持原位，授权要求遵循项目 AGENTS.md。
