/**
 * Phase 服务自测（2026-11-18）。
 *
 * 覆盖：
 *   1. cron 判定（分/时/日/月/周，含"日与周同时限定时取或"的语义）
 *   2. 按天去重（一分钟一次的检查不重复触发）
 *   3. 审计记录（写入 / 读回 / 保留上限 / BOM 容错）
 *   4. REGISTRY 的 4 个 phase 能被读到，且 prompt 能展开成可执行任务
 *   5. **不依赖 ctx.jobs**（2026-11-18 实测：插件的 host scope 没有 job controller）
 *
 * 用法：node RUNTIME/scripts/test-phases.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cronMatches, duePhases, markRan, readPhaseState } from '../../lib/phases/schedule.js'
import { recordRun, readRuns, lastRunByPhase } from '../../lib/phases/audit.js'
import { readPhases, extractPrompt } from '../../lib/memory-system.js'
import { expand } from '../../lib/placeholders.js'
import { resolvePaths } from '../../lib/paths.js'

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

// ══════════════════════════════════════════════════════════════
// 1. cron 判定
// ══════════════════════════════════════════════════════════════
{
  // ⚠️ 用**本地时间**构造（cron 判定用的是 getHours/getDate，都是本地）
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0)

  check('每天 4:00 命中', cronMatches('0 4 * * *', at(2026, 11, 19, 4, 0)))
  check('每天 4:00 不命中 4:01', !cronMatches('0 4 * * *', at(2026, 11, 19, 4, 1)))
  check('每周日 22:00 命中（2026-11-22 是周日）', cronMatches('0 22 * * 0', at(2026, 11, 22, 22, 0)))
  check('每周日 22:00 不命中周一', !cronMatches('0 22 * * 0', at(2026, 11, 23, 22, 0)))
  check('每分钟命中', cronMatches('* * * * *', at(2026, 11, 19, 13, 37)))
  check('步进 */15 命中 0 分', cronMatches('*/15 * * * *', at(2026, 11, 19, 6, 0)))
  check('步进 */15 命中 45 分', cronMatches('*/15 * * * *', at(2026, 11, 19, 6, 45)))
  check('步进 */15 不命中 20 分', !cronMatches('*/15 * * * *', at(2026, 11, 19, 6, 20)))
  check('列表 0,30 命中 30', cronMatches('0,30 * * * *', at(2026, 11, 19, 6, 30)))
  check('范围 9-17 的 10 点命中', cronMatches('0 9-17 * * *', at(2026, 11, 19, 10, 0)))
  check('非法 cron（4 段）不命中', !cronMatches('0 4 * *', at(2026, 11, 19, 4, 0)))
  check('空 cron 不命中', !cronMatches('', at(2026, 11, 19, 4, 0)))

  // ★ 日与周同时限定 ⇒ 取"或"（Vixie cron 语义，最容易写错）
  //   11-19 是周四：dom=19 命中、dow=1 不命中 ⇒ 应该命中
  check('★ 日与周同时限定 ⇒ 取或', cronMatches('0 4 19 * 1', at(2026, 11, 19, 4, 0)))
}

// ══════════════════════════════════════════════════════════════
// 2. 按天去重
// ══════════════════════════════════════════════════════════════
{
  const dir = mkdtempSync(join(tmpdir(), 'phase-sched-'))
  const phases = [
    { phase: 'ingest', cron: '0 4 * * *', enabled: true },
    { phase: 'wiki', cron: '0 22 * * 0', enabled: true },
  ]
  const at4 = new Date(2026, 10, 19, 4, 0, 0, 0)     // 2026-11-19 04:00 本地

  const due1 = duePhases(phases, { statePath: dir, now: at4 })
  check('4:00 到点 ⇒ ingest 待跑', due1.some((p) => p.phase === 'ingest'), due1.map((p) => p.phase).join(','))

  markRan(dir, 'ingest', at4)
  const due2 = duePhases(phases, { statePath: dir, now: new Date(2026, 10, 19, 4, 1, 0, 0) })
  check('★ 同一天不重复触发', !due2.some((p) => p.phase === 'ingest'), due2.map((p) => p.phase).join(','))

  const due3 = duePhases(phases, { statePath: dir, now: new Date(2026, 10, 20, 4, 0, 0, 0) })
  check('跨天重新可触发', due3.some((p) => p.phase === 'ingest'), due3.map((p) => p.phase).join(','))

  // enabled:false 不跑
  const due4 = duePhases([{ phase: 'x', cron: '* * * * *', enabled: false }], { statePath: dir, now: at4 })
  check('enabled:false 不跑', due4.length === 0)

  // ⚠️ lastRunAt 存的是 **ISO（UTC）**：本地 11-19 04:00 = UTC 2026-11-18T20:00Z
  //    所以不能拿本地日期去比字符串——`duePhases` 内部会用 localDate() 转回来。
  const saved = readPhaseState(dir).phases.ingest?.lastRunAt
  check('状态落盘可读回', saved === at4.toISOString(), `${saved} （期望 ${at4.toISOString()}）`)
  rmSync(dir, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
// 2.5 补偿：**错过也要补**（2026-11-18 修的真缺陷）
//
// 第一版用"当前分钟精确匹配" ⇒ 4:00 那一刻 DSH 没开（或电脑睡眠），
// 4:01 打开后 `cronMatches('0 4 * * *', 4:01)` 是 false ⇒ **永远不跑**。
// DSH 的 schedule 有补偿语义（"only the latest missed occurrence"），
// 我照搬"精确匹配"时漏了这一层。
// ══════════════════════════════════════════════════════════════
{
  const { lastDueAt } = await import('../../lib/phases/schedule.js')
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0)

  // 4:00 的 cron，在 6:30 查询 ⇒ 最近一次应是**今天 4:00**
  const due = lastDueAt('0 4 * * *', at(2026, 11, 19, 6, 30))
  check('★ 错过后能反推出"今天 4:00 该跑"',
    due && due.getDate() === 19 && due.getHours() === 4 && due.getMinutes() === 0,
    due?.toISOString())

  // 在 3:00 查询（还没到今天的 4:00）⇒ 最近一次应是**昨天 4:00**
  const due2 = lastDueAt('0 4 * * *', at(2026, 11, 19, 3, 0))
  check('未到点 ⇒ 反推上一次是昨天 4:00',
    due2 && due2.getDate() === 18 && due2.getHours() === 4,
    due2?.toISOString())

  // 正好 4:00 ⇒ 就是此刻
  const due3 = lastDueAt('0 4 * * *', at(2026, 11, 19, 4, 0))
  check('正好到点 ⇒ 就是此刻', due3?.getTime() === at(2026, 11, 19, 4, 0).getTime(), due3?.toISOString())

  // 周日 22:00 的 cron，周一查询 ⇒ 应是**昨天（周日）22:00**
  const due4 = lastDueAt('0 22 * * 0', at(2026, 11, 23, 10, 0))
  check('周 cron 能反推到上周日 22:00',
    due4 && due4.getDay() === 0 && due4.getHours() === 22 && due4.getDate() === 22,
    due4?.toISOString())

  // 月度 cron（每月 1 号 4:00），在 11-19 查询 ⇒ 应是 11-01 04:00
  const due5 = lastDueAt('0 4 1 * *', at(2026, 11, 19, 12, 0))
  check('月度 cron 能反推到本月 1 号',
    due5 && due5.getDate() === 1 && due5.getMonth() === 10 && due5.getHours() === 4,
    due5?.toISOString())

  // 非法 cron ⇒ null
  check('非法 cron 反推为 null', lastDueAt('bad', at(2026, 11, 19, 4, 0)) === null)
}

// ══════════════════════════════════════════════════════════════
// 2.6 补偿语义：错过只补一次
// ══════════════════════════════════════════════════════════════
{
  const dir = mkdtempSync(join(tmpdir(), 'phase-catchup-'))
  const phases = [{ phase: 'ingest', cron: '0 4 * * *', enabled: true }]

  // 三天没跑（lastRunAt 是 11-16 04:00），今天 11-19 06:30 才打开
  markRan(dir, 'ingest', new Date(2026, 10, 16, 4, 0, 0, 0))
  const due = duePhases(phases, { statePath: dir, now: new Date(2026, 10, 19, 6, 30, 0, 0) })
  check('★ 停机三天后打开 ⇒ 补跑（不是永远错过）', due.length === 1, `${due.length} 个待跑`)
  check('补的是**最近一次**（今天 4:00），不是三天前的', due[0]?.dueAt?.includes('T20:00:00.000Z'), due[0]?.dueAt)

  // 补跑完 ⇒ 再查不重复
  markRan(dir, 'ingest', new Date(2026, 10, 19, 4, 0, 0, 0))
  const due2 = duePhases(phases, { statePath: dir, now: new Date(2026, 10, 19, 6, 31, 0, 0) })
  check('补跑后不再重复触发', due2.length === 0, `${due2.length} 个待跑`)
  rmSync(dir, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
// 2.7 失败退避（2026-11-18 修）
//
// 事故：三个 phase 被腰斩（exitCode -1）后**每分钟重试一次**，
// 每次跑 57 秒 ⇒ 一直烧 token。
// ══════════════════════════════════════════════════════════════
{
  const { markFailed } = await import('../../lib/phases/schedule.js')
  const dir = mkdtempSync(join(tmpdir(), 'phase-backoff-'))
  const phases = [{ phase: 'ingest', cron: '0 4 * * *', enabled: true }]
  const t0 = new Date(2026, 10, 19, 4, 0, 0, 0)

  // 失败一次 ⇒ 1 分钟内不再重试
  markFailed(dir, 'ingest', t0, 'boom')
  const d1 = duePhases(phases, { statePath: dir, now: new Date(2026, 10, 19, 4, 0, 30, 0) })
  check('★ 失败后 30 秒内不重试（不会每分钟烧 token）', d1.length === 0, `${d1.length} 个`)

  // 过了 1 分钟 ⇒ 可以重试
  const d2 = duePhases(phases, { statePath: dir, now: new Date(2026, 10, 19, 4, 2, 0, 0) })
  check('过了退避窗口 ⇒ 允许重试', d2.length === 1, `${d2.length} 个`)

  // 连续失败 ⇒ 退避变长（第 2 次是 2 分钟）
  markFailed(dir, 'ingest', new Date(2026, 10, 19, 4, 2, 0, 0), 'boom')
  const d3 = duePhases(phases, { statePath: dir, now: new Date(2026, 10, 19, 4, 3, 0, 0) })
  check('★ 连续失败 ⇒ 退避加长（1 分钟内不重试）', d3.length === 0, `${d3.length} 个`)

  // 成功一次 ⇒ 清零
  markRan(dir, 'ingest', new Date(2026, 10, 19, 4, 5, 0, 0))
  check('成功后 failCount 清零', readPhaseState(dir).phases.ingest?.failCount === 0,
    String(readPhaseState(dir).phases.ingest?.failCount))
  rmSync(dir, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
// 2.8 断电 / 强杀 ⇒ 有痕迹（2026-11-18 加）
//
// 断电时 done() 根本不执行 ⇒ 审计里一点痕迹都没有，
// 事后分不清"没到点"还是"跑到一半没了"。
// ══════════════════════════════════════════════════════════════
{
  const S = await import('../../lib/phases/service.js')
  const dir = mkdtempSync(join(tmpdir(), 'phase-intr-'))

  // 模拟：跑到一半断电（current 留着，pid 是不存在的）
  S.writeCurrent(dir, {
    phase: 'ingest', title: '助手·Daily Ingest',
    startedAt: new Date(Date.now() - 600_000).toISOString(), pid: 999999,
  })
  const r = S.detectInterrupted(dir, null)
  check('★ 断电后能检测到"上次没正常结束"', r?.phase === 'ingest', r?.phase)
  check('★ 补了一条审计（exitCode -1 + 说明）',
    readRuns(dir, 5).length === 1 && r?.exitCode === -1 && String(r?.error).includes('interrupted'),
    `${readRuns(dir, 5).length} 条 / ${r?.error}`)
  check('检测后清掉 current（不会每次启动都重复报）', !existsSync(join(dir, 'phase-current.json')))
  check('二次检测不重复', S.detectInterrupted(dir, null) === null)

  // 正常结束 ⇒ 没有 current ⇒ 检测不到
  S.writeCurrent(dir, { phase: 'wiki', startedAt: new Date().toISOString(), pid: 0 })
  S.clearCurrent(dir)
  check('正常结束（已清 current）⇒ 检测不到中断', S.detectInterrupted(dir, null) === null)

  rmSync(dir, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
// 2.9 幂等：收尾归一（2026-11-18 加）
//
// 用户指出：允许补偿补跑，技术前提是**幂等**。
// 而 phase 的写入是 LLM 在写，prompt 里说"别重复"只是**请求**
// ⇒ 用纯代码再兜一遍。
// ══════════════════════════════════════════════════════════════
{
  const N = await import('../../lib/phases/normalize.js')

  // ── vault 断言：精确重复删掉 ──────────────────────────────
  const fm = [
    '---', '类型: wiki', '断言:',
    '  - 用户喜欢直接说话',
    '  - 用户喜欢直接说话',          // 精确重复
    '  - 用户说话不爱绕弯子',        // 措辞不同（不能删）
    '来源:', '  - x', '---', '', '正文',
  ].join('\n')
  const r1 = N.dedupeAssertionList(fm)
  check('★ 断言精确重复被删', r1.removed === 1, `${r1.removed} 条`)
  check('保留唯一那条', (r1.text.match(/用户喜欢直接说话/g) ?? []).length === 1)
  check('★ 措辞不同的不删（精确度优先）', r1.text.includes('用户说话不爱绕弯子'))
  check('frontmatter 结构没坏', r1.text.startsWith('---\n类型: wiki') && r1.text.includes('\n---\n\n正文'))
  check('正文没被动', r1.text.endsWith('正文'))

  // ── 08-LOGS：只删「同时间戳 + phase」的重复 ────────────────
  const root = mkdtempSync(join(tmpdir(), 'vault-norm-'))
  mkdirSync(join(root, 'VAULT'), { recursive: true })
  const logs = [
    '# 08-LOGS', '',
    '## [2026-11-18 04:00] ingest', '- 第一次（该留）', '', '---', '',
    '## [2026-11-18 06:00] ingest', '- 补跑（不同时间戳，该留）', '', '---', '',
    '## [2026-11-18 06:00] ingest', '- 同一时间戳重复（该删）', '', '---',
  ].join('\n')
  writeFileSync(join(root, 'VAULT', '08-LOGS.md'), logs, 'utf8')
  const r2 = N.dedupeLogs({ vault: join(root, 'VAULT') }, null)
  const after = readFileSync(join(root, 'VAULT', '08-LOGS.md'), 'utf8')
  check('★ 只删同时间戳的重复段', r2.removed === 1, `${r2.removed} 段`)
  check('★ 保留**第一次**那段（不是后到的）', after.includes('第一次（该留）') && !after.includes('同一时间戳重复'))
  check('★ 不同时间戳的补跑留着（append-only 不破坏）', after.includes('补跑（不同时间戳，该留）'))

  // 幂等：再跑一次不应再删
  const r3 = N.dedupeLogs({ vault: join(root, 'VAULT') }, null)
  check('★ 归一是幂等的（再跑一次不删）', r3.removed === 0, `${r3.removed} 段`)
  const r4 = N.dedupeAssertionList(readFileSync(join(root, 'VAULT', '08-LOGS.md'), 'utf8'))
  check('对无 frontmatter 的文件不动', r4.removed === 0 && r4.text === readFileSync(join(root, 'VAULT', '08-LOGS.md'), 'utf8'))

  rmSync(root, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
// 3. 审计
// ══════════════════════════════════════════════════════════════
{
  const dir = mkdtempSync(join(tmpdir(), 'phase-audit-'))
  recordRun(dir, { at: '2026-11-19T04:00:00Z', phase: 'ingest', exitCode: 0, durationMs: 115600, ok: true })
  recordRun(dir, { at: '2026-11-20T04:00:00Z', phase: 'ingest', exitCode: 1, durationMs: 200, ok: false, error: 'boom' })

  const runs = readRuns(dir, 10)
  check('审计写入可读回', runs.length === 2, `${runs.length} 条`)
  check('最新的在最前', runs[0]?.at === '2026-11-20T04:00:00Z', runs[0]?.at)
  check('退出码记下了', runs[0]?.exitCode === 1)
  check('失败原因记下了', runs[0]?.error === 'boom')

  const last = lastRunByPhase(dir)
  check('按 phase 汇总取最近一条', last.ingest?.exitCode === 1, String(last.ingest?.exitCode))

  // BOM 容错（PowerShell 5.1 写的文件会带 BOM，JSON.parse 会抛）
  const file = join(dir, 'phase-runs.json')
  const raw = readFileSync(file, 'utf8')
  writeFileSync(file, `\uFEFF${raw}`, 'utf8')
  check('★ 带 BOM 也能读（不至于静默归零）', readRuns(dir, 10).length === 2, `${readRuns(dir, 10).length} 条`)

  // 保留上限
  for (let i = 0; i < 250; i++) recordRun(dir, { at: `2026-11-21T00:00:${String(i % 60).padStart(2, '0')}Z`, phase: 'x', exitCode: 0 })
  check('保留上限生效（≤200）', readRuns(dir, 999).length <= 200, `${readRuns(dir, 999).length} 条`)
  rmSync(dir, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
// 4. REGISTRY → 可执行任务
// ══════════════════════════════════════════════════════════════
{
  const paths = resolvePaths({ dataRoot: 'D:/dsh/persona/助手' })
  const phases = readPhases(paths.registry)
  check('REGISTRY 读到 4 个 phase', phases.length === 4, phases.map((p) => p.phase).join(','))
  check('cron 都在', phases.every((p) => /\S+ \S+ \S+ \S+ \S+/.test(p.cron ?? '')),
    phases.map((p) => `${p.phase}@${p.cron}`).join(' '))
  check('都有 promptFile', phases.every((p) => Boolean(p.promptFile)),
    phases.map((p) => p.promptFile).join(' '))

  // prompt 能展开成可执行任务（占位符全替换）
  for (const p of phases) {
    const abs = join(paths.root, String(p.promptFile))
    let body = ''
    try {
      body = extractPrompt(readFileSync(abs, 'utf8'))
    } catch { /* 文件缺失下面会判 */ }
    const task = expand(body, { pkg: paths.root, data: paths.dataRoot, user: '用户', assistant: '助手' })
    check(`${p.phase} 的 prompt 可展开成任务`, task.length > 100, `${task.length} 字符`)
    check(`${p.phase} 占位符已替换（无 {PKG}/{DATA}/{ASSISTANT} 残留）`,
      !/\{(PKG|DATA|ASSISTANT|USER)\}/.test(task),
      (task.match(/\{(PKG|DATA|ASSISTANT|USER)\}/g) ?? []).join(','))
  }
}

// ══════════════════════════════════════════════════════════════
// 5. 设计约束
// ══════════════════════════════════════════════════════════════
{
  const svc = readFileSync(new URL('../../lib/phases/service.js', import.meta.url), 'utf8')
  // ⚠️ 只看**实际调用**，不看注释（注释里解释了"为什么不用 ctx.jobs"）
  const codeOnly = svc
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  check('★ 不依赖 ctx.jobs（插件 scope 没有 job controller）',
    !/\.jobs\s*\.\s*start/.test(codeOnly),
    'service.js 里没有 jobs.start 调用')
  check('★ headless 显式关掉审批（无人值守不会卡）',
    svc.includes("'--approval-policy'") && svc.includes("'never'"))
  check('★ 不用 process.execPath（那是 Electron，不是 node）',
    !/spawn\(process\.execPath/.test(codeOnly))
  check('输出落 NDJSON（可逐行复盘）', svc.includes('phase-logs') && svc.includes('appendFileSync'))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
