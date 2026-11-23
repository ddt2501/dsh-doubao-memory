/**
 * dsh-doubao-memory —— 根入口
 *
 * 装上它，DSH 一启动就该知道四件事：
 *   1. **初始化**：人格实例目录不存在 ⇒ 自己从 templates/ 长出来；人格入口 AGENTS.md 写进工作区
 *   2. **运行**：四个 phase 自动注册；主动搭讪与 per-turn 住相自动挂载
 *   3. **维护**：lint 的老化、schedule 的幂等自愈、残留任务清理
 *   4. **可配置**：`persona` 设定填好后自动生成本地人格文件与初始末那识；
 *      四个 phase 的模型可跟随主模型、也可单独指定
 *
 * 用户**不需要先跑任何脚本**（`setup-persona.ps1` 只是给"想在装之前就看到实例"的人用的等价物）。
 */

import { join } from 'node:path'
import { writeFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolvePaths } from './paths.js'
import { readFeishuAppId, readAppSecret } from './proactive/feishu.js'
import { ensureInstance, writePersonaEntry } from './bootstrap.js'
import { mount as mountProactive } from './proactive/index.js'
import { mount as mountSnapshot } from './snapshot/index.js'
import { openMemoryStore, setFactMemoryStore, getFactMemoryStore } from './memory/store.js'
import { buildFactView } from './memory/export.js'
import { mountFactMemoryTools } from './memory/tools.js'
import { mount as mountMemorySystem, armPhaseCleanup, disarmPhaseCleanup } from './memory-system.js'
import { mount as mountPhaseQuiet } from './phase-quiet.js'
import { setPhaseTitlePrefix } from './phase-detect.js'
import { mountPhaseService } from './phases/service.js'
import { generatePersonaFiles, hasPersonaContent } from './persona-generate.js'
import { mountPersonaPrompt } from './persona-prompt.js'
import {
  classifyPersonaDir, listPersonas, resolveActivePersona, writeOrigin,
} from './persona-registry.js'
import { Config } from './config.js'
import { log } from './log.js'

export { Config }

const DEFAULTS = {
  enabled: true,
  /** 数据根目录（默认 = 包根）。指到别处 = 这个包只提供机制，不带记忆。 */
  dataRoot: null,
  /** 状态目录（默认 <dataRoot>/RUNTIME/state） */
  stateDir: null,
  /** 对方的称呼（协议里的 {USER}） */
  userName: '用户',
  /** 我自己的名字（协议里的 {ASSISTANT}） */
  assistantName: '助手',
  proactive: { enabled: true },
  snapshot: { enabled: true },
  memory: { enabled: true },
  factMemory: { enabled: true },
  /**
   * 人格入口（AGENTS.md）安装：DSH 的 `dsh-agent-instructions` 只自动加载
   * **工作区根**的 AGENTS.md。插件启动时会自动写过去
   * （**只在不存在时写**，不覆盖用户改过的版本）。
   */
  personaEntry: { enabled: true, path: null, overwrite: false },
  /** 人格设定（用户手填；填了就生成人格文件） */
  persona: null,
  /** 四个 phase 的模型：follow = 跟随主模型，custom = 单独指定 */
  phaseModel: { mode: 'follow', provider: '', model: '' },
}

/** 读一个配置值。
 *
 * ⚠️ `.volatile()` 字段在 schema 里是**引用**，必须 `.get()` 才拿到当前值；
 *    非 volatile 字段是普通值。两种形态都要认——设置页保存走的是 volatile 路径。
 */
function unwrap(v, fallback) {
  if (v === undefined || v === null) return fallback
  if (typeof v === 'object' && typeof v.get === 'function') {
    try {
      const got = v.get()
      return got === undefined ? fallback : got
    } catch { return fallback }
  }
  return v
}

/**
 * 这个值是不是 schemastery schema？
 *
 * ⚠️ schemastery 的 schema **是函数**（`typeof Config === 'function'`），
 *    不是对象。所以不能用 `typeof x === 'object'` 判断——
 *    2026-11-14 我这么写，探针永远返回 false，白排查了两轮。
 *    DSH 自己的判据是 `'toJSON' in schema`（dsh-settings/lib/index.js:539）。
 */
function schemasteryLike(x) {
  try {
    return (typeof x === 'function' || (typeof x === 'object' && x !== null)) && 'toJSON' in x
  } catch {
    return false
  }
}

/** 把配置里的人格设定归一成一个普通对象 */
function readPersona(config) {
  const p = config.persona ?? {}
  // ⚠️ 数组字段整体也是 volatile 引用 ⇒ 必须**先 unwrap 数组本身**再逐项 unwrap。
  //    先按数组遍历会得到 []（Array.isArray(ref) 为 false），
  //    表现出来就是"填了性格特质但生成的 SOUL 里没有"。
  const arr = (v) => {
    const raw = unwrap(v, [])
    if (!Array.isArray(raw)) return []
    return raw.map((x) => String(unwrap(x, '') ?? '')).filter(Boolean)
  }
  const str = (v, d = '') => String(unwrap(v, d) ?? d).trim()

  // 顶层 userName / memory.userName 是老写法，仍然认（人格设定优先）
  const legacyUser = config.userName ?? config.memory?.userName
  const legacyAssistant = config.assistantName ?? config.memory?.assistantName

  return {
    userName: str(p.userName) || String(legacyUser ?? DEFAULTS.userName),
    assistantName: str(p.assistantName) || String(legacyAssistant ?? DEFAULTS.assistantName),
    selfDescription: str(p.selfDescription),
    coreTraits: arr(p.coreTraits),
    tone: str(p.tone),
    taboos: arr(p.taboos),
  }
}

/** 读一个模型路由（provider + model），缺任一项返回 null */
function readModelRef(ref) {
  if (!ref) return null
  const provider = String(unwrap(ref.provider, '') ?? '').trim()
  const model = String(unwrap(ref.model, '') ?? '').trim()
  if (!provider || !model) return null
  const maxTokens = Number(unwrap(ref.maxTokens, 0)) || undefined
  return maxTokens ? { provider, model, maxTokens } : { provider, model }
}

/** 读降级链 */
function readFallbackModels(list) {
  const raw = unwrap(list, [])
  if (!Array.isArray(raw)) return []
  const out = []
  for (const m of raw) {
    const r = readModelRef(m)
    if (r) out.push(r)
  }
  return out
}

/**
 * 取 DSH 的 **profileContext** —— DSH home / profile 目录 / patch 路径的**可靠来源**。
 *
 * ⚠️ 2026-11-18 第三次踩同一个坑：
 *    `process.env.DSH_HOME` 在 **Electron 的 renderer 进程里是空的**
 *    （诊断日志实测：`envDshHome:"(空)"  envProfileDir:"(空)"`）
 *    ⇒ 靠环境变量定位 DSH home 的代码**全部失效**。
 *
 * `profileContext` 由 DSH 启动器 provide（dsh/lib/profile-boot-*.js:291-305），
 * 带 `home`（= $DSH_HOME）/ `dir`（profile 目录）/ `patchPath`（cordis.patch.yml）。
 * ⇒ **不依赖环境变量，也不依赖猜路径。**
 *
 * ⚠️ `ctx.get(name, false)`：第二个参数 false = 没有也不报错
 *    （Cordis 的 ctx 是 Proxy，直接取没 inject 的服务会抛）。
 *
 * @param {object} ctx
 * @returns {{home?: string, dir?: string, patchPath?: string, name?: string}|null}
 */
function profileContextOf(ctx) {
  try {
    const pc = ctx?.get?.('profileContext', false)
    if (!pc) return null
    return {
      home: pc.home ?? null,
      dir: pc.dir ?? null,
      patchPath: pc.patchPath ?? null,
      name: pc.name ?? null,
    }
  } catch {
    return null
  }
}

/**
 * 飞书直发用的 appId —— 没配就从**飞书插件那继承**。
 *
 * 同一个飞书应用、同一个机器人，没必要让用户填两遍。
 * 读法见 lib/proactive/feishu.js 的 readFeishuAppId（不引 YAML 依赖）。
 *
 * @param {object} config - 插件配置
 * @returns {string} appId（可能为空串）
 */
function feishuAppIdOf(config, profileCtx = null) {
  const configured = String(unwrap(config.proactive?.feishu?.appId, '') ?? '').trim()
  if (configured) return configured
  try {
    // ⚠️ profile patch 路径的来源要**几个都试**（按可靠度排）：
    //    ① profileContext.patchPath（DSH 启动器给的 ⇒ 最可靠）
    //    ② config 里带的
    //    ③ paths.profilePatch（环境变量推导的，Electron 里可能是空的）
    const candidates = [
      profileCtx?.patchPath,
      unwrap(config.proactive?.feishu?.profilePatch, ''),
      resolvePaths(config).profilePatch,
    ].filter(Boolean)
    for (const patch of candidates) {
      const found = readFeishuAppId(patch)
      if (found) {
        log(unwrap(config.proactive?.logPath, ''), 'info', { where: 'feishu-appid', source: patch })
        return found
      }
    }
  } catch { /* 读不到就空着 ⇒ 飞书直发会被跳过 */ }
  return ''
}

/** 四个 phase 用的模型路由（follow 时返回 null，表示不干预） */
function readPhaseModel(config) {
  const pm = config.phaseModel ?? {}
  const mode = String(unwrap(pm.mode, 'follow') ?? 'follow')
  if (mode !== 'custom') return null
  const provider = String(unwrap(pm.provider, '') ?? '').trim()
  const model = String(unwrap(pm.model, '') ?? '').trim()
  if (!provider || !model) return null
  return { provider, model }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const persona = readPersona(config)

  // ── 称呼归一：两种写法都认 ──────────────────────────────────
  // ⚠️ 2026-11-10 实测踩到：profile 里写的是 `memory.userName`，
  //    而插件只读顶层 ⇒ 线上跑的是默认的「用户/助手」，
  //    生成的 AGENTS.md 里也是「用户/助手」——人格名字悄悄丢了。
  cfg.userName = persona.userName
  cfg.assistantName = persona.assistantName
  // phase 标题前缀跟着当前人格走（REGISTRY 的 `{ASSISTANT}·xxx` 展开后与之一致）
  setPhaseTitlePrefix(`${cfg.assistantName}·`)

  if (!unwrap(cfg.enabled, true)) {
    // 插件整体禁用 = 四个 phase 也该停（否则任务还在，空跑协议）。
    // 延迟清理：重载后如果又启用了，新 fiber 的 apply 会 disarm 取消删除。
    try {
      const offPaths = resolvePaths(cfg)
      const offLog = join(offPaths.state, 'doubao-memory.log')
      ctx.inject(['schedule'], (scope) => {
        let sched = null
        try { sched = scope.schedule } catch { /* 服务没就绪 ⇒ cleanup 自己会跳过 */ }
        armPhaseCleanup(sched, offPaths, offLog)
      })
    } catch (err) {
      log(join(resolvePaths(cfg).state, 'doubao-memory.log'), 'error', {
        where: 'cleanup-disabled', message: String(err?.message ?? err),
      })
    }
    return
  }

  // ── 0. 选人格：先决定这次用哪个目录，再解析路径 ────────────────
  // 顺序很重要：dataRoot 是所有子系统的根，必须在挂载前定下来。
  const fallbackPaths = resolvePaths(cfg)
  const selection = resolveActivePersona(cfg, {
    activeId: unwrap(config.persona?.activeId, ''),
    newId: unwrap(config.persona?.newId, ''),
  }, fallbackPaths.dataRoot, fallbackPaths)

  if (selection.action === 'refuse') {
    // 拒绝就是拒绝：不改任何目录，继续用兜底路径（= 现状），并留一条明确日志。
    log(join(fallbackPaths.state, 'doubao-memory.log'), 'persona-select-refused', {
      reason: selection.reason,
      requested: selection.newId ?? null,
      using: fallbackPaths.dataRoot,
    })
  }

  const paths = resolvePaths({ ...cfg, dataRoot: selection.dir })
  const logPath = join(paths.state, 'doubao-memory.log')

  // 插件重新挂载 ⇒ 取消上一次 dispose 装下的卸载清理（重载不是卸载）
  disarmPhaseCleanup(logPath)

  if (selection.action !== 'refuse') {
    log(logPath, 'persona-selected', {
      action: selection.action,
      dir: paths.dataRoot,
      reason: selection.reason,
    })
  }

  // ── 0.1 自举：实例不存在就把它长出来 ───────────────────────────
  // ⚠️ 记住 existed：这是"初次装插件 vs 已有实例"的分界线。
  let instExisted = true
  try {
    const inst = ensureInstance(paths, cfg)
    instExisted = inst.existed
    if (inst.created.length) {
      log(logPath, 'instance-seeded', { root: inst.root, created: inst.created.slice(0, 40) })
    } else {
      log(logPath, 'instance-ok', { root: inst.root })
    }
  } catch (err) {
    log(logPath, 'error', { where: 'ensure-instance', message: String(err?.message ?? err) })
  }

  // ── 0.2 判定这个目录的来历，决定能不能写 ────────────────────────
  const personaKind = classifyPersonaDir(paths, paths.dataRoot, persona).kind
  const isForeign = personaKind === 'foreign'
  log(logPath, 'persona-classified', {
    kind: personaKind,
    dir: paths.dataRoot,
    existed: instExisted,
    protected: isForeign,
  })

  // 列出可用人格，方便用户在选择器里看到（也写进日志备查）
  try {
    const all = listPersonas(paths, cfg)
    if (all.length) {
      log(logPath, 'persona-list', {
        count: all.length,
        personas: all.map((p) => ({ id: p.id, kind: p.kind })),
        active: paths.dataRoot,
      })
    }

    // ── 给设置页的下拉准备数据 ──────────────────────────────────
    // 浏览器读不到文件系统，所以由 Host 把**人格清单**写进工作区根，
    // 设置页再用 `remote.workspaceFiles.read(sessionId, '.doubao-personas.json')`
    // 读回来渲染 `<select>`。
    //
    // 为什么写工作区根而不是 $DSH_HOME：客户端用**相对路径**读，
    // 相对路径是相对 Session 的 workspace root（= memory.targetCwd），
    // 这样不用把绝对路径也传给前端。
    const targetCwd = String(unwrap(cfg.memory?.targetCwd, '') ?? '').trim()
    if (targetCwd) {
      try {
        writeFileSync(
          join(targetCwd, '.doubao-personas.json'),
          JSON.stringify({
            generatedAt: new Date().toISOString(),
            active: paths.dataRoot,
            personas: all.map((p) => ({
              id: p.id,
              kind: p.kind,
              assistantName: p.assistantName,
              active: p.dir === paths.dataRoot,
            })),
          }, null, 2),
          'utf8',
        )
        log(logPath, 'persona-manifest-written', { targetCwd, count: all.length })
      } catch (err) {
        log(logPath, 'error', { where: 'persona-manifest', message: String(err?.message ?? err) })
      }
    }
  } catch (err) {
    log(logPath, 'error', { where: 'persona-list', message: String(err?.message ?? err) })
  }

  // 新建的人格：登记来历，之后它的生成物就可以安全重写
  if (personaKind === 'new' || (selection.action === 'create' && !instExisted)) {
    writeOrigin(paths.dataRoot, { newId: selection.newId ?? null })
  }

  // ── 0.5 人格设定 → 生成核心人格文件 + 初始末那识 ──────────────
  // 只在真填了东西时生成；覆盖用户手写文件前会先备份（见 persona-generate.js）。
  const runGenerate = (why) => {
    try {
      const force = unwrap(config.persona?.regenerate, false) === true
      const live = readPersona(config)
      // kind 每次重算：设置页保存后目录状态可能已变（比如刚新建出来）
      const kind = classifyPersonaDir(paths, paths.dataRoot, live).kind
      const res = generatePersonaFiles(paths, live, { force, kind })
      if (res.skipped) {
        log(logPath, 'persona-generate-skipped', { why, kind, reason: res.skipped })
      } else if (res.generated.length || res.backups.length || (res.skippedFiles ?? []).length) {
        log(logPath, 'persona-generated', {
          why,
          kind,
          files: res.generated,
          backups: res.backups,
          // 手写文件默认不动——列出来是为了让用户知道"为什么改了设定没生效"
          protectedFiles: res.skippedFiles ?? [],
        })
      }
    } catch (err) {
      log(logPath, 'error', { where: 'persona-generate', message: String(err?.message ?? err) })
    }
  }
  runGenerate('mount')

  // ── 人格设定在设置页改过 ⇒ 重新生成 ──────────────────────────
  // feishu 插件用的是同一个事件（settings/document-updated，参数是条目 id）。
  try {
    ctx.on('settings/document-updated', (ns) => {
      if (String(ns) !== 'doubao-memory') return
      runGenerate('settings-updated')
    })
  } catch (err) {
    log(logPath, 'error', { where: 'settings-hook', message: String(err?.message ?? err) })
  }

  // ── 1. 人格入口（AGENTS.md）——工作区根，DSH 自动加载它 ────────
  // ⚠️ **只在明确知道工作区时才写**。默认落到 process.cwd() 会出事：
  //    测试、脚本、别的 cwd 都会把 AGENTS.md 丢在不该放的地方
  //    （2026-11-10：自测就把它写进了插件包根目录）。
  try {
    const entry = cfg.personaEntry ?? {}
    if (unwrap(entry.enabled, true) !== false) {
      const target = unwrap(entry.path, null)
        ?? (cfg.memory?.targetCwd ? join(String(unwrap(cfg.memory.targetCwd, '')), 'AGENTS.md') : null)
      if (!target) {
        log(logPath, 'persona-entry-skipped', { reason: 'no workspace configured (set memory.targetCwd or personaEntry.path)' })
      } else {
        const res = writePersonaEntry(paths, {
          path: target,
          overwrite: unwrap(entry.overwrite, false) === true,
          userName: persona.userName,
          assistantName: persona.assistantName,
        })
        log(logPath, res.written ? 'persona-entry-written' : 'persona-entry-skipped', {
          target: res.target, reason: res.reason,
        })
      }
    }
  } catch (err) {
    log(logPath, 'error', { where: 'persona-entry', message: String(err?.message ?? err) })
  }

  // ── 2. 三个子系统各自 inject：缺哪个服务就少挂哪个，互不拖累 ────
  // ⚠️ cordis 的服务是"注入式"的：不声明 inject 就访问 ctx.xxx，
  //    代理的 get trap 会抛 `cannot get property "xxx" without inject`
  //    （cordis/lib/index.js:1257）—— 这不是 undefined，`?.` 拦不住。

  const phaseModel = readPhaseModel(config)
  if (phaseModel) {
    log(logPath, 'phase-model-custom', phaseModel)
    mountPhaseModelOverride(ctx, logPath, phaseModel, cfg.assistantName)
  }

  // ── 0.9 把「选中的那个人格」注入 system prompt ─────────────────
  // 只改 dataRoot 是不够的：模型看到的身份还来自工作区根的 AGENTS.md。
  // 这一段让"选谁就是谁"在下一次请求就成立，不用重启、不用改 AGENTS.md。
  ctx.inject(['systemPrompt'], (scope) => {
    try {
      mountPersonaPrompt(scope, paths, persona, logPath, log)
    } catch (err) {
      log(logPath, 'error', { where: 'persona-prompt', message: String(err?.message ?? err) })
    }
  })

  if (unwrap(cfg.proactive?.enabled, true) !== false) {
    // DSH home / profile patch 的**可靠来源**（2026-11-18 第三次踩）：
    // `process.env.DSH_HOME` 在 Electron 的 renderer 进程里**是空的**，
    // 插件进程拿不到 ⇒ 靠环境变量定位 DSH home 的代码全部失效。
    // ⇒ 从 `ctx.get('profileContext')` 拿（带 home / dir / patchPath）。
    const profileCtx = profileContextOf(ctx)

    // ── 诊断：凭证指纹（2026-11-18）──────────────────────────
    //
    // 症状：插件进程里发消息报 "Invalid access token"，
    // 但**同样的代码在探针进程里成功** ⇒ 差异在凭证值。
    // ⇒ 打指纹（SHA256 前 8 位），跟探针进程的值对一下就知道是不是同一个 secret。
    //
    // ⚠️ 不打明文，只打指纹。
    try {
      const fp = (s) => (s ? createHash('sha256').update(String(s)).digest('hex').slice(0, 8) : '(空)')
      const envSecret = process.env.FEISHU_APP_SECRET ?? ''
      const fileSecret = readAppSecret(profileCtx?.home ?? '') ?? ''
      log(logPath, 'credential-fingerprint', {
        envSecretFp: fp(envSecret),
        envSecretLen: String(envSecret).length,
        fileSecretFp: fp(fileSecret),
        fileSecretLen: String(fileSecret).length,
        appId: unwrap(cfg.proactive?.feishu?.appId, '') || feishuAppIdOf(config, profileCtx),
      })
    } catch (err) {
      log(logPath, 'error', { where: 'cred-fingerprint', message: String(err?.message ?? err) })
    }

    ctx.inject(['agents', 'llm'], (scope) => {
      try {
        mountProactive(scope, {
          ...cfg.proactive,
          // JitRL 开关**现读**（.volatile() ⇒ 设置页点一下就行，不用重启）
          jitrl: {
            ...(unwrap(config.proactive?.jitrl, {}) ?? {}),
            enabled: unwrap(config.jitrlEnabled, true) === true,
          },
          getJitrlEnabled: () => unwrap(config.jitrlEnabled, true) === true,
          // 模型路由**现读**：设置页改了要立刻生效，不再用挂载时的快照
          getModel: () => readModelRef(config.proactive?.model),
          getFallbackModels: () => readFallbackModels(config.proactive?.fallbackModels),
          // 暂停开关**现读**（.volatile() ⇒ 设置页改完不用重启插件）
          getPaused: () => unwrap(config.proactive?.paused, false) === true,
          // 飞书直发（2026-11-18）：appId 没配就**从飞书插件那继承**——
          // 同一个飞书应用、同一个机器人，没必要让用户填两遍。
          feishu: {
            ...(unwrap(config.proactive?.feishu, {}) ?? {}),
            // profileContext 提供的路径（最可靠）
            ...(profileCtx ? {
              dshHome: profileCtx.home,
              profilePatch: profileCtx.patchPath,
              profileDir: profileCtx.dir,
            } : {}),
            // appId 没配就**从飞书插件那继承**——同一个飞书应用、同一个机器人，
            // 没必要让用户填两遍。
            appId: unwrap(config.proactive?.feishu?.appId, '') || feishuAppIdOf(config, profileCtx),
          },        }, paths)
      } catch (err) {
        log(logPath, 'error', { where: 'proactive', message: String(err?.message ?? err) })
      }
    })
  }

  if (unwrap(cfg.snapshot?.enabled, true) !== false) {
    ctx.inject(['agents', 'llm', 'systemPrompt'], (scope) => {
      try {
        mountSnapshot(scope, {
          ...cfg.snapshot,
          getRecallCredit: () => unwrap(config.jitrlEnabled, true) === true
            && unwrap(config.memory?.recallCredit, true) !== false,
          getModel: () => readModelRef(config.snapshot?.model),
          getFallbackModels: () => readFallbackModels(config.snapshot?.fallbackModels),
        }, paths)
      } catch (err) {
        log(logPath, 'error', { where: 'snapshot', message: String(err?.message ?? err) })
      }
    })
  }

  // ── SQLite 事实记忆（v1.2.0 · 模块化分层）─────────────────────
  //
  // 挂载即自动建库 + 迁移（openMemoryStore → schema.migrate）。**非致命**：失败只记日志，
  // 不影响 wiki/住相/搭讪。句柄存进模块级 holder。
  //
  // 召回是**独立通道**（recall_memory/memory_get 工具，按需服务主对话），**不进住相**
  //（住相=人格映射，非记忆检索，2026-11-22 澄清）。
  //
  // 标志文件 `state/fact-memory.enabled`：ingest 抽取段据此判断要不要写库。
  const factFlag = join(paths.state, 'fact-memory.enabled')
  if (unwrap(cfg.factMemory?.enabled, true) !== false) {
    try {
      const store = openMemoryStore(paths.memoryDb)
      setFactMemoryStore(store)
      try { writeFileSync(factFlag, new Date().toISOString(), 'utf8') } catch { /* ignore */ }
      log(logPath, 'fact-memory-opened', { db: paths.memoryDb, count: store.count(), schema: 2 })
      // 按需召回工具 + 引导段（独立于住相）。inject 失败不影响存储本身。
      try {
        ctx.inject(['tools', 'systemPrompt'], (scope) => {
          mountFactMemoryTools(scope, getFactMemoryStore)
        })
      } catch (err) {
        log(logPath, 'error', { where: 'fact-memory-tools', message: String(err?.message ?? err) })
      }
      // 设置页浏览视图：与人格清单同套路——Host 写工作区根，client 经
      // remote.workspaceFiles.read 读回（浏览器读不到文件系统）。
      // ingest 在子进程写库，Host 每 10 分钟刷新一次视图，设置页不至于太陈旧。
      const factTargetCwd = String(unwrap(cfg.memory?.targetCwd, '') ?? '').trim()
      const writeFactView = () => {
        if (!factTargetCwd) return
        try {
          writeFileSync(join(factTargetCwd, '.doubao-facts.json'), JSON.stringify(buildFactView(store), null, 2), 'utf8')
        } catch (err) {
          log(logPath, 'error', { where: 'fact-view', message: String(err?.message ?? err) })
        }
      }
      writeFactView()
      const viewTimer = setInterval(writeFactView, 600000)
      viewTimer.unref?.()
      ctx.effect(() => {
        clearInterval(viewTimer)
        setFactMemoryStore(null)
        try { store.close() } catch { /* ignore */ }
      }, 'doubao-fact-memory')
    } catch (err) {
      log(logPath, 'error', { where: 'fact-memory', message: String(err?.message ?? err) })
    }
  } else {
    setFactMemoryStore(null)
    try { if (existsSync(factFlag)) rmSync(factFlag) } catch { /* ignore */ }
  }

  // ── Phase 服务（2026-11-18）──────────────────────────────────
  //
  // 用户两次质疑：
  // > "自动化任务 需要审批就很怪，需要开启会话运行也很怪，有没有别的静默运行办法"
  // > "在 headless 基础上再想方案。静默运行的同时还需要可审计。用后端服务怎么样"
  //
  // ⇒ 插件自己带调度器，跑在 `ctx.jobs`（DSH 原生后台任务）里：
  //    不开会话、不弹审批、有 Jobs 面板可看、有 phase-runs.json 可查。
  // ⇒ 详见 lib/phases/service.js
  if (unwrap(cfg.phases?.enabled, false) === true) {
    // ⚠️ 不 inject `jobs`（2026-11-18 实测：插件的 host scope 没有 job controller
    //    ⇒ ctx.jobs.start() 抛 "background jobs unavailable"）。
    //    ⇒ 插件自己跑（见 lib/phases/service.js 的注释）。
    try {
      const dispose = mountPhaseService(ctx, {
        ...(cfg.phases ?? {}),
        // ⚠️ 称呼必须带进去（2026-11-18 踩）：
        //    phase 标题是模板 `{ASSISTANT}·Daily Ingest`，
        //    不带 assistantName ⇒ 展开成"助手·Daily Ingest"（变成了别人）
        userName: persona.userName,
        assistantName: persona.assistantName,
        statePath: join(paths.state),
        dshHome: profileContextOf(ctx)?.home ?? process.env.DSH_HOME ?? '',
      }, paths, logPath)
      ctx.effect(() => dispose, 'doubao-phase-service')
    } catch (err) {
      log(logPath, 'error', { where: 'phase-service', message: String(err?.message ?? err) })
    }
  }

  if (unwrap(cfg.memory?.enabled, true) !== false) {
    // ⚠️ **phases.enabled ⇒ 不再注册 DSH schedule**（2026-11-18）
    //
    // 两条路都能触发同一批 phase，同时开会跑**两遍**（浪费 token + 重复写文件）。
    // ⇒ 开了 phase 服务（headless，静默）就关掉 schedule（会话版）。
    //
    // 但**清理钩子要留着**：把之前注册的 4 个 schedule 删掉，
    // 否则旧的还会继续开新会话。
    const usePhaseService = unwrap(cfg.phases?.enabled, false) === true
    // 称呼从顶层带下来（memory.* 里的写法也认，见上面的归一）
    const memoryCfg = {
      ...(cfg.memory ?? {}),
      userName: persona.userName,
      assistantName: persona.assistantName,
      phaseModel,
    }
    ctx.inject(['schedule', 'agents'], (scope) => {
      // 每次依赖就绪/重注入都算"插件还活着" ⇒ 取消可能已排队的卸载清理
      disarmPhaseCleanup(logPath)

      // ── phase 会话静默（2026-11-14 加）───────────────────────
      // 四个 phase 每次触发都开新会话（target='new'），跑完就归档，
      // 不在用户的会话列表里冒泡。详见 lib/phase-quiet.js。
      try {
        mountPhaseQuiet(scope, paths, logPath)
      } catch (err) {
        log(logPath, 'error', { where: 'phase-quiet', message: String(err?.message ?? err) })
      }

      // ── 卸载收尾 ──────────────────────────────────────────────
      // 真正卸载/停用后，把注册的四个 phase 一起删掉（否则任务留着空跑）。
      // 用延迟 arm 区分"重载"（会重新 apply ⇒ 被上面的 disarm 取消）、
      // "卸载"（30 秒后按 binding 删）和"进程退出"（定时器消失 ⇒ 任务保留）。
      // ⚠️ schedule 服务引用必须现在拿：fiber dispose 后再访问 scope.schedule 会抛。
      try {
        let schedRef = null
        try { schedRef = scope.schedule } catch { /* 服务未就绪 ⇒ cleanup 会跳过 */ }
        scope.effect(() => {
          return () => { armPhaseCleanup(schedRef, paths, logPath) }
        }, 'doubao-phase-cleanup')
      } catch (err) {
        log(logPath, 'error', { where: 'cleanup-hook', message: String(err?.message ?? err) })
      }

      // settled = 首次挂载已经全部注册好 ⇒ 不需要再补。
      // 2026-11-11：targetMode 默认改成 `new`（每次全新 session）之后，
      // 建 task 不再依赖"已有会话"，所以首次挂载通常就成——补注册只在
      // 真的 deferred（Host 还建不了 session）时才需要。
      let settled = false
      if (usePhaseService) {
        // ★ phase 服务接管调度 ⇒ **不注册 schedule**，并把旧的清掉
        log(logPath, 'phase-mode-active', { note: 'schedule 注册已跳过，phase 服务接管' })
        let schedRef = null
        try { schedRef = scope.schedule } catch { /* 服务未就绪 */ }
        // 立即清理一次（不等 30 秒的卸载延迟）
        void (async () => {
          try {
            const { cleanupPhaseTasks } = await import('./memory-system.js')
            const r = await cleanupPhaseTasks(schedRef, paths, logPath)
            log(logPath, 'schedule-cleanup-on-switch', r)
          } catch (err) {
            log(logPath, 'error', { where: 'schedule-cleanup-switch', message: String(err?.message ?? err) })
          }
        })()
        settled = true
      } else {
        void (async () => {
          try {
            const res = await mountMemorySystem(scope, memoryCfg, paths)
            if (res && res.deferred === 0) settled = true
            log(logPath, 'memory-system-mounted', res ?? null)
          } catch (err) {
            log(logPath, 'error', { where: 'memory-system', message: String(err?.message ?? err) })
          }
        })()
      }

      // 空白安装时 boot 早期 Host 还没有会话 ⇒ phase 可能注册不了。
      // 等第一个顶层会话出现时**再补一次**（幂等，不会重复）。
      let retrying = false
      scope.on('agent/created', async (payload) => {
        try {
          if (settled) return
          const agent = payload?.agent
          if (!agent) return
          const roots = scope.agents?.roots?.() ?? []
          if (!roots.includes(agent)) return          // 只关心顶层会话
          if (retrying) return
          retrying = true
          setTimeout(async () => {
            try {
              const res = await mountMemorySystem(scope, memoryCfg, paths)
              if (res && res.deferred === 0) settled = true
            } catch (err) {
              log(logPath, 'error', { where: 'memory-system-retry', message: String(err?.message ?? err) })
            } finally {
              retrying = false
            }
          }, 3000)
        } catch (err) {
          log(logPath, 'error', { where: 'agent-created-hook', message: String(err?.message ?? err) })
        }
      })
    })
  } else {
    // memory 子系统被关掉 = 四个 phase 也该停（否则任务还在，空跑协议）。
    // 同样延迟清理；如果之后又打开，新挂载会 disarm 取消。
    try {
      ctx.inject(['schedule'], (scope) => {
        let sched = null
        try { sched = scope.schedule } catch { /* 服务没就绪 ⇒ cleanup 自己会跳过 */ }
        armPhaseCleanup(sched, paths, logPath)
      })
    } catch (err) {
      log(logPath, 'error', { where: 'cleanup-memory-disabled', message: String(err?.message ?? err) })
    }
  }

  // ── 自检：设置页能不能拿到我们的表单 ──────────────────────────
  // ⚠️ 2026-11-14 血泪：第一版探针写 `typeof schema === 'object'`，
  //    但 **schemastery schema 是函数**，于是恒为 false —— 假阴性，
  //    让我误以为 Host 没拿到 Config，白排了两次重启。
  //    正确判断与 DSH 自己一致：`'toJSON' in schema`（dsh-settings/index.js:539）。
  try {
    const fiber = ctx.fiber
    const runtime = fiber?.runtime
    const schema = runtime?.Config
    const looksLikeSchema = schemasteryLike(schema)
    const volatileCount = looksLikeSchema
      ? (() => {
          try { return JSON.stringify(schema.toJSON()).split('"volatile":true').length - 1 }
          catch { return -1 }
        })()
      : -1
    log(logPath, 'settings-selfcheck', {
      entryId: fiber?.entry?.options?.id ?? null,
      fiberState: fiber?.state ?? null,
      hostSawConfig: looksLikeSchema,
      schemaType: typeof schema,
      volatileFieldCount: volatileCount,
    })
  } catch (err) {
    log(logPath, 'error', { where: 'settings-selfcheck', message: String(err?.message ?? err) })
  }

  // ── 自检：客户端模块有没有被 dsh-client-modules 收下 ───────────
  // 设置页要出现，Host 侧的 Config 只是第一步；浏览器还要真的拿到
  // `lib/client.js` 并执行它的 apply（注册两个插槽）。
  // `clientModules.graph()` 的 entries 就是"浏览器会加载哪些包"的权威清单。
  //
  // ⚠️ 用 `ctx.get(name, false)` 而不是 `ctx.inject([...])`：
  //    - inject 会让本插件**等**那个服务，非 web profile 下不必要地拖住自己；
  //    - `ctx.get` 的 strict 默认是 true（要求目标 fiber 已 active），
  //      boot 早期服务还没起来 ⇒ 传 false 才能读到。
  //    延迟 3 秒是等 client-modules 完成首轮 compose。
  try {
    const timer = setTimeout(() => {
      try {
        const cm = ctx.get('clientModules', false)
        const graph = cm?.graph?.()
        const ids = (graph?.entries ?? []).map((e) => e?.id ?? null).filter(Boolean)
        log(logPath, 'client-module-selfcheck', {
          servicePresent: Boolean(cm),
          registered: ids.includes('dsh-doubao-memory'),
          count: ids.length,
          sample: ids.slice(0, 20),
        })
      } catch (err) {
        log(logPath, 'error', { where: 'client-module-selfcheck', message: String(err?.message ?? err) })
      }
    }, 3000)
    timer?.unref?.()
  } catch (err) {
    log(logPath, 'error', { where: 'client-module-selfcheck-schedule', message: String(err?.message ?? err) })
  }

  log(logPath, 'mount', {
    root: paths.root,
    dataRoot: paths.dataRoot,
    user: persona.userName,
    assistant: persona.assistantName,
    personaKind,
    personaProtected: isForeign,
    personaConfigured: hasPersonaContent(persona),
    phaseModel: phaseModel ?? 'follow',
    proactive: unwrap(cfg.proactive?.enabled, true) !== false,
    snapshot: unwrap(cfg.snapshot?.enabled, true) !== false,
    memory: unwrap(cfg.memory?.enabled, true) !== false,
    factMemory: unwrap(cfg.factMemory?.enabled, true) !== false,
  })
}

/**
 * 给四个 phase 的会话换模型。
 *
 * ⚠️ 为什么不做成"创建时指定"：DSH 的 `ScheduleSessionCreateSpec` 只有
 *    `cwd` / `agentPreset`，**没有 model 字段**。所以在会话创建后替它选模型：
 *    `agent.model.select({ provider, model })` 作用于"下一次还没开始准备的 step"。
 *
 * 识别方式：schedule 创建的会话标题取自任务标题（我们的任务是「助手·xxx」），
 * 所以按标题前缀认。识别不到就什么都不做（跟随主模型），并留日志便于排查。
 */
function mountPhaseModelOverride(ctx, logPath, route, assistantName = '助手') {
  const PREFIX = `${assistantName}·`
  try {
    ctx.on('agent/created', (payload) => {
      const agent = payload?.agent
      if (!agent) return
      let title = ''
      try {
        title = String(agent.session?.header?.title ?? '')
      } catch { title = '' }
      if (!title.startsWith(PREFIX)) return
      const select = agent.model?.select
      if (typeof select !== 'function') {
        log(logPath, 'phase-model-skip', { reason: 'agent.model.select unavailable', title })
        return
      }
      try {
        select.call(agent.model, route)
        log(logPath, 'phase-model-selected', { title, ...route })
      } catch (err) {
        log(logPath, 'error', { where: 'phase-model-select', title, message: String(err?.message ?? err) })
      }
    })
  } catch (err) {
    log(logPath, 'error', { where: 'phase-model-hook', message: String(err?.message ?? err) })
  }
}

export { resolvePaths }
export { listPersonas, classifyPersonaDir } from './persona-registry.js'

// ⚠️ 只导出命名形式 `apply` + `Config`，**不要**再加 `export default`。
//    DSH 文档（dsh-doc/references/host-plugin.md）明确："do not mix them"。
//    2026-11-14 实测：同时给 default 和 apply 时插件能挂载，但 Host 拿不到
//    `Config` ⇒ 设置命名空间不出现 ⇒ 设置页没有表单（且没有任何报错）。
//    参考实现 dsh-feishu-plugin 也是只导出 { Config, apply, inject, name }。
