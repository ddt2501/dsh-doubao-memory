/**
 * 飞书投递分支的自测 —— 验 lib/proactive/index.js 的投递决策。
 *
 * 两条必须成立的行为：
 *
 * 1. **飞书发成功 ⇒ 绝不往 DSH 会话投**
 *    否则同一个意思在飞书和 DSH 各来一遍。
 *
 * 2. **飞书发失败 ⇒ 必须回落投 DSH 会话**
 *    绝不因为发不出去就不说话（用户要的是"我主动找你"，
 *    不是"我只在飞书找你"）。
 *
 * 另外验：不是飞书会话（查不到 chatId）⇒ 走 DSH 会话，**不误发**。
 *
 * 用法：node RUNTIME/scripts/test-proactive-feishu-route.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePersonaFixture } from './fixtures/persona-fixture.mjs'

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

const GOOD = '用户，今天想跟你说说话。'
const { mount } = await import('../../lib/proactive/index.js')

/**
 * 跑一次完整的投递流程。
 *
 * @param {object} opts
 * @param {boolean} opts.feishuEnabled
 * @param {boolean} opts.feishuSucceeds - 飞书发送成功还是失败
 * @param {string|null} opts.chatId - 能查到 chatId 吗
 */
async function runDelivery({ feishuEnabled, feishuSucceeds, chatId }) {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-route-'))
  const statePath = join(dir, 'proactive.json')
  const logPath = join(dir, 'proactive.log')

  // ⚠️ **人格夹具**（2026-11-18 主题演进系统）：
  //    没选中主题就不说话 ⇒ mock 必须提供有种子的人格目录。
  const fx = makePersonaFixture()

  // 飞书插件的 state：让 findChatForSession / findLatestUserThread 能查到
  //
  // ⚠️ 2026-11-18：落点改成 **reply 到最近一次用户活跃的消息**
  //    （用户：「你应该发到会话里，如果有多个会话，就发到最近一次用户活跃的会话里」）
  const dshHome = join(dir, 'home')
  const feishuDir = join(dshHome, 'feishu-plugin')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(feishuDir, { recursive: true })
  writeFileSync(join(feishuDir, 'state.json'), JSON.stringify({
    version: 1,
    threads: chatId
      ? { t1: { sessionId: 'session-feishu', chatId, anchorMessageId: 'om_anchor', createdAt: 1 } }
      : {},
    // roots 的插入顺序 = 时间顺序 ⇒ 最后一个 = 最近的用户消息
    roots: chatId ? { om_user_msg_latest: 't1' } : {},
  }), 'utf8')

  writeFileSync(statePath, JSON.stringify({
    energy: 0.7,
    energyDate: new Date().toLocaleDateString('sv-SE'),
    todayCount: 0,
    lastUserMessageAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    unansweredCount: 0,
    paused: false,
    pausedReason: null,
    quietHours: { start: '00:00', end: '00:00' },
    maxPerDay: null,
    maxUnanswered: 2,
    minGapMs: 0,
    nextEligibleAt: new Date(Date.now() - 60_000).toISOString(),
    lastProactiveAt: null,
    recentProactive: [],
    moodLow: null,
  }), 'utf8')

  const delivered = []
  const agent = {
    id: 'session-feishu',
    status: 'idle',
    session: { id: 'session-feishu', header: { id: 'session-feishu' } },
    async runMaintenance(task) { return await task(new AbortController().signal) },
    followup(m) { delivered.push(m) },
  }

  const scope = {
    _handlers: {},
    effect: (fn) => fn(),
    on: (ev, h) => { scope._handlers[ev] = h },
    agents: { list: () => [agent], roots: () => [agent] },
    llm: {
      stream() {
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: GOOD } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const ctx = { inject: (deps, cb) => cb(scope) }

  // mock fetch
  const origFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    if (url.includes('tenant_access_token')) {
      return { json: async () => ({ code: 0, tenant_access_token: 'tk', expire: 7200 }) }
    }
    sent.push({ url, body: JSON.parse(init.body) })
    if (!feishuSucceeds) {
      return { json: async () => ({ code: 99999, msg: 'mock failure' }) }
    }
    return { json: async () => ({ code: 0, data: { message_id: 'om_mock' } }) }
  }

  try {
    mount(scope, {
      enabled: true,
      statePath,
      logPath,
      idleGraceMs: { min: 1, max: 2 },
      pollIntervalMs: 999999,
      feishu: {
        enabled: feishuEnabled,
        appId: 'cli_mock',
        appSecret: 'secret',
        chatId: '',
        dshHome,
      },
    }, {
      proactiveState: statePath,
      proactiveLog: logPath,
      // ⚠️ 人格路径指向夹具（主题系统需要种子）
      ...fx.paths,
    })

    // 触发一次 idle 判定
    await scope._handlers['agent/status']?.({ status: 'idle', agent })

    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    return { delivered, sent, log }
  } finally {
    globalThis.fetch = origFetch
  }
}

// ══════════════════════════════════════════════════════════════
// 1. 飞书发成功 ⇒ 不投 DSH 会话
// ══════════════════════════════════════════════════════════════
{
  const r = await runDelivery({
    feishuEnabled: true, feishuSucceeds: true, chatId: 'oc_test_chat',
  })
  check('飞书确实发了', r.sent.length === 1, `${r.sent.length} 条`)
  check('★ 用的是 reply 接口（落在会话里，不是管理台）', r.sent[0]?.url?.includes('/reply'), r.sent[0]?.url)
  check('reply 到最近一次用户活跃的消息', r.sent[0]?.url?.includes('om_user_msg_latest'), r.sent[0]?.url)
  check('正文正确', JSON.parse(r.sent[0]?.body?.content ?? '{}').text === GOOD)
  check('★ 发成功就不投 DSH 会话', r.delivered.length === 0, `投了 ${r.delivered.length} 条`)
  check('日志记了 deliver-feishu', r.log.includes('deliver-feishu'))
  check('日志记了会话 id（排查路由用）', r.log.includes('session-feishu'))
}

// ══════════════════════════════════════════════════════════════
// 2. 飞书发失败 ⇒ 回落投 DSH 会话
// ══════════════════════════════════════════════════════════════
{
  const r = await runDelivery({
    feishuEnabled: true, feishuSucceeds: false, chatId: 'oc_test_chat',
  })
  check('飞书尝试过了（reply 失败后又退回 send ⇒ 2 次）', r.sent.length >= 1, `${r.sent.length} 次`)
  check('★ 失败后回落投 DSH 会话', r.delivered.length === 1, `投了 ${r.delivered.length} 条`)
  check('回落的是触发消息', r.delivered[0]?.content?.[0]?.text?.includes('【主动开口】'))
  check('日志记了失败原因', r.log.includes('deliver-feishu-failed'))
}

// ══════════════════════════════════════════════════════════════
// 3. 不是飞书会话（查不到 chatId）⇒ 投 DSH，不误发
// ══════════════════════════════════════════════════════════════
{
  const r = await runDelivery({
    feishuEnabled: true, feishuSucceeds: true, chatId: null,
  })
  check('没发飞书（不是飞书会话）', r.sent.length === 0, `${r.sent.length} 条`)
  check('★ 走 DSH 会话', r.delivered.length === 1, `投了 ${r.delivered.length} 条`)
}

// ══════════════════════════════════════════════════════════════
// 4. 飞书直发关掉 ⇒ 纯走 DSH（向后兼容）
// ══════════════════════════════════════════════════════════════
{
  const r = await runDelivery({
    feishuEnabled: false, feishuSucceeds: true, chatId: 'oc_test_chat',
  })
  check('没发飞书', r.sent.length === 0)
  check('走 DSH 会话', r.delivered.length === 1, `投了 ${r.delivered.length} 条`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
