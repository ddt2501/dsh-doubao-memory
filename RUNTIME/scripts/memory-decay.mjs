#!/usr/bin/env node
/**
 * memory-decay.mjs —— 事实记忆周期老化 CLI（v1.1.0 · P2）
 *
 * lint phase 调它跑衰减批处理：对非 archived 记忆推进 forget_stage/status +
 * 折半 recall_count（importance 基底不动，衰减体现在召回时的 R 计算里）。
 * **不物理删除**——最远推到 archived。
 *
 * 用法：
 *   node memory-decay.mjs --data-root <DATA> [--report <file>]
 *   node memory-decay.mjs --db <memory.db>
 *
 * 输出（stdout / --report）：{ ok, db, processed, count }
 * 开关闸门同 upsert：无 state/fact-memory.enabled 标志 ⇒ gated 不跑。
 */

import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePaths } from '../../lib/paths.js'
import { openMemoryStore } from '../../lib/memory/store.js'

function parseArgs(argv) {
  const out = { db: '', dataRoot: '', report: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i] ?? ''
    else if (a === '--data-root') out.dataRoot = argv[++i] ?? ''
    else if (a === '--report') out.report = argv[++i] ?? ''
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const paths = resolvePaths({ dataRoot: args.dataRoot || undefined })
  const dbPath = args.db || paths.memoryDb
  const emit = (obj) => {
    const line = JSON.stringify(obj)
    console.log(line)
    if (args.report) { try { writeFileSync(args.report, line, 'utf8') } catch { /* ignore */ } }
  }

  if (!args.db && !existsSync(join(paths.state, 'fact-memory.enabled'))) {
    emit({ ok: true, gated: true, reason: '事实记忆未启用', db: dbPath })
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
    const processed = store.decayBatch()
    emit({ ok: true, db: dbPath, processed, count: store.count() })
  } finally {
    try { store.close() } catch { /* ignore */ }
  }
}

main()