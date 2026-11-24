/**
 * 助手主动搭讪
 *
 * 核心语义：**只在会话真空闲（idle）时才考虑主动开口**。
 * - 判定与生成走 `agent.runMaintenance()`（non-turn maintenance task）：
 *   会话忙时不触发、不排队、不打断；生成期间到达的用户消息留在 inbox。
 * - 投递走 `agent.followup()`：DSH 里没有"agent 自己开口"的 API，
 *   主动消息只能作为 user 角色消息进对话（与 schedule 投递同构）。
 *
 * 设计文档：DESIGN/PROACTIVE-PLUGIN-IMPLEMENTATION.md
 * 诊断日志：<dataRoot>/RUNTIME/state/proactive.log
 */

import { randomUUID } from 'node:crypto'
import { readdirSync, statSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadState, saveState, readDomainState, writeDomainState, readThemeStates, writeThemeState } from './state.js'
import { decide } from './decide.js'
import { generateMessage, buildTriggerMessage } from './llm.js'
import { log } from '../log.js'
import { isRootAgent, trackRootAgents } from '../agent-utils.js'
import { isPhaseAgent, rememberFirstSourceKind, rememberHumanSpoke, humanSpoke, lastHumanAt } from '../phase-detect.js'
import { collectMaterial } from './material.js'
import { openProactiveDomain, STATE_KEY } from './storage.js'
import { trySendToFeishu, readAppSecret } from './feishu.js'
import {
  collectSeeds, selectTheme, scoreThemes, expandTheme, snapshotGuidance, advanceTheme,
} from './themes.js'
import { selectWithAdvantage, settleOnSend, settleOnReply } from '../jitrl/index.js'
import { loadMemory, saveMemory } from '../jitrl/memory.js'
import { stateSignature } from '../jitrl/signature.js'
import { scoreCandidates } from '../jitrl/score.js'

const DEFAULTS = {
  enabled: true,
  idleGraceMs: { min: 30000, max: 90000 },
  pollIntervalMs: 600000,
  quietHours: { start: '23:00', end: '08:00' },
  maxPerDay: 2,
  maxUnanswered: 2,
  /**
   * 两条主动消息之间的最小间隔（毫秒）—— 2026-11-17 加。
   *
   * 事故：08:18 和 08:59 连投两条，间隔 41 分钟，说的还是同一件事。
   * 一天 2 次的上限管不住"间隔"，而人在同一个早上不会连着开口两次。
   * 默认 90 分钟。0 = 不限制。
   */
  minGapMs: 90 * 60_000,
  energyRange: { min: 0.15, max: 0.85 },
  /**
   * ⚠️ 用 **MiniMax-M3**，不是 M3.1-Flash —— 理由见 lib/snapshot/index.js 的 DEFAULTS。
   * M3.1-Flash 强制 adaptive thinking 且关不掉 ⇒ 思考 token 吃光 max_tokens ⇒ 无输出。
   */
  model: { provider: 'minimax-cn', model: 'MiniMax-M3' },
}

/**
 * JitRL 开关现读（设置页 .volatile() 切换，不用重启插件）。
 * ⚠️ 必须定义在模块级：投递主循环不在 mount() 作用域内（2026-11-18 踩过：
 *    放在 mount 里 ⇒ 主循环抛 ReferenceError ⇒ 搭讪静默不投递）。
 */
function isJitrlOn(cfg) {
  return typeof cfg.getJitrlEnabled === 'function'
    ? cfg.getJitrlEnabled() === true
    : cfg.jitrl?.enabled === true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 同一 agent 的在途判定（idle 事件与轮询可能同时命中） */
const inFlight = new Set()

/**
 * ── 全局串行闸（2026-11-17 加）─────────────────────────────
 *
 * **为什么需要**：一轮轮询会遍历**所有**顶层会话（实测 17 个），
 * 每个都独立走一遍"判定 → 生成 → 投递 → 写回状态"。
 * 而 `minGapMs`（两条主动消息至少隔 90 分钟）**拦不住同一轮里的第二条**——
 * 因为第一条的 LLM 调用要几秒，状态还没写回，
 * 第二个 agent 读到的仍是"上次是 12 小时前"⇒ 两句都通过判定。
 *
 * 实测事故：2026-11-17 21:07，两秒内投了**两条**：
 *   - "喵喵喵！上次你用这句开场，我可记到今天了。"
 *   - "喵喵喵，用户，今天抓到你的新开场了吗？"
 * 同一件事说了两遍——正是用户 11-17 上午抱怨的"别拿工作汇报烦我"的同类问题。
 *
 * **怎么修**：把"读状态 → 判定 → 生成 → 投递 → 写回"整段**串行化**。
 * 后到的 agent 拿到闸之后**重新读状态**，此时第一条已经写回了
 * `lastProactiveAt` ⇒ 它会被 `minGapMs` 正常拦下（reason: too-recent）。
 *
 * 这是**跨 agent** 的闸，不是 per-agent 的 `inFlight`（那个只防同一个 agent 重入）。
 */
let deliveryChain = Promise.resolve()

/**
 * 排队执行一段"只该发生一次"的逻辑。
 *
 * 前一个失败不影响后一个（`.then(fn, fn)` 两个分支都跑 fn）。
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withDeliveryLock(fn) {
  const run = deliveryChain.then(fn, fn)
  deliveryChain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 挂载主动搭讪。
 * @param {object} scope - 已注入 agents / llm 的 cordis scope
 * @param {object} config - 主动搭讪配置
 * @param {object} paths - 路径解析结果（lib/paths.js）
 */
/**
 * 代码指纹 —— 挂载时记进日志，回答"**现在跑的是哪一版代码？**"
 *
 * ⚠️ 2026-11-18 加。
 *
 * 今天被这个问题坑了两次：热重载之后没法确认新代码到底上没上线
 * （插件一切正常、日志正常、但行为还是旧的）——
 * 只能靠"改代码 → 触发重载 → 看某个新行为"间接推断。
 *
 * 指纹 = `lib/` 下所有 .js 的**最新修改时间**（毫秒）。
 * 一眼能看出：跑的是不是刚改完那版；以及**哪一版**（对比历史日志）。
 */
function codeFingerprint() {
  try {
    let newest = 0
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (name.endsWith('.js')) newest = Math.max(newest, st.mtimeMs)
      }
    }
    walk(join(dirname(fileURLToPath(import.meta.url)), '..'))
    return String(Math.round(newest))
  } catch {
    return 'unknown'
  }
}

export function mount(scope, config = {}, paths = {}) {
  const cfg = {
    ...DEFAULTS,
    ...config,
    statePath: config.statePath ?? paths.proactiveState,
    logPath: config.logPath ?? paths.proactiveLog,
    paths,                       // 搭讪素材从这里取（lib/proactive/material.js）
  }
  if (!cfg.enabled) return

  // ── 飞书直发的配置（2026-11-18）────────────────────────────
  //
  // appSecret 留空 ⇒ 自动取（环境变量 → secrets 文件），
  // 不在配置里存明文（跟飞书插件的做法一致）。
  const feishuCfg = cfg.feishu ?? {}
  // ⚠️ **来源优先级**（2026-11-18 踩了三次才对）：
  //    ① config 里的（来自 `ctx.get('profileContext')` ⇒ **最可靠**，
  //       Electron renderer 里环境变量是空的，只有这条能用）
  //    ② `process.env.DSH_HOME`（CLI 模式下有效）
  //    ③ profile 目录的上上级（$DSH_HOME/profiles/<name> ⇒ 上上级 = $DSH_HOME）
  const profileDir = feishuCfg.profileDir || paths.profileDir || null
  const feishuHome = String(feishuCfg.dshHome || process.env.DSH_HOME || '')
    || (profileDir ? dirname(dirname(profileDir)) : '')
  // ⚠️ appSecret 也要兜底（2026-11-18 踩过）：
  //    `process.env.FEISHU_APP_SECRET` 在 Electron 的 renderer 进程里**是空的**
  //    ⇒ 只从调用方传进来永远是空 ⇒ 报"缺少 appId/appSecret"。
  // ⇒ 这里自己从 `%DSH_HOME%\.secrets\feishu-app-secret.txt` 读。
  const secret = String(feishuCfg.appSecret || '').trim()
    || readAppSecret(feishuHome)
    || ''
  cfg.feishu = {
    enabled: feishuCfg.enabled === true,
    appId: String(feishuCfg.appId ?? ''),
    appSecret: secret,
    chatId: String(feishuCfg.chatId ?? ''),
    dshHome: feishuHome,
    // 诊断：这几个值决定能不能发出去
    // ⚠️ 别在这里引用 `cfg.feishu.xxx`——此刻 cfg.feishu **还没被赋值**
    //    （2026-11-18 踩过：hasSecret 永远 false，因为我引的是旧对象）。
    debugEnv: {
      envDshHome: process.env.DSH_HOME ?? '(空)',
      envProfileDir: process.env.DSH_PROFILE_DIR ?? '(空)',
      fromConfig: feishuCfg.dshHome ?? '(空)',
      profileDir: profileDir ?? '(空)',
      resolved: feishuHome || '(空)',
      appId: String(feishuCfg.appId ?? '') || '(空)',
      // secret 不打日志（敏感）⇒ 只报"有没有"
      hasSecret: Boolean(secret),
    },
  }

  // ── DSH 的 domain 存储（2026-11-17 加）────────────────────────
  //
  // 状态权威搬到 `ctx.storageDomain`：原子写、schema 校验、并发写串行化、
  // 写前落盘、坏记录留证据——全是内建，比自己手搓 JSON 强得多。
  //
  // ⚠️ **双轨**：domain 可用就用它，不可用就退回文件（`proactive.json`）。
  //    两个原因不能一步切：
  //      1. DSH 没重启 ⇒ 服务还没挂上，一步切会让搭讪在重启前瘫痪；
  //      2. 人格数据要随包走，domain 落在 $DSH_HOME 不跟包走 ⇒ 文件是镜像。
  //
  // ⚠️ **服务是 optional**：`ctx.inject(['storageDomain'], ...)` 在服务缺席时
  //    **不注入这个 scope** ⇒ 这套搭讪逻辑压根不挂载（DSH 生态的标准做法，
  //    见 practices.md「Put optional services in inject」）。
  //    ——但我们**不能**因此让搭讪消失：没有 domain 也要能用文件跑。
  //    所以下面用 `ctx.inject` 的**可选变体**：拿不到服务时用当前 scope 兜底。
  const state = { domain: null }

  const openDomain = async (domainScope) => {
    try {
      const d = await openProactiveDomain(domainScope, cfg.logPath)
      state.domain = d
      if (d) {
        log(cfg.logPath, 'domain-opened', { key: STATE_KEY })
        // ── 主题状态回填（2026-11-18）────────────────────────
        //
        // 主题演进系统靠 themes 表记住"每条线说过几次"。
        // 但系统上线**之前**说过的话不在表里 ⇒ 第一次运行时，
        // "哈罗老婆"这条线 saidTimes=0 ⇒ 又会被选中
        // （这正是 11-18 上午的老毛病：5 条里 4 条在讨老婆）。
        //
        // ⇒ themes 表为空、但历史记录里有东西 ⇒ **一次性回填**：
        //   拿 recentProactive 里的每条，去匹配哪个种子的关键词出现在那句话里。
        await backfillThemes(d)
        // ── 运维通道（2026-11-18 加）────────────────────────────
        //
        // **为什么需要**：domain 的记录是 **open 时的内存快照**，
        // 外部改了磁盘上的 JSON 文件，插件**看不到**（domain 是权威）。
        // ⇒ 调状态（测试、演练）只能"改磁盘 + 让插件重新读"。
        //
        // **规则**：若磁盘镜像的 `lastProactiveAt` **比 domain 里的新**
        //          ⇒ 以磁盘为准，写回 domain。
        // 这让"从外部调状态"成为可能（改 JSON → 重载 → 生效），
        // 同时**不会**让旧文件覆盖新状态（只认更新的那个）。
        await adoptNewerFileState(d)
      } else {
        log(cfg.logPath, 'domain-unavailable', { fallback: 'file' })
      }
    } catch (err) {
      log(cfg.logPath, 'error', { where: 'domain-open', message: String(err?.message ?? err) })
    }
  }

  /**
   * **一次性回填主题状态**（2026-11-18）。
   *
   * ## 为什么需要
   *
   * 主题演进系统靠 `themes` 表记住"每条线说过几次"。
   * 但系统上线**之前**说过的话不在表里 ⇒ 第一次运行时，
   * "哈罗老婆"那条线 saidTimes=0 ⇒ 又会被选中
   * （这正是 11-18 上午的老毛病：5 条里 4 条在讨老婆）。
   *
   * ⇒ themes 表为空、但 `recentProactive` 里有东西 ⇒ **回填**：
   *   拿历史记录里的每条，去匹配哪个种子的关键词出现在那句话里。
   *
   * ## 幂等
   *
   * 已经有 themes 记录 ⇒ 直接跳过（只补缺的那些）。
   *
   * @param {object} domain
   */
  async function backfillThemes(domain) {
    try {
      const existing = readThemeStates(domain)
      if (Object.keys(existing).length) return   // 已回填过

      const cur = readDomainState(domain, STATE_KEY) ?? loadState(cfg.statePath)
      const history = (cur?.recentProactive ?? [])
      if (!history.length) return

      const { seeds } = collectSeeds(cfg.paths)
      /** 去标点（"哈罗，老婆" vs "哈罗，老婆" ⇒ 标点不同但说的是同一件事） */
      const bare = (s) => String(s).replace(/[^\w一-鿿]/g, '')
      const THEMES = {}
      for (const entry of history) {
        const topic = bare(entry?.topic ?? '')
        if (!topic) continue
        for (const seed of seeds) {
          // 取种子的关键词（去掉日期、括号注释、标点）
          const key = bare(
            seed.seed.replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/[（(].*?[)）]/g, ''),
          )
          if (key.length < 4) continue
          // 取关键词里**最长的一段**（"哈罗老婆" ⇒ 4 字）
          const probe = key.slice(0, 4)
          if (topic.includes(probe)) {
            THEMES[seed.id] = advanceTheme(THEMES[seed.id] ?? null, seed, entry.at)
          }
        }
      }
      const ids = Object.keys(THEMES)
      if (!ids.length) return
      for (const id of ids) {
        await writeThemeState(domain, THEMES[id])
      }
      log(cfg.logPath, 'themes-backfilled', {
        count: ids.length,
        detail: ids.map((id) => `${id}:${THEMES[id].saidTimes}`).join(' '),
      })
    } catch (err) {
      log(cfg.logPath, 'error', { where: 'backfill-themes', message: String(err?.message ?? err) })
    }
  }

  /**
   * 若磁盘镜像**比 domain 里的状态新**，用它覆盖 domain。
   *
   * **判据用文件的 mtime，不用 lastProactiveAt**：
   * lastProactiveAt 是"上次说话的时刻"，不是"这份状态被写下的时刻"——
   * 我调状态时会把它往回拨（模拟"很久没说话"），
   * 那样 lastProactiveAt 就变**旧**了 ⇒ 按它判断会误以为磁盘更旧。
   * ⇒ **mtime 才是"这份文件什么时候被更新"的真话**。
   *
   * @param {object} domain - domain 句柄
   */
  async function adoptNewerFileState(domain) {
    try {
      const onDisk = loadState(cfg.statePath)
      const inDomain = readDomainState(domain, STATE_KEY)
      // 文件的修改时刻 vs domain 记录的写入时刻（domain 记不住写入时刻，
      // ⇒ 用"domain 里有没有这条记录"当存在性判据）
      let mtime = 0
      try {
        mtime = statSync(cfg.statePath).mtimeMs
      } catch { /* 读不到就当 0 */ }
      const domainExists = Boolean(inDomain)
      // domain 刚打开时还没这条记录 ⇒ 直接采纳磁盘
      if (!domainExists) {
        await writeDomainState(domain, STATE_KEY, onDisk)
        log(cfg.logPath, 'state-adopted-from-file', { reason: 'domain-empty', mtime })
        return
      }
      // 已经有记录 ⇒ 只有当磁盘文件**刚被改过**（mtime 在最近 60 秒内）才采纳
      // （避免拿一个陈旧的镜像文件覆盖 domain 的新状态）
      const fresh = Date.now() - mtime < 60_000
      if (!fresh) return
      const merged = { ...inDomain, ...onDisk }
      await writeDomainState(domain, STATE_KEY, merged)
      log(cfg.logPath, 'state-adopted-from-file', { reason: 'file-fresh', mtime })
    } catch (err) {
      log(cfg.logPath, 'error', { where: 'adopt-file-state', message: String(err?.message ?? err) })
    }
  }

  // ⚠️ **重载时必须关闭旧 domain**（2026-11-17 加）
  //
  // 插件热重载（HMR / plugin_manager）时，旧实例被 unmount、新实例挂载。
  // 旧实例若不关 domain，新实例 `open()` 会拿到
  // "domain 'doubao_proactive' is already open" ⇒ **永远回落文件模式**。
  //
  // `close()` 必须是**异步**的（domain 的写链要 drain），
  // 但 effect 的 disposer 不能 await ⇒ 用 `void` 并吞掉错误。
  const closeDomain = () => {
    const d = state.domain
    state.domain = null
    if (!d) return
    try {
      const r = typeof d.close === 'function' ? d.close() : null
      if (r && typeof r.catch === 'function') {
        r.catch((err) => log(cfg.logPath, 'error', {
          where: 'domain-close', message: String(err?.message ?? err),
        }))
      }
    } catch (err) {
      log(cfg.logPath, 'error', { where: 'domain-close', message: String(err?.message ?? err) })
    }
  }

  // 读状态：domain 优先，回落文件
  const readState = () => {
    const fromDomain = readDomainState(state.domain, STATE_KEY)
    const base = fromDomain ?? loadState(cfg.statePath)
    // ── Config 的暂停开关优先（2026-11-17）────────────────────
    //
    // "别主动找我"是**配置**，不是运行期状态：
    // 用户在 Settings 页面点一下（.volatile() ⇒ 不重启插件）就生效。
    // Config 为 true ⇒ 一定暂停（不管状态文件里写着什么）。
    // Config 为 false ⇒ 状态文件里的 paused 仍然算数
    //（这样"临时暂停"和"长期关掉"两种用法都能表达）。
    const paused = typeof cfg.getPaused === 'function' ? cfg.getPaused() : cfg.paused === true
    if (paused) return { ...base, paused: true }
    return base
  }

  // 写状态：domain 为主 + 文件镜像（迁移用）
  const writeState = async (next) => {
    const ok = await writeDomainState(state.domain, STATE_KEY, next)
    saveState(cfg.statePath, next)   // 镜像：让状态跟着人格包走
    return ok
  }

  /**
   * 用户回话了 ⇒ 计数归零 + 解掉"因为没人理我所以闭嘴"的暂停。
   *
   * ⚠️ 2026-11-18 加。
   *
   * 原来 `unansweredCount` **只增不减**：连着两次主动开口没人理，
   * `unansweredCount >= maxUnanswered` ⇒ `paused = true` ⇒
   * **永远不开口了**——哪怕用户隔天就回了我。
   *
   * 人不是这样：搭了几次没人理、闷了；用户一回话，就又活过来了。
   * 但**手动暂停**（用户亲口说"别主动找我"）不能被这条自动解掉——
   * 所以要靠 `pausedReason` 区分（见 decide.js 的第 4 步）。
   *
   * ⚠️ 只有**真人**消息才算（`source.kind === 'user'`）：
   *    插件自己投的（manas-proactive）、系统注入的（runtime-context 等）
   *    都不算用户在回话。
   */
  const noteHumanReply = async () => {
    try {
      const current = readState()
      let changed = false
      if ((current.unansweredCount ?? 0) > 0) {
        current.unansweredCount = 0
        changed = true
      }
      if (current.paused && current.pausedReason === 'unanswered-cap') {
        current.paused = false
        current.pausedReason = null
        changed = true
        log(cfg.logPath, 'pause-released', { reason: 'human-replied' })
      }
      if (changed) await writeState(current)
      // ── JitRL：他回话了 ⇒ 未回的搭讪结算为正向（+1）──────────
      if (isJitrlOn(cfg)) {
        try {
          const jitrlFile = join(cfg.paths.state ?? '', 'jitrl-proactive.json')
          const store = loadMemory(jitrlFile)
          const settled = settleOnReply(store, {
            at: new Date().toISOString(),
            maxRows: cfg.jitrl?.maxRows,
          })
          if (settled) saveMemory(jitrlFile, store)
        } catch (err) {
          log(cfg.logPath, 'error', { where: 'jitrl-settle-reply', message: String(err?.message ?? err) })
        }
      }
    } catch (err) {
      log(cfg.logPath, 'error', { where: 'note-human-reply', message: String(err?.message ?? err) })
    }
  }

  // domain 服务可选：拿得到就用它，拿不到就用文件。
  // `ctx.inject` 在依赖缺席时不注入 ⇒ 这里用一个"总是注入"的包装：
  // 先试着开 domain，开不了就按文件模式继续。
  const scopeWithDomain = scope
  void openDomain(scopeWithDomain)

  // `tryProactive` 是模块级函数，拿不到这里的闭包 ⇒ 把存取器挂到 cfg 上传进去。
  // （2026-11-17 踩过：闭包里的 readState 在函数作用域外 ⇒ "readState is not defined"，
  //   表现为搭讪彻底不投递、但日志只写一句 maintenance-rejected，很难查。）
  cfg.readState = readState
  cfg.writeState = writeState
  cfg.noteHumanReply = noteHumanReply
  // domain 句柄要能被 tryProactive 拿到（主题状态在里面）
  // ⚠️ `state` 这个名字在 tryProactive 那个函数作用域里**不可见**
  //    （它是 mount 里的局部 const）⇒ 挂到 cfg 上。
  cfg.getDomain = () => state.domain

  scope.effect(() => {    // ── 记账：这个会话的第一条 user 消息是什么来源 ─────────────
    // 这是认出 phase 会话**最可靠**的信号：schedule 投递时写死
    // `source: { kind: 'schedule' }`（dsh-schedule/src/runtime.ts:353）。
    // 没有它，DSH 的 SessionHeader 又没有"自动化"标记，
    // phase 会话会被当成普通顶层会话 ⇒ 搭讪的话投进去 ⇒ 被当成用户在说话。
    //
    // ⚠️ 用 `agent/pre-step` 而不是 `agent/inbox/inserted`：
    //    后者的 emit 点（dsh-agent-loop/src/inbox.ts:228）只传 `{ message }`，
    //    **没有 agent** ⇒ 没法归到具体会话。
    //    pre-step 的 payload 是 `{ agent, messages, turn, step, ... }`（dsh-agent/src/runtime-types.ts:351）。
    const onPreStep = async (payload, next) => {
      try {
        const agent = payload?.agent
        const messages = Array.isArray(payload?.messages) ? payload.messages : []
        const users = messages.filter((m) => m?.role === 'user')
        const firstUser = users[0]
        if (agent && firstUser?.source?.kind) {
          rememberFirstSourceKind(agent, firstUser.source.kind)
        }
        // 用户在这个会话里说过话 ⇒ 它是真人对话，不是自动化会话
        if (agent && users.some((m) => m?.source?.kind === 'user')) {
          rememberHumanSpoke(agent, true)
          // 真人回话了 ⇒ 未回计数归零 + 解掉"没人理所以闭嘴"的暂停
          void noteHumanReply()
        }
      } catch (err) {
        log(cfg.logPath, 'error', { where: 'pre-step', message: String(err?.message ?? err) })
      }
      return next()
    }
    scope.on('agent/pre-step', onPreStep)

    // 路径 A：idle 事件
    const onStatus = async (payload) => {
      try {
        if (payload?.status !== 'idle') return
        const agent = payload.agent
        if (!agent) return
        if (!isRoot(agent, scope)) return
        await tryProactive(agent, cfg, scope, 'idle-event')
      } catch (err) {
        log(cfg.logPath, 'error', { where: 'idle-event', message: String(err?.message ?? err) })
      }
    }
    scope.on('agent/status', onStatus)

    // 路径 B：兜底轮询（会话彻底空闲时补一次）
    // ⚠️ 2026-11-13：不能遍历 roots() —— Desktop 里它返回空（见 agent-utils.js），
    //    改用自己维护的顶层 agent 集合。
    const roots = trackRootAgents(scope)
    const timer = setInterval(() => {
      try {
        const agents = roots.agents()
        // ── 诊断（2026-11-18 加）────────────────────────────────
        // 症状：poll 之后**连 trace 都没有** ⇒ 候选 agent 在
        //       `if (agent.status !== 'idle') continue` 那一行就被跳过了
        //       （那行不记日志 ⇒ 什么都不剩）。
        //       到底是"不在 roots 里"还是"status 不是 idle"，光看外面猜不出来
        //       ⇒ 让插件自己报。
        log(cfg.logPath, 'poll-agents', {
          roots: agents.length,
          agents: agents.map((a) => ({
            id: a?.id ?? null,
            session: a?.session?.id ?? a?.session?.header?.id ?? null,
            status: a?.status ?? null,
          })),
        })
        // ── 排序：用户最近待着的会话排前面（2026-11-17 加）──────
        //
        // 桌面版能同时有十几个顶层会话（一半是 phase 会话），
        // 搭讪该投给"他刚待过的那个"，不是注册表里的第一个。
        // humanSpoke = 这个会话里用户说过话；lastHumanAt = 什么时候说的。
        const ranked = [...agents].sort((a, b) => {
          const ha = humanSpoke(a) ? 1 : 0
          const hb = humanSpoke(b) ? 1 : 0
          if (ha !== hb) return hb - ha
          return lastHumanAt(b) - lastHumanAt(a)
        })
        for (const agent of ranked) {
          if (agent.status !== 'idle') continue    // 忙 → 直接跳过，不产生回合
          void tryProactive(agent, cfg, scope, 'poll')
        }
      } catch (err) {
        log(cfg.logPath, 'error', { where: 'poll', message: String(err?.message ?? err) })
      }
    }, cfg.pollIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()

    log(cfg.logPath, 'mount', {
      pollIntervalMs: cfg.pollIntervalMs,
      statePath: cfg.statePath,
      code: codeFingerprint(),
      // 飞书落点的依赖（dshHome 推不出来 ⇒ 直发必然失败）
      feishu: cfg.feishu?.enabled
        ? { enabled: true, dshHome: cfg.feishu.dshHome, ...cfg.feishu.debugEnv }
        : { enabled: false },
    })

    // ── 飞书直发自检（2026-11-18）────────────────────────────
    //
    // ## 它是什么
    //
    // 让**插件进程自己**跑一次完整的发送链路，并全程留痕。
    // 用途只有一个：**当"插件进程发不出去、而探针进程能发"时，缩小范围**。
    // （2026-11-18 就是靠它排除了"Electron 的 fetch 不一样"这个假设——
    //   自检在插件进程里**成功**了 ⇒ 网络栈没问题 ⇒ 方向转到 token 缓存。）
    //
    // ## 怎么触发（不会误触发）
    //
    // **写一个标志文件**，然后重载插件：
    //   ```
    //   New-Item -ItemType File -Force "D:\dsh\persona\助手\RUNTIME\state\feishu-selftest.flag"
    //   ```
    // 插件挂载后 6 秒跑一次自检，**跑完自动删掉标志文件**（一次性）。
    //
    // ⚠️ **为什么不用配置项**：配置项是"常驻设置"，
    //    万一忘了关 ⇒ 每次 HMR 重载都往用户飞书里刷一条测试消息。
    //    标志文件是"一次性的动作"⇒ 忘了最多下次重载时多跑一次，不会一直跑。
    //
    // ## 影响面
    //
    // - **不进 DSH 会话**（不走 agent.followup）⇒ 不打断任何对话
    // - 只在手动触发时跑 ⇒ 平时零影响
    // - 会在用户飞书里出现**一条**标着"自检"的消息（这是它唯一的外溢）
    const selftestFlag = join(paths.state ?? '', 'feishu-selftest.flag')
    if (cfg.feishu?.enabled && existsSync(selftestFlag)) {
      setTimeout(async () => {
        try {
          // 一次性 ⇒ 先删标志（失败也不重复跑）
          try { unlinkSync(selftestFlag) } catch { /* ignore */ }
          const res = await trySendToFeishu({
            text: '【飞书直发自检】这条路是插件进程自己跑的，不是聊天。',
            sessionId: null,
            chatId: null,
            appId: cfg.feishu.appId,
            appSecret: cfg.feishu.appSecret,
            dshHome: cfg.feishu.dshHome,
            logPath: cfg.logPath,
          })
          log(cfg.logPath, 'feishu-selftest', res)
        } catch (err) {
          log(cfg.logPath, 'error', { where: 'feishu-selftest', message: String(err?.message ?? err) })
        }
      }, 6000)
    }

    return () => {
      clearInterval(timer)
      roots.dispose()
      closeDomain()      // 重载/卸载 ⇒ 释放 domain（否则下次 open 会撞 already-open）
      log(cfg.logPath, 'unmount', {})
    }
  })
}

/** 只有顶层 agent 才参与 —— 纯任务子 agent 不需要人格搭讪 */
function isRoot(agent, ctx) {
  return isRootAgent(agent, ctx)
}

/**
 * 取 agent 的 **DSH 会话 id** —— 飞书那边按它查 chatId。
 *
 * ⚠️ 为什么要多路兜底：agent 上有好几个像 id 的字段，
 *    `agent.id`（agent 自己的）和 `session.id`（会话的）**不是一回事**。
 *    飞书插件的 state.json 里记的是**会话 id** ⇒ 拿错了就查不到 chatId。
 *    而 `agent.id` 到底是不是会话 id，取决于 Host 实现 ⇒ 多试几路。
 *
 * @param {object} agent
 * @returns {string|null}
 */
function sessionIdOf(agent) {
  const candidates = [
    agent?.session?.id,
    agent?.session?.header?.id,
    agent?.sessionId,
    agent?.id,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('session-')) return c
  }
  // 都不是 session- 开头 ⇒ 返回第一个非空的，交给调用方去试
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
  }
  return null
}

async function tryProactive(agent, cfg, ctx, trigger) {
  if (inFlight.has(agent)) return          // 同一 agent 只允许一个在途判定
  inFlight.add(agent)
  try {
    // ── phase 会话闸门（2026-11-14 加）─────────────────────────
    // 四个 phase（ingest/wiki/lint/reflect）是**自动化会话**：
    // 用户没在里面说话，schedule 投递的是协议指令。
    // 把主动搭讪的话投进去 = 让 LLM 在自动化会话里演"有人在跟你聊天"，
    // 那条话会被当成用户的话被下一轮认真对待（2026-11-14 出过事故：
    // 一句编造的"vault/raw 那份配置又改了"投进了 ingest 会话）。
    // 所以：**phase 会话一律不主动搭讪。**
    if (isPhaseAgent(agent, ctx)) {
      log(cfg.logPath, 'skip', { trigger, reason: 'phase-session' })
      return
    }

    // 宽限期：确认用户真的走开了（他可能马上又发消息）
    const grace =
      cfg.idleGraceMs.min + Math.random() * (cfg.idleGraceMs.max - cfg.idleGraceMs.min)
    log(cfg.logPath, 'trace', {
      trigger, stage: 'grace-wait', agent: agent?.id, graceMs: Math.round(grace),
      status: agent?.status,
    })
    await sleep(grace)
    if (agent.status !== 'idle') {         // 用户回来了 → 放弃
      log(cfg.logPath, 'skip', { trigger, reason: 'not-idle-after-grace' })
      return
    }
    log(cfg.logPath, 'trace', { trigger, stage: 'grace-done', agent: agent?.id })

    // 判定 + 生成在 maintenance 阶段跑：
    // 期间到达的用户消息留在 inbox，公开状态仍是 idle —— 不会插进对话流。
    //
    // ⚠️ 整段包在**全局串行闸**里（见文件头 withDeliveryLock）：
    //    一轮轮询有 17 个顶层会话，各自判定会连投好几条。
    //    拿到闸之后重新读状态 ⇒ 后到的会被 minGapMs 正常拦下。
    try {
      await withDeliveryLock(async () => {
        // ── 诊断（2026-11-18 加）──────────────────────────────
        // 症状：poll 之后**既没有 decision 也没有任何 skip**，
        //       状态也不动 ⇒ 卡在这段里的某一步，但**一行日志都没有**。
        //       今天是第二次被"静默卡住"坑到 ⇒ 每个关口都留痕。
        log(cfg.logPath, 'trace', { trigger, stage: 'got-lock', agent: agent?.id })
        await agent.runMaintenance(async () => {
        log(cfg.logPath, 'trace', { trigger, stage: 'in-maintenance' })
        const current = cfg.readState ? cfg.readState() : loadState(cfg.statePath)

        // ── 选主题（2026-11-18 主题演进系统）──────────────────────
        //
        // **纯代码，0 LLM token**：四块地基（梗 / wiki 断言 / 住相 / daily）
        // → 候选池 → 按"轴 + 说过几次 + 多久没提"打分 → 选中一条。
        //
        // 为什么不再"全量素材让模型自己挑"：
        //   实测 11-18 上午 5 条里 4 条在讨老婆（梗池只有 3 条且全在 11-14，
        //   模型面对一堆同质素材只能挑占比最高的那个）。
        const themeStates = (() => {
          try {
            return readThemeStates(cfg.getDomain ? cfg.getDomain() : null)
          } catch (err) {
            log(cfg.logPath, 'error', { where: 'read-themes', message: String(err?.message ?? err) })
            return {}
          }
        })()
        const { seeds, snapshot } = collectSeeds(cfg.paths)
        const guidance = snapshotGuidance(snapshot)
        // ── JitRL 优势调制（2026-11-18，docs/PRD-JITRL.md）────────
        // 关闭 / 无记忆 / 邻居不足 / 出错 ⇒ 与 selectTheme 完全一致。
        const jitrlEnabled = isJitrlOn(cfg)
        const jitrlFile = join(cfg.paths.state ?? '', 'jitrl-proactive.json')
        const jitrlStore = jitrlEnabled ? loadMemory(jitrlFile) : null

        // ── verbalized logit（论文降级实现）：一次调用拿候选 0-100 分 ──
        // 没有 logprobs 的端点走这条；失败 ⇒ verbal=null ⇒ 规则先验分。
        let verbal = null
        if (jitrlEnabled && cfg.jitrl?.scoring === 'verbalized') {
          try {
            const liveModel = typeof cfg.getModel === 'function' ? cfg.getModel() : cfg.model
            const nowMs = new Date()
            const top = scoreThemes(seeds, themeStates, {
              currentAxis: guidance?.preferAxis ?? null,
              now: nowMs.toISOString(),
            }).sort((a, b) => b.score - a.score).slice(0, cfg.jitrl?.topCandidates ?? 8)
            const labels = top.map((entry) => entry.seed.seed ?? entry.seed.text ?? entry.seed.id)
            const probs = await scoreCandidates(scope, { model: liveModel }, {
              state: [
                `energy=${(current.energy ?? 0.5).toFixed(2)}`,
                `recent=${(current.recentProactive ?? []).map((r) => r.topic ?? '').filter(Boolean).join(' / ').slice(0, 200) || 'none'}`,
              ].join('; '),
              candidates: labels,
            })
            if (probs) {
              verbal = Object.fromEntries(top.map((entry, i) => [entry.seed.id, probs[i]]))
            }
          } catch (err) {
            log(cfg.logPath, 'error', { where: 'jitrl-verbalized', message: String(err?.message ?? err) })
          }
        }

        const picked = selectWithAdvantage(seeds, themeStates, {
          currentAxis: guidance?.preferAxis ?? null,
          now: new Date().toISOString(),
          jitrl: cfg.jitrl,
          store: jitrlStore,
          state: current,
          verbal,
          onDecision: (info) => log(cfg.logPath, 'jitrl-decision', info),
        })
        const themeBrief = picked ? expandTheme(picked.seed) : ''
        const themeCtx = picked
          ? { brief: themeBrief, guidance: guidance?.guidance ?? '', saidTimes: picked.state?.saidTimes ?? 0 }
          : null

        // ── 判定 ────────────────────────────────────────────────
        const verdict = decide(current, cfg, new Date(), Boolean(themeBrief), {
          theme: picked ? { seed: picked.seed, state: picked.state } : null,
        })
        if (verdict.stateChanged) await cfg.writeState(current)
        log(cfg.logPath, 'decision', {
          trigger,
          hasMaterial: Boolean(themeBrief),
          theme: picked?.seed?.id ?? null,
          themeAxis: picked?.seed?.axis ?? null,
          themeSaid: picked?.state?.saidTimes ?? 0,
          ...verdict,
          theme: verdict.theme ? { id: verdict.theme.seed.id, saidTimes: verdict.theme.state?.saidTimes ?? 0 } : null,
        })

        if (!verdict.shouldSpeak) return

        const liveModel = typeof cfg.getModel === 'function' ? cfg.getModel() : undefined
      const liveFallback = typeof cfg.getFallbackModels === 'function' ? cfg.getFallbackModels() : undefined
      const effectiveCfg = {
        ...cfg,
        ...(liveModel ? { model: liveModel } : {}),
        ...(liveFallback ? { fallbackModels: liveFallback } : {}),
      }
        const { text, failure } = await generateMessage(
          ctx, effectiveCfg, current, verdict, new Date(), null, themeCtx,
        )
        if (!text) {
          log(cfg.logPath, 'error', { where: 'generate', failure, motive: verdict.motive })
          return
        }

        // 投递 —— 只有到这里才产生一次对话
        //
        // ⚠️ 不能 import { createUserMessage } from '@deepseek-ai/dsh-llm'：
        //    本插件是以 link: 方式装进 profile 的，Node 解析裸包名会从**真实路径**
        //    （D:\dsh\persona\...）往上找 node_modules，找不到 profile 的那份 → ERR_MODULE_NOT_FOUND。
        //    所以这里手搓 UserMessage 字面量：id 非空字符串、role='user'、
        //    content 是 ContentBlock[]、source.kind 非空字符串 —— 满足 session 的持久化校验。
        //
        // ⚠️ **归属（2026-11-18 重做）**：
        //    投进去的是一条**明确标注角色的触发指令**，让模型把那句话
        //    **作为自己的 assistant 输出说出来**——
        //    而不是把搭讪原话当 user 消息投进去（那样模型会当成用户在说，
        //    回出来的是"回应"，渠道发出去的也就不是搭讪本身）。
        //    详见 lib/proactive/llm.js 的 TRIGGER_PREFIX。
        //
        //    `form:'notice'` + `summary` 让界面那行也写明是谁在说话。
        //
        // ── 渠道：飞书直发优先（2026-11-18 加，用户选的方案 A）────────
        //
        // 目标会话若是**飞书会话** ⇒ 直接调飞书 API 把这句话发过去。
        // 发成功了**就不再往 DSH 会话投**（否则同一个意思在两处各来一遍）。
        //
        // 为什么要直发（而不是让飞书插件转发）：
        //   飞书插件只处理 `assistant/message`，且要求有**活跃 run**——
        //   而 run 是用户**在飞书发消息时**才建的。它不暴露任何服务给别的插件
        //   ⇒ DSH 生态里没有"插件主动往渠道推消息"的通道。
        //
        // 失败（没配 appId/secret、不是飞书会话、API 报错）⇒ **回落**到投 DSH 会话。
        // 绝不因为发不出去就不说话。
        let deliveredToFeishu = false
        if (cfg.feishu?.enabled) {
          const sessionId = sessionIdOf(agent)
          const res = await trySendToFeishu({
            text,
            sessionId,
            chatId: cfg.feishu.chatId || null,
            appId: cfg.feishu.appId,
            appSecret: cfg.feishu.appSecret,
            dshHome: cfg.feishu.dshHome,
            logPath: cfg.logPath,      // 诊断：换 token 的每一步都要留痕
          })
          if (res.ok) {
            deliveredToFeishu = true
            log(cfg.logPath, 'deliver-feishu', {
              motive: verdict.motive,
              chatId: res.chatId,
              via: res.via,              // 'latest:reply' / 'session:reply' / '…:send'
              replyTo: res.replyTo ?? null,   // 回复到了哪条消息（落点排查用）
              messageId: res.messageId,
              sessionId,                 // 查 chatId 用的会话 id —— 排查路由问题要看这个
              text,
            })
          } else {
            log(cfg.logPath, 'deliver-feishu-failed', {
              motive: verdict.motive, error: res.error, via: res.via,
            })
          }
        }

        if (!deliveredToFeishu) {
          try {
            agent.followup({
              id: `manas-proactive-${randomUUID()}`,
              role: 'user',
              content: [{ type: 'text', text: buildTriggerMessage(text) }],
              source: {
                kind: 'manas-proactive',
                form: 'notice',
                summary: '助手主动搭讪：这条是助手自己开口说的话，不是用户发的',
              },
            })
          } catch (err) {
            log(cfg.logPath, 'error', { where: 'deliver', message: String(err?.message ?? err) })
            return
          }
        }

        // 更新状态
        const nowIso = new Date().toISOString()

        // ── JitRL：发送成功后结算上一条 + 登记本条（2026-11-18）──
        // 只认行为信号：他回了 ⇒ +1；下一条发出时还没回 ⇒ -1。
        if (jitrlEnabled && picked) {
          try {
            const sig = stateSignature(current, new Date(nowIso), guidance?.preferAxis ?? null)
            settleOnSend(jitrlStore, { sig, action: picked.seed.id }, {
              at: nowIso,
              replyWindowMs: cfg.jitrl?.replyWindowMs,
              maxRows: cfg.jitrl?.maxRows,
            })
            saveMemory(jitrlFile, jitrlStore)
          } catch (err) {
            log(cfg.logPath, 'error', { where: 'jitrl-settle-send', message: String(err?.message ?? err) })
          }
        }

        current.todayCount = (current.todayCount ?? 0) + 1
        current.unansweredCount = (current.unansweredCount ?? 0) + 1
        current.lastProactiveAt = nowIso
        current.recentProactive = [
          { at: nowIso, motive: verdict.motive, topic: text.slice(0, 40) },
          ...(current.recentProactive ?? []),
        ].slice(0, 5)
        current.nextEligibleAt = null
        await cfg.writeState(current)

        // ── 推进主题状态（2026-11-18 主题演进系统）──────────────
        //
        // 说完之后这条线往前走一步：saidTimes++、stage 推进、
        // 记下用过的具体话头（同一个话头不消费两次）。
        // ⇒ 下次选主题时，这条线会因为"说过几次 / 刚说过"被降权或冷却，
        //    自然换到别的线上去 ⇒ **这就是"演进"**。
        if (picked) {
          const nextTheme = advanceTheme(picked.state, picked.seed, nowIso)
          let okTheme = false
          try {
            okTheme = await writeThemeState(cfg.getDomain ? cfg.getDomain() : null, nextTheme)
          } catch (err) {
            // ⚠️ **不许静默**（2026-11-18 踩过：中文 id 被 domain 拒绝，
            //    错误被吞 ⇒ 记录静默丢失 ⇒ 主题状态永远不更新）
            log(cfg.logPath, 'error', {
              where: 'write-theme', id: nextTheme.id, message: String(err?.message ?? err),
            })
          }
          log(cfg.logPath, 'theme-advance', {
            id: nextTheme.id, saidTimes: nextTheme.saidTimes, stage: nextTheme.stage, saved: okTheme,
          })
        }

        log(cfg.logPath, 'deliver', { motive: verdict.motive, text })
        })
      })
    } catch (err) {
      // runMaintenance 在 agent 正忙时同步抛错 —— 放弃这次，不打扰
      log(cfg.logPath, 'skip', { trigger, reason: 'maintenance-rejected', message: String(err?.message ?? err) })
    }
  } finally {
    inFlight.delete(agent)
  }
}
