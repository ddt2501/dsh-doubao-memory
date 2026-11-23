/**
 * 主动搭讪的状态存储 —— 走 DSH 的 domain 存储（`ctx.storageDomain`）。
 *
 * ## 为什么要换掉手写 JSON（2026-11-17）
 *
 * 原实现是插件自己读写 `RUNTIME/state/proactive.json`。今天因为这个吃了两次亏：
 *
 * 1. **BOM**：我用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 改状态文件，
 *    它会写 BOM ⇒ `JSON.parse('\uFEFF{...}')` 直接抛错 ⇒ 旧 `loadState`
 *    吞掉异常、静默回落 `DEFAULT_STATE` ⇒ **`paused:true` 被清掉**，
 *    插件 10:29 又投了一条。同一个 U+FEFF 已经是第二次咬人
 *    （第一次是 MEMORY.md 教训 40，2026-09-01）。
 * 2. **原子写**是自己手搓的（tmp + rename），而 DSH 有一套更完整的：
 *    `writeAtomic()` 带 fsync + 失败回滚 + 跨进程写锁。
 *
 * ## DSH 的正规做法
 *
 * `ctx.storageDomain.open(spec)` → schema 校验的 KV 域：
 *
 * | 能力 | 手写 JSON | domain |
 * |---|---|---|
 * | 原子写 | 自己手搓 | 内建（fsync + rename + 回滚） |
 * | schema 校验 | 无 | 内建（zod，坏记录 `backup-and-skip`） |
 * | 并发写 | 无 | 内建（每域一条写链，`update` 原子读改写） |
 * | 写前落盘 | 无 | 内建（backend 确认持久化后才改内存） |
 * | 坏数据 | 静默回落默认 | **报错 + 留证据**（`.bak.<时间戳>`） |
 * | BOM | 会炸 | 后端自己写文件，永远无 BOM |
 * | 变更通知 | 无 | `domain/changed` 事件 |
 *
 * ## 分工（重要）
 *
 * domain 只装**小而热**的运行期状态（暂停、劲头、计数、去重历史）。
 * **大而冷的记忆仍走 markdown**（VAULT / RAW / IDENTITY）——
 * 那是用户定的人格路线（AGENTS.md §7「自建 markdown 路线即定」），
 * 而且要随包带走；domain 的数据落在 `$DSH_HOME/storages/`，不随包走。
 *
 * @see https://github.com/deepseek-harness/deepseek-harness — @deepseek-ai/dsh-storage-domain
 */

import { z } from 'zod'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 单条主动消息的记录（recentProactive 的一项） */
const proactiveEntrySchema = z.object({
  at: z.string(),
  motive: z.string(),
  topic: z.string(),
})

/**
 * 主动搭讪的完整状态。
 *
 * ⚠️ **每个字段都要有 default** —— 因为 domain 打开时用 schema 校验**每一条已存记录**，
 *    字段缺失会抛 `invalid-record` 并让整个 domain 打不开。
 *    宁可宽松，也不要因为加了个字段就炸掉整个存储。
 */
export const proactiveStateSchema = z.object({
  /** 今天的"想说话的劲头"（跨日重抽） */
  energy: z.number().default(0),
  /** 劲头是哪天抽的 */
  energyDate: z.string().nullable().default(null),
  /** 今天已经主动说了几次 */
  todayCount: z.number().default(0),
  /** 用户最后一次发言的时间（ISO） */
  lastUserMessageAt: z.string().nullable().default(null),
  /** 主动说了几次没被回应 */
  unansweredCount: z.number().default(0),
  /** 暂停开关——"别主动找我" */
  paused: z.boolean().default(false),
  /**
   * 暂停的原因（2026-11-18 加）。
   *
   * - `null` / 缺省 ⇒ **手动暂停**（用户亲口说的"别主动找我"）⇒ 绝不自动解除
   * - `'unanswered-cap'` ⇒ **自动暂停**（连着几次没人理）⇒ 用户一回话就解除
   *
   * ⚠️ 没有这个字段就分不清这两种暂停 ⇒ 手动暂停也永远解不开。
   */
  pausedReason: z.string().nullable().default(null),
  /** 免打扰时段 */
  quietHours: z.object({
    start: z.string().default('23:00'),
    end: z.string().default('08:00'),
  }).default({ start: '23:00', end: '08:00' }),
  /**
   * 一天最多主动几次 —— **已废弃**（2026-11-18 用户定「搭讪不设额度」）。
   *
   * 字段保留只为**兼容老记录**（老记录里是数字 2）。
   * 判定逻辑**不再读它** ⇒ 无论老记录是新记录，都不再有额度闸门。
   */
  maxPerDay: z.number().nullable().default(null),
  /** 连续几次未回应就暂停 */
  maxUnanswered: z.number().default(2),
  /** 两条主动消息之间的最小间隔（毫秒） */
  minGapMs: z.number().default(5_400_000),
  /** 下次可以开口的时间（ISO） */
  nextEligibleAt: z.string().nullable().default(null),
  /** 上次主动开口的时间（ISO） */
  lastProactiveAt: z.string().nullable().default(null),
  /** 最近说过什么（去重用） */
  recentProactive: z.array(proactiveEntrySchema).default([]),
  /** 用户情绪是否低落（语义判定，不是关键词匹配） */
  moodLow: z.boolean().nullable().default(null),
})

/**
 * domain 声明——**纯数据**。
 *
 * ## 为什么不 import `defineDomain` / `domainTable`
 *
 * 那两个函数只是**校验器 + 数据构造器**——源码大致是：
 *
 * ```js
 * function domainTable(schema) { return { valueSchema: schema }; }
 * function defineDomain(spec) {
 *   // 校验名字/版本/表名/全局 schema 不接受 null
 *   return spec;
 * }
 * ```
 *
 * `ctx.storageDomain.open(spec)` 只读 `spec.name / spec.version / spec.tables /
 * spec.layout / spec.global / spec.compatibleVersions`——
 * **不需要那个包的运行时**。
 *
 * 而 import 它有实际代价：
 * - 插件是**链接安装**（`link:`），裸导入解析不到 DSH 安装目录里那份；
 *   要 vendor 就得复制 4.4 MB 进插件包。
 * - 它还带 peerDependency（`@deepseek-ai/dsh-storage`、`cordis`），
 *   vendor 进来反而制造版本不一致。
 *
 * 所以这里**手写等价 spec**（与 `dsh-storage-domain` 的 spec.d.ts 逐字段对齐），
 * 由 DSH 自己在 `open()` 时做真正的校验。
 * ⚠️ 字段名/结构必须与官方 spec 一致，否则 `open()` 会拒绝。
 */

/** domain 表名（必须匹配 `UNIT_NAME_RE`：小写字母数字下划线） */
const TABLE_NAME = 'state'

/** 主题表的名字（主题演进系统的状态） */
const THEME_TABLE = 'themes'

/**
 * 主题表 —— 主题演进系统的状态存储（2026-11-18）。
 *
 * 每条主题记它"说到第几次了、用过哪些话头、属于哪条轴"，
 * ⇒ 下次选主题时可以避开说烂的、推进没说完的。
 *
 * ⚠️ 布局必须是 per-record（理由见上面的 invalidRecords 说明）。
 */
export const themeStateSchema = z.object({
  /** 主题 id（= 种子 id） */
  id: z.string(),
  /** 种子原话 */
  seed: z.string(),
  /** 出处（wiki:xx / daily:xx） */
  source: z.string().default(''),
  /** 轴：relation（关于他这个人）| current（他最近的样子） */
  axis: z.string().default('relation'),
  /** 阶段：fresh | introduced | deepen | cooling */
  stage: z.string().default('introduced'),
  /** 说过几次 */
  saidTimes: z.number().default(0),
  /** 上次说的时候（ISO） */
  lastSaidAt: z.string().nullable().default(null),
  /** 已经用过的具体话头（同一个话头不消费两次） */
  usedSeeds: z.array(z.string()).default([]),
  /** 首次创建（ISO） */
  createdAt: z.string().nullable().default(null),
})

export const proactiveDomain = {
  name: 'doubao_proactive',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    [TABLE_NAME]: { valueSchema: proactiveStateSchema },
    [THEME_TABLE]: { valueSchema: themeStateSchema },
  },
}

/** 状态在表里的键（只有一个） */
export const STATE_KEY = 'current'

/**
 * 打开 domain。调用方负责在插件卸载时 `close()`。
 *
 * @param {object} ctx - 带 `storageDomain` 服务的 scope
 * @param {string} [logPath] - 诊断日志路径
 * @returns {Promise<object|null>} domain 句柄；服务不可用时返回 null
 */
export async function openProactiveDomain(ctx, logPath) {
  // ⚠️ **不能用 `ctx.storageDomain`**：Cordis 的 scope 是 Proxy，
  //    直接取一个没 inject 进来的服务会**抛异常**（不是返回 undefined）：
  //    "cannot get property \"storageDomain\" without inject"
  //    正确姿势是 `ctx.get(name, false)` —— 第二个参数 false = "没有也不报错"。
  //    （这个用法本仓库已有先例：lib/phase-detect.js 取 sessionTitle 就是这么写的。）
  let facility
  try {
    facility = ctx?.get?.('storageDomain', false)
  } catch (err) {
    logTo(logPath, 'domain-service-absent', { fallback: 'file', message: String(err?.message ?? err) })
    return null
  }
  if (!facility || typeof facility.open !== 'function') {
    logTo(logPath, 'domain-service-absent', { fallback: 'file' })
    return null
  }

  // ── 打开，带重试 + 接管（2026-11-17 加）──────────────────────
  //
  // **为什么需要"接管"**：
  //
  // 热重载时 unmount → mount 只隔 60 毫秒，而 domain 的 close 是**异步**的
  // （写链要 drain）。更糟的是：**旧实例可能压根没有 close 的代码**
  // （我 13:37 才补上 closeDomain，而泄漏是 12:43 那次开的）⇒
  // 那个 domain 句柄**永久泄漏**，谁都关不掉 ⇒
  // 之后每次 open() 都撞 "domain 'doubao_proactive' is already open"。
  //
  // ⭐ **正解**：facility 有 `get(name)`（dsh-storage-domain/lib/index.js:431），
  //   可以直接拿到**已经打开**的 domain。撞 already-open 时不是放弃，
  //   而是**接管那个句柄**继续用。
  //
  //   这样就不依赖"旧实例有没有正确关闭"——
  //   热重载多少次都不会泄漏、也不会永远回落文件模式。
  //
  // ⚠️ 但接管有代价：旧实例的 disposer 之后还会调 `close()`，
  //   把我们正在用的 domain 关掉。
  //   ⇒ 接管时必须**标记"我接管了"**，并让旧实例不再关它。
  //   做法：新实例接管后不再持有"需要关闭"的语义；
  //   而旧实例的 close 是幂等的且**共享同一个 teardown**
  //   （`this.disposal ??= this.runClose()`）⇒ 旧实例关掉它就是真关掉。
  //
  //   最稳的做法：**接管后立刻重新 open 一个新的**——
  //   先 close 旧的（异步、幂等），等它释放名字，再 open 新的。
  //   这样 domain 句柄始终归当前实例所有，生命周期干净。
  const maxAttempts = 4
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await facility.open(proactiveDomain)
    } catch (err) {
      const msg = String(err?.message ?? err)
      const alreadyOpen = /already open/i.test(msg)
      if (!alreadyOpen) {
        logTo(logPath, 'domain-open-failed', { message: msg, attempts: attempt })
        return null
      }

      // 撞 already-open ⇒ 找出那个泄漏的句柄，关掉它，等名字释放，再开新的
      const leaked = typeof facility.get === 'function' ? facility.get(proactiveDomain.name) : null
      if (leaked) {
        try {
          await leaked.close()          // 幂等；关完名字就释放了
          logTo(logPath, 'domain-leak-reclaimed', { attempt })
        } catch (closeErr) {
          logTo(logPath, 'domain-leak-close-failed', {
            message: String(closeErr?.message ?? closeErr), attempt,
          })
        }
      }
      // 退避，给 close 的写链 drain 留时间
      await sleep(150 * attempt)
    }
  }
  logTo(logPath, 'domain-open-failed', { message: 'already-open after retries', attempts: maxAttempts })
  return null
}

/** 等待（毫秒） */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 极简日志（避免为了打日志再引一层依赖） */
function logTo(logPath, event, data) {
  if (!logPath) return
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8')
  } catch { /* 日志写失败不影响主流程 */ }
}
