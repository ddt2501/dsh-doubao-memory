/**
 * 记忆召回信用 —— 用 L4/L5 实验拟合的权重做混合排序。
 *
 * 实验结论（内部研究）：信用加权召回明显优于字面召回；
 * 拟合显示长期重要性远重于字面匹配，实际采用 0.8/0.2。
 *
 * 信用文件格式（<dataRoot>/RUNTIME/state/recall-credit.json）：
 *   { "version": 1, "updatedAt": "...", "topics": { "<主题描述>": <0-100> } }
 * 文件不存在 ⇒ 返回 null ⇒ 调用方退回纯字面排序（与旧版一致）。
 */

import { existsSync, readFileSync } from 'node:fs'

export const DEFAULT_WEIGHTS = { sim: 0.2, prior: 0.8 }
const NEUTRAL_PRIOR = 50

export function loadRecallCredit(file) {
  try {
    if (!file || !existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || raw.version !== 1 || !raw.topics || typeof raw.topics !== 'object') return null
    return raw.topics
  } catch {
    return null
  }
}

/** 字符集重合度（0-1），与现有 relevantThemes 的算法一致。 */
export function charOverlap(text, desc) {
  const a = new Set(String(text ?? ''))
  const b = new Set(String(desc ?? ''))
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const ch of b) if (a.has(ch)) inter++
  return inter / b.size
}

/**
 * 单条召回分：w.sim·字面重合 + w.prior·信用（0-1）。
 * 没有信用数据时 prior 取中性 0.5 ⇒ 排序退化为纯字面（旧行为）。
 */
export function recallScore({ text, desc, credit = null, weights = DEFAULT_WEIGHTS }) {
  const sim = charOverlap(text, desc)
  const prior = Number.isFinite(credit?.[desc]) ? credit[desc] / 100 : NEUTRAL_PRIOR / 100
  return weights.sim * sim + weights.prior * prior
}

/** 对候选条目排序（不修改输入）。 */
export function rankRecall(entries, text, credit = null, weights = DEFAULT_WEIGHTS) {
  return (entries ?? [])
    .map((entry) => ({
      ...entry,
      score: recallScore({ text, desc: entry.desc, credit, weights }),
      sim: charOverlap(text, entry.desc),
    }))
    .sort((a, b) => b.score - a.score)
}
