/**
 * 记忆导出单测（v1.1.0 · P3）：固化判据 / 导出行 / 浏览视图 / export CLI。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { openMemoryStore } from '../lib/memory/store.js'
import { selectSolidified, exportRow, buildFactView, SOLIDIFIED_DEFAULTS } from '../lib/memory/export.js'
import { PACKAGE_ROOT } from '../lib/paths.js'

const T0 = Date.parse('2026-11-22T00:00:00Z')
const DAY = 86_400_000
const SCRIPT = join(PACKAGE_ROOT, 'RUNTIME', 'scripts', 'memory-export.mjs')

const mem = (over = {}) => ({
  subject: '用户', predicate: 'open_id', object: 'ou_aaa',
  type: 'fact', source_ref: 'RAW/conversations/2026-11-21', quote: 'open_id 是 ou_aaa',
  confidence: 0.9, ...over,
})

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'memexport-'))
  return { dir, dbPath: join(dir, 'memory.db') }
}

test('export: 固化判据——重要度/命中次数/年龄三者都要过', () => {
  const base = { status: 'active', valid_to: null, importance: 0.7, recall_count: 3, created_at: new Date(T0 - 10 * DAY).toISOString() }
  const now = T0
  assert.equal(selectSolidified([base], {}, now).length, 1)
  assert.equal(selectSolidified([{ ...base, importance: 0.5 }], {}, now).length, 0)
  assert.equal(selectSolidified([{ ...base, recall_count: 1 }], {}, now).length, 0)
  assert.equal(selectSolidified([{ ...base, created_at: new Date(T0 - 3 * DAY).toISOString() }], {}, now).length, 0)
  assert.equal(selectSolidified([{ ...base, status: 'dormant' }], {}, now).length, 0)
  assert.equal(selectSolidified([{ ...base, valid_to: new Date(T0).toISOString() }], {}, now).length, 0)
  // 显式放宽（手工早期抽象）
  assert.equal(selectSolidified([{ ...base, recall_count: 0, created_at: new Date(T0).toISOString() }], { minRecall: 0, minAgeDays: 0 }, now).length, 1)
  assert.deepEqual(SOLIDIFIED_DEFAULTS, { minImportance: 0.6, minRecall: 2, minAgeDays: 7 })
})

test('export: exportRow 带 id 与出处，不带内部衰减字段', () => {
  const row = exportRow({ id: 7, subject: 's', predicate: 'p', object: 'o', type: 'fact', source_ref: 'r', quote: 'q', importance: 0.7, recall_count: 2, created_at: 'c', stability: 365, forget_stage: 0 })
  assert.equal(row.id, 7)
  assert.equal(row.source_ref, 'r')
  assert.equal(row.quote, 'q')
  assert.equal(row.stability, undefined)
  assert.equal(row.forget_stage, undefined)
})

test('export: buildFactView 计数 + 按重要度排序 + 只列当前有效', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    const a = s.insert(mem({ importance: 0.5 }), T0)
    const b = s.insert(mem({ predicate: '偏好', object: '冷硬', type: 'preference', importance: 0.9, quote: '喜欢冷硬' }), T0)
    const c = s.supersede(a, mem({ object: 'ou_bbb', quote: '更正 ou_bbb' }), T0)   // a 作废，c 新增
    const view = buildFactView(s, { now: T0 })
    s.close()   // 先关库再断言，避免断言失败时句柄未释放
    assert.equal(view.total, 3)          // 历史保留：a(作废) + b + c
    assert.equal(view.count, 2)          // 只列当前有效：b + c
    assert.equal(view.facts[0].id, b)    // 重要度高的在前（0.9 > 0.74）
    assert.ok(!view.facts.some((f) => f.id === a))
    assert.equal(view.facts[0].recallCount, 0)
  } finally { cleanup(dir) }
})

function runCli({ flag = true, seed, extraArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'export-cli-'))
  const stateDir = join(dir, 'RUNTIME', 'state')
  mkdirSync(stateDir, { recursive: true })
  if (flag) writeFileSync(join(stateDir, 'fact-memory.enabled'), 'on', 'utf8')
  const dbPath = join(dir, 'RUNTIME', 'memory', 'memory.db')
  if (seed) {
    const s = openMemoryStore(dbPath)
    seed(s)
    s.close()
  }
  const outFile = join(dir, 'out.json')
  const r = spawnSync(process.execPath, [SCRIPT, '--data-root', dir, '--out', outFile, ...extraArgs], { stdio: 'ignore' })
  let out = null
  try { out = JSON.parse(readFileSync(outFile, 'utf8')) } catch { /* ignore */ }
  return { dir, out, status: r.status }
}

test('export cli: 无 flag → gated', () => {
  const { dir, out, status } = runCli({ flag: false })
  try {
    assert.equal(status, 0)
    assert.equal(out.gated, true)
    assert.deepEqual(out.memories, [])
  } finally { cleanup(dir) }
})

test('export cli: 默认固化判据保守，放宽后出候选', () => {
  const seed = (s) => { s.insert(mem({ importance: 0.7 }), T0 - 10 * DAY) }
  // 新库 recall_count=0 ⇒ 默认判据下无固化候选
  const strict = runCli({ seed })
  try {
    assert.equal(strict.out.count, 0)
  } finally { cleanup(strict.dir) }
  // 显式放宽 ⇒ 出候选，且带 id 供引用
  const relaxed = runCli({ seed, extraArgs: ['--min-recall', '0', '--min-age-days', '0'] })
  try {
    assert.equal(relaxed.out.count, 1)
    assert.equal(relaxed.out.memories[0].id, 1)
    assert.ok(relaxed.out.memories[0].source_ref)
  } finally { cleanup(relaxed.dir) }
})

test('export cli: --mode all 出全部当前有效', () => {
  const seed = (s) => {
    s.insert(mem(), T0)
    s.insert(mem({ predicate: '偏好', object: '冷硬', type: 'preference', quote: '喜欢冷硬' }), T0)
  }
  const { dir, out } = runCli({ seed, extraArgs: ['--mode', 'all'] })
  try {
    assert.equal(out.mode, 'all')
    assert.equal(out.count, 2)
  } finally { cleanup(dir) }
})
// 尽力清理：Windows 下 SQLite WAL/SHM 关闭后可能短暂持锁，清理失败不应判测试失败
function cleanup(d) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* ignore */ } }
