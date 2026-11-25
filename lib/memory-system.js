/**
 * 人格记忆系统（LLM Wiki 四相 + manas）——**安装即接线**。
 *
 * 这个模块让"人格记忆系统"成为一个**可复用插件**的关键：
 * 装上插件 = 四个 phase（ingest / wiki / lint / reflect）自动注册，
 * 不再需要用户手动跑 `schedule_create`。
 *
 * 真相源：`RUNTIME/manas-system/REGISTRY.json` 的 `phases[]`
 *   - cron / time_zone / title / promptFile 都在那儿
 *   - prompt 取 promptFile 里**第一个代码块**（那才是真正发给 LLM 的指令）
 *
 * 幂等：按 title 查已有任务 → 有就跳过（不重复注册）。
 *       所以插件反复重载 / DSH 重启都不会产生重复 phase。
 *
 * 路径可移植：prompt 里写死的绝对路径（包根）会被替换成实际 dataRoot。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { log } from './log.js'
import { expand } from './placeholders.js'

/**
 * phase 任务与人格目录的绑定记录。
 *
 * ## 为什么需要它
 *
 * 四个 phase 的 prompt 在**创建时**就把 `{DATA}` 展开成了当时的 dataRoot，
 * 之后查重只按 title 命中 ⇒ 换个 dataRoot 再挂载，会看到"已注册"而全部跳过。
 * 结果：**选了别的人格，四个 phase 还在往旧人格的 vault 里写**。
 *
 * 所以记下注册时的 dataRoot：一旦对不上，就删掉旧任务按新路径重建。
 */
export const BINDING_FILE = '.doubao-phase-binding.json'

function bindingPath(paths) {
  const root = dirname(paths.dataRoot)
  return join(root, BINDING_FILE)
}

function readBinding(paths) {
  try {
    const p = bindingPath(paths)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function writeBinding(paths, data) {
  try {
    const p = bindingPath(paths)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2), 'utf8')
  } catch { /* ignore */ }
}

/** 取 markdown 里第一个 ``` 围栏块的内容 */
export function extractPrompt(markdown) {
  if (!markdown) return ''
  const m = markdown.match(/```[a-zA-Z]*\r?\n([\s\S]*?)```/)
  return (m ? m[1] : markdown).trim()
}

export { expand, expand as rewritePaths }   // re-export 只是别名，本地要用 expand

/**
 * 卸载收尾：插件被真卸载/停用后，把它注册的四个 phase 一起带走。
 *
 * ## 为什么不是"dispose 时立刻删"
 *
 * cordis 的 fiber dispose 分不清三种情况：
 *   1. **插件重载**（改配置、HMR）——几秒后会重新 apply，任务必须留着
 *   2. **插件卸载 / 停用**——任务该删，否则会一直空跑
 *   3. **DSH 进程退出**——任务该留（下次启动复用，且不丢"错过补送"语义）
 *
 * 所以 dispose 时只**装一个 30 秒的定时器**：
 *   - 30 秒内插件重新 apply ⇒ `disarmPhaseCleanup()` 取消 ⇒ 任务原样保留（情况 1）
 *   - 30 秒到点 ⇒ 按 binding 文件里的 titles 删任务（情况 2）
 *   - 进程退出 ⇒ 定时器随进程消失 ⇒ 任务保留（情况 3）
 *
 * 只删 binding 里记录的那个四个人格任务标题——用户自己建的 schedule 一律不碰。
 */
export const CLEANUP_DELAY_MS = 30_000

/** 当前待执行的卸载清理（同进程内只有一个插件实例） */
let pendingCleanup = null

/** 插件重新挂载时调用：取消待执行的卸载清理。返回是否真的取消了一个。 */
export function disarmPhaseCleanup(logPath) {
  if (!pendingCleanup) return false
  clearTimeout(pendingCleanup.timer)
  pendingCleanup = null
  log(logPath, 'cleanup-cancelled', { reason: 'remounted' })
  return true
}

/**
 * dispose 时调用：延迟 `delayMs` 后删除四个 phase 任务。
 *
 * @param {object|null} schedule - **在 fiber 还活着时取到的** schedule 服务引用
 *   （dispose 之后再访问 scope.schedule 会抛 INACTIVE_EFFECT，所以提前拿）
 */
export function armPhaseCleanup(schedule, paths, logPath, delayMs = CLEANUP_DELAY_MS) {
  disarmPhaseCleanup(logPath)
  if (!schedule) {
    log(logPath, 'cleanup-skip', { reason: 'no schedule service captured' })
    return
  }
  if (!paths?.dataRoot) return
  const timer = setTimeout(() => {
    pendingCleanup = null
    Promise.resolve()
      .then(() => cleanupPhaseTasks(schedule, paths, logPath))
      .catch((err) => log(logPath, 'error', { where: 'cleanup-phases', message: String(err?.message ?? err) }))
  }, delayMs)
  // 不阻止 DSH 进程退出（退出时任务保留）
  timer.unref?.()
  pendingCleanup = { timer, schedule, paths, logPath }
  log(logPath, 'cleanup-armed', { delayMs, dataRoot: paths.dataRoot })
}

/**
 * 删除 binding 里记录的 phase 任务（只认 title，不碰别人的任务）。
 *
 * @returns {Promise<{deleted:number, titles?:string[]}>}
 */
export async function cleanupPhaseTasks(schedule, paths, logPath) {
  const binding = readBinding(paths)
  const titles = Array.isArray(binding?.titles) ? binding.titles.filter(Boolean) : []
  if (!titles.length) {
    log(logPath, 'cleanup-skip', { reason: 'no binding titles' })
    return { deleted: 0 }
  }

  let listed
  try {
    listed = await schedule.list({ limit: 200 })
  } catch (err) {
    // 服务已随宿主卸载（比如 DSH 正在关闭）⇒ 什么都不做，任务留到下次启动
    log(logPath, 'cleanup-skip', { reason: 'schedule.list failed', message: String(err?.message ?? err) })
    return { deleted: 0 }
  }

  let deleted = 0
  for (const t of listed?.items ?? []) {
    const title = t?.title ?? t?.record?.title ?? ''
    if (!titles.includes(title)) continue
    const id = t?.id ?? t?.record?.id
    if (!id) continue
    try {
      await schedule.edit({ id, action: 'delete' })
      deleted += 1
      log(logPath, 'cleanup-deleted', { id, title })
    } catch (err) {
      log(logPath, 'error', { where: 'cleanup-delete', id, title, message: String(err?.message ?? err) })
    }
  }
  log(logPath, 'cleanup-done', { deleted, titles })
  return { deleted, titles }
}

/** 读 REGISTRY.json 的 phases */
export function readPhases(registryPath) {
  if (!existsSync(registryPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8'))
    return Array.isArray(parsed.phases) ? parsed.phases : []
  } catch {
    return []
  }
}

/**
 * 注册四相 schedule（幂等）。
 *
 * ## 目标（target）怎么定 —— 空白安装 + **成本**的关键
 *
 * 插件在 **boot 早期**挂载，那时 Host 可能还没有 sessionController
 * （`dsh-schedule` 的 `new_once` / `new` 目标要求 `ctx.get('sessionController')` 存在，
 * 否则报 "This Host cannot create Sessions"）。
 *
 * 所以用 `cfg.targetMode` 选，并**逐级降级**：
 *   1. `new`（默认）—— **每次触发都开全新 session**
 *   2. `new_once` —— 第一次建，之后复用同一个
 *   3. `session` —— 绑到活着的顶层会话（老行为）
 *   4. 都不行 ⇒ **等**：监听 `agent/created`，等第一个会话出现再补注册
 *
 * ## 为什么默认是 `new`（2026-11-11 实测改）
 *
 * phase 绑主对话 session 时，每天凌晨 04:00 触发 ⇒ 距离上次对话必然隔夜 ⇒
 * **prompt cache 全过期** ⇒ 把主对话的整个 history 按全价重发一次：
 *
 *   | 日期 | phase 第一次调用 input | cacheRead |
 *   |---|---|---|
 *   | 10-13 04:00 | 431,165 | 156 |
 *   | 10-18 04:00 | 466,360 | 133 |
 *   | 11-08 04:00 | 711,161 | 512 |
 *
 * 13 次这样的 cache-miss 调用 = phase input 的 **63%**，而且随主对话变长越来越贵。
 * 改成 `new` 后每次 phase 的 history 从 0 开始，input 只剩 system prompt + 工具 + reminder。
 *
 * @param {object} scope - 已注入 schedule（+ agents）服务的 cordis scope
 * @param {object} cfg - memory 子配置
 * @param {object} paths - 路径解析结果
 */
/** 默认目标模式：每次触发都开全新 session（隔离 → 不再背主对话 history） */
export const DEFAULT_TARGET_MODE = 'new'

export async function mount(scope, cfg = {}, paths = {}) {
  const registryPath = cfg.registryPath ?? paths.registry
  const logPath = cfg.logPath ?? paths.memorySystemLog
  const targetCwd = cfg.targetCwd ?? process.cwd()
  const targetMode = cfg.targetMode ?? DEFAULT_TARGET_MODE

  const phases = readPhases(registryPath)
  if (!phases.length) {
    log(logPath, 'error', { where: 'read-registry', reason: 'no phases found', registryPath })
    return
  }

  // 已有任务（按 title 查）
  // ⚠️ `schedule.list()` 返回的是 **`items`**（`dsh-schedule/lib/index.js:2276`
  //    → `{ items, shown, total, limit, offset }`），不是 entries/tasks。
  //    写错字段名 ⇒ existing 永远是空数组 ⇒ **每次插件重载都多注册 4 个 phase**。
  let existing = []
  try {
    const listed = await scope.schedule.list({ limit: 200 })
    existing = listed?.items ?? []
  } catch (err) {
    log(logPath, 'error', { where: 'list', message: String(err?.message ?? err) })
    return
  }
  // 称呼：顶层归一后带下来；直接调用本模块时也有兜底
  const names = { userName: cfg.userName ?? '用户', assistantName: cfg.assistantName ?? '助手' }
  const titles = new Set(existing.map((t) => t?.title ?? t?.record?.title))

  // ── 自愈：清掉「标题带占位符」的残留任务 ──────────────────────
  // 背景：早期版本的标题没走占位符替换，于是装出过
  // 「{ASSISTANT}·Daily Ingest」这种任务——它们既不会被查重命中，
  // 又会真的触发（投递一份带占位符的 prompt）。这里主动删掉。
  for (const t of existing) {
    const title = t?.title ?? t?.record?.title ?? ''
    if (!/^\{[A-Z_]+\}·/.test(title)) continue
    const id = t?.id ?? t?.record?.id
    if (!id) continue
    try {
      await scope.schedule.edit({ id, action: 'delete' })
      log(logPath, 'cleanup', { id, title, reason: 'placeholder title' })
    } catch (err) {
      log(logPath, 'error', { where: 'cleanup', id, title, message: String(err?.message ?? err) })
    }
  }

  const stat = { created: 0, skipped: 0, deferred: 0, migrated: 0, rebound: 0 }

  // ── 换人格：旧任务的 prompt 里烧着旧 dataRoot ⇒ 必须重建 ────────
  // 判断依据是绑定文件里记的 dataRoot（见 BINDING_FILE 注释）。
  // 只删**我们自己注册的那四个 title**，绝不碰用户自己的任务。
  const binding = readBinding(paths)
  const phaseTitles = new Set(
    phases
      .filter((p) => p?.enabled)
      .map((p) => expand(String(p.title ?? ''), {
        pkg: paths.root, data: paths.dataRoot, user: names.userName, assistant: names.assistantName,
      }))
      .filter(Boolean),
  )
  const personChanged = binding?.dataRoot && binding.dataRoot !== paths.dataRoot
  if (personChanged) {
    log(logPath, 'persona-rebind', { from: binding.dataRoot, to: paths.dataRoot })
    for (const t of existing) {
      const title = t?.title ?? t?.record?.title ?? ''
      if (!phaseTitles.has(title)) continue
      const id = t?.id ?? t?.record?.id
      if (!id) continue
      try {
        await scope.schedule.edit({ id, action: 'delete' })
        titles.delete(title)
        stat.rebound += 1
        log(logPath, 'persona-rebind-deleted', { title, id })
      } catch (err) {
        log(logPath, 'error', { where: 'persona-rebind', title, id, message: String(err?.message ?? err) })
      }
    }
  }

  // ── 迁移：把「绑主对话」的老 task 重建成隔离目标 ────────────
  // 2026-11-11 实测：phase 绑主对话 ⇒ 每天凌晨 cache miss 时把主对话
  // 的整个 history（43~71 万 tok）按全价重发一次，占 phase input 的 63%。
  // 这里把老的 `target.kind === 'session'` 删掉，让下面的循环用新目标重建。
  if (targetMode !== 'session') {
    for (const t of existing) {
      const title = t?.title ?? t?.record?.title ?? ''
      if (!titles.has(title)) continue
      if (t?.target?.kind !== 'session') continue
      const id = t?.id ?? t?.record?.id
      if (!id) continue
      try {
        await scope.schedule.edit({ id, action: 'delete' })
        titles.delete(title)
        stat.migrated += 1
        log(logPath, 'migrate-target', { title, id, from: 'session', to: targetMode })
      } catch (err) {
        log(logPath, 'error', { where: 'migrate-target', title, id, message: String(err?.message ?? err) })
      }
    }
  }

  for (const phase of phases) {
    if (!phase?.enabled) continue
    // 标题里也有人名占位符（{ASSISTANT}·Daily Ingest）→ 同样要替换，
    // 否则装出来的任务名会带着占位符，查重也对不上。
    const title = expand(String(phase.title ?? ''), { pkg: paths.root, data: paths.dataRoot, user: names.userName, assistant: names.assistantName })
    if (!title) continue
    if (titles.has(title)) {
      stat.skipped += 1
      log(logPath, 'skip', { phase: phase.phase, title, reason: 'already registered' })
      continue
    }

    // prompt 文件在**包**里（协议是机制），路径按包根解析
    const promptFile = phase.promptFile
      ? String(phase.promptFile).replace(/\\/g, '/')
      : ''
    const absPrompt = promptFile.startsWith('/') || /^[A-Za-z]:/.test(promptFile)
      ? promptFile
      : join(paths.root, promptFile.replace(/^.*RUNTIME\//, 'RUNTIME/'))
    let prompt = ''
    try {
      prompt = extractPrompt(readFileSync(absPrompt, 'utf8'))
    } catch (err) {
      log(logPath, 'error', { where: 'read-prompt', phase: phase.phase, message: String(err?.message ?? err) })
      continue
    }
    // 占位符 → 真实值（{PKG}=包根，{DATA}=人格实例目录，{USER}/{ASSISTANT}=称呼）
    prompt = expand(prompt, {
      pkg: paths.root,
      data: paths.dataRoot,
      user: names.userName,
      assistant: names.assistantName,
    })
    if (!prompt) {
      log(logPath, 'error', { where: 'empty-prompt', phase: phase.phase })
      continue
    }

    try {
      const target = resolveTarget(scope, targetCwd, targetMode)
      if (!target) {
        log(logPath, 'deferred', { phase: phase.phase, title, reason: 'no session target available yet' })
        continue
      }
      const created = await createWithFallback(
        scope,
        {
          title,
          prompt,
          timing: { kind: 'cron', cron: { expression: phase.cron, time_zone: phase.time_zone ?? 'Asia/Shanghai' } },
        },
        target,
        targetCwd,
        logPath,
        phase.phase,
      )
      log(logPath, 'created', { phase: phase.phase, title, cron: phase.cron, id: created?.id, target: target.kind })
      stat.created += 1
    } catch (err) {
      const msg = String(err?.message ?? err)
      // Host 还没法建会话（boot 早期）⇒ 不是错误，是"等第一个会话出现再补"
      if (/cannot create Sessions/i.test(msg)) {
        stat.deferred += 1
        log(logPath, 'deferred', { phase: phase.phase, title, reason: msg })
      } else {
        log(logPath, 'error', { where: 'create', phase: phase.phase, message: msg })
      }
    }
  }

  // 记下这次注册绑定的是哪个人格目录，供下次判断"是不是换人了"
  try {
    writeBinding(paths, { dataRoot: paths.dataRoot, titles: [...phaseTitles], mode: targetMode })
  } catch { /* ignore */ }

  return { ...stat, mode: targetMode }
}

/**
 * 建 task，Host 不支持建 session 时**逐级降级**：
 *   new → new_once → session（现有顶层会话）→ 抛错（调用方记 deferred）
 */
async function createWithFallback(scope, base, target, targetCwd, logPath, phaseName) {
  try {
    return await scope.schedule.create({ ...base, target })
  } catch (err) {
    const msg = String(err?.message ?? err)
    if (!/cannot create Sessions/i.test(msg)) throw err
    if (target.kind === 'new') {
      log(logPath, 'degraded', { phase: phaseName, from: 'new', to: 'new_once', reason: msg })
      return createWithFallback(scope, base, { kind: 'new_once', create: { cwd: targetCwd } }, targetCwd, logPath, phaseName)
    }
    if (target.kind === 'new_once') {
      const roots = scope.agents?.roots?.() ?? []
      if (roots.length && roots[0]?.id) {
        log(logPath, 'degraded', { phase: phaseName, from: 'new_once', to: 'session', reason: msg })
        return scope.schedule.create({ ...base, target: { kind: 'session', sessionId: roots[0].id } })
      }
    }
    throw err
  }
}

/**
 * 决定 phase 投递到哪儿（按 `targetMode`）：
 *   - `new`（默认）：每次触发开全新 session —— phase 的 history 从 0 开始，
 *     不再背主对话的几十万 tok history（这是 phase 成本的大头，见 mount 的注释）
 *   - `new_once`：第一次建，之后复用同一个
 *   - `session`：绑现有顶层会话（老行为，主对话会被 phase 污染且越来越贵）
 *   - 都不可用 ⇒ 返回 null / 由 createWithFallback 降级
 */
export function resolveTarget(scope, targetCwd, mode = DEFAULT_TARGET_MODE) {
  if (mode === 'session') {
    try {
      const roots = scope.agents?.roots?.() ?? []
      if (roots.length && roots[0]?.id) {
        return { kind: 'session', sessionId: roots[0].id }
      }
    } catch { /* ignore */ }
    return { kind: 'new_once', create: { cwd: targetCwd } }
  }
  if (mode === 'new_once') return { kind: 'new_once', create: { cwd: targetCwd } }
  return { kind: 'new', create: { cwd: targetCwd } }
}
