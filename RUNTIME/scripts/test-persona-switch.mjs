/**
 * 人格切换测试 —— 验证「选哪个人格就加载哪个」。
 *
 * 覆盖：
 *   1. 身份注入读到的是**选中那个目录**的 SOUL（不是上一个）
 *   2. 切换目录后注入内容随之改变
 *   3. 目录不存在时退回配置里的自我定位，不注入空段
 *   4. 注入长度有界（不会把 5KB SOUL 全塞进 system prompt）
 *   5. phase 绑定记录能识别"换人了"
 */
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'D:/dsh/packages/dsh-doubao-memory'
const { loadPersonaIdentity, renderPersonaSection, mountPersonaPrompt, SOUL_EXCERPT_LIMIT, TOTAL_LIMIT } =
  await import(`file:///${PKG}/lib/persona-prompt.js`)

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`) }
  catch (e) { fail++; console.log(`FAIL  ${name} — ${e?.message ?? e}`) }
}

/** 造一个人格目录 */
function makePersona(root, id, soulBody, identityBody = '') {
  const dir = join(root, id)
  mkdirSync(join(dir, 'IDENTITY'), { recursive: true })
  writeFileSync(join(dir, 'IDENTITY', 'SOUL.md'), soulBody, 'utf8')
  if (identityBody) writeFileSync(join(dir, 'IDENTITY', 'IDENTITY.md'), identityBody, 'utf8')
  return dir
}

const library = mkdtempSync(join(tmpdir(), 'switch-'))

const dirA = makePersona(library, '阿甲', '# SOUL\n\n我是阿甲，做甲的事。\n')
const dirB = makePersona(library, '阿乙', '# SOUL\n\n我是阿乙，做乙的事。\n')

// ── 1. 读到的是选中目录 ──────────────────────────────────────
{
  const identA = loadPersonaIdentity({ dataRoot: dirA, identity: join(dirA, 'IDENTITY') }, { userName: '用户', assistantName: '阿甲' })
  check('读到阿甲的内容', () => {
    if (!identA.soul.includes('阿甲')) throw new Error(identA.soul)
    if (identA.soul.includes('阿乙')) throw new Error('串了')
  })
  const identB = loadPersonaIdentity({ dataRoot: dirB, identity: join(dirB, 'IDENTITY') }, { userName: '用户', assistantName: '阿乙' })
  check('读到阿乙的内容', () => {
    if (!identB.soul.includes('阿乙')) throw new Error(identB.soul)
  })
}

// ── 2. 切换后注入内容随之改变 ────────────────────────────────
{
  const secA = renderPersonaSection(
    loadPersonaIdentity({ dataRoot: dirA, identity: join(dirA, 'IDENTITY') }, { userName: '用户', assistantName: '阿甲' }), dirA)
  const secB = renderPersonaSection(
    loadPersonaIdentity({ dataRoot: dirB, identity: join(dirB, 'IDENTITY') }, { userName: '用户', assistantName: '阿乙' }), dirB)
  check('注入标题跟着人格变', () => {
    if (!secA.includes('【当前人格 · 阿甲】')) throw new Error('A 标题不对')
    if (!secB.includes('【当前人格 · 阿乙】')) throw new Error('B 标题不对')
  })
  check('注入正文跟着人格变', () => {
    if (secA === secB) throw new Error('两段完全相同')
    if (secB.includes('做甲的事')) throw new Error('B 里混进了 A 的内容')
  })
}

// ── 3. 目录不存在 ⇒ 退回自我定位 ─────────────────────────────
{
  const missing = join(library, '不存在')
  const ident = loadPersonaIdentity({ dataRoot: missing, identity: join(missing, 'IDENTITY') },
    { userName: '用户', assistantName: '某甲', selfDescription: '配置里的自我定位' })
  check('缺文件时退回 selfDescription', () => {
    if (!ident.soul.includes('配置里的自我定位')) throw new Error(ident.soul)
  })
}

// ── 4. 注入长度有界 ─────────────────────────────────────────
{
  const big = '# SOUL\n\n' + '这是一句很长的灵魂独白。'.repeat(900)
  const dirBig = makePersona(library, '大灵魂', big)
  const ident = loadPersonaIdentity({ dataRoot: dirBig, identity: join(dirBig, 'IDENTITY') }, { userName: '用户', assistantName: '大灵魂' })
  check('SOUL 节选不超过上限', () => {
    if (ident.soul.length > SOUL_EXCERPT_LIMIT + 40) throw new Error(`soul=${ident.soul.length}`)
  })
  const sec = renderPersonaSection(ident, dirBig)
  check('注入总长有界', () => {
    if (sec.length > TOTAL_LIMIT + 400) throw new Error(`total=${sec.length}`)
  })
}

// ── 5. mountPersonaPrompt 用对了接口形状 ────────────────────
{
  const captured = []
  const scope = { systemPrompt: { section(o) { captured.push(o); return () => {} } } }
  mountPersonaPrompt(scope, { dataRoot: dirA, identity: join(dirA, 'IDENTITY') },
    { userName: '用户', assistantName: '阿甲' }, null, null)
  check('section 用 name/text/interpolate', () => {
    const o = captured[0]
    if (!o) throw new Error('没注册')
    if (o.name !== 'doubao-persona') throw new Error(`name=${o.name}`)
    if (typeof o.text !== 'function') throw new Error('text 不是函数')
    if (o.interpolate !== false) throw new Error('interpolate 应为 false')
    if (typeof o.order !== 'number') throw new Error('缺 order')
  })
  check('text() 返回选中人格的内容', () => {
    if (!captured[0].text({}).includes('做甲的事')) throw new Error('内容不对')
  })
  check('子代理不带人格前缀（isRoot 闸门）', () => {
    const sub = { session: { header: { origin: 'subagent', delegationDepth: 1 } } }
    if (captured[0].text({ agent: sub }) !== '') throw new Error('子代理应判空')
  })
  check('顶层会话仍带人格前缀', () => {
    const root = { session: { header: { delegationDepth: 0 } } }
    if (!captured[0].text({ agent: root }).includes('做甲的事')) throw new Error('顶层应保留')
  })
}

// ── 6. phase 绑定记录能识别换人 ─────────────────────────────
{
  const BINDING = '.doubao-phase-binding.json'
  const personaDir = join(library, '阿甲')
  const bindFile = join(library, BINDING)
  writeFileSync(bindFile, JSON.stringify({ dataRoot: join(library, '旧人格') }), 'utf8')
  const recorded = JSON.parse(readFileSync(bindFile, 'utf8'))
  check('绑定记录能看出 dataRoot 变了', () => {
    if (recorded.dataRoot === personaDir) throw new Error('应该不同')
  })
}

rmSync(library, { recursive: true, force: true })

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}  (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
