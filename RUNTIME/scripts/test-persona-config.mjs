/**
 * 冒烟测试：用假 ctx + 真实配置结构调 apply()，确认新代码不会在挂载时抛错。
 *
 * 覆盖：
 *   - Config schema 解析真实配置
 *   - persona 解析（volatile 的 .get() 形态 + 普通值形态）
 *   - 人格生成（空设定 ⇒ 不生成；填了 ⇒ 生成到临时 dataRoot）
 *   - phaseModel=custom 时不崩
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'D:/dsh/packages/dsh-doubao-memory'
const { Config } = await import(`file:///${PKG}/lib/config.js`)
const mod = await import(`file:///${PKG}/lib/index.js`)
const apply = mod.apply ?? mod.default

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`PASS  ${name}`)
  } catch (e) {
    fail++
    console.log(`FAIL  ${name} — ${e?.message ?? e}`)
  }
}

/** 假 ctx：只实现 apply() 会碰到的那几个方法 */
function makeCtx(sink) {
  return {
    on(event, fn) { sink.events.push({ event, fn }); return () => {} },
    inject(deps, fn) { sink.injects.push(deps) },
    effect(fn) { try { return fn() } catch { return () => {} } },
    get() { return undefined },
  }
}

// ── 1. 空人格设定：只自举，不生成 ─────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'smoke-'))
  const sink = { events: [], injects: [] }
  const cfg = Config({ dataRoot: root, stateDir: join(root, 'RUNTIME', 'state') })
  check('空人格设定不抛错', () => apply(makeCtx(sink), cfg))
  const soul = join(root, 'IDENTITY', 'SOUL.md')
  check('空人格设定仍自举出模板文件', () => {
    if (!existsSync(soul)) throw new Error('SOUL.md 没生成')
  })
  const hasMark = readFileSync(soul, 'utf8').includes('generated-by')
  check('空人格设定不写生成版 SOUL', () => {
    if (hasMark) throw new Error('不该被生成器覆盖')
  })
  check('注册了 settings 变更钩子', () => {
    if (!sink.events.some((e) => e.event === 'settings/document-updated')) {
      throw new Error('没监听 settings/document-updated')
    }
  })
  rmSync(root, { recursive: true, force: true })
}

// ── 2. 填了人格设定：生成 ─────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'smoke2-'))
  const sink = { events: [], injects: [] }
  const cfg = Config({
    dataRoot: root,
    stateDir: join(root, 'RUNTIME', 'state'),
    persona: {
      userName: '用户',
      assistantName: '助手',
      selfDescription: '技术派搭子',
      coreTraits: ['嘴硬心软'],
      tone: '直说',
      taboos: ['不叫主人'],
    },
  })
  check('填了人格设定不抛错', () => apply(makeCtx(sink), cfg))
  check('生成了 SOUL.md（带标记）', () => {
    const p = join(root, 'IDENTITY', 'SOUL.md')
    if (!existsSync(p)) throw new Error('没生成')
    const t = readFileSync(p, 'utf8')
    if (!t.includes('generated-by')) throw new Error('没有生成标记')
    if (!t.includes('技术派搭子')) throw new Error('自我定位没写进去')
    if (!t.includes('嘴硬心软')) throw new Error('性格特质没写进去')
  })
  check('生成了初始末那识', () => {
    const p = join(root, 'SNAPSHOT_LATEST.md')
    if (!existsSync(p)) throw new Error('没生成 SNAPSHOT_LATEST.md')
  })
  check('生成了 manas 周期文件', () => {
    const dir = join(root, 'RUNTIME', 'manas-system', 'data', 'manas')
    if (!existsSync(dir)) throw new Error('manas 目录不存在')
  })
  rmSync(root, { recursive: true, force: true })
}

// ── 3. phaseModel=custom ─────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'smoke3-'))
  const sink = { events: [], injects: [] }
  const cfg = Config({
    dataRoot: root,
    stateDir: join(root, 'RUNTIME', 'state'),
    phaseModel: { mode: 'custom', provider: 'deepseek-official', model: 'deepseek-chat' },
  })
  check('phaseModel=custom 不抛错', () => apply(makeCtx(sink), cfg))
  check('注册了 agent/created（换模型用）', () => {
    if (!sink.events.some((e) => e.event === 'agent/created')) {
      throw new Error('没监听 agent/created')
    }
  })
  rmSync(root, { recursive: true, force: true })
}

// ── 4. volatile 形态（.get()）也要认 ─────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'smoke4-'))
  const sink = { events: [], injects: [] }
  const raw = Config({
    dataRoot: root,
    stateDir: join(root, 'RUNTIME', 'state'),
    persona: { selfDescription: 'volatile 测试', coreTraits: ['a'], tone: 'b', taboos: [] },
  })
  // 模拟 volatile 字段被替换成 ref（注意 Config() 产出的值本身可能已是 ref，
  // 这里取一次当前值再包一层，模拟真实运行时 .get() 返回普通值）
  const valueOf = (v) => (v && typeof v.get === 'function' ? v.get() : v)
  const wrapped = {
    ...raw,
    persona: Object.fromEntries(
      Object.entries(raw.persona).map(([k, v]) => [k, { get: () => valueOf(v) }]),
    ),
  }
  check('volatile(.get()) 形态不抛错', () => apply(makeCtx(sink), wrapped))
  check('volatile 形态也能生成', () => {
    const p = join(root, 'IDENTITY', 'SOUL.md')
    if (!existsSync(p)) throw new Error('没生成')
    if (!readFileSync(p, 'utf8').includes('volatile 测试')) throw new Error('值没读到')
  })
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}  (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
