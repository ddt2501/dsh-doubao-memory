/**
 * 把「当前选中的那个人格」真的加载进模型视野。
 *
 * ## 为什么需要这个
 *
 * 切换人格如果只改 `dataRoot`，只有记忆系统换个目录；模型看到的身份仍然是
 * 工作区根那份 `AGENTS.md`（可能是手写的、指向旧人格）。结果是
 * "选了别的人格，回话的还是上一个"。
 *
 * 所以插件自己往 system prompt 里注入一段**当前人格的身份摘要**：
 *   - 名字、称呼（来自 config）
 *   - SOUL.md 的正文节选（有界，避免每轮几千 token）
 *   - IDENTITY.md 的身份表（如果有）
 *
 * 有界策略：总长封顶约 2400 字符。SOUL 通常 5 KB，只取正文前段；
 * 完整内容仍由 AGENTS.md 的"启动期必读"引导模型自己读。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 节选上限（字符） */
export const SOUL_EXCERPT_LIMIT = 1600
export const TOTAL_LIMIT = 2400

/** 去掉生成标记与 html 注释，压缩连续空行 */
function normalize(text) {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 取 markdown 里第一个非标题、非引用的正文段落 */
function firstBodyText(md) {
  const lines = normalize(md).split('\n')
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) { if (out.length) break; else continue }
    if (t.startsWith('#')) continue
    if (t.startsWith('>')) continue
    if (t.startsWith('---')) continue
    out.push(t)
    if (out.join('').length > 400) break
  }
  return out.join(' ').trim()
}

/** 读一个文件的正文节选（失败返回空串） */
function excerpt(file, limit) {
  try {
    if (!existsSync(file)) return ''
    const body = normalize(readFileSync(file, 'utf8'))
    if (body.length <= limit) return body
    // 尽量在句子/段落边界截断
    const cut = body.slice(0, limit)
    const lastBreak = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('。'), cut.lastIndexOf('\n'))
    return (lastBreak > limit * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trim() + '…'
  } catch {
    return ''
  }
}

/**
 * 读取当前人格的身份材料。
 * @returns {{ assistantName:string, userName:string, soul:string, identity:string, loaded:boolean }}
 */
export function loadPersonaIdentity(paths, persona = {}) {
  const dir = paths.dataRoot
  const soulFile = join(paths.identity ?? join(dir, 'IDENTITY'), 'SOUL.md')
  const identityFile = join(paths.identity ?? join(dir, 'IDENTITY'), 'IDENTITY.md')

  let soul = excerpt(soulFile, SOUL_EXCERPT_LIMIT)
  let identity = excerpt(identityFile, Math.max(300, TOTAL_LIMIT - soul.length))

  // 总长封顶
  if (soul.length + identity.length > TOTAL_LIMIT) {
    identity = identity.slice(0, Math.max(0, TOTAL_LIMIT - soul.length))
  }

  // 文件读不到时退回配置里的自我定位，至少不注入空段
  if (!soul) soul = String(persona.selfDescription ?? '').trim()

  return {
    assistantName: persona.assistantName ?? '助手',
    userName: persona.userName ?? '用户',
    soul,
    identity,
    loaded: Boolean(soul || identity),
  }
}

/** 组装要注入的段落文本 */
export function renderPersonaSection(ident, personaDir) {
  if (!ident.loaded) return ''
  const lines = [
    `【当前人格 · ${ident.assistantName}】`,
    `对你的称呼：${ident.userName}。你自己的名字：${ident.assistantName}。`,
    `（这个人格的身份文件在 ${personaDir}。下面是它的核心节选；`,
    '完整内容按 AGENTS.md 的启动期必读清单去读。）',
    '',
  ]
  if (ident.soul) {
    lines.push('## 灵魂骨架（SOUL.md 节选）', ident.soul, '')
  }
  if (ident.identity) {
    lines.push('## 身份档案（IDENTITY.md 节选）', ident.identity, '')
  }
  return lines.join('\n').trim()
}

/**
 * 挂 system prompt 段落。
 *
 * `systemPrompt/section` 是 shim：注册的函数会在每次组装时被调用，
 * 所以换人格后**下一次请求**就是新的人格，不需要重启。
 *
 * @returns {() => void} 卸载函数（由 ctx.effect 托管）
 */
export function mountPersonaPrompt(scope, paths, persona, logPath, log) {
  const text = () => {
    try {
      const ident = loadPersonaIdentity(paths, persona)
      return renderPersonaSection(ident, paths.dataRoot)
    } catch (err) {
      if (log && logPath) {
        log(logPath, 'error', { where: 'persona-prompt', message: String(err?.message ?? err) })
      }
      return ''
    }
  }

  // ⚠️ 接口形状照抄本仓库 snapshot 子系统的用法：
  //    { name, order, interpolate, text: (context) => string }
  //    （用 id/content 不会被采纳，段落会静默不出现）
  const dispose = scope.systemPrompt.section({
    name: 'doubao-persona',
    order: 5,                       // 排在住相之前：先知道"我是谁"，再知道"此刻在看什么"
    interpolate: false,             // 人格文件里有 {} 和标点，别让渲染器插值
    text: () => text(),
  })

  if (log && logPath) {
    log(logPath, 'persona-prompt-mounted', {
      dir: paths.dataRoot,
      assistant: persona.assistantName,
      chars: text().length,
    })
  }

  return dispose
}
