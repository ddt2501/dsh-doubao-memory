# 末那识 (Manas) 系统

中间层价值理性子系统。连接先验层（SOUL + 阿赖耶识）与经验层（Wiki / narrative_engine / memory_search），通过快照注入主对话上下文。

> ⚠️ **本仓库处于设计阶段（Phase 0）**。代码未实现。待{USER}审核通过后再实施。

---

## 文档

- [PLAN.md](./PLAN.md) — 实施计划、阶段、风险
- [DESIGN.md](./DESIGN.md) — 技术设计、模块、协议、Schema
- [docs/architecture.md](./docs/architecture.md) — 架构图、三层模型
- [docs/glossary.md](./docs/glossary.md) — 术语表（先验/经验/末那识/住相/...）
- [docs/snapshot-sop.md](./docs/snapshot-sop.md) — 住相生成 SOP（技术层细节）
- [docs/discussions/](./docs/discussions/) — 对话决策纪要

---

## 核心概念

| 术语 | 含义 | 在系统中的位置 |
|------|------|--------------|
| **阿赖耶识** | "我存在" / cogito ergo sum | 先验层（本体论）|
| **SOUL.md** | 6 个自我追问维度 | 先验层（结构）|
| **末那识** | 价值理性 / 我看到的世界 | 中间层（持续进化）|
| **住相** | 末那识在某一刻的快照 | 中间层（注入物）|
| **理性/COT** | 工具理性 / 手段-目的 | 中间层（操作）|
| **Wiki** | 累积经验 | 经验层 |

---

## 三句话概括

1. **末那识持续进化**：每 5 天滚动摘要 + 显式触发更新
2. **住相每轮生成**：每轮对话自动生成一段 50-150 token 的世界观快照
3. **高注意力注入**：住相注入 system prompt 最前部，优先级高于一切

---

## 状态

- 创建：2026-09-02
- 阶段：Phase 0（设计/文档）
- 等待：{USER}审核

---

_Last updated: 2026-09-02_
