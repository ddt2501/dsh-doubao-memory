/**
 * JitRL 决策服务 —— "全局"接入的统一入口。
 *
 * 任何模块只要有「状态 + 候选列表」，就能用同一条链：
 *   打分（规则先验或 verbalized）→ 记忆取邻居 → 优势估计 → z'=base+β·Â → 采样/取 top-k
 *
 * 记忆按 point 隔离（proactive.theme / snapshot.material（规划中） ...），互不串味。
 * 失败/无信号一律返回 null，调用方降级回原逻辑。
 */

import { loadMemory, saveMemory, addRow, neighbors } from './memory.js'
import { scoreCandidates } from './score.js'
import { estimateAdvantage, applyAdvantage, maturityWeight, softmaxSample } from './kernel.js'
import { stateSignature } from './signature.js'

/**
 * @param {object} opts
 * @param {object} opts.ctx - 插件 scope（需要 .llm 才能走 verbalized）
 * @param {object} opts.cfg - jitrl 配置
 * @param {string} opts.point - 决策点命名空间
 * @param {string} opts.memoryFile - 记忆文件路径
 * @param {object} [opts.state] - 用于状态签名的状态
 * @param {string} [opts.stateText] - 给打分器看的状态描述（缺省用签名）
 * @param {Array<{id:string, text:string}>} opts.candidates
 * @param {Record<string, number>} [opts.prior] - 规则先验（0–1），无打分器时用
 * @param {string} [opts.axis]
 * @param {number} [opts.k] - >1 时取 z' 的 top-k（不采样）
 * @param {Date} [opts.now]
 * @param {Function} [opts.rng]
 * @returns {Promise<{ids:string[], texts:string[], sig:string, beta:number, adv:object, degraded:boolean}|null>}
 */
export async function decideWithAdvantage(opts) {
  const {
    ctx, cfg, point, memoryFile, state, stateText, candidates, prior,
    axis = null, k = 1, now = new Date(), rng = Math.random,
  } = opts ?? {}
  if (!cfg?.enabled || !memoryFile || !Array.isArray(candidates) || !candidates.length) return null

  const store = loadMemory(memoryFile)
  const sig = stateSignature(state ?? {}, now, axis)

  // 1) 打分：verbalized 优先，失败退回规则先验
  let base = null
  if (cfg.scoring === 'verbalized' && ctx?.llm) {
    const probs = await scoreCandidates(ctx, { model: cfg.model }, {
      state: stateText ?? sig,
      candidates: candidates.map((c) => c.text),
    })
    if (probs) {
      base = Object.fromEntries(candidates.map((c, i) => [c.id, probs[i]]))
    }
  }
  if (!base) {
    if (!prior) return null
    base = prior
  }

  // 2) 优势
  const pool = neighbors(store, sig, axis, cfg.minNeighbors ?? 3, cfg.topK ?? 16, point)
  const adv = estimateAdvantage(pool, candidates.map((c) => c.id), {
    shrink: cfg.shrink,
    relaxedWeight: cfg.relaxedWeight,
  })
  if (!candidates.some((c) => Math.abs(adv[c.id]) > 1e-9)) return null

  // 3) 调制 + 选择
  const beta = (cfg.beta ?? 1.5) * maturityWeight(store.rows?.length ?? 0, {
    rowsToFull: cfg.maturityRows ?? 50,
  })
  const z = applyAdvantage(base, adv, beta)

  let ids
  if (k > 1) {
    ids = Object.entries(z)
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([id]) => id)
  } else {
    const chosen = softmaxSample(z, cfg.temperature ?? 0.7, rng)
    ids = chosen ? [chosen] : []
  }
  if (!ids.length) return null

  return {
    ids,
    texts: ids.map((id) => candidates.find((c) => c.id === id)?.text ?? ''),
    sig,
    beta,
    adv,
    degraded: false,
  }
}

/**
 * 结算一个决策点的动作：给每个动作写一行 (sig, action, reward)。
 * 调用方负责判断"哪些动作该结算"（被执行的、被采纳的）。
 */
export function settleDecision({ memoryFile, point, sig, actions, reward, at, maxRows }) {
  if (!memoryFile || !Array.isArray(actions) || !actions.length) return false
  const store = loadMemory(memoryFile)
  for (const action of actions) {
    addRow(store, {
      sig,
      point,
      action,
      ret: reward,
      at: at ?? new Date().toISOString(),
    }, maxRows)
  }
  return saveMemory(memoryFile, store)
}
