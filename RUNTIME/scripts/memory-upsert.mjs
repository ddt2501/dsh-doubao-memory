#!/usr/bin/env node
/**
 * memory-upsert.mjs —— ingest 抽取的记忆入库 CLI（v1.1.0 · P1）
 *
 * ingest phase 的 LLM 把昨日对话抽成结构化记忆 JSON，调本脚本写库。
 * 逻辑在 lib/memory/upsert.js（可离线测）；这里只做参数解析 + IO + 报告。
 *
 * 用法：
 *   node memory-upsert.mjs --data-root <DATA> --input memories.json
 *   node memory-upsert.mjs --db <memory.db> --input memories.json
 *   cat memories.json | node memory-upsert.mjs --data-root <DATA>
 *   node memory-upsert.mjs --data-root <DATA> --input memories.json --dry-run
 *
 * 输入 JSON：{ "memories": [ {subject,predicate,object,type,source_ref,quote,confidence?}, ... ] }
 *           或直接是数组 [ ... ]。
 *
 * 输出（stdout，JSON）：{ ok, db, inserted, superseded, skipped, rejected, total }
 * 退出码：0 = 跑完（含逐条拒收）；1 = 致命错（库打不开 / 输入不是合法 JSON）。
 *
 * ⚠️ 每条记忆必须带 source_ref + quote（原话出处）——缺则拒收，防编造。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePaths } from '../../lib/paths.js'
import { openMemoryStore } from '../../lib/memory/store.js'
import { upsertMemories } from '../../lib/memory/upsert.js'

function parseArgs(argv) {
  const out = { db: '', dataRoot: '', input: '', report: '', dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i] ?? ''
    else if (a === '--data-root') out.dataRoot = argv[++i] ?? ''
    else if (a === '--input') out.input = argv[++i] ?? ''
    else if (a === '--report') out.report = argv[++i] ?? ''
    else if (a === '--dry-run') out.dryRun = true
  }
  return out
}

function readInput(args) {
  const text = args.input ? readFileSync(args.input, 'utf8') : readFileSync(0, 'utf8')
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text   // 剥 BOM
  const doc = JSON.parse(stripped)
  const items = Array.isArray(doc) ? doc : (Array.isArray(doc?.memories) ? doc.memories : null)
  if (!items) throw new Error('输入须为数组，或 { "memories": [...] }')
  return items
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const paths = resolvePaths({ dataRoot: args.dataRoot || undefined })
  const dbPath = args.db || paths.memoryDb
  // 报告同时写 stdout 与 --report 文件（后者便于受限环境下回读，不依赖 piped stdio）
  const emit = (obj) => {
    const line = JSON.stringify(obj)
    console.log(line)
    if (args.report) { try { writeFileSync(args.report, line, 'utf8') } catch { /* ignore */ } }
  }

  // 开关闸门：非 --db 手动模式下，标志文件不在 ⇒ 事实记忆未启用 ⇒ 不写库。
  // （标志由插件挂载按 factMemory.enabled 写/删，见 lib/index.js。）
  if (!args.db && !existsSync(join(paths.state, 'fact-memory.enabled'))) {
    emit({ ok: true, gated: true, reason: '事实记忆未启用（factMemory.enabled=false）', db: dbPath })
    return
  }

  let items
  try {
    items = readInput(args)
  } catch (err) {
    emit({ ok: false, error: `输入读取失败：${err?.message ?? err}` })
    process.exit(1)
  }

  // 干跑：只校验必填字段，**不建库不写库**（纯校验，无副作用）
  if (args.dryRun) {
    const required = ['subject', 'predicate', 'object', 'type', 'source_ref', 'quote']
    const rejected = []
    items.forEach((m, i) => {
      const miss = required.filter((k) => !String(m?.[k] ?? '').trim())
      if (miss.length) rejected.push({ index: i, reason: `缺少必填字段 ${miss.join(',')}` })
    })
    emit({ ok: true, dryRun: true, db: dbPath, total: items.length, wouldReject: rejected })
    return
  }

  let store
  try {
    store = openMemoryStore(dbPath)
  } catch (err) {
    emit({ ok: false, db: dbPath, error: `库打开失败：${err?.message ?? err}` })
    process.exit(1)
  }

  try {
    const r = upsertMemories(store, items)
    emit({ ok: true, db: dbPath, total: items.length, ...r, count: store.count() })
  } finally {
    try { store.close() } catch { /* ignore */ }
  }
}

main()