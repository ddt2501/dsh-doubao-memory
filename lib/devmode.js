/**
 * dev 协调模式 —— 主 agent 只写文档，代码写入强制派发子代理。
 *
 * 设计共识（2026-11-24，见 PROGRESS.md）：
 *  - 主 agent 只对接协调；代码开发 / 测试验证派给**干净上下文**的子代理（无人格、有 memory call）。
 *  - 强制手段在**工具层**（guard），不靠提示词自觉 ⇒ 模型无关。
 *  - **pwsh 保留给主 agent**：它有上下文、懂用户电脑；让无上下文子代理拿宽 shell 更危险。
 *    子代理的 shell 应收进紧沙箱（workspace-write），能 dev/test 但越不了界。
 *  - edit/write 只写文本；白名单放行文档(.md)，挡代码。office(.docx/.xlsx/.pdf/.pptx) 是二进制，
 *    走 office_render/脚本，不经 edit/write，天然放行。
 *  - 诚实边界：pwsh 是合法残留旁路（为安全主动保留），故非 airtight 100%；edit/write 主路径是硬挡。
 *
 * 本模块是**纯决策 + 状态**，便于单测；guard 注册在 index.js。
 */

import { readFileSync } from 'node:fs'

/** edit/write 放行的文本扩展名（文档/进度/人格）。office 二进制不经此工具。 */
const DOC_EXT = new Set(['.md', '.markdown'])

let enabled = false

/** 开/关 dev 协调模式（UI 开关 / 斜杠命令 / 配置都调它） */
export function setDevMode(on) {
  enabled = Boolean(on)
}

export function isDevMode() {
  return enabled
}

/** 取小写扩展名（含点）；无扩展名返回 '' */
export function extOf(filePath) {
  const m = String(filePath ?? '').match(/\.([a-z0-9]+)$/i)
  return m ? '.' + m[1].toLowerCase() : ''
}

/**
 * 纯决策：主 agent 的这次写入该不该被挡。
 * @returns {string|null} 拒绝理由（string）或放行（null）
 */
export function writeDenial({ devMode, isRoot, toolName, filePath }) {
  if (!devMode) return null                          // 模式关 ⇒ 全放行
  if (!isRoot) return null                           // 子代理不受影响（它们负责写代码）
  if (toolName !== 'edit' && toolName !== 'write') return null  // pwsh/其它工具保留
  if (DOC_EXT.has(extOf(filePath))) return null      // 文档放行
  return (
    `dev 协调模式：主 agent 只写文档(.md)，代码/其它文件请派发子代理执行` +
    `（目标 ${filePath || '(未知)'}）。如需亲自写，请关闭 dev 模式。`
  )
}

/**
 * dev 协调模式 · 协调者 SOP（devMode ON 时注入主 agent 的 system section）。
 * 显式规定三角色独立派发：开发 / 测试验证 / 独立审计。做进插件，不用 skill。
 * 有界（~300 tok），只在 devMode + 顶层注入。
 *
 * 文案外置在同目录 devmode-coordinator.md：prose 归 .md，dev 模式下主 agent 可直接维护，
 * 不与代码写入互相挡。路径相对本模块（import.meta.url），不依赖 cwd。
 * **每次调用都读**（文件 ~400 字符，开销可忽略）⇒ .md 编辑后无需重启即生效，无缓存失效问题。
 * 读失败 / 内容为空 ⇒ 返回兜底文案（不抛错，不崩注入），并 console.error 一次性日志（同错去重）。
 */
const COORDINATOR_SOP_FALLBACK =
  '【dev 协调模式 · 你的角色：协调者】你不亲自写代码，代码工作派发独立子代理：' +
  '开发子代理实现、测试/验证子代理独立跑（不信任开发子代理的自述）、审计子代理独立审查，三角色上下文互不污染。' +
  '你保留 pwsh、写文档(.md)、recall_memory。'

/** 已日志过的失败签名：同一错误只报一次（避免每次注入刷屏）；读成功后复位。 */
let sopErrorLogged = null

export function renderCoordinatorSection() {
  try {
    const text = readFileSync(new URL('./devmode-coordinator.md', import.meta.url), 'utf8')
    if (!text.trim()) throw new Error('devmode-coordinator.md 内容为空')  // 空文件视为异常：走兜底，下次重读
    sopErrorLogged = null
    return text
  } catch (err) {
    const sig = String(err?.message ?? err)
    if (sopErrorLogged !== sig) {
      sopErrorLogged = sig
      console.error(`[dsh-doubao-memory] 协调者 SOP 读取失败，暂用兜底文案：${sig}`)
    }
    return COORDINATOR_SOP_FALLBACK
  }
}