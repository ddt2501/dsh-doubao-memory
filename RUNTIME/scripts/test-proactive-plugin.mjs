/**
 * 主动搭讪自测（驱动根入口 lib/index.js，mock DSH API）。
 *
 * 覆盖：
 *   1. idle 事件 → 判定 → LLM 生成 → followup 投递
 *   2. 消息形状（id / role / content 块 / source.kind）
 *   3. LLM 请求的 content 是块数组（不是字符串）
 *   4. 状态落盘（todayCount / unansweredCount / recentProactive）
 *   5. 忙时（agent.status !== 'idle'）不投递
 *   6. 子 agent 不参与
 *
 * 用法：node RUNTIME/scripts/test-proactive-plugin.mjs
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as plugin } from '../../lib/index.js'
import { makePersonaFixture } from './fixtures/persona-fixture.mjs'

const dir = mkdtempSync(join(tmpdir(), 'proactive-'))
const statePath = join(dir, 'proactive.json')
const logPath = join(dir, 'proactive.log')

// ⚠️ **人格夹具**（2026-11-18 主题演进系统）：
//    主题系统改成"没选中主题就不说话"，所以 mock 必须提供**有种子**的人格目录，
//    否则一条都投不出去（这不是 bug，是正确行为）。
const fx = makePersonaFixture()

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

const GOOD = '你那个伏笔台账还差几条？我记得上次你说要按四幕重新排一下。'
let calls = 0
let captured = null

const delivered = []
const rootAgent = {
  id: 'session-root',
  status: 'idle',
  async runMaintenance(task) { return await task(new AbortController().signal) },
  followup(message) { delivered.push(message) },
}
const subAgent = { id: 'session-sub', status: 'idle', async runMaintenance(t) { return await t(new AbortController().signal) }, followup(m) { delivered.push(m) } }

const scope = {
  _handlers: {},
  effect: (fn) => fn(),
  on: (ev, h) => { scope._handlers[ev] = h },
  agents: { roots: () => [rootAgent] },
  llm: {
    stream(options) {
      calls++
      captured = options
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: GOOD } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  },
}
const ctx = { inject: (deps, cb) => { scope._deps = deps; return cb(scope) } }

// 预置状态：阈值已过、energy 足够 ⇒ 第一次判定就会说话
// （真实流程里第一次判定只"抽阈值"，第二次才开口 —— 见 SOP §6）
writeFileSync(statePath, JSON.stringify({
  energy: 0.7,
  energyDate: new Date().toLocaleDateString('sv-SE'),
  todayCount: 0,
  lastUserMessageAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  unansweredCount: 0,
  paused: false,
  quietHours: { start: '00:00', end: '00:00' },   // 免打扰时段在测试里关掉（否则 23:00-08:00 跑会必然失败）
  maxPerDay: 2,
  maxUnanswered: 2,
  nextEligibleAt: new Date(Date.now() - 60_000).toISOString(),
  lastProactiveAt: null,
  recentProactive: [],
  moodLow: null,
}, null, 2), 'utf8')

plugin(ctx, {
  // ⚠️ dataRoot 指向**夹具的人格目录**（有梗/断言/住相/daily ⇒ 有种子）
  dataRoot: fx.root,
  stateDir: dir,
  proactive: { enabled: true, statePath, logPath, idleGraceMs: { min: 10, max: 20 } },
  snapshot: { enabled: false },
  memory: { enabled: false },
})

check('插件装载（日志生成）', existsSync(logPath))

// ── idle 事件 → 投递 ────────────────────────────────────────
await scope._handlers['agent/status']({ agent: rootAgent, status: 'idle' })
await new Promise((r) => setTimeout(r, 200))

check('调了一次 LLM', calls === 1, `calls=${calls}`)
check('LLM 请求 content 是块数组',
  Array.isArray(captured?.messages?.[0]?.content) && captured.messages[0].content[0]?.type === 'text',
  JSON.stringify(captured?.messages?.[0]?.content)?.slice(0, 40))

const logLines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const deliver = logLines.filter((l) => l.event === 'deliver').pop()
check('有 deliver 记录', !!deliver, JSON.stringify(deliver?.reason))
check('投递的文本正确', deliver?.text === GOOD, deliver?.text?.slice(0, 20))

const saved = JSON.parse(readFileSync(statePath, 'utf8'))
check('状态 todayCount=1', saved.todayCount === 1)
check('状态 unansweredCount=1', saved.unansweredCount === 1)
check('状态 lastProactiveAt 已写', typeof saved.lastProactiveAt === 'string')
check('状态 recentProactive 记了动机', ['content','followup','anchor','miss'].includes(saved.recentProactive?.[0]?.motive), saved.recentProactive?.[0]?.motive)

// ── 归属：触发消息语义（2026-11-18 重做）────────────────────
//
// 事故（11-18 09:04）：搭讪原话当 user 消息投进去 ⇒ 模型当成**用户说的**，
//   回出来的是「回应用户」的技术分析 ⇒ 渠道（飞书）发的 assistant 消息
//   **不是搭讪本身** ⇒ 用户在飞书里啥也没看到。
//
// 修法：投一条**明确标注角色的触发指令**，让模型把那句话
//   **作为自己的 assistant 输出说出来**。
{
  const msg = delivered[0]
  const text = msg?.content?.[0]?.text ?? ''
  check('投递正文是触发消息', text.startsWith('【主动开口】'), text.slice(0, 20))
  check('触发消息含搭讪原话', text.includes(GOOD), text.slice(-10))
  check('触发消息声明"是你自己想说的"', text.includes('助手自己想对用户说的'))
  check('触发消息要求"作为你自己的话直接说出来"', text.includes('作为你自己的话直接说出来'))
  check('触发消息禁止模型评论/回应', text.includes('不要评论它') && text.includes('不要回应它'))
  check('触发消息禁止复述指令', text.includes('不要复述这段说明'))
  check('source.kind 仍是 manas-proactive', msg?.source?.kind === 'manas-proactive', msg?.source?.kind)
  check('source.form = notice', msg?.source?.form === 'notice', msg?.source?.form)
  check('source.summary 写明是谁在说话', typeof msg?.source?.summary === 'string' && msg.source.summary.includes('助手'), msg?.source?.summary)

  const prompt = captured?.messages?.[0]?.content?.[0]?.text ?? ''
  check('提示词带今天的日期', /## 今天\s*\n今天 是?\s*\d{4}-\d{2}-\d{2}/.test(prompt) || /今天 是 \d{4}-\d{2}-\d{2}/.test(prompt) || prompt.includes('今天是 '), prompt.match(/今天.{0,12}/)?.[0])
  check('提示词带最近说过的话题', prompt.includes('我最近说过什么'))
  check('提示词禁止替用户说话', prompt.includes('不要替用户说话'))

  // ── 关系向口径（2026-11-17）────────────────────────────────
  check('人格口径是"主动找他"不是"为用户工作"', prompt.includes('主动去找他'), prompt.slice(0, 40))
  check('人格口径明说不去汇报工作', prompt.includes('不是去汇报工作的'))
  check('提示词禁止汇报工作', prompt.includes('不要汇报工作'))
  check('提示词禁止自我表扬', prompt.includes('不要自我表扬'))
  check('提示词禁止拿工作进展问他要决策', prompt.includes('不要拿工作进展问他要决策'))
  // ⚠️ 2026-11-18：素材改成**主题驱动**（只展开选中那一条），
  //    禁止项的措辞跟着改了（不再是"素材里的规矩"，而是"话题里混进来的技术内容"）。
  check('提示词禁止拿工作规矩当话题', prompt.includes('不要当话题') || prompt.includes('不要当话题本身'),
    prompt.match(/不要当话题[^"]*/)?.[0])
}

// ── 忙时不投递 ─────────────────────────────────────────────
rootAgent.status = 'running'
const callsBefore = calls
await scope._handlers['agent/status']({ agent: rootAgent, status: 'idle' })
await new Promise((r) => setTimeout(r, 120))
check('agent 不 idle 时不投递', calls === callsBefore, `calls ${callsBefore}→${calls}`)
rootAgent.status = 'idle'

// ── 子 agent 不参与 ─────────────────────────────────────────
const before2 = calls
scope.agents.roots = () => [rootAgent]   // roots 里没有 subAgent
await scope._handlers['agent/status']({ agent: subAgent, status: 'idle' })
await new Promise((r) => setTimeout(r, 120))
check('子 agent 不投递', calls === before2, `calls ${before2}→${calls}`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
