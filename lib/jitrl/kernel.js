/**
 * JitRL 内核 —— 优势估计、调制、采样。纯函数，便于单测。
 *
 * 公式（论文 arXiv:2601.18510 + 官方 jitrl_agent.py 的调制细节）：
 *   Q̂(a) = 动作 a 的加权平均回报（axial 召回的行降权）
 *   V̂    = 已见动作 Q̂ 的均值（基线重算：从邻居级改为动作级）
 *   Â(a) = (Q̂(a) − V̂) × n_a/(n_a + shrink)   # 小样本收缩
 *   Â    = Â / max|Â|                          # max-normalize，尺度固定到 [-1,1]
 *   z'(a) = base(a) + β(t)·Â(a)                # β 随记忆成熟度增长
 *   p     = softmax(z' / T)
 *
 * ⚠️ 对未见动作的偏离：官方以探索概率给正 bonus、否则给 0 后再重算基线，
 *    这会让未见动作的优势变成 -baseline（负），在没有探索项时会把候选池锁死。
 *    这里保持「未见动作 Â=0（中性）」——宁可不选新动作，也不主动惩罚它。
 */

/**
 * 成熟度权重（官方 jitrl_agent.py L370-383 的 episode_weight）：
 * 从 1.0 随行数增长到 1.5 封顶。记忆少时调制要弱，记忆多了才放开。
 */
export function maturityWeight(rows, opts = {}) {
  const rowsToFull = opts.rowsToFull ?? 50
  if (!Number.isFinite(rows) || rows <= 0) return 1
  return Math.min(1 + (rows / rowsToFull) * 0.5, 1.5)
}

/**
 * @param {Array<{action:string, ret:number, relaxed?:boolean}>} neighbors
 * @param {string[]} actions - 本轮候选动作
 * @param {{shrink?:number, relaxedWeight?:number}} opts
 * @returns {Record<string, number>} 每个候选的 Â，范围 [-1, 1]
 */
export function estimateAdvantage(neighbors, actions, opts = {}) {
  const shrink = opts.shrink ?? 4
  const relaxedWeight = opts.relaxedWeight ?? 0.5
  const out = {}
  for (const action of actions) out[action] = 0

  const rows = Array.isArray(neighbors) ? neighbors : []
  if (!rows.length) return out

  // 行权重：放宽到同轴召回的邻居降权，避免轴级噪声主导优势
  const weighted = rows.map((row) => ({
    action: row.action,
    ret: (Number(row.ret) || 0) * (row.relaxed ? relaxedWeight : 1),
    weight: row.relaxed ? relaxedWeight : 1,
  }))

  const byAction = new Map()
  for (const row of weighted) {
    const list = byAction.get(row.action) ?? []
    list.push(row)
    byAction.set(row.action, list)
  }

  // 基线重算：已见动作 Q̂ 的均值（官方 L294-303 的 overall_avg_reward 语义）
  // relaxed 行的回报已乘权重 ⇒ 它的 Q̂ 被压低，方向可信度下降（强度由归一化处理）
  const actionMeans = {}
  for (const [action, list] of byAction) {
    actionMeans[action] = list.reduce((sum, row) => sum + row.ret, 0) / list.length
  }
  const seenMeans = Object.values(actionMeans)
  const baseline = seenMeans.reduce((sum, value) => sum + value, 0) / seenMeans.length

  // 原始优势：收缩后再进入归一化
  const raw = {}
  for (const action of actions) {
    const mean = actionMeans[action]
    if (mean === undefined) {
      raw[action] = 0          // 未见动作：中性，不惩罚（见文件头）
      continue
    }
    const n = (byAction.get(action) ?? []).length
    raw[action] = (mean - baseline) * (n / (n + shrink))
  }

  // max-normalize：正优势除最大正；否则除最大负的绝对值
  const positives = Object.values(raw).filter((value) => value > 0)
  const negatives = Object.values(raw).filter((value) => value < 0)
  let scale = 0
  if (positives.length) scale = Math.max(...positives)
  else if (negatives.length) scale = Math.abs(Math.min(...negatives))

  for (const action of actions) {
    out[action] = scale ? Math.max(-1, Math.min(1, raw[action] / scale)) : 0
  }
  return out
}

/**
 * z'(a) = score(a)/scale + β·Â(a)
 * scale 把先验分（0~80 量级）压到 logit 量级，避免 β·Â 被先验分淹没。
 */
export function modulate(scores, advantages, opts = {}) {
  const beta = opts.beta ?? 1.5
  const scale = opts.scale ?? 40
  const out = {}
  for (const [action, score] of Object.entries(scores)) {
    out[action] = (Number(score) || 0) / scale + beta * (advantages?.[action] ?? 0)
  }
  return out
}

/**
 * 已经归一化到 0–1 的 base（verbalized 的 confidence/100）直接叠加优势：
 *   z' = base + β·Â
 * 不做 scale——verbalized 的 p 本身就是概率量级，再除 scale 会把它抹平。
 */
export function applyAdvantage(base, advantages, beta = 1.5) {
  const out = {}
  for (const [action, value] of Object.entries(base ?? {})) {
    out[action] = (Number(value) || 0) + beta * (advantages?.[action] ?? 0)
  }
  return out
}

/** 按 softmax(z/T) 采样。返回选中的 action；空输入返回 null。 */
export function softmaxSample(z, temperature = 0.7, rng = Math.random) {
  const entries = Object.entries(z ?? {})
  if (!entries.length) return null
  const t = Number.isFinite(temperature) && temperature > 0 ? temperature : 1e-6
  const max = Math.max(...entries.map(([, value]) => value))
  let total = 0
  const weights = entries.map(([action, value]) => {
    const weight = Math.exp((value - max) / t)
    total += weight
    return [action, weight]
  })
  let roll = rng() * total
  for (const [action, weight] of weights) {
    roll -= weight
    if (roll <= 0) return action
  }
  return weights[weights.length - 1][0]
}

/** 无记忆时的确定性选择（与原 selectTheme 一致）。 */
export function argmax(z) {
  const entries = Object.entries(z ?? {})
  if (!entries.length) return null
  return entries.reduce((best, current) => (current[1] > best[1] ? current : best))[0]
}
