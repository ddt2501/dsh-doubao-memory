#!/usr/bin/env node
/**
 * memory-export.mjs —— 记忆导出 CLI（v1.1.0 · P3）
 *
 * wiki phase 调它拿「固化记忆」候选，抽象成人格材料（断言/洞察/基因）。
 * 导出带 id：wiki 断言的 `来源` 写 `"memory#<id> · <source_ref>"` 形成出处链。
 *
 * 用法：
 *   node memory-export.mjs --data-root <DATA> [--out candidates.json]
 *   node memory-export.mjs --data-root <DATA> --mode all
 *   node memory-export.mjs --data-root <DATA> --min-recall 0 --min-age-days 0   # 手工早期抽象
 *
 * 固化判据（默认保守）：importance≥0.6 且 recall_count≥2 且 年龄≥7天。
 * 输出：{ ok, mode, count, memories: [ {id,subject,predicate,object,type,source_ref,quote,...} ] }
 * 开关闸门同 upsert/decay：无 state/fact-memory.enabled 标志 ⇒ gated。
 */

import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePaths } from '../../lib/paths.js'
import { openMemoryStore } from '../../lib/memory/store.js'
import { selectSolidified, exportRow } from '../../lib/memory/export.js'

function parseArgs(argv) {
  const out = {
    db: '', dataRoot: '', out: '', mode: 'solidified', limit: 50,
    minImportance: undefined, minRecall: undefined, minAgeDays: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i] ?? ''
    else if (a === '--data-root') out.dataRoot = argv[++i] ?? ''
    else if (a === '--out') out.out = argv[++i] ?? ''
    else if (a === '--mode') out.mode = argv[++i] ?? 'solidified'
    else if (a === '--limit') out.limit = Number(argv[++i]) || 50
    else if (a === '--min-importance') out.minImportance = Number(argv[++i])
    else if (a === '--min-recall') out.minRecall = Number(argv[++i])
    else if (a === '--min-age-days') out.minAgeDays = Number(argv[++i])
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const paths = resolvePaths({ dataRoot: args.dataRoot || undefined })
  const dbPath = args.db || paths.memoryDb
  const emit = (obj) => {
    const line = JSON.stringify(obj, null, 2)
    console.log(line)
    if (args.out) { try { writeFileSync(args.out, line, 'utf8') } catch { /* ignore */ } }
  }

  if (!args.db && !existsSync(join(paths.state, 'fact-memory.enabled'))) {
    emit({ ok: true, gated: true, reason: '事实记忆未启用', db: dbPath, memories: [] })
    return
  }

  let store
  try {
    store = openMemoryStore(dbPath, { readonly: true })
  } catch (err) {
    emit({ ok: false, db: dbPath, error: `库打开失败：${err?.message ?? err}`, memories: [] })
    process.exit(1)
  }
  try {
    const active = store.list({ status: 'active' })
    let picked
    if (args.mode === 'all') {
      picked = active
    } else {
      const opts = {}
      if (Number.isFinite(args.minImportance)) opts.minImportance = args.minImportance
      if (Number.isFinite(args.minRecall)) opts.minRecall = args.minRecall
      if (Number.isFinite(args.minAgeDays)) opts.minAgeDays = args.minAgeDays
      picked = selectSolidified(active, opts)
    }
    picked = picked.slice(0, args.limit)
    emit({ ok: true, mode: args.mode, db: dbPath, count: picked.length, memories: picked.map(exportRow) })
  } finally {
    try { store.close() } catch { /* ignore */ }
  }
}

main()