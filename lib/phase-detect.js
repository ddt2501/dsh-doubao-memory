/**
 * phase 会话识别 —— 自动化会话不该被当成"用户在跟我说话"。
 *
 * ## 为什么需要这个模块（2026-11-14 踩到的坑）
 *
 * 主动搭讪把一句**编造的**话投进了 ingest 的会话：
 *
 *   > "vault/raw 里那份关于 Claude Code 工具权限的配置又改了，自动化调用现在默认只允许读文件……"
 *
 * 那句话是 LLM **闭着眼编的**——它根本没拿到 vault/raw 的内容，
 * 却写得像在复述某份真实文件。用户以为是自己说过的话，
 * 于是回了一句"这 4 个自动化任务是人格插件维持所需要的"，
 * 整条链路都是幻觉。
 *
 * ## 根因链
 *
 * 1. DSH 的 schedule 每次触发都**新建一个会话**（`target.kind === 'new'`）。
 * 2. 那个会话的 `SessionHeader` 里 **`origin` 是空、`delegationDepth` 是 0**
 *    （只有子代理才有 `origin: 'subagent'`）⇒ `isRootAgent()` 判它是**顶层**。
 * 3. 于是主动搭讪和住相都把它当普通会话 ⇒ 假话投进去、住相也照生成。
 *
 * ## 怎么可靠地认出它
 *
 * `SessionHeader` **没有**任何"自动化"标记（只有 9 个字段：
 * version/id/createdAt/cwd/parentSession/isSeeded/origin/delegationDepth/agentPreset）。
 * 所以只能从**运行期信号**认：
 *
 *   - **信号 A（最可靠）**：这个会话的**第一条** user 消息 `source.kind === 'schedule'`。
 *     DSH 的 schedule 投递时写死这个 source（`dsh-schedule/src/runtime.ts:353`
 *     `createUserMessage({ ..., source: { kind: 'schedule' } })`），
 *     而且它是**持久化**的（session format v4 允许任何非空 producer kind）。
 *   - **信号 B（兜底）**：会话标题以 `助手·` 开头。schedule 建会话后会用任务标题
 *     命名（`dsh-schedule/src/runtime.ts:492-502` `nameSession`），
 *     我们的四个 phase 标题都是 `{ASSISTANT}·xxx` ⇒ 展开成 `助手·xxx`。
 *     ⚠️ 标题是**在 `agent/created` 之后**才写的（runtime.ts:447→449），
 *     所以在 `agent/created` 里读不到。
 *
 * **反向信号（最重要）**：用户在这个会话里说过话 ⇒ **绝不**判成 phase。
 * 真人消息的 `source.kind` 是 `'user'`（实测全库 168 次）——
 * 其余的（time-context / agent-instructions / runtime-context / skill-catalog /
 * schedule / manas-proactive …）全是系统注入或插件投递，都不算用户在说话。
 *
 * 两个信号都拿不到时**不放行**——宁可漏判，也不能让假话再进自动化会话。
 */

/**
 * phase 任务标题前缀（与 RUNTIME/manas-system/REGISTRY.json 的 `{ASSISTANT}·xxx` 对应）。
 * 运行时由插件按配置的 assistantName 设置（见 lib/index.js），不写死具体名字。
 */
let phaseTitlePrefix = '助手·'

export function setPhaseTitlePrefix(prefix) {
  if (typeof prefix === 'string' && prefix.trim()) phaseTitlePrefix = prefix
}

export function getPhaseTitlePrefix() {
  return phaseTitlePrefix
}

/** 记在 agent 实例上的字段名（首条 user 消息的 source.kind） */
const FIRST_SOURCE_KEY = '__doubaoFirstSourceKind'
/** 记在 agent 实例上的字段名（这个会话里有没有真人发言） */
const HAS_HUMAN_KEY = '__doubaoHasHuman'
/** 记在 agent 实例上的字段名（用户最后一次在这个会话说话的时刻） */
const HUMAN_AT_KEY = '__doubaoLastHumanAt'

/**
 * 这个消息是不是 schedule 投递的？
 * @param {object} message - UserMessage
 */
export function isScheduleMessage(message) {
  try {
    return message?.source?.kind === 'schedule'
  } catch {
    return false
  }
}

/**
 * 这个会话标题是不是 phase 任务标题？
 * @param {string} title
 */
export function isPhaseTitle(title) {
  if (typeof title !== 'string') return false
  return title.startsWith(phaseTitlePrefix)
}

/**
 * 记住一个会话的首条 user 消息 source.kind。
 *
 * ⚠️ 只记**第一条**：`agent/pre-step` 每一步都会给当步的 messages，
 *    而 phase 会话第一轮拿到的是 schedule 那条，后面可能混进别的。
 *    判"是不是 phase 会话"要看**第一条**。
 *
 * @param {object} agent
 * @param {string} kind
 */
export function rememberFirstSourceKind(agent, kind) {
  if (!agent || typeof kind !== 'string') return
  try {
    if (agent[FIRST_SOURCE_KEY] === undefined) agent[FIRST_SOURCE_KEY] = kind
  } catch { /* ignore */ }
}

/**
 * 记下"这个会话里用户说过话"。
 *
 * 真人消息的 source.kind 是 `'user'`（实测全库 168 次）——
 * 其余的（time-context / agent-instructions / runtime-context / skill-catalog /
 * schedule / manas-proactive …）全是系统注入或插件投递，**都不算用户在说话**。
 *
 * @param {object} agent
 * @param {boolean} hasHuman
 */
export function rememberHumanSpoke(agent, hasHuman) {
  if (!agent) return
  try {
    if (hasHuman === true) {
      agent[HAS_HUMAN_KEY] = true
      agent[HUMAN_AT_KEY] = Date.now()
    }
  } catch { /* ignore */ }
}

/**
 * 用户最后一次在这个会话说话的时刻（ms 时间戳，没有就 0）。
 *
 * 用途（2026-11-17 加）：一轮轮询会遍历**所有**顶层会话，
 * 而搭讪应该投给"用户最近待着的那个"，不是随便挑一个。
 */
export function lastHumanAt(agent) {
  try {
    return agent?.[HUMAN_AT_KEY] ?? 0
  } catch {
    return 0
  }
}

/**
 * 这个会话里用户说过话吗？
 * @param {object} agent
 */
export function humanSpoke(agent) {
  try {
    return agent?.[HAS_HUMAN_KEY] === true
  } catch {
    return false
  }
}

/**
 * 读这个会话首条 user 消息的 source.kind（没记过就是 undefined）。
 * @param {object} agent
 */
export function firstSourceKind(agent) {
  try {
    return agent?.[FIRST_SOURCE_KEY]
  } catch {
    return undefined
  }
}

/**
 * 判断一个 agent 是不是"自动化会话"（phase 会话）。
 *
 * ⚠️ 用户在这个会话里说过话 ⇒ **绝不**判成 phase。
 *    那种会话已经是真人的对话了，得正常对待（要住相、可以被搭讪）。
 *
 * @param {object} agent - dsh agent 实例
 * @param {object} [scope] - cordis scope（取 sessionTitle 用）
 * @returns {boolean}
 */
export function isPhaseAgent(agent, scope) {
  if (!agent) return false

  // 用户在这说过话 ⇒ 这是真人的对话，不是自动化会话
  if (humanSpoke(agent)) return false

  // 信号 A：首条 user 消息的 source.kind
  if (firstSourceKind(agent) === 'schedule') return true

  // 信号 B：标题
  return isPhaseTitle(titleOf(agent, scope))
}

/** 读会话标题（容错） */
function titleOf(agent, scope) {
  try {
    // 标题不在 header 里（SessionHeader 没这个字段），在 sessionTitle 服务里
    const titles = scope?.get?.('sessionTitle', false)
    const snap = titles?.get?.(agent.session)
    if (snap?.title) return String(snap.title)
  } catch { /* 服务没就绪 ⇒ 走下面的兜底 */ }
  try {
    const h = agent?.session?.header
    if (h?.title) return String(h.title)
  } catch { /* ignore */ }
  return ''
}
