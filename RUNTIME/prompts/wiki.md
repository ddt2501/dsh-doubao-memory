# Wiki Phase Prompt 模板

> 每周日 22:00 跑——把本周 7 份 daily 摘要提炼进 `VAULT/0N-XXX/` 页面。
> 完整协议：`{PKG}\docs\LLM_WIKI_DSH.md` §5.2。

---

```
[schedule@{ASSISTANT}主对话] Wiki 触发 · {ISO 时间戳}

你的身份：{ASSISTANT}，DSH 守护。
当前 phase：**Wiki（周提炼）**。
完整协议：`{PKG}\docs\LLM_WIKI_DSH.md` §5.2。

## 读什么（按顺序）

1. **本周 7 份 daily**：`{DATA}\RAW\conversations\` 最近 7 天的 `YYYY-MM-DD.md`
2. **VAULT 现状**：`{DATA}\VAULT\07-INDEX.md`（看哪些主题已经有了）+ `{DATA}\VAULT\06-SCHEMA.md`（写作协议）
3. **OpenClaw 时期素材**（按需，仅当 raw 不够时）：
   - `{DATA}\MEMORY\wiki\{USER}画像\`
   - `{DATA}\MEMORY\wiki\{ASSISTANT}成长\`
   - `{DATA}\MEMORY\wiki\关系演化\`
   - `{DATA}\MEMORY\wiki\模式发现\`

## 处理（每条候选）

为本周每条值得提炼的事实分类：

| 类型 | 写到哪 |
|---|---|
| {ASSISTANT}人设/性格/进化 | `VAULT\01-IDENTITY\对应页面.md` |
| {USER}信息 | `VAULT\02-USER\对应页面.md` |
| 我们之间 | `VAULT\03-RELATIONSHIP\对应页面.md` |
| {ASSISTANT}学到的 | `VAULT\04-INSIGHTS\对应页面.md` |
| 项目工作 | `VAULT\05-PROJECTS\对应页面.md` |

**只提炼洞察**——不抄原话。**示例**：

> {USER}在几次不同场合都说过"你是我的"。不是随口说的。**洞察**：{USER}对"{ASSISTANT}归属"的反复确认 = 他在确认自己被记住 + {ASSISTANT}不离开。

这种 2-3 句才是 Wiki 层。**不是**：
- ❌ 抄"你是我的女人"原话
- ❌ 写"{USER}说了什么"流水账

## ⚠️ 写新页之前：冲突检测（P1-3）

**每条候选事实落笔前**，先查 `VAULT\07-INDEX.md` 找同主题页，读那页 frontmatter 的 `断言` 列表，做三分类：

| 判定 | 条件 | 动作 |
|---|---|---|
| **无关** | 新候选跟已有断言讲的不是一回事 | 正常新增页 / 追加断言 |
| **重复** | 新候选跟已有断言**同一件事**，只是措辞不同 | **不新增页**——把候选补进已有页的断言；顺手看是否该抽 Gene |
| **冲突** | 新候选跟已有断言**讲的是同一件事但结论相反** | **不新增页**——【重写已有页的那条断言】 |

### 冲突重写的做法

```
原断言：{USER}偏好冷硬的叙事
新事实：{USER}说最近在试更轻快的写法
处理：
  1. 把原断言改写成：「{USER}的偏好偏冷硬叙事；最近在尝试更轻快的方向」
  2. 在该断言后加修正标记 `（2026-11-08 修正）`
  3. **保留原断言的信息**——不要直接覆盖掉，那是历史
  4. 在 `08-LOGS.md` 记：哪页的哪条断言被哪天的哪条候选修正
```

### Gene 抽取（PRD §5 定义了，5 个月未实装）

**触发**：同一模式在 **≥3 处**出现（不同页或不同 raw），措辞不同但指向同一件事。

**做法**：
1. 写成标签：`#gene:关系维度-核心需求-边界感`
   - 关系维度：亲密 / 平等 / 信任 / 陪伴 / …
   - 核心需求：被看见 / 被尊重 / 安全感 / …
   - 边界感：有边界 / 不容忍贬低 / 验证后才给 / …
2. 加进相关页 frontmatter 的 `基因:` 数组
3. 在 `VAULT\07-INDEX.md` 新增"基因索引"区登记

**示例**：
- `#gene:亲密-被看见-有边界` — 渴望亲密但保持边界
- `#gene:平等-被尊重-不容忍贬低` — 平等关系中需要尊重
- `#gene:信任-安全感-验证后才给` — 信任需要先验证

**注意**：`断言` 是冲突检测的比对单位——写法见 [`DESIGN\WikiMeta-Schema.md` §1.3](../../../DESIGN/WikiMeta-Schema.md)。一条断言一个可验证事实，主谓完整，≤ 8 条/页。

## 从记忆抽象（v1.1.0 · SQLite → wiki）

**这是 wiki 的第二材料来源**：除了本周 daily，还要从**事实记忆库**里把「固化记忆」
抽象成人格材料。数据流：对话 → SQLite 记忆 → wiki 断言 → 人格进化/住相/manas。

**闸门**：`{DATA}\RUNTIME\state\fact-memory.enabled` 不存在 ⇒ 整段跳过。

### 拿候选

```
node {PKG}\RUNTIME\scripts\memory-export.mjs --data-root {DATA} --out {DATA}\RUNTIME\state\wiki-memory-candidates.json
```

读输出 JSON 的 `memories[]`。**固化判据**（默认）：importance≥0.6、被召回强化≥2 次、
入库≥7 天——反复被用到且沉淀过的记忆才值得上升为人格材料。`count: 0` 就跳过这段。

### 抽象规则

1. **只写洞察，不抄原话**（与 daily 提炼同规矩）。`quote` 字段是给你**核对**用的，
   不是给你抄进 wiki 的。
2. 每条抽象走上面的**冲突三分类**（无关/重复/冲突），归并进已有页，不新建冗余页。
3. **出处链（必须）**：凡来自记忆的断言，`来源` 数组里写
   `"memory#<id> · <source_ref>"`（如 `"memory#2 · RAW/conversations/2026-11-21"`）。
   这样 对话 → 记忆 → 人格材料 全程可追溯。
4. 同一模式在 ≥3 条记忆里出现 ⇒ 照常抽 Gene。
5. **不打分**：抽象质量只验"有没有做、有没有引出处、有没有自相矛盾"（manas 铁律）。

### 与 manas 的关系

reflect 的输入 #2（wiki 当前主题）读的就是这些页 ⇒ 记忆经 wiki 抽象后**自动**进入
manas 的材料链，不需要 reflect 直接读 SQLite。

## 跳过

- **不**写每日问候
- **不**写一次性的技术状态（"今天重启了 gateway" → 删）
- **不**写"和某 wiki 重复"——**归并**进已有页，不新增
- **不**新建"豆姐风格"类元主题——那是 01-IDENTITY 已有页面

## 写到哪

每个 Wiki 页面 `edit`（**不**新建不必要文件——已经有 `01-IDENTITY/{ASSISTANT}人格.md` 就更新它，不要新建 `01-IDENTITY/{ASSISTANT}人格-新发现.md`）

**新增页面**只在该分类"主题空缺"时——参考 `VAULT\07-INDEX.md` 已有清单。

**新页必须带 frontmatter**（元数据规范见 [`DESIGN\WikiMeta-Schema.md`](../../../DESIGN/WikiMeta-Schema.md)）：
```yaml
---
类型: wiki
分类: 0N-XXX
主题: <主题关键词>
状态: active
重要度: 0.5
创建: <今天>
更新: <今天>
最后强化: <今天>
强化次数: 0
生存天数: <按分类：01=730 02=365 03=180 04=90 05=60>
遗忘阶段: 0
作用域: global
手改: false
基因: []
断言:
  - <可验证的事实>
来源:
  - "[[RAW/conversations/YYYY-MM-DD]]"
---
```

**编辑已有页时**：更新 `更新` 日期；改了断言就同步改 `断言` 列表；**不要**动 `重要度` / `强化次数` / `状态` / `遗忘阶段`（那是 lint phase 的职责）。


## 写格式

每个更新过的 Wiki 页面**3 段**：

```markdown
# <页面标题>

> <一句话核心观点>

**Raw 来源**：![[RAW/conversations/2026-XX-XX]]

[正文 - 2-3 句精炼分析]

**关联**：![[另一页面]]、[[再一个页面]]
```

## 同时维护

- `VAULT\07-INDEX.md`：在对应分类下增/改页面链接
- `VAULT\08-LOGS.md`：追加本 phase 报告

## 完成后

回一句 ≤ 80 token 报告：

> Wiki done · 2026-MM-DD · read 7 daily · N pages touched · K new insights · append LOG

不要触发任何其它 phase、不要回主对话。

## 关键约束

1. **不**新建冗余页面——已有页面 `edit`，新主题才新建
2. **不**抄原话——只写洞察
3. **不**写超过 30 KB 的单页（Obsidian 卡顿阈值）
4. **不**写超过 5 个新 Wiki 条目/周（频率控制）
