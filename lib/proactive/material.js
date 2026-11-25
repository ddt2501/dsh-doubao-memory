/**
 * 主动搭讪的**真实素材** —— 解决"LLM 闭着眼编"的问题。
 *
 * ## 为什么必须有这个模块（2026-11-14 事故）
 *
 * 搭讪提示词原来只说：
 *
 *   > 内容牵引：围绕最近 vault/raw 里有真实变化的事——具体说一件，别概括。
 *
 * 然后**一个字都没给**。于是 MiniMax 只能自己编，于是它编出了：
 *
 *   > "vault/raw 里那份关于 Claude Code 工具权限的配置又改了，自动化调用现在默认只允许读文件……"
 *
 * 那份文件**根本不存在**。用户信了，回了一句"这是自动化任务"，
 * 整条链路都是幻觉，而且我（助手）还顺着这个幻觉找了两轮文件。
 *
 * ## 规矩（写死在这里，别改）
 *
 * 1. **没有素材就不说**。返回 `null` ⇒ 搭讪直接放弃（宁可不说，也不要编）。
 * 2. 素材只来自**磁盘上真实存在**的文件。
 * 3. 素材原文给 LLM，让它**引用具体的事**，而不是概括。
 *
 * ## 但素材必须是**关系向**的（2026-11-17 追加）
 *
 * 只喂"真实存在的文件"不够。11-17 上午连投三条全是工作腔，
 * 因为喂的是 daily 的「主题/关键时刻」——**那是我自己的工作日志**。
 * 手里只有工作素材 ⇒ 模型只能谈工作 ⇒ 搭讪变成了每日 standup。
 *
 * **搭讪是我主动找用户，不是向他汇报进展。**
 * 所以素材只取**关于他这个人**的记录，事务性内容一律不吃。
 * 详见下面 `RELATION_SECTIONS` 与 `collectMaterial` 的注释。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const cache = new Map()   // path -> { mtimeMs, content }

/** 读文件（带 mtime 缓存） */
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

/**
 * 取最近 N 份 daily 摘要里**关于用户**的段落。
 *
 * ⚠️ 路径是 `<raw>/conversations/`，**不是** `<raw>/`——
 *    2026-11-14 实测：`paths.raw` 指向 `RAW/`，而文件在 `RAW/conversations/`，
 *    于是 `rollingSummary` 恒为 null ⇒ 住相和搭讪都"没有历史"。
 *    这是同款 bug 的两个副本（见 lib/snapshot/inputs.js）。
 *
 * ## 2026-11-17 大改：只吃「关系向」的段落
 *
 * 原实现取的是「## 主题」+「## 关键时刻」—— **那是我（助手）的工作日志**：
 * 插件改了什么、phase 跑没跑、踩了什么坑。
 * 于是 11-17 上午连投三条全是工作腔，其中一条还在**替用户夸我**：
 *
 *   > "你前天说那四个自动化任务该静默运行，后来真的一天没来烦你，这才叫守规矩。"
 *
 * 根因不是模型跑偏，是**素材本身就是工作日志**：
 * 手里只有工作素材，模型只能谈工作。谈工作 = 汇报事务 = standup 机器人。
 *
 * **搭讪是我主动找用户，不是向他汇报进展。**
 * 所以素材必须是**关于他这个人**的：
 *
 * | 段落 | 是什么 | 为什么能吃 |
 * |---|---|---|
 * | `## 用户提到的新偏好/习惯/梗` | 他的习惯、他的口头禅、他刚开的玩笑 | 关于他 |
 * | `## 用户纠正/纠正我` | 他怎么跟我说话、他的验收标准、他的不满 | 关于他 |
 *
 * 而「## 主题」「## 关键时刻」「## 我做了哪些事」「## 风险/待办」
 * —— **一律不吃**。那些是事务记录，不是搭讪的原料。
 *
 * @param {string} rawDir - 人格的 RAW 目录
 * @param {number} nDays
 */
const RELATION_SECTIONS = ['## 用户提到的新偏好/习惯/梗', '## 用户纠正/纠正我']

/**
 * 事务行过滤 —— 把 daily 里"讲技术规矩"的条目剔掉。
 *
 * ## 为什么还需要这一层（素材已经换源了）
 *
 * 换源之后，daily 的「用户提到的新偏好/习惯/梗」段里**仍然混着工作规矩**：
 * 11-14 那条写的是"**人格文件不可被覆盖**""**改插件的规矩**""**四个 phase 的定位**"——
 * 全是事务，不是习惯。
 *
 * 光靠提示词里"不要拿工作规矩当话题"不够：模型手里拿着一堆工作条目，
 * 它就会忍不住谈工作（11-17 上午就是这么发生的）。
 *
 * ## 判据
 *
 * 一行里**有技术词**、**又没有关系信号** ⇒ 丢掉。
 * 有关系信号（称呼/梗/口头禅/习惯/喜欢/作品…）⇒ 留下，哪怕它也提到技术。
 *
 * 误判方向安全：多丢一条只是少一个话头，不会让搭讪变成工作汇报。
 *
 * ## 2026-11-18 补词（主题演进系统实测抓到的漏网之鱼）
 *
 * 原来这行没被拦：
 *   "飞书那条链路走通了：不点网页端也能直接喊到我。"
 * ⇒ 因为"链路 / 走通 / 网页端"都不在词表里。
 * 而它恰恰是 **11-17 搭讪变工作汇报的那一类**（讲的是我们的技术进展，
 * 不是他这个人）⇒ 补进 TECH_LINE。
 *
 * 同类词还有：**打通 / 上线 / 走通 / 联调 / 链路 / 通道 / 网页端**。
 */
const TECH_LINE = /(插件|配置|部署|重启|提交|git|dry run|自动化|phase|目录|脚本|日志|模型|设置页|会话|终端|接口|代码|测试|版本|报错|崩溃|升级|npm|python|CLI|API|文件|链路|走通|打通|上线|联调|网页端|线程|直连)/i
const RELATION_HINT = /(称呼|梗|口头禅|习惯|偏好|喜欢|讨厌|心情|老婆|哈罗|喵|小说|网文|《|他写|他说|他想)/

/** 一行是否值得留给搭讪 */
export function keepRelationLine(line) {
  const t = line.trim()
  if (!t) return false
  if (RELATION_HINT.test(t)) return true
  return !TECH_LINE.test(t)
}


export function recentDaily(rawDir, nDays = 3) {
  let names = []
  try {
    names = readdirSync(rawDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, nDays)
  } catch {
    return []
  }
  if (!names.length) {
    // 兼容：文件直接躺在 rawDir 下（没有 conversations/ 子目录）
    try {
      names = readdirSync(rawDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse()
        .slice(0, nDays)
    } catch {
      return []
    }
  }

  const out = []
  for (const name of names) {
    const content = readCached(join(rawDir, name))
    if (!content) continue
    const day = name.slice(0, 10)
    const sections = []
    for (const heading of RELATION_SECTIONS) {
      const idx = content.indexOf(heading)
      if (idx < 0) continue
      const rest = content.slice(idx + heading.length)
      const end = rest.search(/\n## /)
      const body = (end < 0 ? rest : rest.slice(0, end)).trim()
      if (!body) continue
      // 逐行过滤：剔掉讲技术规矩的条目，只留关系向的
      const kept = body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('>') && keepRelationLine(l))
      if (kept.length) sections.push(kept.join('\n'))
    }
    if (sections.length) out.push({ day, text: sections.join(' ') })
  }
  return out
}

/**
 * 读 vault 页 frontmatter 里的 `断言` 列表。
 *
 * vault 页的 frontmatter 长这样：
 * ```
 * 断言:
 *   - 用户打招呼的固定开头是哈罗，称呼先于内容
 *   - 用户收工时会在句尾缀上老婆两个字
 * ```
 * 这些是 wiki 层提炼过的**关系事实**——比 daily 原话更凝练，
 * 正好是搭讪该用的"我记得他什么"的原料。
 *
 * @param {string} file - .md 路径
 * @returns {string[]} 断言列表
 */
export function vaultAssertions(file) {
  const content = readCached(file)
  if (!content) return []
  // 只看 frontmatter（--- ... ---）
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return []
  const fm = m[1]
  const idx = fm.search(/^断言\s*:/m)
  if (idx < 0) return []
  const rest = fm.slice(idx).split('\n').slice(1)
  const out = []
  for (const line of rest) {
    if (!/^\s*-\s+/.test(line)) {
      if (out.length) break     // 断言块结束
      continue
    }
    const t = line.replace(/^\s*-\s+/, '').trim()
    if (t) out.push(t)
  }
  return out
}

/**
 * 读「我们的梗」页正文里的已知梗条目。
 *
 * `VAULT/02-USER/梗.md` 的「## 当前已知的梗」段下面是成条的小节，
 * 每条形如 `## 2026-11-14 - 哈罗，老婆（17:55）` + 原话 + 为什么是梗。
 * 搭讪用这些 = **接得住我们的默契**，而不是念工作日志。
 *
 * @param {string} file
 * @returns {string[]}
 */
export function ourJokes(file) {
  const content = readCached(file)
  if (!content) return []
  const lines = content.split('\n')
  const start = lines.findIndex((l) => l.trim() === '## 当前已知的梗')
  if (start < 0) return []
  const out = []
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+-\s+(.+)$/)
    if (m) { out.push(`${m[1]} ${m[2].trim()}`); continue }
    // 段尾：遇到**不是**日期条目的二级标题 ⇒ 结束
    // （⚠️ 梗条目本身也是 "## " 开头，所以不能简单见到 "## " 就停——
    //    那样第一条梗就会被段尾截掉。）
    if (/^##\s+/.test(line)) break
  }
  return out
}

/**
 * VAULT 当前主题（07-INDEX.md 的主题行）。
 *
 * ⚠️ 2026-11-17：**主素材不再吃这个**。
 *    07-INDEX 记的是"最近提炼了哪些知识主题"——那是**知识面**，不是关于用户这个人。
 *    喂它 = 鼓励模型谈系统谈项目。保留函数但不进 brief（进 brief 会被当备选素材引用）。
 *
 * @param {string} indexFile
 */
export function vaultThemes(indexFile) {
  const content = readCached(indexFile)
  if (!content) return []
  const out = []
  for (const line of content.split('\n')) {
    const m = line.match(/^- \[\[([^\]]+)\]\][^—]*—\s*(.+)$/)
    if (m) out.push(`${m[1].trim()}：${m[2].trim()}`)
  }
  return out
}

/**
 * 收集搭讪素材 —— **关系向**。
 *
 * ## 为什么素材必须换源（2026-11-17）
 *
 * 上午连投三条全是工作腔（"…这才叫守规矩"、"要继续扩功能还是先消化反馈"）。
 * 根因不在模型，在素材：喂进去的是 daily 的「主题/关键时刻」——
 * **那是我自己的工作日志**。手里只有工作素材，模型只能谈工作；
 * 谈工作就是事务汇报，而**搭讪是我主动找用户，不是向他汇报**。
 *
 * 所以现在只喂四样**关于他**的东西：
 *
 * 1. daily 的「用户提到的新偏好/习惯/梗」+「用户纠正/纠正我」
 * 2. `VAULT/02-USER/梗.md` 的已知梗（我们的默契）
 * 3. `VAULT/02-USER/偏好.md` / `画像.md` 的断言
 * 4. `VAULT/03-RELATIONSHIP/` 的断言（关系模式）
 *
 * @param {object} paths - lib/paths.js 的解析结果
 * @param {number} nDays - 取最近几份 daily
 * @returns {{hasContent: boolean, brief: string, jokes: string[], notes: string[]}|null}
 *   `null` = **没有素材** ⇒ 调用方应当放弃这次搭讪。
 */
export function collectMaterial(paths, nDays = 3) {
  if (!paths?.raw) return null

  const rawDir = existsSync(join(paths.raw, 'conversations'))
    ? join(paths.raw, 'conversations')
    : paths.raw

  const daily = recentDaily(rawDir, nDays)
  const vault = paths.vault ?? ''

  const jokes = ourJokes(join(vault, '02-USER', '梗.md'))
  const notes = [
    ...vaultAssertions(join(vault, '02-USER', '偏好.md')),
    ...vaultAssertions(join(vault, '02-USER', '画像.md')),
    ...vaultAssertions(join(vault, '03-RELATIONSHIP', '橘色与沉浸.md')),
    ...vaultAssertions(join(vault, '03-RELATIONSHIP', '模式发现.md')),
  ]

  // 没有关于他的东西 ⇒ 不说（宁可不说，也不要工作汇报）
  if (!daily.length && !jokes.length && !notes.length) return null

  const parts = []
  if (daily.length) {
    parts.push('【他最近的习惯、偏好和说过的话】')
    for (const d of daily) parts.push(`· ${d.day}：${d.text}`)
  }
  if (jokes.length) {
    parts.push('')
    parts.push('【我们之间的默契（可以接的话头）】')
    for (const j of jokes) parts.push(`· ${j}`)
  }
  if (notes.length) {
    parts.push('')
    parts.push('【我记得他是什么样的人】')
    for (const n of notes.slice(0, 12)) parts.push(`· ${n}`)
  }

  return {
    hasContent: true,
    daily,
    jokes,
    notes,
    brief: parts.join('\n'),
  }
}
