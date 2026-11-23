/**
 * decide.js 自测 —— 验判定逻辑（不发消息、不调 LLM）。
 *
 * 用法：node RUNTIME/scripts/test-proactive-decide.mjs
 * 重点覆盖 2026-11-08 修的两个 bug：
 *   1. shouldSpeak 永远为 false（阈值分支把话全拦了）
 *   2. LLM messages.content 传字符串导致 TypeError（已改，测试只覆盖判定部分）
 */

import { decide } from '../../lib/proactive/decide.js'

const cfg = {
  energyRange: { min: 0.15, max: 0.85 },
  quietHours: { start: '23:00', end: '08:00' },
  maxPerDay: 2,
  maxUnanswered: 2,
}

let failed = 0
function check(name, cond, extra = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failed++
  console.log(`${mark}  ${name}${extra ? `  ${extra}` : ''}`)
}

const baseState = () => ({
  energy: 0.6,
  energyDate: '2026-11-08',
  todayCount: 0,
  lastUserMessageAt: '2026-11-08T20:00:00+08:00',
  unansweredCount: 0,
  paused: false,
  quietHours: cfg.quietHours,
  maxPerDay: 2,
  maxUnanswered: 2,
  nextEligibleAt: null,
  lastProactiveAt: null,
  recentProactive: [],
  moodLow: null,
})

// 1) 第一次：还没抽阈值 → threshold-set，不说
{
  const s = baseState()
  const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
  check('首次判定 = threshold-set', v.reason === 'threshold-set' && v.shouldSpeak === false, v.reason)
  check('首次判定写入了 nextEligibleAt', typeof s.nextEligibleAt === 'string' && !Number.isNaN(Date.parse(s.nextEligibleAt)))
}

// 2) 阈值已过 → 应该"说"
{
  const s = baseState()
  s.nextEligibleAt = '2026-11-08T19:00:00+08:00'   // 已过期
  const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
  check('阈值已过 → shouldSpeak=true', v.shouldSpeak === true, `reason=${v.reason} motive=${v.motive}`)
}

// 3) 阈值未到 → too-early
{
  const s = baseState()
  s.nextEligibleAt = '2026-11-08T23:00:00+08:00'   // 未到
  const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
  check('阈值未到 → too-early', v.reason === 'too-early' && v.shouldSpeak === false, v.reason)
}

// 4) 免打扰时段（02:00）
{
  const s = baseState()
  s.nextEligibleAt = '2026-11-08T01:00:00+08:00'
  const v = decide(s, cfg, new Date('2026-11-08T02:00:00+08:00'))
  check('免打扰时段 → quiet-hours', v.reason === 'quiet-hours', v.reason)
}

// 5) 今日上限 —— **已取消**（2026-11-18 用户定「搭讪不设额度」）
//
//    原来这里断言 `todayCount=2 ⇒ daily-cap`。那是**我自己加的**节奏约束，
//    不是用户定的，而且跟他原话「搭讪不设额度，只根据搭讪条件判断」直接冲突。
//    ⇒ 闸门删了，现在额度用满**照样能说**。
{
  const s = baseState()
  s.todayCount = 2
  s.nextEligibleAt = '2026-11-08T19:00:00+08:00'
  const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
  check('不撞 daily-cap（额度已取消）', v.reason !== 'daily-cap', v.reason)
  check('额度用满也能说', v.shouldSpeak === true, `reason=${v.reason}`)
}

// 6) 未回上限 → 暂停
{
  const s = baseState()
  s.unansweredCount = 2
  s.nextEligibleAt = '2026-11-08T19:00:00+08:00'
  const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
  check('未回上限 → unanswered-cap 且 paused', v.reason === 'unanswered-cap' && s.paused === true, v.reason)
}

// 7) 低能量 → 整天不说
{
  const s = baseState()
  s.energy = 0.2
  s.nextEligibleAt = '2026-11-08T19:00:00+08:00'
  const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
  check('低能量 → low-energy', v.reason === 'low-energy', v.reason)
}

// 8) 跨日重抽 energy
{
  const s = baseState()
  s.energyDate = '2026-11-07'
  const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
  check('跨日重抽 energy', s.energyDate === '2026-11-08' && s.energy >= 0.15 && s.energy <= 0.85, `energy=${s.energy}`)
}

// 9) 动机去重：抽到与最近 2 条相同的动机 → duplicate（动机是随机的，所以循环验证）
{
  let sampledContent = 0
  let bad = 0
  for (let i = 0; i < 300; i++) {
    const s = baseState()
    s.nextEligibleAt = '2026-11-08T19:00:00+08:00'
    s.recentProactive = [
      { at: '2026-11-08T10:00:00+08:00', motive: 'content', topic: 'a' },
      { at: '2026-11-08T09:00:00+08:00', motive: 'content', topic: 'b' },
    ]
    const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
    if (v.motive === 'content') {
      sampledContent++
      if (!(v.reason === 'duplicate' && v.shouldSpeak === false)) bad++
    }
  }
  check('动机去重：抽到 content 必判 duplicate', sampledContent > 0 && bad === 0, `抽到 content ${sampledContent} 次，违规 ${bad} 次`)
}

// 10) 动机去重：**最近两条动机不同**时，抽到其中任一个也得判重
//     （2026-11-17 修的原 bug：只比"最近两条是否同动机"，于是 08:18 content
//       + 08:59 content 连投两条说同一件事）
{
  let sampledContent = 0
  let bad = 0
  for (let i = 0; i < 300; i++) {
    const s = baseState()
    s.nextEligibleAt = '2026-11-08T19:00:00+08:00'
    s.recentProactive = [
      { at: '2026-11-08T10:00:00+08:00', motive: 'content', topic: 'a' },
      { at: '2026-11-08T09:00:00+08:00', motive: 'followup', topic: 'b' },
    ]
    const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
    if (v.motive === 'content') {
      sampledContent++
      if (!(v.reason === 'duplicate' && v.shouldSpeak === false)) bad++
    }
  }
  check('动机去重：最近两条动机不同也能拦住重复动机', sampledContent > 0 && bad === 0, `抽到 content ${sampledContent} 次，违规 ${bad} 次`)
}

// 11) 最小间隔：上一条刚投过 → too-recent（2026-11-17 加）
{
  const s = baseState()
  s.nextEligibleAt = '2026-11-08T19:00:00+08:00'
  s.lastProactiveAt = '2026-11-08T19:40:00+08:00'   // 20 分钟前
  const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
  check('刚投过 → too-recent', v.reason === 'too-recent' && v.shouldSpeak === false, v.reason)
}

// 12) 最小间隔：隔够了 → 正常判定
{
  const s = baseState()
  s.nextEligibleAt = '2026-11-08T19:00:00+08:00'
  s.lastProactiveAt = '2026-11-08T18:00:00+08:00'   // 2 小时前
  const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
  check('隔够 90 分钟 → 正常判定', v.reason !== 'too-recent', `reason=${v.reason}`)
}

// 13) 最小间隔：minGapMs=0 → 不限制
{
  const s = baseState()
  s.nextEligibleAt = '2026-11-08T19:00:00+08:00'
  s.lastProactiveAt = '2026-11-08T19:59:00+08:00'
  const v = decide(s, { ...cfg, minGapMs: 0 }, new Date('2026-11-08T20:00:00+08:00'))
  check('minGapMs=0 → 不受间隔限制', v.reason !== 'too-recent', `reason=${v.reason}`)
}

// 14) 动机去重：**超过 24h 的旧记录不再参与判重**（2026-11-22 修）
//     原逻辑只看"最近两条"，而最近两条可能是几天前的 ⇒ 同一个动机一挡好几天，
//     表现为"明明有劲、也没说过，就是不开口"。
{
  let sampledContent = 0
  let bad = 0
  for (let i = 0; i < 300; i++) {
    const s = baseState()
    s.nextEligibleAt = '2026-11-08T19:00:00+08:00'
    s.recentProactive = [
      { at: '2026-11-05T10:00:00+08:00', motive: 'content', topic: 'a' },  // 3 天前
      { at: '2026-11-04T09:00:00+08:00', motive: 'content', topic: 'b' },
    ]
    const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
    if (v.motive === 'content') {
      sampledContent++
      if (v.reason === 'duplicate') bad++
    }
  }
  check('动机去重：超过 24h 的旧记录不再挡', sampledContent > 0 && bad === 0, `抽到 content ${sampledContent} 次，被旧记录挡 ${bad} 次`)
}

// 15) 动机去重：坏时间戳（解析不了）不参与判重，不能把搭讪锁死
{
  let sampledContent = 0
  let bad = 0
  for (let i = 0; i < 300; i++) {
    const s = baseState()
    s.nextEligibleAt = '2026-11-08T19:00:00+08:00'
    s.recentProactive = [{ at: 'not-a-date', motive: 'content', topic: 'a' }]
    const v = decide(s, cfg, new Date('2026-11-08T20:00:00+08:00'))
    if (v.motive === 'content') {
      sampledContent++
      if (v.reason === 'duplicate') bad++
    }
  }
  check('动机去重：坏时间戳不挡', sampledContent > 0 && bad === 0, `抽到 content ${sampledContent} 次，被坏记录挡 ${bad} 次`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
