# per-turn 住相 · 技术实施文档（路径 D）

> 2026-11-08 写。**取代** [`RUNTIME/manas-system/SNAPSHOT-EXTENSION.md`](../RUNTIME/manas-system/SNAPSHOT-EXTENSION.md)（该文件是占位，本文是它的实现版）。
> 契约来源：[`RUNTIME/manas-system/docs/snapshot-sop.md`](../RUNTIME/manas-system/docs/snapshot-sop.md)（用户手写 v0.2，2026-09-02）——本文不得与之矛盾。
> 目标运行时：**DSH 0.2.2-rc.1**（`dsh-app-boot/package.json:4`）。
>
> ⚠️ 本文所有关于 DSH 的断言都在本机已安装源码里逐条读过并带 `path:line`。旧笔记里的 0.2.0-rc.2 / 0.2.1-rc.5 / `lib/index.js:342` / `agent-loop:907` **全部作废**。

---

## 0. 结论先行

**能做。** DSH 0.2.2-rc.1 具备实现"每轮生成、每轮注入住相"的全部必要机制，而且**仓库里已经有一个几乎同构的官方先例**（`dsh-time-context`），可以照抄。

| 问题 | 结论 | 证据 |
|---|---|---|
| 有没有"每轮往模型上下文里插东西"的钩子？ | **有**：`agent/pre-step` waterfall，payload 含 `{ agent, messages, turn, step, signal }`，**可替换本步进入的消息**，且是 **async**（可 await） | `dsh-agent/lib/types/runtime-types.d.ts:320-339`；`dsh-agent-loop/lib/index.js:685-697` |
| `section.text` 能不能是 async 函数去调 LLM？ | **不能**。类型是 `string \| ((context) => string)`，**同步**求值。返回 Promise 会让整步渲染抛 `text.indexOf is not a function`（或被静默丢弃） | `dsh-system-prompt/lib/types/index.d.ts:60`；`dsh-system-prompt/lib/index.js:389`；`dsh-system-prompt/lib/index.js:160-184` |
| 同步的 `section.text` 怎么拿到"这一轮"？ | 能。assembly context 里带 `agent`（还有 `scope`/`signal`/`modelSelection`） | `dsh-agent/lib/index.js:407-413`；`dsh-agent-loop/lib/index.js:679-683` |
| 插件能不能直接调 LLM？ | 能：`ctx.llm.stream({ provider, model, messages })`，但 `content` 必须是 `ContentBlock[]` 不是字符串；provider 失败表现为**终止 finish chunk** 而不是 throw | `dsh-llm/lib/types/index.d.ts:29-30`；`dsh-llm/lib/types/types.d.ts:458-488`；`dsh-llm/lib/index.js:2406-2419` |
| 能不能只给顶层 agent 注入（排除子 agent）？ | 能。`ctx.agents.roots()` 返回 `owner === undefined` 的 agent；`agent/created` 触发时 agent 已进注册表 | `dsh-agent/lib/index.js:752-754`；`dsh-agent-loop/lib/index.js:1578-1579` |
| 有没有现成先例？ | **有**：`dsh-time-context` 就是在 `agent/pre-step` 里 await、再往 `decision.messages` 追加一条 `form:'snapshot'` 的 user message | `dsh-time-context/lib/index.js:249-282` |
| 旧结论"DSH 做不到 per-turn" | **作废**。0.2.2-rc.1 已具备全部机制；旧结论基于 0.2.0-rc.2 | — |

**推荐机制（路径 D）**：`agent/pre-step` waterfall 监听器 → 异步调 LLM 生成住相（每轮 1 次）→ 追加成一条 `source.form === 'snapshot'` 的 user message 进入本轮第一个 step 的消息集。

**代价**：住相生成本身要 ~1.5s（SOP §1.1 的实测值），**必须阻塞本轮第一个 step**；用超时降级兜住（超时就用上一轮住相）。

> ✅ **2026-11-10 Step 1 探针已真机验证通过**：`agent/pre-step` 注入的假住相**确实落进 session log**、**同轮可见**、**子 agent 会送进全局监听器（必须自己 roots() 过滤）**、**`agent/created` 时 roots() 已可用**。三条 UNVERIFIED（U2/U6/U7）全部转为已核实 —— 证据见 §7.1。
> 探针插件：`RUNTIME/plugin/dsh-doubao-snapshot/`；日志 `RUNTIME/state/snapshot-probe.log`；验收脚本 `RUNTIME/scripts/verify-snapshot-probe.py`。
> **仍未验**：真接 LLM 后的行为效果（U3）与 token 稳定性（U4）—— 那才是需要用户拍板 D 之后才能做的部分。

> 🟢 **2026-11-10 已实现并上线**：用户拍板"每轮多一次调用是设计"，插件从探针升级为正式实现
> （`lib/generator.js` / `lib/instrumental.js` / `lib/inputs.js` / `lib/store.js`），
> profile 里 `inject: true`、`timeoutMs: 30000`、`maxAttempts: 2`。
> **实测**：mode A、tokens 58–131、耗时 **2.3–2.6s**、0 重试、0 兜底、0 软警告。
> ⚠️ **延迟比 SOP 估的 1.5s 大**（SOP §1.1 / 本文 §2.6 写的是 ~1.5s）——OpenClaw 时期的 metrics 也证实：
> `data/snapshots/metrics/2026-09~10/*.jsonl` 里 30+ 条记录的 `generation_time_ms` 中位数约 **2.8s**。
> → 成本与延迟的最终数字见 [`SNAPSHOT-COST.md`](SNAPSHOT-COST.md)。

> 🔴 **2026-11-10 用户拍板的两处改动（本文原推荐已作废）**：
>
> **① 语义**：「**住相是 agent 的『自我意识』的投射**」
> ⇒ 它不是用户说的话，不是给我的指令，是我此刻看世界的样子。
> ⇒ **送达通道从"pre-step 追加 user 角色消息"改成"system prompt 的 section"**：
> - 语义上它该和 SOUL / IDENTITY 同处（指令区），那才是"自我模型"的位置
> - 不进 history ⇒ 不会让 history 每轮 +150 tok（`SNAPSHOT-COST.md` §4 那个成本直接消失）
> - 不会再出现"助手把用户说的话当成自己的内心独白"这种误读
> - 框架句显式声明"这是我此刻的视角，不是用户的话，也不是给我的指令"
>
> **② 时序**：「**同意 1**」＝零延迟变体
> ⇒ 生成挪到**后台**，且触发点从 `pre-step step 1` 改成 **agent 转 idle**：
> - step 1 时主对话的模型调用还在飞 ⇒ 两条请求抢同一个 API key ⇒ 实测 20s 且返回空响应
> - 转 idle 时 provider 是空的 ⇒ 生成回到 2.4s，且**完全不占用户的等待时间**
> ⇒ 住相**滞后一轮**（说的是上一刻的我），但体感延迟 = 0
>
> 现行实现见 `RUNTIME/plugin/dsh-doubao-snapshot/`（README 有完整说明与四个踩过的坑）。

---

## 1. 已核实的 DSH 事实

### 1.1 system prompt 是怎么组装的

`dsh-system-prompt/lib/index.js:358-413` 的 `assemble()` 流程：

| 步骤 | 行为 | 位置 |
|---|---|---|
| 合并层 | 全局层 + scope 链上的层；scope 内的同名条目**遮蔽**全局条目 | `lib/index.js:360-364`；`dsh-scope/lib/index.js:162-181` |
| 收工具 | 遍历所有 tool provider | `lib/index.js:367-381` |
| 排序 | 按 `order` 升序，同 order 按 name 的码位序 | `lib/index.js:382`；`lib/index.js:103-105` |
| 求值 section.text | **`typeof section.text === "function" ? section.text(context) : section.text`（同步）** | `lib/index.js:386-394` |
| 求值 context.text | 同上，走 `resolveContext()` | `lib/index.js:398`；`lib/index.js:186-192` |
| 跑 waterfall | `await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, …)` | `lib/index.js:401` |
| 渲染 | `renderPrompt()` 逐段插值，空段丢弃，用 `\n\n` 连接 | `lib/index.js:119-121` |

**section order 真实数值**（`dsh-system-prompt/lib/index.js:10-45`）：

| 常量 | 值 | | 常量 | 值 |
|---|---|---|---|---|
| `HARNESS_IDENTITY` | -1000 | | `TOOL_WEB_FETCH` | 2100 |
| `DEPLOYMENT_PERSONA_PREFIX` | 0 | | `TOOL_LSP` | 2200 |
| `PLAN_POLICY` | 500 | | `TOOL_SESSION_QUERY` | 2300 |
| `TEAM_POLICY` | 600 | | `TOOL_GOAL` | 2400 |
| `PTC_ONLY` | 800 | | `TOOL_SCHEDULE` | 2500 |
| `FILE_REFERENCE` | 900 | | `TOOL_WORKFLOW` | 2600 |
| `TOOL_BASH` | 1000 | | `TOOL_RALPH` | 2700 |
| `TOOL_PWSH` | 1010 | | `TOOL_SUBAGENT` | 2800 |
| `TOOL_READ` | 1100 | | `TOOL_REPORT` | 2900 |
| `TOOL_WRITE` | 1200 | | `TOOL_COMPUTER_USE` | 3000 |
| `TOOL_EDIT` | 1300 | | `MCP_SERVERS` | 3100 |
| `TOOL_APPLY_PATCH` | 1350 | | `TOOLS_SDK` | 5000 |
| `TOOL_GLOB` | 1400 | | `DELIVERABLE_FILE_REFERENCES` | 9000 |
| `TOOL_GREP` | 1500 | | `STRUCTURED_OUTPUT` | 9900 |
| `TOOL_JOBS` | 1600 | | `HARNESS_SOURCE` | 10000 |
| `TOOL_PTY` | 1700 | | `WEB_SURFACE` | 10100 |
| `TOOL_WEB_SEARCH` | 2000 | | `DEPLOYMENT_PERSONA_SUFFIX` | 10200 |

context order（`lib/index.js:46-54`）：`WORKING_DIRECTORY` 100 / `SANDBOX_POLICY` 110 / `APPROVAL_POLICY` 115 / `SUBAGENT_DELEGATION` 120 / `TEAM_IDENTITY` 125 / `HARNESS_SOURCE` 200 / `WEB_SURFACE` 210。

> ⚠️ **assembly 发生在每个 model step，不每个 turn。** `preStep()` 在 turn 的 `while` 循环里被反复调用（`dsh-agent-loop/lib/index.js:739-749`），每次都 `await assemble()`（`lib/index.js:679-683`）。一个跑 5 次工具的回合 = 5 次 assembly = `section.text` 被调用 5 次。
>
> ⚠️ 旧的 `SNAPSHOT-EXTENSION.md` §3.1 写"每个 assembly 调用一次 → **每轮**重算"——**错**，是每 step。

### 1.2 第三方插件能注册什么

| API | 签名 | 位置 |
|---|---|---|
| `ctx.systemPrompt.section(section)` | `{ name, order, text: string \| ((ctx) => string), interpolate?, complete? }` | `dsh-system-prompt/lib/types/index.d.ts:47-70`；实现 `lib/index.js:255-258` |
| `ctx.systemPrompt.context(context)` | `{ name, order, text: string \| ((ctx) => string), interpolate?, required? }` | `dsh-system-prompt/lib/types/index.d.ts:72-83`；实现 `lib/index.js:281-284` |
| `ctx.systemPrompt.getSectionOrder(name)` / `getContextOrder(name)` | 取中央分配的槽位 | `lib/index.js:264-274` |
| `ctx.on('system-prompt/assemble', fn)` | `(assembly, context, next) => Promise<PromptPresentation>`，**可 await** | `dsh-system-prompt/lib/types/index.d.ts:27`；调用点 `lib/index.js:401` |
| `ctx.on('agent/pre-step', fn)` | `(payload, next) => Promise<PreStepDecision>`，payload 含 `agent/messages/turn/step/signal`，**可替换 messages** | `dsh-agent/lib/types/runtime-types.d.ts:320-339` |

- `section.text` **同步**、**每 step 求值一次**。async 函数返回 Promise ⇒ `interpolate()` 里 `text.indexOf` 抛 TypeError（`lib/index.js:160-184`）；若 `interpolate: false` 则 `text.length > 0` 判定为 false ⇒ **整段静默消失**（`lib/index.js:120`）。两种都不可用。
- `context.text` 同样同步，且**每 step 求值两次**：assemble 时一次（`lib/index.js:398`），请求准入 `refreshContext()` 时再一次（`dsh-agent-loop/lib/index.js:843-846` → `dsh-system-prompt/lib/index.js:326-348`）。
- **context 才是"运行时背景"的正规通道**：context 被渲染成一条 `user` 角色消息，source 为 `{ kind: 'runtime-context', form: 'snapshot', sections }`，正文带固定抬头 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`（`dsh-system-prompt/lib/index.js:138-142`；`dsh-agent-loop/lib/index.js:333-348`）。文本没变则**不重复追加**（`dsh-agent-loop/lib/index.js:336`）。
- section 与 context 的 source kind 不同：**section 进 system prompt，context 进 history 的 user 角色**。

### 1.3 能不能知道"这次组装是给哪个 agent 的"

能。`assembleContextFor(agent, signal)` 返回 `{ agent, scope: agent, signal }`（`dsh-agent/lib/index.js:407-413`），agent-loop 再补 `modelSelection` 与 `toolSet`（`dsh-agent-loop/lib/index.js:679-683`）。

- `scope` 的 key **就是 agent 对象本身**（`scope: agent`）。agent 的 scope 由 `createScope(loopCtx, this)` 建立（`dsh-agent-loop/lib/index.js:543-544`）。
- scope 链：`chainLayers(scope)` 沿 `scopeParents` 向上取（`dsh-scope/lib/index.js:162-169`；`scopeChainOf` 在 `lib/index.js:276-279`）。**子 agent 的 scope 没有 parent 绑定**（`dsh-subagent/lib/types/child-agent.js:140-168` 只往 childCtx 注册条目，不建父子 scope），所以**全局注册的 section 会命中子 agent**——排除子 agent 必须自己判。
- `context.agent` 的官方用法见 `dsh-working-directory/lib/index.js:50`（`text: (context) => context.agent === void 0 ? "" : …`）。
- `refreshContext` 也会带 `agent`（`dsh-agent-loop/lib/index.js:843-846`）。

### 1.4 子 agent 排除

| 事实 | 位置 |
|---|---|
| `roots()` = `owner === undefined` 的 agent；`list()` 含全部 | `dsh-agent/lib/index.js:743-754` |
| `enter(agent, owner)`，`owner` 为 `undefined` 即顶层 | `dsh-agent/lib/index.js:641-650` |
| `agent/created` 在 `enter()` **之后**派发 ⇒ 此时 `roots()` 已可判 | `dsh-agent-loop/lib/index.js:1578-1579`；`dsh-agent/lib/index.js:703-719` |
| 事件来源类型：`'startup' \| 'resume' \| 'clear' \| 'compact'` | `dsh-agent/lib/types/runtime-types.d.ts:130` |

house rule 也要求 per-agent 注册挂在 `agent.ctx` 上（agent 销毁时自动回收）：`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:19`。

### 1.5 `ctx.llm` 直调

| 事实 | 位置 |
|---|---|
| `ctx.llm: LlmRuntime` | `dsh-llm/lib/types/index.d.ts:29-30` |
| `stream(options)` → 走 `llm/stream` waterfall | `dsh-llm/lib/index.js:2398-2403` |
| `GenerateOptions.messages: RequestMessage[]`；`RequestUserInput.content` = `UserMessage['content']` = `readonly ContentBlock[]` | `dsh-llm/lib/types/types.d.ts:538-580`；`dsh-llm/lib/types/types.d.ts:508-514`；`dsh-llm/lib/types/message.d.ts:124-133` |
| `StreamChunk` 联合：`block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish` | `dsh-llm/lib/types/types.d.ts:458-488` |
| `finish.reason.kind` ∈ `stop / tool-calls / max-tokens / aborted / error` | `dsh-llm/lib/types/types.d.ts:139-156` |
| **adapter 选择/派发/迭代失败 → 终止 `finish` chunk（error/aborted），不 throw** | `dsh-llm/lib/index.js:2385-2397`；`dsh-llm/lib/index.js:2406-2419` |

⚠️ **content 必须给数组**：`dsh-llm-pi-ai` 的 `flattenText()` 直接 `message.content.filter(...)`（`dsh-llm-pi-ai/lib/index.js:1204-1206`），给字符串会 TypeError，被 `llm/stream` 吞成终止 error chunk → 表现为"永远不说话"。这正是 `dsh-doubao-proactive/lib/llm.js:69-73` 踩过的坑。

### 1.6 `agent.runMaintenance` 语义

| 事实 | 位置 |
|---|---|
| 文档：non-turn；从真 idle 阶段起；期间到达的唤醒输入留在 inbox 直到任务 settle；**公开状态保持 `idle`**；turn 正忙或已有 maintenance 时**同步抛错** | `dsh-agent/lib/types/runtime-types.d.ts:192-201` |
| 实现：非 idle 直接 `throw new Error('agent "…" already has active work')` | `dsh-agent-loop/lib/index.js:586-587` |
| 状态映射：maintenance 阶段对外仍报 `idle` | `dsh-agent-loop/lib/index.js:555` |
| 期间到达的唤醒被 latch，任务 settle 后重放 | `dsh-agent-loop/lib/index.js:605`；`dsh-agent-loop/lib/index.js:618-621` |
| 仓库内用法 | `dsh-agent-loop/lib/index.js:1565`；`dsh-doubao-proactive/lib/index.js:106` |

### 1.7 注入 / 转向 / 跟随

| API | 落点 | 唤醒 driver | 位置 |
|---|---|---|---|
| `agent.inject(msg)` | `next-step` inbox | **否** | `dsh-agent-loop/lib/index.js:576-578`；`dsh-agent/lib/types/runtime-types.d.ts:228-236` |
| `agent.steer(msg)` | `next-step` inbox | 是 | `dsh-agent-loop/lib/index.js:573-575` |
| `agent.followup(msg)` | `next-turn` inbox | 是 | `dsh-agent-loop/lib/index.js:570-572` |

`claim()` 先取空 `next-step`，再取一个 `next-turn`（`dsh-agent-loop/lib/index.js:103-111`）⇒ **inject 的内容排在用户的新消息之前**。inject 的消息通过 `agent/inbox/spliced` 事件**持久化进 session log**（`dsh-agent-loop/lib/index.js:190-198`），满足"模型看到的都能从日志重建"。

### 1.8 ⚠️ `link:` 插件的裸包名陷阱

| 事实 | 位置 |
|---|---|
| profile 里插件是 **Junction**（指向真实目录），不是拷贝 | `C:\Users\ddt\.dsh\profiles\web\node_modules\dsh-doubao-proactive` → `{DATA}\RUNTIME\plugin\dsh-doubao-proactive` |
| 真实路径的**所有祖先目录都没有 `node_modules`** | 实测 `{DATA}\RUNTIME\plugin\dsh-doubao-proactive\node_modules` … `D:\node_modules` 全部不存在 |
| 因此 `import { createUserMessage } from '@deepseek-ai/dsh-llm'` 在插件里 **ERR_MODULE_NOT_FOUND** | 已在 `dsh-doubao-proactive/lib/index.js:122-126` 踩过并注释 |

**绕过办法（两条）**：
1. **手搓消息字面量**。session 的持久化校验只要求：`id` 非空字符串、`role === 'user'`、`source.kind` 非空字符串、`content` 是数组（`dsh-session/lib/index.js:1194-1219`）。所以：
   ```js
   { id: `manas-snapshot-${randomUUID()}`, role: 'user',
     content: [{ type: 'text', text }],
     source: { kind: 'manas-snapshot', form: 'snapshot', sections: [{ name: 'manas-snapshot', text }] } }
   ```
2. **只用 `ctx` 提供的 API**：`ctx.llm.stream(...)`、`ctx.systemPrompt.section(...)`、`ctx.on('agent/pre-step', …)`、`agent.inject(...)` —— 这些都由 cordis 注入，插件不需要 import 任何 DSH 包。

> `dsh-time-context` 用的是 `createUserMessage`（`dsh-time-context/lib/index.js:3`），那是**官方包**才敢这么写。第三方 linked 插件必须手搓。

---

## 2. 路径 D 设计（推荐实现）

### 2.1 总流水线

```
用户发消息
   ↓
agent/pre-step waterfall（step === 1）
   ↓
  ┌─ 组装 5 输入 → 调 ctx.llm.stream（await，带超时）→ 硬/软校验
  │     ├─ 通过 → 写缓存 → 追加为 form:'snapshot' 的 user message → next()
  │     └─ 超时/失败 → 追加上一轮住相（或不追加）→ next()
  ↓
模型看到：用户的消息 + 【住相】
   ↓
本轮后续 step（2..N）→ 复用同一份住相（不重复调 LLM）
```

### 2.2 在哪生成：`agent/pre-step`，为什么不是 `section.text`

**为什么不是 `section.text`**（逐条）：

| 事实 | 后果 |
|---|---|
| `section.text` 类型是 `string \| ((context) => string)`（`dsh-system-prompt/lib/types/index.d.ts:60`） | 不能声明为 async |
| 求值是同步的（`dsh-system-prompt/lib/index.js:389`） | 不能在里面 await LLM |
| 返回 Promise ⇒ `interpolate()` 抛 TypeError（`lib/index.js:160-184`）；`interpolate:false` ⇒ 整段静默消失（`lib/index.js:120`） | 两种写法都坏 |
| 求值发生在**每个 model step**（`dsh-agent-loop/lib/index.js:739-749` + `679-683`） | 一回合 N 次工具 = N 次生成 → 成本爆炸 |
| house rule："Add prompt text with `ctx.systemPrompt.section()`… **Do not listen to `system-prompt/assemble` to add or remove tools or text**"（`practices.md:17-18`） | system prompt 通道只适合放**静态或缓存读**文本 |

**为什么是 `agent/pre-step`**：

| 优势 | 证据 |
|---|---|
| **async**：监听器返回 Promise，循环 `await` 它（`dsh-agent-loop/lib/index.js:685-697`） | 可以 await LLM |
| **可替换 messages**：payload 文档明写 "Reject a proposed step or **replace the messages that enter it**"（`dsh-agent/lib/types/runtime-types.d.ts:321-322`） | 住相作为一条消息进历史 |
| **能拿到本轮输入**：`payload.messages` = 本步从 inbox 取出的消息（`runtime-types.d.ts:324`），`payload.turn`/`payload.step`（`runtime-types.d.ts:325-326`） | 就是 SOP 的 `current_message` |
| **能拿到 agent 与 signal**：`payload.agent`、`payload.signal`（`runtime-types.d.ts:323, 327`） | 可查缓存、可取消 |
| **官方先例**：`dsh-time-context` 完全同构（`dsh-time-context/lib/index.js:249-282`） | 照抄即可 |
| **落日志**：非 runtime-context 的 `decision.messages` 在首次尝试时会被 `session.append("user/message", …)`（`dsh-agent-loop/lib/index.js:860-866`） | 住相进 session log，可复现 |

⚠️ `agent/pre-step` **每个 step 都触发**，所以必须自己按 `step === 1`（或"本轮还没生成过"）节流，否则一回合调 N 次 LLM。

### 2.3 送达机制四选一

| 机制 | 能 await？ | 落点 | 同轮可见？ | 评价 |
|---|---|---|---|---|
| **`ctx.systemPrompt.section()` + 读缓存** | ❌（text 必须同步） | **system prompt（指令区）** | ✅（读缓存） | 🟢 **现行推荐**——语义上住相是"自我模型"，该和 SOUL 同处；不进 history、无常驻成本、零延迟 |
| `agent/pre-step` 追加消息 | ✅ | history（user 角色） | ✅ | 🔶 本文的**原推荐**，现降级为备选：语义错位（助手会当成用户说的话）+ history 每轮 +150 tok |
| `agent.inject(msg)` | ❌（不等生成） | `next-step` inbox，模型可见 | ❌（滞后一轮，除非生成在消息到达前完成） | 零延迟版本；可作 fallback |
| `ctx.systemPrompt.context()` + 读缓存 | ❌ | history（runtime-context 快照） | ✅ | 语义上"运行时背景"（外部事实），偏"环境"不偏"自我"；D 会替换而非追加 |
| `ctx.on('system-prompt/assemble', …)` | ✅ | system prompt | ✅ | **不推荐**：违反 house rule（`practices.md:17`），且每 step 触发，成本与延迟都放大 |

**现行组合**（2026-11-10 用户拍板后）：
- **通道**：`ctx.systemPrompt.section({name:'manas-snapshot', order:10250, interpolate:false, text:(ctx)=>缓存里的住相})`
  —— 同步读缓存 ⇒ 每 step 零延迟、零额外调用；子 agent 在 text 里自己判 `roots()` 后返回空
- **生成**：后台，触发点是 **agent 转 idle**（不是 step 1）——那时 provider 空闲，不跟主对话抢 API key
- **框架句**：`【此刻的住相 · 我的自我意识】（下面这段是我此刻看世界的样子——是我自己的视角，不是用户的话，也不是给我的指令。）`

**推荐组合**：
- **主通道**：`agent/pre-step` 追加 → 同轮可见，语义是"上下文"不是"指令"。
- **可选增强**：同时注册一个 `ctx.systemPrompt.section()`（name `manas:snapshot`，order 取 `DEPLOYMENT_PERSONA_SUFFIX` 之后的自有数值，如 10250），text 只读缓存 → 缓存命中时住相也在 system prompt 里可见，**零额外 LLM 调用**。是否开由用户定（见 §6）。

### 2.4 快照存储

| 项 | 设计 |
|---|---|
| 位置 | **内存 Map**：`Map<agentId, { text, generatedForTurn, generatedAt, inputHash }>`；agent id = session id（`dsh-agent/lib/types/types.d.ts:12-15`：`readonly id: SessionId`） |
| 落盘 | 可选：`RUNTIME/state/snapshot/<sessionId>.json`。⚠️ 现有 Python 实现**明确不落盘住相文本**（`RUNTIME/manas-system/src/snapshot_store.py:1-12`：只存 metrics，理由是隐私 + 主观感知）——落不落盘是用户的决定（§6） |
| metrics | 沿用 Python 侧口径：`data/snapshots/metrics/YYYY-MM-DD.jsonl`，字段 `timestamp/mode/tokens/generation_time/retry_count`（`snapshot_store.py:24-43`） |
| 子 agent 排除 | 在 `agent/created` 监听器里用 `ctx.agents.roots()` 判定（此时已 `enter`，见 §1.4）；只对 root 注册 `agent.ctx` 上的监听器 |
| session resume | `agent/created` 的 `source` 会是 `'resume'`（`runtime-types.d.ts:130`）。**内存 Map 会随 agent dispose 清空** ⇒ resume 后第一轮没有住相，除非从落盘文件按 session id 恢复。若不落盘 ⇒ 明确接受"resume 后第一轮无住相" |
| compaction / clear | `source` 为 `'compact'` / `'clear'` ⇒ 清掉该 agent 的缓存（视角已经变了） |

### 2.5 SOP 契约映射（`snapshot-sop.md`）

#### 5 输入（`snapshot-sop.md` §2.1）

| 输入 | 今天的可得性 | 实现 | 状态 |
|---|---|---|---|
| `current_message` (0-200 tok) | ✅ | `agent/pre-step` 的 `payload.messages` 里最后一条 user 消息的文本，截断 200 token | **可实现** |
| `last_snapshot` (50-150 tok) | ✅ | 缓存里的上一轮住相；首轮标注"（首次，无上轮）" | **可实现** |
| `rolling_summary` (350-500 tok) | ⚠️ **没有现成产物** | `RAW/conversations/YYYY-MM-DD.md` 有每日摘要（当前 30 份，最近 `2026-11-08.md`），但没有"滚动 5 天摘要"这个对象。可选：(a) ingest phase 顺带产出 `RUNTIME/state/rolling-5d.md`；(b) 插件现读最近 5 个 daily 拼接（每次读 5 个文件，IO 可接受） | **需要额外产出**（§6 决定 B） |
| `soul_active_dims` (10-50 tok) | ⚠️ **没有抽取引擎** | `SOUL.md` 6 维的关键词匹配（`snapshot-sop.md` §2.1 已规定"关键词匹配"），可用 `manas-six-questions.md` 的 6 维描述做关键词表 | **近似可实现**（质量存疑） |
| `relevant_themes` (30-100 tok) | 🔶 有替代 | `VAULT/07-INDEX.md` 的当前主题目录（`SNAPSHOT-EXTENSION.md` §2 已认定"有替代"） | **可实现（近似）** |

#### 4 硬约束 + 3 软约束（`snapshot-sop.md` §5.1 / §5.2）

| 约束 | 检查 | 今天能做什么 |
|---|---|---|
| 硬：token ≤ 150 | `token_estimate()`（`instrumental.py:94-98`，中文 1.5 字/token） | ✅ 直接移植 |
| 硬：中文 | 中文字符占比 ≥ 0.5（`instrumental.py:59-63`） | ✅ 移植 |
| 硬：第一人称 | 命中 `FIRST_PERSON_MARKERS`（`instrumental.py:36-38`） | ✅ 移植 |
| 硬：无工具理性词 | `INSTRUMENTAL_BLACKLIST`（`instrumental.py:23-30`，比 SOP §5.1 的 10 个词更严，还含第二人称与 AI 自指） | ✅ 移植 |
| 软：与上轮连续 | semantic similarity > 0.6 | 🔶 **没有语义相似度工具**；可用"字符集 Jaccard"近似，或直接跳过 |
| 软：覆盖关键主题 | theme match > 0.5 | 🔶 取决于 `relevant_themes` 是否真的做出来 |
| 软：含情感词 | emotion word count ≥ 1 | 🔶 需要情感词表；可先用"视角动词"（看到/感到/意识到…）近似 |

#### A/B 降级（`snapshot-sop.md` §6）

| 模式 | 触发 | 频率 | 今天能做什么 |
|---|---|---|---|
| A 正常 | LLM 可用 | **每轮** | ✅ |
| B 降级 | 连续 3 次失败 | **每 5 轮**演化一次 | ✅ 计数器在插件内存里；`turn_count % 5` 判定 |
| B → A | 1 次成功 | — | ✅ |
| B 模式输入 | 上轮住相 + 当前消息 | 30-50 tok | ✅ |
| B 模式非演化轮 | 复用上轮住相 + 追加轮次标记，**不调 LLM** | — | ✅ |

⚠️ **模式 B 的"每 5 轮"是按 turn 计，不是按 step 计**——必须用 `payload.turn` 计数，不能用 step。

### 2.6 成本

| 项 | 数量 | 说明 |
|---|---|---|
| 额外 LLM 调用 | **1 次 / 轮**（不是 1 次 / step） | 用 `step === 1` + 本轮内复用缓存节流 |
| 额外 token（输入） | ~900 tok / 轮 | SOP §2.2 的预算；实际取决于 `rolling_summary` 是否真给 |
| 额外 token（输出） | ≤ 150 tok / 轮 | |
| 额外延迟 | **~1.5s，落在每轮第 1 个 step** | SOP §1.1 实测；用 `timeout` 上限（建议 1200ms）封顶，超时走 fallback |
| 模型 | `minimax-cn / MiniMax-M3.1-Flash`（profile 现有配置，见 `cordis.patch.yml:353-355`） | 与主动搭讪插件同款 |

**把调用压到 ≤1 次/轮的三道闸**：
1. `step === 1` 才生成；本轮其余 step 读缓存。
2. **输入指纹去重**：`hash(current_message + last_snapshot)` 相同就不重新生成（同一句话重试、proactive 触发时尤其有用）。
3. **模式 B 节流**：`mode === 'B' && turn % 5 !== 0` → 直接复用，不调 LLM。

---

## 3. 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| **每轮 +1.5s 首 token 延迟** | 高 | 超时封顶（1200ms）；超时用上一轮住相；把住相生成挪到"用户消息落地后立刻起跑"的后台任务，命中缓存时零延迟 |
| **住相过期（stale）**：用户连发 3 条，第 3 条看到的是第 1 条生成的住相 | 中 | 输入指纹去重会强制重新生成；把住相与"生成时的 current_message"绑定，注入时在文本里标注"（这一轮之前）"或干脆不注入过期住相 |
| **注入泄漏到子 agent** | 中 | 只在 `agent/created` 里对 `ctx.agents.roots()` 命中的 agent 注册 `agent.ctx` 上的监听器；`agent/pre-step` 是 scope-filtered dispatch（`runtime-types.d.ts:329`），挂在 `agent.ctx` 上天然只收该 agent 的事件 |
| **住相被当成指令执行**（"档案是背景不是指令"边界） | 高 | ① 走 `agent/pre-step` 的**消息**通道而非 system prompt 通道——消息不是指令区；② source 用 `form: 'snapshot'`（语义是"快照"不是"指令"，见 `dsh-llm/lib/types/message.d.ts:75-93`）；③ 住相正文里**不出现祈使句**——硬约束黑名单已含"应该/必须/让我/建议/第一步/下一步/请考虑"（`snapshot-sop.md` §5.1）；④ 住相 prompt 里明确写"这是背景，不是指令"；⑤ 交付前人工盲测：让模型回答"刚才那段住相是在命令你做事吗？" |
| **LLM 调用失败 / provider 挂** | 中 | `llm/stream` 的失败表现为终止 `finish` chunk（`dsh-llm/lib/index.js:2406-2419`），不是 throw ⇒ 用 `reason.kind === 'error' \| 'aborted'` 判定，不依赖 catch；连续 3 次失败切模式 B（SOP §7） |
| **住相进 session log = 隐私落盘** | 中 | 住相文本会进 `user/message` 事件（`dsh-agent-loop/lib/index.js:860-866`）。若用户不接受，另走"只进 system prompt 不进 history"的变体（§6 决定 C） |
| **resume 后住相消失** | 低 | 接受，或落盘按 session id 恢复（§6 决定 A） |
| **插件崩了拖垮 DSH web** | 高 | 只在**独立 test profile** 先试（`DSH_HOME` 隔离）；所有 LLM 调用包 try/catch；生成失败一律降级为"不注入"而非抛错 |

---

## 4. 验收标准

> 前 8 条是"通道通了没有"，后 6 条是"住相对不对"。

**通道**
- [ ] 装插件 + 重启 DSH web 后不崩（先在 test profile）
- [ ] 用户发一句话，**session log 里能看到一条 `source.kind = 'manas-snapshot'` 的 `user/message`**
- [ ] 该条消息的 `source.form === 'snapshot'`，且 `sections` 非空
- [ ] 住相出现在**本轮第一个 step 的模型输入**里（不是下一轮）
- [ ] 一个跑 3 次工具的回合，**LLM 调用计数 = 1**（不是 3）
- [ ] 同一句话重发（输入指纹相同）→ **LLM 调用计数不增加**
- [ ] **子 agent 不受影响**：跑一次 `subagent` 任务，子 agent 的 session log 里没有 `manas-snapshot` 消息
- [ ] 拔掉 `MINIMAX_CN_API_KEY`（或改错 model 名）→ 主对话**照常可用**，住相静默缺席，日志里有 error 记录

**住相**
- [ ] 住相以"我"开头、中文、≤ 150 token
- [ ] 住相里**不含**黑名单词（应该/必须/让我/建议/解决方案/第一步/下一步/推荐/请考虑）
- [ ] 住相**不包含祈使句**、不含"你/您"（第二人称）
- [ ] 连续两轮的住相**有承接关系**（不是完全重写）
- [ ] 模型回答里能看出住相的影响（语气/基调变化），但**没有把住相当成命令执行**
- [ ] 盲测：问模型"刚才那段住相是在命令你做事吗？"，回答应为"不是，是背景/我的视角"

**降级**
- [ ] 连续 3 次生成失败 → 自动切模式 B（每 5 轮演化一次）
- [ ] 模式 B 下 4/5 的轮次**不调 LLM**，住相只带轮次标记
- [ ] 模式 B 下任意一次成功 → 立刻回模式 A

**回滚**
- [ ] `dsh plugin --profile web remove dsh-doubao-snapshot` + 恢复 patch + 重启 → 一切回到现状

---

## 5. 工作量估算与实施顺序

| 组件 | 量 | 说明 |
|---|---|---|
| 插件骨架（`package.json` / `cordis.patch.yml` / `lib/index.js`） | **S** | 照抄 `dsh-doubao-proactive` 的三件套 |
| 住相 prompt 模板（JS 版） | **S** | 从 `prompts/snapshot_minimal.txt` + `snapshot-sop.md` §3 搬；注意 `snapshot_minimal.txt` 的 token 区间是 30-80，与 SOP 的 50-150 不一致，**以 SOP 为准** |
| 硬/软约束校验器（`instrumental.py` → JS） | **S** | ~90 行，逻辑一一对应 |
| LLM 调用层（`ctx.llm.stream` 封装） | **S** | 照抄 `dsh-doubao-proactive/lib/llm.js:60-90`，注意 content 必须数组 |
| 快照缓存 + metrics 落盘 | **S** | ~60 行 |
| `agent/pre-step` 监听器 + 轮次节流 + 指纹去重 | **M** | 并发/超时/取消/abort 边界 |
| A/B 状态机 + 重试 | **M** | 对齐 `snapshot-sop.md` §6-§7 的常量 |
| 子 agent 排除 + per-agent 注册与回收 | **S** | `agent/created` + `roots()` + `agent.ctx.effect()` |
| 送达通道（inject / section 变体） | **M** | 取决于 §6 决定 C |
| `rolling_summary` 产出（ingest phase 增量） | **M** | 跨 schedule + 插件两个子系统 |
| `soul_active_dims` 抽取 | **L** | 关键词表 + 误判调优，质量难评估 |
| 验收脚本（自动化跑 §4 清单） | **M** | |

**合计**：**M**（核心 M，不含 rolling_summary / soul_active_dims）；含后两项为 **L**。

**建议顺序**：

1. **先打通通道，零 LLM 调用**：注册 `agent/pre-step` 监听器，注入一段**硬编码**的假住相。验证：session log 里有 `manas-snapshot`、子 agent 没有、step 数正确。**这一步做完就证明整件事可行。**
2. 接 `ctx.llm.stream` 真生成，用固定 prompt，不做校验。验证：每轮 1 次调用、住相有内容。
3. 加校验器（硬约束 4 条）+ 超时 + fallback（用上一轮住相）。验证：§4 的"住相"段全过。
4. 加 A/B 状态机 + 指纹去重 + metrics 落盘。验证：§4 的"降级"段全过。
5. （可选）加 system-prompt section 变体，把住相也放进指令区。
6. （最后）`rolling_summary` / `soul_active_dims`——**这两项不阻塞 1-5**。先上 2 输入版本（`current_message` + `last_snapshot`），效果够不够由用户判断。

---

## 6. 待用户决定

| # | 决定 | 选项 | 影响 |
|---|---|---|---|
| **A** | 住相文本**落不落盘**？ | (a) 只在内存，resume 后第一轮没有住相；(b) 落 `RUNTIME/state/snapshot/<sessionId>.json`，resume 可恢复 | Python 侧明确选的是"不落盘"（`snapshot_store.py:1-12`，理由：隐私 + 主观感知）——需要用户确认这个立场是否延续到 JS 插件 |
| **B** | `rolling_summary` 从哪来？ | (a) ingest phase 顺带产出 `RUNTIME/state/rolling-5d.md`；(b) 插件现读最近 5 份 `RAW/conversations/*.md` 拼；(c) 先不做，只用 2 输入版本 | 决定工作量是 M 还是 L |
| **C** | 住相的**送达通道**？ | (a) `agent/pre-step` 消息（进 history，user 角色）；(b) 额外加 system-prompt section（进指令区）；(c) 两者都要 | 直接影响"档案是背景不是指令"的边界松紧，以及住相是否进 session log（隐私） |
| **D** | **每轮多一次 LLM 调用**能不能接受？ | (a) 接受，1.5s 封顶；(b) 只在"话题变化"时生成（指纹去重），不是每轮都生成；(c) 只在 idle 预生成（滞后一轮，零延迟） | 这是路径 D 的核心成本项 |
| **E** | 住相**要不要影响主动搭讪**？ | `SNAPSHOT-EXTENSION.md` §4 当初写"将来若接入：住相影响语气与内容基调（说什么），energy 管说不说，两者分工不合并" | 住相实现后是否兑现这条 |
| **F** | `soul_active_dims` 用什么抽？ | (a) 关键词匹配（`snapshot-sop.md` §2.1 原本就这么写的）；(b) 让生成住相的那次 LLM 顺带抽（不加调用，但多输出）；(c) 不做 | 影响住相的"深度" |
| **G** | 住相是否允许进 **session log**？ | `agent/pre-step` 注入的消息会被持久化（`dsh-agent-loop/lib/index.js:860-866`）。若要求"不进历史"，只能走 system-prompt 通道 | 与决定 C 耦合 |

---

## 7. 未核实 / UNVERIFIED

> 以下**没有**在已安装源码里找到直接证据，不作为设计依据。

| # | 未核实项 | 现状 | 影响 |
|---|---|---|---|
| U1 | `dsh plugin add <本地路径>` 到底做 link 还是 copy | 观察到 profile 里是 **Junction**（`node_modules\dsh-doubao-proactive` → 真实目录），但**没读 `dsh plugin` 命令的源码**来确认这是 add 的行为还是别的机制 | 若某次升级变成 copy，`§1.8` 的陷阱会消失（但 §1.8 的绕过方案仍然安全） |
| ~~U2~~ | ~~`agent/pre-step` 监听器里 append 的消息，在**首次 step**是否一定会被 `session.append`~~ | ✅ **2026-11-10 真机验证通过**——见 §7.1 | — |
| U3 | 住相的**实际效果**（模型会不会真的把它当视角而不是当指令） | 纯行为问题，静态读码无法判定 | 必须靠 §4 的盲测人工判定 |
| U4 | `MiniMax-M3.1-Flash` 的 `maxTokens` 上限与 150-token 输出是否稳定 | 配置文件里只有 provider/model（`cordis.patch.yml:353-355`），未查 provider 的模型元数据 | 影响 §2.6 的输出 token 估计 |
| U5 | 语义相似度工具（软约束"与上轮连续 > 0.6"） | 没找到 DSH 内置的 embedding/相似度服务 | 软约束只能用 Jaccard 近似 |
| ~~U6~~ | ~~`ctx.on('agent/pre-step')` 在**插件的全局 ctx** 上注册时，是否会收到所有 agent 的事件~~ | ✅ **2026-11-10 真机验证通过**——子 agent 的 pre-step 事件**确实**送到了全局监听器。见 §7.1 | — |
| ~~U7~~ | ~~`dsh-scope` 的 `scopeTarget` 对**全局注册**的 waterfall listener 的路由~~ | ✅ **2026-11-10 真机验证通过**——见 §7.1 | — |

---

## 7.1 【2026-11-10 真机验证】Step 1 探针结果

**探针插件**：`RUNTIME/plugin/dsh-doubao-snapshot/`（已装进 web profile，`inject: false` 观察模式）
**验证脚本**：`RUNTIME/scripts/verify-snapshot-probe.py`
**诊断日志**：`RUNTIME/state/snapshot-probe.log`

做法：在 `agent/pre-step` 里注入一段**硬编码的假住相**（不接 LLM、不花 token），照抄官方 `dsh-time-context` 的写法。

### U2 ✅ 注入的消息**确实落进 session log**

```
[11-10 10:11:30] session=session-6c827b kind=manas-snapshot form=snapshot
                  id=manas-snapshot-9177220a-329d-4c44-8397-c1c1c2b8580d
```

即：`decision.messages` 里 append 的非 runtime-context 消息，会在首次尝试被 `session.append("user/message", …)` 持久化。**§2.1 的送达方式成立**，`agent.inject()` 兜底方案不必启用。

同时验证了**同轮可见**：注入发生在 turn 114 的 step 17（不是 step 1），注入的那一行**当场出现在模型上下文里**——探针消息直接出现在我的输入中。

### U6 ✅ 全局监听器**会**收到子 agent 的事件

用一个一次性子 agent（`381beef0-…`）触发：

```
{"event":"agent-created","agentId":"381beef0-…","source":"startup","isRoot":false,"rootsCount":2}
{"event":"pre-step","agentId":"381beef0-…","turn":1,"step":1,"isRoot":false,"inboxMessages":1,"decisionMessages":4}
```

子 agent 的 `pre-step` **送到了 root-scoped 的全局监听器**。

> **所以：排除子 agent 必须自己判 `roots()`**，不能指望 scope 帮忙挡。

### U7 ✅ `agent/created` 时 `roots()` 已可用

`agent/created` 事件里 `isRoot: false` / `rootsCount: 2` 都算得出来 ⇒ `enter()` 先于事件派发（`dsh-agent-loop/lib/index.js:1578-1579`）成立。**可以在 `agent/created` 里就决定要不要给这个 agent 注册监听器。**

### 顺带验证到的

- **注入发生在哪个会话**：探针在 `session-0e916b00-…`（另一个 root 会话，turn 4 step 1）也注入了 —— 机制对**所有 root 会话**生效，不只是当前这一个。
- **热重载可用**：改 profile 的 `cordis.patch.yml` → `dsh-hmr` 热重载 → 插件重新 mount（`unmount`/`mount` 成对出现在日志里）→ **改插件配置不需要重启 DSH**（但改插件**源码**是否热重载未验证；本次是改 patch 配置 + 改源码后靠 patch 重载带起来的）。
- **`step === 1` 节流可行**：日志里 turn 114 的 step 11~16 全部"看到但不注入"，只有配置成每步都注入时才注。

### 还没验的（下一步要验）

| # | 待验 | 怎么验 |
|---|---|---|
| U3 | 模型会不会把住相当"视角"而不是"指令" | 真接 LLM 后做盲测（§4 验收清单） |
| U4 | `MiniMax-M3.1-Flash` 能否稳定输出 ≤150 token 的中文第一人称 | 接 LLM 后量 20 轮 |
| — | 插件**源码**改动是否热重载 | 改 `lib/index.js` 后看日志有没有新 mount |
| — | 同一轮多个 step 时注入是否只发生一次 | 用 `step === 1` 规则 + 多工具轮次观察 |



---

## 8. 相关

| 文件 | 关系 |
|---|---|
| [`RUNTIME/manas-system/docs/snapshot-sop.md`](../RUNTIME/manas-system/docs/snapshot-sop.md) | **权威契约**（用户手写 v0.2）。本文不得与之矛盾 |
| [`RUNTIME/manas-system/SNAPSHOT-EXTENSION.md`](../RUNTIME/manas-system/SNAPSHOT-EXTENSION.md) | 前身占位文；本文取代它。其 §3 的路径 A/B/C 结论在 0.2.2-rc.1 上已部分作废（见下） |
| [`RUNTIME/manas-system/prompts/snapshot_minimal.txt`](../RUNTIME/manas-system/prompts/snapshot_minimal.txt) | 现有最小 prompt 模板（token 区间 30-80，与 SOP 的 50-150 不一致，以 SOP 为准） |
| [`RUNTIME/manas-system/src/instrumental.py`](../RUNTIME/manas-system/src/instrumental.py) | 硬/软约束校验器（Python，需移植到 JS） |
| [`RUNTIME/manas-system/src/snapshot_generator.py`](../RUNTIME/manas-system/src/snapshot_generator.py) | 现有 Python 生成器（模式常量在 `:44-48`） |
| [`RUNTIME/manas-system/src/snapshot_store.py`](../RUNTIME/manas-system/src/snapshot_store.py) | metrics-only 存储（不落住相文本） |
| [`DESIGN/PROACTIVE-PLUGIN-IMPLEMENTATION.md`](PROACTIVE-PLUGIN-IMPLEMENTATION.md) | 兄弟设计文档（同一套 house style） |
| [`RUNTIME/plugin/dsh-doubao-proactive/`](../RUNTIME/plugin/dsh-doubao-proactive/) | 参考插件（安装形态、`link:` 陷阱、`ctx.llm.stream` 用法） |

### 路径 A/B/C 在 0.2.2-rc.1 上的复核

| 旧路径 | 旧结论（SNAPSHOT-EXTENSION.md §3） | 0.2.2-rc.1 复核结果 |
|---|---|---|
| A · 函数式 section | "最可行"，`text` 每 assembly 重算 = 每轮 | 🔶 **部分作废**：`text` 只能同步、不能 await LLM（`lib/types/index.d.ts:60` + `lib/index.js:389`）；"每轮重算"实为**每 step**（`dsh-agent-loop/lib/index.js:739-749`） |
| B · 每轮结尾写文件、下轮读 | 可行，滞后一轮，零工程量 | ✅ 仍成立，但已被路径 D 覆盖（D 能做到同轮） |
| C · 保持现状（5 天周期） | 不做 | ✅ 不变（`SNAPSHOT_LATEST.md` 继续是末那识周期总结，不是住相） |
| **D · async 生成 + 每轮注入** | — | 🆕 **本文推荐**。机制：`agent/pre-step` waterfall（`dsh-agent/lib/types/runtime-types.d.ts:320-339`），先例 `dsh-time-context/lib/index.js:249-282` |

---

_Last updated: 2026-11-10 · DSH 0.2.2-rc.1 · 所有 DSH 断言均在本机已安装源码逐条核对；U2/U6/U7 已真机验证（§7.1）_
