/**
 * Phase 调度 —— 极简 cron 判定（5 字段：分 时 日 月 周）。
 *
 * ## 为什么自己写而不是引依赖
 *
 * 只要 `0 4 * * *`、`0 22 * * 0` 这种形状 ⇒ 一百行足够。
 * 引 cron 包要给插件再加一个 vendor 依赖（见 package.json 的 zod 那笔账），
 * 而调度逻辑本身简单到不值得。
 *
 * ## 判定规则
 *
 * 1. cron 匹配当前分钟
 * 2. **今天还没跑过**这个 phase（`lastRunAt` 不是今天）
 * 3. 不在跑（由 service 的 running 集合管）
 *
 * ⇒ 关键：**按"天"去重**，所以一分钟一次的检查不会重复触发。
 *    （DSH 的 schedule 靠内部状态，我们靠 phase-state.json 的 lastRunAt）
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { log } from '../log.js'

/** phase 运行状态（lastRunAt 等） */
const STATE_FILE = 'phase-state.json'

/**
 * 解析某个字段 —— 支持 `*`、数字、逗号列表、范围和步进。
 *
 * @param {string} field
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {boolean}
 */
function fieldMatches(field, value, min, max) {
  const f = String(field ?? '*').trim()
  if (f === '*' || f === '?') return true
  for (const part of f.split(',')) {
    const seg = part.trim()
    if (!seg) continue
    // 步进：*/5 或 1-30/2
    const [rangePart, stepPart] = seg.split('/')
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isFinite(step) || step <= 0) continue
    let lo
    let hi
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number)
      lo = a
      hi = b
    } else {
      lo = Number(rangePart)
      hi = lo
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true
  }
  return false
}

/**
 * cron 是否匹配这一刻（**只看到分钟**）。
 *
 * @param {string} cron - "0 4 * * *"
 * @param {Date} now
 * @returns {boolean}
 */
export function cronMatches(cron, now) {
  const parts = String(cron ?? '').trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, dom, mon, dow] = parts
  if (!fieldMatches(min, now.getMinutes(), 0, 59)) return false
  if (!fieldMatches(hour, now.getHours(), 0, 23)) return false
  if (!fieldMatches(mon, now.getMonth() + 1, 1, 12)) return false
  // 日 / 周：两个都限定时是"或"（标准 cron 语义），这是最容易写错的地方
  const domRestricted = dom !== '*' && dom !== '?'
  const dowRestricted = dow !== '*' && dow !== '?'
  const domOk = fieldMatches(dom, now.getDate(), 1, 31)
  const dowOk = fieldMatches(dow, now.getDay(), 0, 6)
  if (domRestricted && dowRestricted) {
    if (!domOk && !dowOk) return false
  } else if (domRestricted) {
    if (!domOk) return false
  } else if (dowRestricted) {
    if (!dowOk) return false
  }
  return true
}

/** 本地日期（YYYY-MM-DD）—— 不能用 toISOString，那是 UTC */
function localDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 读 phase 运行状态。
 *
 * @param {string} stateDir
 * @returns {{phases: object}}
 */
export function readPhaseState(stateDir) {
  const file = joinSafe(stateDir, STATE_FILE)
  try {
    if (!existsSync(file)) return { phases: {} }
    let raw = readFileSync(file, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)     // BOM 会让 JSON.parse 抛
    const parsed = JSON.parse(raw)
    return { phases: parsed?.phases ?? {} }
  } catch {
    return { phases: {} }
  }
}

/** 写 phase 运行状态（原子写） */
function writePhaseState(stateDir, state) {
  const file = joinSafe(stateDir, STATE_FILE)
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch { /* 状态写不成不该让 phase 跑挂 */ }
}

/**
 * 把一个 cron 字段展开成具体数值数组（用于精确列举触发时刻）。
 *
 * 比 `fieldMatches` 多一步"枚举"：判定只问"这个值在不在集合里"，
 * 反推触发时刻需要知道"集合里有哪些值"。
 *
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {number[]} 升序
 */
function enumerateField(field, min, max) {
  const f = String(field ?? '*').trim()
  const set = new Set()
  if (f === '*' || f === '?') {
    for (let v = min; v <= max; v++) set.add(v)
    return [...set].sort((a, b) => a - b)
  }
  for (const part of f.split(',')) {
    const seg = part.trim()
    if (!seg) continue
    const [rangePart, stepPart] = seg.split('/')
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isFinite(step) || step <= 0) continue
    let lo
    let hi
    if (rangePart === '*') { lo = min; hi = max }
    else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number)
      lo = a; hi = b
    } else { lo = Number(rangePart); hi = lo }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) set.add(v)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * 反推**最近一次应该触发的时刻**（≤ now）。
 *
 * ## 为什么必须有这个（2026-11-18 修）
 *
 * 第一版 `duePhases` 用的是"当前分钟精确匹配"：
 * ```js
 * if (!cronMatches(p.cron, now)) continue
 * ```
 * ⇒ **错过就永远错过**：4:00 那一刻 DSH 没开（或电脑睡眠），
 *    4:01 打开后 `cronMatches('0 4 * * *', 4:01)` 是 false ⇒ 永远不跑。
 *
 * DSH 的 `schedule` 服务有补偿语义（"After downtime, only the latest
 * missed occurrence is delivered"），我照搬"精确匹配"时漏了这一层。
 *
 * ⇒ 改成"该跑但没跑"：先算出**最近一次应触发时刻**，
 *    跟 `lastRunAt` 比 ⇒ 错过也补，且只补**最近一次**（不补一堆）。
 *
 * ## 回溯上限
 *
 * 32 天（覆盖 `0 4 1 * *` 这种月度 cron）。
 * 每一天先用**日期字段**粗筛（月/日/周），不匹配就整天跳过 ⇒ 几乎不耗时间。
 *
 * @param {string} cron
 * @param {Date} now
 * @param {number} [maxDays]
 * @returns {Date|null}
 */
export function lastDueAt(cron, now, maxDays = 32) {
  const parts = String(cron ?? '').trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minF, hourF, domF, monF, dowF] = parts
  const hours = enumerateField(hourF, 0, 23)
  const mins = enumerateField(minF, 0, 59)
  if (!hours.length || !mins.length) return null

  const domRestricted = domF !== '*' && domF !== '?'
  const dowRestricted = dowF !== '*' && dowF !== '?'
  const doms = enumerateField(domF, 1, 31)
  const mons = enumerateField(monF, 1, 12)
  const dows = enumerateField(dowF, 0, 6)

  for (let d = 0; d <= maxDays; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d)
    // 月份粗筛（最便宜，先做）
    if (!mons.includes(day.getMonth() + 1)) continue
    // 日 / 周：同时限定时取"或"（Vixie 语义）
    const domOk = doms.includes(day.getDate())
    const dowOk = dows.includes(day.getDay())
    let dayOk
    if (domRestricted && dowRestricted) dayOk = domOk || dowOk
    else if (domRestricted) dayOk = domOk
    else if (dowRestricted) dayOk = dowOk
    else dayOk = true
    if (!dayOk) continue

    // 这一天的候选时刻（从晚到早，找第一个 ≤ now）
    for (let hi = hours.length - 1; hi >= 0; hi--) {
      for (let mi = mins.length - 1; mi >= 0; mi--) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours[hi], mins[mi], 0, 0)
        if (t.getTime() <= now.getTime()) return t
      }
    }
  }
  return null
}

/**
 * 这一刻该跑哪些 phase —— **按"该跑但没跑"判定，不是"精确匹配当前分钟"**。
 *
 * @param {object[]} phases
 * @param {object} opts
 * @param {string} opts.statePath - RUNTIME/state 目录
 * @param {Date} opts.now
 * @returns {object[]}
 */
export function duePhases(phases, { statePath, now = new Date() }) {
  const state = readPhaseState(statePath)
  const out = []
  for (const p of phases) {
    if (!p?.phase || p.enabled === false) continue
    const due = lastDueAt(p.cron, now)
    if (!due) continue
    const st = state.phases[p.phase] ?? {}
    const last = st.lastRunAt
    // 最近一次应触发时刻**已经跑过** ⇒ 不重复
    if (last && new Date(last).getTime() >= due.getTime()) continue

    // ── 失败退避（2026-11-18 加）──────────────────────────────
    //
    // 事故：三个 phase 被腰斩（exitCode -1）后**每分钟重试一次**，
    // 每次跑 57 秒 ⇒ 一直烧 token。
    // ⇒ 连续失败时指数退避：1 → 2 → 4 → 8 → … 封顶 60 分钟。
    //   成功一次就清零。
    if (st.failCount > 0 && st.lastAttemptAt) {
      const backoffMs = Math.min(60, 2 ** Math.min(st.failCount, 6)) * 60_000
      const since = now.getTime() - new Date(st.lastAttemptAt).getTime()
      if (since < backoffMs) continue
    }
    out.push({ ...p, dueAt: due.toISOString() })
  }
  return out
}

/**
 * 记一次**失败**尝试（触发退避）。
 *
 * @param {string} statePath
 * @param {string} phase
 * @param {Date} at
 * @param {string} [error]
 */
export function markFailed(statePath, phase, at = new Date(), error = null) {
  const state = readPhaseState(statePath)
  const prev = state.phases[phase] ?? {}
  state.phases[phase] = {
    ...prev,
    lastAttemptAt: at.toISOString(),
    failCount: (prev.failCount ?? 0) + 1,
    lastError: error ?? null,
  }
  writePhaseState(statePath, state)
}

/**
 * 记一次成功运行（清掉失败计数）。
 *
 * @param {string} statePath
 * @param {string} phase
 * @param {Date} at
 */
export function markRan(statePath, phase, at = new Date()) {
  const state = readPhaseState(statePath)
  state.phases[phase] = {
    ...(state.phases[phase] ?? {}),
    lastRunAt: at.toISOString(),
    lastAttemptAt: at.toISOString(),
    failCount: 0,
    lastError: null,
  }
  writePhaseState(statePath, state)
}

/** join 的安全包装（避免 Windows 路径拼接踩坑） */
function joinSafe(dir, name) {
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}\\${name}`
}
