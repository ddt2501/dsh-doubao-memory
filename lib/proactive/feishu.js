/**
 * 飞书直发 —— 让主动搭讪能真的**送到用户的飞书上**。
 *
 * ## 为什么需要这个模块（2026-11-18）
 *
 * 用户在飞书里问「我怎么没看见呢」，查下来是两件事叠在一起：
 *
 * 1. **归属错位**（已修，见 lib/proactive/llm.js 的 TRIGGER_PREFIX）：
 *    搭讪原话当 user 消息投进去 ⇒ 模型当成用户说的 ⇒ 回的是"回应"不是"主动开口"。
 * 2. **渠道不主动推送**（本模块要解决的）：
 *    飞书插件的 `onSessionEvent` 只处理 `assistant/message`，
 *    且要求 `runs.get(sessionId)` 有**活跃 run**——
 *    而 run 是**用户在飞书发消息时**才建的（`beginPrompt`），
 *    飞书插件**不暴露任何服务**给别的插件。
 *    ⇒ DSH 生态里**没有**"插件主动往渠道推消息"的通道。
 *
 * ## 本模块怎么补这个缺口
 *
 * **不依赖飞书插件**，直接调飞书开放平台的 REST API：
 *
 *   1. 取 `tenant_access_token`：POST /open-apis/auth/v3/tenant_access_token/internal
 *   2. 发消息：POST /open-apis/im/v1/messages?receive_id_type=chat_id
 *
 * chatId 从飞书插件的 `state.json` 里按 sessionId 查
 * （那个文件记着 `threadId → {sessionId, chatId, openId, ...}`）。
 *
 * ## 边界
 *
 * - **只发纯文本**，不碰卡片、不碰附件（那些是飞书插件的活）。
 * - **发送失败一律回落**到"投进 DSH 会话"⇒ 绝不因为发不出去就不说话。
 * - 主动搭讪**不重复投递**：飞书发成功 ⇒ 不再往 DSH 会话投一遍。
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const FEISHU_API = 'https://open.feishu.cn/open-apis'

/** token 缓存（tenant_access_token 有效期 2 小时） */
let tokenCache = { token: null, expiresAt: 0 }

/**
 * 取 DSH home —— **调用方没给就自己找**。
 *
 * ⚠️ 2026-11-18 踩过：调用方用 `cfg.feishu.dshHome ?? process.env.DSH_HOME`，
 *    而 profile 里配的是空串 ⇒ `??` 不回落 ⇒ dshHome 是 `''`
 *    ⇒ 后面所有查 state.json 的函数全返回 null
 *    ⇒ 报"找不到 chatId"（而实际上飞书插件装得好好的）。
 *
 * ⇒ 这里**再兜一层**：空串也当"没给"，自己从环境变量取。
 *
 * @param {string} [dshHome]
 * @returns {string}
 */
function resolveDshHome(dshHome) {
  return String(dshHome || process.env.DSH_HOME || '')
}

/**
 * 读飞书插件的状态文件，找出某个会话对应的 chatId。
 *
 * @param {string} dshHome - DSH home（默认取环境变量）
 * @param {string} sessionId - DSH 会话 id
 * @returns {{chatId: string, openId: string|null}|null}
 */
export function findChatForSession(dshHome, sessionId) {
  const home = resolveDshHome(dshHome)
  if (!home || !sessionId) return null
  const file = join(home, 'feishu-plugin', 'state.json')
  if (!existsSync(file)) return null
  let state
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const threads = state?.threads ?? {}
  // 优先按 sessionThreads 精确匹配，退回全表扫
  const threadIds = state?.sessionThreads?.[sessionId] ?? []
  const candidates = threadIds.length
    ? threadIds.map((id) => threads[id]).filter(Boolean)
    : Object.values(threads).filter((t) => t?.sessionId === sessionId)
  if (!candidates.length) return null
  // 同一个会话可能有多个 thread ⇒ 取最新建的
  const hit = candidates.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
  if (!hit?.chatId) return null
  return { chatId: hit.chatId, openId: hit.openId ?? null }
}

/**
 * 从 profile 的 `cordis.patch.yml` 里读**飞书插件那一行**的 appId。
 *
 * ## 为什么不引 YAML 解析器
 *
 * 插件是 `link:` 装的，裸包名解析不到 DSH 安装目录里那份 YAML；
 * 要 vendor 就得多几 MB。而这里只需要**一个标量**——
 * 用不着完整的 YAML 解析。
 *
 * ## 为什么不让用户填两遍
 *
 * 飞书插件的 appId 已经在 profile 配置里了（同一个机器人），
 * 让用户在我的插件配置里再填一遍 = 多一处会配错的地方。
 *
 * @param {string} patchPath - profile 的 cordis.patch.yml 路径
 * @returns {string|null} appId
 */
export function readFeishuAppId(patchPath) {
  if (!patchPath || !existsSync(patchPath)) return null
  let text
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    return null
  }
  // 找 `- id: feishu` 那行，从那儿往后扫（只在本块内找 appId）
  const lines = text.split(/\r?\n/)
  let inBlock = false
  for (const line of lines) {
    if (/^\s*-\s*id:\s*feishu\s*$/.test(line) || /^\s*id:\s*feishu\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    // 遇到下一个 id 行 ⇒ 出了 feishu 块
    if (/^\s*(-\s*)?id:\s*\S/.test(line) && !/^\s*-\s*id:\s*feishu\s*$/.test(line)) break
    const m = line.match(/^\s*appId:\s*['"]?([A-Za-z0-9_\-]+)['"]?\s*$/)
    if (m) return m[1]
  }
  return null
}

/**
 * 找**最近一次用户活跃**的会话（飞书 thread）。
 *
 * ## 为什么要这个（2026-11-18，用户指出）
 *
 * 我原来用 `receive_id: chatId` 发 ⇒ 消息落在 chat 的**最后一条消息下面**
 * ⇒ 用户看到的是"**发到飞书插件的管理台去了**"。
 *
 * 用户要的：「**发到会话里**，如果有多个会话，就发到**最近一次用户活跃**的会话里」。
 *
 * ## 怎么找"最近活跃"
 *
 * 飞书插件的 state.json 里：
 * - `roots` = { **入站消息 id** → threadId } ⇒ **插入顺序 = 时间顺序**
 *   ⇒ **最后一个键 = 最近一条用户消息**
 * - `threads[threadId]` = { sessionId, chatId, anchorMessageId, openId, createdAt }
 *
 * ⚠️ 同一个 chat 下可能有**很多** thread（用户每次开新会话就是一个），
 *    但 chatId 全都一样 ⇒ 只看 chatId **分不出是哪个会话**，
 *    必须靠 roots 的时间顺序。
 *
 * @param {string} dshHome
 * @returns {{chatId: string, messageId: string, anchorMessageId: string|null, threadId: string, sessionId: string|null}|null}
 */
export function findLatestUserThread(dshHome) {
  const home = resolveDshHome(dshHome)
  if (!home) return null
  const file = join(home, 'feishu-plugin', 'state.json')
  if (!existsSync(file)) return null
  let state
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const roots = state?.roots ?? {}
  const keys = Object.keys(roots)
  if (!keys.length) return null
  const messageId = keys[keys.length - 1]          // 最后插入 = 最近一条用户消息
  const threadId = roots[messageId]
  const thread = state?.threads?.[threadId]
  if (!thread?.chatId) return null
  return {
    chatId: thread.chatId,
    messageId,                                     // ← 用它 reply，消息就落在那条消息下面
    anchorMessageId: thread.anchorMessageId ?? null,
    threadId,
    sessionId: thread.sessionId ?? null,
  }
}

/**
 * 取 app secret。
 *
 * 优先级：环境变量 → `%DSH_HOME%\.secrets\feishu-app-secret.txt`
 * （profile 的配置里用 `!!js 'process.env.FEISHU_APP_SECRET'`，
 *  说明 DSH 进程的环境变量里就有；文件是第二道保险。）
 *
 * @param {string} dshHome
 * @returns {string|null}
 */
export function readAppSecret(dshHome) {
  const fromEnv = process.env.FEISHU_APP_SECRET
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim()
  const home = resolveDshHome(dshHome)
  if (!home) return null
  const file = join(home, '.secrets', 'feishu-app-secret.txt')
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf8').replace(/^﻿/, '').trim()
    return raw || null
  } catch {
    return null
  }
}

/**
 * 往插件日志写一行（不引 log.js，避免循环依赖）。
 *
 * ⚠️ 为什么自己写（2026-11-18）：插件进程里出现过
 *    "Invalid access token for authorization"，
 *    但**同样的代码在探针进程里成功** ⇒ 差异在插件进程内，
 *    而当时**没有任何一行日志**能告诉我 token 换得对不对。
 * ⇒ 换 token 这条链路必须留痕。
 *
 * @param {string} logPath
 * @param {string} event
 * @param {object} data
 */
function logTo(logPath, event, data) {
  if (!logPath) return
  try {
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`, 'utf8')
  } catch { /* 日志失败不能影响发送 */ }
}

/**
 * 作废缓存的 token（强制下次重换）。
 *
 * @returns {void}
 */
export function invalidateToken() {
  tokenCache = { token: null, expiresAt: 0 }
}

/**
 * token 相关的错误码 —— 命中就说明**缓存里的 token 废了**，要清掉重换。
 *
 * 99991663 = "Invalid access token for authorization"
 * 99991661 = token 不存在
 * 99991663 / 99991668(过期) / 99991672 都是 token 类
 */
const TOKEN_ERROR_CODES = new Set([99991663, 99991661, 99991668, 99991672, 99991664])

/**
 * 判断错误是不是"token 废了"。
 *
 * @param {string} errorText - 形如 `code=99991663 msg=...`
 * @returns {boolean}
 */
export function isTokenError(errorText) {
  if (!errorText) return false
  const m = String(errorText).match(/code=(\d+)/)
  if (!m) return false
  return TOKEN_ERROR_CODES.has(Number(m[1]))
}

/**
 * 取 tenant_access_token（带缓存）。
 *
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {string} [opts.logPath] - 诊断日志
 * @returns {Promise<string|null>}
 */
async function fetchTenantToken({ appId, appSecret, logPath = null }) {
  const now = Date.now()
  if (tokenCache.token && tokenCache.expiresAt > now) {
    if (logPath) {
      logTo(logPath, 'feishu-token-cache-hit', {
        expiresIn: Math.round((tokenCache.expiresAt - now) / 1000),
        tokenHead: String(tokenCache.token).slice(0, 8),
      })
    }
    return tokenCache.token
  }

  const res = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const data = await res.json().catch(() => ({}))
  if (data?.code !== 0 || !data?.tenant_access_token) {
    if (logPath) {
      logTo(logPath, 'feishu-token-failed', {
        code: data?.code ?? null, msg: data?.msg ?? '?', appId,
        secretLen: String(appSecret ?? '').length,
      })
    }
    throw new Error(`tenant_access_token 取不到: code=${data?.code} msg=${data?.msg ?? '?'}`)
  }
  // 提前 5 分钟过期
  //
  // ⚠️⚠️ **单位是秒**（2026-11-18 踩坑，症状极隐蔽）
  //
  // 原来写的是：
  //   expiresAt: now + Math.max(60_000, (expire - 300) * 1000)
  // ⇒ expire=7200（**秒**）⇒ 7200-300=6900 ⇒ Math.max(60000, 6900)=60000
  // ⇒ 60000 * 1000 = **60,000 秒 ≈ 16.7 小时**
  // 而 token 实际只活 **2 小时** ⇒ 缓存认为它还有 16.7 小时
  // ⇒ 两小时后发消息被飞书拒："Invalid access token for authorization"
  //
  // **为什么没早点发现**：HMR 重载**不重建 ESM 模块** ⇒ 模块级 tokenCache 保留
  // ⇒ 换 token 的时刻和用 token 的时刻可以差好几小时 ⇒ 症状时有时无。
  //
  // ⇒ 现在：先统一成秒，再转毫秒。
  const expireSec = Number(data.expire) > 0 ? Number(data.expire) : 7200
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + Math.max(60_000, expireSec * 1000 - 300_000),
  }
  if (logPath) {
    logTo(logPath, 'feishu-token-ok', {
      expiresIn: Math.round((tokenCache.expiresAt - now) / 1000),
      tokenHead: String(data.tenant_access_token).slice(0, 8),
      tokenLen: String(data.tenant_access_token).length,
      appId,
    })
  }
  return tokenCache.token
}

/**
 * 往飞书发一条纯文本消息。
 *
 * @param {object} opts
 * @param {string} opts.text - 正文
 * @param {string} opts.chatId - 目标会话
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
export async function sendFeishuText({ text, chatId, appId, appSecret, logPath = null }) {
  if (!text || !chatId) return { ok: false, error: '缺少正文或 chatId' }
  if (!appId || !appSecret) return { ok: false, error: '缺少 appId/appSecret' }
  if (typeof globalThis.fetch !== 'function') {
    return { ok: false, error: '这个运行时没有 fetch' }
  }
  try {
    const token = await fetchTenantToken({ appId, appSecret, logPath })
    const res = await fetch(
      `${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      },
    )
    const data = await res.json().catch(() => ({}))
    if (data?.code !== 0) {
      // ⚠️ 响应细节必须留痕（2026-11-18）：
      //    插件进程报 "Invalid access token"，探针进程成功 ⇒ 差异在网络栈
      //    （node fetch vs Chromium fetch）。
      //    ⇒ 打出**最终 URL**（跨域重定向会改 URL）和 CORS 相关头。
      if (logPath) {
        logTo(logPath, 'feishu-send-failed', {
          code: data?.code ?? null,
          msg: data?.msg ?? '?',
          httpStatus: res.status,
          finalUrl: res.url,
          respHeaders: {
            acao: res.headers?.get?.('access-control-allow-origin') ?? null,
            acah: res.headers?.get?.('access-control-allow-headers') ?? null,
            server: res.headers?.get?.('server') ?? null,
          },
        })
      }
      return { ok: false, error: `code=${data?.code} msg=${data?.msg ?? '?'}` }
    }
    return { ok: true, messageId: data?.data?.message_id }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/**
 * **回复**某条消息 —— 消息会落在**那条消息下面**，而不是 chat 底部。
 *
 * ⚠️ 这是用户 2026-11-18 明确要求的：
 * 「你应该发到**会话里**」——
 * 用 `receive_id` 发是落 chat 底部（他看到的是"管理台"），
 * 用 reply 才是落在他最后那条消息旁边。
 *
 * 飞书插件自己也是这么做的（`replyCard(anchorMessageId)`）——
 * 见 dsh-feishu-plugin/lib/index.js:127599。
 *
 * @param {object} opts
 * @param {string} opts.text - 正文
 * @param {string} opts.messageId - 被回复的消息 id
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {boolean} [opts.inThread] - 是否回复在话题里（群聊用）
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
export async function replyFeishuText({ text, messageId, appId, appSecret, inThread = true, logPath = null }) {
  if (!text || !messageId) return { ok: false, error: '缺少正文或 messageId' }
  if (!appId || !appSecret) return { ok: false, error: '缺少 appId/appSecret' }
  if (typeof globalThis.fetch !== 'function') {
    return { ok: false, error: '这个运行时没有 fetch' }
  }
  try {
    const token = await fetchTenantToken({ appId, appSecret, logPath })
    const res = await fetch(
      `${FEISHU_API}/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          content: JSON.stringify({ text }),
          msg_type: 'text',
          reply_in_thread: inThread,
        }),
      },
    )
    const data = await res.json().catch(() => ({}))
    if (data?.code !== 0) {
      return { ok: false, error: `code=${data?.code} msg=${data?.msg ?? '?'}` }
    }
    return { ok: true, messageId: data?.data?.message_id }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/**
 * 试一次：把这句话发到用户最近活跃的飞书会话。
 *
 * 顺序（用户 2026-11-18 定）：
 * 1. **reply 到最近一次用户活跃的消息**（落在会话里，不是管理台）
 * 2. reply 失败 ⇒ 退回发到 chat 底部
 * 3. 全失败 ⇒ 返回失败，调用方回落到 DSH 会话
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} [opts.sessionId] - 指定 DSH 会话（会按它找 thread）
 * @param {string} [opts.chatId] - 直接指定 chat_id
 * @param {string} [opts.replyTo] - 直接指定被回复的消息 id
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {string} [opts.dshHome]
 * @returns {Promise<{ok: boolean, via: string, chatId?: string, messageId?: string, error?: string}>}
 */
export async function trySendToFeishu({ text, sessionId, chatId, replyTo, appId, appSecret, dshHome, logPath = null }) {
  // ── 凭证兜底（2026-11-18 踩过）────────────────────────────────
  //
  // appSecret 只从调用方传进来是不够的：
  // 调用方拿的是 `process.env.FEISHU_APP_SECRET`，
  // 而 **Electron 的 renderer 进程里环境变量是空的**（实测 `(空)`）⇒
  // secret 永远是空 ⇒ 报"缺少 appId/appSecret"。
  //
  // ⇒ 这里自己补上（顺序）：
  //   ① 传进来的（配置里明文，或环境变量）
  //   ② `%DSH_HOME%\.secrets\feishu-app-secret.txt`
  //   （profile 里飞书插件用的就是 `!!js 'process.env.FEISHU_APP_SECRET'`，
  //    而那个插件是 CLI/独立进程启动的，能拿到环境变量；**我不行**。）
  const home = resolveDshHome(dshHome)
  const secret = String(appSecret || '').trim() || readAppSecret(home) || ''
  const id = String(appId || '').trim()

  // ── 定位目标 ────────────────────────────────────────────────
  // 优先用显式指定的；否则按 sessionId 查；再否则取**最近用户活跃**的 thread。
  let target = null
  let via = null

  if (replyTo) {
    target = { messageId: replyTo, chatId: chatId ?? null }
    via = 'replyTo'
  } else if (sessionId) {
    const found = findChatForSession(dshHome, sessionId)
    if (found) {
      const latest = findLatestUserThread(dshHome)
      target = {
        chatId: found.chatId,
        messageId: latest?.sessionId === sessionId ? latest.messageId : (latest?.anchorMessageId ?? null),
      }
      via = 'session'
    }
  }
  if (!target) {
    const latest = findLatestUserThread(dshHome)
    if (latest) {
      target = { chatId: latest.chatId, messageId: latest.messageId }
      via = 'latest'
    }
  }
  if (!target?.chatId) {
    return { ok: false, via: null, error: '找不到 chatId（没装飞书插件？）' }
  }

  // ── 1. reply（落在会话里）───────────────────────────────────
  if (target.messageId) {
    const replied = await replyFeishuText({
      text, messageId: target.messageId, appId: id, appSecret: secret, logPath,
    })
    if (replied.ok) {
      return { ...replied, via: `${via}:reply`, chatId: target.chatId, replyTo: target.messageId }
    }
    // ★ **token 废了 ⇒ 清缓存重换，再试一次**（2026-11-18）
    //   缓存里的 token 过期是**唯一**会"时好时坏"的原因 ⇒ 必须自愈，
    //   不能让一次搭讪因为一个过期的 token 就白等一轮。
    if (isTokenError(replied.error)) {
      logTo(logPath, 'feishu-token-retry', { where: 'reply', error: replied.error })
      invalidateToken()
      const again = await replyFeishuText({
        text, messageId: target.messageId, appId: id, appSecret: secret, logPath,
      })
      if (again.ok) {
        return { ...again, via: `${via}:reply`, chatId: target.chatId, replyTo: target.messageId }
      }
      if (via === 'replyTo') {
        return { ok: false, via, chatId: target.chatId, error: again.error }
      }
    } else if (via === 'replyTo') {
      // reply 失败 ⇒ 往下退回 send
      return { ok: false, via, chatId: target.chatId, error: replied.error }
    }
  }

  // ── 2. send（chat 底部）─────────────────────────────────────
  let sent = await sendFeishuText({ text, chatId: target.chatId, appId: id, appSecret: secret, logPath })
  if (!sent.ok && isTokenError(sent.error)) {
    logTo(logPath, 'feishu-token-retry', { where: 'send', error: sent.error })
    invalidateToken()
    sent = await sendFeishuText({ text, chatId: target.chatId, appId: id, appSecret: secret, logPath })
  }
  return { ...sent, via: sent.ok ? `${via}:send` : via, chatId: target.chatId }
}
