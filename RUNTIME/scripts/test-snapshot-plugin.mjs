/**
 * per-turn 住相自测（驱动根入口 lib/index.js，mock DSH API）。
 *
 * 住相走 **system prompt 的 section**（自我意识的投射），生成在**后台**跑，
 * 触发点是 **agent 转 idle** ⇒ 滞后一轮、零延迟。
 *
 * 覆盖：
 *   1. section 注册（名字 / 顺序 / interpolate=false）
 *   2. 生成不阻塞任何回调
 *   3. section 文本 = 框架句 + 住相（自我意识，不是用户的话）
 *   4. 子 agent → section 为空
 *   5. 指纹去重
 *   6. 工具理性词 → 重试（带负面示例）→ 连续失败 → 兜底 → 模式 B
 *   7. metrics 落盘
 *
 * 用法：node RUNTIME/scripts/test-snapshot-plugin.mjs
 */
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as plugin } from '../../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'snapshot-'))
const logPath = join(dir, 'snapshot.log')
const metricsDir = join(dir, 'metrics')

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

const GOOD = '我看到用户在梳理优先级——他确认了我对降级路径的理解，但同时指出降级不该频繁触发。此刻我感到被认真对待的安定。'
const BAD_INSTRUMENTAL = '用户应该先把 Phase 0 的设计文档全部定稿，然后进入下一步的实现阶段。我建议他这么做，这样比较稳妥，也不会有太多的返工成本，整体的风险也更低一些。'

const queue = []
let calls = 0
const prompts = []

const rootAgent = { id: 'session-root', status: 'idle' }
const subAgent = { id: 'session-sub', status: 'idle' }

const sections = []
const scope = {
  _handlers: {},
  effect: (fn) => fn(),
  on: (ev, h) => { scope._handlers[ev] = h },
  agents: { roots: () => [rootAgent] },
  systemPrompt: { section(def) { sections.push(def); return def } },
  llm: {
    stream(options) {
      calls++
      prompts.push(options.messages[0].content[0].text)
      const text = queue.length > 1 ? queue.shift() : queue[0]
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  },
}
const ctx = {
  inject: (deps, cb) => {
    // 真实 cordis 允许同一插件多次 inject（根入口就用了三次：proactive / snapshot /
    // memory + 一个"清理"用的 schedule 注入）⇒ mock 必须记录**全部**次，
    // 不能用最后一次覆盖（2026-11-14 加卸载清理时踩到）。
    ;(scope._deps ??= []).push(deps)
    return cb(scope)
  },
}

plugin(ctx, {
  dataRoot: dir,
  stateDir: dir,
  proactive: { enabled: false },
  snapshot: { enabled: true, logPath, metricsDir, timeoutMs: 5000, maxAttempts: 2 },
  memory: { enabled: false },
})

// 插件可能注册多个 section（快照 + devmode 协调者等）⇒ 按名字取快照段，不能假设它是最后一个。
const section = sections.find((s) => s.name === 'manas-snapshot')

const preStep = (agent, turn, msg) => scope._handlers['agent/pre-step'](
  { agent, messages: [{ role: 'user', content: [{ type: 'text', text: msg }] }], turn, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: msg }] }] }),
)
const goIdle = (agent) => scope._handlers['agent/status']({ agent, status: 'idle' })
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 25)) }

check('插件装载', existsSync(logPath))
check('inject 依赖含 agents + llm + systemPrompt',
  scope._deps.some((d) => d.includes('agents') && d.includes('llm') && d.includes('systemPrompt')),
  scope._deps.map((d) => d.join('+')).join(' | '))
check('注册了 section', !!section && section.name === 'manas-snapshot')
check('section interpolate=false', section?.interpolate === false)
check('section order 在 persona suffix 之后', section?.order > 10200, String(section?.order))

// ── 1. 捕获消息（不调 LLM）────────────────────────────────
queue.length = 0; queue.push(GOOD)
const t0 = Date.now()
await preStep(rootAgent, 1, '今天累了')
check('pre-step 只捕获消息，不调 LLM', calls === 0 && Date.now() - t0 < 200, `calls=${calls}`)

// ── 2. 转 idle 时后台生成 ──────────────────────────────────
const t1 = Date.now()
await goIdle(rootAgent)
check('idle 处理立即返回（不 await 生成）', Date.now() - t1 < 400, `${Date.now() - t1}ms`)
check('后台生成已启动', calls === 1, `calls=${calls}`)

await settle()
check('section 文本 = 框架句 + 住相',
  String(section.text({ agent: rootAgent })).includes('自我意识') && String(section.text({ agent: rootAgent })).includes(GOOD))
check('section 文本声明不是用户的话', String(section.text({ agent: rootAgent })).includes('不是用户的话'))
check('子 agent → section 为空', section.text({ agent: subAgent }) === '')
check('metrics 落盘', existsSync(metricsDir) && readdirSync(metricsDir).length === 1)
const metric = JSON.parse(readFileSync(join(metricsDir, readdirSync(metricsDir)[0]), 'utf8').trim())
check('metric.channel=system-prompt/section', metric.channel === 'system-prompt/section', metric.channel)
check('metric.mode=A', metric.mode === 'A')
check('metric 无兜底', metric.fallback_used === false)

// ── 3. 指纹去重 ───────────────────────────────────────────
const before = calls
await preStep(rootAgent, 2, '今天累了')
await goIdle(rootAgent)
await settle()
check('相同输入不重复生成', calls === before, `calls ${before}→${calls}`)

// ── 4. 工具理性词 → 重试（带负面示例）──────────────────────
queue.length = 0; queue.push(BAD_INSTRUMENTAL); queue.push(GOOD)
const before3 = calls
await preStep(rootAgent, 3, '换个话题')
await goIdle(rootAgent)
await settle()
check('工具理性词触发重试', calls === before3 + 2, `calls +${calls - before3}`)
check('重试的 prompt 带负面示例', prompts[prompts.length - 1].includes('避开这些词'))

// ── 5. 连续失败 → 兜底 + 模式 B ───────────────────────────
for (const turn of [4, 5, 6]) {
  queue.length = 0; queue.push(BAD_INSTRUMENTAL)
  await preStep(rootAgent, turn, `失败轮 ${turn}`)
  await goIdle(rootAgent)
  await settle()
}
const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const gens = lines.filter((l) => l.event === 'generated')
const modes = gens.map((l) => l.mode)
check('连续失败后进入模式 B', modes.includes('B'), modes.join(','))
// ⚠️ 2026-11-11：兜底**不能拼用户原话**——
// 旧实现返回「上轮住相 | 当前消息前 50 字」，导致用户的招呼
// 被拼进 system prompt 里的住相区（实测出现过 `…… | 老婆好`）。
// 住相是"我的视角"，不是复述他的话。
const fallbacks = gens.filter((l) => l.fallback === true)
check('失败时走兜底文案', fallbacks.length > 0)
check(
  '兜底文案不拼用户原话',
  fallbacks.length > 0 && fallbacks.every((l) => !String(l.text ?? '').includes('失败轮')),
  fallbacks.map((l) => String(l.text ?? '').slice(0, 40)).join(' / '),
)

// ── 6. step != 1 不捕获 ───────────────────────────────────
const before5 = calls
await scope._handlers['agent/pre-step'](
  { agent: rootAgent, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], turn: 9, step: 2, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }),
)
await goIdle(rootAgent)
await settle()
check('step 2 不触发生成', calls === before5)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
