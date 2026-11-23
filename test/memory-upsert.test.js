/**
 * 记忆入库单测（v1.1.0 · P1）：upsert 逻辑 + CLI 脚本 + 开关闸门。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { openMemoryStore } from '../lib/memory/store.js'
import { upsertMemories } from '../lib/memory/upsert.js'
import { PACKAGE_ROOT } from '../lib/paths.js'

const T0 = Date.parse('2026-11-22T00:00:00Z')
const SCRIPT = join(PACKAGE_ROOT, 'RUNTIME', 'scripts', 'memory-upsert.mjs')

const mem = (over = {}) => ({
  subject: '用户', predicate: 'open_id', object: 'ou_aaa',
  type: 'fact', source_ref: 'RAW/conversations/2026-11-22', quote: 'open_id 是 ou_aaa',
  confidence: 0.9, ...over,
})

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'upsert-'))
  return { dir, dbPath: join(dir, 'memory.db') }
}

test('upsert: 新事实 insert', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    const r = upsertMemories(s, [mem()], T0)
    assert.equal(r.inserted, 1)
    assert.equal(r.skipped, 0)
    assert.equal(r.rejected.length, 0)
    assert.equal(s.count(), 1)
    s.close()
  } finally { cleanup(dir) }
})

test('upsert: 同主谓同值 → skip（幂等去重）', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    upsertMemories(s, [mem()], T0)
    const r = upsertMemories(s, [mem()], T0 + 1000)
    assert.equal(r.skipped, 1)
    assert.equal(r.inserted, 0)
    assert.equal(s.count(), 1)   // 不重复入库
    s.close()
  } finally { cleanup(dir) }
})

test('upsert: 同主谓异值 → supersede（作废旧值留历史）', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    upsertMemories(s, [mem({ object: 'ou_old' })], T0)
    const r = upsertMemories(s, [mem({ object: 'ou_new', quote: '更正：ou_new' })], T0 + 1000)
    assert.equal(r.superseded, 1)
    assert.equal(s.count(), 2)                       // 历史保留
    assert.equal(s.list().length, 1)                 // 当前只有新值
    assert.equal(s.list()[0].object, 'ou_new')
    s.close()
  } finally { cleanup(dir) }
})

test('upsert: 缺 quote 拒收，且不中断整批', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    const r = upsertMemories(s, [
      mem({ quote: '' }),                       // 拒收
      mem({ predicate: '偏好', object: '冷硬叙事', type: 'preference', quote: '我喜欢冷硬' }),  // 正常
    ], T0)
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0].reason, /quote/)
    assert.equal(r.inserted, 1)                 // 第二条仍入库
    assert.equal(s.count(), 1)
    s.close()
  } finally { cleanup(dir) }
})

test('upsert: 低置信不拒收，映射低重要度', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    const r = upsertMemories(s, [mem({ confidence: 0.3, type: 'episode', predicate: '做过', object: '某事' })], T0)
    assert.equal(r.inserted, 1)
    assert.ok(s.list()[0].importance < 0.5)     // 低置信 → 低重要度
    s.close()
  } finally { cleanup(dir) }
})

/** 起一个临时 dataRoot，写好 flag 与输入，跑 CLI，回读报告 */
function runCli({ flag = true, items = [mem()], extraArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'upsert-cli-'))
  const stateDir = join(dir, 'RUNTIME', 'state')
  mkdirSync(stateDir, { recursive: true })
  if (flag) writeFileSync(join(stateDir, 'fact-memory.enabled'), 'on', 'utf8')
  const inputFile = join(dir, 'memories.json')
  writeFileSync(inputFile, JSON.stringify({ memories: items }), 'utf8')
  const reportFile = join(dir, 'report.json')
  const r = spawnSync(process.execPath, [
    SCRIPT, '--data-root', dir, '--input', inputFile, '--report', reportFile, ...extraArgs,
  ], { stdio: 'ignore' })
  let report = null
  if (existsSync(reportFile)) report = JSON.parse(readFileSync(reportFile, 'utf8'))
  return { dir, report, status: r.status, dbPath: join(dir, 'RUNTIME', 'memory', 'memory.db') }
}

test('cli: 启用时入库并报告（自动建库）', () => {
  const { dir, report, status, dbPath } = runCli({ items: [mem(), mem({ predicate: '偏好', object: '冷硬叙事', type: 'preference', quote: '喜欢冷硬' })] })
  try {
    assert.equal(status, 0)
    assert.equal(report.ok, true)
    assert.equal(report.inserted, 2)
    assert.ok(existsSync(dbPath), 'CLI 应自动建库')
    const s = openMemoryStore(dbPath, { readonly: true })
    assert.equal(s.count(), 2)
    s.close()
  } finally { cleanup(dir) }
})

test('cli: 开关关闭（无 flag）→ gated 不写库', () => {
  const { dir, report, status, dbPath } = runCli({ flag: false })
  try {
    assert.equal(status, 0)
    assert.equal(report.gated, true)
    assert.ok(!existsSync(dbPath), '关闭时不应建库')
  } finally { cleanup(dir) }
})

test('cli: dry-run 只校验不写库', () => {
  const { dir, report, status, dbPath } = runCli({ items: [mem(), mem({ quote: '' })], extraArgs: ['--dry-run'] })
  try {
    assert.equal(status, 0)
    assert.equal(report.dryRun, true)
    assert.equal(report.wouldReject.length, 1)
    assert.ok(!existsSync(dbPath), 'dry-run 不建库')
  } finally { cleanup(dir) }
})
// 尽力清理：Windows 下 SQLite WAL/SHM 关闭后可能短暂持锁，清理失败不应判测试失败
function cleanup(d) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* ignore */ } }
