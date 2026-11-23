/**
 * 记忆 v2 模块化架构测试：迁移 / gist-detail 分层 / 检索接口 / 温度池 /
 * 实体聚合预算 / 工具适配。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openMemoryStore, SCHEMA_VERSION } from '../lib/memory/store.js'
import { selectPool, recallMemories, packGists, rankFacts } from '../lib/memory/recall.js'
import { LexicalRetriever } from '../lib/memory/retrieval.js'
import { mountFactMemoryTools } from '../lib/memory/tools.js'

const T0 = Date.parse('2026-11-22T00:00:00Z')
const DAY = 86_400_000
function cleanup(d) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* ignore */ } }
function tmpDb() { const dir = mkdtempSync(join(tmpdir(), 'memv2-')); return { dir, dbPath: join(dir, 'memory.db') } }
const mem = (over = {}) => ({
  subject: '用户', predicate: 'open_id', object: 'ou_test_0001',
  type: 'fact', source_ref: 'RAW/conversations/2026-11-21', quote: 'open_id 是 ou_test_0001',
  confidence: 0.9, ...over,
})

test('v2: 全新库直接建 v2（gist/detail/视图/fts），user_version=2', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    assert.equal(SCHEMA_VERSION, 2)
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 2)
    const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    assert.ok(tables.includes('memory_gist'))
    assert.ok(tables.includes('memory_detail'))
    const views = s.db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map((r) => r.name)
    assert.ok(views.includes('memory'))
    s.close()
  } finally { cleanup(dir) }
})

test('v2: v1 单表迁移到 v2，数据无损 + 分层正确', () => {
  const { dir, dbPath } = tmpDb()
  try {
    // 手工建一个 v1 库（单 memory 表）
    const v1 = new DatabaseSync(dbPath)
    v1.exec(`CREATE TABLE memory (
      id INTEGER PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, type TEXT,
      source_ref TEXT, quote TEXT, confidence REAL, valid_from TEXT, valid_to TEXT,
      superseded_by INTEGER, importance REAL, stability REAL, recall_count INTEGER,
      last_recalled TEXT, pinned INTEGER, forget_stage INTEGER, forget_since TEXT,
      status TEXT, created_at TEXT)`)
    v1.prepare(`INSERT INTO memory VALUES (1,'用户','open_id','ou_old','fact','r','q',0.9,'2026-11-01',NULL,NULL,0.7,365,0,NULL,1,0,NULL,'active','2026-11-01')`).run()
    v1.exec('PRAGMA user_version = 1')
    v1.close()
    // 打开 ⇒ 自动迁移
    const s = openMemoryStore(dbPath)
    assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(s.count(), 1)
    const full = s.get(1)
    assert.equal(full.object, 'ou_old')
    assert.equal(full.quote, 'q')          // 视图 join 出 detail
    assert.equal(s.getGist(1).quote, undefined)   // gist 无 quote
    assert.equal(s.getDetail(1).quote, 'q')       // detail 有 quote
    assert.equal(s.getGist(1).created_at, '2026-11-01')  // created_at 在 gist（衰减用）
    s.close()
  } finally { cleanup(dir) }
})

test('v2: listGists 轻量（无 quote/source_ref），list 全量', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    s.insert(mem(), T0)
    const g = s.listGists()[0]
    assert.equal(g.quote, undefined)
    assert.equal(g.source_ref, undefined)
    assert.ok(g.subject)
    const full = s.list()[0]
    assert.ok(full.quote)
    s.close()
  } finally { cleanup(dir) }
})

test('v2: 温度池——默认排除 dormant，deep 纳入', () => {
  const gists = [
    { id: 1, pinned: 1, status: 'active', valid_to: null },
    { id: 2, pinned: 0, status: 'active', valid_to: null },
    { id: 3, pinned: 0, status: 'dormant', valid_to: null },
    { id: 4, pinned: 0, status: 'archived', valid_to: null },
    { id: 5, pinned: 0, status: 'active', valid_to: '2026-11-22' },  // 已作废
  ]
  assert.deepEqual(selectPool(gists).map((g) => g.id), [1, 2])
  assert.deepEqual(selectPool(gists, { deep: true }).map((g) => g.id), [1, 2, 3, 4])
})

test('v2: packGists 实体聚合 + 预算 + more', () => {
  const ranked = [
    { subject: '用户', predicate: 'open_id', object: 'ou_x' },
    { subject: '用户', predicate: 'Gitee', object: 'acct' },
    { subject: '助手', predicate: '偏好', object: '冷硬' },
  ]
  const { text, usedFactCount, more } = packGists(ranked, 200)
  assert.ok(text.includes('用户 › open_id=ou_x · Gitee=acct'))  // 同主语聚合
  assert.ok(text.includes('助手 › 偏好=冷硬'))
  assert.equal(usedFactCount, 3)
  assert.equal(more, 0)
  // 极小预算 ⇒ 只装第一张卡，more>0
  const tiny = packGists(ranked, 5)
  assert.equal(tiny.usedFactCount, 2)   // 第一张卡（用户两条）
  assert.ok(tiny.more >= 1)
})

test('v2: recallMemories 结构化召回 + 命中强化', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    const id = s.insert(mem({ type: 'preference', predicate: '偏好', object: '冷硬叙事', quote: '喜欢冷硬' }), T0)
    const r = recallMemories(s, '冷硬叙事', { now: T0 })
    assert.ok(r.text.includes('冷硬叙事'))
    assert.equal(r.hits.length, 1)
    assert.equal(s.getGist(id).recall_count, 1)   // 强化写回
    s.close()
  } finally { cleanup(dir) }
})

test('v2: Retriever 接口可插拔（自定义 sim 源改变排序）', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    s.insert(mem({ predicate: 'a', object: 'zzz', importance: 0.5 }), T0)
    s.insert(mem({ predicate: 'b', object: 'yyy', importance: 0.5 }), T0)
    // 自定义检索器：给 object=yyy 满分 sim，应排到前面
    const custom = { retrieve: (q, gists) => gists.map((g) => ({ ...g, sim: g.object === 'yyy' ? 1 : 0 })) }
    const r = recallMemories(s, '任意', { now: T0, retriever: custom, reinforceHits: false })
    assert.equal(r.hits[0].object, 'yyy')
    // LexicalRetriever 显式可用
    assert.ok(new LexicalRetriever().retrieve('x', s.listGists()).every((g) => typeof g.sim === 'number'))
    s.close()
  } finally { cleanup(dir) }
})

test('v2: 工具适配——recall_memory / memory_get 注册并可执行', async () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    const id = s.insert(mem({ predicate: 'Gitee账号', object: 'test_account', quote: '账号 test_account' }), T0)
    const registered = []
    const mockScope = {
      tools: { register: (d) => registered.push(d) },
      systemPrompt: { section: () => {} },
    }
    mountFactMemoryTools(mockScope, () => s)
    const recall = registered.find((d) => d.name === 'recall_memory')
    const get = registered.find((d) => d.name === 'memory_get')
    assert.ok(recall && get)
    assert.equal(typeof recall.output.render, 'function')
    const r = await recall.execute({ query: 'gitee 账号' })
    assert.ok(r.text.includes('test_account'))
    assert.equal(r.count, 1)
    const g = await get.execute({ id })
    assert.equal(g.found, true)
    assert.ok(g.text.includes('test_account'))
    assert.ok(g.text.includes('RAW/conversations'))   // 出处
    const miss = await get.execute({ id: 999 })
    assert.equal(miss.found, false)
    s.close()
  } finally { cleanup(dir) }
})