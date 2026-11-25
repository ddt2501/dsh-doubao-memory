/**
 * 2026-11-14 事故回归测试 —— 三处真缺陷 + 两个深层缺陷。
 *
 * 事故：主动搭讪把一句**编造的**话投进了 ingest 会话：
 *   "vault/raw 里那份关于 Claude Code 工具权限的配置又改了……"
 * 那份文件根本不存在。用户信了，回了一句，整条链路都是幻觉。
 *
 * 覆盖：
 *   1. phase 会话**不**投递搭讪的话（闸门）
 *   2. 没有素材时 **content/followup 动机不抽**（不抽 = 不编）
 *   3. 素材**真的进了提示词**（LLM 看得到具体的事）
 *   4. 住相的 daily 摘要能读到了（RAW/conversations 路径 bug）
 *   5. phase 会话**不**生成住相
 *
 * 用法：node RUNTIME/scripts/test-phase-isolation.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as plugin } from '../../lib/index.js'
import { decide } from '../../lib/proactive/decide.js'
import { buildPrompt, validate } from '../../lib/proactive/llm.js'
import { collectMaterial, keepRelationLine } from '../../lib/proactive/material.js'
import { isPhaseAgent, rememberFirstSourceKind, rememberHumanSpoke, isPhaseTitle } from '../../lib/phase-detect.js'
import { mount as mountPhaseQuiet } from '../../lib/phase-quiet.js'
import { rollingSummary } from '../../lib/snapshot/inputs.js'

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

// ── 建一个假的人格实例目录 ────────────────────────────────
// ⚠️ 2026-11-17：搭讪素材**换源**了（只吃关系向内容），
//    所以夹具也得有"关于用户"的东西，否则 collectMaterial 会返回 null。
const dir = mkdtempSync(join(tmpdir(), 'phase-iso-'))
const rawDir = join(dir, 'RAW')
const convDir = join(rawDir, 'conversations')
const vaultDir = join(dir, 'VAULT')
mkdirSync(convDir, { recursive: true })
mkdirSync(vaultDir, { recursive: true })
writeFileSync(join(convDir, '2026-11-13.md'), [
  '# 2026-11-13', '', '## 主题',
  '- 整晚一条主线：把助手从 CLI 版迁到 DSH 官方桌面版。', '',
  '## 关键时刻',
  '- 21:04 - 用户提出迁移；23:55 - 查清重启是我自己排的任务。', '',
  '## 用户提到的新偏好/习惯/梗',
  '- 固定称呼："哈罗"、"晚安老婆"。', '',
  '## 用户纠正/纠正我',
  '- "别用那套了"——说过一次就别再用。',
].join('\n'), 'utf8')
writeFileSync(join(vaultDir, '07-INDEX.md'), [
  '# 07-INDEX', '',
  '- [[05-PROJECTS/工具链]] — DSH 0.2.2-rc.1 主用',
  '- [[02-USER/偏好]] — 成本敏感、只要官方',
].join('\n'), 'utf8')
mkdirSync(join(vaultDir, '02-USER'), { recursive: true })
mkdirSync(join(vaultDir, '03-RELATIONSHIP'), { recursive: true })
writeFileSync(join(vaultDir, '02-USER', '梗.md'), [
  '---', '类型: wiki', '断言:', '  - 用户打招呼的固定开头是哈罗', '---', '',
  '# 梗', '', '## 当前已知的梗', '',
  '## 2026-11-13 - 哈罗（21:04）', '', '用户：哈罗', '', '**为什么是梗**：先认人再谈事。',
].join('\n'), 'utf8')
writeFileSync(join(vaultDir, '02-USER', '偏好.md'), [
  '---', '类型: wiki', '断言:', '  - 用户只接受官方发布的软件', '---', '',
  '# 偏好',
].join('\n'), 'utf8')
writeFileSync(join(vaultDir, '02-USER', '画像.md'), [
  '---', '类型: wiki', '断言:', '  - 用户表面嘴硬心软', '---', '',
  '# 画像',
].join('\n'), 'utf8')
writeFileSync(join(vaultDir, '03-RELATIONSHIP', '橘色与沉浸.md'), [
  '---', '类型: wiki', '断言:', '  - 用户要求自动化 phase 静默运行', '---', '',
  '# 橘色与沉浸',
].join('\n'), 'utf8')
writeFileSync(join(vaultDir, '03-RELATIONSHIP', '模式发现.md'), [
  '---', '类型: wiki', '断言:', '  - 用户需要确定性而非承诺', '---', '',
  '# 模式发现',
].join('\n'), 'utf8')

const paths = { raw: rawDir, vault: vaultDir }

// ── 1. phase 会话识别 ──────────────────────────────────────
{
  const phaseAgent = { id: 'phase-1', session: { header: { id: 'phase-1' } } }
  const normalAgent = { id: 'normal-1', session: { header: { id: 'normal-1' } } }

  // 首条消息是 schedule ⇒ 是 phase 会话
  rememberFirstSourceKind(phaseAgent, 'schedule')
  check('首条 source=schedule ⇒ 判为 phase 会话', isPhaseAgent(phaseAgent, {}))

  // 首条消息是 user ⇒ 不是 phase 会话
  rememberFirstSourceKind(normalAgent, 'user')
  check('首条 source=user ⇒ 不判为 phase 会话', !isPhaseAgent(normalAgent, {}))

  // 标题兜底
  check('标题以「助手·」开头 ⇒ 判为 phase', isPhaseTitle('助手·Daily Ingest · 2026-11-14 17:54'))
  check('普通标题 ⇒ 不判为 phase', !isPhaseTitle('DSH 迁移讨论'))

  // 用户在 phase 会话里说过话 ⇒ 那个会话已经是真人的对话，不再算 phase
  const mixed = { id: 'mixed-1', session: { header: { id: 'mixed-1' } } }
  rememberFirstSourceKind(mixed, 'schedule')
  check('刚认出是 phase', isPhaseAgent(mixed, {}))
  rememberHumanSpoke(mixed, true)
  check('用户说过话 ⇒ 不再算 phase（要正常生成住相）', !isPhaseAgent(mixed, {}))
}

// ── 2. 没有素材时，content/followup 动机不抽 ───────────────
{
  const cfg = { energyRange: { min: 0.15, max: 0.85 }, quietHours: { start: '23:00', end: '08:00' }, maxPerDay: 2, maxUnanswered: 2 }
  const mk = () => ({
    energy: 0.9, energyDate: '2026-11-14', todayCount: 0,
    lastUserMessageAt: '2026-11-14T10:00:00+08:00', unansweredCount: 0, paused: false,
    quietHours: cfg.quietHours, maxPerDay: 2, maxUnanswered: 2,
    nextEligibleAt: '2026-11-14T09:00:00+08:00', lastProactiveAt: null, recentProactive: [], moodLow: null,
  })

  let sawContent = 0
  let sawFollowup = 0
  for (let i = 0; i < 400; i++) {
    const s = mk()
    const v = decide(s, cfg, new Date('2026-11-14T20:00:00+08:00'), false)   // 无素材
    if (v.motive === 'content') sawContent++
    if (v.motive === 'followup') sawFollowup++
  }
  check('无素材 ⇒ 绝不抽 content 动机', sawContent === 0, `抽到 ${sawContent} 次`)
  check('无素材 ⇒ 绝不抽 followup 动机', sawFollowup === 0, `抽到 ${sawFollowup} 次`)

  let sawContentWith = 0
  for (let i = 0; i < 200; i++) {
    const s = mk()
    const v = decide(s, cfg, new Date('2026-11-14T20:00:00+08:00'), true)    // 有素材
    if (v.motive === 'content') sawContentWith++
  }
  check('有素材 ⇒ content 动机可抽', sawContentWith > 0, `抽到 ${sawContentWith}/200`)
}

// ── 3. 素材真的进了提示词 ─────────────────────────────────
// ⚠️ 2026-11-17：素材**换源**了——不再吃 daily 的「主题/关键时刻」
//    （那是我自己的工作日志），改吃「用户提到的新偏好/习惯/梗」
//    +「用户纠正/纠正我」+ 我们的梗 + 关系断言。
{
  const material = collectMaterial(paths)
  check('能收到素材', material?.hasContent === true)
  check('素材含真实日期', /^\d{4}-\d{2}-\d{2}$/.test(material?.daily?.[0]?.day ?? ''), material?.daily?.[0]?.day)
  check('素材含我们的梗', (material?.jokes?.length ?? 0) > 0, `jokes=${material?.jokes?.length}`)
  check('素材含关系断言', (material?.notes?.length ?? 0) > 0, `notes=${material?.notes?.length}`)
  check('素材**不含**工作日志的「主题」段', !(material?.brief ?? '').includes('## 主题'))
  check('素材**不含**工作日志的「我做了哪些事」', !(material?.brief ?? '').includes('我做了哪些事'))
  check('素材**不含**事务规矩条目', !(material?.brief ?? '').includes('改插件的规矩'), '事务行过滤失效')

  // 事务行过滤单测
  {
    check('事务行被剔除', keepRelationLine('- **改插件的规矩**：先 dry run、再提交 git。') === false)
    check('关系行保留', keepRelationLine('- 固定称呼："哈罗，老婆"、"晚安老婆"。') === true)
    check('梗被保留', keepRelationLine('- "喵喵喵！"——第一次拿猫叫开场，记下来当新梗观察。') === true)
  }

  const prompt = buildPrompt({ moodLow: null, unansweredCount: 0 }, { motive: 'content' }, new Date('2026-11-14T20:00:00+08:00'), material)
  check('提示词含素材原文（关系向）', prompt.includes('哈罗'), prompt.slice(0, 60))
  check('提示词含素材原文（我们的梗）', prompt.includes('我们之间的默契') || prompt.includes('默契'))
  // ⚠️ 2026-11-18：素材改成主题驱动 ⇒ "素材"改成"话题"
  check('提示词明确禁止编造',
    prompt.includes('不要提到素材里没有的具体事物') || prompt.includes('不要提到话题里没有的具体事物'),
    prompt.match(/不要提到[^"]{0,20}/)?.[0])
  check('提示词禁止拿工作规矩当话题', prompt.includes('不要当话题'))

  // 没有素材时，提示词必须明说"不许编"
  const bare = buildPrompt({ moodLow: null, unansweredCount: 0 }, { motive: 'content' }, new Date('2026-11-14T20:00:00+08:00'), null)
  check('无素材时提示词明说别编', bare.includes('不许编造任何具体的事'))
}

// ── 3b. 事务腔硬闸（2026-11-17）────────────────────────────
// 11-17 上午那三条**每一条都含事务词** ⇒ 现在必须全部被拦下。
// 这是"提示词说别做"之外的第二道保证。
{
  const cfg = { energyRange: { min: 0.15, max: 0.85 }, quietHours: { start: '23:00', end: '08:00' }, maxPerDay: 2, maxUnanswered: 2 }
  const mk = () => ({
    energy: 0.9, energyDate: '2026-11-14', todayCount: 0,
    lastUserMessageAt: '2026-11-14T10:00:00+08:00', unansweredCount: 0, paused: false,
    quietHours: cfg.quietHours, maxPerDay: 2, maxUnanswered: 2,
    nextEligibleAt: '2026-11-14T09:00:00+08:00', lastProactiveAt: null, recentProactive: [], moodLow: null,
  })

  const three = [
    '前天那句"这4个自动化任务应该静默运行"已经兑现了，后面我没再拿后台动静打扰你。',
    '你前天说那四个自动化任务该静默运行，后来真的一天没来烦你，这才叫守规矩。',
    '用户，插件人格配置这条线已经闭环了；接下来要继续扩功能，还是先消化这轮实战反馈？',
  ]
  for (const [i, t] of three.entries()) {
    check(`事务腔硬闸拦下 11-17 实际投递的第 ${i + 1} 条`, validate(t) === false, t.slice(0, 24))
  }

  // 关系向的话应该放行
  const ok = ['你今天那句"喵喵喵"我还在琢磨，什么意思啊', '你那个猫视角写起来顺不顺']
  for (const t of ok) {
    check(`关系向的话放行：${t.slice(0, 12)}`, validate(t) === true)
  }
}

// ── 4. 住相的 daily 摘要路径 bug ──────────────────────────
{
  const summary = rollingSummary(rawDir, 5, 500)
  check('rollingSummary 能读到 daily（RAW/conversations）', summary !== null && summary.includes('2026-11-13'), summary?.slice(0, 40))
}

// ── 5. 端到端：phase 会话不投递搭讪 ────────────────────────
{
  const statePath = join(dir, 'proactive.json')
  const logPath = join(dir, 'proactive.log')
  let calls = 0
  const delivered = []

  const phaseAgent = {
    id: 'session-phase', status: 'idle',
    session: { header: { id: 'session-phase' } },
    async runMaintenance(t) { return await t(new AbortController().signal) },
    followup(m) { delivered.push(m) },
  }
  const normalAgent = {
    id: 'session-normal', status: 'idle',
    session: { header: { id: 'session-normal' } },
    async runMaintenance(t) { return await t(new AbortController().signal) },
    followup(m) { delivered.push(m) },
  }

  const scope = {
    _handlers: {},
    effect: (fn) => fn(),
    on: (ev, h) => { scope._handlers[ev] = h },
    get: () => undefined,
    agents: { roots: () => [phaseAgent, normalAgent] },
    llm: {
      stream() {
        calls++
        return (async function* () {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '你那个伏笔台账还差几条？' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const ctx = { inject: (deps, cb) => { scope._deps = deps; return cb(scope) } }

  writeFileSync(statePath, JSON.stringify({
    energy: 0.9, energyDate: new Date().toLocaleDateString('sv-SE'),
    todayCount: 0, lastUserMessageAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    unansweredCount: 0, paused: false, quietHours: { start: '00:00', end: '00:00' },
    maxPerDay: 5, maxUnanswered: 5,
    nextEligibleAt: new Date(Date.now() - 60_000).toISOString(),
    lastProactiveAt: null, recentProactive: [], moodLow: null,
  }, null, 2), 'utf8')

  plugin(ctx, {
    dataRoot: dir, stateDir: dir,
    proactive: { enabled: true, statePath, logPath, idleGraceMs: { min: 10, max: 20 } },
    snapshot: { enabled: false },
    memory: { enabled: false },
  })

  // phase 会话：标记它是 schedule 来的
  rememberFirstSourceKind(phaseAgent, 'schedule')

  await scope._handlers['agent/status']({ agent: phaseAgent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 150))
  check('phase 会话不投递搭讪', delivered.length === 0, `投递了 ${delivered.length} 条`)

  // 普通会话：应该投递
  await scope._handlers['agent/status']({ agent: normalAgent, status: 'idle' })
  await new Promise((r) => setTimeout(r, 150))
  check('普通会话照常投递', delivered.length === 1, `投递了 ${delivered.length} 条`)
  check('投递的 source 是 manas-proactive', delivered[0]?.source?.kind === 'manas-proactive', delivered[0]?.source?.kind)

  // 日志里应有 phase-session 的 skip
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  check('日志记录了 phase-session 跳过', lines.some((l) => l.event === 'skip' && l.reason === 'phase-session'))
}

// ── 6. phase-quiet 的归档保护（防"弄丢用户的对话"）─────────
{
  const archived = []

  // 场景 A：纯 phase 会话（只有 schedule 消息）⇒ 该归档
  const purePhase = {
    id: 'session-pure',
    session: { header: { id: 'session-pure' } },
  }
  const scopeA = {
    _handlers: {},
    effect: (fn) => fn(),
    on: (ev, h) => { scopeA._handlers[ev] = h },
    get: (name) => {
      if (name === 'workspaceRegistry') {
        return { archiveSession: async (id) => { archived.push(id) } }
      }
      if (name === 'sessions') {
        return {
          get: (id) => ({
            snapshotEvents: () => ([
              { type: 'user/message', data: { source: { kind: 'schedule' } } },
            ]),
          }),
        }
      }
      return undefined
    },
  }
  mountPhaseQuiet(scopeA, {}, join(dir, 'quiet-a.log'))

  // 模拟 pre-step：首条是 schedule
  await scopeA._handlers['agent/pre-step']({
    agent: purePhase,
    messages: [{ role: 'user', source: { kind: 'schedule' } }],
  }, async () => ({ kind: 'allow' }))
  await scopeA._handlers['agent/status']({ agent: purePhase, status: 'idle' })
  await new Promise((r) => setTimeout(r, 60))
  check('纯 phase 会话 ⇒ 归档', archived.includes('session-pure'), `归档了 ${archived.length} 个`)

  // 场景 B：用户在这个会话里说过话 ⇒ 绝不能归档
  archived.length = 0
  const mixed = {
    id: 'session-mixed',
    session: { header: { id: 'session-mixed' } },
  }
  const scopeB = {
    _handlers: {},
    effect: (fn) => fn(),
    on: (ev, h) => { scopeB._handlers[ev] = h },
    get: (name) => {
      if (name === 'workspaceRegistry') {
        return { archiveSession: async (id) => { archived.push(id) } }
      }
      if (name === 'sessions') {
        return {
          get: () => ({
            snapshotEvents: () => ([
              { type: 'user/message', data: { source: { kind: 'schedule' } } },
              { type: 'user/message', data: { source: { kind: 'user' } } },   // 真人
            ]),
          }),
        }
      }
      return undefined
    },
  }
  mountPhaseQuiet(scopeB, {}, join(dir, 'quiet-b.log'))

  await scopeB._handlers['agent/pre-step']({
    agent: mixed,
    messages: [
      { role: 'user', source: { kind: 'schedule' } },
      { role: 'user', source: { kind: 'user' } },         // 真人从 GUI 发的
    ],
  }, async () => ({ kind: 'allow' }))
  await scopeB._handlers['agent/status']({ agent: mixed, status: 'idle' })
  await new Promise((r) => setTimeout(r, 60))
  check('用户在 phase 会话里说过话 ⇒ 不归档', archived.length === 0, `归档了 ${archived.length} 个`)

  // 场景 C：读不出会话 ⇒ 保守不归档
  archived.length = 0
  const unknown = { id: 'session-unknown', session: { header: { id: 'session-unknown' } } }
  const scopeC = {
    _handlers: {},
    effect: (fn) => fn(),
    on: (ev, h) => { scopeC._handlers[ev] = h },
    get: (name) => (name === 'workspaceRegistry'
      ? { archiveSession: async (id) => { archived.push(id) } }
      : undefined),
  }
  mountPhaseQuiet(scopeC, {}, join(dir, 'quiet-c.log'))
  await scopeC._handlers['agent/pre-step']({
    agent: unknown,
    messages: [{ role: 'user', source: { kind: 'schedule' } }],
  }, async () => ({ kind: 'allow' }))
  await scopeC._handlers['agent/status']({ agent: unknown, status: 'idle' })
  await new Promise((r) => setTimeout(r, 60))
  check('读不出会话内容 ⇒ 保守不归档', archived.length === 0, `归档了 ${archived.length} 个`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
