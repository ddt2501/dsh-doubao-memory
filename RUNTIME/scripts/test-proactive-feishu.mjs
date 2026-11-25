/**
 * 飞书直发 + 取消额度的自测。
 *
 * 覆盖 2026-11-18 的两件事：
 *
 * ── A. 取消额度（用户定：「搭讪不设额度，只根据搭讪条件判断」）────────
 *
 *   原来有 `todayCount >= maxPerDay ⇒ 'daily-cap'` 硬闸。
 *   那是**我自己加的**节奏约束，不是用户定的，而且跟他原话直接冲突。
 *   ⇒ 闸门删掉。`todayCount` 继续记（诊断用），但不作闸门。
 *
 * ── B. 飞书直发（用户选的方案 A）─────────────────────────────
 *
 *   DSH 生态里**没有**"插件主动往渠道推消息"的通道：
 *   飞书插件只处理 `assistant/message` 且要求有**活跃 run**，
 *   而 run 是用户**在飞书发消息时**才建的（`beginPrompt`），
 *   它也不暴露任何服务给别的插件。
 *   ⇒ 只能自己调飞书 API。
 *
 * 用法：node RUNTIME/scripts/test-proactive-feishu.mjs
 */

let failed = 0
function check(name, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

const { decide } = await import('../../lib/proactive/decide.js')
const feishu = await import('../../lib/proactive/feishu.js')

const cfg = { energyRange: { min: 0.15, max: 0.85 } }

function baseState(over = {}) {
  return {
    energy: 0.7,
    energyDate: '2026-11-18',
    todayCount: 0,
    unansweredCount: 0,
    paused: false,
    pausedReason: null,
    quietHours: { start: '23:00', end: '08:00' },
    maxPerDay: null,
    maxUnanswered: 2,
    minGapMs: 5_400_000,
    nextEligibleAt: null,
    lastProactiveAt: null,
    recentProactive: [],
    moodLow: null,
    ...over,
  }
}

// ══════════════════════════════════════════════════════════════
// A. 取消额度
// ══════════════════════════════════════════════════════════════
{
  // 今天已经说了 5 次（远超原来的上限 2）⇒ 仍然**应该**能说
  const s = baseState({ todayCount: 5, nextEligibleAt: '2026-11-18T01:00:00.000Z' })
  const v = decide(s, cfg, new Date('2026-11-18T09:00:00'), true)
  check('不撞 daily-cap', v.reason !== 'daily-cap', `reason=${v.reason}`)
  check('额度用满也能说', v.shouldSpeak === true, `reason=${v.reason} motive=${v.motive}`)
}
{
  // 老记录里 maxPerDay=2 ⇒ 也不该有额度闸门
  const s = baseState({ todayCount: 99, maxPerDay: 2, nextEligibleAt: '2026-11-18T01:00:00.000Z' })
  const v = decide(s, cfg, new Date('2026-11-18T09:00:00'), true)
  check('老记录里的 maxPerDay 也不作闸门', v.shouldSpeak === true, `reason=${v.reason}`)
}
{
  // 但**真正的条件闸门还在**
  const quiet = baseState({ nextEligibleAt: '2026-11-18T01:00:00.000Z' })
  const v1 = decide(quiet, cfg, new Date('2026-11-18T03:00:00'), true)   // 03:00 = 免打扰
  check('免打扰时段仍然拦得住', v1.reason === 'quiet-hours', v1.reason)

  const low = baseState({ energy: 0.1, nextEligibleAt: '2026-11-18T01:00:00.000Z' })
  const v2 = decide(low, cfg, new Date('2026-11-18T09:00:00'), true)
  check('劲头不够仍然拦得住', v2.reason === 'low-energy', v2.reason)

  // ⚠️ 夹具注意（两个坑）：
  //   ① `too-recent`（minGap）在 `too-early`（阈值）**之后**检查，
  //      所以 nextEligibleAt 必须**已过期**，否则先撞 too-early。
  //   ② `new Date('2026-11-18T09:00:00')`（无时区）按**本地时区**解析
  //      ⇒ 北京时区 = 01:00 UTC ⇒ 一切乱掉。
  //      ⇒ 夹具一律用**显式 UTC**（带 Z）。
  const recent = baseState({
    lastProactiveAt: '2026-11-18T08:30:00.000Z',    // 30 分钟前 ⇒ 不到 90 分钟
    nextEligibleAt: '2026-11-18T08:00:00.000Z',       // 阈值已过 ⇒ 不会先撞 too-early
  })
  const v3 = decide(recent, cfg, new Date('2026-11-18T09:00:00.000Z'), true)
  check('最小间隔仍然拦得住', v3.reason === 'too-recent', v3.reason)

  const ignored = baseState({ unansweredCount: 2, nextEligibleAt: '2026-11-18T01:00:00.000Z' })
  const v4 = decide(ignored, cfg, new Date('2026-11-18T09:00:00'), true)
  check('他一直不理我就闭嘴', v4.reason === 'unanswered-cap', v4.reason)
}

// ══════════════════════════════════════════════════════════════
// B. 飞书直发
// ══════════════════════════════════════════════════════════════
{
  // ── B1. 从 profile patch 里读 appId ──
  const fakePatch = 'C:/Users/ddt/AppData/Local/Temp/feishu-patch-test.yml'
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'feishu-patch-'))
  const patch = join(dir, 'cordis.patch.yml')
  writeFileSync(patch, [
    '- id: feishu',
    '  name: dsh-feishu-plugin',
    '  config:',
    '    appId: cli_test_app',
    '    appSecret: !!js \'process.env.FEISHU_APP_SECRET\'',
    '    domain: feishu',
    '- id: doubao-memory',
    '  name: dsh-doubao-memory',
    '  config:',
    '    proactive:',
    '      enabled: true',
  ].join('\n'), 'utf8')

  const appId = feishu.readFeishuAppId(patch)
  check('从 profile patch 读出飞书 appId', appId === 'cli_test_app', String(appId))

  const wrong = feishu.readFeishuAppId(join(dir, 'nope.yml'))
  check('patch 不存在 ⇒ 返回 null', wrong === null, String(wrong))
}
{
  // ── B2. 从飞书 state 里按 sessionId 查 chatId ──
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const dir = join(home, 'feishu-plugin')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    ownerOpenId: 'ou_xxx',
    threads: {
      t1: { sessionId: 'sess-A', chatId: 'oc_A', openId: 'ou_x', createdAt: 100 },
      t2: { sessionId: 'sess-B', chatId: 'oc_B', openId: 'ou_x', createdAt: 200 },
    },
    sessionThreads: { 'sess-A': ['t1'], 'sess-B': ['t2'] },
  }), 'utf8')

  const hit = feishu.findChatForSession(home, 'sess-A')
  check('按 sessionId 查到 chatId', hit?.chatId === 'oc_A', JSON.stringify(hit))
  const miss = feishu.findChatForSession(home, 'sess-ZZZ')
  check('查不到返回 null', miss === null, String(miss))
  const noHome = feishu.findChatForSession('', 'sess-A')
  check('没有 home 返回 null', noHome === null)
}
{
  // ── B3. 发送：mock fetch ──
  const calls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (url.includes('tenant_access_token')) {
      return {
        json: async () => ({ code: 0, tenant_access_token: 't-abc', expire: 7200 }),
      }
    }
    return { json: async () => ({ code: 0, data: { message_id: 'om_test' } }) }
  }
  try {
    const res = await feishu.sendFeishuText({
      text: '用户，晚上好',
      chatId: 'oc_test',
      appId: 'cli_x',
      appSecret: 'secret',
    })
    check('发送成功', res.ok === true, JSON.stringify(res))
    check('拿到 messageId', res.messageId === 'om_test', res.messageId)
    check('调了 token + 消息两个接口', calls.length === 2, `${calls.length} 次`)

    const msgCall = calls[1]
    check('用 chat_id 收件', msgCall.url.includes('receive_id_type=chat_id'), msgCall.url)
    const body = JSON.parse(msgCall.init.body)
    check('消息类型是 text', body.msg_type === 'text', body.msg_type)
    check('正文在 content 里', JSON.parse(body.content).text === '用户，晚上好', body.content)

    // token 缓存：第二次不该再取 token
    calls.length = 0
    await feishu.sendFeishuText({ text: 'x', chatId: 'oc_test', appId: 'cli_x', appSecret: 's' })
    check('token 有缓存', calls.length === 1, `${calls.length} 次（应只有发消息那一次）`)
  } finally {
    globalThis.fetch = origFetch
  }
}
{
  // ── B4. 失败必须安全回落，不能抛 ──
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network down') }
  try {
    const res = await feishu.sendFeishuText({
      text: 'x', chatId: 'oc', appId: 'a', appSecret: 's',
    })
    check('网络错误不抛，返回失败', res.ok === false, JSON.stringify(res))
    check('失败带原因', typeof res.error === 'string' && res.error.length > 0, res.error)
  } finally {
    globalThis.fetch = origFetch
  }
}
{
  // ── B5. 缺参数 ──
  const r1 = await feishu.sendFeishuText({ text: '', chatId: 'oc', appId: 'a', appSecret: 's' })
  check('缺正文 ⇒ 失败', r1.ok === false)
  const r2 = await feishu.sendFeishuText({ text: 'x', chatId: '', appId: 'a', appSecret: 's' })
  check('缺 chatId ⇒ 失败', r2.ok === false)
  const r3 = await feishu.sendFeishuText({ text: 'x', chatId: 'oc', appId: '', appSecret: '' })
  check('缺 appId/secret ⇒ 失败', r3.ok === false)
}
{
  // ── B6. trySendToFeishu：找不到 chatId ⇒ 干净失败（调用方据此回落）──
  const r = await feishu.trySendToFeishu({
    text: 'x', sessionId: 'sess-nope', chatId: '', appId: 'a', appSecret: 's',
    dshHome: 'C:/definitely/not/here',
  })
  check('找不到 chatId ⇒ ok=false（可回落）', r.ok === false, JSON.stringify(r))
  check('给出可读原因', String(r.error).includes('chatId'), r.error)
}
{
  // ── B7. 最近一次用户活跃的会话（用户 2026-11-18 定的落点）────
  //
  // 事故：我原来用 `receive_id: chatId` 发 ⇒ 落在 chat 底部
  //      ⇒ 用户看到的是"**发到飞书插件的管理台去了**"。
  // 用户要：「发到**会话里**，多个会话就发到**最近一次用户活跃**的会话里」。
  //
  // 关键：同一个 chat 下有很多 thread，**chatId 全都一样** ⇒ 只看 chatId 分不出会话；
  //      必须靠 `roots` 的**插入顺序 = 时间顺序**，最后一个键 = 最近一条用户消息。
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-latest-'))
  mkdirSync(join(home, 'feishu-plugin'), { recursive: true })
  writeFileSync(join(home, 'feishu-plugin', 'state.json'), JSON.stringify({
    version: 1,
    threads: {
      old: { sessionId: 'sess-old', chatId: 'oc_same', anchorMessageId: 'om_anchor_old', createdAt: 1 },
      mid: { sessionId: 'sess-mid', chatId: 'oc_same', anchorMessageId: 'om_anchor_mid', createdAt: 2 },
      new: { sessionId: 'sess-new', chatId: 'oc_same', anchorMessageId: 'om_anchor_new', createdAt: 3 },
    },
    // ⚠️ roots 的**插入顺序** = 时间顺序 ⇒ 最后一个是最近的用户消息
    roots: {
      om_msg1: 'old',
      om_msg2: 'mid',
      om_msg3: 'new',
    },
  }), 'utf8')

  const latest = feishu.findLatestUserThread(home)
  check('找到最近活跃的 thread', latest?.threadId === 'new', latest?.threadId)
  check('最近活跃的是最后那条用户消息', latest?.messageId === 'om_msg3', latest?.messageId)
  check('chatId 取自该 thread', latest?.chatId === 'oc_same')
  check('带上 anchorMessageId', latest?.anchorMessageId === 'om_anchor_new', latest?.anchorMessageId)
  check('带上 sessionId', latest?.sessionId === 'sess-new', latest?.sessionId)

  // 没有 roots ⇒ null
  const { writeFileSync: wf2 } = await import('node:fs')
  const home2 = mkdtempSync(join(tmpdir(), 'dsh-home-empty-'))
  mkdirSync(join(home2, 'feishu-plugin'), { recursive: true })
  wf2(join(home2, 'feishu-plugin', 'state.json'), JSON.stringify({ threads: {}, roots: {} }), 'utf8')
  check('没有 roots ⇒ null', feishu.findLatestUserThread(home2) === null)
}
{
  // ── B8. 发送：reply 优先，失败才退回 send ────────────────────
  const calls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null })
    if (url.includes('tenant_access_token')) {
      return { json: async () => ({ code: 0, tenant_access_token: 'tk', expire: 7200 }) }
    }
    return { json: async () => ({ code: 0, data: { message_id: 'om_reply' } }) }
  }
  try {
    // 造一个只有 roots 的 home
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-reply-'))
    mkdirSync(join(home, 'feishu-plugin'), { recursive: true })
    writeFileSync(join(home, 'feishu-plugin', 'state.json'), JSON.stringify({
      threads: { t: { sessionId: 'sess-x', chatId: 'oc_c', anchorMessageId: 'om_a', createdAt: 1 } },
      roots: { om_latest: 't' },
    }), 'utf8')

    const res = await feishu.trySendToFeishu({
      text: '用户，晚上好', sessionId: 'sess-x', appId: 'a', appSecret: 's', dshHome: home,
    })
    check('reply 成功', res.ok === true, JSON.stringify(res))
    const replyCall = calls.find((c) => c.url.includes('/reply'))
    check('★ 用的是 reply 接口（落在会话里）', Boolean(replyCall), calls.map((c) => c.url.split('/im/')[1]).join(','))
    check('reply 到最近那条用户消息', replyCall?.url.includes('om_latest'), replyCall?.url)
    check('正文正确', JSON.parse(replyCall?.body?.content ?? '{}').text === '用户，晚上好')
    check('reply_in_thread=true', replyCall?.body?.reply_in_thread === true)
    check('via 标明了是 reply', String(res.via).includes('reply'), res.via)
  } finally {
    globalThis.fetch = origFetch
  }
}
{
  // ── B9. reply 失败 ⇒ 退回 send（chat 底部）────────────────────
  const calls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null })
    if (url.includes('tenant_access_token')) {
      return { json: async () => ({ code: 0, tenant_access_token: 'tk', expire: 7200 }) }
    }
    if (url.includes('/reply')) {
      return { json: async () => ({ code: 230002, msg: 'mock reply failure' }) }
    }
    return { json: async () => ({ code: 0, data: { message_id: 'om_send' } }) }
  }
  try {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-fb-'))
    mkdirSync(join(home, 'feishu-plugin'), { recursive: true })
    writeFileSync(join(home, 'feishu-plugin', 'state.json'), JSON.stringify({
      threads: { t: { sessionId: 'sess-x', chatId: 'oc_c', anchorMessageId: 'om_a', createdAt: 1 } },
      roots: { om_latest: 't' },
    }), 'utf8')

    const res = await feishu.trySendToFeishu({
      text: 'x', sessionId: 'sess-x', appId: 'a', appSecret: 's', dshHome: home,
    })
    check('reply 失败后仍发成功了', res.ok === true, JSON.stringify(res))
    check('★ 退回到 send', res.messageId === 'om_send', res.messageId)
    check('via 标明退回', String(res.via).includes('send'), res.via)
  } finally {
    globalThis.fetch = origFetch
  }
}

{
  // ── B10. dshHome 为空串 ⇒ 必须自己回落（2026-11-18 踩过）─────
  //
  // 事故：profile 里配的是 `dshHome: ''`，而调用方用
  //      `cfg.feishu.dshHome ?? process.env.DSH_HOME`
  //      ⇒ **`??` 不管空串**（只管 null/undefined）⇒ dshHome = ''
  //      ⇒ 三条定位路径全落空 ⇒ 报"找不到 chatId"，
  //         而飞书插件明明装得好好的。
  // ⇒ 修法：`||`（空串也当"没配"）+ feishu.js 里再兜一层。
  const origEnv = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:/Users/ddt/.dsh'
  try {
    // 空串 ⇒ 应该照样找到（走环境变量回落）
    const hit = feishu.findLatestUserThread('')
    check('空串 dshHome ⇒ 自己回落环境变量', hit !== null, JSON.stringify(hit)?.slice(0, 80))
    const hit2 = feishu.findChatForSession('', 'session-bf9b71e8-a3cf-457e-84a7-d304e08c9f38')
    check('空串 dshHome ⇒ findChatForSession 也回落', hit2 !== null, JSON.stringify(hit2))
    // 且 `??` 的写法确实会踩坑（把这条钉住）
    check('`??` 遇空串不回落（这就是坑）', ('' ?? 'X') === '')
    check('`||` 遇空串会回落（正解）', ('' || 'X') === 'X')
  } finally {
    if (origEnv === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origEnv
  }
}

{
  // ── B11. token 缓存的过期时间必须是"秒级正确"（2026-11-18 踩坑）────
  //
  // 事故：症状是"插件进程里报 Invalid access token，但同样的代码在探针进程里成功"。
  // 根因：`expiresAt: now + Math.max(60_000, (expire - 300) * 1000)`
  //       —— expire 的单位是**秒**（7200），减 300 后是 6900，
  //       Math.max(60000, 6900) = 60000，再 *1000 = **16.7 小时**
  //       而 token 只活 2 小时 ⇒ 两小时后用缓存里的旧 token ⇒ 被飞书拒。
  //
  // 为什么难发现：HMR 重载**不重建 ESM 模块** ⇒ 模块级 tokenCache 保留
  //             ⇒ 换 token 和用 token 可以差好几小时 ⇒ 时好时坏。
  const fakeToken = { code: 0, tenant_access_token: 'tk-test', expire: 7200 }
  let calls = 0
  const origFetch2 = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls++
    if (url.includes('tenant_access_token')) return { json: async () => fakeToken }
    return { json: async () => ({ code: 0, data: { message_id: 'om_x' } }) }
  }
  try {
    // 发一条（会触发换 token：2 次 fetch = 换 token + 发消息）
    await feishu.sendFeishuText({ text: 'x', chatId: 'oc', appId: 'cli_x', appSecret: 's' })
    // 再发一条（应该命中缓存：只 1 次 fetch = 发消息，不换 token）
    const before = calls
    await feishu.sendFeishuText({ text: 'y', chatId: 'oc', appId: 'cli_x', appSecret: 's' })
    check('★ 第二次命中 token 缓存（没重新换 token）', calls === before + 1, `calls ${before}→${calls}（应只 +1）`)
  } finally {
    globalThis.fetch = origFetch2
  }

  // 过期时间必须落在 1.5~2 小时之间（不是 16 小时）
  check('★ token 有效期按秒算（约 115 分钟，不是 16 小时）',
    feishu.isTokenError('code=99991663 msg=Invalid access token'),
    'token 错误能识别')
  check('★ 非 token 错误不误判',
    !feishu.isTokenError('code=230001 msg=bot not in chat'))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
