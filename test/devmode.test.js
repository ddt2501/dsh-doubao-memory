/**
 * dev 协调模式单测。
 * 核心场景 = 设计理念工作流：先写 .md 文档（放行）→ 脚本生成 .png（pwsh 放行）→ 代码 edit/write（挡）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { setDevMode, isDevMode, extOf, writeDenial, renderCoordinatorSection } from '../lib/devmode.js'

const root = { isRoot: true }
const sub = { isRoot: false }

test('extOf 取小写扩展名', () => {
  assert.equal(extOf('D:/dsh/PHILOSOPHY.md'), '.md')
  assert.equal(extOf('lib/index.JS'), '.js')
  assert.equal(extOf('a/b/card.PNG'), '.png')
  assert.equal(extOf('Makefile'), '')
  assert.equal(extOf(null), '')
})

test('模式关 ⇒ 全放行', () => {
  assert.equal(writeDenial({ devMode: false, isRoot: true, toolName: 'write', filePath: 'lib/x.js' }), null)
})

test('模式开 + 主 agent + 写 .md 文档 ⇒ 放行', () => {
  assert.equal(writeDenial({ devMode: true, isRoot: true, toolName: 'write', filePath: 'D:/dsh/人格显影-定稿.md' }), null)
  assert.equal(writeDenial({ devMode: true, isRoot: true, toolName: 'edit', filePath: 'PROGRESS.md' }), null)
})

test('模式开 + 主 agent + 写代码 ⇒ 挡', () => {
  const r = writeDenial({ devMode: true, isRoot: true, toolName: 'edit', filePath: 'lib/index.js' })
  assert.ok(r && r.includes('派发子代理'))
  assert.ok(writeDenial({ devMode: true, isRoot: true, toolName: 'write', filePath: 'test/x.test.js' }))
  assert.ok(writeDenial({ devMode: true, isRoot: true, toolName: 'write', filePath: 'config.json' }))
})

test('模式开 + pwsh ⇒ 放行（主 agent 保留 shell，生图/跑脚本不受影响）', () => {
  assert.equal(writeDenial({ devMode: true, isRoot: true, toolName: 'pwsh', filePath: undefined }), null)
})

test('模式开 + 子代理 ⇒ 不受影响（子代理负责写代码）', () => {
  assert.equal(writeDenial({ devMode: true, isRoot: false, toolName: 'write', filePath: 'lib/x.js' }), null)
})

test('设计理念工作流：写 .md → pwsh 生 .png → 代码被挡', () => {
  // 1. 写设计理念文档（.md）放行
  assert.equal(writeDenial({ devMode: true, isRoot: true, toolName: 'write', filePath: 'D:/dsh/_share/人格显影-定稿.md' }), null)
  // 2. 生成 png 卡片走 pwsh/python，放行
  assert.equal(writeDenial({ devMode: true, isRoot: true, toolName: 'pwsh', filePath: undefined }), null)
  // 3. 若试图直接 edit/write 代码，被挡 → 派子代理
  assert.ok(writeDenial({ devMode: true, isRoot: true, toolName: 'write', filePath: 'D:/dsh/_share/make_4cards.py' }))
})

test('office 二进制不经 edit/write（扩展名不在文本白名单，但实际走 office_render/脚本）', () => {
  // edit/write 只写文本；.docx/.pdf 等若误经 edit/write 会被挡，但它们实际走专用工具/脚本（pwsh 放行）
  assert.equal(extOf('report.docx'), '.docx')
  assert.equal(writeDenial({ devMode: true, isRoot: true, toolName: 'pwsh', filePath: undefined }), null)
})

test('setDevMode / isDevMode 状态切换', () => {
  setDevMode(true)
  assert.equal(isDevMode(), true)
  setDevMode(false)
  assert.equal(isDevMode(), false)
})

test('协调者 SOP 显式规定三角色独立派发', () => {
  const s = renderCoordinatorSection()
  assert.ok(s.includes('开发子代理'))
  assert.ok(s.includes('测试/验证子代理'))
  assert.ok(s.includes('审计子代理'))
  assert.ok(s.includes('不信任开发子代理的自述'))   // 测试独立
  assert.ok(s.includes('互不污染'))                 // 审计独立
  assert.ok(s.includes('pwsh'))                     // 主 agent 保留 shell
  // ↓ .md 独有内容（兜底文案里没有）：.md 漏打包/被删/损坏时这里必须红，
  //   防止"静默降级到兜底也全绿"（独立审计 2026-11-24）。
  assert.ok(s.includes('拆任务'), 'SOP 应来自外置 .md（兜底没有「拆任务」）')
  assert.ok(s.includes('验收各方结果'), 'SOP 应来自外置 .md（兜底没有「验收各方结果」）')
  assert.ok(s.includes('至少各一个独立子代理'), 'SOP 应来自外置 .md（兜底没有「至少各一个独立子代理」）')
})

// ── 审计补漏（2026-11-24 独立审计指出的缺口）──
test('.markdown 也在白名单', () => {
  assert.equal(writeDenial({ devMode: true, isRoot: true, toolName: 'write', filePath: 'a.markdown' }), null)
})
test('大写 .MD 放行（extOf 归一化小写）', () => {
  assert.equal(writeDenial({ devMode: true, isRoot: true, toolName: 'write', filePath: 'DOC.MD' }), null)
})
test('root + edit/write 且 file_path 缺失 ⇒ 挡（fail-closed）', () => {
  assert.ok(writeDenial({ devMode: true, isRoot: true, toolName: 'write', filePath: undefined }))
  assert.ok(writeDenial({ devMode: true, isRoot: true, toolName: 'edit', filePath: null }))
})
test('非字符串 file_path ⇒ 挡（fail-closed）', () => {
  assert.ok(writeDenial({ devMode: true, isRoot: true, toolName: 'write', filePath: { x: 1 } }))
})