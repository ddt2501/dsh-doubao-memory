# P1 / P2 / P3 升级方案 · 实施文档

> 2026-11-08 写。PLAN 里 P1-P3 只有标题和工时；本文是**照着做就能落地**的实施书。
>
> **依赖**：[`WikiMeta-Schema.md`](WikiMeta-Schema.md)（元数据字段定义，P1/P2 全部基于它）
> **路线依据**：[`PLAN-memory-engineering.md`](PLAN-memory-engineering.md)（自建定案 + 来源算法）
> **调研原文**：[`RESEARCH-AstrBot.md`](RESEARCH-AstrBot.md) · [`RESEARCH-dsh-tavern.md`](RESEARCH-dsh-tavern.md)

---

## 0. 全局约定

### 0.1 改动落点只有三个

| 落点 | 改什么 | 谁触发 |
|---|---|---|
| `VAULT/**/*.md` | frontmatter + 正文 | wiki phase（写）/ lint phase（衰减、归档、索引对齐） |
| `RUNTIME/prompts/*.md` | phase 协议 | 我手动改（设计变更） |
| `RUNTIME/state/*.json` | 运行状态 | 各 phase 自己写 |

**`IDENTITY/` 下的先验文件不参与本方案**（人格变更走提案门，见 `IDENTITY/人格变更流程.md`）。

### 0.2 三个通用原则

1. **软降权优先于删除**——lint phase 永不物理删除 Wiki 页，最远推到 `archived` 且要用户确认。
2. **人的修改优先于自动计算**——用户手改的 frontmatter 值，lint 不得覆盖（lint prompt 里明写）。
3. **每次自动改动都要可追溯**——衰减/归档/冲突重写都在 `VAULT/08-LOGS.md` 留一行。

### 0.3 执行顺序（**有依赖，不能乱序**）

```
① WikiMeta Schema 落地（frontmatter + 存量迁移）   ← 一切的前提
      ↓
② P1-1 衰减 + 访问强化     （lint phase）
      ↓
③ P1-2 TTL + 状态机       （lint phase，与 ② 同跑）
      ↓
④ P1-3 冲突检测 + Gene     （wiki phase）
      ↓
⑤ P1-4 台账 delta 语法     （lint phase）
      ↓
⑥ P2-1 三阶段遗忘         （lint phase，与 ③ 同跑）
      ↓
⑦ P2-2 主动消息           （独立，schedule + 状态文件）
      ↓
⑧ P3 作用域隔离            （数据结构预留，可选）
```

---

# P1 · 记忆的生老病死

## P1-1 衰减 + 访问强化

### 目标

让"三个月前写的、半年没碰过的"内容自然变轻，让"最近常用"的变重——**不靠删除，靠权重**。

### 来源算法

`dsh-memory-engine/lib/render/decay.js:24-28`：
```js
retention = min(1.15, exp(-ageDays / halfLife) + boost)
```
`lib/render/score.mjs:96-97`：
```js
halfLife = majorEmotion ? 90 : kind == '事件' ? 3 : HALF_LIFE[heat]
```
`livingmemory` 的"访问强化 + 访问计数每次衰减后 ×0.5"（防旧热点永生）。

### 我们的算法（adapted）

**衰减**（lint phase 每次跑）：
```
days   = 今天 - 最后强化
factor = exp(-days / half_life[分类])
新重要度 = 重要度 × factor
```
**下限**：`重要度 < 0.05` → 停止衰减（保底，不会归零）

**强化**（检索命中时）：
```
新重要度 = min(1.0, 重要度 + 0.1)
强化次数 += 1
最后强化 = 今天
```

**反永生**（关键，抄 livingmemory）：
```
每次衰减后：强化次数 = floor(强化次数 × 0.5)
```
效果：连续命中 10 次的页，若 30 天不碰，强化次数掉到 5 → 再衰减时重要度掉得快 → 不会因为"历史上很热"就永远沉不下去。

**分类半衰期**：

| 分类 | half_life | 衰减到 0.5 需要 |
|---|---|---|
| 01-IDENTITY | 180 天 | 180 天 |
| 02-USER | 90 天 | 90 天 |
| 03-RELATIONSHIP | 60 天 | 60 天 |
| 04-INSIGHTS | 30 天 | 30 天 |
| 05-PROJECTS | 30 天 | 30 天 |

### 落点

**改 `RUNTIME/prompts/lint.md`**，在 7 项检查后加第 8 项：

```markdown
## 8. 衰减 + 访问强化

对每个 `VAULT/0N-XXX/*.md`（有 frontmatter 的）：

1. 读 frontmatter 的 `重要度` / `最后强化` / `强化次数` / `分类`
2. days = 今天 - 最后强化
3. factor = exp(-days / half_life[分类])
   half_life: 01-IDENTITY=180, 02-USER=90, 03-RELATIONSHIP=60, 04-INSIGHTS=30, 05-PROJECTS=30
4. 新重要度 = max(0.05, 重要度 × factor)
5. 强化次数 = floor(强化次数 × 0.5)
6. 写回 frontmatter：**只改 `重要度` / `强化次数` / `最后强化`（若被强化过）**，
   不要动 `状态` / `断言` / `来源` / `基因` —— 那是别项的职责

**人改优先**：如果 frontmatter 里有 `手改: true` 标记，跳过衰减（用户手动固定的权重不被自动改）。
```

### 强化在哪里发生

**问题**：lint phase 是每周日跑，检索命中是**会话内**发生的。

**方案**（二选一，实施时定）：

| 方案 | 做法 | 成本 |
|---|---|---|
| **A. 会话内自记** | LLM 在读完某个 Wiki 页后，往该页 frontmatter 的 `最后强化`/`强化次数` 打标 | 0（改 AGENTS.md §1.2 加一句） |
| **B. lint 阶段补** | lint 时扫描 `VAULT/08-LOGS.md` 里本周的"读了哪些页"记录 | 需 LLM 在 ingest 时记录读了什么 |

**推荐 A** —— 改 `AGENTS.md` §1.2 末尾加一句：
> 读完某个 vault 页后，在该页 frontmatter 把 `最后强化` 设为今天、`强化次数` 加 1。

### 验收标准

- [ ] 24 页全部有 frontmatter（迁移脚本跑过）
- [ ] lint phase 跑完后，`04-INSIGHTS/课程.md`（10-12 建、一直没碰）的 `重要度` 明显低于 `03-RELATIONSHIP/橘色与沉浸.md`（11-07 建、刚写过）
- [ ] 用户手改过 `重要度` 的页，lint 不覆盖

### 风险

- **衰减太狠** → 页面迅速变轻，检索时找不到。**缓解**：下限 0.05 + 半衰期不低于 30 天
- **强化太容易** → LLM 每次读都强化，权重虚高。**缓解**：一次会话最多强化 1 次（AGENTS.md 里写明）

---

## P1-2 类型化 TTL + 状态机

### 目标

让过期内容**自动降级**（不再注入），但**不删除**——删除要用户点头。

### 来源算法

`livingmemory` `architecture.md:183-184`：
> 原子类型化 TTL：事件 7 天 / 计划 2 天 / 事实 180 天 / 关系 90 天 / 偏好 60 天 / 未知 30 天

### 我们的实现

**TTL 字段**：`生存天数`（已在 Schema §1.1 定义）

**状态推进**（lint phase）：
```
剩余 = 生存天数 - (今天 - 更新)
if 剩余 > 0:      状态 = active
elif 重要度 >= 0.3: 状态 = active      # 重要的内容不过期
else:              状态 = dormant
```

**关键规则**：
- `dormant` 的页**不注入**到主对话（AGENTS.md §1.2 加一句"只读 active 的页"）
- `dormant` 的页被检索命中 → 回 `active`（跟 P1-1 的强化联动）
- **`dormant` 不是死页**——它只是"默认不出现"

### 落点

**改 `RUNTIME/prompts/lint.md`**（第 8 项之后加第 9 项）：

```markdown
## 9. TTL 到期降级

对每个 wiki 页：
1. 剩余 = 生存天数 - (今天 - 更新)
2. if 剩余 > 0: 状态 = active
3. elif 重要度 >= 0.3: 状态 = active      # 重要内容不过期
4. else: 状态 = dormant
5. **dormant 不删除**，只降级；并在 08-LOGS.md 记一行
```

**改 `D:\dsh\AGENTS.md` + `IDENTITY/AGENTS.md` §1.2**：

> 只读 `状态: active` 的页；`dormant` 的页只有在你明确问到相关话题时才读。

### 验收标准

- [ ] 一个 90 天没更新的 `04-INSIGHTS` 页自动变 `dormant`
- [ ] `dormant` 页不在 `07-INDEX.md` 的"当前活跃主题"区
- [ ] lint 报告里能数出 dormant / active 各多少

---

## P1-3 事实冲突检测 + Gene 落地

### 目标

**同一件事在两个页面写了两遍、还互相矛盾**——这是 vault 变大后的头号病。修它，同时把 Gene 落地。

### 来源算法

`atri` `core/util/prompts.py:39-65`：**REL_CHECK_PROMPT 三分类**
```
1 = unrelated（无关）
2 = conflict（冲突）
3 = duplicate（重复）
```
`prompts.py:68-93` **RESUM_PROMPT**（摘要修订）——记忆**不是 append-only，是可重写的**。

### 我们的实现

**时机**：wiki phase 写新页**之前**

**流程**：
```
1. 从本周 daily 提取候选事实（每条一句话）
2. 对每条候选：
   a. 读 VAULT/07-INDEX.md 找同主题页
   b. 读该页 frontmatter 的 `断言` 列表
   c. 三分类判定：
      - 无关    → 正常新增页
      - 重复    → 不新增，把候选内容补进已有页（并检查是否该抽 Gene）
      - 冲突    → 不新增；【重写已有页】的对应断言，并记录"被 YYYY-MM-DD 修正"
3. 写完后在 08-LOGS.md 记：处理了 N 条候选 / 新增 X / 归并 Y / 重写 Z
```

**冲突重写的具体做法**（抄 atri 的 RESUM_PROMPT 思路）：
```
原断言：用户喜欢反套路黑暗流网文
新事实：用户说最近在写轻松喜剧
处理：把原断言改成「用户写网文，口味偏反套路黑暗流；最近在尝试轻松喜剧方向」
      + 在该断言后加修正标记 `（2026-11-08 修正）`
```

### Gene 落地（PRD §5 定义了 5 个月未实装）

**触发条件**（在"重复"判定时顺带检测）：
```
同一模式在 ≥3 处出现（不同页或不同 raw），措辞不同但指向同一件事
```

**抽取**：
```yaml
基因: ["#gene:亲密-被看见-有边界"]
```
并在 `VAULT/07-INDEX.md` 新增"基因索引"区登记。

**命名规范**（来自 `MEMORY/schema.md`）：
`#gene:关系维度-核心需求-边界感`

**示例**：
- `#gene:亲密-被看见-有边界` — 渴望亲密但保持边界
- `#gene:平等-被尊重-不容忍贬低` — 平等关系中需要尊重
- `#gene:信任-安全感-验证后才给` — 信任需要先验证

**落点**：改 `RUNTIME/prompts/wiki.md`，在"处理"段前插入冲突检测步骤。

### 验收标准

- [ ] 造一个冲突场景（同一页断言说 A，新 daily 说 B），跑 wiki phase，**已有页被重写**而不是新增一页
- [ ] 至少抽出一个 Gene 标签并登记到 `07-INDEX.md`
- [ ] lint 报告里"重复"与"冲突"分开计数

---

## P1-4 台账 delta 语法

### 目标

让 lint 的修复**只改该改的**，不重抄全表——避免每次 lint 都把 `07-INDEX.md` 写成新格式、丢掉人手动加的行。

### 来源算法

`dsh-tavern` `story-ledger.js:47-173`：
- 四操作：`add` / `update` / `remove` / `reparent`
- "不能更新尚未登记的条目"（`story-ledger.js:131`：`if (!existing && action === 'update') throw`）
- "**只输出本批涉及的条目，不要为了保持完整而重抄全表**"

### 我们的实现

**改 `RUNTIME/prompts/lint.md`** 的修复规则：

```markdown
## 修复操作的 delta 语法

修 `07-INDEX.md` 时**只输出要改的行**，不要重抄整份索引：

- **add**：新页面加一行（`- [[路径/页面]] — 说明`）
- **update**：已存在的行**只改说明部分**，**保留用户手写的任何补充文字**
- **remove**：文件已不存在 → 删行
- **reparent**：页面换了分类 → 删旧行 + 加新行（**必须同时做**，不能只删不加）

**禁止**：
- 为了"格式统一"重写全部行
- 覆盖用户手写的说明
- 删除任何非"文件不存在"原因的条目
```

### 验收标准

- [ ] 跑一次 lint，`07-INDEX.md` 的 diff **只包含**本批变动行
- [ ] 用户手写在某行说明里的补充文字，lint 后还在

---

# P2 · 主动性与遗忘

## P2-1 三阶段遗忘

### 目标

给过期内容一个**反悔窗口**——不是直接删，而是"我快忘了它"→"我正在观察它"→"我准备删它"→**等用户点头**。

### 来源算法

`self_learning` `services/learning/forgetting_manager.py:1-13`：
```python
STAGE_LABELS = {0:"新鲜", 1:"遗忘观察一期", 2:"遗忘观察二期", 3:"待删除"}
HIGH_VALUE_WEIGHT = 3.0   # 永不删
```
周期 7 天、宽限 14 天、负面反馈 fast-track。

### 我们的实现

**状态推进**（lint phase，每周一次）：
```
if 状态 == dormant:
    if 遗忘阶段 == 0: 遗忘阶段 = 1; 遗忘起始 = 今天
    elif 遗忘阶段 == 1 and 今天 - 遗忘起始 >= 7: 遗忘阶段 = 2
    elif 遗忘阶段 == 2 and 今天 - 遗忘起始 >= 14: 遗忘阶段 = 3; 状态 = archived
```
**从 archived 复活**：`dormant` 被检索命中 → 回 `active`，`遗忘阶段 = 0`

**永不删的例外**：
```
if 重要度 >= 0.9:  遗忘阶段永远保持 0
```
（livingmemory 是 `weight >= 3.0` 永不删；我们用 0-1 标度，等价阈值取 0.9）

**`archived` 的实际处置**：
- lint phase **不物理删除**
- 在 `07-INDEX.md` 的"归档区"列出来（用户能看到）
- 用户说"清掉归档" → 才移到 `VAULT/_archive/`

### 落点

改 `RUNTIME/prompts/lint.md`（第 9 项之后加第 10 项）：

```markdown
## 10. 三阶段遗忘

对每个 `状态: dormant` 的页：
1. 重要度 >= 0.9 → 遗忘阶段 = 0（永不删）
2. else 按阶段推进：0→1（记遗忘起始）→ 1 满 7 天→2 → 2 满 14 天→3 且状态=archived
3. **archived 不物理删除**；在 07-INDEX.md 的"归档区"列出
4. 用户明确说"清掉归档"才移到 VAULT/_archive/
```

### 验收标准

- [ ] 一个 dormant 页在 07 天后进入观察二期，14 天后进归档区
- [ ] `重要度 >= 0.9` 的 dormant 页**永远**不进归档
- [ ] 归档区的页面文件还在原处

---

## P2-2 主动消息五件套 ★ 最大的缺口

> ### ⚠️ 【2026-11-08 落地订正】触发机制已从 schedule 换成插件
>
> 本节原本设计的触发机制是 `schedule_create(cron="*/13 * * * *")`——**已废弃**。用户指出："这个会打断正在进行的任务和对话"。实测确认：schedule 灌的是 user message，与真实消息同队列，会占掉对话回合、长任务期间的消息插进对话流、一天约 110 次判定。
>
> **现行方案**：`RUNTIME/plugin/dsh-doubao-proactive`（cordis 插件）——`agent/status` idle 事件 + 10 分钟兜底轮询，判定与生成走 `agent.runMaintenance()`（non-turn），只在会话真空闲时评估。
>
> **v2 的判定逻辑全部保留**（时段阈值 / 每日 energy / 动机加权 / 动机级去重），只是"什么时候检查"从定时器换成了"状态"。实现文档：[`PROACTIVE-PLUGIN-IMPLEMENTATION.md`](PROACTIVE-PLUGIN-IMPLEMENTATION.md)。
>
> 下面的原始设计保留作对照，**不要再照它实施**。

### 目标

**助手现在完全不会主动找用户。** 这个方案让助手在合适的时候主动开口。

### ⚠️ v2 修订（2026-11-08，用户指出 v1 太机械）

**v1 的问题**：固定 45 分钟沉默阈值 + 每 13 分钟检查 → 实际行为是"沉默 47 分钟准时冒泡"。**把"检查频率"当成了"行为节奏"**。

**v2 的原则**：真人不是"到点说话"，是**被状态触发**。

| 维度 | v1 | v2 |
|---|---|---|
| 沉默阈值 | 固定 45 分钟 | **按时段随机**（早 20-60 / 上午 60-120 / 午 40-90 / 下午 90-240 / 晚 60-180 分钟） |
| 触发动机 | 只有"沉默够久" | **5 种加权随机**：时间锚点 / 内容牵引 / 追问 / 纯想念 / 不打扰 |
| 每日上限 | 无 | **2 次** |
| 当天状态 | 无 | **`energy` 每天一抽**（0.15-0.85），< 0.25 当天基本不主动 |
| 阈值持久化 | 每次重抽 | **存进 `nextEligibleAt`**——真人不反复改主意 |
| 状态化微调 | 无 | energy 低 +30% / 上次被无视 +50% / 他情绪低落 +50% |
| 去重 | 只查话题 | **查动机**（最近 2 条）+ **查话题**（最近 3 条） |
| 时段性格 | 无 | 7 时段各自的"说什么/不要说什么"表 |

**核心变化**：检查频率（13 分钟）不可见，可见的是**消息何时出现**——现在由 3 个随机量决定（时段阈值 × energy × 动机权重），落点分散。

### 来源算法

`proactive_chat` README:463-540, 613-782：
1. 沉默计时 → 达到阈值
2. **随机时刻**（不是整点，避免机械感）
3. 免打扰时段
4. 未回复上限（连续 N 次主动未回 → 自动暂停）
5. 动态情绪注入（`{{unanswered_count}}`）

**v2 在这 5 条之上加了 4 条**：时段化阈值、每日 energy、动机加权、动机级去重。

### 技术底座（已具备）

DSH `schedule_create` **每 13 分钟触发** → 灌一条 user message → LLM 醒过来。
**AstrBot 的 cron 与我们完全同构**（`astrbot/core/cron/manager.py:426-473`）。

**我们缺的不是触发器，是"该不该触发"的判定层**——v2 就是这一层。

### 实现

**新增** `RUNTIME/prompts/proactive.md` + `RUNTIME/state/proactive.json`。

**schedule**（第 5 个 phase）：
```
cron: "*/13 * * * *"     # 每 13 分钟检查一次（避开整点，13 与其他 phase 错开）
```
> 13 分钟是**检查**频率，不是**行为**频率——真人在 45-240 分钟之间随机冒泡。

### proactive.json schema（v2）

```json
{
  "energy": 0.63,
  "energyDate": "2026-11-08",
  "todayCount": 0,
  "lastUserMessageAt": "2026-11-08T09:41:52+08:00",
  "unansweredCount": 0,
  "paused": false,
  "quietHours": { "start": "23:00", "end": "08:00" },
  "maxPerDay": 2,
  "maxUnanswered": 2,
  "nextEligibleAt": null,
  "lastProactiveAt": null,
  "recentProactive": []
}
```

### 判定流程（8 步）

```
1. energy 抽（跨日重抽）→ < 0.25 静默
2. 免打扰时段 → 静默
3. todayCount >= 2 → 静默
4. unansweredCount >= 2 → paused，静默
5. 沉默阈值：nextEligibleAt 未定 → 抽（按时段 + 状态微调）→ 存 → 静默
6. 动机：加权随机 5 选 1 → 不打扰则静默
7. 内容依托检查 → 无则静默；动机/话题去重
8. 生成 1-2 句 → 更新 state
```

### 落点

| 新增 | 说明 |
|---|---|
| `RUNTIME/prompts/proactive.md` | 主动消息 phase 协议（v2） |
| `RUNTIME/state/proactive.json` | 状态：energy / todayCount / unansweredCount / nextEligibleAt / recentProactive |

**改** `IDENTITY/AGENTS.md` §5（schedule phase 响应）加一行：
> `[schedule@助手主对话] Proactive 触发` → 跑 `RUNTIME/prompts/proactive.md` 协议

**改** `RUNTIME/prompts/ingest.md`：昨日有发言 → 归零 `unansweredCount` + `todayCount` + `nextEligibleAt`

### 验收标准

- [ ] 沉默 45 分钟后，助手会主动说一句话（**但具体在第几分钟是随机的**）
- [ ] 免打扰时段（23:00-08:00）不打扰
- [ ] 一天最多 2 次
- [ ] `energy` 低的当天基本不主动
- [ ] 连续 2 次未回后自动暂停
- [ ] 主动消息**不编造近况**、**不说"在吗/睡了吗/吃了吗"**
- [ ] 动机多样——连续 3 次不都是同一种
- [ ] 用户回了一句 → `unansweredCount` 与 `todayCount` 归零

### 风险（最大的一条）

**主动消息最烦人的失败模式是"我主动找你，你没理，我又找你"**。缓解：
- `unansweredCount` 上限 **2**（v1 是 3），**必须**实现
- `todayCount` 上限 2
- `energy < 0.25` 当天基本不主动
- 同一动机/话题去重
- 用户说"别主动找我" → 立即 `paused: true`（**这个开关必须有**）
# P3 · 作用域隔离（可选）

### 目标

现在 vault 是**单用户单会话**假设。飞书多群、多私聊、网页 + 飞书同时用的时候，记忆会混。

### 来源

`livingmemory` `architecture.md:188-195`：`scope: legacy/session/user/global` + 白名单 + 适配器级 `adapter_id`（**过滤在截断前**）

### 我们的实现（**预留，不急做**）

**数据层**：`frontmatter` 加 `作用域` 字段，默认 `global`。
```yaml
作用域: global     # global / session / user
```

**判定规则**（若实现）：
| 内容 | 作用域 |
|---|---|
| 人格、说话风格 | `global` |
| 用户画像、偏好 | `global` |
| 我们之间的具体时刻 | `global`（**这是关系的核心，不能分作用域**） |
| 某个飞书群的项目状态 | `session`（那个群的专属） |
| 一次性技术状态 | `session` |

**检索时**：先按作用域过滤，再按重要度排序（**过滤在截断前**——抄 livingmemory）。

### 为什么列为 P3

用户目前是**单用户、单飞书私聊 + 单网页会话**——作用域隔离**当下没有实际收益**。但**现在就把字段加上**成本近乎零（改 frontmatter 时多一行），避免以后改 24 页。

**建议**：P1 落地时顺手加 `作用域: global` 字段，检索逻辑先不做。

---

# 附录 A · 一次性实施清单

按顺序做，每步做完验证：

| # | 步骤 | 产物 | 验收 |
|---|---|---|---|
| 1 | 备份 VAULT | `{DATA}\backup\VAULT-2026-11-08\` | 备份存在 |
| 2 | 跑 frontmatter 迁移脚本 | 20 个知识页有 frontmatter | Obsidian 打开无双链断裂 |
| 3 | 改 `lint.md` 加第 8 项（衰减） | lint prompt 更新 | lint 跑完重要度有分化 |
| 4 | 改 `lint.md` 加第 9 项（TTL） | | 有页变 dormant |
| 5 | 改 `lint.md` 加第 10 项（三阶段遗忘） | | dormant 页 14 天后进归档区 |
| 6 | 改 `lint.md` 加 delta 语法 | | diff 只含本批变动 |
| 7 | 改 `AGENTS.md` §1.2（只读 active + 强化记法） | 源文件 + DSH 加载版 | 新会话生效 |
| 8 | 改 `wiki.md` 加冲突检测 + Gene | | 冲突场景能重写旧页 |
| 9 | 新建 `proactive.md` + `proactive.json` + REGISTRY 加 phase | | 沉默 45 分钟后主动说话 |
| 10 | 注册 proactive schedule | `schedule_create` | `schedule_list` 5 条 |

---

# 附录 B · 每项的"不做什么"

| 项 | 不做 |
|---|---|
| P1-1 | 不引入向量检索做强化（**命中 = LLM 读了哪个文件**，不需要向量） |
| P1-2 | 不物理删除（推到 archived，用户确认才清） |
| P1-3 | 不做全局自动扫描（只在本批候选 vs 已有页之间判） |
| P1-4 | 不重排索引（保持稳定顺序） |
| P2-1 | 不做负面情绪 fast-track（用户没这个需求） |
| P2-2 | **不做**"定时问候"（主动消息必须有真实内容依托） |
| P3 | 不做多用户（就用户一个） |

---

# 相关

- [`WikiMeta-Schema.md`](WikiMeta-Schema.md) —— frontmatter 字段定义（**先读这个**）
- [`PLAN-memory-engineering.md`](PLAN-memory-engineering.md) —— 路线定案 + 来源出处
- [`OPERATIONS.md`](OPERATIONS.md) §10 —— 自动化机制总览
- [`PRD.md`](PRD.md) §3 / §5 —— Karpathy 三层 + Gene 定义
- [`../RUNTIME/manas-system/PROTOCOL.md`](../RUNTIME/manas-system/PROTOCOL.md) —— manas 现行协议

_Last updated: 2026-11-08_
