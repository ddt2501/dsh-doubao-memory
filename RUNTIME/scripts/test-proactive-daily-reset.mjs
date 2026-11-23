/**
 * 跨日归零 + 暂停解除 的自测。
 *
 * 覆盖 2026-11-18 早上从 live 状态文件里挖出来的两个**致命**bug：
 *
 * ── bug A：`todayCount` 从不跨日重置 ────────────────────────────
 *
 * 11-18 09:04 那次投递后，live 状态是：
 *     todayCount: 2      maxPerDay: 2
 * ⇒ `todayCount >= maxPerDay` **恒成立**
 * ⇒ 从 11-19 起每天都是 'daily-cap'
 * ⇒ **主动搭讪永久停摆**。
 *
 * 根因：跨日重置只做了 energy/energyDate，todayCount 和 unansweredCount
 * **只增不减**——"一天 2 次"实际变成了"一辈子 2 次"。
 *
 * ── bug B：`unansweredCount` 只增不减，且分不清暂停原因 ─────────
 *
 * 连着两次没人理 ⇒ `unansweredCount >= maxUnanswered` ⇒ `paused = true`
 * ⇒ **永远不开口了**，哪怕用户隔天就回了我。
 * 而且原来只置 `paused`，没记原因 ⇒ 分不清"没人理所以闭嘴"
 * 和"用户亲口说别主动找我" ⇒ 手动暂停也自动解不掉。
 *
 * 用法：node RUNTIME/scripts/test-proactive-daily-reset.mjs
 */

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

const { decide, localDate } = await import('../../lib/proactive/decide.js')

const cfg = { energyRange: { min: 0.15, max: 0.85 } }

/** 一个"正常状态" */
function baseState(over = {}) {
  return {
    energy: 0.7,
    energyDate: '2026-11-17',
    todayCount: 1,
    lastUserMessageAt: null,
    unansweredCount: 0,
    paused: false,
    pausedReason: null,
    quietHours: { start: '23:00', end: '08:00' },
    maxPerDay: 2,
    maxUnanswered: 2,
    minGapMs: 5_400_000,
    nextEligibleAt: null,
    lastProactiveAt: null,
    recentProactive: [],
    moodLow: null,
    ...over,
  }
}

// ══════════════════════════════════════════════════════════════
// A. 跨日归零
// ══════════════════════════════════════════════════════════════
{
  // 昨天已经用满 2 次（live 状态就是这样的）
  const s = baseState({ energyDate: '2026-11-17', todayCount: 2, unansweredCount: 2 })
  const today = new Date('2026-11-18T09:00:00')
  const v = decide(s, cfg, today, true)

  check('跨日时 todayCount 归零', s.todayCount === 0, `todayCount=${s.todayCount}`)
  check('跨日时 unansweredCount 归零', s.unansweredCount === 0, `unansweredCount=${s.unansweredCount}`)
  check('跨日时状态标记为变了', v.stateChanged === true)
  check('跨日后不再撞 daily-cap', v.reason !== 'daily-cap', `reason=${v.reason}`)
}

// ── 不跨日就不该归零 ──
{
  const s = baseState({ energyDate: '2026-11-18', todayCount: 1 })
  decide(s, cfg, new Date('2026-11-18T15:00:00'), true)
  check('同一天不归零 todayCount', s.todayCount === 1, `todayCount=${s.todayCount}`)
}

// ── 跨日归零后能重新说话 ──
{
  const s = baseState({ energyDate: '2026-11-17', todayCount: 2, nextEligibleAt: null })
  const today = new Date('2026-11-18T09:00:00')
  decide(s, cfg, today, true)          // 跨日归零 + 抽阈值
  // ⚠️ 跨日会**重抽 energy**（0.15~0.85 随机）⇒ 抽到 <0.25 就是 'low-energy'。
  //    那是正确行为，但会让测试不稳定 ⇒ 这里固定成"劲头不错"。
  s.energy = 0.7
  s.nextEligibleAt = new Date(today.getTime() - 60_000).toISOString()   // 阈值已到
  const v = decide(s, cfg, today, true)
  check('跨日之后能重新开口', v.shouldSpeak === true, `reason=${v.reason}`)
}

// ══════════════════════════════════════════════════════════════
// B. 自动暂停 vs 手动暂停
// ══════════════════════════════════════════════════════════════
{
  // 连着 2 次没人理 ⇒ 自动暂停，并记下原因
  // ⚠️ energyDate 必须是**同一天**，否则跨日归零会先把 unansweredCount 清掉
  const s = baseState({ energyDate: '2026-11-18', unansweredCount: 2 })
  const v = decide(s, cfg, new Date('2026-11-18T09:00:00'), true)
  check('未回够数 ⇒ 暂停', s.paused === true)
  check('自动暂停记下原因', s.pausedReason === 'unanswered-cap', String(s.pausedReason))
  check('理由是 unanswered-cap', v.reason === 'unanswered-cap', v.reason)

  // 手动暂停（没有 pausedReason）⇒ 跨日也不该自动解除
  const m = baseState({ energyDate: '2026-11-17', paused: true, pausedReason: null, unansweredCount: 2 })
  decide(m, cfg, new Date('2026-11-18T09:00:00'), true)
  check('手动暂停不被跨日自动解除', m.paused === true, `paused=${m.paused} reason=${m.pausedReason}`)
}

// ── 用户回话 ⇒ 计数归零 + 自动暂停解除 ──
{
  // 模拟 noteHumanReply 的效果（插件里的实现）
  const s = baseState({ unansweredCount: 2, paused: true, pausedReason: 'unanswered-cap' })
  if ((s.unansweredCount ?? 0) > 0) s.unansweredCount = 0
  if (s.paused && s.pausedReason === 'unanswered-cap') {
    s.paused = false
    s.pausedReason = null
  }
  check('用户回话 ⇒ 未回计数归零', s.unansweredCount === 0)
  check('用户回话 ⇒ 自动暂停解除', s.paused === false, `paused=${s.paused}`)
  check('解除后原因清空', s.pausedReason === null)

  // 手动暂停不受影响
  const m = baseState({ paused: true, pausedReason: null, unansweredCount: 2 })
  if ((m.unansweredCount ?? 0) > 0) m.unansweredCount = 0
  if (m.paused && m.pausedReason === 'unanswered-cap') { m.paused = false; m.pausedReason = null }
  check('用户回话不解手动暂停', m.paused === true, `paused=${m.paused}`)
}

// ── Config 的暂停（更上层）也不受影响 ──
{
  // readState 里：Config paused=true ⇒ 一定暂停；解除逻辑在 noteHumanReply，
  // 它只碰 pausedReason === 'unanswered-cap'，所以手动/Config 暂停都安全。
  const s = baseState({ paused: true, pausedReason: 'manual' })
  if (s.paused && s.pausedReason === 'unanswered-cap') { s.paused = false; s.pausedReason = null }
  check('Config 暂停不被回话解除', s.paused === true)
}

// ══════════════════════════════════════════════════════════════
// C. localDate 用本地时区（UTC 会差一天）
// ══════════════════════════════════════════════════════════════
{
  const d = new Date('2026-11-18T00:30:00+08:00')
  check('本地日期用本地时区', localDate(d) === '2026-11-18', localDate(d))
  const d2 = new Date('2026-11-17T23:30:00+08:00')
  check('跨 UTC 日界仍然算本地那天', localDate(d2) === '2026-11-17', localDate(d2))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
