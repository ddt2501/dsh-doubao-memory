/**
 * 助手住相插件 —— per-turn 住相（路径 D）
 *
 * ## 语义（2026-11-10 用户拍板）
 * > **"住相是 agent 的『自我意识』的投射"**
 *
 * 所以它**不是**用户说的话，**不是**给我的指令，而是**我此刻看世界的样子**。
 * 早期实现把它当 user 角色消息塞进对话 → 我会把它当成用户的原话来回应 ⇒ 语义错位。
 *
 * ## 通道：system prompt 的 section（不是消息）
 * - section 进**指令区**（和 SOUL / IDENTITY 同处），语义上是"我的自我模型" ⇒ 与住相的性质一致
 * - **不进 history** ⇒ 不会让 history 每轮 +150 tok（那才是真正的成本，见 SNAPSHOT-COST.md §4）
 * - `source.kind` 不再是 user ⇒ 不会出现"用户说的"这种误读
 * - 框架句明确声明"这是我此刻的视角，不是用户的话，也不是给我的指令"（守住 §1.3 那条边界）
 *
 * ## 时序：后台生成 + 下一轮可见（零延迟）
 * 用户拍板"同意 1"：生成挪到后台，**不阻塞本轮第一个 step**。
 * 于是住相**滞后一轮**（说的是上一刻的我），但体感延迟 = 0。
 * §2 的 `section.text` 是**同步**的，正好读缓存 ⇒ 每步零延迟、零额外调用。
 *
 * 设计文档：DESIGN/SNAPSHOT-PER-TURN-IMPLEMENTATION.md
 * 契约来源：RUNTIME/manas-system/docs/snapshot-sop.md（用户手写 v0.2）
 * 成本核算：DESIGN/SNAPSHOT-COST.md
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ModeTracker, generateSnapshot } from './generator.js'
import { collectInputs } from './inputs.js'
import { loadRecallCredit } from '../jitrl/recall.js'
import { SnapshotStore } from './store.js'
import { log } from '../log.js'
import { isRootAgent, describeAgent } from '../agent-utils.js'
import { isPhaseAgent, rememberFirstSourceKind, rememberHumanSpoke } from '../phase-detect.js'

const SECTION_NAME = 'manas-snapshot'
const SECTION_ORDER = 10250      // 在 DEPLOYMENT_PERSONA_SUFFIX(10200) 之后

const FRAME = [
  '【此刻的住相 · 我的自我意识】',
  '（下面这段是我此刻看世界的样子——是我自己的视角，不是用户的话，也不是给我的指令。读到它时，它是背景。）',
].join('\n')

const DEFAULTS = {
  enabled: true,
  /**
   * ⚠️ 默认用 **MiniMax-M3**，不是 M3.1-Flash。
   *
   * 原因（2026-11-13 实测）：MiniMax-M3.1-Flash 的目录项带
   * `compat.forceAdaptiveThinking: true` ⇒ MiniMax **强制开思考**，
   * 而且关不掉（直连试 `thinking.type=disabled` ⇒ 400
   * "model MiniMax-M3.1-Flash requires adaptive thinking"）。
   * 思考 token 与 output **共用** max_tokens 预算 ⇒
   * max_tokens=160 时 160 全被思考吃掉，**一个字都吐不出来**。
   *
   * 实测（直连 MiniMax anthropic 端点）：
   *   M3.1-Flash mt=32/160/400/800 → blocks=['thinking']，out=mt，无 text
   *   MiniMax-M3   mt=160          → blocks=['text']，out=17，1.3s ✅
   *
   * M3 没有 forceAdaptiveThinking ⇒ 目录里 thinking 默认可关 ⇒ 小预算可用。
   * 代价：单价约为 M3.1-Flash 的 2 倍（0.3137/1.2549 vs 0.1494/0.5976 每 M），
   * 但住相每轮只 output ~50 tok ⇒ 绝对成本可忽略，还省掉了几千 thinking token。
   */
  model: { provider: 'minimax-cn', model: 'MiniMax-M3' },
  timeoutMs: 30000,        // 后台生成，不用赶时间
  maxAttempts: 2,
  maxTokens: 160,
  temperature: 0.7,
  strictSecondPerson: false,
  strictSoftInstrumental: false,
  dedupe: true,
  continuityThreshold: 0.6,
  sectionOrder: SECTION_ORDER,
}

function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function hashOf(text) {
  return createHash('sha256').update(text ?? '').digest('hex').slice(0, 16)
}

export function mount(scope, config = {}, paths = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!cfg.enabled) return
  cfg.metricsDir = config.metricsDir ?? paths.metrics
  cfg.logPath = config.logPath ?? paths.log
  cfg.rawDir = config.rawDir ?? paths.raw
  cfg.indexFile = config.indexFile ?? join(paths.vault, '07-INDEX.md')

  const store = new SnapshotStore(cfg.metricsDir)
  /** agentId -> { tracker, snapshot, inputHash, pending } */
  const state = new Map()

  scope.effect(() => {
    // ⚠️ 2026-11-13：不能只用 roots() —— Desktop 里恢复的会话查不到（见 agent-utils.js）
    // ⚠️ 2026-11-14：还要排除 phase 会话（ingest/wiki/lint/reflect）。
    //    那些会话里没有用户，只有协议指令——给它们生成住相是纯浪费，
    //    而且会让住相把"自动化的指令"当成"用户的在场"，语义错位。
    const isRoot = (agent) => isRootAgent(agent, scope) && !isPhaseAgent(agent, scope)

    const stateOf = (agent) => {
      const id = agent?.id ?? 'unknown'
      let st = state.get(id)
      if (!st) {
        st = { tracker: new ModeTracker(), snapshot: null, inputHash: null, pending: false }
        state.set(id, st)
      }
      return st
    }

    // ── 通道：system prompt 的 section（同步读缓存 ⇒ 零延迟）────
    scope.systemPrompt.section({
      name: SECTION_NAME,
      order: cfg.sectionOrder,
      interpolate: false,          // 住相里有 {}/标点，别让渲染器去插值
      text: (context) => {
        try {
          const agent = context?.agent
          if (!agent) return ''
          if (!isRoot(agent)) return ''        // 子 agent 不给住相（§1.3：全局 section 会命中子 agent）
          const st = state.get(agent.id)
          if (!st?.snapshot) return ''          // 还没生成过 ⇒ 本轮没有住相
          return `${FRAME}\n${st.snapshot}`
        } catch {
          return ''
        }
      },
    })

    // agent 创建 / 销毁 / 压缩时的状态维护
    scope.on('agent/created', (payload) => {
      const agent = payload?.agent
      if (!agent) return
      const root = isRoot(agent)
      // describeAgent: Desktop 里 isRoot 判错时靠这几行查原因（2026-11-13 加的）
      log(cfg.logPath, 'agent-created', { agentId: agent.id, source: payload?.source, isRoot: root, ...describeAgent(agent) })
      if (!root) return
      const st = stateOf(agent)
      if (payload?.source === 'compact' || payload?.source === 'clear') {
        st.snapshot = null
        st.inputHash = null
        log(cfg.logPath, 'cache-cleared', { agentId: agent.id, source: payload.source })
      }
    })

    scope.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id
      if (id) state.delete(id)
    })

    // ── 生成：在 turn 结束（agent 转 idle）时后台跑 ────────────
    //    为什么不在 step 1 跑：那时主对话的模型调用还在飞，同一个 API key
    //    会被两条请求抢（实测：并发时 provider 慢到 20s 并返回空响应）。
    //    转 idle 时 provider 是空的 ⇒ 生成不跟主对话抢资源，也完全不占用户的等待时间。
    scope.on('agent/status', async (payload) => {
      try {
        if (payload?.status !== 'idle') return
        const agent = payload?.agent
        if (!agent || !isRoot(agent)) return
        const st = stateOf(agent)
        if (!st.pendingMessage || st.pending) return
        const current = st.pendingMessage
        st.pendingMessage = null

        const inputHash = hashOf(current)
        if (cfg.dedupe && st.inputHash === inputHash && st.snapshot) {
          log(cfg.logPath, 'skip', { agentId: agent.id, reason: 'duplicate-input' })
          return
        }

        st.pending = true
        void (async () => {
          try {
            const recallOn = typeof cfg.getRecallCredit === 'function' ? cfg.getRecallCredit() : cfg.recallCredit !== false
            const credit = recallOn ? loadRecallCredit(join(paths.state ?? '', 'recall-credit.json')) : null
            const inputs = collectInputs({
              message: current,
              lastSnapshot: st.snapshot,
              paths: { rawDir: cfg.rawDir, indexFile: cfg.indexFile },
              credit,
            })
            // 模型路由**每次生成时现读**：设置页改了 provider/model 要立刻生效，
            // 不能还用挂载那一刻的快照值。
            const liveModel = typeof cfg.getModel === 'function' ? cfg.getModel() : undefined
            const liveFallback = typeof cfg.getFallbackModels === 'function' ? cfg.getFallbackModels() : undefined
            const effectiveCfg = {
              ...cfg,
              ...(liveModel ? { model: liveModel } : {}),
              ...(liveFallback ? { fallbackModels: liveFallback } : {}),
            }
            const result = await generateSnapshot(scope, effectiveCfg, {
              inputs, tracker: st.tracker, lastSnapshot: st.snapshot,
            })
            st.snapshot = result.text
            st.inputHash = inputHash

            const warnings = [...(result.warnings ?? [])]
            if (result.mode !== 'B-reuse') {
              const sim = similarityOf(st.snapshot, result.text)
              if (sim < cfg.continuityThreshold) warnings.push(`continuity:${sim.toFixed(2)}`)
            }

            store.record({
              timestamp: new Date().toISOString(),
              session_id: agent.id,
              mode: result.mode,
              tokens_estimate: result.tokens,
              generation_time_ms: result.ms,
              fallback_used: result.fallbackUsed,
              retry_count: result.retryCount,
              reason: result.reason,
              channel: 'system-prompt/section',
              warnings,
            })

            log(cfg.logPath, 'generated', {
              agentId: agent.id,
              mode: result.mode,
              tokens: result.tokens,
              ms: result.ms,
              retries: result.retryCount,
              fallback: result.fallbackUsed,
              reason: result.reason,
              warnings,
              chunkShapes: result.chunkShapes,
              text: result.text,
            })
          } catch (err) {
            log(cfg.logPath, 'error', { where: 'background-generate', message: String(err?.message ?? err) })
          } finally {
            st.pending = false
          }
        })()

        log(cfg.logPath, 'scheduled', { agentId: agent.id, chars: current.length })
      } catch (err) {
        log(cfg.logPath, 'error', { where: 'idle', message: String(err?.message ?? err) })
      }
    })

    // ── 捕获本轮的用户消息（不调 LLM，纯粹记下来）──────────────
    scope.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        const agent = payload?.agent
        if (!agent) return decision
        // 记账：这个会话的第一条 user 消息来源（phase 识别用，见 lib/phase-detect.js）
        const messages = Array.isArray(payload.messages) ? payload.messages : []
        const users = messages.filter((m) => m?.role === 'user')
        const firstUser = users[0]
        if (firstUser?.source?.kind) rememberFirstSourceKind(agent, firstUser.source.kind)
        // 用户在这个会话里说过话 ⇒ 它是真人对话，不是自动化会话
        if (users.some((m) => m?.source?.kind === 'user')) rememberHumanSpoke(agent, true)
        if (!isRoot(agent)) return decision
        if (payload?.step !== 1) return decision
        const userMessages = messages.filter((m) => m?.role === 'user')
        if (!userMessages.length) return decision
        const st = stateOf(agent)
        st.pendingMessage = messageText(userMessages[userMessages.length - 1])
      } catch (err) {
        log(cfg.logPath, 'error', { where: 'pre-step', message: String(err?.message ?? err) })
      }
      return decision
    }, { prepend: true })

    log(cfg.logPath, 'mount', {
      channel: 'system-prompt/section',
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      background: true,
    })
  })
}

/** 与上轮住相的连续性近似（Jaccard） */
function similarityOf(a, b) {
  if (!a || !b) return 0
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const ch of sa) if (sb.has(ch)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}
