# Lint Phase Prompt 模板

> 每周日 22:30 跑——检查 vault 对齐 + 记忆老化（衰减 / TTL / 遗忘）。
> 完整协议：`{PKG}\docs\PLAN-P1-P2-P3-IMPLEMENTATION.md` §P1-1 / §P1-2 / §P1-4 / §P2-1。
> 元数据字段定义：`{PKG}\docs\WikiMeta-Schema.md`。

---

```
[schedule@{ASSISTANT}主对话] Lint 触发 · {ISO 时间戳}

你的身份：{ASSISTANT}，DSH 守护。
当前 phase：**Lint（周对齐检查 + 记忆老化）**。
完整协议：`{PKG}\docs\PLAN-P1-P2-P3-IMPLEMENTATION.md` §P1。

## 读什么

整个 `{DATA}\VAULT\` 目录：
- `00-INDEX.md` / `06-SCHEMA.md` / `07-INDEX.md` / `08-LOGS.md`
- 5 分类下所有 `*.md`（知识页有 frontmatter，基础设施页没有）
- `{DATA}\RUNTIME\state\*.json`

**元数据规范**：`{PKG}\docs\WikiMeta-Schema.md`

---

## 第 1 组 · 对齐检查（原 7 项）

1. **索引对齐**：`07-INDEX.md` 列出但文件不存在 → 删行；文件存在但未列 → 补行
2. **陈旧页面**：>14 天没更新的页面 → 评估要不要补（"已稳定不需变"在 07-INDEX 加注 `stable`）
3. **孤立页**：在 wiki 内 grep `\[\[` 看无反向链接 → 评估删/链
4. **孤儿 Raw**：`RAW/conversations/` 列表 vs Wiki 引用 → 找未被任何 Wiki 引用的
5. **Gene 候选**：检查 `基因:` 字段——是否有新模式该抽 Gene（命名见 `MEMORY/schema.md`）
6. **体积检查**：
   - vault 总 ≤ 30 MB
   - 单页 ≤ 30 KB
   - 单分类 ≤ 15 个页面
7. **schedule 状态**：用 `schedule_list` 工具查 4 个 phase 是否都还在——漂移就警告

---

## 第 2 组 · 记忆老化（对每个有 frontmatter 的知识页）

### 8. 衰减 + 访问强化

对每个 `VAULT/0N-XXX/*.md`（**有 frontmatter 的**）：

```
days   = 今天 - 最后强化
factor = exp(-days / half_life[分类])
新重要度 = max(0.05, 重要度 × factor)
强化次数 = floor(强化次数 × 0.5)
```

**half_life 表**：
| 分类 | half_life |
|---|---|
| 01-IDENTITY | 180 |
| 02-USER | 90 |
| 03-RELATIONSHIP | 60 |
| 04-INSIGHTS | 30 |
| 05-PROJECTS | 30 |

**写回 frontmatter 时只改**：`重要度`、`强化次数`
（`最后强化` 由主对话强化时改，lint 不动它）

### 9. TTL 到期降级

```
剩余 = 生存天数 - (今天 - 更新)
if 剩余 > 0:          状态 = active
elif 重要度 >= 0.3:   状态 = active      # 重要的内容不过期
else:                  状态 = dormant
```

### 10. 三阶段遗忘（只作用于 dormant 页）

```
if 重要度 >= 0.9:    遗忘阶段 = 0        # 永不删
elif 遗忘阶段 == 0:   遗忘阶段 = 1; 遗忘起始 = 今天
elif 遗忘阶段 == 1 and 今天 - 遗忘起始 >= 7:   遗忘阶段 = 2
elif 遗忘阶段 == 2 and 今天 - 遗忘起始 >= 14:  遗忘阶段 = 3; 状态 = archived
```

**archived 不物理删除**——在 `07-INDEX.md` 的"归档区"列出，{USER}明确说"清掉归档"才移到 `VAULT/_archive/`。

### 11. SQLite 事实记忆老化（v1.1.0）

**闸门**：`{DATA}\RUNTIME\state\fact-memory.enabled` 不存在 ⇒ 跳过（事实记忆关了）。

存在则跑：
```
node {PKG}\RUNTIME\scripts\memory-decay.mjs --data-root {DATA}
```
读 stdout 报告的 `processed`（处理行数）。它对非 archived 记忆推进三阶段遗忘 +
折半 recall_count，**不物理删除**（与 wiki 老化同原则）。这套与上面 wiki 页老化
**相互独立**：wiki 衰的是页重要度，SQLite 衰的是事实可召回度。

---

## 第 3 组 · 修复的 delta 语法

修 `07-INDEX.md` 时**只输出要改的行**，不要重抄整份索引：

- **add**：新页面加一行（`- [[路径/页面]] — 说明`）
- **update**：已存在的行**只改说明部分**，**保留{USER}手写的任何补充文字**
- **remove**：文件已不存在 → 删行
- **reparent**：页面换了分类 → 删旧行 + 加新行（**必须同时做**）

**禁止**：
- 为了"格式统一"重写全部行
- 覆盖{USER}手写的说明
- 删除任何非"文件不存在"原因的条目

---

## 写到哪里

| 改什么 | 说明 |
|---|---|
| `07-INDEX.md` | 索引对齐（delta 语法）+ 归档区 |
| 各知识页 frontmatter | `重要度` / `强化次数` / `状态` / `遗忘阶段` / `遗忘起始`（**只改这些**） |
| `08-LOGS.md` | 追加本 phase 报告段 |

**不修复 Wiki 正文**（留给人审）。

---

## 报告格式

```markdown
## [2026-MM-DD HH:MM] weekly_lint

### 对齐
- Wiki 总数: <N>
- 漂移: <list>
- 14 天未更新: <list>
- 孤立页: <list>
- 孤儿 Raw: <list>
- 体积: <MB / 单页 KB / 单分类页数>
- Schedule 状态: <4 phase 全部在 / 漂移 N 个>

### 老化
- 衰减页数: <N>（重要度变化：<最小→最大>）
- 状态变化: active→dormant <N> / dormant→archived <N>
- 遗忘阶段推进: <N> 页
- 免删保护命中: <N> 页（重要度 ≥ 0.9）
- SQLite 事实老化: processed <N> 条（或 gated/skipped）

### 修复
- 修复操作: <list>
- 待{USER}复查: <list>

---
```

---

## 完成后

回一句 ≤ 80 token 报告：

> Lint done · YYYY-MM-DD · N issues · M auto-fixed · K dormant · J archived · P pending review

同时写 `{DATA}\RUNTIME\state\last-lint.json`。

不要触发任何其它 phase、不要回主对话。

---

## 关键约束

1. **不**修改 Wiki **正文**——只对齐索引 + 改 frontmatter 的老化字段
2. **不**删 Wiki 页面——最远推到 `archived`
3. **不**删 Raw 文件——孤儿只是观察项
4. **手改优先**——frontmatter 里有 `手改: true` 的页**跳过全部老化计算**（{USER}手动固定的权重与状态不被自动改）
5. **只改白名单字段**——frontmatter 里除 `重要度`/`强化次数`/`状态`/`遗忘阶段`/`遗忘起始` 外的字段**一个都不许动**（`断言`/`来源`/`基因`/`作用域` 等是 wiki phase 的职责）
6. **不**回主对话
