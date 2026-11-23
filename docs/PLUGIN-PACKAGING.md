# 打包成 DSH 可复用插件（2026-11-10）

> 目标（用户原话）：**"把我们的所有人格记忆系统（包括 llm wiki manas）等，打包为一个 dsh 的可复用插件，存入本地 git 仓库，以后本机如果对系统进行了升级，还能自动同步"**
>
> 结果（2026-11-10 晚间修订）：拆成**机制与数据两层**——
> **插件包**是可复用、可分发的（人格是空的）；**人格实例**是本机的配置（不进包）。
> 拆分的理由：用户要求"**助手人格是本机的配置，插件版应该是空置状态，其他用户安装后进行设置**"。
>
> ```
> D:\dsh\packages\dsh-doubao-memory\   ← 插件包（机制）+ 本地 git 仓库，可装到别的机器
> D:\dsh\persona\助手\                  ← 人格实例（助手的人格与记忆）+ 本地 git 仓库
> ```

---

## 1. 结构

### 插件包（机制 · 可分发 · 人格为空）

```
dsh-doubao-memory/
├── package.json              ← DSH bundle 清单（dsh.bundle.patch → cordis.patch.yml）
├── cordis.patch.yml          ← 一个 entry：id doubao-memory
├── lib/                      ← 插件代码
│   ├── index.js              ←   根入口：注入服务 → 挂三个子系统
│   ├── paths.js              ←   包根 / 数据根解析（可移植）
│   ├── log.js                ←   共享诊断日志
│   ├── memory-system.js      ←   注册 LLM Wiki 四相 schedule（幂等）
│   ├── proactive/            ←   主动搭讪子系统
│   └── snapshot/             ←   per-turn 住相子系统
├── RUNTIME/
│   ├── prompts/              ← 四相协议（路径写 {PKG} / {DATA} 占位符）
│   ├── manas-system/         ← manas 协议 + 校验器 + REGISTRY（**不含 cycle 数据**）
│   └── scripts/              ← 自测 + setup-persona.ps1（安装向导）+ sync-repo.ps1
├── templates/                ← **空置的人格骨架**（装完自己填）
├── docs/                     ← 协议与设计文档
├── .git/                     ← 本地仓库
└── .gitignore
```

### 人格实例（本机配置 · 不进包）

```
助手/
├── IDENTITY/                 ← 人格三件套 + 人格进化指令 + 提案/快照目录
├── VAULT/                    ← 蒸馏后的记忆（24 页 + frontmatter 老化字段）
├── RAW/                      ← 每日对话摘要
├── MEMORY.md                 ← 跨会话硬事实
├── SNAPSHOT_LATEST.md        ← 末那识周期总结
├── DESIGN/                   ← 设计文档与决策历史（本机专属）
├── RUNTIME/state/            ← 运行时状态
├── RUNTIME/manas-system/data/← manas cycle 数据
├── RUNTIME/memory/           ← OpenClaw 时期历史档案（不进 git）
└── .git/
```

**为什么拆**：DSH 只认 `package.json` + `dsh.bundle.patch`，而包里的路径都是相对包根解析的。
**机制与数据分开** ⇒ 别的机器装同一个包，得到的是**空人格 + 完整引擎**；本机的记忆永远不进包、不外传。

---

## 2. 装上会发生什么

```powershell
dsh plugin --profile web add "D:\dsh\packages\dsh-doubao-memory"
```

1. pnpm 在 profile 里建 **junction**：`node_modules\dsh-doubao-memory → D:\dsh\packages\dsh-doubao-memory`
2. profile 的 `package.json` 加依赖 `link:D:/dsh/persona/助手` + `dsh.profile.bundles` 加 `dsh-doubao-memory`
3. profile 的 `cordis.patch.yml` 里启用这一行（**安装不会自动改 patch 文件**，要自己加）：
   ```yaml
   - id: doubao-memory
     name: dsh-doubao-memory
     disabled: false
     config:
       proactive: { ... }
       snapshot:  { ... }
       memory:    { ... }
   ```
4. 重启 DSH web（改 `package.json` 必须重启；改 `cordis.patch.yml` 会被 `dsh-hmr` 热重载）

启动后插件做三件事：

| 子系统 | 做什么 | 关键设计 |
|---|---|---|
| **memory-system** | 从 `RUNTIME/manas-system/REGISTRY.json` 读 4 个 phase，注册成 schedule | **幂等**：按 title 查已有任务，有就跳过 → 反复重载不会重复注册 |
| **proactive** | 沉默够久且会话真空闲时主动开口 | `agent.runMaintenance`（non-turn），忙时直接跳过 |
| **snapshot** | 每轮一段第一人称住相 | 走 system prompt 的 section，**零延迟、不进 history** |

### 幂等的一个坑（2026-11-10 踩到）

`ctx.schedule.list()` 返回的是 **`items`**（`dsh-schedule/lib/index.js:2276` → `{items, shown, total, limit, offset}`），
不是 `entries`/`tasks`。写错字段名 ⇒ 查重永远查不到 ⇒ **每次插件重载都多注册 4 个 phase**。
→ `lib/memory-system.js` 用 `listed?.items ?? []`；`RUNTIME/scripts/test-memory-system.mjs` 的 mock 也按真实形状返回。

---

## 3. 可移植性

| 东西 | 怎么办 |
|---|---|
| 路径 | `lib/paths.js` 从 `import.meta.url` 解析**包根**（运行时穿 junction 指回真实目录，实测一致）；配置 `dataRoot` 可把数据指到别处 |
| prompt 里的绝对路径 | `lib/memory-system.js` 的 `rewritePaths()` 把包根替换成实际 `dataRoot` |
| 人格入口（AGENTS.md） | DSH 只自动加载**工作区根**的 AGENTS.md。插件可选地把它写过去（`config.personaEntry`），**默认关闭**（只写不覆盖） |

> **装到别处 = 装一套完整的人格**（IDENTITY + VAULT + RAW 都随包走）。
> 只想装机制不带记忆 ⇒ `dataRoot` 指向另一个空目录。

---

## 4. Git 仓库与"自动同步"

**仓库 = persona 目录本身**（`git init` 于 2026-11-10），所以"本机升级"= 工作区改动，不需要导出/导入。

| 机制 | 说明 |
|---|---|
| `RUNTIME/scripts/sync-repo.ps1` | ① `git add -A` → 有变化就 commit（有 remote 就 push）② **安装自愈**：检查 junction / profile 的 package.json / patch 行，缺了就补 |
| 计划任务 `DSH-Memory-Sync` | 每 6 小时跑一次（`schtasks /create /sc hourly /mo 6`） |
| 手动 | `powershell -ExecutionPolicy Bypass -File RUNTIME\scripts\sync-repo.ps1` |

### "DSH 升级后自动同步"指的是什么

DSH 升级可能重写 profile 的 `node_modules` / `package.json` ⇒ 插件的 junction 没了、bundle 条目没了。
`sync-repo.ps1` 的第二部分就是**自愈**：检查三件事，缺了就补回去。
（DSH 升级也可能改 `cordis.patch.yml` 的行 id —— 那一行是**用户层**的，DSH 不会主动删，但手动删了也会被补回。）

### .gitignore 排除什么

| 排除 | 原因 |
|---|---|
| `RUNTIME/memory/dreaming/` | OpenClaw 时期 337 个文件 / 2.4 MB 的历史档案；源在 `D:\用户与豆姐` 与 `D:\openclaw\workspace` |
| `*.log` / `RUNTIME/state/*.log` | 运行时噪声 |
| `RUNTIME/_errors/` | 失败日志 |
| `node_modules/` | — |

**保留**：代码、协议、提示词、脚本、**VAULT（记忆）**、**RAW（每日摘要）**、IDENTITY（人格）、manas cycle 数据。

---

## 5. 自测

```powershell
node RUNTIME\scripts\test-proactive-decide.mjs      # 判定逻辑 9 项
node RUNTIME\scripts\test-proactive-plugin.mjs      # 主动搭讪端到端
node RUNTIME\scripts\test-snapshot-plugin.mjs       # 住相端到端（含 section / 后台生成 / A-B 降级）
node RUNTIME\scripts\test-memory-system.mjs        # 四相接线（mock schedule 服务）
```

四套都驱动**根入口** `lib/index.js`（真实集成面），不是各子模块。

---

## 6. 迁移记录（2026-11-10）

| 之前 | 之后 |
|---|---|
| `dsh-doubao-proactive`（独立包，`RUNTIME/plugin/` 下） | 并入 `dsh-doubao-memory` 的 `lib/proactive/` |
| `dsh-doubao-snapshot`（独立包） | 并入 `lib/snapshot/` |
| 4 个 phase 要手动 `schedule_create` | 插件启动时**自动注册**（幂等） |
| 路径写死在代码里（`D:\\dsh\\persona\\助手\\...`） | 相对**包根**解析 + `dataRoot` 可覆盖 |
| 无版本控制 | git 仓库（本地），计划任务每 6 小时自动提交 + 安装自愈 |

迁移中修掉的三个 bug：

1. `schedule.list()` 的返回字段写错（`entries` → `items`）⇒ 会重复注册 phase
2. `lib/snapshot/index.js` 漏 `import { join } from 'node:path'` ⇒ ReferenceError，整个住相不挂载
3. LLM chunk 收集：适配器**只发块不发 delta** ⇒ 按 delta 收会漏收；块与 delta 混着收会**收两遍**（文本重复）⇒ 统一成"块与 delta 分开收、块优先"

---

## 7. 相关

- [`DESIGN/PROACTIVE-PLUGIN-IMPLEMENTATION.md`](PROACTIVE-PLUGIN-IMPLEMENTATION.md) — 主动搭讪
- [`DESIGN/SNAPSHOT-PER-TURN-IMPLEMENTATION.md`](SNAPSHOT-PER-TURN-IMPLEMENTATION.md) — per-turn 住相
- [`DESIGN/SNAPSHOT-COST.md`](SNAPSHOT-COST.md) — 成本核算
- [`RUNTIME/manas-system/PROTOCOL.md`](../RUNTIME/manas-system/PROTOCOL.md) — manas 协议
- [`RUNTIME/manas-system/REGISTRY.json`](../RUNTIME/manas-system/REGISTRY.json) — 四相注册表（插件的真相源）
