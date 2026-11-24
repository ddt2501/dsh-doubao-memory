/**
 * 事实记忆召回编排器 —— 独立于住相的记忆检索通道（服务日常会话）。
 *
 * ⚠️ 层次定位（2026-11-22 澄清）：住相是人格映射（抽象 WIKI 再抽象），**不是记忆检索**。
 *    本模块是**独立的记忆召回**，经 recall_memory 工具按需服务主对话，不进住相。
 *
 * ## 编排管线（各段可替换）
 *   温度池（core/active/archival）→ Retriever（相关性）→ 排序（0.2·sim + 0.8·R）
 *   → 过滤 → 预算装填 + 实体聚合 → 命中强化。
 *
 * ## token 效率
 *   只回 gist（三元组），同 subject 聚合成实体卡（不重复主语），按预算贪心装填。
 *   出处/原话不进召回 payload —— 要核对走 memory_get(id)。
 *
 * ## 排序基底
 *   R = 衰减后的强度 = 先验。与主题召回（JitRL recall-credit）同形：0.2·字面 + 0.8·先验。
 */

import { retrievability } from './dynamics.js'
import { defaultRetriever, factDesc } from './retrieval.js'

export { factDesc } from './retrieval.js'
export const FACT_WEIGHTS = { sim: 0.2, prior: 0.8 }
/** R 高于此即使字面不命中也召回（高重要度事实） */
export const R_THRESHOLD = 0.5

/** 粗截断（token ≈ 字符/1.5） */
function cap(text, maxTokens) {
  if (!text) return ''
  const limit = Math.floor(maxTokens * 1.5)
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
const estTokens = (text) => Math.ceil(String(text).length / 1.5)

/**
 * 温度池选择：默认 core(pinned) ∪ active；deep 才纳入 dormant/archival。
 * 这是 token 效率的第一道闸——默认不碰沉底记忆。
 */
export function selectPool(gists, { deep = false } = {}) {
  const current = (gists ?? []).filter((g) => g.valid_to == null)
  if (deep) return current
  return current.filter((g) => g.pinned === 1 || g.status === 'active')
}

/** 混合排序（不修改输入）：sim 来自 retriever，R 来自动力学。兼容旧调用。 */
export function rankFacts(facts, message, now = Date.now(), weights = FACT_WEIGHTS, retriever = defaultRetriever) {
  const scored = retriever.retrieve(message, facts)
  return scored
    .map((m) => {
      const r = retrievability(m, now)
      return { ...m, desc: factDesc(m), r, score: weights.sim * (m.sim ?? 0) + weights.prior * r }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * 实体聚合 + 预算装填：同 subject 归一张卡（"subject › pred=obj · pred=obj"），
 * 贪心装到 maxTokens。返回 {text, usedFactCount, more}。
 */
export function packGists(ranked, maxTokens = 200) {
  const groups = new Map()   // subject → [facts]（保持排序序）
  for (const f of ranked) {
    if (!groups.has(f.subject)) groups.set(f.subject, [])
    groups.get(f.subject).push(f)
  }
  const lines = []
  let budget = maxTokens
  let used = 0
  for (const [subject, facts] of groups) {
    const card = `${subject} › ${facts.map((f) => `${f.predicate}=${f.object}`).join(' · ')}`
    const cost = estTokens(card) + 1
    if (cost > budget && lines.length) break   // 至少给一张卡；装不下就停
    lines.push(card)
    budget -= cost
    used += facts.length
  }
  return { text: lines.join('\n'), usedFactCount: used, more: Math.max(0, ranked.length - used) }
}

/**
 * 结构化召回（recall_memory 工具用）。
 * @returns {{hits:Array, text:string, more:number}}
 */
export function recallMemories(store, query, opts = {}) {
  const {
    maxTokens = 200, topK = 8, deep = false, now = Date.now(),
    weights = FACT_WEIGHTS, reinforceHits = true, retriever = defaultRetriever,
  } = opts
  const empty = { hits: [], text: '', more: 0 }
  if (!store) return empty
  let gists
  try { gists = store.listGists() } catch { return empty }
  const pool = selectPool(gists, { deep })
  if (!pool.length) return empty
  const ranked = rankFacts(pool, query, now, weights, retriever)
    .filter((f) => (f.sim ?? 0) > 0 || f.r >= R_THRESHOLD)
  if (!ranked.length) return empty
  const candidates = ranked.slice(0, topK)
  const { text, usedFactCount, more } = packGists(candidates, maxTokens)
  const hits = candidates.slice(0, usedFactCount)
  if (reinforceHits) {
    for (const f of hits) { try { store.reinforceById(f.id, now) } catch { /* 强化失败不影响召回 */ } }
  }
  return { hits, text, more: more + (ranked.length - candidates.length) }
}

/**
 * 兼容包装：返回 top-k 描述串（旧 recallFacts 语义，供历史调用/测试）。
 * 新代码请用 recallMemories（结构化 + 实体聚合 + 预算）。
 */
export function recallFacts(store, message, opts = {}) {
  const { topK = 3, maxTokens = 120, now = Date.now(), weights = FACT_WEIGHTS, reinforceHits = true } = opts
  if (!store) return null
  let facts
  try { facts = store.list({ status: 'active' }) } catch { return null }
  if (!facts.length) return null
  const picked = rankFacts(facts, message, now, weights)
    .filter((f) => (f.sim ?? 0) > 0 || f.r >= R_THRESHOLD)
    .slice(0, topK)
  if (!picked.length) return null
  if (reinforceHits) {
    for (const f of picked) { try { store.reinforceById(f.id, now) } catch { /* ignore */ } }
  }
  return cap(picked.map((f) => f.desc).join('；'), maxTokens)
}