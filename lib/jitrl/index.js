/**
 * JitRL 接入层 —— 包住 selectTheme：先验分 → 优势调制 → 采样。
 *
 * 设计（见 docs/PRD-JITRL.md）：
 *   - 只对先验分 top-N 候选做调制（防冷门种子靠噪声上位）
 *   - 邻居不足 / 无信号 / 出错 ⇒ 原 argmax，行为与旧版逐字节一致
 *   - 结算只认行为信号：被回复 +1（15 分钟内额外 +0.2），下一条发出仍未回 −1
 */

import { scoreThemes } from '../proactive/themes.js'
import { stateSignature } from './signature.js'
import { estimateAdvantage, modulate, applyAdvantage, maturityWeight, softmaxSample } from './kernel.js'
import { addRow, neighbors } from './memory.js'

const REPLY_FAST_MS = 15 * 60_000

/**
 * 选主题。参数与 selectTheme 兼容，另加 jitrl 配置 + memoryFile + state。
 *
 * @param {object[]} seeds
 * @param {object} themeStates
 * @param {object} opts
 * @param {object} [opts.jitrl] - 配置（enabled/beta/shrink/scale/temperature/...）
 * @param {object} [opts.store] - 已加载的记忆（缺省则纯降级）
 * @param {object} [opts.state] - proactive 状态（算签名）
 * @param {Date}   [opts.now]
 * @param {string} [opts.currentAxis]
 * @param {Function} [opts.onDecision] - 日志回调
 * @param {Function} [opts.rng] - 采样随机源（测试用）
 */
export function selectWithAdvantage(seeds, themeStates = {}, opts = {}) {
  const scored = scoreThemes(seeds, themeStates, opts)
  if (!scored.length) return null
  scored.sort((a, b) => b.score - a.score)
  const fallback = scored[0]

  const cfg = opts.jitrl ?? {}
  if (!cfg.enabled || !opts.store) {
    return fallback
  }

  try {
    const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now())
    const sig = stateSignature(opts.state ?? {}, now, opts.currentAxis ?? null)
    const topN = Math.max(1, Math.min(cfg.topCandidates ?? 8, scored.length))
    const top = scored.slice(0, topN)
    const actions = top.map((entry) => entry.seed.id)

    const pool = neighbors(opts.store, sig, opts.currentAxis ?? null, cfg.minNeighbors ?? 3, cfg.topK ?? 16)
    const adv = estimateAdvantage(pool, actions, {
      shrink: cfg.shrink,
      relaxedWeight: cfg.relaxedWeight,
    })
    const hasSignal = actions.some((action) => Math.abs(adv[action]) > 1e-9)
    if (!hasSignal) {
      opts.onDecision?.({ sig, degraded: 'no-signal', candidates: top.map((e) => ({ id: e.seed.id, score: e.score })) })
      return fallback
    }

    // 打分来源：verbalized（模型自评 0–1，论文降级实现）或规则先验分/scale。
    const base = opts.verbal
      ? Object.fromEntries(top.map((entry) => [entry.seed.id, opts.verbal[entry.seed.id] ?? 0.5]))
      : Object.fromEntries(top.map((entry) => [entry.seed.id, entry.score / (cfg.scale ?? 40)]))
    // β 随记忆成熟度增长（官方 episode_weight：1.0 → 1.5 封顶）
    const beta = (cfg.beta ?? 1.5) * maturityWeight(opts.store.rows?.length ?? 0, {
      rowsToFull: cfg.maturityRows ?? 50,
    })
    const z = applyAdvantage(base, adv, beta)
    const chosenId = softmaxSample(z, cfg.temperature ?? 0.7, opts.rng)
    const chosen = top.find((entry) => entry.seed.id === chosenId) ?? fallback

    opts.onDecision?.({
      sig,
      degraded: null,
      chosen: chosenId,
      candidates: top.map((entry) => ({ id: entry.seed.id, score: entry.score, adv: adv[entry.seed.id] })),
    })
    return chosen
  } catch (error) {
    opts.onDecision?.({ sig: null, degraded: 'error', error: String(error?.message ?? error) })
    return fallback
  }
}

/**
 * 发送一条搭讪后调用：先结算超期未回的 pending（−1），再登记新 pending。
 */
export function settleOnSend(store, pending, opts = {}) {
  if (!store || !pending?.action) return store
  const at = opts.at ?? new Date().toISOString()
  const nowMs = Date.parse(at)
  const windowMs = opts.replyWindowMs ?? 24 * 3600_000

  for (const [id, item] of Object.entries(store.pending ?? {})) {
    const deadline = Date.parse(item.replyDeadline ?? at)
    if (Number.isFinite(deadline) && nowMs >= deadline) {
      addRow(store, { sig: item.sig, axis: null, action: item.action, ret: -1, at }, opts.maxRows)
      delete store.pending[id]
    }
  }

  store.pending = store.pending ?? {}
  store.pending[pending.action] = {
    sig: pending.sig,
    action: pending.action,
    sentAt: at,
    replyDeadline: new Date(nowMs + windowMs).toISOString(),
  }
  return store
}

/**
 * 真人回话后调用：所有 pending 结算为 +1（15 分钟内回复 +0.2）。
 * 返回是否发生了结算，供调用方决定是否写盘。
 */
export function settleOnReply(store, opts = {}) {
  if (!store?.pending || !Object.keys(store.pending).length) return false
  const at = opts.at ?? new Date().toISOString()
  const nowMs = Date.parse(at)
  let settled = false
  for (const [id, item] of Object.entries(store.pending)) {
    const sentAt = Date.parse(item.sentAt ?? at)
    const fast = Number.isFinite(sentAt) && nowMs - sentAt <= REPLY_FAST_MS
    addRow(store, { sig: item.sig, axis: null, action: item.action, ret: fast ? 1.2 : 1.0, at }, opts.maxRows)
    delete store.pending[id]
    settled = true
  }
  return settled
}
