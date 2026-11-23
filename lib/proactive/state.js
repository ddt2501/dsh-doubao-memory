/**
 * 主动搭讪的状态读写 —— **双轨**：domain 优先，文件兜底。
 *
 * ## 为什么双轨而不是一步切到 domain
 *
 * DSH 生态里确实有正规的状态存储（`ctx.storageDomain`，见 lib/proactive/storage.js）：
 * 原子写、schema 校验、并发写串行化、写前落盘、坏记录留证据——
 * 全都内建，比自己手搓 JSON 强得多。
 *
 * 但**一次切不过去**，两个原因：
 *
 * 1. **DSH 还没重启** ⇒ `storageDomain` 服务在当前进程里还没挂上；
 *    一步切会让主动搭讪在重启前完全瘫痪。
 * 2. **人格数据要随包走**（AGENTS.md §5「那里的人格是空置的」）：
 *    domain 的数据落在 `$DSH_HOME/storages/`，**不随插件包走**；
 *    而 `proactive.json` 在人格目录里，跟着包走。
 *
 * 所以：**domain 是运行时状态的权威，文件是可迁移的镜像。**
 * domain 可用就写 domain（同时更新镜像），不可用就退回文件——
 * 两边读到的内容一样，谁活着用谁。
 *
 * ## 文件轨的加固（2026-11-17 两次事故留下的）
 *
 * 1. **BOM**：我用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 改状态文件，
 *    它写 BOM ⇒ `JSON.parse` 抛错 ⇒ 旧代码吞掉异常、静默回落默认状态
 *    ⇒ **`paused:true` 被清掉**，插件又开口了。
 *    现在：读入时**剥掉 BOM**；解析失败 ⇒ **保守判定 paused**（fail-safe）。
 * 2. **原子写**：直接 `writeFileSync` 是 truncate-then-write，
 *    写到一半被打断 ⇒ 半截 JSON ⇒ 状态丢失。
 *    现在：临时文件 + rename。
 * 3. **不写 BOM**：Node 的 `writeFileSync(path, str, 'utf8')` 默认不写 BOM，
 *    但 PowerShell 的 `Set-Content -Encoding UTF8`（5.1）会写——
 *    同一个文件可能被两边改 ⇒ 写的时候必须自己保证干净。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { proactiveStateSchema, themeStateSchema } from './storage.js'

export const DEFAULT_STATE = {
  energy: null,
  energyDate: null,
  todayCount: 0,
  lastUserMessageAt: null,
  unansweredCount: 0,
  paused: false,
  quietHours: { start: '23:00', end: '08:00' },
  maxPerDay: null,          // 已废弃（2026-11-18「搭讪不设额度」）
  maxUnanswered: 2,
  minGapMs: 90 * 60_000,
  nextEligibleAt: null,
  lastProactiveAt: null,
  recentProactive: [],
  moodLow: null,
}

/**
 * 读**全部主题状态**（主题演进系统的记忆）。
 *
 * @param {object|null} domain
 * @returns {object} id → 主题状态
 */
export function readThemeStates(domain) {
  if (!domain) return {}
  const table = domain.table('themes')
  const out = {}
  for (const [id, rec] of table.entries()) {
    if (rec) out[id] = rec
  }
  return out
}

/**
 * 写一条主题状态。
 *
 * ## ⚠️ 失败必须**抛出去**，不能吞（2026-11-18 踩坑）
 *
 * 实测：中文 id（"哈罗老婆"）被 domain 的 per-record 后端拒绝：
 * > `dsh-storage-json/lib/index.js:608`
 * > `per-record key '...' is not path-safe (must match /^[a-zA-Z0-9_-]+$/)`
 *
 * 而我当时用 try/catch 吞掉了 ⇒ **记录静默丢失**，
 * 表面看"回填了 2 条"，磁盘上只有 1 个文件。
 * ⇒ 现在抛出去，让调用方能看见。
 *
 * @param {object|null} domain
 * @param {object} theme - 主题状态
 * @returns {Promise<boolean>}
 */
export async function writeThemeState(domain, theme) {
  if (!domain || !theme?.id) return false
  // 写入前自己校验（domain 的 put 不校验，见 writeDomainState 的说明）
  const parsed = themeStateSchema.safeParse(theme)
  if (!parsed.success) {
    throw new Error(`theme 校验失败: ${JSON.stringify(parsed.error.issues.map((i) => `${i.path}: ${i.message}`))}`)
  }
  // ⚠️ key 必须是 ASCII（per-record 后端拿 key 当文件名）
  if (!/^[a-zA-Z0-9_-]+$/.test(theme.id)) {
    throw new Error(`theme id 不是 path-safe: "${theme.id}"（只允许 ASCII 字母数字 _ -）`)
  }
  await domain.table('themes').put(theme.id, theme)
  return true
}

/**
 * 从 domain 句柄读状态。
 *
 * @param {object|null} domain - `ctx.storageDomain.open()` 的返回值
 * @param {string} key - 表里的键
 * @returns {object|null} 读不到返回 null（调用方回落到文件）
 */
export function readDomainState(domain, key) {
  if (!domain) return null
  try {
    const record = domain.table('state').get(key)
    if (!record) return null
    // schema 已校验过，但字段可能比 DEFAULT_STATE 少（老版本存的）⇒ 合并默认值
    return { ...DEFAULT_STATE, ...record }
  } catch {
    return null
  }
}
/**
 * 写状态到 domain。
 *
 * ⚠️ **写之前必须自己校验**（2026-11-17 加）
 *
 * 实测：domain 的 `put()` **不做 schema 校验**——校验只在 `open()` 时发生。
 * 所以一条坏记录写进去当时没事，**下次打开时整个 domain 打不开**
 * （invalid-record）⇒ domain 被一条坏数据**永久砖化**。
 *
 * 而且 `open()` 抛错时我这边会安静回落文件模式 ⇒ 表现为"domain 突然不工作了"，
 * 极难排查。
 *
 * 所以：**写入前先用同一个 zod schema 校验**，不通过就压根不写。
 * （domain 那边还声明了 `invalidRecords: 'backup-and-skip'` 作为第二道保险——
 *   万一真有一���坏记录落盘，下次打开会自动挪走而不是砖化。）
 *
 * @param {object|null} domain
 * @param {string} key
 * @param {object} state
 * @returns {Promise<boolean>} 是否写成功
 */
export async function writeDomainState(domain, key, state) {
  if (!domain) return false
  try {
    // 校验（用**我们自己那份** schema —— KvTable 不暴露 valueSchema，
    // 见 dsh-storage-domain 的 domain.d.ts：只有 get/entries/keys/size/
    // put/delete/deleteMany/update）
    const parsed = proactiveStateSchema.safeParse(state)
    if (!parsed.success) return false   // 不通过就压根不写
    await domain.table('state').put(key, state)
    return true
  } catch {
    return false
  }
}

/**
 * 从文件读状态。
 *
 * **fail-safe**：状态读不出来 ⇒ 判定为 **paused**。
 * 静默回落默认值 = 把用户的"别主动找我"当成不存在（2026-11-17 出过事故）。
 *
 * @param {string} path
 * @returns {object} 状态
 */
export function loadState(path) {
  if (!path || !existsSync(path)) return { ...DEFAULT_STATE }

  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ...DEFAULT_STATE, paused: true }
  }

  // BOM（U+FEFF）不是合法 JSON 前缀 —— 先剥掉。
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)

  try {
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_STATE, ...parsed }
  } catch {
    return { ...DEFAULT_STATE, paused: true }
  }
}

/**
 * 原子写状态到文件（不带 BOM）。
 *
 * @param {string} path
 * @param {object} state
 */
export function saveState(path, state) {
  if (!path) return
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
  }
}
