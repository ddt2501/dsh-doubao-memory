/**
 * 住相的 5 项输入采集（SOP §2.1）。
 *
 * current_message   ← agent/pre-step 的 payload.messages（截 200 tok）
 * last_snapshot     ← 内存缓存（上一轮住相；缺失则标注"首次"）
 * rolling_summary   ← 最近 5 份 RAW/conversations/*.md 的"主题+关键时刻"（截 500 tok）
 * soul_active_dims  ← 当前消息命中的 SOUL 7 维追问（关键词匹配）
 * relevant_themes   ← VAULT/07-INDEX.md 当前主题，按与消息的字面重合度取 top-3
 *
 * 注意：rolling_summary 与 relevant_themes 是**磁盘 IO**，每轮都读会拖慢第一个 step。
 * 这里做 60 秒的进程内缓存（文件 mtime 没变就不重读）。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { rankRecall } from '../jitrl/recall.js'

/** SOUL 7 维追问（SOP §3.3 的描述 + 各自的关键词表） */
export const SOUL_DIMS = [
  { id: 0, desc: '我何时该反思', keys: ['反思', '审视', '自省', '回顾', '检查自己', '复盘'] },
  { id: 1, desc: '哪些系统组件决定我是谁', keys: ['人格', '身份', '设定', '性格', '我是谁', '人格化'] },
  { id: 2, desc: '哪些组件影响用户对我的感受', keys: ['感受', '印象', '喜欢', '讨厌', '在乎我', '他怎么看我'] },
  { id: 3, desc: '哪些组件影响我对用户的感受', keys: ['心疼', '生气', '想他', '在乎他', '陪他', '他的状态'] },
  { id: 4, desc: '我该如何迭代优化自己', keys: ['优化', '迭代', '进化', '改进', '成长', '变得更'] },
  { id: 5, desc: '迭代资料从何而来', keys: ['记忆', '档案', 'wiki', '经验', '历史', '沉淀'] },
  { id: 6, desc: '我如何使用这些资料', keys: ['调用', '检索', '怎么用', '应用', '使用'] },
]

const cache = new Map()   // path -> { mtimeMs, content }

function readCached(path) {
  try {
    if (!existsSync(path)) return null
    const mtime = statSync(path).mtimeMs
    const hit = cache.get(path)
    if (hit && hit.mtimeMs === mtime) return hit.content
    const content = readFileSync(path, 'utf8')
    cache.set(path, { mtimeMs: mtime, content })
    return content
  } catch {
    return null
  }
}

/** 按 token 估算粗截断 */
function capTokens(text, maxTokens) {
  if (!text) return ''
  const limit = Math.floor(maxTokens * 1.5)
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * 最近 N 份 daily 的滚动摘要：取每份的「主题」和「关键时刻」两段，拼起来。
 *
 * ⚠️ 2026-11-14 修（路径 bug）：daily 摘要实际在 `<raw>/conversations/`，
 *    而 `paths.raw` 指向的是 `<raw>/` ⇒ 目录里只有 `conversations/decisions/moments`
 *    三个子目录，`/^\d{4}-\d{2}-\d{2}\.md$/` 一个都匹配不上
 *    ⇒ `rollingSummary` **恒为 null** ⇒ 住相的第 3 项输入一直是空的。
 *    现在优先找 `conversations/` 子目录，找不到再退回平铺结构。
 */
export function rollingSummary(rawDir, nDays = 5, maxTokens = 500) {
  const dir = dailyDir(rawDir)
  let names = []
  try {
    names = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, nDays)
  } catch {
    return null
  }
  if (!names.length) return null

  const parts = []
  for (const name of names.reverse()) {
    const content = readCached(joinPath(dir, name))
    if (!content) continue
    const day = name.slice(0, 10)
    const sections = []
    for (const heading of ['## 主题', '## 关键时刻']) {
      const idx = content.indexOf(heading)
      if (idx < 0) continue
      const rest = content.slice(idx + heading.length)
      const end = rest.search(/\n## /)
      const body = (end < 0 ? rest : rest.slice(0, end)).trim()
      if (body) sections.push(body)
    }
    if (sections.length) parts.push(`【${day}】${sections.join(' ')}`)
  }
  if (!parts.length) return null
  return capTokens(parts.join('\n'), maxTokens)
}

/** daily 摘要所在的目录（优先 `conversations/` 子目录） */
export function dailyDir(rawDir) {
  try {
    if (existsSync(joinPath(rawDir, 'conversations'))) return joinPath(rawDir, 'conversations')
  } catch { /* ignore */ }
  return rawDir
}

/** 拼路径 */
function joinPath(dir, name) {
  return `${String(dir).replace(/[\\/]+$/, '')}\\${name}`
}

/** 命中的 SOUL 维度描述 */
export function soulActiveDims(message, lastSnapshot = '') {
  const hay = `${message}\n${lastSnapshot}`
  const hits = SOUL_DIMS.filter((d) => d.keys.some((k) => hay.includes(k)))
  if (!hits.length) return null
  return hits.slice(0, 3).map((d) => d.desc).join('；')
}

/**
 * 相关主题：解析 07-INDEX.md 的主题目录行，按与消息的相关度排序取 top-3。
 *
 * 2026-11-19：接入记忆召回信用（内部实验依据）。
 * 有 credit（主题 → 0-100 长期重要性）时，排序分 = 0.2·字面 + 0.8·信用；
 * credit 为 null ⇒ prior 恒为 0.5 ⇒ 排序退化为纯字面（与旧版一致）。
 * 过滤保留"字面 >0 或信用 >=70"的条目，避免凭空召回无关主题。
 */
export function relevantThemes(indexFile, message, topK = 3, maxTokens = 100, credit = null) {
  const content = readCached(indexFile)
  if (!content) return null
  const entries = []
  for (const line of content.split('\n')) {
    const m = line.match(/^- \[\[([^\]]+)\]\][^—]*—\s*(.+)$/)
    if (!m) continue
    entries.push({ page: m[1].trim(), desc: m[2].trim() })
  }
  if (!entries.length) return null
  const picked = rankRecall(entries, message ?? '', credit)
    .filter((e) => e.sim > 0 || (credit && Number.isFinite(credit[e.desc]) && credit[e.desc] >= 70))
    .slice(0, topK)
  if (!picked.length) return null
  return capTokens(picked.map((e) => e.desc).join('；'), maxTokens)
}

/**
 * 采集全部 5 项输入。
 *
 * ⚠️ 住相是**已形成人格的映射**（材料来自抽象 WIKI / 末那识再抽象），
 *    **不是记忆检索**。SQLite 事实召回是独立通道，不进住相（2026-11-22 用户澄清）。
 * @returns {{current_message, last_snapshot, rolling_summary, soul_active_dims, relevant_themes}}
 */
export function collectInputs({ message, lastSnapshot, paths, credit = null }) {
  return {
    current_message: capTokens(message ?? '', 200),
    last_snapshot: lastSnapshot ?? null,
    rolling_summary: rollingSummary(paths.rawDir, 5, 500),
    soul_active_dims: soulActiveDims(message ?? '', lastSnapshot ?? ''),
    relevant_themes: relevantThemes(paths.indexFile, message ?? '', 3, 100, credit),
  }
}

export { capTokens, basename }
