/**
 * devMode 挂载独立性回归测试。
 * 审计修复（2026-11-24）：devMode 曾误嵌 factMemory 分支+建库 try，factMemory 关/建库失败
 * 会令强制机制静默失效。本测试验证：factMemory.enabled=false 时 devMode guard+section 仍挂载。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as plugin } from '../lib/index.js'
import { isDevMode, setDevMode } from '../lib/devmode.js'

function mountWith(cfg) {
  const dir = mkdtempSync(join(tmpdir(), 'devmode-mount-'))
  const guards = []
  const sections = []
  const scope = {
    _handlers: {},
    effect: (fn) => { try { fn() } catch { /* ignore */ } },
    on: (ev, h) => { scope._handlers[ev] = h },
    agents: { roots: () => [] },
    tools: { guard: (g) => { guards.push(g); return () => {} }, register: () => () => {} },
    systemPrompt: { section: (def) => { sections.push(def); return def } },
    llm: { stream: () => (async function* () {})() },
    get: () => null,
  }
  const ctx = { inject: (deps, cb) => cb(scope), get: () => null }
  plugin(ctx, {
    dataRoot: dir,
    stateDir: dir,
    proactive: { enabled: false },
    snapshot: { enabled: false },
    memory: { enabled: false },
    ...cfg,
  })
  return { guards, sections }
}

test('factMemory 关 + devMode 开 ⇒ guard 与协调者段仍挂载（独立性回归）', () => {
  setDevMode(false)
  const { guards, sections } = mountWith({ factMemory: { enabled: false }, devMode: { enabled: true } })
  assert.ok(guards.length >= 1, 'devMode guard 应注册（不依赖 factMemory）')
  assert.ok(sections.some((s) => s.name === 'doubao-devmode-coordinator'), '协调者段应注册')
  assert.equal(isDevMode(), true)
  setDevMode(false)
})

test('factMemory 关 + devMode 关 ⇒ guard 挂载但处于放行态', () => {
  setDevMode(false)
  const { guards } = mountWith({ factMemory: { enabled: false }, devMode: { enabled: false } })
  assert.ok(guards.length >= 1)
  assert.equal(isDevMode(), false)
  // devMode 关 ⇒ guard 对代码写入放行
  const deny = guards[0]({ name: 'write', arguments: { file_path: 'x.js' }, agent: { session: { header: { delegationDepth: 0 } } } })
  assert.equal(deny, undefined)
})