/**
 * 记忆入库逻辑（v1.1.0 · P1）—— ingest 抽取的结构化记忆经此写库。
 *
 * 纯函数（store + items → 结果），便于离线自测；CLI 包装见
 * `RUNTIME/scripts/memory-upsert.mjs`。
 *
 * ## 冲突/作废（复用 wiki 的重复/冲突三分类）
 *
 * 对每条候选，按 subject+predicate 找当前有效记忆：
 *   - 无 ⇒ **insert**（新事实）
 *   - 有且 object 相同 ⇒ **skip**（重复，幂等，不重复入库）
 *   - 有但 object 不同 ⇒ **supersede**（冲突，新值作废旧值，保留历史）
 *
 * ## 质量守卫（无人工闸门）
 *
 * 必填字段（subject/predicate/object/type/source_ref/quote）任一缺失 ⇒ **rejected**。
 * 低置信不拒收，由 store 映射成低 importance ⇒ 衰减自清洁。
 * 单条失败不中断整批（逐条 try/catch）。
 */

const REQUIRED = ['subject', 'predicate', 'object', 'type', 'source_ref', 'quote']

/**
 * @param {object} store - openMemoryStore 句柄
 * @param {Array<object>} items - 候选记忆
 * @param {number} [now] - 时间戳（测试可注入）
 * @returns {{inserted:number, superseded:number, skipped:number, rejected:Array<{index:number, reason:string}>}}
 */
export function upsertMemories(store, items, now = Date.now()) {
  const result = { inserted: 0, superseded: 0, skipped: 0, rejected: [] }
  const list = Array.isArray(items) ? items : []
  for (let i = 0; i < list.length; i++) {
    const m = list[i] ?? {}
    try {
      for (const k of REQUIRED) {
        if (!String(m[k] ?? '').trim()) throw new Error(`缺少必填字段 ${k}`)
      }
      const subject = String(m.subject).trim()
      const predicate = String(m.predicate).trim()
      const object = String(m.object).trim()
      const existing = store.findCurrent(subject, predicate)
      if (existing && String(existing.object).trim() === object) {
        result.skipped++
        continue
      }
      const payload = { ...m, subject, predicate, object }
      if (existing) {
        store.supersede(existing.id, payload, now)
        result.superseded++
      } else {
        store.insert(payload, now)
        result.inserted++
      }
    } catch (err) {
      result.rejected.push({ index: i, reason: String(err?.message ?? err) })
    }
  }
  return result
}