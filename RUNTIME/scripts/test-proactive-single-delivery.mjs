/**
 * 主动搭讪的"一轮只投一条"自测。
 *
 * 覆盖 2026-11-17 21:07 的真事故：
 *   **两秒内投了两条**——
 *     "喵喵喵！上次你用这句开场，我可记到今天了。"
 *     "喵喵喵，用户，今天抓到你的新开场了吗？"
 *   同一件事说了两遍。
 *
 * 根因：一轮轮询遍历**所有**顶层会话（实测 17 个），每个都独立走
 * "判定 → 生成 → 投递 → 写回状态"。而 `minGapMs`（90 分钟）
 * **拦不住同一轮里的第二条**——第一条的 LLM 调用要几秒，
 * 状态还没写回，第二个 agent 读到的仍是"上次是 12 小时前"⇒ 两句都通过。
 *
 * 修法：全局串行闸（withDeliveryLock）——
 * 后到的 agent 拿到闸之后**重新读状态**，
 * 此时第一条已写回 `lastProactiveAt` ⇒ 被 minGapMs 正常拦下。
 *
 * 用法：node RUNTIME/scripts/test-proactive-single-delivery.mjs
 */

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

// ══════════════════════════════════════════════════════════════
// 第一部分：串行闸本身（与插件解耦地验证语义）
// ══════════════════════════════════════════════════════════════
{
  // 复刻 withDeliveryLock 的实现来测语义
  let chain = Promise.resolve()
  const withLock = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  const order = []
  const results = await Promise.all([
    withLock(async () => { await new Promise((r) => setTimeout(r, 30)); order.push('A'); return 'A' }),
    withLock(async () => { order.push('B'); return 'B' }),
    withLock(async () => { order.push('C'); return 'C' }),
  ])
  check('三个任务都完成', results.join('') === 'ABC')
  check('严格串行（A 完成后才是 B）', order.join('') === 'ABC', order.join(''))
}

{
  // 前一个失败，后一个仍要执行
  let chain = Promise.resolve()
  const withLock = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.then(() => undefined, () => undefined)
    return run
  }
  let secondRan = false
  await Promise.all([
    withLock(async () => { throw new Error('boom') }).catch(() => {}),
    withLock(async () => { secondRan = true }),
  ])
  check('前一个抛错不挡住后一个', secondRan === true)
}

// ══════════════════════════════════════════════════════════════
// 第二部分：模拟真实场景 —— 17 个 agent 同一轮判定，只应投一条
// ══════════════════════════════════════════════════════════════
{
  const { decide } = await import('../../lib/proactive/decide.js')

  const state = {
    energy: 0.7,
    energyDate: '2026-11-17',
    todayCount: 1,
    unansweredCount: 1,
    paused: false,
    quietHours: { start: '23:00', end: '08:00' },
    maxPerDay: 5,          // 放开上限，让测试只聚焦"同轮连投"这一件事
    maxUnanswered: 5,
    minGapMs: 5_400_000,
    nextEligibleAt: null,
    // 上一次投递在 3 小时前 ⇒ 距今超过 90 分钟 minGap，第一条应该放行
    lastProactiveAt: '2026-11-17T11:00:00.000Z',
    recentProactive: [],
    moodLow: null,
  }
  const cfg = { energyRange: { min: 0.15, max: 0.85 } }
  const now = new Date('2026-11-17T14:21:00.000Z')

  // 真实时序：
  //   第一次判定：nextEligibleAt 为空 ⇒ 抽阈值（threshold-set），不说话
  //   阈值到期后的判定：才真的说
  const s1 = { ...state }
  const v0 = decide(s1, cfg, now, true)
  check('首次判定抽阈值不说', v0.shouldSpeak === false && v0.reason === 'threshold-set', v0.reason)

  // 阈值到期（下一轮轮询，时间已过）
  s1.nextEligibleAt = new Date(now.getTime() - 60_000).toISOString()
  const v1 = decide(s1, cfg, now, true)
  check('阈值到期后放行', v1.shouldSpeak === true, `reason=${v1.reason} motive=${v1.motive}`)

  // 模拟投递后写回状态
  s1.lastProactiveAt = now.toISOString()
  s1.todayCount += 1
  s1.nextEligibleAt = null

  // 第二个 agent 拿到串行闸后重新读状态
  const s2 = { ...s1 }
  const v2 = decide(s2, cfg, now, true)
  check('第二个 agent 被拦下', v2.shouldSpeak === false, `reason=${v2.reason}`)
  check('拦截理由是 too-recent', v2.reason === 'too-recent', v2.reason)
}

// ══════════════════════════════════════════════════════════════
// 第三部分：会话排序 —— 优先投给用户最后说话的会话
// ══════════════════════════════════════════════════════════════
{
  const { humanSpoke, rememberHumanSpoke, lastHumanAt } = await import('../../lib/phase-detect.js')

  const old = { id: 'old' }
  const fresh = { id: 'fresh' }
  const silent = { id: 'silent' }

  rememberHumanSpoke(old, true)
  await new Promise((r) => setTimeout(r, 5))     // 让两者时间戳不同
  rememberHumanSpoke(fresh, true)

  check('记了真人发言', humanSpoke(fresh) === true)
  check('没发言的会话判 false', humanSpoke(silent) === false)
  check('lastHumanAt 有值', lastHumanAt(fresh) > 0)
  check('没发言的会话 lastHumanAt=0', lastHumanAt(silent) === 0)
  check('新的比旧的新', lastHumanAt(fresh) > lastHumanAt(old))

  // 排序：有真人发言的排前面，新的在前
  const ranked = [silent, old, fresh].sort((a, b) => {
    const ha = humanSpoke(a) ? 1 : 0
    const hb = humanSpoke(b) ? 1 : 0
    if (ha !== hb) return hb - ha
    return lastHumanAt(b) - lastHumanAt(a)
  })
  check('排序后用户最后说话的排第一', ranked[0].id === 'fresh', ranked.map((a) => a.id).join(','))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
