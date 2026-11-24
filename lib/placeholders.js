/**
 * 占位符替换 —— 机制里唯一的"个性化"入口。
 *
 * | 占位符 | 替换成 |
 * |---|---|
 * | `{PKG}` | 插件包目录（机制） |
 * | `{DATA}` | 人格实例目录（数据） |
 * | `{USER}` | 对方的称呼 |
 * | `{ASSISTANT}` | 我自己的名字 |
 *
 * 协议、模板、生成的 AGENTS.md 都用它 ⇒ **换机器 / 换目录 / 换人，都不用改那些文件**。
 */

import { join } from 'node:path'

/**
 * @param {string} text
 * @param {{pkg?:string, data?:string, user?:string, assistant?:string}} ctx
 * @returns {string}
 */
export function expand(text, ctx = {}) {
  if (!text) return text
  const pkg = ctx.pkg ?? ''
  const data = ctx.data ?? ''
  const user = ctx.user ?? '用户'
  const assistant = ctx.assistant ?? '助手'
  let out = String(text)
    .split('{PKG}').join(pkg)
    .split('{DATA}').join(data)
    .split('{USER}').join(user)
    .split('{ASSISTANT}').join(assistant)
  // 兼容旧写法：写死的绝对路径
  if (pkg) out = out.split(pkg).join(data)
  return out
}

/** 把形如 `IDENTITY\SOUL.md` 的相对引用展开成绝对路径（用于生成的 AGENTS.md） */
export function expandMdRefs(text, dataRoot) {
  if (!text) return text
  return String(text).replace(/`([^`\n]*?\.md)`/g, (m, p) => {
    if (/^[A-Za-z]:/.test(p)) return m                    // 已经是绝对路径
    const abs = join(dataRoot, p.replace(/\\/g, '/')).replace(/\//g, '\\')
    return `\`${abs}\``                                  // ⚠️ 别把 .md 吃掉
  })
}
