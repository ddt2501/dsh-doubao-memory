/**
 * 顶层 agent 追踪自测 —— 验 lib/agent-utils.js 的 trackRootAgents。
 *
 * 重点覆盖 2026-11-17 的一个真 bug：
 *   **插件热重载后，主动搭讪彻底静默失效。**
 *
 *   根因：集合只靠 `agent/created` 事件累积。HMR 重载时
 *   - 旧实例 unmount ⇒ 集合清空
 *   - 新实例挂载 ⇒ **已存在的 agent 不会再触发 `agent/created`**
 *   ⇒ 集合永远为空 ⇒ 轮询 `roots:0` ⇒ 一次都不判定。
 *
 *   表现极其隐蔽：DSH 一切正常，插件日志里只有一行
 *   `{"event":"poll","roots":0}`，没有任何报错。
 *
 * 修法：挂载时用 `scope.agents.list()` 扫一遍已存在的 agent。
 *
 * 用法：node RUNTIME/scripts/test-agent-tracking.mjs
 */

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

// 动态 import（ESM 里顶层 await 可以用）
const { trackRootAgents, isRootAgent } = await import('../../lib/agent-utils.js')

/** 造一个顶层 agent（session header 表明是顶层） */
function makeRoot(id) {
  return {
    id,
    status: 'idle',
    session: { header: { id, delegationDepth: 0 } },
  }
}

/** 造一个子 agent（header 表明是子代理） */
function makeSub(id) {
  return {
    id,
    status: 'idle',
    session: { header: { id, origin: 'subagent', delegationDepth: 1 } },
  }
}

/** 造一个 mock scope，带 agents 注册表和事件派发 */
function makeScope(agents) {
  const handlers = {}
  return {
    _handlers: handlers,
    agents: {
      list: () => [...agents],
      roots: () => [...agents],
    },
    on: (ev, h) => { handlers[ev] = h },
    emit: (ev, payload) => handlers[ev]?.(payload),
  }
}

// ── 1. 挂载时就能收到**已存在**的顶层 agent ────────────────
{
  const root = makeRoot('a1')
  const sub = makeSub('a2')
  const scope = makeScope([root, sub])
  const tracker = trackRootAgents(scope)
  check('挂载时扫到已存在的顶层 agent', tracker.agents().length === 1, `拿到 ${tracker.agents().length} 个`)
  check('扫到的是对的那个', tracker.agents()[0]?.id === 'a1', tracker.agents()[0]?.id)
  check('子 agent 不算顶层', !tracker.agents().includes(sub))
}

// ── 2. 之后新建的 agent 仍然能收到 ────────────────────────
{
  const scope = makeScope([])
  const tracker = trackRootAgents(scope)
  check('初始为空', tracker.agents().length === 0)
  const root = makeRoot('b1')
  scope.emit('agent/created', { agent: root })
  check('agent/created 后能收到', tracker.agents().length === 1)
  scope.emit('agent/disposed', { agent: root })
  check('agent/disposed 后移除', tracker.agents().length === 0)
}

// ── 3. **模拟 HMR 重载**：旧集合丢弃，新实例挂载时重新扫 ────
{
  const root = makeRoot('c1')
  const scope = makeScope([root])

  // 第一次挂载
  const first = trackRootAgents(scope)
  check('首次挂载扫到 agent', first.agents().length === 1)

  // 卸载（旧实例 dispose）
  first.dispose()
  check('卸载后旧集合清空', first.agents().length === 0)

  // 重新挂载（热重载）—— agent 还在，但**不会**再触发 agent/created
  const second = trackRootAgents(scope)
  check('热重载后重新扫到 agent（关键）', second.agents().length === 1, `拿到 ${second.agents().length} 个`)
  check('热重载后拿到的是同一个 agent', second.agents()[0]?.id === 'c1')
}

// ── 4. isRootAgent 的判据 ────────────────────────────────
{
  check('delegationDepth=0 ⇒ 顶层', isRootAgent(makeRoot('d1'), {}) === true)
  check('origin=subagent ⇒ 非顶层', isRootAgent(makeSub('d2'), {}) === false)
  check('delegationDepth=1 ⇒ 非顶层', isRootAgent({
    id: 'd3', session: { header: { id: 'd3', delegationDepth: 1 } },
  }, {}) === false)
  check('header 在但字段缺 ⇒ 顶层', isRootAgent({
    id: 'd4', session: { header: { id: 'd4' } },
  }, {}) === true)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
