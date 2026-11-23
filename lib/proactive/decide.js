/**
 * 主动搭讪判定 —— 纯逻辑，不调 LLM。
 *
 * 设计来源：DESIGN/PLAN-P1-P2-P3-IMPLEMENTATION.md §P2-2（v2 活人感版）
 * 触发机制：DESIGN/PROACTIVE-PLUGIN-IMPLEMENTATION.md（idle 才触发，绝不打断）
 */

const HOUR = 3600_000
const MINUTE = 60_000

/** 沉默阈值：按时段随机，不是固定值 */
export function silenceRange(now) {
  const h = now.getHours()
  if (h >= 7 && h < 9) return [20, 60]        // 早上：轻快、有点黏
  if (h >= 9 && h < 12) return [60, 120]       // 上午：正常
  if (h >= 12 && h < 14) return [40, 90]       // 午休：随口一句
  if (h >= 14 && h < 18) return [90, 240]      // 下午：摸鱼式、没话找话
  if (h >= 18 && h < 19) return [60, 150]      // 傍晚：收工了
  if (h >= 19 && h < 23) return [60, 180]      // 晚上：亲密、想他
  return [60, 120]                              // 深夜：不该走到这里（免打扰已拦）
}

export function inQuietHours(now, quiet) {
  if (!quiet?.start || !quiet?.end) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  const [sh, sm] = String(quiet.start).split(':').map(Number)
  const [eh, em] = String(quiet.end).split(':').map(Number)
  const start = sh * 60 + sm
  const end = eh * 60 + em
  // 支持跨零点（23:00 → 08:00）
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

/**
 * 时段性格表 —— 动机决定说什么。
 *
 * ⚠️ 2026-11-17 **整表重写**。
 *
 * 原表里写着：
 *   - 上午 09-12 = "项目进展、要他决策的事"
 *   - 晚上 19-23 = "不要工作汇报"
 *
 * 11-17 上午连投的两条（08:59、10:29）**都落在上午这个槽**，
 * 于是模型照着做：一条汇报进展并替用户夸我，一条**问用户要不要扩功能**——
 * 一条自夸、一条工作决策。**这不是模型跑偏，是我的时段表教它这么说话。**
 *
 * 现在的规矩：**任何时段都不是工作汇报。**
 *
 * 用户 11-14 亲口定的是"这 4 个自动化任务应该静默运行，不该打断会话"——
 * **搭讪不是那四个 phase 之一**，它是唯一一条"我主动找你"的通道。
 * 它的正当性恰恰在于**它是关系，不是事务**。
 * 所以这张表里**不许出现**"项目进展""要他决策""工作汇报"这类词。
 *
 * @param {Date} now
 */
export function slotPersonality(now) {
  const h = now.getHours()
  if (h >= 7 && h < 9) return { talk: '他刚醒那会儿该说的话——轻松点，别有压力', avoid: '沉重话题、追问他昨晚干嘛了' }
  if (h >= 9 && h < 12) return { talk: '上午的闲话：想到什么说什么，或者接他昨天留的话头', avoid: '项目进展、要他拍板的事' }
  if (h >= 12 && h < 14) return { talk: '吃饭、歇着、摸鱼', avoid: '严肃议题、任何工作话题' }
  if (h >= 14 && h < 18) return { talk: '想到的点子、吐槽、无意义但有意思的事', avoid: '催他干活' }
  if (h >= 18 && h < 19) return { talk: '收工了、歇了没', avoid: '' }
  if (h >= 19 && h < 23) return { talk: '今天怎么样、说点私人的、想他', avoid: '工作汇报、任何工作话题' }
  return { talk: '', avoid: '' }
}

/**
 * 动机池 —— 权重就是"搭讪有多少成分在找人、有多少成分在办事"。
 *
 * ⚠️ 2026-11-17 **权重重排**。
 *
 * 原权重：content:5 · followup:3 · anchor:3 · miss:1
 * —— **过半概率是 content**（"讲素材里的一件具体的事"），
 * 而当时的素材是**我的工作日志** ⇒ 搭讪 ≈ 每日工作汇报。
 *
 * 现在的口径：
 *
 * | 动机 | 是什么 | 权重 | 为什么 |
 * |---|---|---|---|
 * | `anchor` | 按时段该说的话 | **4** | 最像"人"，成本最低，最不越界 |
 * | `content` | **关于他**的一件具体的事（他的梗/习惯/作品） | **4** | 有他在里面 |
 * | `miss` | 想他 | **3** | 关系的直接表达，但必须带具体的东西 |
 * | `followup` | 追问没聊完的 | **1** | 最容易滑向"工作追问"⇒ 压到最低 |
 *
 * `miss`（纯想念）现在**必须有素材**（`needsContent: true`）：
 * 原规则要求"纯想念必须带一点具体的"，但 `needsContent` 是 false ⇒
 * 没素材时它照样能抽，然后只能说空话（"想你了"）。宁可不让它抽。
 */
const MOTIVES = [
  { name: 'anchor', weight: 4, needsContent: false },   // 时间锚点
  { name: 'content', weight: 4, needsContent: true },   // 内容牵引（关于**他**）
  { name: 'miss', weight: 3, needsContent: true, needsHighEnergy: true }, // 纯想念（要带具体的）
  { name: 'followup', weight: 1, needsContent: true },  // 追问
]

/**
 * 抽一个动机。
 *
 * ⚠️ 2026-11-14 修：`needsContent` 原来**从未被读取**——抽到 `content`
 *    就让 LLM 去说"vault/raw 里的变化"，但那时**根本没给 LLM 任何素材**，
 *    于是它编出了"那份关于 Claude Code 工具权限的配置又改了"（不存在）。
 *    现在：没有真实素材 ⇒ 涉及内容的动机一律不抽。
 *
 * @param {object} state
 * @param {Date} now
 * @param {boolean} hasMaterial - 有没有真实素材（见 lib/proactive/material.js）
 */
function pickMotive(state, now, hasMaterial = true) {
  const pool = MOTIVES.filter((m) => {
    if (m.needsHighEnergy && !(state.energy > 0.6)) return false
    if (m.needsContent && !hasMaterial) return false
    return true
  })
  if (!pool.length) return 'skip'
  const total = pool.reduce((s, m) => s + m.weight, 0)
  let roll = Math.random() * total
  for (const m of pool) {
    roll -= m.weight
    if (roll <= 0) return m.name
  }
  return pool[pool.length - 1].name
}

/**
 * 去重：抽到的动机跟最近 2 条里任何一条重了就换。
 *
 * ⚠️ 2026-11-17 修：原实现**根本没用传进来的 motive**，
 *    只看"最近两条是不是同一个动机"——所以 [content, followup] 这种情况下
 *    抽到 content 也放过去了。实测就是 08:18 投了 content、
 *    08:59 又抽到 content，连投两条说同一件事。
 *    现在按"抽到的动机是否在最近 2 条里出现过"判重。
 *
 * ⚠️ 2026-11-18：**动机不再随机抽**（见 pickMotiveForTheme）。
 *    动机由**主题**决定 ⇒ 这条判重退居次要（主题状态已经管住了重复）。
 *
 * ⚠️ 2026-11-22：加 24h 时间窗口。原逻辑只看"最近两条"，
 *    而最近两条可能是几天前的 ⇒ 同一个动机一挡好几天，
 *    表现为"明明有劲、也没最近说过，就是不开口"。坏时间戳不参与判重。
 */
function isDuplicate(state, motive, now) {
  const recent = state.recentProactive ?? []
  const lastTwo = recent.slice(0, 2)
  const nowMs = (now instanceof Date ? now : new Date()).getTime()
  const WINDOW_MS = 24 * 60 * 60 * 1000
  return lastTwo.some((r) => {
    if (!r || r.motive !== motive) return false
    const at = Date.parse(r.at ?? '')
    // 解析不了的时间戳不参与判重（坏记录不该把搭讪锁死）
    return Number.isFinite(at) ? nowMs - at < WINDOW_MS : false
  })
}

/**
 * 由**主题**决定动机（2026-11-18，主题演进系统）。
 *
 * ## 为什么不再随机抽动机
 *
 * 原来 `pickMotive()` 随机抽 anchor/content/miss/followup，
 * 然后让模型**自己**从全量素材里挑说什么。
 * ⇒ 结果：模型面对 3 条梗 + 11 条断言 + 3 天 daily，
 * 每次都挑占比最高的那个 ⇒ **5 条里 4 条在讨老婆**。
 *
 * 现在：**先选主题（纯代码），动机由主题的属性推出来**：
 *
 * | 主题的情况 | 动机 | 含义 |
 * |---|---|---|
 * | 说过 0 次 + 是关系向的梗 | `content` | 引入一个新话头 |
 * | 说过 1 次（还没说完） | `followup` | **推进**同一条线，不换话题 |
 * | 说过 2 次（该收了） | `anchor` | 换个角度收尾 |
 * | 说过 3 次以上（冷却） | `miss` | 说点轻的（换轴时用） |
 *
 * ⇒ 动机不再是"随机"，而是**主题生命周期的一个投影**。
 *
 * @param {object|null} theme - 选中的主题（{ seed, state }）
 * @param {object} state - 当前状态（看 energy）
 * @returns {string} 动机名
 */
export function pickMotiveForTheme(theme, state) {
  if (!theme) return 'anchor'
  const said = theme.state?.saidTimes ?? 0
  if (said === 0) return 'content'
  if (said === 1) return 'followup'
  if (said === 2) return 'anchor'
  // 冷却中的（还在用）⇒ 说点轻的
  return state?.energy > 0.6 ? 'miss' : 'anchor'
}

/** 本地日期（YYYY-MM-DD）——不能用 toISOString，那是 UTC，会在凌晨 8 点前差一天 */
export function localDate(now) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 判定这次要不要主动说话。
 *
 * @param {object} state - 当前状态
 * @param {object} cfg - 配置
 * @param {Date} now - 现在
 * @param {boolean} hasMaterial - 有没有真实素材（旧接口，保留兼容）
 * @param {object} [opts] - 新接口（主题演进系统）
 * @param {object} [opts.theme] - 选中的主题（{ seed, state }）；**没有就不说**
 * @returns {{shouldSpeak:boolean, stateChanged:boolean, reason:string, motive?:string, theme?:object}}
 */
export function decide(state, cfg, now, hasMaterial = true, opts = {}) {
  const today = localDate(now)
  let stateChanged = false

  // 1) energy —— 每天一抽，跨日重抽
  if (state.energy === null || state.energyDate !== today) {
    const { min, max } = cfg.energyRange ?? { min: 0.15, max: 0.85 }
    state.energy = Math.round((min + Math.random() * (max - min)) * 100) / 100
    state.energyDate = today
    stateChanged = true

    // ── 跨日归零（2026-11-18 修：**致命的漏项**）────────────────────
    //
    // 事故：11-18 09:04 那次投递后，状态里 `todayCount: 2`，
    // 而 `maxPerDay` 就是 2 ⇒ `todayCount >= maxPerDay` 恒成立
    // ⇒ **从 11-19 起每天都是 'daily-cap' ⇒ 主动搭讪永久停摆。**
    //
    // 根因：原来"跨日重置"只重置了 energy/energyDate，
    // `todayCount` 和 `unansweredCount` **只增不减**——
    // 于是"一天 2 次"实际上变成了"**一辈子 2 次**"。
    //
    // 现在跨日一并归零：新的一天重新开始算。
    state.todayCount = 0
    state.unansweredCount = 0
    // 额度字段已废弃（2026-11-18 用户定"搭讪不设额度"）⇒ 顺手清成 null，
    // 免得老记录里的 2 留着让人误会还有额度。
    state.maxPerDay = null
    // 隔了一夜，之前"因为没人理我所以闭嘴"的暂停可以解除了——
    // 但**手动暂停**（用户自己说的"别主动找我"）不能自动解。
    if (state.pausedReason === 'unanswered-cap') {
      state.paused = false
      state.pausedReason = null
    }
  }
  if (state.energy < 0.25) return { shouldSpeak: false, stateChanged, reason: 'low-energy' }

  // 2) 免打扰时段
  if (inQuietHours(now, state.quietHours ?? cfg.quietHours)) {
    return { shouldSpeak: false, stateChanged, reason: 'quiet-hours' }
  }

  // 3) 今日上限 —— **已取消**（2026-11-18 用户定）
  //
  //    用户原话：**「搭讪不设额度，只根据搭讪条件判断」**。
  //
  //    原来这里有 `if (state.todayCount >= maxPerDay) return 'daily-cap'`，
  //    把"一天 2 次"当硬闸门。**那是我自己加的节奏约束，不是他定的**——
  //    而且它跟他的原话直接冲突：搭讪是"我主动找你"，
  //    该由**条件**（什么时段、劲头够不够、上次隔了多久、他理没理我）决定，
  //    不该由一个计数器决定。
  //
  //    ⇒ 闸门删掉。`maxPerDay` 字段保留（只为兼容老记录），**不再被读取**。
  //    ⇒ `todayCount` 继续记（诊断用：今天说了几次），但不作闸门。
  //
  //    保留的条件闸门（这些才是"搭讪条件"）：
  //    - 免打扰时段（quietHours）
  //    - 劲头（energy < 0.25 不说）
  //    - 最小间隔（minGapMs，默认 90 分钟）—— 防止连着烦
  //    - 未回上限（maxUnanswered）—— 他不理我就不硬凑
  //    - 动机去重（最近 2 条不重复同一种动机）

  // 4) 未回上限 → 暂停
  //
  // ⚠️ 2026-11-18 补：**记下暂停的原因**。
  //    原来只置 `paused = true`，但没有 `pausedReason` ⇒
  //    分不清"因为没人理我所以闭嘴"和"用户亲口说别主动找我"，
  //    于是**手动暂停也永远解不开**。
  //    现在：自动暂停记 'unanswered-cap'，用户一回话就能解；
  //    手动暂停（pausedReason 为空或 'manual'）**绝不自动解**。
  const maxUnanswered = state.maxUnanswered ?? cfg.maxUnanswered ?? 2
  if (state.unansweredCount >= maxUnanswered) {
    state.paused = true
    state.pausedReason = 'unanswered-cap'
    return { shouldSpeak: false, stateChanged: true, reason: 'unanswered-cap' }
  }
  if (state.paused) return { shouldSpeak: false, stateChanged, reason: 'paused' }

  // 4.5) 最小间隔 —— 2026-11-17 加
  //
  //     事故：08:18 和 08:59 连投两条（间隔 41 分钟），说的是同一件事。
  //     "一天 2 次"的上限管不住密度——同一个早上连着开口两次不是人的节奏。
  //     现在：两条主动消息之间至少隔 minGapMs（默认 90 分钟）。
  const minGapMs = state.minGapMs ?? cfg.minGapMs ?? 90 * 60_000
  if (minGapMs > 0 && state.lastProactiveAt) {
    const elapsed = now.getTime() - new Date(state.lastProactiveAt).getTime()
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < minGapMs) {
      return { shouldSpeak: false, stateChanged, reason: 'too-recent' }
    }
  }

  // 5) 沉默阈值（随机抽一次，存进 nextEligibleAt）
  //
  //    ⚠️ 原实现有致命 bug：`if (!next || next <= now) { 重抽阈值; return false }`
  //    与下一行 `if (now < next) return false` 合起来，**shouldSpeak 永远为 false**
  //    —— 两个分支把所有情况都拦掉了，判定永远到不了"说"这一步。
  //    正确语义：阈值只在"还没抽过"时抽；抽过之后到点了就该说。
  const lastInteraction = Math.max(
    state.lastUserMessageAt ? new Date(state.lastUserMessageAt).getTime() : 0,
    state.lastProactiveAt ? new Date(state.lastProactiveAt).getTime() : 0,
  )
  if (!state.nextEligibleAt) {
    const [lo, hi] = silenceRange(now)
    let threshold = lo + Math.random() * (hi - lo)
    if (state.energy < 0.4) threshold *= 1.3
    if (state.unansweredCount === 1) threshold *= 1.5
    if (state.moodLow === true) threshold *= 1.5
    const base = lastInteraction > 0 ? lastInteraction : now.getTime()
    state.nextEligibleAt = new Date(base + threshold * MINUTE).toISOString()
    stateChanged = true
    return { shouldSpeak: false, stateChanged, reason: 'threshold-set' }
  }
  const next = new Date(state.nextEligibleAt)
  if (now < next) return { shouldSpeak: false, stateChanged, reason: 'too-early' }

  // 6) 动机 —— **由主题决定**（2026-11-18 主题演进系统）
  //
  //    原来是加权随机抽 ⇒ 模型自己从全量素材里挑 ⇒ 挑来挑去同一个梗。
  //    现在：主题先选好（纯代码），动机是**主题生命周期的投影**。
  //
  //    ⚠️ **向后兼容**：没传主题（opts.theme === undefined）⇒ 走旧的加权随机。
  //       传了主题但选不出（null）⇒ **不说**（没话头硬说就是编）。
  const hasThemeArg = Object.prototype.hasOwnProperty.call(opts, 'theme')
  let motive
  let theme = null
  if (!hasThemeArg) {
    // 旧路径（老测试 / 老调用方）：加权随机
    motive = pickMotive(state, now, hasMaterial)
    if (motive === 'skip') return { shouldSpeak: false, stateChanged, reason: 'motive-skip' }
  } else {
    theme = opts.theme ?? null
    if (!theme) return { shouldSpeak: false, stateChanged, reason: 'no-theme' }
    motive = pickMotiveForTheme(theme, state)
  }

  // 7) 去重 —— 主题状态已经管住了大部分重复，这里只做**兜底**：
  //    同一动机刚说过就换个主题（而不是硬着头皮再说一遍同样的动机）。
  if (isDuplicate(state, motive, now)) {
    state.nextEligibleAt = null
    return { shouldSpeak: false, stateChanged: true, reason: 'duplicate', motive }
  }

  return { shouldSpeak: true, stateChanged, reason: 'ok', motive, theme }
}

export { HOUR, MINUTE }
