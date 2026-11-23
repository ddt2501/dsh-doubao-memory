/**
 * Phase 审计 —— 每次运行都留证据（用户明确要求"可审计"）。
 *
 * ## 三层审计
 *
 * | 层 | 在哪 | 看什么 |
 * |---|---|---|
 * | 实时 | DSH 的 Jobs 面板 | 正在跑 / 成功 / 失败（job 状态 + 输出环） |
 * | 历史 | `RUNTIME/state/phase-runs.json` | 时间/耗时/退出码/错误（可 git diff） |
 * | 全量 | `RUNTIME/state/phase-logs/<phase>-<date>.ndjson` | 完整输出流，逐行复盘 |
 *
 * ## 为什么退出码也要记
 *
 * "跑了"和"跑成了"是两件事。原来用会话跑 phase，
 * 界面上只能看到"有这条会话"，看不到它到底成功没有
 * ⇒ **失败了也像成功**（2026-11-14 那句编造的话就是这么混过去的）。
 * ⇒ 退出码 + 耗时 + 输出尾部，三样一起记才叫可审计。
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log.js'

const RUNS_FILE = 'phase-runs.json'
/** 历史保留条数（太多会让 git diff 难看） */
const MAX_RUNS = 200

/**
 * 记一次运行。
 *
 * @param {string} stateDir - RUNTIME/state
 * @param {object} run - 运行记录
 * @param {string} [logPath]
 */
export function recordRun(stateDir, run, logPath = null) {
  try {
    const file = join(stateDir, RUNS_FILE)
    let all = []
    try {
      if (existsSync(file)) {
        let raw = readFileSync(file, 'utf8')
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)   // BOM 会让 JSON.parse 抛
        const parsed = JSON.parse(raw)
        all = Array.isArray(parsed?.runs) ? parsed.runs : []
      }
    } catch { all = [] }

    all.unshift(run)
    const trimmed = all.slice(0, MAX_RUNS)

    // 原子写（tmp + rename）：写到一半崩了不会留下半截 JSON
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), runs: trimmed }, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    // 审计写失败不该让 phase 判成失败 ⇒ 只记日志
    if (logPath) log(logPath, 'error', { where: 'audit-record', message: String(err?.message ?? err) })
  }
}

/**
 * 读运行历史（给工具/诊断用）。
 *
 * @param {string} stateDir
 * @param {number} [limit]
 * @returns {object[]}
 */
export function readRuns(stateDir, limit = 20) {
  const file = join(stateDir, RUNS_FILE)
  try {
    if (!existsSync(file)) return []
    let raw = readFileSync(file, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    const parsed = JSON.parse(raw)
    const runs = Array.isArray(parsed?.runs) ? parsed.runs : []
    return runs.slice(0, limit)
  } catch {
    return []
  }
}

/**
 * 汇总：每个 phase 最近一次的结果。
 *
 * @param {string} stateDir
 * @returns {Record<string, object>}
 */
export function lastRunByPhase(stateDir) {
  const out = {}
  for (const run of readRuns(stateDir, MAX_RUNS)) {
    if (run?.phase && !out[run.phase]) out[run.phase] = run
  }
  return out
}
