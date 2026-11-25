/**
 * 人格保护测试 —— 验证「迭代很久的人格不会被覆写」这条红线。
 *
 * 场景：
 *   1. 外来人格（有人真实写过）        ⇒ 一个字都不写
 *   2. 外来人格 + regenerate=true      ⇒ 覆盖，但先备份
 *   3. 新建人格（newId 不存在）        ⇒ 建出来并登记来历
 *   4. 新建人格（newId 已存在）        ⇒ **拒绝**，不覆盖
 *   5. 选择已有人格（activeId）        ⇒ 选中那个目录
 *   6. 选择不存在的人格                ⇒ 拒绝
 *   7. listPersonas 能列出全部
 *   8. 模板目录（没人动过）            ⇒ 视同新的，可以生成
 */
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'D:/dsh/packages/dsh-doubao-memory'
const { generatePersonaFiles } = await import(`file:///${PKG}/lib/persona-generate.js`)
const { classifyPersonaDir, resolveActivePersona, listPersonas, writeOrigin } =
  await import(`file:///${PKG}/lib/persona-registry.js`)

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`) }
  catch (e) { fail++; console.log(`FAIL  ${name} — ${e?.message ?? e}`) }
}

const PERSONA = {
  userName: '用户', assistantName: '助手',
  selfDescription: '技术派搭子', coreTraits: ['嘴硬心软'], tone: '直说', taboos: ['不叫主人'],
}

function makePaths(dataRoot) {
  return { root: PKG, templates: join(PKG, 'templates'), dataRoot }
}

/** 造一个"有人真实写过"的实例：有标记外的内容 */
function makeForeignInstance(dir) {
  mkdirSync(join(dir, 'IDENTITY'), { recursive: true })
  writeFileSync(join(dir, 'IDENTITY', 'SOUL.md'),
    '# 手写的灵魂\n\n这是几个月一句一句话攒出来的，不许动。\n')
  writeFileSync(join(dir, 'IDENTITY', 'IDENTITY.md'), '# 手写身份\n')
}

// ── 1. 外来人格 ⇒ 一个字都不写 ────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'prot1-'))
  makeForeignInstance(root)
  const before = readFileSync(join(root, 'IDENTITY', 'SOUL.md'), 'utf8')

  const kind = classifyPersonaDir(makePaths(root), root, PERSONA).kind
  check('外来人格被识别为 foreign', () => {
    if (kind !== 'foreign') throw new Error(`got ${kind}`)
  })

  const res = generatePersonaFiles(makePaths(root), PERSONA, { kind })
  check('外来人格 ⇒ 拒绝生成', () => {
    if (res.skipped !== 'foreign-persona-protected') throw new Error(`skipped=${res.skipped}`)
    if (res.generated.length !== 0) throw new Error(`生成了 ${res.generated.length} 个文件`)
  })
  check('外来人格 ⇒ SOUL.md 字节未变', () => {
    const after = readFileSync(join(root, 'IDENTITY', 'SOUL.md'), 'utf8')
    if (after !== before) throw new Error('内容被改了')
  })
  check('外来人格 ⇒ 没有多出生成文件', () => {
    const snap = join(root, 'SNAPSHOT_LATEST.md')
    if (existsSync(snap)) throw new Error('不该生成 SNAPSHOT_LATEST.md')
  })
  rmSync(root, { recursive: true, force: true })
}

// ── 2. 外来人格 + regenerate ⇒ 覆盖但备份 ────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'prot2-'))
  makeForeignInstance(root)
  const before = readFileSync(join(root, 'IDENTITY', 'SOUL.md'), 'utf8')

  const res = generatePersonaFiles(makePaths(root), PERSONA, { kind: 'foreign', force: true })
  check('regenerate ⇒ 允许覆盖', () => {
    if (!res.generated.length) throw new Error('没生成')
  })
  check('regenerate ⇒ 留下 .bak', () => {
    if (!res.backups.length) throw new Error('没备份')
    const bak = res.backups[0].replace('<dataRoot>', root)
    if (!existsSync(bak)) throw new Error(`备份文件不存在: ${bak}`)
    if (readFileSync(bak, 'utf8') !== before) throw new Error('备份内容不对')
  })
  rmSync(root, { recursive: true, force: true })
}

// ── 3. 新建人格（id 不存在）───────────────────────────────────
{
  const library = mkdtempSync(join(tmpdir(), 'prot3-'))
  const cfg = { personasRoot: library }
  const sel = resolveActivePersona(cfg, { newId: '新朋友', activeId: '' }, join(library, 'fallback'))
  check('新建人格 ⇒ action=create', () => {
    if (sel.action !== 'create') throw new Error(`got ${sel.action}: ${sel.reason}`)
    if (!sel.dir.endsWith('新朋友')) throw new Error(`dir=${sel.dir}`)
  })
  rmSync(library, { recursive: true, force: true })
}

// ── 4. 新建人格但同名已存在 ⇒ 拒绝 ───────────────────────────
{
  const library = mkdtempSync(join(tmpdir(), 'prot4-'))
  const existing = join(library, '助手')
  makeForeignInstance(existing)
  const before = readFileSync(join(existing, 'IDENTITY', 'SOUL.md'), 'utf8')

  const sel = resolveActivePersona({ personasRoot: library }, { newId: '助手', activeId: '' }, library)
  check('同名已存在 ⇒ action=refuse', () => {
    if (sel.action !== 'refuse') throw new Error(`got ${sel.action}`)
    if (!sel.reason.includes('已存在')) throw new Error(`reason=${sel.reason}`)
  })
  check('拒绝后原目录未被改动', () => {
    const after = readFileSync(join(existing, 'IDENTITY', 'SOUL.md'), 'utf8')
    if (after !== before) throw new Error('被改了')
  })
  rmSync(library, { recursive: true, force: true })
}

// ── 5. 选择已有人格 ──────────────────────────────────────────
{
  const library = mkdtempSync(join(tmpdir(), 'prot5-'))
  makeForeignInstance(join(library, '助手'))
  const sel = resolveActivePersona({ personasRoot: library }, { activeId: '助手', newId: '' }, library)
  check('activeId 选中已有人格', () => {
    if (sel.action !== 'use') throw new Error(`got ${sel.action}`)
    if (!sel.dir.endsWith('助手')) throw new Error(`dir=${sel.dir}`)
  })
  rmSync(library, { recursive: true, force: true })
}

// ── 6. 选择不存在的人格 ⇒ 拒绝 ───────────────────────────────
{
  const library = mkdtempSync(join(tmpdir(), 'prot6-'))
  const sel = resolveActivePersona({ personasRoot: library }, { activeId: '不存在', newId: '' }, library)
  check('activeId 不存在 ⇒ 拒绝', () => {
    if (sel.action !== 'refuse') throw new Error(`got ${sel.action}`)
  })
  rmSync(library, { recursive: true, force: true })
}

// ── 7. listPersonas 列出全部并分类 ───────────────────────────
{
  const library = mkdtempSync(join(tmpdir(), 'prot7-'))
  makeForeignInstance(join(library, '手写人生'))
  // 「我们的」= 插件建的实例：有 IDENTITY 骨架 + 来历标记
  mkdirSync(join(library, '我们的', 'IDENTITY'), { recursive: true })
  writeFileSync(join(library, '我们的', 'IDENTITY', 'SOUL.md'), '# SOUL\n', 'utf8')
  writeOrigin(join(library, '我们的'), { newId: '我们的' })
  const paths = makePaths(library)
  const all = listPersonas(paths, { personasRoot: library })
  check('listPersonas 列出 2 个', () => {
    if (all.length !== 2) throw new Error(`got ${all.length}`)
  })
  check('分类正确（foreign / ours）', () => {
    const kinds = all.map((p) => `${p.id}:${p.kind}`).sort().join(',')
    if (!kinds.includes('手写人生:foreign')) throw new Error(kinds)
    if (!kinds.includes('我们的:ours')) throw new Error(kinds)
  })
  rmSync(library, { recursive: true, force: true })
}

// ── 8. 模板目录（没人动过）⇒ 可以生成 ───────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'prot8-'))
  // 用真实模板播种一份"没人动过"的实例
  const { ensureInstance } = await import(`file:///${PKG}/lib/bootstrap.js`)
  const paths = makePaths(root)
  ensureInstance(paths, { userName: '用户', assistantName: '助手' })

  const kind = classifyPersonaDir(paths, root, { userName: '用户', assistantName: '助手' }).kind
  check('模板目录被判为 template-only', () => {
    if (kind !== 'template-only') throw new Error(`got ${kind}`)
  })
  const res = generatePersonaFiles(paths, PERSONA, { kind })
  check('模板目录 ⇒ 允许生成', () => {
    if (!res.generated.length) throw new Error('没生成')
  })
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}  (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
