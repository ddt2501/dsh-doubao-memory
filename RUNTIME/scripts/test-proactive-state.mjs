/**
 * 主动搭讪状态读写自测 —— 验 lib/proactive/state.js。
 *
 * 重点覆盖 2026-11-17 的两个事故：
 *   1. **BOM**：手工改状态时用了 PS 的 `Set-Content -Encoding UTF8`（写 BOM）
 *      ⇒ JSON.parse 抛错 ⇒ 旧实现静默回落 DEFAULT_STATE
 *      ⇒ `paused:true` 被清掉 ⇒ 插件 10:29 又开口。
 *      现在：BOM 要能读；真读不出来 ⇒ **保守判定为 paused**。
 *   2. **原子写**：truncate-then-write 中断 ⇒ 半截 JSON ⇒ 状态归零。
 *      现在：临时文件 + rename。
 *
 * 用法：node RUNTIME/scripts/test-proactive-state.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState, DEFAULT_STATE } from '../../lib/proactive/state.js'

const dir = mkdtempSync(join(tmpdir(), 'proactive-state-'))

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

// ── 1. 文件不存在 ⇒ 默认状态（不是 paused）─────────────────
{
  const s = loadState(join(dir, 'nope.json'))
  check('文件不存在 ⇒ 默认状态', s.paused === false && s.todayCount === 0, `paused=${s.paused}`)
}

// ── 2. 正常文件 ⇒ 原样读回 ────────────────────────────────
{
  const p = join(dir, 'ok.json')
  saveState(p, { ...DEFAULT_STATE, paused: true, todayCount: 2, energy: 0.42 })
  const s = loadState(p)
  check('正常文件 ⇒ paused 读回', s.paused === true, `paused=${s.paused}`)
  check('正常文件 ⇒ todayCount 读回', s.todayCount === 2, `todayCount=${s.todayCount}`)
}

// ── 3. **BOM 文件也要能读**（2026-11-17 事故）──────────────
{
  const p = join(dir, 'bom.json')
  writeFileSync(p, '\uFEFF' + JSON.stringify({ ...DEFAULT_STATE, paused: true, todayCount: 1 }), 'utf8')
  const s = loadState(p)
  check('BOM 文件 ⇒ 不再解析失败', s.todayCount === 1, `todayCount=${s.todayCount}`)
  check('BOM 文件 ⇒ paused 保留', s.paused === true, `paused=${s.paused}`)
}

// ── 4. **真坏的文件 ⇒ 保守暂停**（不许静默解除暂停）──────
{
  const p = join(dir, 'broken.json')
  writeFileSync(p, '{ this is not json', 'utf8')
  const s = loadState(p)
  check('坏文件 ⇒ paused=true（fail-safe）', s.paused === true, `paused=${s.paused}`)
}

// ── 5. 空文件 ⇒ 保守暂停 ──────────────────────────────────
{
  const p = join(dir, 'empty.json')
  writeFileSync(p, '', 'utf8')
  const s = loadState(p)
  check('空文件 ⇒ paused=true（fail-safe）', s.paused === true, `paused=${s.paused}`)
}

// ── 6. saveState 不写 BOM ─────────────────────────────────
{
  const p = join(dir, 'nobom.json')
  saveState(p, { ...DEFAULT_STATE, energy: 0.5 })
  const buf = readFileSync(p)
  check('saveState 不写 BOM', !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf),
    `first bytes: ${buf[0].toString(16)} ${buf[1].toString(16)} ${buf[2].toString(16)}`)
}

// ── 7. saveState 是原子的：不留 tmp 文件 ──────────────────
{
  const p = join(dir, 'atomic.json')
  saveState(p, { ...DEFAULT_STATE })
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
  check('saveState 不留临时文件', leftovers.length === 0, leftovers.join(','))
}

// ── 8. saveState 覆盖旧内容（不留旧尾巴）─────────────────
{
  const p = join(dir, 'overwrite.json')
  saveState(p, { ...DEFAULT_STATE, todayCount: 2, recentProactive: [{ at: 'x', motive: 'content', topic: 't' }] })
  saveState(p, { ...DEFAULT_STATE, todayCount: 0, recentProactive: [] })
  const s = loadState(p)
  check('覆盖写 ⇒ 旧内容不残留', s.todayCount === 0 && s.recentProactive.length === 0,
    `todayCount=${s.todayCount} recent=${s.recentProactive.length}`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
