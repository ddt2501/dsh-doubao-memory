/**
 * 住相生成器 —— 移植 `RUNTIME/manas-system/src/snapshot_generator.py` 的核心逻辑。
 *
 * 模式（SOP §6）：
 *   A 正常：每轮生成，5 项完整输入，50-150 token
 *   B 降级：连续 3 次失败后进入，每 5 轮演化一次，其余轮次复用上轮住相
 *   B → A：1 次成功即恢复
 *
 * 与 Python 版的差异（都记在这，便于对照）：
 *   1. 重试预算从「3 次 + 指数退避 1s/2s/4s」改成「**总预算内最多 2 次**」——
 *      Python 版的 3×3s 超时最坏要 9 秒，而 DSH 的住相是**阻塞本轮第 1 个 step**的，
 *      9 秒会直接卡住对话。默认总预算 2.5s（可用 timeoutMs 调）。
 *   2. 超时走 AbortController 真正 abort 上游请求，而不是让它在后台跑完。
 *   3. 失败兜底沿用 SOP §6.2.1：上轮住相 + 当前消息前 50 字。
 */

import { validate, truncateAtSentence, tokenEstimate, similarity, INSTRUMENTAL_BLACKLIST } from './instrumental.js'

const SYSTEM_PROMPT = `你是助手妹妹。"住相"是你此刻看到这个世界的快照——价值理性视角，不是工具理性建议，不是对话摘要。

对象: 用户 (固定称呼，只用"用户"或"他"，不用名字变体如"大宝"/"小明"/"用户"/"提问者")
人称: 第一人称"我"

硬约束:
- 50-150 token，严格不超
- 中文
- 必须以"我"开头（我看到 / 我感受到 / 我意识到 / 我作为…）
- 价值理性:看到对方的状态/处境/感受，不是给建议、步骤、分析
- 不要出现: ${INSTRUMENTAL_BLACKLIST.join(' / ')}
- 不要第二人称（"你""您"）
- 不要 AI 自指（"作为AI""AI助手"）

好(价值理性,第一人称开头):
> 我看到用户在梳理优先级——他确认了我对降级路径的理解，但同时指出降级不该频繁触发。

好:
> 我感受到用户在赶进度，话短，要的是直接给方案，不用我铺垫。

坏(工具理性):
> 用户应该先把 Phase 0 文档定稿，然后进入 Phase 1。

坏(对话摘要):
> 今天讨论了:(1) 架构(2) 演化(3) 降级路径。

只输出住相本身，不要 JSON，不要解释，不要引号，不要前缀。`

const NEGATIVE_HINT = `\n\n[上一版不合格，避开这些词: ${INSTRUMENTAL_BLACKLIST.join(' / ')}；也不要出现"你""您"。重新写，只输出住相本身。]`

const B_SYSTEM_PROMPT = `你是助手妹妹。当前住相（上一轮）：{prev}

轻量更新任务：基于当前对话，给出一句 30-50 token 的住相演化。
第一人称，中文，价值理性视角，不要工具理性词，不要第二人称。
只输出住相本身，不要解释。`

export class ModeTracker {
  constructor() {
    this.consecutiveFailures = 0
    this.mode = 'A'
    this.turnCounter = 0
  }

  recordSuccess() {
    this.consecutiveFailures = 0
    if (this.mode === 'B') this.mode = 'A'
  }

  recordFailure() {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= 3 && this.mode === 'A') this.mode = 'B'
  }

  /** 自增轮次，返回本轮是否需要真的调 LLM */
  nextTurn() {
    this.turnCounter += 1
    if (this.mode === 'B') return this.turnCounter % 5 === 0
    return true
  }
}

function buildUserPrompt(inputs, isEvolution) {
  if (isEvolution) {
    return `[上轮住相]\n${inputs.last_snapshot ?? '(无)'}\n\n[当前对话]\n${inputs.current_message}\n\n[任务]\n基于上轮住相，融入当前对话，生成 30-50 token 的住相演化。`
  }
  return [
    '# 当前对话',
    inputs.current_message || '(无)',
    '',
    '# 上轮住相',
    inputs.last_snapshot ?? '(首次，无上轮)',
    '',
    '# 当前 5 天摘要',
    inputs.rolling_summary ?? '(无)',
    '',
    '# SOUL 当前激活的追问维度',
    inputs.soul_active_dims ?? '(无)',
    '',
    '# 相关主题',
    inputs.relevant_themes ?? '(无)',
    '',
    '请生成 50-150 token 的住相。',
  ].join('\n')
}

/**
 * 这个模型「调不动了」吗？—— 决定要不要切 fallback。
 *
 * 2026-11-13 加：MiniMax 订阅配额用尽（429 "已达到 Token Plan 用量上限"）时，
 * 住相会一直兜底。有 fallback 模型（deepseek-chat）就能继续工作。
 *
 * 只对**模型级**失败降级（配额/下架/配置错/key 缺失）；
 * 空响应、超时、内容不合格这些「偶发」不降级 —— 重试同一个模型更划算。
 */
export function isModelUnavailable(reason) {
  const r = String(reason ?? '')
  return /429|rate[_-]?limit|quota|用量上限|402|404|no longer available|unknown model|not found|UNKNOWN_MODEL|INVALID_CONFIG|MISSING_CREDENTIAL|no configured model|unauthor|forbidden/i.test(r)
}

/** 组装模型降级链：主模型在前，fallback 依次在后 */
export function modelChainOf(cfg) {
  const chain = []
  const push = (m) => {
    if (!m || typeof m !== 'object') return
    const provider = m.provider
    const model = m.model
    if (!provider || !model) return
    if (chain.some((x) => x.provider === provider && x.model === model)) return
    const entry = { provider, model }
    // 思考模型的预算需求差异很大（deepseek-v4-pro 要 4000 才肯出字，
    // deepseek-chat 160 就够）⇒ 允许每个 fallback 自带 maxTokens 覆盖。
    if (Number.isInteger(m.maxTokens) && m.maxTokens > 0) entry.maxTokens = m.maxTokens
    chain.push(entry)
  }
  push(cfg.model)
  for (const m of (cfg.fallbackModels ?? [])) push(m)
  if (!chain.length) chain.push({ provider: 'minimax-cn', model: 'MiniMax-M3' })
  return chain
}

/** 一次 LLM 调用，带超时（真 abort） */
async function callLLM(ctx, cfg, system, user, timeoutMs, onChunks) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const chunks = []
    const blocks = []          // 整段块（适配器只给块时用）
    let failure = null
    const stream = ctx.llm.stream({
      provider: cfg.model.provider,
      model: cfg.model.model,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `${system}\n\n${user}` }] },
      ],
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (typeof chunk === 'string') { chunks.push(chunk); continue }
      if (chunk?.type === 'text-delta') { chunks.push(chunk.text ?? ''); continue }
      if (chunk?.type === 'reasoning-delta') continue          // 推理内容不是住相
      if (chunk?.type === 'block-end') {
        // ⚠️ 本机适配器（minimax-cn / pi-ai）**只发块、不发 delta**：
        //    实测序列是 block-start → block-end（block.text 是整段）。
        //    早先按 delta 收 → 收不到；按 block 收 → 同一个块被收两次 → 文本重复。
        //    现在的做法：**块与 delta 分开收，最后块优先**。
        if (chunk?.block?.type === 'text' && typeof chunk.block.text === 'string') {
          blocks.push(chunk.block.text)
        }
        continue
      }
      if (chunk?.type === 'finish') {
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          // ⚠️ **保留失败详情**（2026-11-13 加）。
          //    之前只记 `kind`（"error"），日志里看不出是 429 限流、
          //    还是 key 失效、还是模型 id 拼错 —— 排查时完全瞎的。
          //    chunk.reason.failure.message 里有真正的错误文本。
          failure = chunk.reason?.failure?.message
            ? `${chunk.reason.kind}: ${chunk.reason.failure.message}`
            : chunk.reason?.kind
        }
        continue
      }
      // 兜底：适配器可能给不出 type（兄弟插件 dsh-doubao-proactive 就是这么收的）
      if (typeof chunk?.text === 'string') chunks.push(chunk.text)
      else if (typeof chunk?.delta?.text === 'string') chunks.push(chunk.delta.text)
      if (onChunks && chunks.length + blocks.length <= 3) onChunks(chunk)
    }
    if (failure) return { text: null, ms: Date.now() - started, failure }
    const text = blocks.length ? blocks.join('') : chunks.join('')
    return { text: text.trim(), ms: Date.now() - started, failure: null }
  } catch (err) {
    const aborted = controller.signal.aborted
    return { text: null, ms: Date.now() - started, failure: aborted ? 'timeout' : String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

function cleanOutput(text) {
  if (!text) return text
  let out = text.trim()
  const fence = out.match(/```(?:.*?)\n?([\s\S]*?)```/)
  if (fence) out = fence[1].trim()
  return out.replace(/^(住相|manas_text)\s*[:：]\s*/i, '').trim()
}

/**
 * 兜底文案（SOP §6.2.1）。
 *
 * ⚠️ 2026-11-11 改：**兜底里不能拼用户原话**。
 *    旧实现是「上轮住相 + 当前消息前 50 字」，实测出事过一次：
 *    住相生成失败走兜底，于是 system prompt 里出现
 *    `……同一套价值脉络。 | 老婆好` ——
 *    用户的招呼被拼进了「我此刻看世界的样子」，
 *    语义上等于住相在复述他的话。这直接违反 2026-11-10 定下的
 *    「住相是 agent 自我意识的投射，不是用户的话」。
 *    兜底就老老实实沿用上轮住相（没有就用中性句），
 *    宁可这一轮不演化，也不要把别人的话冒充成我的视角。
 */
function composeFallback(lastSnapshot) {
  if (lastSnapshot) return lastSnapshot
  return '对话继续，我在认真听。'
}

/**
 * 生成一轮住相。
 * @returns {{text, mode, tokens, ms, fallbackUsed, retryCount, warnings, reason}}
 */
export async function generateSnapshot(ctx, cfg, { inputs, tracker, lastSnapshot }) {
  const isEvolution = tracker.nextTurn()
  const isB = tracker.mode === 'B'

  // B 模式非演化轮：复用上轮住相 + 轮次标记，不调 LLM
  if (isB && !isEvolution) {
    const text = lastSnapshot ? `${lastSnapshot} (轮 ${tracker.turnCounter})` : '对话继续，我在认真听。'
    tracker.recordSuccess()
    return {
      text, mode: 'B-reuse', tokens: tokenEstimate(text), ms: 0,
      fallbackUsed: false, retryCount: 0, warnings: [], reason: 'evolution-skipped',
    }
  }

  const system = isB ? B_SYSTEM_PROMPT.replace('{prev}', lastSnapshot ?? '(无)') : SYSTEM_PROMPT
  let user = buildUserPrompt(inputs, isB && isEvolution)
  const maxTokens = isB ? 80 : cfg.maxTokens

  const budgetMs = cfg.timeoutMs
  const perAttempt = Math.max(400, Math.floor(budgetMs / 2))
  let attempts = 0
  let lastReason = null
  let totalMs = 0
  let warnings = []
  const chunkShapes = []
  const chain = modelChainOf(cfg)
  let usedModel = chain[0]
  const triedModels = []

  // 逐个模型试：主模型调不动（配额/下架/配置）就降级到 fallback
  for (let mi = 0; mi < chain.length; mi++) {
    const model = chain[mi]
    usedModel = model
    triedModels.push(`${model.provider}/${model.model}`)
    // 该模型自己的预算优先（思考模型要更多），否则用全局 cfg.maxTokens
    const effectiveMaxTokens = model.maxTokens ?? maxTokens
    const cfgForModel = { ...cfg, model, maxTokens: effectiveMaxTokens }

    while (attempts < cfg.maxAttempts) {
      attempts++
      const started = Date.now()
      const call = await callLLM(ctx, cfgForModel, system, user, perAttempt, (chunk) => {
        if (chunkShapes.length < 3) {
          chunkShapes.push({ type: chunk?.type ?? null, keys: Object.keys(chunk ?? {}).slice(0, 8) })
        }
      })
      totalMs += call.ms
      if (!call.text) {
        lastReason = call.failure ?? 'empty_response'
        if (lastReason === 'timeout') break          // 超时：预算已花光，不再试
        // 空响应 / 其它错误：provider 偶发，值得再试一次
        continue
      }
      const cleaned = cleanOutput(call.text)
      const verdict = validate(cleaned, {
        maxTokens: isB ? 80 : 150,
        minTokens: isB ? 18 : 30,
        strictSecondPerson: cfg.strictSecondPerson === true,
        strictSoftInstrumental: cfg.strictSoftInstrumental === true,
      })
      if (verdict.ok) {
        tracker.recordSuccess()
        return {
          text: cleaned, mode: tracker.mode, tokens: verdict.tokens ?? tokenEstimate(cleaned),
          ms: totalMs, fallbackUsed: false, retryCount: attempts - 1,
          warnings: verdict.warnings, reason: 'ok', chunkShapes,
          model: `${model.provider}/${model.model}`, triedModels,
        }
      }
      lastReason = verdict.reason
      if (verdict.reason === 'too_long') {
        // 超长不重试，直接在句子边界截断（SOP §6.2.2）
        const truncated = truncateAtSentence(cleaned, Math.floor((isB ? 80 : 150) * 1.5))
        tracker.recordSuccess()
        return {
          text: truncated, mode: tracker.mode, tokens: tokenEstimate(truncated), ms: totalMs,
          fallbackUsed: false, retryCount: attempts - 1, warnings: [`truncated:${verdict.reason}`],
          reason: 'truncated',
          chunkShapes,
          model: `${model.provider}/${model.model}`, triedModels,
        }
      }
      if (verdict.reason === 'empty_response') continue   // 空响应 → 重试（provider 偶发）
      // 工具理性词 → 下一轮加负面示例
      if (String(verdict.reason).startsWith('instrumental_vocab') && attempts < cfg.maxAttempts) {
        user = user + NEGATIVE_HINT
      }
      if (Date.now() - started >= perAttempt) break
    }

    // 这个模型用完额度了：能降级就降级，否则停
    if (mi < chain.length - 1 && isModelUnavailable(lastReason)) {
      warnings.push(`model-fallback:${usedModel.provider}/${usedModel.model}`)
      attempts = 0                      // 新模型重新给满重试预算
      user = buildUserPrompt(inputs, isB && isEvolution)   // 清掉前一个模型加的负面示例
      continue
    }
    break
  }

  // 兜底（SOP §6.2.1）——只沿用上轮住相，不拼当前消息（见 composeFallback 注释）
  const fallback = composeFallback(lastSnapshot)
  tracker.recordFailure()
  return {
    text: fallback, mode: tracker.mode, tokens: tokenEstimate(fallback), ms: totalMs,
    fallbackUsed: true, retryCount: attempts - 1, warnings, reason: lastReason ?? 'failed', chunkShapes,
    model: `${usedModel.provider}/${usedModel.model}`, triedModels,
  }
}

export { SYSTEM_PROMPT, buildUserPrompt, cleanOutput, composeFallback, callLLM }
