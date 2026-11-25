/**
 * SQLite 事实记忆存储单测（v1.1.0 · P0）。
 *
 * 覆盖：迁移幂等 / 出处守卫 / 置信度→重要度 / 衰减与强化 / 钉住免删 /
 *       三阶段遗忘 / supersede / FTS5 中文检索 / **跨进程 WAL 读写**。
 *
 * 跑法：node --test（随全量套件）。跨进程用例 spawn 独立 node 进程，
 *       子进程结果写临时文件回读（不用 piped stdio，受限沙箱下也稳）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  openMemoryStore, SCHEMA_VERSION, TYPE_STABILITY,
  initialImportance, retrievability, reinforce, ageMemory, daysSince,
} from '../lib/memory/store.js'

const T0 = Date.parse('2026-11-22T00:00:00Z')
const DAY = 86_400_000
const iso = (ms) => new Date(ms).toISOString()

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'memstore-'))
  return { dir, dbPath: join(dir, 'memory.db') }
}

const sample = (over = {}) => ({
  subject: '用户', predicate: 'open_id', object: 'ou_test_0001',
  type: 'fact', source_ref: 'RAW/conversations/2026-11-02', quote: '用户的 open_id 是 ou_test…',
  confidence: 0.9, ...over,
})

test('store: 迁移幂等，user_version 落到 SCHEMA_VERSION', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s1 = openMemoryStore(dbPath)
    assert.equal(s1.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
    s1.insert(sample())
    s1.close()
    // 再开一次：不重复建表、不丢数据
    const s2 = openMemoryStore(dbPath)
    assert.equal(s2.count(), 1)
    assert.equal(s2.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
    s2.close()
  } finally { cleanup(dir) }
})

test('store: insert/get 往返；fact 默认 pinned', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    const id = s.insert(sample(), T0)
    const row = s.get(id)
    assert.equal(row.subject, '用户')
    assert.equal(row.object, 'ou_test_0001')
    assert.equal(row.pinned, 1)                       // fact 默认钉住
    assert.equal(row.stability, TYPE_STABILITY.fact)  // 365
    assert.equal(row.status, 'active')
    assert.equal(row.valid_to, null)
    // 非 fact 默认不钉住
    const id2 = s.insert(sample({ type: 'episode', predicate: '做过', object: '某天改了配置' }), T0)
    assert.equal(s.get(id2).pinned, 0)
    s.close()
  } finally { cleanup(dir) }
})

test('store: 出处守卫——缺 quote / source_ref 拒收', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    assert.throws(() => s.insert(sample({ quote: '' })), /quote/)
    assert.throws(() => s.insert(sample({ source_ref: '  ' })), /source_ref/)
    assert.throws(() => s.insert(sample({ object: '' })), /object/)
    assert.equal(s.count(), 0)   // 一条都没进
    s.close()
  } finally { cleanup(dir) }
})

test('store: 置信度映射初始重要度（低置信→低重要度）', () => {
  assert.equal(initialImportance(0.8), 0.68)
  assert.equal(initialImportance(0.5), 0.5)
  assert.equal(initialImportance(0.3), 0.38)
  assert.ok(initialImportance(0.9) > initialImportance(0.3))
})

test('store: 可召回度随时间衰减（episode 半衰期 30 天）', () => {
  const mem = { importance: 0.68, stability: 30, created_at: iso(T0), last_recalled: null }
  const r0 = retrievability(mem, T0)
  const r30 = retrievability(mem, T0 + 30 * DAY)
  const r60 = retrievability(mem, T0 + 60 * DAY)
  assert.ok(Math.abs(r0 - 0.68) < 1e-9)
  assert.ok(Math.abs(r30 - 0.68 * Math.exp(-1)) < 1e-6)  // 一个半衰期 → ×1/e
  assert.ok(r0 > r30 && r30 > r60)
})

test('store: 强化抬重要度/半衰期、重置衰减时钟', () => {
  const mem = { importance: 0.5, stability: 30, recall_count: 2, created_at: iso(T0 - 40 * DAY), last_recalled: iso(T0 - 40 * DAY) }
  const before = retrievability(mem, T0)
  const patch = reinforce(mem, T0)
  assert.ok(patch.importance > mem.importance)
  assert.ok(patch.stability > mem.stability)
  assert.equal(patch.recall_count, 3)
  assert.equal(patch.last_recalled, iso(T0))
  const after = retrievability({ ...mem, ...patch }, T0)
  assert.ok(after > before, `强化后 R 应跳升: ${after} > ${before}`)
})

test('store: 钉住的事实长期不衰减到可忽略（fact 半衰期 365）', () => {
  const mem = { importance: 0.68, stability: 365, pinned: 1, created_at: iso(T0), last_recalled: null }
  const r180 = retrievability(mem, T0 + 180 * DAY)
  assert.ok(r180 > 0.4, `身份级事实半年后仍应高可召回: ${r180}`)
})

test('store: ageMemory 免删保护（pinned / importance≥0.9）', () => {
  const old = { importance: 0.2, stability: 30, pinned: 1, recall_count: 4, created_at: iso(T0 - 200 * DAY), forget_stage: 0 }
  const p = ageMemory(old, T0)
  assert.equal(p.status, 'active')
  assert.equal(p.forget_stage, 0)
  assert.equal(p.recall_count, 2)   // 折半
  const hi = ageMemory({ ...old, pinned: 0, importance: 0.95 }, T0)
  assert.equal(hi.status, 'active')
})

test('store: 三阶段遗忘 dormant→1→2→archived，且不物理删除', () => {
  const base = { importance: 0.2, stability: 30, pinned: 0, recall_count: 0, created_at: iso(T0 - 200 * DAY), last_recalled: null }
  const s1 = ageMemory({ ...base, forget_stage: 0 }, T0)
  assert.equal(s1.status, 'dormant'); assert.equal(s1.forget_stage, 1); assert.equal(s1.forget_since, iso(T0))
  const s2 = ageMemory({ ...base, forget_stage: 1, forget_since: iso(T0) }, T0 + 8 * DAY)
  assert.equal(s2.forget_stage, 2)
  const s3 = ageMemory({ ...base, forget_stage: 2, forget_since: iso(T0) }, T0 + 15 * DAY)
  assert.equal(s3.status, 'archived'); assert.equal(s3.forget_stage, 3)
})

test('store: supersede 作废旧值保留历史，list 默认排除已作废', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    const oldId = s.insert(sample({ object: 'ou_old' }), T0)
    const newId = s.supersede(oldId, sample({ object: 'ou_new', quote: '更正：open_id 是 ou_new' }), T0 + DAY)
    const old = s.get(oldId)
    assert.equal(old.valid_to, iso(T0 + DAY))
    assert.equal(old.superseded_by, newId)
    assert.equal(s.get(newId).object, 'ou_new')
    assert.equal(s.count(), 2)                       // 历史仍在（不物理删）
    assert.equal(s.list().length, 1)                 // 默认只列当前有效
    assert.equal(s.list({ includeSuperseded: true }).length, 2)
    s.close()
  } finally { cleanup(dir) }
})

test('store: FTS5 + LIKE 检索（ascii / ≥3字中文 / 2字中文兜底）', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    s.insert(sample(), T0)
    s.insert(sample({ type: 'preference', predicate: '偏好', object: '用户偏好冷硬叙事风格', quote: '我喜欢冷硬叙事' }), T0)
    assert.ok(s.search('open_id').some((r) => r.object.includes('ou_test')), 'ascii 命中')
    assert.ok(s.search('冷硬叙事').some((r) => r.object.includes('冷硬叙事')), '≥3字中文 FTS 命中')
    assert.ok(s.search('飞书').length >= 0, '短查询不报错')
    // 2 字中文走 LIKE 兜底：插入含「飞书」的记忆
    s.insert(sample({ type: 'fact', predicate: '应用', object: '飞书应用 cli_test', quote: '飞书应用是 cli_test' }), T0)
    assert.ok(s.search('飞书').some((r) => r.object.includes('飞书应用')), '2字中文 LIKE 兜底命中')
    assert.ok(s.search('冷硬').some((r) => r.object.includes('冷硬叙事')), '2字中文 LIKE 兜底命中')
    // 检索结果附带可召回度 r
    assert.ok(s.search('open_id').every((r) => typeof r.r === 'number'))
    s.close()
  } finally { cleanup(dir) }
})

test('store: decayBatch 推进老化但不删行', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    // 一条低重要度、很久没命中的 episode → 应进 dormant
    s.insert(sample({ type: 'episode', predicate: '做过', object: '很久以前的事', confidence: 0.3, quote: '很久以前' }), T0 - 200 * DAY)
    const before = s.count()
    const n = s.decayBatch(T0)
    assert.equal(n, 1)
    assert.equal(s.count(), before)   // 不物理删
    const row = s.list({ includeSuperseded: true })[0]
    assert.equal(row.status, 'dormant')
    assert.equal(row.forget_stage, 1)
    s.close()
  } finally { cleanup(dir) }
})

test('store: 跨进程 WAL——独立进程读到写进程的全部数据', () => {
  const { dir, dbPath } = tmpDb()
  const outFile = join(dir, 'child-result.json')
  try {
    const writer = openMemoryStore(dbPath)
    for (let i = 0; i < 50; i++) {
      writer.insert(sample({ predicate: 'p' + i, object: '记忆条目 ' + i + ' 冷硬叙事', quote: 'q' + i }), T0)
    }
    // 不 close writer，模拟 host 写侧常驻；spawn 独立读进程
    const childScript = `
      const { DatabaseSync } = require('node:sqlite')
      const fs = require('node:fs')
      const db = new DatabaseSync(process.argv[1], { readOnly: true })
      db.exec('PRAGMA busy_timeout = 5000')
      const c = db.prepare('SELECT count(*) c FROM memory').get().c
      const fts = db.prepare("SELECT count(*) c FROM memory_fts WHERE memory_fts MATCH '\\"冷硬叙事\\"'").get().c
      fs.writeFileSync(process.argv[2], JSON.stringify({ count: c, fts }))
      db.close()
    `
    const r = spawnSync(process.execPath, ['-e', childScript, dbPath, outFile], { stdio: 'ignore' })
    assert.equal(r.status, 0, `子进程退出码 ${r.status}`)
    const res = JSON.parse(readFileSync(outFile, 'utf8'))
    assert.equal(res.count, 50, '独立进程应读到全部 50 行')
    assert.ok(res.fts >= 50, '独立进程 FTS5 也应命中')
    writer.close()
  } finally { cleanup(dir) }
})
// 尽力清理：Windows 下 SQLite WAL/SHM 关闭后可能短暂持锁，清理失败不应判测试失败
function cleanup(d) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* ignore */ } }
