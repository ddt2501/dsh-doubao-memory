/**
 * 事实记忆召回单测（v1.1.0 · P2）：混合排序 / 命中强化 / 无损降级 /
 * collectInputs 第 6 项 / decay CLI。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { openMemoryStore } from '../lib/memory/store.js'
import { recallFacts, rankFacts, factDesc, R_THRESHOLD } from '../lib/memory/recall.js'
import { collectInputs } from '../lib/snapshot/inputs.js'
import { PACKAGE_ROOT } from '../lib/paths.js'

const T0 = Date.parse('2026-11-22T00:00:00Z')
const DAY = 86_400_000
const DECAY_SCRIPT = join(PACKAGE_ROOT, 'RUNTIME', 'scripts', 'memory-decay.mjs')

const mem = (over = {}) => ({
  subject: '用户', predicate: 'open_id', object: 'ou_test_0001',
  type: 'fact', source_ref: 'RAW/conversations/2026-11-02', quote: 'open_id 是 ou_test…',
  confidence: 0.9, ...over,
})

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'factrecall-'))
  return { dir, dbPath: join(dir, 'memory.db') }
}

test('recall: factDesc 拼主谓宾', () => {
  assert.equal(factDesc({ subject: '用户', predicate: '偏好', object: '冷硬叙事' }), '用户 偏好 冷硬叙事')
})

test('recall: 强度（R）压过字面——与主题召回的 credit 同形', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    // A：高重要度钉住事实，与消息字面几乎不重合
    const a = s.insert(mem({ importance: 0.95 }), T0)
    // B：低置信 episode，200 天前，字面强重合
    const b = s.insert(mem({
      type: 'episode', predicate: '做过', object: '工作加班跑步', confidence: 0.3, quote: '加班跑步',
    }), T0 - 200 * DAY)
    const ranked = rankFacts(s.list({ status: 'active' }), '工作加班跑步', T0)
    assert.equal(ranked[0].id, a, '高 R 应压过强字面的低 R')
    assert.ok(ranked.find((f) => f.id === b).r < 0.01)
    s.close()
  } finally { cleanup(dir) }
})

test('recall: 无损降级——store 缺席 / 空库 ⇒ null', () => {
  assert.equal(recallFacts(null, '随便什么'), null)
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    assert.equal(recallFacts(s, '随便什么', { now: T0 }), null)
    s.close()
  } finally { cleanup(dir) }
})

test('recall: 命中返回描述串并写回强化', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    const id = s.insert(mem({ type: 'preference', predicate: '偏好', object: '冷硬叙事风格', quote: '我喜欢冷硬' }), T0)
    const before = s.get(id)
    const text = recallFacts(s, '聊聊冷硬叙事', { now: T0 + DAY })
    assert.ok(text.includes('冷硬叙事风格'))
    const after = s.get(id)
    assert.equal(after.recall_count, before.recall_count + 1)
    assert.ok(after.importance > before.importance)
    assert.ok(after.stability > before.stability)
    assert.equal(after.last_recalled, new Date(T0 + DAY).toISOString())
    s.close()
  } finally { cleanup(dir) }
})

test('recall: 无关且低 R 的事实不召回（不凭空塞）', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    s.insert(mem({
      type: 'episode', predicate: '做过', object: 'zzz', confidence: 0.3, quote: 'zzz',
    }), T0 - 300 * DAY)
    // 消息与 zzz 无字面重合（连空格都不给——charOverlap 按字符集算），R 极低 ⇒ 不召回
    const text = recallFacts(s, '完全不相关的消息', { now: T0 })
    assert.equal(text, null)
    s.close()
  } finally { cleanup(dir) }
})

test('recall: 高 R 事实即使字面不命中也放行（≥阈值）', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    s.insert(mem({ importance: 0.95, object: 'qqq' }), T0)
    const ranked = rankFacts(s.list({ status: 'active' }), '完全不相关', T0)
    assert.ok(ranked[0].r >= R_THRESHOLD)
    const text = recallFacts(s, '完全不相关', { now: T0 })
    assert.ok(text && text.includes('qqq'))
    s.close()
  } finally { cleanup(dir) }
})

test('inputs: 住相是纯人格映射——collectInputs 5 项，不含事实召回', () => {
  const { dir } = tmpDb()
  try {
    const paths = { rawDir: join(dir, 'RAW'), indexFile: join(dir, '07-INDEX.md') }
    const inputs = collectInputs({ message: '冷硬叙事', lastSnapshot: '', paths })
    // 住相材料来自抽象 WIKI/末那识，不是记忆检索 ⇒ 恰好 5 项，无 relevant_facts
    assert.equal(Object.keys(inputs).length, 5)
    assert.equal(inputs.relevant_facts, undefined)
    assert.ok('relevant_themes' in inputs)
  } finally { cleanup(dir) }
})

test('recall: recallFacts 作为独立检索通道可用（不依赖住相）', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    s.insert(mem({ type: 'preference', predicate: '偏好', object: '冷硬叙事风格', quote: '喜欢冷硬' }), T0)
    const text = recallFacts(s, '冷硬叙事', { now: T0 })
    assert.ok(text && text.includes('冷硬叙事风格'))
    s.close()
  } finally { cleanup(dir) }
})

test('recall: 字面匹配归一大小写（gitee ↔ Gitee）', () => {
  const { dir, dbPath } = tmpDb()
  try {
    const s = openMemoryStore(dbPath)
    s.insert(mem({ predicate: 'Gitee账号', object: 'test_account', quote: '账号 test_account' }), T0)
    s.insert(mem({ type: 'episode', predicate: '做过', object: 'zzzqqq', confidence: 0.3, quote: 'zzzqqq' }), T0 - 100 * DAY)
    const text = recallFacts(s, 'gitee推送用什么账号', { now: T0, reinforceHits: false })
    assert.ok(text && text.includes('test_account'), `应召回 Gitee 账号: ${text}`)
    s.close()
  } finally { cleanup(dir) }
})

test('decay cli: 无 flag → gated；有 flag → 推进老化不删行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decay-cli-'))
  try {
    const stateDir = join(dir, 'RUNTIME', 'state')
    mkdirSync(stateDir, { recursive: true })
    const dbPath = join(dir, 'RUNTIME', 'memory', 'memory.db')
    const report = join(dir, 'report.json')

    // 无 flag
    let r = spawnSync(process.execPath, [DECAY_SCRIPT, '--data-root', dir, '--report', report], { stdio: 'ignore' })
    assert.equal(r.status, 0)
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).gated, true)

    // 有 flag + 一条陈旧低置信 episode
    writeFileSync(join(stateDir, 'fact-memory.enabled'), 'on', 'utf8')
    const s = openMemoryStore(dbPath)
    s.insert(mem({ type: 'episode', predicate: '做过', object: '很久以前', confidence: 0.3, quote: '很久以前' }), T0 - 200 * DAY)
    s.close()
    r = spawnSync(process.execPath, [DECAY_SCRIPT, '--data-root', dir, '--report', report], { stdio: 'ignore' })
    assert.equal(r.status, 0)
    const out = JSON.parse(readFileSync(report, 'utf8'))
    assert.equal(out.ok, true)
    assert.equal(out.processed, 1)
    assert.equal(out.count, 1)   // 不物理删
    const s2 = openMemoryStore(dbPath, { readonly: true })
    assert.equal(s2.list({ includeSuperseded: true })[0].status, 'dormant')
    s2.close()
  } finally { cleanup(dir) }
})
// 尽力清理：Windows 下 SQLite WAL/SHM 关闭后可能短暂持锁，清理失败不应判测试失败
function cleanup(d) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* ignore */ } }
