/**
 * 自举 —— 空白安装时把人格实例**自己长出来**。
 *
 * 理想状态：别的用户装上插件，DSH 一启动就该知道
 *   ① 实例目录在哪儿、结构对不对   → ensureInstance()
 *   ② 人格入口（AGENTS.md）在工作区  → writePersonaEntry()
 *   ③ 四个 phase 已注册             → memory-system.js
 * 而**不需要他先跑 setup-persona.ps1**（脚本只是给"想在装之前就看到实例"的人用的等价物）。
 *
 * 原则：**只补缺失的，不覆盖已有的** —— 用户的记忆和人格永远比模板重要。
 */

import {
  existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync,
} from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { expand, expandMdRefs } from './placeholders.js'

/** 实例该有的目录骨架 */
export const INSTANCE_DIRS = [
  'IDENTITY', 'IDENTITY/PROPOSALS', 'IDENTITY/SNAPSHOTS',
  'VAULT', 'VAULT/01-IDENTITY', 'VAULT/02-USER', 'VAULT/03-RELATIONSHIP',
  'VAULT/04-INSIGHTS', 'VAULT/05-PROJECTS',
  'RAW/conversations', 'RAW/moments',
  'RUNTIME/state', 'RUNTIME/_errors',
  'RUNTIME/manas-system/data/manas', 'RUNTIME/manas-system/data/snapshots/metrics',
]

/** 实例该有的文件（相对 dataRoot） */
export const INSTANCE_FILES = [
  'IDENTITY/SOUL.md', 'IDENTITY/IDENTITY.md', 'IDENTITY/USER.md',
  'IDENTITY/AGENTS.md', 'IDENTITY/人格变更流程.md',
  'IDENTITY/PROPOSALS/_模板.md', 'IDENTITY/SNAPSHOTS/_说明.md',
  'VAULT/00-INDEX.md', 'VAULT/06-SCHEMA.md', 'VAULT/07-INDEX.md', 'VAULT/08-LOGS.md',
  'MEMORY.md', 'SNAPSHOT_LATEST.md',
]

function copyTree(srcDir, dstDir, created, base = dstDir, expandCtx = null) {
  if (!existsSync(srcDir)) return
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, entry.name)
    const d = join(dstDir, entry.name)
    if (entry.isDirectory()) {
      if (!existsSync(d)) { mkdirSync(d, { recursive: true }); created.push(relative(base, d) + '/') }
      copyTree(s, d, created, base, expandCtx)
    } else if (!existsSync(d)) {
      mkdirSync(dirname(d), { recursive: true })
      copyFileSync(s, d)
      // ⚠️ 模板里带占位符（`{ASSISTANT}` / `{DATA}` / `{PKG}`）。
      //    不展开的话，**别人的实例里就留着字面量占位符**——
      //    那份 AGENTS.md 谁也读不懂。2026-11-10 实测才发现。
      if (expandCtx) expandPlaceholdersInPlace(d, expandCtx)
      created.push(relative(base, d))
    }
  }
}

/** 文本文件里展开占位符（只动常见文本后缀，二进制原样保留） */
const TEXT_EXT = /\.(md|txt|json|ya?ml|ini|cfg)$/i
function expandPlaceholdersInPlace(file, ctx) {
  if (!TEXT_EXT.test(file)) return
  try {
    const raw = readFileSync(file, 'utf8')
    if (!raw.includes('{')) return
    const out = expand(raw, ctx)
    if (out !== raw) writeFileSync(file, out, 'utf8')
  } catch { /* ignore：模板不该因为展开失败而挡住安装 */ }
}

/**
 * 确保人格实例存在且结构完整。**只补缺失的**。
 * @returns {{created: string[], existed: boolean, root: string}}
 */
export function ensureInstance(paths, opts = {}) {
  const dataRoot = paths.dataRoot
  const created = []
  let existed = false
  try {
    existed = existsSync(dataRoot) && statSync(dataRoot).isDirectory()
  } catch { existed = false }

  // ⚠️ 守卫：**绝不能把人格写进插件包自己**。
  // 那会把"机制"和"数据"搅在一起，插件一升级就带着别人的记忆走。
  try {
    if (resolve(dataRoot) === resolve(paths.root)) {
      return { created, existed: true, root: dataRoot, refused: 'dataRoot is the package root' }
    }
  } catch { /* ignore */ }

  // 1) 目录骨架
  for (const d of INSTANCE_DIRS) {
    const p = join(dataRoot, d)
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true })
      created.push(`${d}/`)
    }
  }

  // 2) 从 templates/ 播种缺失的文件（**并展开占位符**）
  const templates = paths.templates ?? join(paths.root, 'templates')
  if (existsSync(templates)) {
    copyTree(templates, dataRoot, created, dataRoot, {
      pkg: paths.root,
      data: paths.dataRoot,
      user: opts.userName ?? '用户',
      assistant: opts.assistantName ?? '助手',
    })
  }

  // 3) 实例清单（便于判断"已初始化"）
  const manifest = join(dataRoot, 'RUNTIME', 'state', 'instance.json')
  if (!existsSync(manifest)) {
    try {
      mkdirSync(dirname(manifest), { recursive: true })
      writeFileSync(manifest, JSON.stringify({
        createdAt: new Date().toISOString(),
        dataRoot,
        packageRoot: paths.root,
        version: 1,
      }, null, 2), 'utf8')
      created.push('RUNTIME/state/instance.json')
    } catch { /* ignore */ }
  }

  return { created, existed, root: dataRoot }
}

/**
 * 写人格入口（AGENTS.md）到工作区根 —— DSH 只自动加载工作区根的 AGENTS.md。
 * **只在不存在时写**（不覆盖用户改过的）。
 * @returns {{written:boolean, target:string, reason?:string}}
 */
export function writePersonaEntry(paths, opts = {}) {
  const target = opts.path ?? join(opts.workspace ?? process.cwd(), 'AGENTS.md')
  if (existsSync(target) && !opts.overwrite) {
    return { written: false, target, reason: 'already exists' }
  }
  const source = join(paths.identity, 'AGENTS.md')
  if (!existsSync(source)) {
    return { written: false, target, reason: 'no template AGENTS.md' }
  }
  const text = readFileSync(source, 'utf8')
  const expanded = expandMdRefs(
    expand(text, {
      pkg: paths.root,
      data: paths.dataRoot,
      user: opts.userName,
      assistant: opts.assistantName,
    }),
    paths.dataRoot,
  )
  try {
    writeFileSync(target, expanded, 'utf8')
    return { written: true, target }
  } catch (err) {
    return { written: false, target, reason: String(err?.message ?? err) }
  }
}
