/**
 * 人格记忆系统（LLM Wiki 四相）接线自测。
 *
 * 驱动**根入口**（lib/index.js），用 mock 的 schedule 服务验证：
 *   1. 从 REGISTRY.json 读出 4 个 phase
 *   2. prompt 取 promptFile 里第一个代码块
 *   3. cron / time_zone 原样传给 schedule.create
 *   4. 幂等：已有同名任务 ⇒ 不重复注册
 *   5. 路径可移植：prompt 里的包根绝对路径被替换成 dataRoot
 *
 * 用法：node RUNTIME/scripts/test-memory-system.mjs
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply as plugin } from '../../lib/index.js'
import { armPhaseCleanup, disarmPhaseCleanup, cleanupPhaseTasks } from '../../lib/memory-system.js'

// ⚠️ stateDir 必须指向临时目录 —— 否则自测的日志会写进真实的 RUNTIME/state，
//    和服务器自己的日志混在一起（2026-11-10 踩过）。
// ⚠️ DSH_HOME 也要隔离：paths.js 的兜底是 `$DSH_HOME/personas/<名字>`，
//    不隔离的话自测会把模板人格实例（和 .doubao-phase-binding.json）写进真实人格库
//    （2026-11-14 加卸载清理测试时才发现，清掉了 4 个测试实例）。
const tmp = mkdtempSync(join(tmpdir(), 'memsys-'))
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'memsys-home-'))

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

const created = []
let listed = []

const scope = {
  _handlers: {},
  effect: (fn) => fn(),
  on: (ev, h) => { scope._handlers[ev] = h },
  agents: { roots: () => [] },
  llm: { stream: () => (async function* () {})() },
  schedule: {
    // ⚠️ 真实 API 返回的是 **items**（dsh-schedule/lib/index.js:2276）
    async list() { return { items: listed, shown: listed.length, total: listed.length, limit: 200, offset: 0 } },
    async create(req) { created.push(req); return { id: `sched-${created.length}` } },
  },
}
const ctx = { inject: (deps, cb) => { scope._deps = deps; return cb(scope) } }

// 用真实的 REGISTRY.json + 真实的 prompt 文件（dataRoot = 包根）
plugin(ctx, {
  stateDir: tmp,
  proactive: { enabled: false },
  snapshot: { enabled: false },
  memory: { enabled: true, targetCwd: 'D:\\dsh', userName: '用户', assistantName: '助手' },
})

await new Promise((r) => setTimeout(r, 300))

check('注册了 4 个 phase', created.length === 4, `created=${created.length}`)

const byTitle = Object.fromEntries(created.map((c) => [c.title, c]))
const expect = [
  ['助手·Daily Ingest', '0 4 * * *'],
  ['助手·Weekly Wiki', '0 22 * * 0'],
  ['助手·Weekly Lint', '30 22 * * 0'],
  ['助手·5-day Reflect', '0 0 * * *'],
]
for (const [title, cron] of expect) {
  const c = byTitle[title]
  check(`${title} 已注册`, !!c)
  if (!c) continue
  check(`${title} cron=${cron}`, c.timing?.kind === 'cron' && c.timing.cron.expression === cron,
    c.timing?.cron?.expression)
  check(`${title} time_zone=Asia/Shanghai`, c.timing?.cron?.time_zone === 'Asia/Shanghai')
  check(`${title} prompt 非空`, typeof c.prompt === 'string' && c.prompt.length > 100, `${c.prompt?.length} 字符`)
  check(`${title} prompt 不含代码围栏`, !c.prompt.includes('```'))
  check(`${title} target 是 new（每次全新 session，不背主对话 history）`, c.target?.kind === 'new', c.target?.kind)
}

// reflect 的 prompt 必须提到 5 天节流
const reflect = byTitle['助手·5-day Reflect']
check('reflect prompt 含节流规则', /5\s*天|cycle/i.test(reflect?.prompt ?? ''))

// 幂等：已有同名任务 ⇒ 不再注册
created.length = 0
listed = expect.map(([title]) => ({ title }))
const scope2 = { ...scope, _handlers: {}, schedule: scope.schedule }
const ctx2 = { inject: (deps, cb) => { scope2._deps = deps; return cb(scope2) } }
plugin(ctx2, { stateDir: tmp, proactive: { enabled: false }, snapshot: { enabled: false }, memory: { enabled: true, userName: '用户', assistantName: '助手' } })
await new Promise((r) => setTimeout(r, 300))
check('已有同名任务 ⇒ 不重复注册', created.length === 0, `created=${created.length}`)

// ── 空白安装 + 目标模式 ─────────────────────────────────────────
// 2026-11-11 起默认 targetMode='new'：每次触发开全新 session。
// 好处是**不再依赖"已有会话"**（空白安装首次挂载就能注册），
// 而且 phase 的 history 从 0 开始（不再背主对话的几十万 tok）。
{
  const tmp3 = mkdtempSync(join(tmpdir(), 'memsys3-'))
  const created3 = []
  let roots3 = []                      // 模拟"还没有会话"
  const scope3 = {
    _handlers: {},
    effect: (fn) => fn(),
    on: (ev, h) => { scope3._handlers[ev] = h },
    agents: { roots: () => roots3 },
    schedule: {
      async list() { return { items: [], shown: 0, total: 0, limit: 200, offset: 0 } },
      async create(r) {
        created3.push(r)
        return { id: `s-${created3.length}` }
      },
    },
  }
  const ctx3 = { inject: (deps, cb) => { scope3._deps = deps; return cb(scope3) } }
  plugin(ctx3, {
    stateDir: tmp3,
    proactive: { enabled: false },
    snapshot: { enabled: false },
    personaEntry: { enabled: false },
    memory: { enabled: true, userName: '小王', assistantName: '小助手' },
  })
  await new Promise((r) => setTimeout(r, 300))
  check('没有会话也能注册（new 不依赖现有会话）', created3.length === 4, `created=${created3.length}`)
  check('投递目标是 new（每次全新 session）', created3[0]?.target?.kind === 'new', created3[0]?.target?.kind)
  check('new 带上 targetCwd', typeof created3[0]?.target?.create?.cwd === 'string', created3[0]?.target?.create?.cwd)
  check('标题带的是真名不是占位符', created3[0]?.title === '小助手·Daily Ingest', created3[0]?.title)
  check('prompt 里没有残留占位符', !/\{PKG\}|\{DATA\}|\{USER\}|\{ASSISTANT\}/.test(created3[0]?.prompt ?? ''))

  // 已全部注册 ⇒ agent/created 不该再重复注册
  roots3 = [{ id: 'session-abc' }]
  await scope3._handlers['agent/created']({ agent: roots3[0], source: 'startup' })
  await new Promise((r) => setTimeout(r, 4000))
  check('已注册完 ⇒ agent/created 不重复注册', created3.length === 4, `created=${created3.length}`)
}

// ── 降级链：Host 建不了 session 时 new → new_once → session ──────
{
  const tmp5 = mkdtempSync(join(tmpdir(), 'memsys5-'))
  const created5 = []
  const roots5 = [{ id: 'session-fallback' }]
  const scope5 = {
    _handlers: {},
    effect: (fn) => fn(),
    on: (ev, h) => { scope5._handlers[ev] = h },
    agents: { roots: () => roots5 },
    schedule: {
      async list() { return { items: [], shown: 0, total: 0, limit: 200, offset: 0 } },
      async create(r) {
        // 模拟 Host 没有 sessionController：new / new_once 都被拒
        if (r.target?.kind === 'new' || r.target?.kind === 'new_once') {
          throw new Error('This Host cannot create Sessions; choose an existing Session target.')
        }
        created5.push(r)
        return { id: `s-${created5.length}` }
      },
    },
  }
  const ctx5 = { inject: (deps, cb) => { scope5._deps = deps; return cb(scope5) } }
  plugin(ctx5, {
    stateDir: tmp5,
    proactive: { enabled: false },
    snapshot: { enabled: false },
    personaEntry: { enabled: false },
    memory: { enabled: true, userName: '小王', assistantName: '小助手' },
  })
  await new Promise((r) => setTimeout(r, 400))
  check('建不了 session ⇒ 降级到现有会话', created5.length === 4, `created=${created5.length}`)
  check('降级后的 target 是 session', created5[0]?.target?.kind === 'session' && created5[0]?.target?.sessionId === 'session-fallback',
    JSON.stringify(created5[0]?.target))
}

// ── 配置形状：称呼写在顶层也要认 ────────────────────────────────
// 2026-11-10 踩过：profile 里写的是 `memory.userName`，
// 而插件只读顶层 ⇒ 线上跑的是默认的「用户/助手」，人格名字悄悄丢了。
{
  const tmp4 = mkdtempSync(join(tmpdir(), 'memsys4-'))
  const created4 = []
  const entryPath = join(tmp4, 'AGENTS.md')
  const scope4 = {
    _handlers: {},
    effect: (fn) => fn(),
    on: (ev, h) => { scope4._handlers[ev] = h },
    agents: { roots: () => [{ id: 'session-xyz' }] },
    schedule: {
      async list() { return { items: [], shown: 0, total: 0, limit: 200, offset: 0 } },
      async create(r) { created4.push(r); return { id: `s-${created4.length}` } },
    },
  }
  const ctx4 = { inject: (deps, cb) => { scope4._deps = deps; return cb(scope4) } }
  plugin(ctx4, {
    stateDir: tmp4,
    proactive: { enabled: false },
    snapshot: { enabled: false },
    personaEntry: { enabled: true, path: entryPath },
    // ⚠️ 称呼只在**顶层**，memory 里没有 ⇒ 也必须生效
    userName: '老王',
    assistantName: '小艺',
    memory: { enabled: true },
  })
  await new Promise((r) => setTimeout(r, 400))
  check('顶层称呼生效：phase 标题用真名', created4[0]?.title === '小艺·Daily Ingest', created4[0]?.title)
  check('顶层称呼生效：prompt 无残留占位符',
    !/\{PKG\}|\{DATA\}|\{USER\}|\{ASSISTANT\}/.test(created4[0]?.prompt ?? ''))
  check('人格入口写出来了', existsSync(entryPath))
  if (existsSync(entryPath)) {
    const txt = readFileSync(entryPath, 'utf8')
    check('人格入口用了顶层称呼', txt.includes('小艺'))
    check('人格入口没有字面占位符', !/\{PKG\}|\{DATA\}|\{USER\}|\{ASSISTANT\}/.test(txt))
  }
}

// ── 卸载收尾：只删自己注册的四个 phase ──────────────────────────
// 背景：插件卸载/停用后，schedule 里的任务不会自己消失——不移除就会空跑。
// 重载则必须保留任务（30 秒内重新 apply 会 disarm 取消删除）。
{
  const root = mkdtempSync(join(tmpdir(), 'memsys-cleanup-'))
  const dataRoot = join(root, 'persona', '测试')
  mkdirSync(dataRoot, { recursive: true })
  const bindingFile = join(dirname(dataRoot), '.doubao-phase-binding.json')
  const ourTitles = ['小助手·Daily Ingest', '小助手·Weekly Wiki', '小助手·Weekly Lint', '小助手·5-day Reflect']
  writeFileSync(bindingFile, JSON.stringify({ dataRoot, titles: ourTitles, mode: 'new' }))

  const removed = []
  const tasks = [
    { id: 'p1', title: ourTitles[0] },
    { id: 'p2', title: ourTitles[1] },
    { id: 'p3', title: ourTitles[2] },
    { id: 'p4', title: ourTitles[3] },
    { id: 'x1', title: '用户自己建的任务' },
  ]
  const sched = {
    async list() { return { items: tasks } },
    async edit({ id, action }) { if (action === 'delete') removed.push(id) },
  }
  const paths = { dataRoot }
  const logFile = join(root, 'log.jsonl')

  const res = await cleanupPhaseTasks(sched, paths, logFile)
  check('卸载清理删掉 4 个 phase', res.deleted === 4 && removed.length === 4, `deleted=${res.deleted}`)
  check('卸载清理不碰别人的任务', !removed.includes('x1'))

  // 没有 binding（插件从没注册过）⇒ 不删任何东西
  const emptyRoot = mkdtempSync(join(tmpdir(), 'memsys-nobind-'))
  const res2 = await cleanupPhaseTasks(sched, { dataRoot: join(emptyRoot, 'nobody') }, join(emptyRoot, 'log.jsonl'))
  check('没有 binding 文件 ⇒ 不删任务', res2.deleted === 0, `deleted=${res2.deleted}`)

  // 重载：dispose 后 30 秒内重新 apply ⇒ 取消，任务保留
  removed.length = 0
  armPhaseCleanup(sched, paths, logFile, 60)
  const cancelled = disarmPhaseCleanup(logFile)
  await new Promise((r) => setTimeout(r, 200))
  check('重载 ⇒ 取消卸载清理（任务保留）', cancelled === true && removed.length === 0, `removed=${removed.length}`)

  // 真卸载：没人取消 ⇒ 到期后删
  removed.length = 0
  armPhaseCleanup(sched, paths, logFile, 60)
  await new Promise((r) => setTimeout(r, 250))
  check('真卸载 ⇒ 到期后删任务', removed.length === 4, `removed=${removed.length}`)

  // 不留模块级定时器给后续用例
  disarmPhaseCleanup(logFile)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
