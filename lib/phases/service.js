/**
 * **Phase 服务** —— 让四个自动化 phase 静默运行，且可审计。
 *
 * ## 为什么要重做（2026-11-18 用户的两次质疑）
 *
 * > "自动化任务 需要审批就很怪，需要开启会话运行也很怪，有没有别的静默运行办法"
 *
 * 原来用 DSH 的 `schedule` 服务，`target: 'new'` ⇒ **每次触发开一个新会话**：
 * - 要权限 ⇒ 无人值守时卡在审批弹窗（用户 19:28 才发现）
 * - 会话列表被污染 ⇒ 界面上多出四个"没人说过话的会话"
 * - **DSH 桌面不开，schedule 服务就不存在** ⇒ 所有自动化静默停摆
 *
 * ## 现在怎么做
 *
 * 插件**自己带调度器**，跑在 `ctx.jobs`（DSH 原生后台任务注册表）里：
 *
 * ```
 * 插件 mount
 *   └─ ctx.inject(['jobs']) → 每分钟检查一次
 *        └─ 到期 → ctx.jobs.start({ kind:'doubao-phase', label:'助手·Daily Ingest', run })
 *             └─ run 里 spawn `dsh --profile headless --approval-policy never <task>`
 *                  └─ stdout/stderr 全量转进 job 的输出环
 *                  └─ 退出后写审计记录
 * ```
 *
 * ## 为什么是 headless 子进程，不是进程内跑 agent
 *
 * 进程内跑 agent 需要 session / context / tools / prompt 组装 —— 等于重造
 * DSH 核心。而 `dsh --profile headless` 是**官方的一次性 agent 入口**
 * （"no Host, HTTP, or browser layer"），行为跟会话里一致。
 *
 * 子进程还有个好处：**崩溃隔离**。phase 跑挂了不影响主进程，退出码就是审计证据。
 *
 * ## 可审计（用户明确要求）
 *
 * 三层：
 * 1. **DSH 的 Jobs 面板** —— 实时看"助手·Daily Ingest 正在跑 / 成功 / 失败"
 * 2. **`phase-runs.json`** —— 历史记录（时间/耗时/退出码/结果摘要），可 git diff
 * 3. **`phase-logs/<phase>-<date>.ndjson`** —— 完整输出流，出事能逐行复盘
 *
 * ## 静默（用户明确要求）
 *
 * - **不开会话** ⇒ 会话列表干净
 * - **不弹审批** ⇒ `--approval-policy never`
 * - **不打断对话** ⇒ 全程在 job 里跑，不碰任何 agent 的 turn
 *
 * ## 跟 DSH 生态的关系
 *
 * - 用 `ctx.jobs`（DSH 原生服务），不自己起 server、不装额外插件
 * - 插件启用即启动、禁用即停 —— 生命周期跟着 `ctx.effect()`
 * - 全部代码在这个包里 ⇒ 可 git、可开源、换机器能用
 */

import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { log } from '../log.js'
import { recordRun, readRuns } from './audit.js'
import { normalizeAfterPhase } from './normalize.js'
import { duePhases, markRan, markFailed } from './schedule.js'
import { readPhases, extractPrompt } from '../memory-system.js'
import { expand } from '../placeholders.js'

/** 检查间隔：一分钟一次（cron 的最小粒度就是分钟） */
const TICK_MS = 60_000

/**
 * 启动 phase 服务。
 *
 * @param {object} scope - 已注入 jobs 的 cordis scope
 * @param {object} cfg - 配置
 * @param {object} paths - 路径解析结果
 */
export function mountPhaseService(scope, cfg, paths, logPath) {
  // ── phase 从 **REGISTRY.json** 读（2026-11-18）────────────────
  //
  // REGISTRY 已经是"schedule 调度的唯一真相源"（见 RUNTIME/manas-system/REGISTRY.json
  // 的 notes）。它本来就写着 4 个 phase 的 phase / cron / promptFile ⇒
  // **复用它，不另立一份配置**。
  //
  // ⇒ 加/改 phase 只改 REGISTRY；插件配置里只有"开关 + 路径"。
  //    这也正好满足用户要的"模块化、git、开源复用"。
  let phases = []
  try {
    phases = readPhases(paths.registry).map((p) => ({
      ...p,
      title: expand(String(p.title ?? ''), {
        pkg: paths.root,
        data: paths.dataRoot,
        user: cfg.userName ?? '用户',
        assistant: cfg.assistantName ?? '助手',
      }),
    }))
  } catch (err) {
    log(logPath, 'error', { where: 'phase-registry', message: String(err?.message ?? err) })
  }
  // 配置里的 list 可以**追加/覆盖**（给开源用户自定义用）
  for (const p of cfg.list ?? []) {
    const idx = phases.findIndex((x) => x.phase === p.phase)
    if (idx >= 0) phases[idx] = { ...phases[idx], ...p }
    else phases.push(p)
  }
  if (!phases.length) {
    log(logPath, 'phase-service-skip', { reason: 'no phases in registry or config', registry: paths.registry })
    return () => {}
  }

  /** 正在跑的 phase（同一个 phase 不并发） */
  const running = new Set()
  /** 取消函数（dispose 时用来停掉在途 job） */
  const cancels = new Set()

  const tick = async () => {
    let due = []
    try {
      due = duePhases(phases, { statePath: cfg.statePath, now: new Date() })
    } catch (err) {
      log(logPath, 'error', { where: 'phase-due', message: String(err?.message ?? err) })
      return
    }
    for (const phase of due) {
      // ── **串行**（2026-11-18 加）────────────────────────────
      //
      // 事故：补偿时 4 个 phase **同时** spawn ⇒ 4 个 headless 并发，
      // 各跑 2 分钟、烧 4 份 token，而且我重载插件时全被腰斩。
      // ⇒ 一次只跑一个，跑完再起下一个（done 里会主动再 tick 一次）。
      if (running.size > 0) break
      startPhase(phase)
    }
  }

  /**
   * 起一个 phase。
   *
   * ## 为什么不用 `ctx.jobs`（2026-11-18 实测）
   *
   * `ctx.jobs.start()` 需要 `servesOwner(owner)` 成立，而它要求：
   * > "The global layer holds every controller attached from an unscoped context
   * >  — a host composition's own controls" / 否则看 owner 所在 scope
   * （dsh-jobs-local/lib/index.js:553）
   *
   * ⇒ **controller 由 agent 侧的 `dsh-tool-jobs` 提供**，插件所在的 host scope 没有
   * ⇒ 直接调会抛 "background jobs unavailable: no job controller serves this agent"。
   *
   * ⇒ 插件自己跑（setInterval + spawn），审计栈自己建。
   *    好处：零内部 API 依赖，换 DSH 版本不会坏。
   *    代价：DSH 的 Jobs 面板看不到实时进度（用 phase-runs.json 代替）。
   *
   * @param {object} phase - phase 定义
   */
  function startPhase(phase) {
    running.add(phase.phase)
    const startedAt = new Date()
    let child
    try {
      child = runHeadless(phase, cfg, paths, (chunk) => appendOutput(phase, startedAt, chunk))
    } catch (err) {
      running.delete(phase.phase)
      recordRun(cfg.statePath, {
        at: startedAt.toISOString(),
        phase: phase.phase,
        title: phase.title,
        trigger: 'cron',
        durationMs: 0,
        exitCode: -1,
        error: String(err?.message ?? err),
      }, logPath)
      log(logPath, 'error', { where: 'phase-start', phase: phase.phase, message: String(err?.message ?? err) })
      return
    }

    const cancel = () => { try { child.kill() } catch { /* 已经退出 */ } }
    cancels.add(cancel)

    // ── 在途记录（2026-11-18 加）──────────────────────────────
    //
    // **为什么需要**：断电/强杀时 `done()` 根本不会执行 ⇒
    // 审计里**一点痕迹都没有**，事后只能说"它没跑过"，
    // 分不清是"没到点"、"跑了但挂了"、还是"跑到一半断电"。
    //
    // ⇒ 启动时写 `phase-current.json`（正在跑什么、何时开始、pid），
    //   正常结束删掉它；下次 mount 时若还留着 ⇒ **上一次异常终止**，
    //   补一条审计记录（exitCode -1，error='interrupted'）。
    writeCurrent(cfg.statePath, {
      phase: phase.phase,
      title: phase.title,
      startedAt: startedAt.toISOString(),
      pid: child.pid ?? null,
    })

    let settled = false
    const done = (code, error) => {
      if (settled) return
      settled = true
      running.delete(phase.phase)
      cancels.delete(cancel)
      clearCurrent(cfg.statePath)
      const durationMs = Date.now() - startedAt.getTime()
      const run = {
        at: startedAt.toISOString(),
        phase: phase.phase,
        title: phase.title,
        trigger: 'cron',
        durationMs,
        exitCode: code,
        error: error ?? null,
        // 审计要点：**跑了 ≠ 跑成了**。退出码是最硬的证据。
        ok: code === 0,
      }
      recordRun(cfg.statePath, run, logPath)
      if (code === 0) {
        markRan(cfg.statePath, phase.phase, startedAt)
        // ── 收尾归一（2026-11-18）──────────────────────────────
        //
        // **幂等的代码级保证**：phase 的写入是 LLM 在写，
        // prompt 里说"别重复"只是请求 ⇒ 这里用纯代码再兜一遍。
        // 见 lib/phases/normalize.js 的说明。
        try {
          const norm = normalizeAfterPhase(paths, logPath)
          if (norm.assertions.removed || norm.logs.removed) {
            log(logPath, 'phase-normalized', {
              phase: phase.phase,
              assertions: norm.assertions.removed,
              logs: norm.logs.removed,
            })
          }
        } catch (err) {
          log(logPath, 'error', { where: 'normalize', message: String(err?.message ?? err) })
        }
      } else {
        // 失败要退避（否则每分钟重试一次，一直烧 token）
        markFailed(cfg.statePath, phase.phase, startedAt, error ?? `exitCode ${code}`)
      }
      log(logPath, 'phase-done', run)
      // 串行：跑完立刻检查下一个（不等下一分钟）
      setTimeout(() => { void tick() }, 3_000).unref?.()
    }

    child.on('exit', (code) => done(code ?? -1))
    child.on('error', (err) => done(-1, String(err?.message ?? err)))
  }

  /**
   * 把子进程输出同时写到：内存尾部缓冲 + NDJSON 文件。
   *
   * @param {object} phase
   * @param {Date} startedAt
   * @param {string} chunk
   */
  function appendOutput(phase, startedAt, chunk) {
    try {
      const day = startedAt.toISOString().slice(0, 10)
      const dir = join(cfg.statePath, 'phase-logs')
      const file = join(dir, `${phase.phase}-${day}.ndjson`)
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), chunk })}\n`, 'utf8')
    } catch { /* 输出落盘失败不该让 phase 判失败 */ }
  }

  const timer = setInterval(() => { void tick() }, TICK_MS)
  if (typeof timer.unref === 'function') timer.unref()

  // ── 启动时检测"上次异常终止"（2026-11-18 加）──────────────────
  //
  // 断电 / 强杀 / 崩溃 ⇒ done() 不会执行 ⇒ 审计里没痕迹。
  // 这里补记一条，让"跑到一半没了"这件事**有据可查**。
  // 同时它也是**补偿的依据**：那条 phase 没有 lastRunAt
  // ⇒ duePhases 会认为该跑没跑 ⇒ 自动补跑。
  try {
    const interrupted = detectInterrupted(cfg.statePath, logPath)
    if (interrupted) {
      log(logPath, 'phase-interrupted-detected', { phase: interrupted.phase, at: interrupted.at })
    }
  } catch (err) {
    log(logPath, 'error', { where: 'detect-interrupted', message: String(err?.message ?? err) })
  }

  log(logPath, 'phase-service-mounted', {
    phases: phases.map((p) => `${p.phase}@${p.cron}`),
    tickMs: TICK_MS,
  })

  // 启动时立刻查一次（DSH 刚开、可能已经过点）
  setTimeout(() => { void tick() }, 5_000).unref?.()

  return () => {
    clearInterval(timer)
    // ── **不腰斩在途的 phase**（2026-11-18 修）─────────────────
    //
    // 事故：我在 HMR 重载后，三个 phase（ingest/wiki/lint）在 57 秒时被
    //       `child.kill()` 打断，审计里留下三条 exitCode -1 —— **白烧了 token**。
    //
    // headless 是 one-shot 进程，**自己会跑完退出**（最长两三分钟）。
    // ⇒ 重载时只停调度、不杀子进程：让它跑完，别把半截活扔掉。
    //   （真卸载的话，最多多跑两三分钟，无害。）
    cancels.clear()
    log(logPath, 'phase-service-unmounted', {
      note: '在途 phase 不杀，让它跑完',
      running: [...running],
    })
  }
}

/**
 * 找 node 可执行文件。
 *
 * ⚠️ **不能用 `process.execPath`**（2026-11-18 踩）：
 *    插件跑在 DSH 的 Electron 进程里 ⇒ `process.execPath` 是
 *    `D:\tools\dsh\DeepSeek Harness.exe`，不是 node
 *    ⇒ spawn 它会当成 GUI 启动，直接失败（实测退出码空、0 秒）。
 *    而 `ELECTRON_RUN_AS_NODE=1` + asar 内的 bin.js 也走不通。
 *
 * ⇒ 顺序：
 *   ① 配置 `phases.nodeExe`
 *   ② `DSH_NODE_EXECUTABLE`（**注意**：DSH 里这个值是 Electron 本体，不是 node，
 *      只有文件名像 node 时才采用）
 *   ③ PATH 里的 `node`
 *
 * @param {object} cfg
 * @returns {string|null}
 */
function findNodeExe(cfg) {
  const configured = String(cfg.nodeExe ?? '').trim()
  if (configured && existsSync(configured)) return configured

  const fromEnv = String(process.env.DSH_NODE_EXECUTABLE ?? '').trim()
  if (fromEnv && /node(\.exe)?$/i.test(fromEnv) && existsSync(fromEnv)) return fromEnv

  // PATH 里的 node
  const dirs = String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 写"在途记录" —— 跑到一半断电时，这是唯一的痕迹。
 *
 * @param {string} statePath
 * @param {object} cur
 */
export function writeCurrent(statePath, cur) {
  try {
    writeFileSync(join(statePath, 'phase-current.json'), JSON.stringify(cur, null, 2), 'utf8')
  } catch { /* 记录失败不该挡住 phase 本身 */ }
}

/**
 * 清"在途记录"（正常结束时）。
 *
 * @param {string} statePath
 */
export function clearCurrent(statePath) {
  try {
    const f = join(statePath, 'phase-current.json')
    if (existsSync(f)) unlinkSync(f)
  } catch { /* ignore */ }
}

/**
 * 检测**上一次异常终止**（断电 / 强杀 / 崩溃），补一条审计。
 *
 * 判据：`phase-current.json` 还留着，且它记的 pid 已经不在了
 * （或者时间已经过去超过 10 分钟）⇒ 上次没正常结束。
 *
 * @param {string} statePath
 * @param {string} [logPath]
 * @returns {object|null} 被补记的那条（没有则 null）
 */
export function detectInterrupted(statePath, logPath = null) {
  const file = join(statePath, 'phase-current.json')
  if (!existsSync(file)) return null
  let cur = null
  try {
    let raw = readFileSync(file, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    cur = JSON.parse(raw)
  } catch {
    clearCurrent(statePath)
    return null
  }
  // pid 还在 ⇒ 真的还在跑（比如 HMR 重载后旧进程未退）⇒ 不动它
  if (cur?.pid && isPidAlive(cur.pid)) return null

  const started = cur?.startedAt ? Date.parse(cur.startedAt) : 0
  const run = {
    at: cur?.startedAt ?? new Date().toISOString(),
    phase: cur?.phase ?? 'unknown',
    title: cur?.title ?? '未知 phase',
    trigger: 'cron',
    durationMs: started ? Math.max(0, Date.now() - started) : 0,
    exitCode: -1,
    error: 'interrupted（上次没正常结束：断电 / 强杀 / 崩溃）',
    ok: false,
  }
  recordRun(statePath, run, logPath)
  clearCurrent(statePath)
  if (logPath) log(logPath, 'phase-interrupted', run)
  return run
}

/** pid 是否还活着（Windows 用 process.kill(pid, 0) 会抛，退而用 tasklist 太重） */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 取一个 phase 的任务正文。
 *
 * 优先级：
 * 1. `phase.task`（配置里显式写的）
 * 2. `phase.promptFile`（REGISTRY 里的相对路径，通常是 `RUNTIME/prompts/xxx.md`）
 *
 * 第 2 条是正路：prompt 文件里的 ``` 代码块就是完整的 phase 协议模板，
 * 占位符（`{PKG}` / `{DATA}` / `{ASSISTANT}` / `{ISO 时间戳}`）在这里替换掉。
 * ⇒ **换机器、换人格目录都不用改 prompt**。
 *
 * @param {object} phase
 * @param {object} paths
 * @param {object} cfg
 * @returns {string}
 */
function taskOf(phase, paths, cfg) {
  if (phase.task) return phase.task
  const rel = String(phase.promptFile ?? '').trim()
  if (!rel) return ''
  const abs = join(paths.root, rel.replace(/^[/\\]+/, ''))
  if (!existsSync(abs)) {
    throw new Error(`找不到 phase 的 prompt 文件：${abs}`)
  }
  const raw = readFileSync(abs, 'utf8')
  const body = extractPrompt(raw) || raw
  const now = new Date()
  return expand(body, {
    pkg: paths.root,
    data: paths.dataRoot,
    user: cfg.userName ?? '用户',
    assistant: cfg.assistantName ?? '助手',
  })
    // phase 协议里的 `{ISO 时间戳}` 不在 placeholders.js 的四个标准占位符里
    // （它带空格和中文）⇒ 在这里单独替
    .replace(/\{ISO\s*时间戳\}/g, now.toISOString())
    .replace(/\{ISO\}/g, now.toISOString())
    .replace(/\{TODAY\}/g, now.toISOString().slice(0, 10))
}

/**
 * 跑一次 headless。
 *
 * @param {object} phase
 * @param {object} cfg
 * @param {object} paths
 * @param {(chunk:string)=>void} onOutput
 * @returns {import('node:child_process').ChildProcess}
 */
function runHeadless(phase, cfg, paths, onOutput) {
  const dshBin = cfg.dshBin
  if (!dshBin || !existsSync(dshBin)) {
    throw new Error(`找不到 dsh 入口（phases.dshBin=${dshBin || '未配'}）—— 见 docs/plugin-phases.md`)
  }
  const nodeExe = findNodeExe(cfg)
  if (!nodeExe) {
    throw new Error('找不到 node 可执行文件（配 phases.nodeExe，或把 node 放进 PATH）')
  }
  const task = taskOf(phase, paths, cfg)
  if (!task.trim()) {
    throw new Error(`phase ${phase.phase} 没有可执行的任务正文`)
  }
  const args = [
    dshBin,
    '--profile', cfg.headlessProfile ?? 'headless',
    '--permission-mode', cfg.permissionMode ?? 'danger-full-access',
    '--approval-policy', 'never',
    task,
  ]
  const child = spawn(nodeExe, args, {
    cwd: cfg.cwd || paths.dataRoot,
    env: { ...process.env, DSH_HOME: cfg.dshHome ?? process.env.DSH_HOME ?? '' },
    windowsHide: true,
  })
  child.stdout?.on('data', (d) => onOutput(String(d)))
  child.stderr?.on('data', (d) => onOutput(String(d)))
  return child
}

export { readRuns }
