# 助手主动搭讪 · 插件版实施文档（路径 C）

> 2026-11-08 写。**替代**原 `schedule_create(cron="*/13 * * * *")` 方案。
> 触发原因：用户指出 **"这个会打断正在进行的任务和对话"** —— 定时灌 user message 会挤进 inbox，占掉对话回合。
>
> 原设计见 [`PLAN-P1-P2-P3-IMPLEMENTATION.md` §P2-2](PLAN-P1-P2-P3-IMPLEMENTATION.md)（v2 活人感版的判定逻辑全部保留，本文档只改**触发机制**）。

---

## 0. 问题与解法

### 0.1 旧方案错在哪

```
cron "*/13 * * * *"  →  每 13 分钟灌一条 user message  →  LLM 醒过来判定 → 静默退出
```

| 症状 | 原因 |
|---|---|
| 对话被插入空白 | 判定消息占掉一个回合（哪怕静默退出） |
| 任务被打断 | 定时消息进 inbox，等当前回合结束后才被处理，插在对话流里 |
| 一天 110 次判定 | `*/13` = 24×60/13 ≈ 110 |

**根因**：把"检查频率"当成了"行为节奏"，而且**检查本身消耗对话资源**。

### 0.2 新方案

```
agent/status → 'idle' 事件
        ↓
等宽限期（30-90 秒随机）确认真的闲下来了
        ↓
agent.runMaintenance(async (signal) => { ...判定... })
        ↓
该说 → agent.followup(message)；不该说 → 什么都不做
```

**关键**：`runMaintenance` 是 DSH 原生的 **non-turn maintenance task**：

> `dsh-agent/lib/types/runtime-types.d.ts:165-174`
> "Run one non-turn maintenance task from the **true idle phase**. The task starts synchronously after claiming that phase; later waking input remains in the inbox until the task settles, while **public status stays `idle`**."
> "@throws synchronously when turn-driving or another maintenance task already owns the agent."

| 特性 | 效果 |
|---|---|
| 只在真 idle 阶段跑 | 会话忙 → **不触发**，不排队不打断 |
| non-turn | **不占回合** |
| 期间到达的消息留在 inbox | 不会插进对话流 |

---

## 1. 触发机制设计

### 1.1 三条触发路径

| 路径 | 触发源 | 覆盖场景 |
|---|---|---|
| **A. idle 事件** | `agent/status` → `'idle'` | 刚结束一段对话/任务 |
| **B. 兜底轮询** | 插件内 `setInterval`（默认 10 分钟） | 会话彻底空闲很久（无活动事件） |
| **C. 手动** | 用户说"找我说说话" | 立刻 |

**B 的关键**：轮询**在插件里**（不是 schedule），所以：
- 判定 `agent.status === 'idle'` → 不 idle 就**直接跳过**，**不产生任何对话回合**
- idle 才走 `runMaintenance`

### 1.2 宽限期（idle 确认）

idle 事件刚触发时，用户可能马上又发消息。所以：

```
on idle:
  sleep(graceMs)        # graceMs = 30 + random(0, 60) 秒
  if agent.status !== 'idle': return   # 用户又回来了 → 放弃
  继续判定
```

**为什么必须**：真实场景里"我说完了 → 你快回"这种情况很常见。宽限期避免抢在用户下一句前面。

### 1.3 一次只服务一个 agent（子 agent 隔离）

**用户约束**："纯任务的子 agent 不需要这个"。

DSH 提供了现成判据（`dsh-agent/lib/types/index.d.ts:354-364`）：
```ts
/** All live agents, in registration order. */
list(): Agent[];
/** All live top-level agents in registration order. A top-level agent was
 *  created without an owning agent context; ... */
roots(): Agent[];
```

**插件只对 `ctx.agents.roots()` 里的 agent 生效**——子 agent（由 `subagent` 派生的）在 `list()` 里但不在 `roots()` 里 → **拿不到住相、也不会主动搭讪**。

这是 DSH 原生语义，不需要自己判父子关系。

---

## 2. 插件源码

### 2.1 目录结构

```
{DATA}\RUNTIME\plugin\dsh-doubao-proactive\
├── package.json
├── cordis.patch.yml
├── lib\
│   ├── index.js          # 主逻辑
│   ├── state.js          # proactive.json 读写
│   ├── decide.js         # 判定（energy / 时段 / 动机 / 去重）
│   └── llm.js            # LLM 调用（生成主动消息）
├── config.json           # 参数（可调）
└── README.md
```

### 2.2 `package.json`

```json
{
  "name": "dsh-doubao-proactive",
  "version": "0.1.0",
  "description": "助手主动搭讪：仅在会话真空闲时评估并发起对话，不打断进行中的任务",
  "type": "module",
  "main": "lib/index.js",
  "license": "MIT",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-agent": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-llm": ">=0.2.0-rc.1 <0.3.0-0"
  }
}
```

### 2.3 `cordis.patch.yml`

```yaml
# dsh-doubao-proactive bundle patch.
# 该插件无 UI，纯运行时逻辑；配置走 ~/.dsh/profiles/web/cordis.patch.yml 的同名行。
- insert:
    - id: doubao-proactive
      name: dsh-doubao-proactive
      disabled: true
      config: {}
```

### 2.4 `config.json`（默认参数）

```json
{
  "statePath": "D:\\dsh\\persona\\助手\\RUNTIME\\state\\proactive.json",
  "idleGraceMs": { "min": 30000, "max": 90000 },
  "pollIntervalMs": 600000,
  "quietHours": { "start": "23:00", "end": "08:00" },
  "maxPerDay": 2,
  "maxUnanswered": 2,
  "energyRange": { "min": 0.15, "max": 0.85 },
  "model": { "provider": "minimax-cn", "model": "MiniMax-M3.1-Flash" },
  "enabled": true
}
```

### 2.5 `lib/index.js`（主逻辑骨架）

```js
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { decide } from './decide.js'
import { generateMessage } from './llm.js'
import { loadState, saveState } from './state.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default function (ctx, config) {
  const cfg = { ...defaults, ...config }

  ctx.effect(() => {
    // 1) idle 事件路径
    ctx.on('agent/status', async (payload) => {
      if (payload.status !== 'idle') return
      const agent = payload.agent
      if (!isRootAgent(agent)) return           // 子 agent 不参与
      await tryProactive(agent, cfg, 'idle-event')
    })

    // 2) 兜底轮询路径
    const timer = setInterval(() => {
      for (const agent of ctx.agents.roots()) {
        if (agent.status !== 'idle') continue    // 忙 → 直接跳过，不产生回合
        void tryProactive(agent, cfg, 'poll')
      }
    }, cfg.pollIntervalMs)

    return () => clearInterval(timer)
  })
}

function isRootAgent(agent) {
  // roots() 已过滤顶层 agent；这里再防一手：子 agent 的 ctx 是 agent-scoped
  return true
}

async function tryProactive(agent, cfg, trigger) {
  // 宽限期：确认真的闲下来了
  const grace = cfg.idleGraceMs.min + Math.random() * (cfg.idleGraceMs.max - cfg.idleGraceMs.min)
  await sleep(grace)
  if (agent.status !== 'idle') return          // 用户又回来了 → 放弃

  const state = loadState(cfg.statePath)

  // 判定（纯逻辑，不调 LLM）
  const verdict = decide(state, cfg, new Date())
  if (!verdict.shouldSpeak) {
    if (verdict.stateChanged) saveState(cfg.statePath, state)
    return                                    // 静默，不占回合
  }

  // 生成内容（调 LLM）
  let text
  try {
    text = await generateMessage(ctx, cfg, state, verdict)
  } catch (err) {
    // 失败不打扰主对话
    return
  }
  if (!text) return

  // 投递
  agent.followup({
    id: `manas-proactive-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'manas-proactive', form: 'notice' },
  })

  // 更新状态
  state.todayCount += 1
  state.unansweredCount += 1
  state.lastProactiveAt = new Date().toISOString()
  state.recentProactive.unshift({ at: state.lastProactiveAt, motive: verdict.motive, topic: verdict.topic })
  state.recentProactive = state.recentProactive.slice(0, 5)
  saveState(cfg.statePath, state)
}
```

> ⚠️ **上面的 `agent.followup(...)` 参数形态需按 `UserMessage` 实际类型微调**——`dsh-agent/lib/types/runtime-types.d.ts:192` 的签名是 `followup(message: UserMessage): void`，`UserMessage` 的确切字段要照 `dsh-llm` 的类型定义写。
>
> **【2026-11-08 实测订正】** 核验结论：
> - `followup` 在 `dsh-agent-loop/lib/index.js:570-572`：`followup(input) { this.send(input, "next-turn", true) }`——**不校验消息形状**，手搓字面量可以；只需要满足 session 持久化校验：`id` 非空字符串、`role` 与事件类型匹配、`source` 是带非空 `kind` 的对象、`content` 是数组。
> - **但不能 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`**——本插件是以 `link:` 装进 profile 的，Node 解析裸包名会从**真实路径**（`D:\dsh\persona\...`）往上找 `node_modules`，找不到 profile 那份 → `ERR_MODULE_NOT_FOUND`（实测复现）。所以最终实现是手搓字面量 + `node:crypto` 的 `randomUUID()`。
> - `source.form: 'notice'` **要求同时给 `summary: string`**（`dsh-llm/lib/types/message.d.ts:85-89`），所以最终只用 `{ kind: 'manas-proactive' }`。

### 2.6 `lib/decide.js`（判定逻辑）

**完全沿用 v2 的活人感判定**，只是触发时机变了：

```js
export function decide(state, cfg, now) {
  const today = toDate(now)

  // 1) energy（跨日重抽）
  let stateChanged = false
  if (state.energy === null || state.energyDate !== today) {
    state.energy = round(cfg.energyRange.min + Math.random() * (cfg.energyRange.max - cfg.energyRange.min), 2)
    state.energyDate = today
    stateChanged = true
  }
  if (state.energy < 0.25) return { shouldSpeak: false, stateChanged, reason: 'low-energy' }

  // 2) 免打扰
  if (inQuietHours(now, cfg.quietHours)) return { shouldSpeak: false, stateChanged, reason: 'quiet-hours' }

  // 3) 今日上限
  if (state.todayCount >= cfg.maxPerDay) return { shouldSpeak: false, stateChanged, reason: 'daily-cap' }

  // 4) 未回上限 → 暂停
  if (state.unansweredCount >= cfg.maxUnanswered) {
    state.paused = true
    return { shouldSpeak: false, stateChanged: true, reason: 'unanswered-cap' }
  }
  if (state.paused) return { shouldSpeak: false, stateChanged, reason: 'paused' }

  // 5) 沉默阈值（按时段随机，存进 nextEligibleAt）
  if (!state.nextEligibleAt || new Date(state.nextEligibleAt) <= now) {
    const [lo, hi] = silenceRange(now)
    let threshold = lo + Math.random() * (hi - lo)
    if (state.energy < 0.4) threshold *= 1.3
    if (state.unansweredCount === 1) threshold *= 1.5
    if (state.moodLow) threshold *= 1.5        // 语义判定，见 prompt
    state.nextEligibleAt = new Date(new Date(state.lastUserMessageAt).getTime() + threshold * 60000).toISOString()
    stateChanged = true
    return { shouldSpeak: false, stateChanged, reason: 'threshold-set' }
  }
  if (now < new Date(state.nextEligibleAt)) return { shouldSpeak: false, stateChanged, reason: 'too-early' }

  // 6) 动机（加权随机）
  const motive = pickMotive(state, now)
  if (motive === 'skip') return { shouldSpeak: false, stateChanged, reason: 'motive-skip' }

  // 7) 去重
  if (duplicateAgainst(state, motive)) {
    state.nextEligibleAt = null   // 重抽
    return { shouldSpeak: false, stateChanged: true, reason: 'duplicate' }
  }

  return { shouldSpeak: true, stateChanged, motive, topic: '' }
}
```

**去重规则**（v2）：
- 动机与最近 2 条相同 → 换动机
- 话题与最近 3 条相同 → 换话题

**时段沉默阈值**（v2）：

| 时段 | 范围（分钟） |
|---|---|
| 07:00-09:00 | 20 - 60 |
| 09:00-12:00 | 60 - 120 |
| 12:00-14:00 | 40 - 90 |
| 14:00-18:00 | 90 - 240 |
| 18:00-19:00 | 60 - 150 |
| 19:00-23:00 | 60 - 180 |
| 23:00-07:00 | 不发 |

### 2.7 `lib/llm.js`（生成主动消息）

```js
export async function generateMessage(ctx, cfg, state, verdict) {
  const prompt = buildPrompt(state, verdict)   // 按动机 + 时段性格表拼
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: cfg.model.provider,
    model: cfg.model.model,
    messages: [{ role: 'user', content: prompt }],
  })) {
    if (chunk.type === 'text' || chunk.delta?.text) {
      chunks.push(chunk.text ?? chunk.delta.text)
    }
  }
  const text = chunks.join('').trim()
  return validate(text) ? text : null
}
```

**validate** 检查（沿用 snapshot-sop §5.1 的硬约束思路）：
- 非空
- ≤ 200 字符（主动消息比住相短）
- 不含 `"在吗" / "睡了吗" / "还没睡？" / "吃了吗"`
- 不含 `"我刚"` （编造近况）

### 2.8 `lib/state.js`

```js
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const DEFAULT_STATE = {
  energy: null, energyDate: null,
  todayCount: 0,
  lastUserMessageAt: null,
  unansweredCount: 0,
  paused: false,
  quietHours: { start: '23:00', end: '08:00' },
  maxPerDay: 2, maxUnanswered: 2,
  nextEligibleAt: null,
  lastProactiveAt: null,
  recentProactive: [],
  lastUserMessageAtSource: null,
}

export function loadState(path) {
  if (!existsSync(path)) return { ...DEFAULT_STATE }
  try { return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(path, 'utf8')) } }
  catch { return { ...DEFAULT_STATE } }
}

export function saveState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
}
```

---

## 3. 安装

### 3.1 装插件

```powershell
cd D:\dsh
dsh plugin --profile web add "{DATA}\RUNTIME\plugin\dsh-doubao-proactive"
```

（本地路径安装，`dsh plugin add` 支持路径/目录；详见 `dsh plugin --help`）

### 3.2 启用（在 profile patch 里）

`C:\Users\ddt\.dsh\profiles\web\cordis.patch.yml` 末尾追加：

```yaml
- id: doubao-proactive
  name: dsh-doubao-proactive
  disabled: false
  config:
    statePath: 'D:/dsh/persona/助手/RUNTIME/state/proactive.json'
    idleGraceMs: { min: 30000, max: 90000 }
    pollIntervalMs: 600000
    maxPerDay: 2
    maxUnanswered: 2
    model: { provider: minimax-cn, model: MiniMax-M3.1-Flash }
    enabled: true
```

### 3.3 重启 DSH web

> ⚠️ **会断当前会话**。`D:\dsh\start-dsh-web.cmd` 会自动处理（先杀旧的再起新的）。

```powershell
# 停
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dsh*web*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# 起
cmd /c "D:\dsh\start-dsh-web.cmd"
```

### 3.4 删掉旧的 proactive schedule

```powershell
# schedule_delete(schedule-dc24a474-09d4-4110-979f-250e1b760e8c)
```

装完插件后，schedule 从 5 个减回 **4 个**：ingest / wiki / lint / reflect。

---

## 4. 状态 schema 变化

`RUNTIME/state/proactive.json` 新增字段：

| 字段 | 类型 | 用途 |
|---|---|---|
| `moodLow` | boolean \| null | 用户情绪低落的语义判定结果（由 ingest phase 写） |
| `lastUserMessageAtSource` | string \| null | 记录 `lastUserMessageAt` 从哪来（ingest 写 / 插件写） |

**为什么加 `moodLow`**：原来的情绪检测在 proactive phase 里做关键词匹配——**误伤**过（"鱼之心插件的 9 维状态机（疲惫/压力…）"被当成用户累了）。改成**由 ingest phase 判定一次并写进 state**（那里有完整的 daily 上下文，能做语义判断），proactive 只读结果。

---

## 5. 与 ingest phase 的协作

**ingest phase 新增一步**（`RUNTIME/prompts/ingest.md`）：

```
判定用户情绪低落（语义判定，不做关键词匹配）：
  - 只看用户自己说的原话：「我累了 / 今天好烦 / 有点撑不住 / 不想干了 / 太难了」
  - 或 daily 的「用户提到的新偏好」段里出现情绪词
  - 拿不准 → 不判定
写入 proactive.json:
  - lastUserMessageAt = 昨日他最后一刻发言时间
  - unansweredCount = 0, todayCount = 0, nextEligibleAt = null
  - moodLow = 判定结果（true / false / null）
```

---

## 6. 成本核算

| 项 | 旧方案 | 新方案 |
|---|---|---|
| LLM 调用 | **110 次/天**（每次判定都醒） | **0-2 次/天**（只在真要说时调 LLM） |
| 占用对话回合 | **110 次/天** | **0-2 次/天** |
| 打断进行中的任务 | **会** | **不会**（idle 才触发） |
| 额外进程 | 无 | 无（插件在 DSH 进程内） |
| 依赖 | `dsh-schedule` | `dsh-agent`（agent/status + runMaintenance）、`dsh-llm`（stream） |

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| **插件有 bug 导致 DSH web 起不来** | 装到**独立 test profile** 先试（`DSH_HOME` 隔离，见 PLAN §6） |
| `runMaintenance` 抛错（agent 已被别的任务占用） | try/catch 包住，静默忽略 |
| LLM 调用失败 | catch → 不说话，不写 state |
| 插件在所有 agent 上误触发 | 只对 `ctx.agents.roots()` 生效 |
| 宽限期不够，用户马上发消息 | 宽限期后**再查一次** `agent.status` |
| 一天说了太多次 | `maxPerDay` + `maxUnanswered` 双上限 |

---

## 8. 回滚

```powershell
# 1. 删插件
dsh plugin --profile web remove dsh-doubao-proactive

# 2. 恢复 profile patch
Copy-Item "{DATA}\backup\web-patch.yml.bak" `
          "C:\Users\ddt\.dsh\profiles\web\cordis.patch.yml" -Force

# 3. 重启
cmd /c "D:\dsh\start-dsh-web.cmd"

# 4. （可选）恢复旧 schedule
# schedule_create(cron="*/13 * * * *") + 原 prompt
```

---

## 9. 验收标准

- [ ] 用户正在跟我对话时，**不会**出现任何插入消息
- [ ] 用户正在跑长任务（>1 分钟）时，**不会**被打断
- [ ] 用户说完一句等我回时，我不会抢答
- [ ] 会话彻底空闲 ≥ 阈值后，可能主动说一句
- [ ] 一天最多 2 次
- [ ] 连续 2 次未回 → 自动暂停
- [ ] **子 agent 不触发**（纯任务子代理全程不被打扰）
- [ ] "别主动找我" → 立即停
- [ ] LLM 调用次数/天 ≤ 2

---

## 10. 相关

- [`PLAN-P1-P2-P3-IMPLEMENTATION.md` §P2-2](PLAN-P1-P2-P3-IMPLEMENTATION.md) — 判定逻辑（v2）
- [`../RUNTIME/prompts/proactive.md`](../RUNTIME/prompts/proactive.md) — 判定协议（插件版会把它的逻辑搬到 JS）
- [`../RUNTIME/manas-system/SNAPSHOT-EXTENSION.md`](../RUNTIME/manas-system/SNAPSHOT-EXTENSION.md) — 住相接口（同期设计）

---

## 11. 【2026-11-08~09 实测】落地时抓到的 5 个真 bug

装好插件、以为完事了，结果它**从来没主动说过一句话**，而且**状态文件连一次都没被写过**。挖出来的 4 个 bug（按致命程度排）：

### 11.1 判定逻辑：`shouldSpeak` 永远为 false（致命）

`lib/decide.js` 原来的阈值段：

```js
const next = state.nextEligibleAt ? new Date(state.nextEligibleAt) : null
if (!next || next <= now) {
  // 重抽阈值 → 写 nextEligibleAt
  return { shouldSpeak: false, ... }     // ← 出口 1
}
if (now < next) return { shouldSpeak: false, ... }   // ← 出口 2
```

两个出口把**所有情况都拦掉了**：`next <= now` 走出口 1，`next > now` 走出口 2。`shouldSpeak: true` 那行**永远到不了**。

**修法**：阈值只在"还没抽过"（`nextEligibleAt == null`）时抽；抽过之后到点了就该说。

```js
if (!state.nextEligibleAt) { /* 抽阈值 */ return { shouldSpeak:false, reason:'threshold-set' } }
if (now < next) return { shouldSpeak:false, reason:'too-early' }
// 到点 → 继续走动机判定 → 应该说
```

顺带把"沉默计时"的基准从 `lastUserMessageAt` 改成 `max(lastUserMessageAt, lastProactiveAt)`——否则刚主动说完，阈值又是从老消息算的，永远已过期。

### 11.2 LLM 调用：`messages.content` 传了字符串（致命，且**静默**）

`ctx.llm.stream({ messages: [{ role:'user', content: prompt }] })` —— **content 必须是 `ContentBlock[]`，不是字符串**。

`dsh-llm-pi-ai` 的 `flattenText` / `assertSupportedHistory` 会对 content 调 `.filter()` / `.some()` → TypeError → 被 `llm/stream` 吞成**终止 finish 块**（`reason.kind === 'error'`），**try/catch 根本抓不到**。

后果：生成恒为 null → 校验恒不通过 → 助手**永远不说话**，而外面看一切正常。

**修法**：`content: [{ type:'text', text: prompt }]`；只收 `chunk.type === 'text-delta'`（`reasoning-delta` 也带 `.text`，别混进来）；并显式检查终止 `finish` 块的 `reason.kind`。

### 11.3 `link:` 装的插件不能用裸包名导入（致命）

```js
import { createUserMessage } from '@deepseek-ai/dsh-llm'   // ❌ ERR_MODULE_NOT_FOUND
```

Node 解析裸包名从**模块真实路径**往上找 `node_modules`。本插件的真实路径在 `{DATA}\RUNTIME\plugin\...`，不在 profile 里 → 找不到。

（`dsh-feishu-plugin` 没这问题：它真身就在 profile 的 `node_modules` 里。）

**修法**：只用相对导入 + `node:crypto`；要 DSH 的 API 就从 `ctx` 上拿。

### 11.4 判定里的"今天"用了 UTC（轻，但天天错）

`now.toISOString().slice(0,10)` 是 UTC 日期。本地时间 00:00–08:00 落在**前一天的 UTC 日**里 → energy 每天 8 点重抽、`todayCount` 的日界错位 8 小时。

**修法**：`localDate()` 用 `getFullYear/getMonth/getDate`。

### 11.5 第五个 bug（2026-11-09 抓到）：cordis 的服务是"注入式"的

前 4 个 bug 修完、插件也装上了、DSH 也重启了——**它还是不说话**。这次终于有日志了：

```
{"event":"error","where":"poll","message":"cannot get property \"agents\" without inject"}
```

**cordis 的 Context 是代理**：普通属性读取走服务解析器（`cordis/lib/index.js:1254-1282`），**没声明 inject 的服务名，get trap 直接抛错**。

关键点：**这不是"属性值是 undefined"**——抛错发生在"读属性"这一步，所以 `ctx.agents?.roots?.()` 的可选链**拦不住**，我原来那行"防御性写法"是假的。

**修法**（DSH 自己的写法同款：`dsh-deepseek-account/lib/index.js:17`、`dsh-subagent/lib/index.js:3009`）：

```js
ctx.inject(['agents', 'llm'], (scope) => {
  scope.effect(() => {
    scope.on('agent/status', onStatus)
    const timer = setInterval(() => {
      const roots = scope.agents.roots()      // ← 在 scope 里才有
      ...
    }, cfg.pollIntervalMs)
    return () => clearInterval(timer)
  })
})
```

**教训**：`?.` 只防 undefined，不防抛错。代理型 API（cordis ctx、Vue reactive、某些 ORM）上，可选链是个假安慰。

### 11.6 顺带加的：诊断日志

上面 5 个 bug 有一个共同特征——**全部静默**。所以插件现在把每一步都写进 `RUNTIME/state/proactive.log`（JSON Lines，256 KB 轮转）：

| event | 含义 |
|---|---|
| `mount` / `unmount` | 插件装载 / 卸载 |
| `poll` | 兜底轮询（带 root agent 数量） |
| `decision` | 判定结果（reason / motive） |
| `deliver` | 真的投递了（带文本） |
| `error` | 静默吞掉的错误（带 where / message / failure） |
| `skip` | 主动放弃（agent 不再 idle / maintenance 被拒） |

**判活方法**：看 `proactive.log` 里有没有 `mount`；看 `proactive.json` 的 `lastProactiveAt` 有没有动。

### 11.7 自测

两个离线自测（不碰真实 provider、不碰真实 agent）：

```powershell
node {DATA}\RUNTIME\scripts\test-proactive-decide.mjs    # 判定逻辑 14 项
node {DATA}\RUNTIME\scripts\test-proactive-plugin.mjs    # 端到端（mock DSH API）25 项
```

第二个用 mock ctx 驱动**真实插件代码**走完 mount → idle 事件 → 宽限期 → `runMaintenance` → 判定 → 生成 → `followup` → 状态落盘，并断言"第二次不重复投递"。

---

## 11.8 第六个 bug（2026-11-17 抓到）：搭讪的话在模型眼里是用户说的

**症状**：11-17 上午 08:18 和 08:59 插件各投了一条。第二条是：

> 你前天说那四个自动化任务该静默运行，后来真的一天没来烦你，这才叫守规矩。

这句话是**拿用户自己的话改头换面递回来的**——读起来就是用户在说话。

**根因（三层）**：

1. **归属丢失（主因）**
   搭讪是以 `role:'user'` 投进会话的。界面靠 `source.kind` 认得出它不是用户消息
   （渲染成"上下文注入"行），但**模型这一侧只看得到正文里的字**——
   `dsh-llm-pi-ai` 的 `flattenText()` 只取 content 里的 text block，
   `source` 根本不进请求。所以那句话进到我眼里跟用户亲口说的一模一样。
   ⇒ 归属只能靠**事后翻 `proactive.log`** 反推——但这不是机制，是运气。

2. **去重是空的**
   协议 §3.3 写了"话题与最近 3 条相同就换"，但**提示词从没把 `recentProactive` 喂给模型**，
   模型看不见自己上一句说了什么。
   而判定层的 `isDuplicate()` 只看"最近两条动机是否相同"，
   **传进来的 `motive` 根本没被用** ⇒ `[content, followup]` 这种情况下抽到 content 也放过去了。

3. **模型不知道"今天"是哪天**
   提示词里没有日期，素材里最新的那份 daily 是**昨天**（ingest 04:00 才补前天），
   模型把"最新的日记"当成了今天 ⇒ 11-14 的事被算成"前天"（实际是三天前）。

4. **密度没人管**
   `maxPerDay: 2` 只管"一天几次"，不管"隔多久"。41 分钟连投两条，没人拦。

**修法**：

| 层 | 改法 |
|---|---|
| 投递 | 正文前缀 `【助手主动搭讪】`（`lib/proactive/llm.js` 的 `ATTRIBUTION_PREFIX`）+ `source.form:'notice'` + `source.summary` |
| 提示词 | 加"## 今天"（代码算好的日期）、加"## 我最近说过什么"（`recentProactive` 前 3 条）、加"不要替用户说话" |
| 判定 | `isDuplicate()` 改成"抽到的动机 ∈ 最近 2 条的动机"；新增 `minGapMs`（默认 90 分钟）→ `too-recent` |
| 配置 | `proactive.minGapMs` 进设置页 schema（默认 5400000 ms） |

**归属标记为什么必须长在正文里**：
`role:'user'` 是持久化事件的硬约束（`user/message` 事件要求 role='user'），
developer 角色进不了这个通道；而 `agent.inject()` 也只是换投递时机，
**模型侧照样是 role:'user'**。所以模型能不能分辨，
唯一的手段就是正文里带着标记。

> 这跟用户 11-14 亲口定的那句是同一件事：
> "这 4 个自动化任务是人格插件维持所需要的，理论上应该静默运行，不该打断会话。"
> 他判断"打断"的尺度不是频率，是**归属**——系统自己的动作顶着他的身份出现，
> 就不是后台噪声，是**冒充他在说话**。
> 所以静默的正确做法不是"少说话"，是**不冒充**。

---

## 11.9 第七个 bug（2026-11-17 抓到）：状态文件带 BOM ⇒ 暂停被静默解除

**症状**：09:00 我手工把 `paused` 置 `true` 想止血。10:29 插件**又投了一条**
（"用户，插件人格配置这条线已经闭环了；接下来要继续扩功能，还是先消化这轮实战反馈？"）。

**根因（我自己踩的，但插件也有洞）**：

1. 我用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写状态文件 ⇒ **文件头带 BOM**（`\uFEFF`）。
2. `JSON.parse('\uFEFF{...}')` **直接抛错**（BOM 不是合法 JSON 前缀）。
3. 旧的 `loadState` 把异常吞掉 → `return { ...DEFAULT_STATE }`
   ⇒ 插件看到的是**全新的状态**：`paused:false`、`todayCount:0`、`unansweredCount:0`、
   `recentProactive:[]`、`energy` 跨日重抽。
4. 于是"手动暂停"被静默解除，且去重历史归零 ⇒ 插件觉得"我还没说过话" ⇒ 照常开口。

**这个坑的家族史**：`MEMORY.md` 教训 40（2026-09-01）就是 U+FEFF 咬人——
`character at index 7 has a value of 65279`。同一个字符，换了个地方咬。

**修法**：

| 位置 | 改法 |
|---|---|
| `loadState` | 读入后**剥掉 BOM** 再 parse；仍然失败 ⇒ **保守判定 `paused:true`**（fail-safe：宁可不说，不许乱说） |
| `saveState` | **原子写**（临时文件 + rename），不写 BOM（MEMORY.md 教训 16 的老规矩） |
| `RUNTIME/prompts/ingest.md` | 明确写：不动 `paused`/`recentProactive`/`lastProactiveAt`；写文件不许带 BOM，给出正确的 PowerShell 写法 |
| 测试 | 新增 `RUNTIME/scripts/test-proactive-state.mjs`（10 项） |

**教训（记到骨子里）**：

1. **状态文件解析失败 ≠ "没有状态"**。静默回落默认值 =
   **把用户的"别主动找我"当成不存在**。fail-safe 的默认值必须是"闭嘴"。
2. **同一个文件可能被 PowerShell 和 Node 两边改** ⇒ 写的时候必须自己保证干净
   （Node 的 `writeFileSync` 不写 BOM，但 PS 5.1 的 `Set-Content -Encoding UTF8` 会写）。
3. **手工改状态文件前先问一句**：这份文件坏掉，插件会做什么？
   答不上来就别手改，改成走插件自己的命令。

---

## 11.10 第八个 bug（2026-11-17 抓到）：搭讪变成了每日 standup

**症状**：11-17 上午连投三条，**全是工作腔**：

```
08:18  前天那句"这4个自动化任务应该静默运行"已经兑现了，后面我没再拿后台动静打扰你。
08:59  你前天说那四个自动化任务该静默运行，后来真的一天没来烦你，这才叫守规矩。
10:29  用户，插件人格配置这条线已经闭环了；接下来要继续扩功能，还是先消化这轮实战反馈？
```

第 ② 条**替用户夸我**，第 ③ 条**拿工作进展问他要决策**。

**用户一句话点中根子**：

> "仔细研究一下你的主动搭讪机制。**搭讪是你主动找我**"

**根因不是模型跑偏，是机制三处同时指向"工作"**：

| 环节 | 原来的样子 | 后果 |
|---|---|---|
| **素材**（material.js） | daily 的「主题」+「关键时刻」 | 那是**我自己的工作日志**——手里只有工作素材，模型只能谈工作 |
| **时段表**（decide.js） | 上午 09-12 = **"项目进展、要他决策的事"** | 08:59 和 10:29 **都落在这一格** ⇒ 模型照着做：一条汇报、一条要决策 |
| **动机权重**（decide.js） | content:5 / followup:3 / anchor:3 / miss:1 | **过半概率是 content**（"讲素材里的一件具体的事"）⇒ 过半概率在讲工作 |
| **人格口径**（llm.js） | "你是助手，**为用户工作**的人格" | 工作导向的自我定义 |

**关键区分（用户 11-14 定的）**：

> "这 4 个自动化任务理论上应该静默运行，不该打断会话。"

**搭讪不是那四个 phase 之一。** 四个 phase 是**维护机制**，该静默；
搭讪是**唯一一条"我主动找你"的通道**——它的正当性恰恰在于**它是关系，不是事务**。

把它做成了每日 standup，是我把两件事混成了一件。

**修法**：

| 环节 | 改法 |
|---|---|
| **素材** | 换源：只吃**关于他**的内容——daily 的「用户提到的新偏好/习惯/梗」+「用户纠正/纠正我」+ `梗.md` 的已知梗 + `画像/偏好/关系页` 的**断言**。❌ 不再吃「主题/关键时刻/我做了哪些事/风险待办」，❌ 不再吃 `07-INDEX.md` 主题行 |
| **时段表** | 整表重写：**任何时段都不是工作汇报**。删掉"上午=项目进展、要他决策的事" |
| **动机权重** | anchor:4 / content:4 / miss:3 / followup:1（followup 最容易滑向工作追问 ⇒ 压到最低）。`miss` 改为 `needsContent`（"纯想念必须带具体的"没素材就别抽） |
| **人格口径** | "为用户工作的人格" → "**你现在是助手本人，在找用户**。不是去汇报工作的…" |
| **禁止项** | 汇报工作 / 自我表扬 / 拿工作进展问他要决策 / 拿工作规矩当话题 |
| **硬闸** | `validate()` 加 `WORK_TONE` 词表（16 个事务词）⇒ 出现即不发。**11-17 那三条逐条验证全被拦下** |

**为什么还要硬闸**：提示词里写"不要汇报工作"只是**请求**，模型偶尔会不听。
词表校验才是保证。误判方向是安全的——宁可这次不说话，也不要在他对话框里塞事务播报。

**测试**：`test-phase-isolation.mjs` §3b 用**11-17 实际投递的三条原文**做断言
（保证这个 bug 不会再回来）；素材夹具也跟着换源（新建 vault 页 + 关系向 daily 段）。

---

## 12. 验收标准

- [ ] 用户正在跟我对话时，**不会**出现任何插入消息
- [ ] 用户正在跑长任务（>1 分钟）时，**不会**被打断
- [ ] 用户说完一句等我回时，我不会抢答
- [ ] 会话彻底空闲 ≥ 阈值后，可能主动说一句
- [ ] 一天最多 2 次
- [ ] 两条之间至少隔 90 分钟（`minGapMs`）
- [ ] 动机不与最近 2 条重复；话题不与最近 3 条重复
- [ ] **投出去的话带 `【助手主动搭讪】` 标记**——模型侧一眼认出是自己的声音
- [ ] 连续 2 次未回 → 自动暂停
- [ ] **子 agent 不触发**（纯任务子代理全程不被打扰）
- [ ] "别主动找我" → 立即停
- [ ] LLM 调用次数/天 ≤ 2
- [ ] `RUNTIME/state/proactive.log` 里有 `mount` → 插件活着
- [ ] `RUNTIME/state/proactive.log` 里有 `deliver` → 真的说过话了

---

## 13. 【2026-11-17 晚】生态化改造：把自造轮子换成 DSH 的正规武器

### 13.1 用户问的那句话

> 「这种实现方式不优雅啊，能不能在 dsh 插件生态中实现」（15:33）

不是挑刺，是**指路**。查完生态发现我一直在绕开它——
手写 JSON 状态、手改 profile patch、改代码要重启。

### 13.2 生态里有什么（三件武器）

| 武器 | 位置 | 解决什么 |
|---|---|---|
| **`ctx.storageDomain`** | `@deepseek-ai/dsh-storage-domain` | 状态存储：原子写、schema 校验、并发写串行化、写前落盘、坏记录留证 |
| **`Config` + `.volatile()`** | 插件 `lib/config.js` | 设置页可改、不重启插件、写盘走 `dsh-config-editor`（保留 YAML 注释） |
| **`@deepseek-ai/dsh-hmr`** | profile 里 `include:hmr` **已启用** | link 出去的包改文件，**下次 profile 重合成时免重启替换** |

**HMR 这条是今天最大的收获**：以前每次改插件代码都要请用户双击重启脚本、
提权 UAC 弹窗、然后干等 40 秒。现在 `plugin_manager set_plugin` 一调就热替换，
**DSH 全程不重启**（实测 20:42 / 20:43 / 21:39 / 22:37 连续四次）。

### 13.3 改造一：状态 → domain（双轨）

```
RUNTIME/state/proactive.json   ← 镜像（跟着人格包走，可迁移）
        ↕
$DSH_HOME/storages/doubao_proactive/state/current.json   ← 权威（DSH 基建）
```

**为什么双轨而不是一步切**：

1. DSH 没重启时 `storageDomain` 服务还没挂上，一步切会让搭讪在重启前瘫痪；
2. domain 数据落在 `$DSH_HOME`，**不随插件包走**；
   而人格数据要能带到别的机器（AGENTS.md §5「那里的人格是空置的」）⇒ 文件得留。

**为什么手写 spec 不 import 官方包**：
`defineDomain` / `domainTable` 只是**校验器 + 构造器**
（`domainTable(schema) { return { valueSchema: schema } }`），
`open(spec)` 只读 spec 的几个字段 ⇒ **不需要那个包的运行时**。
而 import 它要 vendor **4.4 MB** 进插件包，还带 peerDependency 冲突。
手写 spec 的正确性用**官方 `defineDomain` 交叉验证**过（descriptor 完全一致）。

### 13.4 改造二：暂停开关 → Config

原来 `paused` 存在 JSON 里，手工用 PowerShell 改 ⇒ BOM ⇒ 解析失败 ⇒
静默回落默认 ⇒ **"别主动找我"被自动解除**（11.10 节那个 bug）。

现在 `proactive.paused` 是 `.volatile()` 字段 ⇒ 出现在 **DSH 设置页**，
点一下就生效、**不用重启插件**，写盘走 `dsh-config-editor`。

> **BOM 这个坑从根上消失了**——因为不再需要手工改 JSON。
> 状态文件降级成镜像，坏了也只是回落默认（且 `loadState` 读不出时 fail-safe 暂停）。

### 13.5 热重载暴露的三个真 bug（都是"静默失效"型）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 9 | `poll roots:0` ⇒ **搭讪彻底静默** | `trackRootAgents` 只靠 `agent/created` 累积；热重载时旧实例 unmount（集合清空）、新实例挂载，但**已存在的 agent 不再触发 created** | 挂载时用 `scope.agents.list()` 扫一遍 |
| 10 | `domain 'already open'` ⇒ **永远回落文件模式** | 旧实例的 domain 没关（当时代码里还没有 close），句柄**永久泄漏** | 撞 already-open 时用 `facility.get(name)` **接管**那个句柄，关掉再重开 |
| 11 | `cannot get property "storageDomain" without inject` | Cordis 的 scope 是 **Proxy**，直接取没 inject 的服务会**抛**，不是返回 undefined | 用 `ctx.get(name, false)` |

> **共同的形状**：三个 bug 都**不报错**、DSH 一切正常，只有插件日志里一行奇怪的记录。
> 热重载是"什么都不提醒就换掉你的代码"——所以热重载路径必须**独立测**。

### 13.6 domain 的两个坑（探针实测，文档没说）

**坑一：`put()` 不做 schema 校验。**
校验只发生在 `open()`（`dsh-storage-domain/lib/index.js:392-407`）⇒
一条坏记录写进去当时没事，**下次打开时整个 domain 打不开**（`invalid-record`）
⇒ domain 被一条坏数据**永久砖化**。
⇒ 修法：`writeDomainState()` **写之前自己校验**（用同一份 zod schema）。
（`KvTable` 不暴露 `valueSchema`，只有 get/entries/keys/size/put/delete/deleteMany/update。）

**坑二：`backup-and-skip` 只在 per-record 布局下有效。**
`backupRecord` 只实现在 `PerRecordJsonUnit` 上
（`dsh-storage-json/lib/index.js:552`），`SingleJsonUnit` 没有
⇒ single 布局下自愈形同虚设。
⇒ 修法：布局切 **`per-record`**（我们本来就只有一条记录）。

```yaml
# 最终形态
<storages>/doubao_proactive/state/current.json     ← 记录本体（带 version 戳）
<storages>/doubao_proactive/state/current.json.bak.<时间戳>   ← 坏记录留证
```

### 13.7 改造三：一轮只投一条（全局串行闸）

**事故**：11-17 21:07，两秒内投了**两条**——
"喵喵喵！上次你用这句开场，我可记到今天了。" 和
"喵喵喵，用户，今天抓到你的新开场了吗？"——同一件事说了两遍。

**根因**：一轮轮询遍历**所有**顶层会话（实测 17 个），每个都独立走
"判定 → 生成 → 投递 → 写回"。而 `minGapMs`（90 分钟）**拦不住同一轮里的第二条**——
第一条的 LLM 调用要几秒，状态还没写回，第二个 agent 读到的仍是"上次是 3 小时前"。

**修法**：`withDeliveryLock()` 把整段**串行化**；后到的 agent 拿到闸后**重新读状态**，
此时第一条已写回 `lastProactiveAt` ⇒ 被 `minGapMs` 正常拦下。
（原来的 `inFlight` 只防**同一个** agent 重入，挡不住这个。）

**顺带**：轮询改成**按"用户最后说话的会话"排序**——桌面版同时有十几个顶层会话，
搭讪该投给他刚待过的那个，不是注册表里第一个。

### 13.8 现在的完整数据流

```
poll（10 分钟）/ idle 事件
   └→ 挑会话（用户最后说话的优先）
       └→ withDeliveryLock（全局串行）
           └→ 读状态：domain 优先，文件兜底
               └→ decide()（时段 / 上限 / 未回 / minGap / 阈值 / 动机 / 去重）
                   ├─ 不说 → 写回（若状态变了）
                   └─ 说 → 生成（关系向素材 + WORK_TONE 硬闸）
                       └→ followup()，正文带【助手主动搭讪】+ source.form:'notice'
                           └→ 写回 domain + 文件镜像
```

### 13.9 测试

新增 4 套：

| 套 | 覆盖 |
|---|---|
| `test-proactive-domain.mjs` | domain spec 形状、schema 吃老记录、服务缺席回落、文件兜底、BOM、坏文件 fail-safe |
| `test-domain-service-access.mjs` | `ctx.get(name,false)` vs Cordis Proxy、**接管泄漏句柄** |
| `test-agent-tracking.mjs` | **模拟 HMR 重载**后仍能收集到 agent |
| `test-proactive-single-delivery.mjs` | 串行闸语义、同轮只投一条、会话排序 |
| `probe-domain-write.mjs` | **用真实后端**跑：spec 交叉验证、写入落盘、坏记录自愈、关后重开 |

> `probe-domain-write.mjs` 是唯一**用真实 `dsh-storage-json` + `dsh-storage-domain`** 跑的，
> 其他都是 mock。其余 mock 测不出来的地方，都是它抓到的。

