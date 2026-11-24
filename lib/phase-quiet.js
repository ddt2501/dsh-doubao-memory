/**
 * phase 会话静默 —— 四个自动化任务不该在用户的会话列表里冒泡。
 *
 * ## 问题
 *
 * DSH 的 schedule 每次触发都**新建一个会话**（`target.kind === 'new'`，
 * 见 lib/memory-system.js 的 DEFAULT_TARGET_MODE）。
 * 于是每跑一次 ingest/wiki/lint/reflect，侧边栏就多一个会话。
 * 客户端按 `updatedAt` 排序（`dsh-client-ui-workspace/src/client/tree.ts:145`
 * `orderByRecency`）⇒ **刚跑完的 phase 会话排在最上面**。
 *
 * 后果（2026-11-14 实测）：
 *   17:54 ingest 触发 → 新会话出现 → 它成了列表第一个 →
 *   用户打开界面，看到的就是这个自动化会话 → 他的下一句话投了进去 →
 *   主对话被"挤"到一边。
 *
 * ## 解法：跑完就归档
 *
 * DSH **没有** hidden/ephemeral/automation 标记（`SessionHeader` 只有 9 个字段，
 * `origin` 只能是 `'subagent'`）—— 唯一的隐藏杠杆是**归档**
 * （`ctx.workspaceRegistry.archiveSession`）。
 * 归档后：
 *   - 侧边栏默认过滤掉（`archivedFilter: 'default'`，tree.ts:237-239）
 *   - 仍然可以在"全部对话（显示已归档）"里找到 ⇒ **可追溯，没丢**
 *   - 不会被自动选中当主会话
 *
 * 为什么用 `new` + 归档，而不是 `new_once` + 常驻：
 *   `new_once` 会让所有 phase 挤在一个会话里，历史互相污染；
 *   而且归档后 DSH 的 ArchivedSessionGate 会挡住它的下一步（archived-session-gate.ts:29）
 *   ⇒ 下次投递进不去。`new` 每次开新会话 ⇒ 归档不影响下次的投递。
 *
 * ## 安全性
 *
 * **只归档"确认收到过 schedule 消息"的会话** ⇒ 绝不会是用户正在聊的会话。
 * 归档时不带 `stopActivity` ⇒ 忙碌的会话会被 Workspace 拒绝归档
 * （`WorkspaceActiveSessionError`），我们只是记一条日志、跳过。
 */

import { log } from './log.js'

/** 我们的四个 phase 任务标题前缀 */
import { getPhaseTitlePrefix } from './phase-detect.js'

/**
 * 挂载 phase 静默处理。
 *
 * @param {object} scope - cordis scope（已注入 agents / workspaceRegistry / schedule）
 * @param {object} paths - 路径解析结果
 * @param {string} logPath
 */
export function mount(scope, paths = {}, logPath = '') {
  /** 已经确认是 phase 会话的 agent id → 会话 id */
  const phaseSessions = new Map()

  // 挂载标记 —— 用来确认"新代码真的进来了"（2026-11-14 加：
  // 光看 proactive.log 的 mount 事件不能证明是新版，因为那个文件没变）。
  log(logPath, 'mount', { module: 'phase-quiet', version: '2026-11-14' })

  scope.effect(() => {
    // ── 1. 认出 phase 会话 ────────────────────────────────────
    // schedule 投递的 user 消息 source.kind 恒为 'schedule'
    // （dsh-schedule/src/runtime.ts:353）。
    //
    // ⚠️ **但不能只看第一条**：如果用户在这个 phase 会话里说过话
    //    （他的真人消息 source.kind 是 'user'——实测全库 168 次，
    //    而系统注入是 time-context / agent-instructions / runtime-context 等），
    //    这个会话就**已经变成真人对话**了 ⇒ 绝不能归档，
    //    否则用户正在聊的内容会凭空消失。
    //    ——这正是 2026-11-14 17:57 那次事故的现场：
    //    用户的话被投进了 ingest 会话，那个会话既在跑 phase 又有真人在说话。
    const onPreStep = async (payload, next) => {
      try {
        const agent = payload?.agent
        const messages = Array.isArray(payload?.messages) ? payload.messages : []
        const users = messages.filter((m) => m?.role === 'user')
        const firstUser = users[0]
        if (agent && firstUser?.source?.kind === 'schedule') {
          const id = sessionIdOf(agent)
          if (id) {
            // 真人发言过 ⇒ 标记成"有真人"，不归档
            const hasHuman = users.some((m) => m?.source?.kind === 'user')
            phaseSessions.set(agent, { id, hasHuman })
            log(logPath, 'phase-detected', { sessionId: id, hasHuman })
          }
        }
      } catch (err) {
        log(logPath, 'error', { where: 'pre-step', message: String(err?.message ?? err) })
      }
      return next()
    }
    scope.on('agent/pre-step', onPreStep)

    // ── 2. 跑完就归档 ─────────────────────────────────────────
    const onStatus = async (payload) => {
      try {
        if (payload?.status !== 'idle') return
        const agent = payload?.agent
        if (!agent) return
        const entry = phaseSessions.get(agent)
        if (!entry) return
        // 用户在这个会话里说过话 ⇒ 已经是真人的对话了 ⇒ 不碰
        // （两道检查：pre-step 时记的 + 现在现查会话事件）
        if (entry.hasHuman || await hasHumanMessage(scope, entry.id)) {
          log(logPath, 'archive-skip', { sessionId: entry.id, reason: 'human-spoke-here' })
          return
        }
        // 归档是异步的，别挡住事件循环
        void archivePhaseSession(scope, entry.id, logPath)
      } catch (err) {
        log(logPath, 'error', { where: 'status', message: String(err?.message ?? err) })
      }
    }
    scope.on('agent/status', onStatus)

    // ── 3. 启动时清理历史遗留的 phase 会话 ────────────────────
    // 修好之前跑出来的 phase 会话还在列表里（每次跑多一个）。
    // 只认"我们的四个任务投递过的会话"⇒ 不会碰到用户的会话。
    void sweepOldPhaseSessions(scope, logPath)

    return () => {
      phaseSessions.clear()
    }
  })
}

/** 取会话 id */
function sessionIdOf(agent) {
  try {
    const id = agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * 归档一个 phase 会话。
 *
 * ⚠️ 不传 `stopActivity`：忙碌的会话会被 Workspace 拒绝
 *    （WorkspaceActiveSessionError）——那说明它还在跑，下一轮 idle 再试。
 */
async function archivePhaseSession(scope, sessionId, logPath) {
  try {
    const registry = scope?.get?.('workspaceRegistry', false)
    if (!registry || typeof registry.archiveSession !== 'function') {
      log(logPath, 'archive-skip', { sessionId, reason: 'no workspaceRegistry' })
      return false
    }
    await registry.archiveSession(sessionId, {})
    log(logPath, 'archived', { sessionId })
    return true
  } catch (err) {
    log(logPath, 'archive-skip', { sessionId, reason: String(err?.message ?? err) })
    return false
  }
}

/**
 * 清理历史遗留的 phase 会话。
 *
 * 判据：schedule 任务里，**我们那四个任务**的投递记录里的 targetSessionId。
 *
 * ⚠️ **归档前必须确认这个会话里没有真人发言**。
 *    2026-11-14 的现场就是反例：用户的话被投进了 ingest 会话，
 *    那个会话既在跑 phase 又被当成了真人的对话 ⇒ 归档它 = 用户的对话凭空消失。
 *    所以每个候选都要先查会话事件里有没有"不是 schedule 投递"的 user 消息。
 */
async function sweepOldPhaseSessions(scope, logPath) {
  try {
    const sched = scope?.get?.('schedule', false)
    if (!sched || typeof sched.list !== 'function') return
    const listed = await sched.list({ limit: 200 })
    const items = listed?.items ?? []
    const ids = new Set()
    for (const t of items) {
      const title = t?.title ?? t?.record?.title ?? ''
      if (!title.startsWith(getPhaseTitlePrefix())) continue
      const delivery = t?.lastDelivery
      if (delivery?.targetSessionId) ids.add(String(delivery.targetSessionId))
      const records = t?.deliveryHistory?.records ?? []
      for (const r of records) {
        if (r?.targetSessionId) ids.add(String(r.targetSessionId))
      }
    }
    if (!ids.size) {
      log(logPath, 'sweep-skip', { reason: 'no phase sessions found' })
      return
    }
    let archived = 0
    let skipped = 0
    for (const id of ids) {
      if (await hasHumanMessage(scope, id)) {
        skipped++
        log(logPath, 'archive-skip', { sessionId: id, reason: 'human-spoke-here' })
        continue
      }
      const ok = await archivePhaseSession(scope, id, logPath)
      if (ok) archived++
    }
    log(logPath, 'sweep-done', { candidates: ids.size, archived, skipped })
  } catch (err) {
    log(logPath, 'error', { where: 'sweep', message: String(err?.message ?? err) })
  }
}

/**
 * 这个会话里有没有真人发言？
 *
 * 判据：会话事件里存在一条 `user/message`，其 `source.kind === 'user'`。
 *
 * ⚠️ 全库实测的 source.kind 分布（2026-11-14）：
 *   `user`（168，真人）· `time-context`（132）· `agent-instructions`（69）·
 *   `runtime-context`（46）· `skill-catalog`（32）· `schedule`（29）·
 *   `subagent-settled`（15）· `agent-message`（13）· `manas-proactive`（3）…
 *   ——**除 `user` 以外全是系统注入或插件投递**，都不能算"用户在说话"。
 *
 * 读不出来（会话已不在内存 / 服务不可用）⇒ 返回 **true**（保守：不归档）。
 * 宁可列表里多留一个会话，也不能弄丢用户的对话。
 *
 * @returns {Promise<boolean>}
 */
export async function hasHumanMessage(scope, sessionId) {
  try {
    const sessions = scope?.get?.('sessions', false)
    const session = sessions?.get?.(sessionId)
    if (!session || typeof session.snapshotEvents !== 'function') return true
    const events = session.snapshotEvents()
    for (const ev of events) {
      if (ev?.type !== 'user/message') continue
      const kind = ev?.data?.source?.kind
      if (kind === 'user') return true
    }
    return false
  } catch {
    return true
  }
}
