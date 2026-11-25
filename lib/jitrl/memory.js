/**
 * JitRL 记忆 —— (状态签名, 动作, 回报) 三元组 + 待结算记录。
 *
 * 独立于 proactive.json：JitRL 读写失败不许影响主状态机。
 * 文件小（maxRows=500），同步读写足够；写盘用 tmp + rename 保证原子。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const EMPTY = { version: 1, rows: [], pending: {} }

export function emptyMemory() {
  return { version: 1, rows: [], pending: {} }
}

/** 读失败一律返回空记忆（降级，不抛错）。 */
export function loadMemory(file) {
  try {
    if (!file || !existsSync(file)) return emptyMemory()
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) return emptyMemory()
    return { version: 1, rows: raw.rows, pending: raw.pending ?? {} }
  } catch {
    return emptyMemory()
  }
}

/** 写盘失败返回 false（调用方记日志，不抛错）。 */
export function saveMemory(file, store) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * @param {object} store
 * @param {{sig:string, axis?:string, action:string, ret:number, at:string, point?:string}} row
 * @param {number} maxRows - 超出按时间淘汰最旧的
 */
export function addRow(store, row, maxRows = 500) {
  store.rows.push({
    sig: row.sig,
    axis: row.axis ?? null,
    point: row.point ?? null,
    action: row.action,
    ret: row.ret,
    at: row.at ?? new Date().toISOString(),
  })
  if (store.rows.length > maxRows) {
    store.rows.splice(0, store.rows.length - maxRows)
  }
  return store
}

/**
 * 邻居召回：同签名优先；不足 minNeighbors 时放宽到同轴（axis 相同）。
 * 传入 point 时按决策点过滤（旧行没有 point ⇒ 视为通用，仍保留）。
 * 返回按时间倒序的最近 k 条。
 */
export function neighbors(store, sig, axis, minNeighbors = 3, k = 16, point = null) {
  const rows = (Array.isArray(store?.rows) ? store.rows : [])
    .filter((r) => !point || !r.point || r.point === point)
  const exact = rows.filter((r) => r.sig === sig).map((r) => ({ ...r, relaxed: false }))
  let pool = exact
  if (exact.length < minNeighbors && axis) {
    // 放宽到同轴：这些行只"沾边"，标记 relaxed 让优势估计给它们降权
    const sameAxis = rows
      .filter((r) => r.sig !== sig && r.axis === axis)
      .map((r) => ({ ...r, relaxed: true }))
    pool = [...exact, ...sameAxis]
  }
  return pool.slice(-k)
}
