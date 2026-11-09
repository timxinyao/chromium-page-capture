# 批次采集需求讨论

状态：v0.2.0 已交付。2026-11-09 用户明确修订结束行为，点击“结束本批”立即停止并丢弃未保存缓存，需要留档时先“保存一次”。用户已授权快速修改后 push，当前规则见 [spec.md](spec.md)，实际验证见 [status.md](status.md)。

## 权威记录与后续步骤

- 行为约定、技术落地建议和验收条件集中维护在 [spec.md](spec.md)。本文件不再维护一份平行规则。
- 术语见 [GLOSSARY.md](../../../GLOSSARY.md)。README.md 继续描述已发布版本。
- 本轮不拆票；行为基线为已获批准的 spec。
- v0.2.0 实施使用独立 feature/batch-capture 分支与任务 worktree，该隔离任务已合入、归档并清理。v0.2.1 在 main 主检出完成局部修订，结果见 status.md。
- 实施进度、验证和待完成项以 [status.md](status.md) 为准；文档约定不代替实际验证。
