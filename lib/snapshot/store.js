/**
 * 住相 metrics 存储 —— 移植 `RUNTIME/manas-system/src/snapshot_store.py`。
 *
 * 设计原则（Python 版的原话，保留）：**不持久化住相文本**（隐私 + 主观感知），
 * 只存 metrics：timestamp / mode / tokens / generation_time / retry_count。
 * JSONL 追加，保留 30 天。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export class SnapshotStore {
  constructor(metricsDir) {
    this.dir = metricsDir
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    } catch { /* ignore */ }
  }

  pathFor(date) {
    return join(this.dir, `${date}.jsonl`)
  }

  record(metric) {
    try {
      const date = metric.timestamp.slice(0, 10)
      const path = this.pathFor(date)
      appendFileSync(path, `${JSON.stringify(metric)}\n`, 'utf8')
      return path
    } catch {
      return null
    }
  }

  readDay(date) {
    const path = this.pathFor(date)
    if (!existsSync(path)) return []
    const out = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* corrupt line */ }
    }
    return out
  }

  stats(days = 7) {
    const out = []
    const now = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      out.push(...this.readDay(key))
    }
    if (!out.length) return { days, total: 0 }
    const tokens = out.map((m) => m.tokens_estimate ?? 0).sort((a, b) => a - b)
    const modes = {}
    for (const m of out) modes[m.mode] = (modes[m.mode] ?? 0) + 1
    const fallbacks = out.filter((m) => m.fallback_used).length
    const times = out.map((m) => m.generation_time_ms ?? 0).filter((t) => t > 0)
    return {
      days,
      total: out.length,
      p50_tokens: tokens[Math.floor(tokens.length * 0.5)] ?? 0,
      p99_tokens: tokens[Math.min(tokens.length - 1, Math.floor(tokens.length * 0.99))] ?? 0,
      modes,
      fallback_rate: Math.round((fallbacks / out.length) * 10000) / 10000,
      avg_generation_ms: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
    }
  }

  rotate(keepDays = 30) {
    const cutoff = new Date(Date.now() - keepDays * 86400000)
    const key = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
    let count = 0
    try {
      for (const name of readdirSync(this.dir)) {
        const date = name.replace('.jsonl', '')
        if (date < key) { unlinkSync(join(this.dir, name)); count++ }
      }
    } catch { /* ignore */ }
    return count
  }
}
