# Phase 服务 —— 四个自动化的静默运行

> 2026-11-18 用户两次质疑之后重做的调度层。
>
> 原来：DSH `schedule` 服务 + `target: 'new'` ⇒ **每次触发开一个新会话**。
> 现在：插件自带调度器 + `dsh --profile headless` 子进程 ⇒ **不开会话、不弹审批**。

## 1. 为什么重做

用户 2026-11-18 原话：

> 「自动化任务 **需要审批就很怪**，**需要开启会话运行也很怪**，有没有别的静默运行办法」

> 「不要弄 windows 计划任务，毕竟是插件，跟 dsh 生态要兼容，模块化，方便 git 和开源复用。
>   在 headless 基础上再想方案。**静默运行的同时还需要可审计**。用后端服务怎么样」

旧方案的三个问题：

| 问题 | 后果 |
|---|---|
| 每次触发开新会话 | 会话列表被污染；界面上多出四个"没人说过话的会话" |
| 新会话拿默认权限（`workspace-write` + `ask`） | **无人值守时卡在审批弹窗**（2026-11-18 凌晨 4:00 的 ingest 就卡了，用户 19:28 才发现） |
| 依赖 DSH 的 `schedule` 服务 | 插件被禁用/卸载时任务会被清掉（当天就发生过：4 个任务全没了） |

## 2. 怎么做的

```
dsh-doubao-memory 插件 mount
  └─ mountPhaseService()
       ├─ 从 RUNTIME/manas-system/REGISTRY.json 读 phase 定义（唯一真相源）
       ├─ setInterval 每 60 秒检查一次
       │    └─ duePhases(): cron 匹配 && 今天没跑过
       └─ 到期 → spawn `node <dsh-bin> --profile headless`
                    --permission-mode danger-full-access
                    --approval-policy never
                    <从 RUNTIME/prompts/<phase>.md 展开的任务>
                 └─ stdout/stderr → phase-logs/<phase>-<date>.ndjson
                 └─ 退出 → 写 phase-runs.json + phase-state.json
```

### 2.1 为什么是 headless 子进程

`dsh --profile headless` 是 DSH 官方的**一次性 agent 运行器**，官方描述：

> a direct core Agent/Session runner over dsh-base with **no Host, HTTP, or browser layer** —
> opens no ports and leaves nothing running behind

⇒ 行为跟会话里一致，但没有窗口、没有 HTTP 层、跑完即退。

**为什么不进程内跑 agent**：需要一个完整的 agent 栈（session / context / tools /
prompt 组装），等于重造 DSH 核心。子进程还额外获得**崩溃隔离**。

### 2.2 为什么不用 `ctx.jobs`

`ctx.jobs.start()` 要求 `servesOwner(owner)` 成立
（`dsh-jobs-local/lib/index.js:553`）：

> The global layer holds every controller attached from an unscoped context —
> a host composition's own controls — and therefore serves every owner

而 **job controller 由 agent 侧的 `dsh-tool-jobs` 提供**，插件所在的 host scope 没有
⇒ 直接调会抛 `background jobs unavailable: no job controller serves this agent`。

⇒ 插件自己跑。代价：DSH 的 Jobs 面板看不到实时进度（用 `phase-runs.json` 代替）。

## 3. 可审计（三层）

| 层 | 位置 | 看什么 |
|---|---|---|
| **历史** | `RUNTIME/state/phase-runs.json` | 时间 / 耗时 / **退出码** / 错误（可 git diff） |
| **全量** | `RUNTIME/state/phase-logs/<phase>-<date>.ndjson` | 完整输出流，逐行复盘 |
| **事件** | `RUNTIME/state/doubao-memory.log` 的 `phase-start` / `phase-done` | 调度决策 |

`phase-runs.json` 的一条记录：

```json
{
  "at": "2026-11-19T04:00:00.000Z",
  "phase": "ingest",
  "title": "助手·Daily Ingest",
  "trigger": "cron",
  "durationMs": 115600,
  "exitCode": 0,
  "error": null,
  "ok": true
}
```

**为什么退出码最重要**：`跑了` 和 `跑成了` 是两件事。旧方案用会话跑，
界面上只能看到"有这条会话"，看不到成功没有 ⇒ **失败了也像成功**。

## 4. 配置

极简——phase 定义全在 `REGISTRY.json` 里，配置只管开关和路径：

```yaml
- id: doubao-memory
  config:
    phases:
      enabled: true
      # dsh 的入口脚本（headless 模式的 bin.js）
      dshBin: '<npx 缓存>/node_modules/@deepseek-ai/dsh/lib/bin.js'
      # node 可执行文件；留空则从 PATH 找
      nodeExe: 'D:\tools\nodejs\node.exe'
      # 跑 phase 的工作目录
      cwd: 'D:/dsh'
      headlessProfile: headless          # 默认
      permissionMode: danger-full-access # 默认（写文件不弹审批）
      list: []                           # 追加/覆盖 REGISTRY 里的 phase
```

### 4.1 怎么找 `dshBin`

DSH 是 Electron 应用，`dsh` 通常不在 PATH。它在 npx 缓存里：

```powershell
Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx" -Recurse -Depth 3 -Filter "bin.js" -EA SilentlyContinue |
  Where-Object { $_.FullName -match '@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js' } |
  Select-Object -First 1 -ExpandProperty FullName
```

或者从正在运行的 DSH 进程环境里读 `DSH_INSTALL_DIR`。

### 4.2 `nodeExe` 为什么必须单独配

⚠️ **不能用 `process.execPath`**：插件跑在 DSH 的 Electron 进程里，
`process.execPath` 是 `DeepSeek Harness.exe`（GUI 程序），不是 node
⇒ spawn 它会当 GUI 启动，直接失败（实测退出码空、0 秒）。

`ELECTRON_RUN_AS_NODE=1` + asar 内的 bin.js 也走不通（实测）。

## 5. 跟旧 schedule 的关系

`phases.enabled: true` 时：

1. **跳过** `mountMemorySystem` 的 schedule 注册
2. **立即清理**之前注册过的 4 个 schedule（日志 `schedule-cleanup-on-switch`）

⇒ 两条路不会同时跑（否则跑两遍，浪费 token + 重复写文件）。

想回退：`phases.enabled: false` ⇒ 恢复用 DSH schedule（会重新注册 4 个任务）。

## 6. 实测数据（2026-11-18）

| 测试 | 耗时 | 结果 |
|---|---|---|
| headless 简单任务 | 3.7 秒 | 退出码 0 |
| headless 写文件 | 4.2 秒 | 文件真写入 |
| headless 完整 ingest | 115.6 秒 | `Ingest done · 2026-11-17 · 2 topics · 14 moments · 5 new preferences · 4 corrections` |
| **插件调度器跑 probe phase** | 5.3 秒 | `exitCode: 0, ok: true`，审计自动落盘 |

## 7. 可靠性：休眠 / 断电 / 断网 / DSH 关闭

| 场景 | 影响 | 应对 | 状态 |
|---|---|---|---|
| **DSH 关闭** | 插件不加载 ⇒ 调度器不存在 ⇒ phase 不跑 | 再开 DSH ⇒ mount 后 5 秒检查 ⇒ `lastDueAt` 发现"该跑没跑" ⇒ **补跑最近一次** | ✅ |
| **电脑休眠** | 进程冻结，timer 不走 | 唤醒后 setInterval 立即补一次回调（≤60 秒内）⇒ 同样靠补偿触发 | ✅ |
| **断网** | headless 调模型失败 ⇒ 退出码非 0 | 失败退避 1→2→4→8…封顶 60 分钟，网络恢复后自动成功 | ✅ |
| **断电 / 强杀** | `done()` 不执行 ⇒ 审计零痕迹 | `phase-current.json` 在途记录 ⇒ 下次启动检测到 ⇒ 补记 `interrupted` + 自动补跑 | ✅ |

### 7.1 补偿的语义（关键）

统一靠 `lastDueAt()`：**反推"最近一次应该触发的时刻"**，与 `lastRunAt` 比较。

```
lastRunAt >= 最近一次应触发时刻  ⇒ 已处理过，不跑
否                              ⇒ 跑（哪怕现在早就过了那个点）
```

⇒ **错过不会永远错过**，而且**只补最近一次**（不补一堆）。
跟 DSH `schedule` 的语义一致（"only the latest missed occurrence is delivered"）。

**举例**：断网 + 关机 3 天，第 3 天开机。
- ingest（每天 4:00）：只补**今天** 4:00 那次，不补前两天的
- wiki（每周日）：如果这 3 天里跨过周日 ⇒ 补最近那个周日
- 若 4 个 phase 同时该补 ⇒ **串行**跑（一个跑完再下一个），不会并发烧 4 份 token

### 7.2 断电留下的半截文件

`phase-current.json` 能让你知道"上次跑到一半没了"，但**不能保证文件完整**。

各 phase 的风险与自愈：

| phase | 写什么 | 断电风险 | 自愈 |
|---|---|---|---|
| ingest | `RAW/conversations/YYYY-MM-DD.md` | 可能截断 | **次日覆盖写** ⇒ 自愈 |
| wiki | `VAULT/0N-XXX/*.md` 增量 | 可能写坏某页 | 下次 wiki 会重读重写；必要时用 git 回滚 |
| lint | `07-INDEX.md` / `08-LOGS.md` | 可能写坏 | 同上 |
| reflect | `SNAPSHOT_LATEST.md`（整体覆盖） | 可能截断 | 下次 reflect 覆盖 |

> **建议**：`D:\dsh\persona\助手` 纳入 git（它已经是仓库）。
> 断电后 `git status` 一眼看出哪几页被写到一半，`git checkout -- <file>` 回滚。
> **这是比任何自动修复都可靠的兜底。**

### 7.3 开机自启的前提

补偿逻辑要求"DSH 在某个时刻重新跑起来"。所以：

1. **DSH 需要开机自启**（或至少你每天开一次）
2. **headless 的凭证在 `$DSH_HOME/.env`** ⇒ 不依赖 GUI 登录也能跑（已实测）
3. 如果长时间不开 DSH ⇒ 只有最近一次会被补（更早的放弃），这是**有意为之**（不堆积历史欠账）

### 7.4 没有解决的

| 情况 | 说明 |
|---|---|
| **DSH 一直不开** | 没有任何东西会跑。这是设计选择（用户明确说过"dsh不开也太怪了"） |
| **断电时正在写关键文件** | 半截文件只能靠 git 回滚，插件不做原子写（LLM 用 write 工具，插件控制不了） |
| **系统时间被改** | cron 判定用本地时间；改时区/时间会造成一次误判，下一轮自愈 |

## 8. 已知边界

1. **DSH 桌面必须开着** —— 调度器跟着插件生命周期。用户明确说
   「dsh不开也太怪了」⇒ 这是**设计选择**，不是缺陷。
2. **headless 仍会在 `sessions/` 留一个记录文件** —— 界面上看不到
   （无 Host 层），但磁盘上有。可定期清理。
3. **一次只跑一个同 phase** —— `running` 集合挡住并发；不同 phase 可以并行。

## 9. 文件

| 文件 | 作用 |
|---|---|
| `lib/phases/service.js` | 调度器：cron 检查、spawn headless、输出转发、取消 |
| `lib/phases/schedule.js` | 极简 cron 判定（5 字段）+ 按天去重 |
| `lib/phases/audit.js` | 三层审计的写入与读取 |
| `RUNTIME/scripts/test-phases.mjs` | 自测（41 条断言） |
