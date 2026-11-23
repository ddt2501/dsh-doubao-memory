/**
 * SQLite 事实记忆存储 —— repository facade（v2 分层）。
 *
 * 设计纲领见 vault `05-PROJECTS/记忆系统升级-PRD.md`。一句话：
 *   SQLite 是记忆的**唯一权威**；wiki 是从记忆抽象出的人格材料（源与流）。
 *
 * ## 分层（见 schema.js）
 *   memory_gist（轻，召回/排序/老化）+ memory_detail（重，出处/原话）+ memory 视图（兼容）。
 *   本模块是数据访问层（repository）：只管存取，不含排序/召回策略（那些在 recall/retrieval）。
 *
 * ## 为什么 node:sqlite
 *   Node 22.5+ 内置（桌面 Node 24，SQLite 3.54.0），零原生依赖。WAL + busy_timeout
 *   跨进程读写已实测。
 *
 * ## 公共 API（稳定，供 upsert/export/recall/tools/测试复用）
 *   insert / get / getGist / getDetail / supersede / search / listGists /
 *   reinforceById / decayBatch / findCurrent / list / count / close。
 *   动力学纯函数与 SCHEMA_VERSION 从本模块 re-export（历史调用方兼容）。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrate, SCHEMA_VERSION } from './schema.js'
import {
  TYPE_STABILITY, DEFAULT_STABILITY, initialImportance, retrievability, reinforce, ageMemory,
} from './dynamics.js'

// re-export：历史调用方（测试 / recall / export）从 store.js 取这些，保持兼容
export { SCHEMA_VERSION } from './schema.js'
export {
  TYPE_STABILITY, DEFAULT_STABILITY, STABILITY_CAP, IMPORTANCE_FLOOR,
  ACTIVE_R_THRESHOLD, PROTECT_IMPORTANCE,
  initialImportance, daysSince, retrievability, reinforce, ageMemory,
} from './dynamics.js'

/**
 * 打开（必要时创建 + 迁移）记忆库。
 * @param {string} dbPath
 * @param {object} [opts]
 * @param {boolean} [opts.readonly] - 只读打开（不迁移，库须已存在）
 */
export function openMemoryStore(dbPath, opts = {}) {
  if (!dbPath) throw new Error('openMemoryStore: dbPath required')
  const readonly = opts.readonly === true
  if (!readonly) mkdirSync(dirname(dbPath), { recursive: true })
  const db = readonly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 5000')
  if (!readonly) {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
  }

  // 可重入事务：supersede 包 insert，两者都用 tx ⇒ 嵌套调用只在最外层 BEGIN/COMMIT。
  let txDepth = 0
  const tx = (fn) => {
    const outermost = txDepth === 0
    if (outermost) db.exec('BEGIN')
    txDepth++
    try {
      const r = fn()
      txDepth--
      if (outermost) db.exec('COMMIT')
      return r
    } catch (e) {
      txDepth--
      if (outermost) { try { db.exec('ROLLBACK') } catch { /* ignore */ } }
      throw e
    }
  }

  const insGist = db.prepare(`
    INSERT INTO memory_gist
      (subject, predicate, object, type, importance, stability, pinned, valid_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `)
  const insDetail = db.prepare(`
    INSERT INTO memory_detail
      (id, quote, source_ref, confidence, valid_from)
    VALUES (?, ?, ?, ?, ?)
  `)

  /**
   * 入库一条记忆。强制出处：subject/predicate/object/type/source_ref/quote 任一为空 ⇒ 拒收。
   * @returns {number} 新 id
   */
  function insert(mem, now = Date.now()) {
    for (const k of ['subject', 'predicate', 'object', 'type', 'source_ref', 'quote']) {
      if (!String(mem?.[k] ?? '').trim()) {
        throw new Error(`memory.insert: 缺少必填字段 ${k}（无原话/出处不入库）`)
      }
    }
    const type = String(mem.type)
    const iso = new Date(now).toISOString()
    const confidence = Number.isFinite(mem.confidence) ? mem.confidence : 0.8
    const importance = Number.isFinite(mem.importance) ? mem.importance : initialImportance(confidence)
    const stability = Number(mem.stability || TYPE_STABILITY[type] || DEFAULT_STABILITY)
    const pinned = mem.pinned != null ? (mem.pinned ? 1 : 0) : (type === 'fact' ? 1 : 0)
    return tx(() => {
      const r = insGist.run(String(mem.subject), String(mem.predicate), String(mem.object), type, importance, stability, pinned, iso)
      const id = Number(r.lastInsertRowid)
      insDetail.run(id, String(mem.quote), String(mem.source_ref), confidence, mem.valid_from || iso)
      return id
    })
  }

  const getStmt = db.prepare('SELECT * FROM memory WHERE id = ?')
  const getGistStmt = db.prepare('SELECT * FROM memory_gist WHERE id = ?')
  const getDetailStmt = db.prepare('SELECT * FROM memory_detail WHERE id = ?')
  const get = (id) => getStmt.get(id) ?? null
  const getGist = (id) => getGistStmt.get(id) ?? null
  const getDetail = (id) => getDetailStmt.get(id) ?? null

  /** 作废旧记忆并以新记忆取代（保留历史）。@returns {number} 新 id */
  function supersede(oldId, newMem, now = Date.now()) {
    return tx(() => {
      const newId = insert(newMem, now)
      db.prepare('UPDATE memory_gist SET valid_to = ? WHERE id = ?').run(new Date(now).toISOString(), oldId)
      db.prepare('UPDATE memory_detail SET superseded_by = ? WHERE id = ?').run(newId, oldId)
      return newId
    })
  }

  const ftsStmt = db.prepare(`
    SELECT g.*, d.quote, d.source_ref, d.confidence, d.valid_from, d.superseded_by, f.rank AS fts_rank
    FROM memory_fts f JOIN memory_gist g ON g.id = f.rowid JOIN memory_detail d ON d.id = g.id
    WHERE memory_fts MATCH ? ORDER BY f.rank LIMIT ?
  `)
  const likeStmt = db.prepare(`
    SELECT g.*, d.quote, d.source_ref, d.confidence, d.valid_from, d.superseded_by
    FROM memory_gist g JOIN memory_detail d ON d.id = g.id
    WHERE g.subject LIKE ? OR g.predicate LIKE ? OR g.object LIKE ? LIMIT ?
  `)

  /** 全文检索（FTS5 trigram + LIKE 兜底），返回全量行 + 可召回度 r。供 memory_get/浏览。 */
  function search(query, { limit = 20, now = Date.now() } = {}) {
    const q = String(query ?? '').trim()
    if (!q) return []
    const map = new Map()
    if ([...q].length >= 3) {
      try {
        const phrase = `"${q.replace(/"/g, '""')}"`
        for (const row of ftsStmt.all(phrase, limit)) map.set(row.id, row)
      } catch { /* MATCH 异常 ⇒ LIKE 仍跑 */ }
    }
    const pat = `%${q}%`
    for (const row of likeStmt.all(pat, pat, pat, limit)) if (!map.has(row.id)) map.set(row.id, row)
    return [...map.values()].map((row) => ({ ...row, r: retrievability(row, now) }))
  }

  /**
   * 轻量 gist 列表（召回专用，token  efficient）：只取 gist 列，不 join detail。
   * @param {object} [f]
   * @param {boolean} [f.includeSuperseded=false]
   */
  function listGists({ includeSuperseded = false } = {}) {
    const sql = includeSuperseded
      ? 'SELECT * FROM memory_gist ORDER BY id'
      : 'SELECT * FROM memory_gist WHERE valid_to IS NULL ORDER BY id'
    return db.prepare(sql).all()
  }

  /** 命中强化并写回 gist。返回更新后的全量行。 */
  function reinforceById(id, now = Date.now()) {
    const g = getGist(id)
    if (!g) return null
    const patch = reinforce(g, now)
    db.prepare('UPDATE memory_gist SET importance=?, stability=?, recall_count=?, last_recalled=? WHERE id=?')
      .run(patch.importance, patch.stability, patch.recall_count, patch.last_recalled, id)
    return get(id)
  }

  /** 周期老化批处理（lint 用）：对非 archived gist 推进 status/stage + 折半 recall_count。 */
  function decayBatch(now = Date.now()) {
    const rows = db.prepare("SELECT * FROM memory_gist WHERE status != 'archived'").all()
    const upd = db.prepare('UPDATE memory_gist SET status=?, forget_stage=?, forget_since=?, recall_count=? WHERE id=?')
    return tx(() => {
      let n = 0
      for (const g of rows) {
        const p = ageMemory(g, now)
        upd.run(p.status, p.forget_stage, p.forget_since, p.recall_count, g.id)
        n++
      }
      return n
    })
  }

  const findCurrentStmt = db.prepare(
    'SELECT * FROM memory WHERE subject = ? AND predicate = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1'
  )
  const findCurrent = (subject, predicate) => findCurrentStmt.get(subject, predicate) ?? null

  /** 全量行列表（视图，兼容 export/upsert/测试）。 */
  const list = ({ status, includeSuperseded = false } = {}) => {
    let sql = 'SELECT * FROM memory'
    const where = []
    const args = []
    if (status) { where.push('status = ?'); args.push(status) }
    if (!includeSuperseded) { where.push('valid_to IS NULL') }
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY id'
    return db.prepare(sql).all(...args)
  }

  const count = () => db.prepare('SELECT count(*) c FROM memory_gist').get().c

  return {
    db, insert, get, getGist, getDetail, supersede, search, listGists,
    reinforceById, decayBatch, findCurrent, list, count,
    close: () => db.close(),
  }
}

/** 进程内当前记忆库句柄（挂载时设，召回工具读）。卸载置 null。 */
let currentStore = null
export function setFactMemoryStore(store) { currentStore = store ?? null }
export function getFactMemoryStore() { return currentStore }