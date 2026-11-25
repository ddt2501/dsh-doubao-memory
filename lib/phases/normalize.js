/**
 * Phase 收尾归一 —— **幂等的代码级保证**。
 *
 * ## 为什么必须有这一层（2026-11-18）
 *
 * 用户指出：允许补偿补跑，技术上**前提是幂等**——补跑不能把知识库写坏。
 *
 * 而 phase 的写入是 **LLM 在写**，靠 prompt 里说"别重复"只是**请求**，
 * 不是保证（这条教训 MEMORY 里记着：「提示词里的"禁止"是请求，词表校验才是保证」）。
 *
 * ⇒ phase 成功退出后，再跑一遍**纯代码**的归一：
 *
 * | 检查 | 判据 | 动作 |
 * |---|---|---|
 * | vault 断言 | **精确重复**（去首尾空白后逐字相同） | 删掉后出现的 |
 * | vault 断言 | 相似（规范化后相同，但措辞有别） | **只报告，不删** |
 * | 08-LOGS | 同一「时间戳 + phase」出现多段 | 只留第一段 |
 *
 * ## 为什么不删"相似"的
 *
 * 精确度优先：「同一条断言换个说法」和「两条不同的断言」机器分不清。
 * 删错一条 = 永久丢一条事实；留着一条冗余 = 只是啰嗦。
 * ⇒ **宁可不删。**（这是用户"可靠性和精确度大于持续性"的直接推论）
 *
 * ## 为什么 08-LOGS 只按时间戳去重
 *
 * 08-LOGS 的设计是 **append-only**（见文件头「不删历史」）。
 * 4:00 漏跑、6:00 补跑 ⇒ **两段不同时间戳，都该留**（它记录了"补跑"这件事）。
 * 真正该去的只有**同一个时间戳出现两次**（那是重试的 bug）。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log.js'

/** vault 的五个知识分类（只有这些有 frontmatter） */
const VAULT_DIRS = ['01-IDENTITY', '02-USER', '03-RELATIONSHIP', '04-INSIGHTS', '05-PROJECTS']

/**
 * 把 frontmatter 的 `断言:` 段做**精确去重**。
 *
 * @param {string} text - 整份文件内容
 * @returns {{text: string, removed: number}}
 */
export function dedupeAssertionList(text) {
  const m = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (!m) return { text, removed: 0 }
  const [whole, open, fm, close] = m
  const lines = fm.split(/\r?\n/)
  const start = lines.findIndex((l) => /^断言\s*:/.test(l))
  if (start < 0) return { text, removed: 0 }

  // 收集断言块：[start+1, end)
  let end = start + 1
  while (end < lines.length) {
    const l = lines[end]
    if (/^\s*-\s+/.test(l)) { end += 1; continue }
    if (!l.trim()) { end += 1; continue }      // 块内空行
    break                                       // 碰到下一个 key
  }

  const seen = new Set()
  const kept = []
  let removed = 0
  for (let i = start + 1; i < end; i++) {
    const l = lines[i]
    const item = l.replace(/^\s*-\s+/, '').trim()
    if (!item) { kept.push(l); continue }
    const key = item                          // **精确**：只去首尾空白
    if (seen.has(key)) { removed += 1; continue }
    seen.add(key)
    kept.push(l)
  }
  if (!removed) return { text, removed: 0 }

  const newFm = [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join('\n')
  return { text: `${open}${newFm}${close}${text.slice(m[0].length)}`, removed }
}

/**
 * 扫描 vault，对所有页的断言做精确去重。
 *
 * @param {object} paths
 * @param {string} [logPath]
 * @returns {{scanned: number, removed: number, files: string[]}}
 */
export function dedupeAssertions(paths, logPath = null) {
  const result = { scanned: 0, removed: 0, files: [] }
  for (const dir of VAULT_DIRS) {
    const abs = join(paths.vault, dir)
    if (!existsSync(abs)) continue
    for (const file of listMd(abs)) {
      let raw
      try {
        raw = readFileSync(file, 'utf8')
      } catch { continue }
      if (!raw.includes('断言')) continue
      result.scanned += 1
      const { text, removed } = dedupeAssertionList(raw)
      if (!removed) continue
      try {
        const tmp = `${file}.tmp`
        writeFileSync(tmp, text, 'utf8')
        renameSync(tmp, file)                 // 原子写：写到一半崩了不会留半截
        result.removed += removed
        result.files.push(`${dir}/${basename(file)}`)
      } catch (err) {
        if (logPath) log(logPath, 'error', { where: 'dedupe-assertions', file, message: String(err?.message ?? err) })
      }
    }
  }
  if (result.removed && logPath) log(logPath, 'normalize-assertions', result)
  return result
}

/**
 * 08-LOGS：同一个「时间戳 + phase」出现多段 ⇒ 只留第一段。
 *
 * append-only 的设计保持不变：不同时间戳的段落**全部保留**
 *（补跑本来就该留下痕迹）。
 *
 * @param {object} paths
 * @param {string} [logPath]
 * @returns {{removed: number, keys: string[]}}
 */
export function dedupeLogs(paths, logPath = null) {
  const file = join(paths.vault, '08-LOGS.md')
  if (!existsSync(file)) return { removed: 0, keys: [] }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { removed: 0, keys: [] }
  }

  // 段落分隔：二级标题「## [YYYY-MM-DD HH:MM] <phase>」
  const re = /^##\s*\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?::\d{2})?\]\s*(\S+)\s*$/gm
  const marks = []
  let m
  while ((m = re.exec(text)) !== null) {
    marks.push({ index: m.index, key: `${m[1]}|${m[2]}`, line: m[0] })
  }
  if (marks.length < 2) return { removed: 0, keys: [] }

  // ── 判定：**从前往后**，保留第一次出现的那段 ────────────────
  // ⚠️ 2026-11-18 踩：第一版是从后往前收集，结果保留了**后一段**
  //    （"同一时间戳重复"那段），把第一段的真实内容删了。
  const seen = new Set()
  const toDrop = []
  for (const mk of marks) {
    if (seen.has(mk.key)) toDrop.push(mk)
    else seen.add(mk.key)
  }
  if (!toDrop.length) return { removed: 0, keys: [] }

  // 每段的范围：自己标题行 → 下一个标题行（或文件末）
  const ranges = marks.map((mk, i) => ({
    ...mk,
    end: i + 1 < marks.length ? marks[i + 1].index : text.length,
  }))
  let out = text
  for (const drop of toDrop.sort((a, b) => b.index - a.index)) {
    const r = ranges.find((x) => x.index === drop.index && x.key === drop.key)
    if (!r) continue
    out = out.slice(0, r.index) + out.slice(r.end)
  }

  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, out, 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    if (logPath) log(logPath, 'error', { where: 'dedupe-logs', message: String(err?.message ?? err) })
    return { removed: 0, keys: [] }
  }
  const keys = toDrop.map((d) => d.key)
  if (logPath) log(logPath, 'normalize-logs', { removed: keys.length, keys })
  return { removed: keys.length, keys }
}

/**
 * phase 成功后的统一收尾。
 *
 * @param {object} paths
 * @param {string} [logPath]
 * @returns {{assertions: object, logs: object}}
 */
export function normalizeAfterPhase(paths, logPath = null) {
  let assertions = { scanned: 0, removed: 0, files: [] }
  let logs = { removed: 0, keys: [] }
  try {
    assertions = dedupeAssertions(paths, logPath)
  } catch (err) {
    if (logPath) log(logPath, 'error', { where: 'normalize-assertions-fatal', message: String(err?.message ?? err) })
  }
  try {
    logs = dedupeLogs(paths, logPath)
  } catch (err) {
    if (logPath) log(logPath, 'error', { where: 'normalize-logs-fatal', message: String(err?.message ?? err) })
  }
  return { assertions, logs }
}

/** 列目录下所有 .md（不递归，vault 分类是扁平的） */
function listMd(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** 取文件名（不引 path.basename 的额外分支） */
function basename(p) {
  return String(p).split(/[\\/]/).pop() ?? p
}
