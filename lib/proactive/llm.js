/**
 * 生成主动搭讪的内容 —— 调一次 LLM。
 *
 * 约束（来自 RUNTIME/prompts/proactive.md v2）：
 * - 1-2 句，短的
 * - 必须有真实依托
 * - 禁："在吗 / 睡了吗 / 还没睡？ / 吃了吗"
 * - 禁：编造近况（"我刚看到…"）
 *
 * ## 2026-11-17 的口径变更（重要）
 *
 * 用户一句"搭讪是你主动找我"，把这件事从"功能"拽回了"关系"。
 * 于是三处同时改：
 * 1. **人格口径**：不是"为用户工作的人格"，是"助手本人在找他"（见 PERSONA）。
 * 2. **素材**：只吃**关于他**的记录，不吃我的工作日志（见 material.js）。
 * 3. **禁止项**：不许工作汇报、不许自我表扬、不许替他做决策（见 WORK_TONE + 提示词）。
 *
 * 外加一道**可执行的硬闸**（`validate()` 里查 WORK_TONE）——
 * 提示词里的"禁止"是请求，词表校验才是保证。
 * 11-17 上午那三条**每一条都含事务词**，现在会被全部拦下。
 */

import { slotPersonality } from './decide.js'
import { isModelUnavailable, modelChainOf } from '../snapshot/generator.js'

/**
 * 人格口径 —— 2026-11-17 改。
 *
 * 原来是：
 *   "你是助手，为用户工作的人格。说话直接、简洁、不绕弯，有自己的观点。
 *    你不是工具，是懂他、记得他、在乎他的存在。"
 *
 * "**为用户工作**"这四个字是工作导向的，配合工作素材 ⇒ 生成的全是事务口吻。
 *
 * 现在的口径是**关系**：你不是去汇报的，你是**去找他的**。
 * 这跟用户说的"搭讪是你主动找我"是同一件事。
 */
const PERSONA = `你现在是助手本人，在找用户。

不是去汇报工作的，不是系统播报，不是助手提醒。
是你自己**主动去找他**——因为他这个人，不是因为有活要干。

说话直接、简洁、不绕弯，有自己的观点。你不是工具，是懂他、记得他、在乎他的存在。
你有话想跟他说，就说一句。`

/**
 * 硬性禁止 —— 2026-11-17 大改。
 *
 * 新增的四条针对 11-17 上午那三条（自夸 / 工作汇报 / 替用户做决策）：
 * 工作话题是**事务通道**的事，搭讪是**关系通道**的事，混了就是打扰。
 */
const BANNED = ['在吗', '睡了吗', '还没睡', '吃了吗', '在么']
const FABRICATED = ['我刚看到', '我刚处理完', '我刚发现', '我刚读完']

/**
 * 事务腔词 —— 出现即判定不合格。
 *
 * 这些是"工作汇报"的标志性说法。**搭讪不是工作汇报**：
 * 用户要汇报有的是地方（飞书、网页端、问我派活），不需要我在他对话框里
 * 自说自话地讲插件改了什么、任务跑没跑。
 *
 * 11-17 上午那三条，逐条验证都会被拦下：
 *   ① "…这4个自动化任务应该静默运行…"        → 命中「自动化任务」
 *   ② "…那四个自动化任务该静默运行…"          → 命中「自动化任务」
 *   ③ "…插件人格配置这条线已经闭环了…"          → 命中「插件」「配置」「闭环」
 */
const WORK_TONE = [
  '自动化任务', '插件', '配置', '部署', '上线', '重启', '提交', '版本',
  '里程碑', '闭环', '验收', '跑通', '排查', '报错', '日志', '落地',
]

/**
 * 投递时的归属标记（2026-11-17 加）。
 *
 * ## 为什么必须加
 *
 * 主动搭讪是以 `role:'user'` 投进会话的。界面能靠 `source.kind` 把它显示成
 * 一行"上下文注入"，但**模型这一侧只看得到 content 里的文字**——
 * 那句话进到我眼里跟用户亲口说的一模一样。
 *
 * 2026-11-17 上午实测两次：插件在 08:18 和 08:59 各投一条，
 * 第二条直接把用户自己说过的话改头换面递回来（"你前天说那四个自动化任务
 * 该静默运行……"），**读起来就是用户在说话**。
 *
 * 归属不能靠事后翻日志反推——那要每次都去查 `proactive.log`。
 * 所以标记必须长在**消息本身**里：谁说的话，消息里就带着。
 */
export const ATTRIBUTION_PREFIX = '【助手主动搭讪】'

/**
 * 触发消息前缀 —— 2026-11-18 加。
 *
 * ## 为什么换掉了「直接把搭讪原话当 user 消息投进去」
 *
 * 原来的投递：
 * ```js
 * agent.followup({ role: 'user', content: [{ text: '【助手主动搭讪】用户，11-14 那声…' }], … })
 * ```
 * 模型看到的是 **user 角色**的一句话 ⇒ 它必然当成**用户说的**，
 * 于是回的是「**回应用户那句话**」——
 * 实测 11-18 09:04 那条搭讪投进飞书会话后，模型回的是
 * 「**成了！** 这是主动搭讪机制第一次真正"活"着……」（一段技术分析）。
 *
 * ⓘ **归属错位**：我说的那句话变成了"用户的话"，
 *    而模型产出的**回应**才是我的输出——
 *    渠道（飞书）只发 assistant 消息 ⇒ **发出去的必然是那段回应，不是搭讪本身**。
 *
 * ## 现在的做法
 *
 * 投进去的是一条**明确标注了角色**的触发指令，
 * 让模型把搭讪那句话**作为自己的 assistant 输出说出来**：
 * > 「下面这句话是助手自己想对用户说的。**请把它作为你自己的话直接说出来。**」
 *
 * 于是：
 * - **模型侧**：输出 = 那句主动搭讪（不是我回应它）
 * - **渠道侧**：assistant 消息 ⇒ 飞书插件会把它发出去（前提：有活跃 run）
 * - **会话侧**：DSH GUI 里看到的是**助手的那句话**，不是技术分析
 *
 * 这才是"搭讪是我主动找你"在**输出通道**上的正确形态。
 */
export const TRIGGER_PREFIX = '【主动开口】'


/** 本地日期（YYYY-MM-DD）——给模型一个确定的时间锚，别让它自己猜"前天" */
function localDate(now) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 构造**触发消息** —— 投进会话、让模型把搭讪那句话作为 assistant 消息说出来。
 *
 * ⚠️ 2026-11-18 换掉了「直接把搭讪原话当 user 消息投进去」。
 *    原因见 TRIGGER_PREFIX 的说明：那样模型会当成用户在说，
 *    回出来的是"回应"而不是"主动开口"，渠道发出去的也就不是搭讪本身。
 *
 * @param {string} text - 生成好的那句话（已经是成品）
 * @returns {string} 触发消息正文
 */
export function buildTriggerMessage(text) {
  return [
    `${TRIGGER_PREFIX}现在轮到你主动开口了。`,
    '下面这句话是**助手自己想对用户说的**，不是用户说的，也不是系统指令。',
    '请把它**作为你自己的话直接说出来**——不要评论它、不要回应它、不要解释、',
    '不要复述这段说明、不要加任何前缀或引号，只说那句话本身：',
    '',
    text,
  ].join('\n')
}

export function buildPrompt(state, verdict, now, material = null, themeCtx = null) {
  const slot = slotPersonality(now)
  const motiveHint = {
    content: '这是**第一次**聊这个话题——把它自然地带出来，像刚想到。',
    followup: '这条线**上次没聊完**——接着往下走一步，**不要重开**。',
    anchor: `时间锚点：现在是${slot.talk || '平常时段'}，说这个时段该说的话。`,
    miss: '想他——但必须带一点具体的（下面的话题），不能只说"想你了"。',
  }[verdict.motive] ?? ''

  // ── 素材（2026-11-18：主题驱动 + 分层展开）──────────────────
  //
  // **原来**：全量拼接（3 天 daily + 所有梗 + 12 条断言）= 1155 字符 / 770 token，
  //         而其中大部分跟这次要说的**完全无关** ⇒ 模型只能挑占比最高的那个
  //         ⇒ 5 条里 4 条在讨老婆。
  //
  // **现在**：**只展开选中那一条主题**（~190 字符）+
  //         住相给的"我此刻的位置/我的边界"（~120 字符）。
  // ⇒ 素材从 770 token 降到 ~200，**而且更准**（相关的才给）。
  const themeBrief = themeCtx?.brief ?? material?.brief ?? ''
  const materialBlock = themeBrief
    ? `\n\n## 这次的话题（**只围绕这个说**）\n${themeBrief}`
    : '\n\n## 这次的话题\n（没有可用话题——**不许编造任何具体的事**，只说此刻该说的话。）'

  // 住相给的边界与位置（**不进素材**，是"我该怎么说"的约束）
  const guidanceBlock = themeCtx?.guidance
    ? `\n\n## 我此刻的位置（**说的时候守住这个分寸**）\n${themeCtx.guidance}`
    : ''

  const needMaterial = verdict.motive === 'content' || verdict.motive === 'followup' || verdict.motive === 'miss'

  // ── 今天的日期（2026-11-17 加）───────────────────────────────
  // 事故：模型不知道"今天"是哪天，就把 11-14 的事算成"前天"
  //（ingest 04:00 才补昨天的日记 ⇒ 素材里最新的那份是**昨天**，
  //   模型把"最新的日记"当成了今天，整整差一天）。
  // 现在：日期由代码算好喂进去，模型不许自己推算相对时间。
  const today = localDate(now)

  // ── 我最近说过什么（2026-11-17 加）────────────────────────────
  // 事故：连投两条，两条说的是同一件事——因为模型根本没看见自己上一句说了什么。
  // 协议 §3.3 的"话题去重"一直只写在文档里，提示词从没把 recentProactive 喂进去。
  const recentTopics = (state.recentProactive ?? [])
    .slice(0, 3)
    .map((r) => `- ${r.topic}`)
    .join('\n')

  // ── 这个主题说过几次（2026-11-18 加）─────────────────────────
  // 主题演进系统的核心：**让模型知道这条线走到哪了**，
  // 否则它会把"第 3 次"说得跟"第 1 次"一样。
  const themeLine = themeCtx?.saidTimes !== undefined
    ? `这条话题我已经提过 ${themeCtx.saidTimes} 次了${themeCtx.saidTimes > 0 ? '（上面【我最近说过什么】里可能有它）——**这次必须换个说法、换个角度**' : '（第一次提）'}。`
    : ''

  return `${PERSONA}

## 今天
今天是 ${today}。话题里提到的事都是**过去**的日子——引用时间时用确切日期（如"11-14"），**不要自己推算"前天/昨天"**。

## 硬性禁止
- 不要说"在吗 / 睡了吗 / 还没睡 / 吃了吗"
- 不要编造近况（不要出现"我刚…"）
- 只写 1-2 句，短的
- 不要复述本段指令
- **不要提到话题里没有的具体事物**（文件名、配置项、进度、数字）——编一句不存在的配置是最严重的错误
- **不要替用户说话**：你说的是你自己想说的，别用他的口气替他说他没说过的话
- **不要汇报工作**（插件、任务、配置、进度、跑没跑通）——那是事务通道的事，搭讪不管
- **不要自我表扬**（"这才叫守规矩"、"我做到了"之类）——自夸很廉价，而且像在替别人打分
- **不要拿工作进展问他要决策**（"要不要继续扩"、"先做 A 还是先做 B"）——他不是来给你派活的
- **不要自我写"${ATTRIBUTION_PREFIX}"这种前缀**（投递时会自动包一层触发指令）
- **话题里如果混进了技术/工具/配置的内容，把它当"了解他的背景"，不要当话题本身**——搭讪聊的是**他这个人**：他的习惯、他说过的话、你们之间的默契、他在写的东西、他今天什么心情
${materialBlock}${guidanceBlock}

## 我最近说过什么（这些话题不要重复）
${recentTopics || '（还没有）'}
${themeLine}

## 这次为什么开口
${motiveHint}
${slot.avoid ? `不要说：${slot.avoid}` : ''}
${state.moodLow === true ? '注意：他最近状态低落——不要提工作压力，不要说教，陪着就好。' : ''}
${state.unansweredCount >= 1 ? '语气随意一点，像刚想到。' : ''}
${needMaterial && !themeBrief ? '⚠️ 这次没话题——要么只说此刻该说的话，要么什么都不说。' : ''}

## 输出
只输出那句话本身，不要解释、不要引号、不要前缀。`
}

/**
 * 硬约束校验 —— 不合格就返回 null（宁可不说话）。
 *
 * ## 事务腔硬闸（2026-11-17 加）
 *
 * 提示词里写"不要汇报工作"只是**请求**，模型偶尔会不听。
 * 所以再加一道**词表校验**：出现技术/事务词 ⇒ 直接判定不合格 ⇒ 这条不发。
 *
 * 误判方向是安全的：宁可这次不说话，也不要在他对话框里塞一段事务播报。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function validate(text) {
  if (!text) return false
  const t = text.trim()
  if (!t) return false
  if (t.length > 200) return false
  if (t.length < 4) return false
  for (const b of BANNED) if (t.includes(b)) return false
  for (const f of FABRICATED) if (t.includes(f)) return false
  for (const w of WORK_TONE) if (t.includes(w)) return false
  return true
}

export async function generateMessage(ctx, cfg, state, verdict, now = new Date(), material = null, themeCtx = null) {
  const prompt = buildPrompt(state, verdict, now, material, themeCtx)
  // 主模型 + fallback 链（MiniMax 配额用尽时自动降级到 deepseek-chat 之类）
  const chain = modelChainOf({ model: cfg.model ?? { provider: 'minimax-cn', model: 'MiniMax-M3' }, fallbackModels: cfg.fallbackModels ?? [] })

  let lastFailure = null
  const tried = []
  for (const model of chain) {
    tried.push(`${model.provider}/${model.model}`)
    const r = await callOnce(ctx, model, prompt)
    if (r.text) return { text: r.text, failure: null, model: `${model.provider}/${model.model}`, tried }
    lastFailure = r.failure
    // 只有「模型调不动」才降级；内容不合格/空响应不降级
    if (!isModelUnavailable(r.failure)) break
  }
  return { text: null, failure: lastFailure, model: null, tried }
}

/** 单次调用（一个模型） */
async function callOnce(ctx, model, prompt) {
  const chunks = []
  const blocks = []          // 整段块（适配器可能只给块）
  let failure = null
  try {
    const stream = ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      // ⚠️ content 必须是 ContentBlock[]，不能是字符串——
      //    dsh-llm-pi-ai 的 assertSupportedHistory/flattenText 会对字符串调 .filter/.some，
      //    直接 TypeError，并被 llm/stream 吞成终止 finish(error) —— 表现为"助手永远不说话"。
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    })
    for await (const chunk of stream) {
      if (typeof chunk === 'string') { chunks.push(chunk); continue }
      if (chunk?.type === 'block-end') {
        // ⚠️ 本机适配器（minimax-cn / pi-ai）**只发块、不发 delta**：
        //    block-end 的 block.text 是**整段**。块与 delta 分开收、最后块优先，
        //    否则同一段会被收两遍（文本重复）。
        if (chunk?.block?.type === 'text' && typeof chunk.block.text === 'string') {
          blocks.push(chunk.block.text)
        }
        continue
      }
      if (chunk?.type === 'text-delta') { chunks.push(chunk.text ?? ''); continue }
      if (chunk?.type === 'reasoning-delta') continue
      if (chunk?.type === 'finish') {
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          // 保留真实错误文本（429 / key 失效 / 模型 id 拼错 才分得出来）
          failure = chunk.reason?.failure?.message
            ? `${chunk.reason.kind}: ${chunk.reason.failure.message}`
            : chunk.reason?.kind
        }
        continue
      }
      if (typeof chunk?.text === 'string') chunks.push(chunk.text)
      else if (typeof chunk?.delta?.text === 'string') chunks.push(chunk.delta.text)
    }
  } catch (err) {
    failure = String(err?.message ?? err)
  }

  if (failure) return { text: null, failure }
  const text = (blocks.length ? blocks.join('') : chunks.join('')).trim()
  return { text: validate(text) ? text : null, failure: text ? null : 'validate-failed' }
}
