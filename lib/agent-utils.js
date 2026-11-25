/**
 * agent 相关的小工具 —— 判断"谁是顶层会话"。
 *
 * ## 为什么需要这个模块（2026-11-13 踩到的坑）
 *
 * 插件原来用 `scope.agents.roots()` 判断顶层会话：
 *   roots() { return [...store.values()].filter(e => e.owner === void 0).map(e => e.agent) }
 *
 * 在 CLI 版（`dsh web`）里一直好用。但迁移到 **DSH Desktop（0.2.2-rc.2）** 后，
 * 恢复的会话在 `roots()` 里查不到（Desktop 的 Host 恢复 session 时带了 owner）
 * ⇒ `roots()` 返回空数组 ⇒
 *    - 住相：section 永远返回 ''（子 agent 不给住相），一条都不生成
 *    - 主动搭讪：`isRoot` 全 false + poll 遍历空数组，一次都不判定
 *
 * **两个子系统静默失效，日志里只有 `isRoot:false`，没有任何报错。**
 *
 * ## 修法
 *
 * 改用 **session header 的持久化字段**（`dsh-session` 的 SessionHeader）：
 *   - `origin === 'subagent'` ⇒ 明确的子代理
 *   - `delegationDepth`：absent 或 0 = 顶层，>0 = 子代理（官方语义）
 *   - header 存在但没这两个字段 ⇒ 顶层（普通会话）
 *   - header 都读不到（旧 Host）⇒ 兜底 `roots()`
 *
 * 这几个字段是**写进 session header 的持久化数据**，跨 Host 实现都可靠。
 */

/** 读 session header（容错） */
function headerOf(agent) {
  try {
    return agent?.session?.header ?? agent?.session?.meta ?? undefined
  } catch {
    return undefined
  }
}

/**
 * @param {object} agent - dsh agent 实例
 * @param {object} [scope] - 可选的 cordis scope（兜底 roots() 用）
 * @returns {boolean} 是不是顶层会话
 */
export function isRootAgent(agent, scope) {
  if (!agent) return false

  const h = headerOf(agent)
  if (h) {
    if (h.origin === 'subagent') return false           // 明确标记的子代理
    const d = h.delegationDepth
    if (typeof d === 'number') return d === 0           // 0 = 顶层，>0 = 子代理
    return true                                          // header 在、字段缺 ⇒ 顶层
  }

  // 读不到 header（旧 Host / 异常）⇒ 退回运行时的 roots()
  try {
    const roots = scope?.agents?.roots?.() ?? []
    return roots.some((a) => a === agent)
  } catch {
    return false
  }
}

/**
 * 诊断用：把一个 agent 的"身份线索"压成一行，方便日志排查。
 * 2026-11-13 加——Desktop 里 isRoot 判错时，光看 `isRoot:false` 查不出原因。
 */
export function describeAgent(agent) {
  try {
    const h = headerOf(agent)
    return {
      id: agent?.id ?? null,
      hasHeader: !!h,
      origin: h?.origin ?? null,
      delegationDepth: h?.delegationDepth ?? null,
      parentSession: h?.parentSession ?? null,
      isSeeded: h?.isSeeded ?? null,
    }
  } catch (err) {
    return { error: String(err?.message ?? err) }
  }
}

/**
 * 维护"已知的顶层 agent"集合 —— 给轮询用。
 *
 * `roots()` 不可靠时（Desktop），轮询没法靠它拿到 agent，
 * 所以自己在 `agent/created` / `agent/disposed` 上维护一份。
 *
 * @param {object} scope
 * @returns {{ agents: () => object[], has: (a: object) => boolean, dispose: () => void }}
 */
export function trackRootAgents(scope) {
  const known = new Set()

  const onCreated = (payload) => {
    try {
      const agent = payload?.agent
      if (agent && isRootAgent(agent, scope)) known.add(agent)
    } catch { /* ignore */ }
  }
  const onDisposed = (payload) => {
    try {
      const agent = payload?.agent
      if (agent) known.delete(agent)
    } catch { /* ignore */ }
  }

  scope.on('agent/created', onCreated)
  scope.on('agent/disposed', onDisposed)

  // ── 挂载时先扫一遍**已经存在**的 agent（2026-11-17 加）────────────
  //
  // **为什么必须扫**：这套集合只靠 `agent/created` 事件累积。
  // 而插件**热重载**（HMR / plugin_manager 触发重合成）时：
  //   - 旧插件实例被 unmount ⇒ 集合随 dispose 清空
  //   - 新插件实例挂载 ⇒ 但**已存在的 agent 不会再触发 `agent/created`**
  // ⇒ 集合永远为空 ⇒ 轮询 `roots:0` ⇒ **主动搭讪彻底静默失效**。
  //
  // 实测（2026-11-17 20:42）：HMR 重载后日志里
  //   `{"event":"poll","roots":0}` 一直持续，而 DSH 本身完全正常。
  //
  // `scope.agents.roots()` 在 Desktop 上不可靠（见本文件顶部说明），
  // 所以这里用 **`scope.agents.list()`**（全部活着的 agent，注册顺序），
  // 再用 `isRootAgent` 逐个过滤——判据是 session header 的持久化字段，跨 Host 可靠。
  //
  // `AgentRegistry.list()` 的实现（dsh-agent/lib/index.js:743）：
  //   `return [...this.store.values()].map((entry) => entry.agent)`
  // ⇒ 返回的是 **agent 本体**，不是 `{ agent }` 包装。
  try {
    const registry = scope?.agents
    const all = typeof registry?.list === 'function' ? registry.list() : []
    for (const agent of all) {
      try {
        const target = agent?.agent ?? agent     // 兼容包装形态
        if (target && isRootAgent(target, scope)) known.add(target)
      } catch { /* ignore */ }
    }
  } catch { /* 注册表还没就绪 ⇒ 后面 agent/created 会补上 */ }

  return {
    agents: () => [...known],
    has: (agent) => known.has(agent),
    dispose: () => { known.clear() },
  }
}
