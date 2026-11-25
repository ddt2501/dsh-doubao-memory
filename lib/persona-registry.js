/**
 * 人格实例登记 —— 回答两个问题：
 *   1. 现在该用哪个人格？（选择）
 *   2. 这个人格目录能不能写？（保护）
 *
 * ## 为什么需要它
 *
 * 「人格文件」不是配置文件，是**长期迭代的产物**——助手的 SOUL.md 写了 5.6 KB，
 * 是几个月一句一句攒出来的。一次配置保存把它换成模板，等于把人抹了。
 * 所以写权限必须由目录的**来历**决定，不能由"用户点没点保存"决定。
 *
 * ## 三类目录
 *
 * | 分类 | 判据 | 能写吗 |
 * |---|---|---|
 * | `new` | 目录不存在 / 刚被这次调用建出来 | ✅ 播种 + 生成 |
 * | `ours` | 有 `RUNTIME/state/persona-origin.json` | ✅ 只改自己生成的文件（手改的仍是只读） |
 * | `template-only` | 存在，无标记，且所有受管文件与模板逐字节相同 | ✅ 视同没被用过 |
 * | `foreign` | 存在，无标记，且至少一个受管文件与模板不同 | ❌ **一个字都不写** |
 *
 * `foreign` 就是"别人（或过去的我）真实写出来的人格"。要动它只有一条路：
 * 显式 `regenerate: true`，且覆盖前写 `.bak`。
 */

import {
  existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync,
} from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { expand } from './placeholders.js'
import { GENERATED_MARK } from './persona-generate.js'

/** 来历标记的文件名（放在实例的 RUNTIME/state/ 下） */
export const ORIGIN_FILE = 'persona-origin.json'

/** 受管文件 = 生成器会写的那些（相对实例根） */
export const MANAGED_FILES = [
  'IDENTITY/SOUL.md',
  'IDENTITY/IDENTITY.md',
  'IDENTITY/USER.md',
  'IDENTITY/PERSONA.md',
  'SNAPSHOT_LATEST.md',
]

/** 人格目录的根：$DSH_HOME/personas */
export function personasRoot(cfg = {}) {
  if (cfg.personasRoot) return resolve(cfg.personasRoot)
  const home = process.env.DSH_HOME
  if (home) return join(home, 'personas')
  return null
}

/**
 * 所有可能放人格的根目录（按优先级）。
 *
 * ⚠️ 2026-11-14 两次踩坑后的结论：
 *   1. 只扫 `$DSH_HOME/personas` 不够——本机真正在用的助手在 `D:\dsh\persona\助手`，
 *      库里只有 4 个早期测试留下的空模板 ⇒ 下拉读到 0 个。
 *   2. 于是改成"连 dataRoot 的父目录一起扫"⇒ **太宽**：测试实例的 dataRoot 在
 *      %TEMP% 下，父目录里几十个历史测试目录全被当成人格列出来。
 *
 * 所以：**人格库是显式概念**。
 *   - `personasRoot` 配置项说了算；
 *   - 否则用 `$DSH_HOME/personas`；
 *   - 当前在用的 dataRoot 永远单独列出来（不出现在根里也能看到自己）。
 * 本机的 `D:\dsh\persona` 通过 profile 里的 `personasRoot` 指过去。
 *
 * @returns {string[]} 去重后的根目录列表（不保证存在，调用方自行判断）
 */
export function personasRoots(paths = {}, cfg = {}) {
  // 显式配置**完全覆盖**默认（不叠加），避免"我以为只看这个库，其实还混着别处"。
  if (cfg.personasRoot) {
    try { return [resolve(cfg.personasRoot)] } catch { return [] }
  }
  if (process.env.DSH_HOME) {
    try { return [join(process.env.DSH_HOME, 'personas')] } catch { return [] }
  }
  return []
}

/** 读来历标记（没有就返回 null） */
export function readOrigin(dir) {
  try {
    const p = join(dir, 'RUNTIME', 'state', ORIGIN_FILE)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 写来历标记 —— 只有确定这个目录是"我们建的"时才调 */
export function writeOrigin(dir, extra = {}) {
  try {
    const p = join(dir, 'RUNTIME', 'state', ORIGIN_FILE)
    mkdirSync(join(dir, 'RUNTIME', 'state'), { recursive: true })
    writeFileSync(p, JSON.stringify({
      createdBy: 'dsh-doubao-memory',
      at: new Date().toISOString(),
      version: 1,
      ...extra,
    }, null, 2), 'utf8')
    return p
  } catch {
    return null
  }
}

/**
 * 这个文件是不是"还没人动过的模板"？
 *
 * ⚠️ 不能只拿**当前配置的名字**去展开模板再比对：
 *    `$DSH_HOME/personas/助手` 当初是用 assistantName="助手" 播种的，
 *    而现在配置里可能叫别的；只比一种展开会把所有模板目录误判成 foreign
 *    （2026-11-14 实测：4 个纯模板目录全被判成 foreign）。
 *
 * 所以按**几个候选名字组合**各展开一次，命中任意一个就算模板原文。
 * 手写过的文件不会命中任何候选（它早就不等于模板了）。
 */
function isUntouchedTemplateFile(paths, dir, rel, persona) {
  try {
    const target = join(dir, rel)
    if (!existsSync(target)) return false
    const tpl = join(paths.templates, rel)
    if (!existsSync(tpl)) return false

    const actual = readFileSync(target, 'utf8')
    const tplRaw = readFileSync(tpl, 'utf8')
    if (!tplRaw.includes('{')) return actual === tplRaw

    const dirName = basename(dir)
    const cands = new Set()
    const push = (u, a) => cands.add(`${u ?? ''}\u0000${a ?? ''}`)
    push(persona?.userName, persona?.assistantName)
    push('用户', '助手')
    push('用户', dirName)
    push(dirName, dirName)
    push(dirName, '助手')
    push('用户', '用户')

    // 路径会漂移（实例可能在不同机器/不同 dataRoot 下播种过），
    // 比对时把含绝对路径的**整行**剔除，只比结构。
    // 误判方向是安全侧：宁可把老模板当"手写"（只读），也不要反过来。
    const stripPaths = (s) => s.split(/\r?\n/).filter((l) => !/[A-Za-z]:[\\/]|\/home\/|\/Users\//.test(l)).join('\n')
    const actualS = stripPaths(actual)

    for (const key of cands) {
      const [u, a] = key.split('\u0000')
      const expected = expand(tplRaw, { pkg: paths.root, data: dir, user: u, assistant: a })
      if (actual === expected) return true
      if (actualS === stripPaths(expected)) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 判断一个已存在目录的来历。
 * @returns {{kind:'new'|'ours'|'template-only'|'foreign', reasons:string[], foreignFiles:string[]}}
 */
export function classifyPersonaDir(paths, dir, persona) {
  if (!existsSync(dir)) return { kind: 'new', reasons: ['directory missing'], foreignFiles: [] }

  const origin = readOrigin(dir)
  if (origin) {
    return { kind: 'ours', reasons: [`origin marker: ${origin.createdBy} @ ${origin.at}`], foreignFiles: [] }
  }

  // 无标记：逐个受管文件比对模板，全部一致（或缺省）⇒ 没人写过
  const foreignFiles = []
  const reasons = ['no origin marker']
  for (const rel of MANAGED_FILES) {
    const p = join(dir, rel)
    if (!existsSync(p)) continue                     // 缺文件不算"写过"
    let actual = ''
    try { actual = readFileSync(p, 'utf8') } catch { actual = '' }
    // 我们自己生成的文件（带标记）不算"外来"
    if (actual.includes(GENERATED_MARK)) continue
    if (!isUntouchedTemplateFile(paths, dir, rel, persona)) foreignFiles.push(rel)
  }

  if (foreignFiles.length === 0) {
    return { kind: 'template-only', reasons, foreignFiles }
  }
  return { kind: 'foreign', reasons: [...reasons, `${foreignFiles.length} file(s) differ from template`], foreignFiles }
}

/**
 * 列出所有已存在的人格。
 * @returns {Array<{id:string, dir:string, kind:string, assistantName:string|null, files:number, lastModified:number}>}
 */
export function listPersonas(paths, cfg = {}) {
  const roots = personasRoots(paths, cfg)
  const seen = new Set()
  const out = []

  const consider = (dir, rootLabel) => {
    let abs
    try { abs = resolve(dir) } catch { return }
    if (seen.has(abs)) return
    seen.add(abs)
    // 必须像一个实例：至少要有 IDENTITY 目录
    if (!existsSync(join(abs, 'IDENTITY'))) return

    let assistantName = null
    try {
      const soul = join(abs, 'IDENTITY', 'SOUL.md')
      if (existsSync(soul)) {
        const m = readFileSync(soul, 'utf8').match(/\*\*我是\*\*[:：]\s*(.+)/)
        assistantName = m ? m[1].trim() : null
      }
    } catch { /* ignore */ }

    let files = 0
    let lastModified = 0
    try {
      for (const rel of MANAGED_FILES) {
        const p = join(abs, rel)
        if (existsSync(p)) {
          files++
          const t = statSync(p).mtimeMs
          if (t > lastModified) lastModified = t
        }
      }
    } catch { /* ignore */ }

    const cls = classifyPersonaDir(paths, abs, null)
    out.push({
      id: basename(abs),
      dir: abs,
      root: rootLabel,
      kind: cls.kind,
      assistantName,
      files,
      lastModified,
      active: paths.dataRoot ? resolve(paths.dataRoot) === abs : false,
    })
  }

  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      consider(join(root, e.name), root)
    }
  }

  // 当前在用的那个即使不在任何根下也要列出来（否则用户看不到自己）
  if (paths.dataRoot) consider(paths.dataRoot, 'active')

  // ── 按 id 去重 ────────────────────────────────────────────────
  // ⚠️ 同名目录可能出现在多个根下（本机：D:\dsh\persona\助手 是真正在用的，
  //    $DSH_HOME\personas\助手 是早期测试留下的空模板）。
  //    下拉里出现两个「助手」会让用户选错，而 activeId 是按名字解析的——
  //    选错就会切到空模板，等于把人换了。所以同 id 只保留一个：
  //    在用的 > 文件多的 > 最近改的。
  const byId = new Map()
  for (const p of out) {
    const prev = byId.get(p.id)
    if (!prev) { byId.set(p.id, p); continue }
    const better = (p.active && !prev.active)
      || (p.active === prev.active && p.files > prev.files)
      || (p.active === prev.active && p.files === prev.files && p.lastModified > prev.lastModified)
    if (better) byId.set(p.id, p)
  }
  const unique = [...byId.values()]

  // 在用的排最前，其余按最近修改
  unique.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.lastModified - a.lastModified)
  return unique
}

/**
 * 决定这次该用哪个人格目录。
 *
 * 优先级：
 *   1. `persona.newId`  → 新建（已存在则拒绝，绝不覆盖）
 *   2. `persona.activeId` → 用已存在的那个
 *   3. `dataRoot` → 老配置，原样尊重
 *   4. 默认 → $DSH_HOME/personas/<assistantName>
 *
 * @returns {{dir:string, action:'create'|'use'|'refuse', reason:string, newId?:string}}
 */
export function resolveActivePersona(cfg, persona, fallbackDir, paths = {}) {
  const roots = personasRoots(paths ?? {}, cfg)
  const primary = roots[0] ?? null
  const newId = String(persona?.newId ?? '').trim()
  const activeId = String(persona?.activeId ?? '').trim()

  /**
   * 在所有根里找同名目录。
   *
   * ⚠️ **当前在用的那个优先**：本机两个根下有同名「助手」
   *    （真在用的 + $DSH_HOME 里的空模板）。按名字解析时必须先命中在用的，
   *    否则用户在下拉里选「助手」会切到空模板——等于把人格换了。
   */
  const findByName = (id) => {
    try {
      if (paths.dataRoot && basename(paths.dataRoot) === id && existsSync(paths.dataRoot)) {
        return resolve(paths.dataRoot)
      }
    } catch { /* ignore */ }
    for (const root of roots) {
      const dir = join(root, id)
      if (existsSync(dir)) return dir
    }
    return null
  }

  if (newId) {
    if (!primary) {
      return { dir: fallbackDir, action: 'refuse', reason: 'persona.newId needs a personas root' }
    }
    const existed = findByName(newId)
    if (existed) {
      // ⚠️ 最关键的一条：同名目录已存在 ⇒ **拒绝创建**，不做"覆盖成新的"这种事。
      return { dir: existed, action: 'refuse', reason: `persona "${newId}" 已存在，不会覆盖`, newId }
    }
    return { dir: join(primary, newId), action: 'create', reason: `新建人格 "${newId}"`, newId }
  }

  if (activeId) {
    const found = findByName(activeId)
    if (!found) {
      return { dir: fallbackDir, action: 'refuse', reason: `persona "${activeId}" 不存在`, newId: activeId }
    }
    return { dir: found, action: 'use', reason: `使用已有人格 "${activeId}"` }
  }

  return { dir: fallbackDir, action: 'use', reason: 'default (dataRoot / assistantName)' }
}
