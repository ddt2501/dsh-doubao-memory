/**
 * 状态签名 —— 把"此刻是什么局面"压成一个短字符串。
 *
 * JitRL 的优势估计依赖"相似状态"检索。状态越细，样本越稀；越粗，越容易串味。
 * 这里用五个离散桶，粒度对齐主动搭讪真正会变化的因素（时段 / 劲头 / 沉默多久 /
 * 上一轮他理没理我 / 当前轴）。
 *
 * 例：`evening|mid|2-6h|replied|relation`
 */

const SLOTS = [
  [7, 9, 'morning'],
  [9, 12, 'forenoon'],
  [12, 14, 'noon'],
  [14, 18, 'afternoon'],
  [18, 23, 'evening'],
]

export function slotOf(hour) {
  for (const [lo, hi, name] of SLOTS) {
    if (hour >= lo && hour < hi) return name
  }
  return 'night'
}

export function energyBucket(energy) {
  const value = Number.isFinite(energy) ? energy : 0.5
  if (value < 0.4) return 'low'
  if (value <= 0.7) return 'mid'
  return 'high'
}

export function silenceBucket(nowMs, lastUserMessageAt) {
  if (!lastUserMessageAt) return '>24h'
  const last = Date.parse(lastUserMessageAt)
  if (!Number.isFinite(last)) return '>24h'
  const minutes = (nowMs - last) / 60_000
  if (minutes < 30) return '<30m'
  if (minutes < 120) return '30-120m'
  if (minutes < 360) return '2-6h'
  if (minutes < 1440) return '6-24h'
  return '>24h'
}

/**
 * @param {object} state - proactive 状态（energy / unansweredCount / lastUserMessageAt / lastProactiveAt）
 * @param {Date} now
 * @param {string|null} currentAxis - 住相给的轴（relation / current）
 */
export function stateSignature(state = {}, now = new Date(), currentAxis = null) {
  const slot = slotOf(now.getHours())
  const energy = energyBucket(state?.energy)
  const silence = silenceBucket(now.getTime(), state?.lastUserMessageAt)
  const lastResult = (state?.unansweredCount ?? 0) > 0
    ? 'unanswered'
    : (state?.lastProactiveAt ? 'replied' : 'none')
  const axis = currentAxis ?? 'none'
  return [slot, energy, silence, lastResult, axis].join('|')
}
