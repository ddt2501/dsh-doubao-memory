/**
 * 记忆动力学（遗忘 / 强化 / 老化）—— 纯函数模块，无 IO。
 *
 * 从 store.js 抽离，作为独立的"记忆强度模型"层。与存储解耦后：
 *   - 可单测、可替换（未来换遗忘曲线只动这里）；
 *   - 召回/老化/强化共用同一套强度语义，不散落各处。
 *
 * ## Design A（避免复合衰减）
 *   importance 是基底强度，只由强化改变，不随时间改写；
 *   衰减体现在召回时计算的 R = importance × exp(-Δdays / stability)。
 *   周期老化只推进 forget_stage/status + 折半 recall_count。
 *
 * ## 两条铁律
 *   1. 遗忘 = 召回失败，不是擦除（记录与出处永不物理删除）。
 *   2. pinned=1 或 importance≥0.9 免衰减免归档。
 */

export const TYPE_STABILITY = {
  fact: 365,        // ID/配置：身份级，默认 pinned
  preference: 90,   // 对齐 02-USER
  relation: 60,     // 对齐 03-RELATIONSHIP
  episode: 30,      // 对齐 04/05
  correction: 180,  // 纠正长期有效
}
export const DEFAULT_STABILITY = 60
export const STABILITY_CAP = 730      // 强化后半衰期上限（天）
export const IMPORTANCE_FLOOR = 0.05  // 衰减地板（lint 同款）
export const ACTIVE_R_THRESHOLD = 0.3 // R 低于此 → dormant 候选
export const PROTECT_IMPORTANCE = 0.9 // importance≥此 → 免删保护

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const round3 = (x) => Math.round(x * 1000) / 1000
const DAY_MS = 86_400_000

/** 置信度 → 初始 importance（低置信 → 低重要度 → 衰减快）。 */
export function initialImportance(confidence = 0.8) {
  return round3(0.2 + 0.6 * clamp(Number(confidence) || 0, 0, 1))
}

/** 自最近命中（缺失则自创建）起的天数 */
export function daysSince(mem, now = Date.now()) {
  const anchor = mem?.last_recalled || mem?.created_at
  const t = anchor ? Date.parse(anchor) : now
  if (!Number.isFinite(t)) return 0
  return Math.max(0, (now - t) / DAY_MS)
}

/** 可召回度 R = importance × exp(-Δdays / stability)。这就是遗忘曲线。 */
export function retrievability(mem, now = Date.now()) {
  const importance = Number(mem?.importance ?? 0.5)
  const stability = Number(mem?.stability || DEFAULT_STABILITY)
  return importance * Math.exp(-daysSince(mem, now) / stability)
}

/** 访问强化：抬 importance/stability，重置衰减时钟。返回需写回的字段。 */
export function reinforce(mem, now = Date.now()) {
  return {
    importance: round3(clamp(Number(mem.importance ?? 0.5) + 0.1, 0, 1)),
    stability: round3(clamp(Number(mem.stability || DEFAULT_STABILITY) * 1.5, 1, STABILITY_CAP)),
    recall_count: (mem.recall_count || 0) + 1,
    last_recalled: new Date(now).toISOString(),
  }
}

/** 周期老化（lint §9-10 同款）：折半 recall_count + 推进 status/forget_stage。importance 基底不动。 */
export function ageMemory(mem, now = Date.now()) {
  const recall_count = Math.floor((mem.recall_count || 0) * 0.5)
  const protect = mem.pinned === 1 || Number(mem.importance) >= PROTECT_IMPORTANCE
  const R = retrievability(mem, now)
  if (protect || R >= ACTIVE_R_THRESHOLD) {
    return { status: 'active', forget_stage: 0, forget_since: null, recall_count }
  }
  const stage = mem.forget_stage || 0
  const since = mem.forget_since ? Date.parse(mem.forget_since) : null
  const elapsed = Number.isFinite(since) ? (now - since) / DAY_MS : 0
  if (stage === 0) {
    return { status: 'dormant', forget_stage: 1, forget_since: new Date(now).toISOString(), recall_count }
  }
  if (stage === 1 && elapsed >= 7) {
    return { status: 'dormant', forget_stage: 2, forget_since: mem.forget_since, recall_count }
  }
  if (stage === 2 && elapsed >= 14) {
    return { status: 'archived', forget_stage: 3, forget_since: mem.forget_since, recall_count }
  }
  return { status: 'dormant', forget_stage: stage, forget_since: mem.forget_since ?? null, recall_count }
}