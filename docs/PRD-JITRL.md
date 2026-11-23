# PRD · JitRL 优势调制接入主动搭讪（v0.1）

> 状态：草案（待用户 review）
> 作者：助手
> 日期：2026-11-18
> 关联：[JitRL 论文](https://arxiv.org/abs/2601.18510) · 本地验证 `D:\dsh\_research\jitrl-mini\`

## 1. 背景

主动搭讪是插件里唯一"我主动找他"的通道。现在它选主题用的是**静态先验分**：

```js
// lib/proactive/themes.js selectTheme()
if (currentAxis && seed.axis === currentAxis) score += 40
if (!st || st.saidTimes === 0) score += 25
if (st?.lastSaidAt) score += ...
if (st?.stage === 'introduced') score += 10
```

这些权重是人手定的，不随"他实际对什么有反应"变化。结果是：聊得对不对，全靠手调规则和素材质量。

JitRL 提供了另一条路：**把"这条主题在类似语境下被回应得如何"变成对选择分布的数值偏置**，不训练、不改 prompt、不往上下文里塞经验文本。

本地已验证（`_research/jitrl-mini/`）：

| 组 | 成功率 |
|---|---|
| control（无记忆） | 5/16 |
| JitRL（有记忆） | 13/16（后半段 100%） |

## 2. 目标 / 非目标

**目标**

- 用 JitRL 的 `Â = Q̂ − V̂` 调制 `selectTheme` 的候选排序，让主题选择随"他的反应"漂移
- 零额外 LLM 调用（反馈来自状态机：他回没回、多久回）
- 默认关闭；开启后出错必须无损回退到现有逻辑
- 决策可审计：每次选择有一条日志（候选、先验分、Â、采样结果）

**非目标**

- 不调制主对话回复（开放生成，没有封闭候选集）
- 不引入 embedding / 向量库（状态签名用离散桶）
- 不改 `decide()` 的闸门（免打扰、能量、最小间隔、未回上限全部保持原样）
- 不做 LLM judge（P2 再议，先用行为信号）

## 3. 术语

| 术语 | 含义 |
|---|---|
| 种子（seed） | 一条可说的主题素材（梗、偏好断言、daily 关系向条目） |
| 动作 | 选中某个种子 = 这一轮主动搭讪的动作 |
| 状态签名 | 当前语境的离散化字符串（时段/劲能/沉默时长/上一轮是否被回/当前轴） |
| 回报 | 这条搭讪在他眼里的结果：被回复 +1，未回复 −1 |
| Â | 优势：这个动作在类似语境下比平均水平好多少 |

## 4. 设计

### 4.1 接入点

`lib/proactive/index.js:691` 的 `selectTheme(seeds, themeStates, opts)`。

- **候选集**：`selectTheme` 里通过冷却/去重过滤后的 seeds（只有它们有资格被选）
- **只对先验分 top-8 候选做调制**：防止冷门种子靠随机噪声上位（JitRL 的探索项在插件场景里收益低、风险高）
- **不改 `decide()`**：选完主题后照旧走动机推导、闸门、发送

### 4.2 状态签名

`stateSig = ` 五段拼接，段间用 `|`：

| 段 | 取值 | 来源 |
|---|---|---|
| 时段 | morning(7-9) / forenoon(9-12) / noon(12-14) / afternoon(14-18) / evening(18-23) / night | `now.getHours()` |
| 劲能 | low(<0.4) / mid(0.4-0.7) / high(>0.7) | `state.energy` |
| 沉默 | <30m / 30-120m / 2-6h / 6-24h / >24h | `now - lastUserMessageAt` |
| 上轮结果 | replied / unanswered / none | `state.unansweredCount` + `pending` |
| 轴 | relation / current / none | 住相给的 `currentAxis` |

例：`evening|mid|2-6h|replied|relation`

### 4.3 动作与相似度

- 动作 id = `seed.id`（`asciiId` 生成，稳定）
- 邻居召回：**同 stateSig 精确匹配**优先；不足 `minNeighbors` 时放宽到"同轴"（`axis` 相同）
- 每轮最多取 16 条最近邻

### 4.4 回报信号（零 LLM）

每条搭讪发送时写一条 `pending` 记录。结算只有两个入口：

| 事件 | 回报 |
|---|---|
| 真人回复（`noteHumanReply`，`source.kind === 'user'`） | +1，且回复延迟 <15 分钟额外 +0.2 |
| 下一条搭讪发出时上一条仍未回 | −1（超过 `replyWindowMs` 也按未回结算） |
| 他明确说"别烦我" | 由人工/后续规则另记（P2） |

写回 `(stateSig, action, return)` 到记忆文件，`pending` 清空。

> 为什么不用"回复情绪"当信号：情绪判定要 LLM，成本与噪声都不划算。行为信号（回/不回）
> 已经是"偏好"的直接投影——这正是用户要的"长期偏好"。

### 4.5 优势估计（JitRL 内核，对齐官方 jitrl_agent.py L294-383）

```
Q̂(a) = mean(动作 a 的邻居回报，relaxed 行先乘 0.5)
V̂   = mean(已见动作 Q̂)                      // 基线重算：动作级，不是邻居级
Â(a) = (Q̂(a) − V̂) × n_a/(n_a + shrink)      // 小样本收缩，shrink=4
Â    = Â / max|Â|                            // max-normalize，尺度固定到 [-1,1]
β(t) = β0 × min(1 + rows/maturityRows × 0.5, 1.5)   // 成熟度权重
```

**借自官方、我们此前缺的三个方法：**

1. **max-normalize**：官方把优势归一化到"最大正=1 / 最大负=−1"，让 Â 尺度固定。
   我们之前 shrink 后直接 clip，实际值常常只有 ±0.2 ⇒ β 必须手调（3→10 才见效）。
2. **成熟度权重**：官方 `episode_weight = min(1 + episode/50×0.5, 1.5)`。
   记忆少时调制弱、多了才放开，替代我们 `minNeighbors` 的一刀切。
3. **基线重算**：官方在给未见动作赋值后重算基线；我们改为按动作 Q̂ 的均值重算
   （从邻居级到动作级），避免"邻居数量多"的动作主导基线。

**与官方的刻意偏离**：官方对未见动作以探索概率给正 bonus、否则给 0 再重算基线，
这会让未见动作的优势变成 −baseline（负）。在没有探索项的情况下会把候选池锁死
（新种子永远选不到）⇒ 本实现保持"未见动作 Â=0（中性）"，宁可不选，也不主动惩罚。

**relaxed 降权**：邻居不足时放宽到"同轴"召回的行标记 `relaxed`，回报先乘
`relaxedWeight`（默认 0.5）再参与 Q̂——轴级相似度只算"沾边"，不能和精确签名同权。

邻居不足 `minNeighbors`（默认 3）⇒ 全部 Â=0 ⇒ 退化为原排序。

### 4.6 调制与采样

```
z(a)  = 先验分 / scale                     // scale=40，把 0~80 的先验分压到 0~2
z'(a) = z(a) + β · Â(a)                    // β=1.5
p(a)  = softmax(z' / T)                    // T=0.7
采样    （不是 argmax；保留少量探索）
```

- 先验分 top-1 与 top-2 差距大时，采样几乎等于 argmax
- 记忆改变的是差距小的场景——正好是"他可能对哪个更有反应"不确定的时候

### 4.6.1 verbalized logit（论文降级实现）

拿不到 `logprobs` 的端点（MiniMax、大多数中转、API 黑盒模型）走这条路，
对应官方实现的 `--confidence_mode verbalized`：

1. 一次 LLM 调用，让模型对每个候选输出 0–100 的置信度（JSON）
2. `p = confidence / 100`（官方实现直接除 100，不做 softmax）
3. `z' = p + β·Â`
4. 取最大（官方是 argmax；本实现保留采样开关）

与 token 档的区别：分数来自模型**自评**，不是真实分布；但它平滑得多，
优势项真的能翻转它——实测 DeepSeek 的 `top_logprobs` 在选择题上会饱和到
0.99999，β 再大也翻不动；verbalized 的 72/85/60 却能正常调制。

**降级**：打分调用失败 / 解析失败 / 无模型 ⇒ 回退规则先验分，行为与关闭时一致。

**配置**：`proactive.jitrl.scoring = 'rule' | 'verbalized'`。默认 `rule`（零额外调用）；
`verbalized` 每次决策多一次打分调用。

**实测**（2026-11-18，DeepSeek `deepseek-chat`）：

```
raw:    {"scores": {"1": 72, "2": 85, "3": 60}}
parsed: { 1: 72, 2: 85, 3: 60 }
probs:  { 0: 0.72, 1: 0.85, 2: 0.6 }
```

### 4.7 降级与安全

任一条件成立 ⇒ 走原 `scored.sort()[0]`（argmax），并写日志：

- `cfg.jitrl.enabled === false`（默认）
- 候选 < 2
- 邻居 < `minNeighbors`
- 记忆文件读/写失败
- 任意异常（`try/catch` 兜底）

**永远不改 `decide()` 的闸门**：免打扰、能量、间隔、未回上限仍由原逻辑先判。

### 4.8 存储

独立文件：`<dataRoot>/RUNTIME/state/jitrl-proactive.json`

```json
{
  "version": 1,
  "rows": [{ "sig": "evening|mid|2-6h|replied|relation", "action": "x7f3", "ret": 1.0, "at": "2026-11-18T21:00:00+08:00" }],
  "pending": { "x7f3": { "sig": "...", "sentAt": "...", "replyDeadline": "..." } }
}
```

- `maxRows` 默认 500，超出按时间淘汰
- 写盘走插件现有 `writeState` 风格的原子写（tmp + rename）
- 与 `proactive.json` 分离：JitRL 故障不污染主状态机

### 4.9 配置

`lib/config.js` 的 `proactive` 下新增：

```js
jitrl: z.object({
  enabled: z.boolean().default(false),
  beta: z.number().default(1.5),
  shrink: z.number().default(4),
  scale: z.number().default(40),
  temperature: z.number().default(0.7),
  minNeighbors: z.number().default(3),
  topCandidates: z.number().default(8),
  replyWindowMs: z.number().default(86400000),
  maxRows: z.number().default(500),
}).default({})
```

**设置页开关**：`enabled` 声明为 `.volatile()`，因此会出现在插件的 Settings 表单里
（已验证 `volatileForm` 输出包含 `proactive.jitrl.enabled`）。它是**现读**的
（`getJitrlEnabled()`），切换后立即生效，不用重启插件；其余调参字段是普通配置，
改动会走 Cordis 配置编辑、由 DSH 重建插件。

### 4.10 全局接入（决策点注册）

同一个服务（`lib/jitrl/service.js`）接管所有"有候选集"的决策：

| 决策点 | 候选 | 打分 | 信号 | 状态 |
|---|---|---|---|---|
| `proactive.theme` | 主题种子 | rule / verbalized | 他回/不回 | 已接（默认开） |
| `snapshot.dims` | SOUL 7 维追问 | 关键词先验 / verbalized | 下一轮他的反应（弱） | 已接（默认关） |
| `snapshot.themes` | vault 主题 top-3 | 字面重合先验 | 同上 | 预留 |
| `memory.recall` | 记忆条目 | — | 被引用后是否有效 | 预留（信号未定义） |

- 记忆按 `point` 隔离（`jitrl-proactive.json` / `jitrl-snapshot.json`），互不串味；
  旧行没有 `point` ⇒ 视为通用行，仍可被任何决策点使用。
- `snapshot.dims` 的回报是**弱信号**：`replyReward` 按他下一轮消息的长度/不满词
  给 −1 / 0.3 / 0.7 / 1。归因天然弱（住相不是一条独立消息），所以默认关闭，
  且 `minNeighbors` 会让它前几周基本不生效。
- 住相决策发生在**后台生成阶段**（agent 转 idle 后），不占用户等待时间；
  代价是每轮多一次打分调用（`scoring=verbalized` 时）。

### 4.11 退役：snapshot.dims（2026-11-19）

**实测否证**：住相作为"每轮注入的自我认识"在单轮设置下是负增益——无论 prefix 还是
system 注入，配对比较都显著拉低回复质量；按回复长度匹配后负增益仍在。住相内容多为
第一人称散文腔，回复随之变短；长度/内容特征与增益的相关都很弱。

⇒ `proactive.jitrl.snapshot` 与 `snapshot.dims` 决策点已**删除**。

**结论**：JitRL 不应调"住相的输出"，应调"住相的输入"（材料选择 + 更新时机），
回报改为**预测性**（离线回放：住相的判断是否被后续 1–3 轮证实）。

### 4.12 接入：memory.recall（2026-11-19）

实验依据（内部研究，实验数据不随仓库分发）：

- 记忆召回的重要性有强区分度（同片段内候选分数差异显著）
- 信用加权召回显著优于字面召回（配对检验显著）
- 拟合显示「长期重要性」远重于「字面匹配」；实现取 0.2·字面 + 0.8·信用（避免完全忽略语境）

实现：

- `lib/jitrl/recall.js`：`loadRecallCredit` / `recallScore` / `rankRecall`
- 信用文件 `<dataRoot>/RUNTIME/state/recall-credit.json`；**不存在 ⇒ 退回纯字面**（与旧版一致）
- `snapshot/inputs.js` 的 `relevantThemes` 改用 `rankRecall`
- 过滤保留"字面 >0 或信用 >=70"，避免凭空召回无关主题
- 离线标注脚本：`RUNTIME/scripts/label-recall-credit.mjs`（一次性，成本可忽略）

## 5. 接口

新增 `lib/jitrl/`：

| 文件 | 职责 |
|---|---|
| `signature.js` | `stateSignature(state, now, currentAxis)` → string |
| `memory.js` | `load(store)`, `add(store, sig, action, ret)`, `neighbors(store, sig, axis, k)` |
| `kernel.js` | `estimateAdvantage(neighbors, actions, opts)`, `modulate(scores, adv, opts)`, `sample(z, T, rng)` |
| `index.js` | `selectWithAdvantage(seeds, states, opts)`：包装 `selectTheme`，调制后采样；`settle(pending, outcome)` |

`index.js:691` 改为：

```js
const picked = jitrlEnabled
  ? selectWithAdvantage(seeds, themeStates, { ...opts, store, state, nowIso })
  : selectTheme(seeds, themeStates, opts)
```

## 6. 验收标准

- [ ] `node --test` 全绿（新增 ≥10 个用例：签名、优势公式、收缩、clip、降级、采样分布、结算）
- [ ] `enabled=false` 时，`selectWithAdvantage` 与 `selectTheme` 返回**完全一致**（同种子、同分数）
- [ ] 邻居不足时返回原 argmax
- [ ] 记忆文件损坏时降级 + 日志，不抛异常
- [ ] 决策日志含 `sig / candidates / z / adv / chosen / degraded`
- [ ] 本地模拟：构造"回 A 不回 B"的历史，A 的被选概率显著高于先验（可单测断言）

### 6.1 实测状态（2026-11-20）

| 事实 | 来源 |
|---|---|
| `jitrl-decision` 日志 **176 条** | `RUNTIME/state/proactive.log` |
| `jitrl-proactive.json`（记忆/回报落盘）**不存在** | `RUNTIME/state/` 目录列举 |
| 当前日志 `decision` **291 条**，`"shouldSpeak":true` **0 条** | `RUNTIME/state/proactive.log` |
| 11-18 有 `shouldSpeak:true` **3 条**、`deliver` **14 条** | `RUNTIME/state/proactive.log.1` |
| `paused:false` / `unansweredCount:0` / `maxPerDay:null` | `RUNTIME/state/proactive.json` |

**结论**：不是算错了，是**永远拿不到回报**。而「主题选择」在「0 次发送」前提下没有价值——瓶颈在「要不要说」，不在「说哪个」。

因此本 PRD 的验收标准（§6）对 P2 之后的阶段**不充分**：它只验「关掉时行为不变」，没验「开着时数据有没有进来」。补一节 §6.2。

### 6.2 回报侧验收（2026-11-20 追加）

- [ ] `jitrl-proactive.json` 在 14 天内有 ≥ 10 行（说明结算真的落盘）
- [ ] `shouldSpeak:true` 不再恒为 0（说明发送链路与学习链路同时活着）
- [ ] `deliver-feishu-failed` 事件计入失败样本，不被当作中性
- [ ] 若 14 天后仍是 0 发送 → 执行 §8 的 P4（关闭而不是空转）

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 行为信号有偏（只回感兴趣的，但"感兴趣"就是偏好） | 可接受；信号只影响"选哪个"，不改"要不要说" |
| 小样本噪声放大 | shrink=4 + minNeighbors=3 + 只对 top-8 调制 |
| 探索选到冷门话题 | top-8 限制 + T=0.7；先验差距大时采样近似 argmax |
| 与现有状态机耦合 | 独立 JSON 文件，读写失败一律降级 |
| 他烦了却没明说 | 未回上限（原有机制）仍会先暂停 |

## 8. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| P0 | kernel + memory + signature + 单测（不接线） | 单测全绿 |
| P1 | 接 selectTheme，默认关闭，日志 + 降级 | 关闭时行为不变 |
| P2 | 结算信号（noteHumanReply / 下一条发送时） | 模拟历史驱动偏好 |
| **P2.5**（2026-11-20 插入） | **回报侧扩信号**：在线未回 −0.5 / 发送后他主动开新话题 +1.5 / `deliver-feishu-failed` 计失败样本。**不动动作空间** | §6.2 前两项 |
| P3 | （可选）LLM judge 做步级评分；主对话风格调制 | 另开 PRD |
| **P4**（2026-11-20 插入） | **止损**：若 P2.5 上线 14 天后仍 0 次发送 → `jitrl.enabled=false`，在 PRD 留结论（瓶颈在阈值判定，不在选择） | §6.2 第四项 |

> **为什么不改动作空间**：现在的问题不是"选错主题"，是"根本不发"。先把数据打通，再决定值不值得把动作从"主题"换成"时机"——那是一次重写 seed 打分与相似度的工程，不做在数据为 0 的时候。

## 9. 回滚

- 配置 `jitrl.enabled=false` 一行关闭
- 不删记忆文件不影响主流程
- git 回滚到合并前 commit 即可
