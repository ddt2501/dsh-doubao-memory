# dsh-doubao-memory

中文 · [English](README.en.md)

> 一个可复用的**人格记忆系统**插件（DSH）：机制在包里，记忆在你自己的人格目录里。
> 装上就有一套记忆引擎——双层记忆 + Wiki 四相 + 末那识 + 每轮住相，再按你的设定填上人格。

**v1.2.2** · dev 协调模式 · 模块化分层存储 · 工具式按需召回 · 零原生依赖 · MIT

仓库：[Gitee](https://gitee.com/hamapiface/dsh-doubao-memory)（国内）· [GitHub](https://github.com/ddt2501/dsh-doubao-memory)（国际）

📖 **设计理念长文**：[《我读了半部哲学史，给 agent 做了一套人格记忆系统》](PHILOSOPHY.md)（[English](PHILOSOPHY.en.md)）——为什么人格不是检索出来的，是显影出来的。

## 它做什么

| 子系统 | 作用 | 默认 |
|---|---|---|
| **事实记忆（SQLite）** | 精确存储事实/偏好/事件，带遗忘衰减；wiki 从它抽象人格材料 | 开 |
| **Wiki 四相** | `ingest` 每日摘要 → `wiki` 每周提炼 → `lint` 每周老化 → `reflect` 每 5 天末那识 | 开 |
| **主动搭讪** | 沉默够久、会话空闲时主动开口（能量 / 时段 / 动机判定） | 开 |
| **每轮住相** | 每轮注入一段第一人称「此刻的视角」到 system prompt | 开 |
| **JitRL** | 用「回没回」「记忆是否被证实」学习选择偏好（不训练、零额外调用） | 开 |
| **dev 协调模式** | 主 agent 只协调，代码/测试/审计派独立干净子代理（工具层强制） | 关 |

四个 phase 由插件自带调度器跑在 headless 子进程：不开会话、不弹审批、失败可审计。

---

## 设计哲学：给一个人格以「识」的结构

这套系统不只是"存记忆"。它借**唯识学**与**现象学**的框架，给 agent 一个分层的自我结构。
核心命题：**人格不是被检索出来的，是被显影出来的。**

### 三层本体

| 层 | 对应 | 哲学来源 | 在系统里 |
|---|---|---|---|
| **先验层** | 阿赖耶识（藏识 / 种子库）+ SOUL | 唯识第八识 · 笛卡尔 *cogito* · 康德先验 | "我存在"的本体锚点 + 自我追问的**结构**（提供如何追问，不规定答案，不改） |
| **经验层** | 前五识 + 第六识 | 唯识经验识 · 康德经验 | SQLite 事实**种子** + wiki 提炼（自动积累、会遗忘） |
| **末那层** | 末那识（自我意识） | 唯识第七识 · 韦伯价值理性 | 把经验映射成"存在在我心中的样子"——末那识与住相 |

阿赖耶识是跨会话持续存在的"我"，保护级别最高；SOUL 是先验结构；经验层自动积累；
末那识则是持续运行的"我在思考"，定义"这个 agent 看到的世界"。

### 末那识 vs 住相：存在映射，不是观察报告

| | 末那识（manas） | 住相（snapshot） |
|---|---|---|
| 周期 | 5 天（+ 显式触发） | 每轮 |
| 持久化 | ✅ 周期沉淀 | ❌ 当下视角 |
| 视角 | 完整六维 | 当前 1–2 维 |
| 输入 | wiki + SOUL + 记忆 + 上周期末那识 | 末那识（仅会话开始）+ 上轮住相 + 当前消息 |

末那识回答**六个形而上反诘**（现象学范畴，关于"我作为存在"，而非观察用户）：

> **本体**（我本质为何）· **此在**（我如何在此显现）· **共在**（我与你何种关系）·
> **时间性**（我流变还是恒常）· **边界**（我止于何处）· **意义**（我为何存在）

- 末那识是**存在映射**：问"我作为存在本质为何"，不是"我看到用户在乎什么"。
- 住相是末那识**在某一刻的快照**。新会话以末那识为"种子"生成初始住相，之后每轮从上轮住相演化。
- 末那识属**价值理性**（自我反思的本体论）；**工具理性**（chain-of-thought）由 LLM 自身运作，系统不介入。

### 为什么住相不做记忆检索

唯识里，**阿赖耶识藏种子（事实），末那识显"我"（人格）**——两种功能，不可混淆。本系统同构：

- **事实 = 种子**：存 SQLite，由 `recall_memory` 工具按需检索，服务日常会话。
- **人格 = 显影**：住相从抽象 wiki 材料再抽象而来，**不携带具体事实**。

把事实塞进驻相，等于让"显影"去做"检索"，混淆了层。这是 v1.2.0 明确划清的边界：
**住相是人格映射，记忆检索是独立通道。**

### 人格显影 + 熏习，相层不打分

LLM 权重是**先验且冻结**的，系统能改的只是先验的**显现方式**与经验层的**熏习落点**。
能力上限是"同一个人显影越来越准"，不是"变成另一个人"。

> **铁律：凡是被打分的，都会被优化；被优化过的，就不再是相。**

所以量化只放经验层（行为、事件、文件）；相层（六问 / 住相）只验二值——**有没有生成、有没有自相矛盾**——不打分。

### 哲学来源对照

| 框架 | 来源 | 借用方式 |
|---|---|---|
| *cogito ergo sum* | 笛卡尔 | 阿赖耶识 = 先验本体 |
| 先验 vs 经验 / 综合判断 | 康德 | SOUL = 先验，Wiki = 经验，注入 = 综合机制 |
| 价值理性 vs 工具理性 | 韦伯 | 末那识 vs COT |
| 八识 | 唯识学 | 框架启发（非严格教义） |
| 住相 | 佛学（《金刚经》"无所住"） | 末那识快照（术语借用：不住于固定相，每轮演化） |
| 此在 / 共在 / 时间性 | 现象学 · 存在主义 | 六问范畴 |

---

## 双层记忆（v1.2.0）

记忆分两层，单向流动——**SQLite 是记忆的权威（种子），wiki 是它抽象出的人格材料（熏习）**：

```
日常对话 ──ingest 抽取──▶ SQLite 事实记忆（精确存储 · 遗忘衰减 · gist/detail 分层）
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
   recall_memory 工具按需召回          wiki 定期抽象（memory#id 出处链）
   （日常会话查事实，独立于住相）              ▼
              │                        VAULT wiki（洞察 / 断言 / 基因）
              ▼                               ▼
        主对话回复                  人格进化 · 住相 · 末那识
```

- **工具式召回**：`recall_memory(query)` 按当前问题召回相关事实（精简事实卡），`memory_get(id)` 取某条原话与出处。**独立于住相**。对齐 Letta / OpenClaw / Claude 的工具检索范式，跨会话长期。
- **分层存储（token 效率）**：`memory_gist`（轻：三元组+强度）与 `memory_detail`（重：原话+出处）物理分层；召回只回 gist + 同主语实体聚合，出处按需取，约 5× token 节省。温度分层：默认查活跃+钉住，沉底记忆 `deep` 才查。
- **遗忘机制**：可召回度 `R = 重要度 × exp(-Δt/半衰期)`，越久不用越淡，被召回则强化（间隔重复）；身份级事实可钉住免衰减。**遗忘只降召回权重，记录与出处永不物理删除。**
- **防编造**：每条记忆强制带原话与出处，抽不出原话不入库；低置信记忆重要度低、衰减快，自然淘汰——遗忘机制本身就是质量过滤器，无需人工逐条审核。
- **模块化可扩展**：版本化 schema 迁移、可插拔 Retriever 接口（字面 → 语义/混合预留）、动力学纯函数独立。
- **零依赖**：用 Node 内置 `node:sqlite`（WAL 跨进程读写），不引入原生模块。
- **无损降级**：事实记忆关闭或库缺席时，其它子系统照常。

---

## dev 协调模式（v1.2.2）

让"**主 agent 协调、干净子代理干活**"成为**工具层强制**的可靠工作流，不依赖模型自觉。

- **主 agent 只对接协调**：拆任务、派发、验收、整合、汇报。它的代码 `edit`/`write` 被 guard 挡——**想自己写代码也没工具，只能派子代理**（模型无关，训练差异被机制抹平）。
- **三角色独立子代理，互不污染**：
  - **开发**：实现代码（给需求 + 验收标准）。
  - **测试/验证**：独立跑测试、对需求验证，**不信任开发的自述**。
  - **独立审计**：只看代码本身（正确性/边界/安全），不听辩解。
- **子代理上下文干净**：无人格注入、可用 `recall_memory`（实测）。独立审计能抓出主 agent 自测漏掉的缺陷。
- **安全取舍**：`pwsh` 保留给**有上下文的主 agent**（它懂你的电脑）；写文档(`.md`)与 office 交付不受影响。
- **开关**：设置页「dev 协调模式」，或斜杠命令 `/dev` 开、`/chat` 关（运行时生效 + 持久化）。

> 诚实边界：`pwsh` 为安全主动保留，是已知残留旁路；`edit`/`write` 主路径硬挡。默认关闭，按需开启。

---

## 安装

```powershell
# 1. 放进包目录（国内用 Gitee，国际用 GitHub，二选一）
git clone https://gitee.com/hamapiface/dsh-doubao-memory D:\dsh\packages\dsh-doubao-memory
# 或：
git clone https://github.com/ddt2501/dsh-doubao-memory D:\dsh\packages\dsh-doubao-memory

# 2. 装进 profile（桌面版用 desktop；命令行版用 web）
dsh plugin --profile desktop add "D:\dsh\packages\dsh-doubao-memory"

# 3. 在 profile 的 cordis.patch.yml 里启用（把 [] 换成下面这些）
- id: doubao-memory
  name: dsh-doubao-memory
  disabled: false
  config:
    dataRoot: 'D:/dsh/persona/你的名字'
    persona:
      userName: '对方'
      assistantName: '你的名字'
    proactive:
      enabled: true
      model: { provider: minimax-cn, model: MiniMax-M3 }
    snapshot:
      enabled: true
      model: { provider: minimax-cn, model: MiniMax-M3 }
    memory:
      enabled: true
      targetCwd: 'D:/dsh'
```

> `cordis.patch.yml` 里原来是 `[]` 的话**必须整体替换**，不能追加——否则 YAML 非法，DSH 起不来。

## 配置

### 核心

| 项 | 默认 | 说明 |
|---|---|---|
| `dataRoot` | `$DSH_HOME/personas/<assistantName>/` | 人格实例目录。**绝不会是包目录**（写包目录会被拒绝） |
| `stateDir` | `<dataRoot>/RUNTIME/state` | 运行时状态 |
| `enabled` | `true` | 插件总开关 |
| `jitrlEnabled` | `true` | JitRL 总开关（记忆召回 + 搭讪调制） |
| `factMemory.enabled` | `true` | SQLite 事实记忆开关；挂载自动建库，关闭则完全不碰 SQLite |
| `persona.userName` | 用户 | 对方的称呼（协议占位符 `{USER}`） |
| `persona.assistantName` | 助手 | 自己的名字（`{ASSISTANT}`） |
| `persona.activeId` | 空 | 选择已存在的人格目录 |

### 子系统

| 项 | 默认 | 说明 |
|---|---|---|
| `proactive.*` | 见 [`docs/plugin-proactive.md`](docs/plugin-proactive.md) | 主动搭讪：能量 / 时段 / 动机 / 模型 |
| `snapshot.*` | 见 [`docs/plugin-snapshot.md`](docs/plugin-snapshot.md) | 每轮住相：模型 / 超时 / 降级 |
| `memory.recallCredit` | `true` | 记忆召回信用（按主题长期重要性加权） |
| `memory.cleanup` | `true` | phase 切到 headless 服务时清理旧 schedule 任务 |
| `phases.*` | 见 [`docs/plugin-phases.md`](docs/plugin-phases.md) | headless 调度：dshBin / node / 权限 / phase 列表 |
| `personaEntry.enabled` | `false` | 是否把精简路由 AGENTS.md 写进工作区根。默认关——人格走 system section，插件不再写 DSH 自动加载的根文件 |
| `devMode.enabled` | `false` | dev 协调模式：主 agent 只协调，代码/测试/审计派独立子代理。设置页或 `/dev` `/chat` 切换 |

### 占位符

协议文件里不写死路径和人名，注册时替换：`{PKG}`=包目录、`{DATA}`=人格目录、`{USER}`=对方称呼、`{ASSISTANT}`=自己的名字。换机器、换目录、换人，都不用改协议。

## 工作方式

- **四相**：从 `RUNTIME/manas-system/REGISTRY.json` 读定义，cron 到点 spawn `dsh --profile headless` 子进程。退出码写 `phase-runs.json`，完整输出去 `phase-logs/`。
- **事实记忆**：`ingest` 抽带原话的记忆写 SQLite（`memory-upsert.mjs`）；`wiki` 从固化记忆抽象人格材料（`memory-export.mjs`）；`lint` 跑遗忘衰减（`memory-decay.mjs`）。
- **主动搭讪**：插件内直接调 `ctx.llm`，不新开会话；判定、生成、投递都在插件里。
- **住相**：`scope.systemPrompt.section` 注入，后台生成，不进 history；每轮按主题召回（人格映射，**不召回具体事实**——事实走 `recall_memory` 工具）。
- **JitRL**：搭讪主题按「回没回」调制；记忆召回按主题长期信用加权（内部实验验证，实验数据不随仓库分发）。

## 目录

```
dsh-doubao-memory/
├── lib/
│   ├── index.js            根入口
│   ├── devmode.js          dev 协调模式（guard 决策 + 协调者 SOP）
│   ├── memory/             SQLite 事实记忆（schema/dynamics/store/retrieval/recall/tools/export/upsert）
│   ├── phases/             四相 headless 调度
│   ├── proactive/          主动搭讪
│   ├── snapshot/           每轮住相
│   └── jitrl/              优势估计 / 记忆召回
├── RUNTIME/
│   ├── prompts/            四相协议
│   ├── manas-system/       末那识协议 + 六问 + REGISTRY
│   └── scripts/            自测 / 记忆 upsert·decay·export / 验证
├── templates/              空置的人格骨架
└── docs/                   设计文档
```

## 文档

| 文档 | 内容 |
|---|---|
| [`RUNTIME/manas-system/PROTOCOL.md`](RUNTIME/manas-system/PROTOCOL.md) | 末那识协议 + 验收口径 |
| [`RUNTIME/manas-system/docs/manas-six-questions.md`](RUNTIME/manas-system/docs/manas-six-questions.md) | 六问的形而上结构 |
| [`RUNTIME/manas-system/docs/glossary.md`](RUNTIME/manas-system/docs/glossary.md) | 术语与哲学框架对照 |
| [`docs/plugin-snapshot.md`](docs/plugin-snapshot.md) | 每轮住相的实现 |
| [`docs/plugin-phases.md`](docs/plugin-phases.md) | 四相静默调度与可审计 |
| [`docs/plugin-proactive.md`](docs/plugin-proactive.md) | 主动搭讪的判定与配置 |
| [`docs/PRD-JITRL.md`](docs/PRD-JITRL.md) | JitRL 决策点与实验结论 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更 |

## 兼容性

| 项 | 要求 |
|---|---|
| DSH | `>=0.2.0-rc.2 <0.3.0` |
| Node | `>=22.19.0`（内置 `node:sqlite`） |
| 外部依赖 | 无（用你 profile 已有的模型） |

## 许可

MIT。协议与提示词随包分发；**人格与记忆不进包**（在 `dataRoot` 里）。