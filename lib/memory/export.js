/**
 * 记忆导出（v1.1.0 · P3）—— SQLite → wiki 抽象的候选选择 + 设置页视图。
 *
 * ## 固化（solidified）判据
 *
 * 不是所有记忆都值得抽象成人格材料。**反复被用到、且沉淀了一段时间的**才值得：
 *
 *   importance ≥ minImportance 且 recall_count ≥ minRecall 且 年龄 ≥ minAgeDays
 *
 * 默认 0.6 / 2 次 / 7 天——保守起步，防"刚抽出来就上升为人格"。
 * 手工/早期抽象可用 CLI 参数放宽（显式行为，不改默认）。
 *
 * ## 出处链
 *
 * 导出带 `id` 与 `source_ref`：wiki 断言的 `来源` 写
 * `"memory#<id> · <source_ref>"` ⇒ 对话 → 记忆 → 人格材料 全程可追溯。
 */

const DAY_MS = 86_400_000

export const SOLIDIFIED_DEFAULTS = { minImportance: 0.6, minRecall: 2, minAgeDays: 7 }

/** 从当前有效记忆里选固化候选（纯函数，不修改输入）。 */
export function selectSolidified(facts, opts = {}, now = Date.now()) {
  const { minImportance, minRecall, minAgeDays } = { ...SOLIDIFIED_DEFAULTS, ...opts }
  return (facts ?? []).filter((m) => {
    if (m.status !== 'active' || m.valid_to != null) return false
    if (Number(m.importance) < minImportance) return false
    if ((m.recall_count || 0) < minRecall) return false
    const born = Date.parse(m.created_at ?? '')
    if (!Number.isFinite(born)) return false
    return (now - born) / DAY_MS >= minAgeDays
  })
}

/** 导出行（给 wiki LLM 读：带 id 供引用，带 quote 供核对，不带内部衰减字段）。 */
export function exportRow(m) {
  return {
    id: m.id,
    subject: m.subject,
    predicate: m.predicate,
    object: m.object,
    type: m.type,
    source_ref: m.source_ref,
    quote: m.quote,
    importance: m.importance,
    recall_count: m.recall_count,
    created_at: m.created_at,
  }
}

/**
 * 设置页浏览视图（host 写 `.doubao-facts.json`，client 经 workspaceFiles 读）。
 * 只读摘要：计数 + 按重要度排序的 top-N 当前有效记忆。
 */
export function buildFactView(store, { limit = 30, now = Date.now() } = {}) {
  const facts = store.list({ status: 'active' })
  const sorted = [...facts].sort((a, b) => Number(b.importance) - Number(a.importance))
  return {
    generatedAt: new Date(now).toISOString(),
    count: facts.length,
    total: store.count(),
    facts: sorted.slice(0, limit).map((m) => ({
      id: m.id,
      subject: m.subject,
      predicate: m.predicate,
      object: m.object,
      type: m.type,
      importance: m.importance,
      recallCount: m.recall_count,
      pinned: m.pinned === 1,
      createdAt: m.created_at,
    })),
  }
}