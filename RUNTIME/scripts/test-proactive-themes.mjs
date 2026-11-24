/**
 * 主题演进系统自测（2026-11-18）。
 *
 * 覆盖：
 *   1. 四块地基都能取到种子（梗 / wiki 断言 / 住相 / daily）
 *   2. **住相不当话头**（它是方向，不是话头）
 *   3. 事务行被过滤（daily 里的工作条目不能进种子池）
 *   4. 选主题：同轴优先、说过多次的降权、冷却中的排除
 *   5. 主题状态推进（fresh → introduced → deepen → cooling）
 *   6. **token 对比**：主题 brief 比全量素材短多少
 *
 * 用法：node RUNTIME/scripts/test-proactive-themes.mjs
 */
import { makePersonaFixture } from './fixtures/persona-fixture.mjs'
import { resolvePaths } from '../../lib/paths.js'

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

const fx = makePersonaFixture()
const paths = resolvePaths({ dataRoot: fx.root })
const T = await import('../../lib/proactive/themes.js')
const { collectMaterial } = await import('../../lib/proactive/material.js')

// ══════════════════════════════════════════════════════════════
// 1. 四块地基
// ══════════════════════════════════════════════════════════════
const { seeds, snapshot } = T.collectSeeds(paths)
{
  check('种子池非空', seeds.length > 0, `${seeds.length} 个`)
  check('梗进来了', seeds.some((s) => s.source.includes('梗')), '')
  check('wiki 断言进来了', seeds.some((s) => s.source.includes('偏好')), '')
  check('住相读到了', Boolean(snapshot?.questions?.length), `${snapshot?.questions?.length} 问`)
  check('daily 关系向进来了', seeds.some((s) => s.source.startsWith('daily:')), '')
  check('轴只有两种', seeds.every((s) => ['relation', 'current'].includes(s.axis)),
    [...new Set(seeds.map((s) => s.axis))].join(','))
}

// ══════════════════════════════════════════════════════════════
// 2. 住相不当话头
// ══════════════════════════════════════════════════════════════
{
  check('★ 住相不在种子池里（它是方向不是话头）',
    !seeds.some((s) => s.source.startsWith('snapshot:')),
    seeds.filter((s) => s.source.startsWith('snapshot')).map((s) => s.id).join(','))
  const g = T.snapshotGuidance(snapshot)
  check('住相给出方向', Boolean(g?.guidance), g?.preferAxis)
  check('方向有偏好轴', ['relation', 'current'].includes(g?.preferAxis), g?.preferAxis)
  check('方向含"我此刻的位置"', g?.guidance?.includes('我此刻的位置'), '')
  check('方向含"我的边界"', g?.guidance?.includes('我的边界'), '')
}

// ══════════════════════════════════════════════════════════════
// 3. 事务行被过滤
// ══════════════════════════════════════════════════════════════
{
  const daily = seeds.filter((s) => s.source.startsWith('daily:'))
  const tech = daily.find((s) => s.detail.includes('飞书那条链路走通了'))
  check('★ 事务行（飞书链路走通了）被过滤', !tech, tech?.detail?.slice(0, 20))
  const rel = daily.find((s) => s.detail.includes('喵喵喵'))
  check('关系行（喵喵喵）保留', Boolean(rel), rel?.detail?.slice(0, 20))
}

// ══════════════════════════════════════════════════════════════
// 4. 选主题
// ══════════════════════════════════════════════════════════════
{
  // 同轴优先
  const p = T.selectTheme(seeds, {}, { currentAxis: 'relation' })
  check('同轴优先：选中 relation 轴', p?.seed?.axis === 'relation', p?.seed?.axis)

  // 说过多次的降权
  const jokeSeed = seeds.find((s) => s.source.includes('梗'))
  const states = {
    [jokeSeed.id]: { id: jokeSeed.id, saidTimes: 3, lastSaidAt: new Date().toISOString(), stage: 'cooling' },
  }
  const p2 = T.selectTheme(seeds, states, { currentAxis: 'relation' })
  check('★ 说过的梗被避开', p2?.seed?.id !== jokeSeed.id, p2?.seed?.id)

  // 冷却中的直接排除
  const states2 = {}
  for (const s of seeds.slice(0, 3)) {
    states2[s.id] = { id: s.id, saidTimes: 3, lastSaidAt: new Date().toISOString(), stage: 'cooling' }
  }
  const p3 = T.selectTheme(seeds, states2, { currentAxis: 'relation' })
  check('冷却中的被排除', !seeds.slice(0, 3).some((s) => s.id === p3?.seed?.id), p3?.seed?.id)

  // 用过的话头不消费第二次
  const s4 = seeds[0]
  const states4 = { [s4.id]: { id: s4.id, saidTimes: 1, usedSeeds: [s4.seed], lastSaidAt: null, stage: 'introduced' } }
  const p4 = T.selectTheme(seeds, states4, { currentAxis: null })
  check('★ 用过的话头不选第二次', p4?.seed?.id !== s4.id || p4?.seed?.seed !== s4.seed, p4?.seed?.id)
}

// ══════════════════════════════════════════════════════════════
// 5. 主题状态推进
// ══════════════════════════════════════════════════════════════
{
  const seed = seeds[0]
  let st = null
  st = T.advanceTheme(st, seed, '2026-11-18T10:00:00.000Z')
  check('第一次 ⇒ introduced', st.stage === 'introduced', st.stage)
  check('第一次 ⇒ saidTimes=1', st.saidTimes === 1)
  st = T.advanceTheme(st, seed, '2026-11-18T12:00:00.000Z')
  check('第二次 ⇒ deepen', st.stage === 'deepen', st.stage)
  st = T.advanceTheme(st, seed, '2026-11-18T14:00:00.000Z')
  check('第三次 ⇒ cooling', st.stage === 'cooling', st.stage)
  check('用过的记下来了', st.usedSeeds.length === 3, JSON.stringify(st.usedSeeds.length))
}

// ══════════════════════════════════════════════════════════════
// 6. 动机由主题决定（不是随机）
// ══════════════════════════════════════════════════════════════
{
  const { pickMotiveForTheme } = await import('../../lib/proactive/decide.js')
  const seed = seeds[0]
  check('新主题 ⇒ content', pickMotiveForTheme({ seed, state: null }, {}) === 'content')
  check('说过一次 ⇒ followup（推进同一条线）',
    pickMotiveForTheme({ seed, state: { saidTimes: 1 } }, {}) === 'followup')
  check('说过两次 ⇒ anchor（换角度收尾）',
    pickMotiveForTheme({ seed, state: { saidTimes: 2 } }, {}) === 'anchor')
}

// ══════════════════════════════════════════════════════════════
// 7. token 对比（用户 2026-11-18 要求"考虑 token 开销"）
// ══════════════════════════════════════════════════════════════
{
  const material = collectMaterial(paths)
  const full = material?.brief ?? ''
  const picked = T.selectTheme(seeds, {}, { currentAxis: 'relation' })
  const brief = T.expandTheme(picked.seed)
  const g = T.snapshotGuidance(snapshot)
  const total = brief.length + (g?.guidance?.length ?? 0)

  const fullTokens = Math.round(full.length / 1.5)
  const newTokens = Math.round(total / 1.5)
  console.log(`\n  全量素材 brief: ${full.length} 字符 ≈ ${fullTokens} token`)
  console.log(`  主题 brief:      ${total} 字符 ≈ ${newTokens} token`)
  console.log(`  节省: ${Math.round((1 - total / Math.max(1, full.length)) * 100)}%`)

  check('★ 主题 brief 比全量素材短', total < full.length, `${total} < ${full.length}`)
  check('★ token 降到 300 以下', newTokens < 300, `${newTokens} token`)
  check('主题 brief 含出处', brief.includes('【这个话题从哪来】'))
}

// ══════════════════════════════════════════════════════════════
// 8. 主题 id 必须是 ASCII（2026-11-18 踩坑）
// ══════════════════════════════════════════════════════════════
{
  // domain 的 per-record 后端拿 key 当文件名 ⇒ 只允许 /^[a-zA-Z0-9_-]+$/
  // 中文 id 会被拒绝，而且**错误被吞 ⇒ 记录静默丢失**。
  check('★ 所有种子 id 都是 path-safe',
    seeds.every((s) => /^[a-zA-Z0-9_-]+$/.test(s.id)),
    seeds.filter((s) => !/^[a-zA-Z0-9_-]+$/.test(s.id)).map((s) => s.id).join(','))
  check('asciiId 把中文转成 ASCII',
    /^[a-zA-Z0-9_-]+$/.test(T.asciiId('哈罗老婆', 'joke')),
    T.asciiId('哈罗老婆', 'joke'))
  check('asciiId 保持原本就 ASCII 的 id',
    T.asciiId('joke-2026-11-14', 'joke') === 'joke-2026-11-14')
  check('★ 不同中文不撞 id',
    T.asciiId('哈罗老婆', 'joke') !== T.asciiId('晚安老婆', 'joke'))
}

fx.cleanup()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
