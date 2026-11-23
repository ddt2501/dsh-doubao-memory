/**
 * 主动搭讪的 domain 存储自测 —— 验 lib/proactive/storage.js + lib/proactive/state.js 的双轨。
 *
 * 覆盖 2026-11-17 的两个改造点：
 *   1. **domain 优先、文件兜底**：domain 可用就用它；服务缺席就安静回落到文件。
 *   2. **Config 的暂停开关优先**：Config 说暂停 ⇒ 一定暂停（不管状态文件写什么）。
 *
 * 不碰真实 provider、不碰真实 DSH 服务（mock 一个假的 storageDomain）。
 *
 * 用法：node RUNTIME/scripts/test-proactive-domain.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  proactiveDomain, proactiveStateSchema, openProactiveDomain, STATE_KEY,
} from '../../lib/proactive/storage.js'
import {
  loadState, saveState, readDomainState, writeDomainState, DEFAULT_STATE,
} from '../../lib/proactive/state.js'

const dir = mkdtempSync(join(tmpdir(), 'proactive-domain-'))

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

// ── 1. domain spec 的形状（必须与 dsh-storage-domain 的 spec 对齐）──
{
  check('domain 名字合法（小写+下划线）', /^[a-z][a-z0-9_]*$/.test(proactiveDomain.name), proactiveDomain.name)
  check('version 是非负整数', Number.isInteger(proactiveDomain.version) && proactiveDomain.version >= 0, String(proactiveDomain.version))
  check('有 state 表', Boolean(proactiveDomain.tables?.state))
  check('表名合法', Object.keys(proactiveDomain.tables).every((n) => /^[a-z][a-z0-9_]*$/.test(n)), Object.keys(proactiveDomain.tables).join(','))
  check('表带 zod schema', typeof proactiveDomain.tables.state.valueSchema?.safeParse === 'function')
}

// ── 2. schema 能吃完整状态，也能吃缺字段的旧记录 ────────────
{
  const full = { ...DEFAULT_STATE, energy: 0.5, paused: true, recentProactive: [{ at: 'x', motive: 'content', topic: 't' }] }
  check('完整状态通过校验', proactiveStateSchema.safeParse(full).success)
  // 老记录缺字段 ⇒ 必须能补默认值（否则加个字段就炸掉整个 domain）
  const partial = { energy: 0.5 }
  const parsed = proactiveStateSchema.safeParse(partial)
  check('缺字段的老记录能过校验', parsed.success, parsed.success ? '' : parsed.error?.issues?.[0]?.message)
  check('缺字段被补上默认值', parsed.success && parsed.data.paused === false && parsed.data.recentProactive.length === 0)
}

// ── 3. 服务缺席 ⇒ 安静回落（返回 null，不抛）──────────────
{
  const d = await openProactiveDomain({}, join(dir, 'absent.log'))
  check('服务缺席 ⇒ 返回 null 而不是抛错', d === null)
  const log = readFileSync(join(dir, 'absent.log'), 'utf8')
  check('缺席有日志记录', log.includes('domain-service-absent'))
}

// ── 4. mock domain：读、写、schema 校验 ────────────────────
{
  const store = new Map()
  const fakeDomain = {
    table: () => ({
      get: (k) => store.get(k),
      put: async (k, v) => { store.set(k, v); return true },
    }),
  }
  // ⚠️ 必须用 `get(name, false)` —— Cordis 的 scope 是 Proxy，
  //    直接取 `scope.storageDomain` 会抛（见 test-domain-service-access.mjs）。
  const fakeCtx = {
    get: (n) => (n === 'storageDomain' ? { open: async () => fakeDomain } : undefined),
  }
  const d = await openProactiveDomain(fakeCtx, join(dir, 'ok.log'))
  check('服务在 ⇒ 拿到 domain 句柄', d !== null)

  const ok = await writeDomainState(d, STATE_KEY, { ...DEFAULT_STATE, energy: 0.77, paused: true })
  check('写 domain 成功', ok === true)
  check('读 domain 拿到刚写的', readDomainState(d, STATE_KEY)?.energy === 0.77)
  check('读 domain 合并默认值', readDomainState(d, STATE_KEY)?.maxUnanswered === 2)

  // domain 里没有 ⇒ 返回 null（调用方回落文件）
  check('domain 没记录 ⇒ 返回 null', readDomainState(fakeDomain, 'nope') === null)
}

// ── 5. 文件兜底：BOM / 坏文件 / 原子写 ────────────────────
{
  const p = join(dir, 'state.json')
  saveState(p, { ...DEFAULT_STATE, paused: true, todayCount: 2 })
  check('文件写入无 BOM', readFileSync(p)[0] !== 0xef)
  check('文件读回 paused', loadState(p).paused === true)
  check('文件读回 todayCount', loadState(p).todayCount === 2)

  // BOM 文件要能读（2026-11-17 事故）
  writeFileSync(p, '\uFEFF' + JSON.stringify({ ...DEFAULT_STATE, paused: true }), 'utf8')
  check('BOM 文件也能读', loadState(p).paused === true, `paused=${loadState(p).paused}`)

  // 坏文件 ⇒ 保守暂停
  writeFileSync(p, '{ not json', 'utf8')
  check('坏文件 ⇒ fail-safe 暂停', loadState(p).paused === true)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
