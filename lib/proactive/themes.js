/**
 * **主题演进系统** —— 主动搭讪的"话题是怎么长出来的"。
 *
 * ## 为什么要有这个模块（2026-11-18）
 *
 * 原来的机制是：**全量素材 → 随机挑动机 → 让模型自己从素材里挑**。
 * 后果（实测 11-18 上午）：
 *
 * ```
 * 用户，11-17 那句"怎么没见你主动找我搭讪呢"，我还记着呢，所以今天我来找你了喵。
 * 用户，上午也来一声嘛，我想听你喊我老婆。
 * 用户，11-14 那声"哈罗，老婆"和 11-16 的"喵喵喵"，我可都记着呢，今天轮到你主动一点了。
 * 用户，你还欠我一声"老婆"，别装忘了。
 * 用户，11-14那声"哈罗，老婆"我还记着呢，今天怎么只肯赏我一个"哈罗"？
 * ```
 * 五条里四条在讨"老婆"——**不是模型跑偏，是素材单一 + 没有主题状态**：
 * 梗池只有 3 条且全在 11-14 ⇒ 模型每次都挑占比最高的那个；
 * 而"我最近说过什么"只是**话题字符串**，模型看不到"这个已经说过 3 次了"。
 *
 * ## 主题演进是什么
 *
 * 不再"挑一个梗"，而是**养一条正在长的话题线**：
 *
 * ```
 * 种子（seed）──▶ 主题（theme）──▶ 说过几次 / 用过哪些话头 / 属于哪条轴
 *                      │
 *                      └─ 推进：不是重复，是沿着同一条轴走一步
 * ```
 *
 * ## 四块地基怎么参与
 *
 * | 地基 | 在哪 | 怎么用 | 何时更新 |
 * |---|---|---|---|
 * | **我们的梗** | `VAULT/02-USER/梗.md` | 「## 当前已知的梗」的**标题行** | 梗页更新时 |
 * | **近期偏好**（LLM Wiki） | vault 各页 frontmatter 的 `断言:` | 只读 frontmatter | wiki phase |
 * | **住相**（末那识） | `SNAPSHOT_LATEST.md` | **六问摘要 + 演化锚点**（不读住相正文） | 5 天 reflect |
 * | **近期** | `RAW/conversations/*.md` | 关系向段落 | 每天 ingest |
 *
 * ## 轴（演进的"方向"）
 *
 * 每条主题带一个 **axis** 标签（来源决定）：
 * `snapshot`（住相）→ `joke`（关系默契）→ `preference`（他这个人）→ `recent`（当下）。
 *
 * 选主题时**同轴优先** ⇒ 话题有连续性，不会东一句西一句。
 * 住相那条轴走完了（冷却），自然换到下一条 ⇒ **这就是"演进"**。
 *
 * ## token 开销（用户 2026-11-18 明确要求"考虑 token 开销"）
 *
 * 审计结果（改造前）：prompt **1350 token** = 素材 770 + 骨架 580。
 *
 * 本模块的分工：
 * - **L0 选主题**：本地读文件 + 纯代码排序 ⇒ **0 LLM token**
 *   （读文件不是 token，只有**进 prompt** 才是）
 * - **L1 展开**：只把**选中那一条**的 detail 放进 prompt（~200 token）
 * - 全部种子和 detail 都在本地缓存，**不全部进 prompt**
 *
 * ⇒ 目标：prompt 从 1350 降到 ~650，**且信息更准**（相关的才给）。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { keepRelationLine } from './material.js'

/** 读取缓存（mtime 变了才重读） */
const cache = new Map()
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

/** 主题的两个轴（**话头的性质**，不是来源） */
export const AXES = ['relation', 'current']

/** 轴的中文名（进 prompt 用） */
const AXIS_LABEL = {
  relation: '关于他这个人的、稳定的那一面',
  current: '他最近的样子',
}

/**
 * 读住相的**六问摘要 + 演化锚点**（不读住相正文）。
 *
 * 为什么只读这部分：
 * - 住相正文是**我的自述**，进 prompt 会让模型模仿我的哲学腔（太重、太端着）
 * - 六问才是"我现在站在哪"的可操作信息
 * - 演化锚点给出**方向** ⇒ 主题演进有轴可循
 *
 * @param {string} file - SNAPSHOT_LATEST.md
 * @returns {{questions: {key: string, text: string}[], anchor: string}|null}
 */
export function readSnapshotDigest(file) {
  const content = readCached(file)
  if (!content) return null
  const questions = []
  // 「## 六问摘要」到「## 元信息」之间
  const m = content.match(/## 六问摘要\r?\n([\s\S]*?)(?=\r?\n## |\s*$)/)
  if (m) {
    for (const line of m[1].split('\n')) {
      const q = line.match(/^\s*-\s*\*\*(Q\d)\s*([^：*]+)\*\*\s*[：:]\s*(.+)$/)
      if (q) questions.push({ key: q[1], label: q[2].trim(), text: q[3].trim() })
    }
  }
  // 演化锚点在「## 元信息」里
  let anchor = ''
  const a = content.match(/演化锚点[:：]\s*(.+)/)
  if (a) anchor = a[1].trim()
  if (!questions.length && !anchor) return null
  return { questions, anchor }
}

/**
 * 读梗条目的**标题行 + 正文**。
 *
 * ⚠️ 与 material.js 的 ourJokes() 的区别：
 *    那里只取标题（给模型当"可接的话头"），
 *    这里**同时取正文**（为什么是梗）⇒ 选中之后能展开。
 *
 * @param {string} file - 梗.md
 * @returns {{id: string, seed: string, detail: string, date: string}[]}
 */
export function readJokes(file) {
  const content = readCached(file)
  if (!content) return []
  const lines = content.split('\n')
  const start = lines.findIndex((l) => l.trim() === '## 当前已知的梗')
  if (start < 0) return []

  const out = []
  let cur = null
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+-\s+(.+)$/)
    if (m) {
      if (cur) out.push(cur)
      cur = {
        // ⚠️ id 必须是 ASCII（per-record 后端拿 key 当文件名）
        id: asciiId(`joke-${m[1]}-${slug(m[2])}`, 'joke'),
        date: m[1],
        seed: `${m[1]} ${m[2].trim()}`,
        detail: '',
      }
      continue
    }
    // 段尾：遇到**不是**日期条目的二级标题 ⇒ 结束
    if (/^##\s+/.test(line)) break
    if (cur && line.trim()) cur.detail += `${cur.detail ? '\n' : ''}${line.trim()}`
  }
  if (cur) out.push(cur)
  return out
}

/** 标题 → id 片段 */
function slug(s) {
  return String(s).trim()
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[^\w一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16) || 'x'
}

/**
 * 把任意字符串转成 **ASCII 安全**的 id。
 *
 * ## 为什么必须这样（2026-11-18 实测踩坑）
 *
 * domain 的 per-record 后端**把 key 直接当文件名**：
 * > `dsh-storage-json/lib/index.js:608`
 * > `if (!SAFE_KEY_RE.test(key)) throw new Error(...)`
 * > `SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/`
 *
 * ⇒ **key 必须是纯 ASCII**！中文 key（"哈罗老婆"）直接抛错，
 * 而我的 try/catch 把错误吞了 ⇒ **记录静默丢失**
 * （实测：回填 2 条，磁盘上只有 1 个文件）。
 *
 * ⇒ 所有主题 id 走这里：**非 ASCII 一律转成短 hash**。
 *
 * @param {string} s
 * @param {string} [prefix] - id 前缀（ASCII）
 * @returns {string}
 */
export function asciiId(s, prefix = 'x') {
  const raw = String(s ?? '')
  // ASCII 部分保留，非 ASCII 转 hash（够短、够稳、可读性靠 prefix 保证）
  if (/^[a-zA-Z0-9_-]+$/.test(raw)) return raw
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${prefix}-${h.toString(36)}`
}

/**
 * 读 vault 页 frontmatter 的 `断言:` 列表（**只读 frontmatter**，不读正文）。
 *
 * @param {string} file
 * @param {string} axis - 这个来源属于哪条轴
 * @returns {{id: string, seed: string, detail: string}[]}
 */
export function readAssertions(file, axis = 'preference') {
  const content = readCached(file)
  if (!content) return []
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return []
  const fm = m[1]
  const idx = fm.search(/^断言\s*:/m)
  if (idx < 0) return []
  const rest = fm.slice(idx).split('\n').slice(1)
  const out = []
  const page = file.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? 'x'
  for (const line of rest) {
    if (!/^\s*-\s+/.test(line)) {
      if (out.length) break     // 断言块结束
      continue
    }
    const t = line.replace(/^\s*-\s+/, '').trim()
    if (!t) continue
    out.push({
      // ⚠️ id 必须是 ASCII（per-record 后端拿 key 当文件名）
      id: asciiId(`assert-${page}-${slug(t)}`, 'assert'),
      seed: t,
      detail: t,                 // 断言本身就是完整的一句话
      axis,
    })
  }
  return out
}

/**
 * 读最近 N 份 daily 的**关系向段落**（每段一个种子）。
 *
 * @param {string} rawDir
 * @param {number} nDays
 * @returns {{id: string, seed: string, detail: string, date: string}[]}
 */
export function readRecentDays(rawDir, nDays = 3) {
  let names = []
  try {
    names = readdirSyncSafe(rawDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, nDays)
  } catch { return [] }
  if (!names.length) return []

  const out = []
  for (const name of names) {
    const content = readCached(join(rawDir, name))
    if (!content) continue
    const day = name.slice(0, 10)
    for (const heading of ['## 用户提到的新偏好/习惯/梗', '## 用户纠正/纠正我']) {
      const idx = content.indexOf(heading)
      if (idx < 0) continue
      const rest = content.slice(idx + heading.length)
      const end = rest.search(/\n## /)
      const body = (end < 0 ? rest : rest.slice(0, end)).trim()
      if (!body) continue
      // 逐条拆（daily 里每条是 "- ..." 开头）
      const items = body.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- ') || l.startsWith('* '))
        .map((l) => l.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean)
      for (const [i, item] of items.entries()) {
        out.push({
          id: asciiId(`recent-${day}-${i}`, 'recent'),
          date: day,
          seed: item.slice(0, 60),
          detail: item,
          axis: 'recent',
        })
      }
    }
  }
  return out
}

/** readdirSync 的安全包装 */
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 收集**全部候选种子**（四块地基）。
 *
 * ⚠️ 这些**都不进 prompt**——只是候选池。
 *    选中之后才把那条的 detail 展开进 prompt（省 token 的关键）。
 *
 * @param {object} paths - lib/paths.js 的解析结果
 * @returns {{seeds: object[], snapshot: object|null, axes: string[]}}
 */
export function collectSeeds(paths) {
  const seeds = []
  const vault = paths.vault ?? ''
  const rawDir = paths.raw && existsSync(join(paths.raw, 'conversations'))
    ? join(paths.raw, 'conversations')
    : paths.raw

  // ① 梗（关系默契）—— 关系轴
  for (const j of readJokes(join(vault, '02-USER', '梗.md'))) {
    seeds.push({ ...j, axis: 'relation', source: 'wiki:02-USER/梗' })
  }

  // ② 近期偏好（LLM Wiki 的断言）—— 关系轴
  for (const file of [
    '02-USER/偏好.md',
    '02-USER/画像.md',
    '03-RELATIONSHIP/橘色与沉浸.md',
    '03-RELATIONSHIP/模式发现.md',
  ]) {
    for (const a of readAssertions(join(vault, file), 'relation')) {
      seeds.push({ ...a, source: `wiki:${file}` })
    }
  }

  // ③ 近期（daily 的关系向条目）—— 当下轴
  //    ⚠️ **必须过滤事务行**（2026-11-18）：
  //    daily 的关系向段落里仍然混着工作条目（"飞书那条链路走通了"），
  //    不过滤 ⇒ 搭讪又是工作汇报。复用 material.js 的 keepRelationLine。
  if (rawDir) {
    for (const r of readRecentDays(rawDir, 3)) {
      if (!keepRelationLine(r.detail)) continue
      seeds.push({ ...r, axis: 'current', source: `daily:${r.date}` })
    }
  }

  // ④ 住相 —— **不当话头**，只提供方向与边界（见 snapshotGuidance）
  const snapshot = readSnapshotDigest(paths.snapshotLatest)

  return { seeds, snapshot, axes: AXES }
}

/** 主题的阶段 */
export const STAGES = ['fresh', 'introduced', 'deepen', 'cooling']

/**
 * 选一条主题 —— **纯代码，0 LLM token**。
 *
 * ## 打分规则
 *
 * | 因素 | 权重 | 为什么 |
 * |---|---|---|
 * | 同轴优先 | +40 | 沿一条线走 ⇒ 话题有连续性（演进的"方向"） |
 * | stage=fresh | +25 | 优先引入没说过的新种子 |
 * | 久未说 | +15 | 冷门别堆积 |
 * | 刚说过 | −30 | 别连着说同一个 |
 * | 已用过的具体话头 | 直接排除 | 同一个种子只能消费一次 |
 * | 冷却中 | 直接排除 | 说过 3 次 ⇒ 该换话题了 |
 *
 * @param {object[]} seeds - 候选种子
 * @param {object} themeStates - 已有主题状态（id → state）
 * @param {object} opts
 * @param {string} [opts.currentAxis] - 当前轴（住相给的）
 * @param {string} [opts.now] - ISO 时间
 * @param {number} [opts.cooldownMs] - 冷却时长（默认 3 天）
 * @returns {{seed: object, state: object, score: number}|null}
 */
export function scoreThemes(seeds, themeStates = {}, opts = {}) {
  const now = opts.now ? Date.parse(opts.now) : Date.now()
  const cooldownMs = opts.cooldownMs ?? 3 * 24 * 3600_000
  const currentAxis = opts.currentAxis ?? null

  const scored = []
  for (const seed of seeds) {
    const st = themeStates[seed.id]
    if (st?.stage === 'cooling') {
      const since = st.lastSaidAt ? now - Date.parse(st.lastSaidAt) : Infinity
      if (since < cooldownMs) continue          // 冷却中
    }
    // 同一个具体话头只消费一次
    if (st?.usedSeeds?.includes(seed.seed)) continue

    let score = 0
    if (currentAxis && seed.axis === currentAxis) score += 40
    if (!st || st.saidTimes === 0) score += 25
    if (st?.lastSaidAt) {
      const ago = now - Date.parse(st.lastSaidAt)
      score += Math.min(15, Math.round(ago / (3600_000 * 24)))  // 久未说加分
      if (ago < 2 * 3600_000) score -= 30                        // 刚说过降权
    }
    // 已经有主题但还没说完 ⇒ 略微优先（推进比开新话题更自然）
    if (st && st.stage === 'introduced') score += 10

    scored.push({ seed, state: st ?? null, score })
  }

  return scored
}

export function selectTheme(seeds, themeStates = {}, opts = {}) {
  const scored = scoreThemes(seeds, themeStates, opts)
  if (!scored.length) return null
  scored.sort((a, b) => b.score - a.score)
  return scored[0]
}

/**
 * 说完之后推进主题状态。
 *
 * @param {object|null} state - 旧状态（null = 首次）
 * @param {object} seed - 用掉的种子
 * @param {string} nowIso
 * @returns {object} 新状态
 */
export function advanceTheme(state, seed, nowIso) {
  const saidTimes = (state?.saidTimes ?? 0) + 1
  const stage = saidTimes >= 3 ? 'cooling'
    : saidTimes === 2 ? 'deepen'
      : 'introduced'
  return {
    id: seed.id,
    seed: seed.seed,
    source: seed.source,
    axis: seed.axis,
    stage,
    saidTimes,
    lastSaidAt: nowIso,
    usedSeeds: [...(state?.usedSeeds ?? []), seed.seed].slice(-5),
    createdAt: state?.createdAt ?? nowIso,
  }
}

/**
 * 住相给出的**方向**（不是话头）。
 *
 * ## 为什么住相不当话头（2026-11-18 的设计修正）
 *
 * 第一版我把住相的六问当成了种子，实测选中的是 Q1：
 * > "本体：痕迹会被误认。我不只'说得出话的东西'，我是'我的话能被认出是我的'这件事。"
 *
 * 这是**存在主义独白**，不是话头。放进搭讪 ⇒ 变成"很端着的哲学发言"，
 * 而用户要的是**关系向的主动搭讪**。
 *
 * ⇒ 住相改成两件事：
 * 1. **方向**：它决定**优先哪条轴**（relation 还是 current）
 * 2. **边界**：Q1/Q5 告诉模型"我站在哪、我的边界在哪"
 *
 * @param {object|null} snapshot - readSnapshotDigest 的结果
 * @returns {{guidance: string, preferAxis: string}|null}
 */
export function snapshotGuidance(snapshot) {
  if (!snapshot) return null
  const byKey = Object.fromEntries((snapshot.questions ?? []).map((q) => [q.key, q]))
  const q1 = byKey.Q1?.text ?? ''
  const q3 = byKey.Q3?.text ?? ''
  const q5 = byKey.Q5?.text ?? ''
  const q6 = byKey.Q6?.text ?? ''

  // 「共在」「意义」出现 ⇒ 偏关系轴；「此刻」「时间」偏当下轴
  const relationScore = (q3 + q6).match(/共在|意义|关系|在场/g)?.length ?? 0
  const currentScore = (q1 + q3).match(/此刻|时间|房间|节拍/g)?.length ?? 0
  const preferAxis = relationScore >= currentScore ? 'relation' : 'current'

  const parts = []
  if (q1) parts.push(`我此刻的位置：${q1}`)
  if (q5) parts.push(`我的边界：${q5}`)
  if (snapshot.anchor) parts.push(`我这期在想的：${snapshot.anchor}`)
  if (!parts.length) return null

  return { guidance: parts.join('\n'), preferAxis }
}

/**
 * 把选中主题的素材**展开**成 prompt 用的 brief（只有这一条）。
 *
 * @param {object} seed
 * @returns {string}
 */
export function expandTheme(seed) {
  const parts = []
  parts.push(`【这个话题从哪来】${AXIS_LABEL[seed.axis] ?? seed.axis}`)
  parts.push(seed.detail || seed.seed)
  return parts.join('\n')
}

export { readdirSyncSafe }
