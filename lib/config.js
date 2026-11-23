/**
 * 配置模式（Config schema）
 *
 * ⚠️ 为什么要写这个文件：DSH 的 Settings 表单是**从 Host 插件的 Config 派生**的。
 *    只声明 `.volatile()` 的字段才会出现在表单里（见 @deepseek-ai/dsh-settings README）。
 *    没有 Config 导出 ⇒ 设置页拿不到任何字段。
 *
 * ⚠️ 为什么 vendor 了 schemastery（node_modules/@deepseek-ai/schemastery）：
 *    插件是**链接安装**在 profile 的 node_modules 下，裸导入 `@deepseek-ai/schemastery`
 *    在运行时解析不到 DSH 安装目录里的那份。schemastery 用 `Symbol.for('schemastery')`
 *    认 schema，所以多份副本互通，vendor 一份是安全的。
 *
 * ⚠️ Schema 必须**完整描述现有配置**：DSH 激活条目时会用这份 schema 校验 config。
 *    漏掉的字段会被丢弃或被判非法，把线上能跑的组合打断。
 */

import z from '@deepseek-ai/schemastery'

/** 人格设定：用户手填，保存后生成本地人格文件 */
export const personaSchema = z.object({
  /**
   * 用哪个**已存在**的人格（$DSH_HOME/personas/<id>）。
   * 留空 = 用 dataRoot / 按 assistantName 找。
   */
  activeId: z.string().default('').volatile().description('人格 · 选择已存在的人格'),
  /**
   * 新建一个人格（$DSH_HOME/personas/<id>）。
   * ⚠️ 同名目录已存在时**拒绝创建**，绝不覆盖。
   * 建成功后把这里清空，改用 activeId。
   */
  newId: z.string().default('').volatile().description('人格 · 新建（同名已存在则拒绝）'),
  /** 人格 · 他对我的称呼（协议里的 {USER}） */
  userName: z.string().default('用户').volatile().description('人格 · 他对我的称呼'),
  /** 人格 · 我的名字（协议里的 {ASSISTANT}） */
  assistantName: z.string().default('助手').volatile().description('人格 · 我的名字'),
  /** 人格 · 一句话自我定位 */
  selfDescription: z.string().default('').volatile().description('人格 · 一句话自我定位'),
  /** 人格 · 性格特质，3-6 条 */
  coreTraits: z.array(z.string()).default([]).volatile().description('人格 · 性格特质'),
  /** 人格 · 说话风格 */
  tone: z.string().default('').volatile().description('人格 · 说话风格'),
  /** 禁忌 / 边界 */
  taboos: z.array(z.string()).default([]).volatile().description('人格 · 禁忌与边界'),
  /**
   * 强制覆盖手写文件（默认 false）。
   * 只覆盖生成器自己写的文件时不需要它；要连手写的 SOUL.md 一起换掉才打开。
   * 打开后每次保存都会重写，覆盖前会在 IDENTITY/SNAPSHOTS/ 留 .bak。
   */
  regenerate: z.boolean().default(false).volatile().description('人格 · 强制覆盖手写文件（会备份）'),
})

/** 某个子系统用的模型路由 */
export const modelRefSchema = z.object({
  // provider / model 标成 volatile：设置页要能把它们做成下拉并可写。
  // 写完不用重启——调用方每次生成时用 getModel() 现读。
  provider: z.string().default('minimax-cn').volatile().description('搭讪 · provider'),
  model: z.string().default('MiniMax-M3').volatile().description('搭讪 · 模型 id'),
  /** 该模型自己的输出预算（思考模型需要更多） */
  maxTokens: z.number().min(1).default(160),
})

/** 住相自己的模型（与搭讪分开描述，设置页才分得清） */
export const snapshotModelSchema = z.object({
  provider: z.string().default('minimax-cn').volatile().description('住相 · provider'),
  model: z.string().default('MiniMax-M3').volatile().description('住相 · 模型 id'),
  maxTokens: z.number().min(1).default(160),
})

/** 降级链条目：模型 + 可选预算覆盖 */
export const fallbackModelSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  maxTokens: z.number().min(1).default(160),
})

/**
 * manas / llm-wiki（四个 phase）用的模型。
 * 四个 phase 是 schedule 创建的会话，DSH 的 schedule 不直接收模型参数
 * （`ScheduleSessionCreateSpec` 只有 cwd / agentPreset），
 * 所以这里配的是「插件创建会话后替它选模型」的路由。
 */
export const phaseModelSchema = z.object({
  /** follow = 跟随主对话模型；custom = 用下面的 provider/model */
  mode: z.union(['follow', 'custom']).default('follow').volatile()
    .description('Phase 模型 · 跟随主模型 / 单独指定'),
  provider: z.string().default('').volatile().description('Phase 模型 · provider（custom 时用）'),
  model: z.string().default('').volatile().description('Phase 模型 · 模型 id（custom 时用）'),
})

export const Config = z.object({
  enabled: z.boolean().default(true),

  /** JitRL 总开关（2026-11-19）：记忆召回信用 + 搭讪主题优势调制 */
  jitrlEnabled: z.boolean().default(true).volatile().description('JitRL · 总开关（召回信用 + 搭讪调制）'),

  /**
   * SQLite 事实记忆（v1.1.0）——与 `memory`（wiki 四相）是两回事。
   * 开启后插件挂载时**自动建库**（<dataRoot>/RUNTIME/memory/memory.db），非致命：
   * 建库失败只记日志，不影响 wiki/住相/搭讪。关掉则完全不碰 SQLite。
   */
  factMemory: z.object({
    enabled: z.boolean().default(true).volatile().description('事实记忆 · SQLite 存储（挂载自动建库）'),
  }).default({}),

  /** 数据根目录；null = 包根。指到别处 = 这个包只提供机制，不带记忆。 */
  dataRoot: z.string().default(null),
  /** 状态目录；null = <dataRoot>/RUNTIME/state */
  stateDir: z.string().default(null),
  /** 人格库根目录；null = $DSH_HOME/personas */
  personasRoot: z.string().default(null),

  /** 人格设定（可volatile，保存后触发生成） */
  persona: personaSchema,

  /** manas / llm-wiki 的模型路由 */
  phaseModel: phaseModelSchema,

  /** 主动搭讪 */
  proactive: z.object({
    enabled: z.boolean().default(true),
    model: modelRefSchema,
    fallbackModels: z.array(fallbackModelSchema).default([]),
    pollIntervalMs: z.number().default(600000),
    /**
     * 一天最多主动几次 —— **已废弃**（2026-11-18 用户定「搭讪不设额度」）。
     *
     * 判定逻辑不再读它；字段保留只为兼容老记录。
     * ⇒ 「搭讪不设额度，只根据搭讪条件判断」——
     *    真正的闸门是：免打扰时段、劲头、最小间隔(90分)、未回上限、动机去重。
     *
     * ⚠️ schemastery **没有** `.nullable()`，也没有 `z.null()` 构造器
     *    ⇒ 可空标量只能用 `z.union([z.number(), z.any()])` 表达。
     */
    maxPerDay: z.union([z.number(), z.any()]).default(null),
    maxUnanswered: z.number().default(2),
    /** 两条主动消息之间的最小间隔（毫秒，默认 90 分钟）—— 2026-11-17 加 */
    minGapMs: z.number().default(5400000),
    /**
     * JitRL 优势调制（2026-11-18，PRD: docs/PRD-JITRL.md）。
     *
     * 用"他回没回"的行为信号学出主题偏好，调制 selectTheme 的候选排序。
     * 不训练、不注入上下文、零额外 LLM 调用。
     * **默认关闭**；关闭时行为与旧版逐字节一致。
     */
    jitrl: z.object({
      enabled: z.boolean().default(false).volatile().description('搭讪 · JitRL 调制（按他回没回）'),
      /** 优势强度：先验分差大的时候几乎不生效，差距小时才翻转 */
      beta: z.number().default(1.5),
      /** 小样本收缩：n/(n+shrink)，防止 1~2 条记忆放大噪声 */
      shrink: z.number().default(4),
      /** 成熟度：记忆行数到多少时 β 达到 1.5 倍上限（官方 episode_weight 公式） */
      maturityRows: z.number().default(50),
      /** 放宽到同轴召回的历史行降权系数（0 = 完全不用轴邻居） */
      relaxedWeight: z.number().default(0.5),
      /** 先验分压到 logit 量级（0~80 分 / 40 → 0~2） */
      scale: z.number().default(40),
      /** 采样温度：0.7 保留少量探索，越小越接近 argmax */
      temperature: z.number().default(0.7),
      /**
       * 打分来源（2026-11-18）：
       *  - 'rule'：规则先验分 / scale（零 LLM 调用）
       *  - 'verbalized'：让模型对候选打 0–100 分（论文降级实现，多一次调用）
       */
      scoring: z.string().default('rule'),
      /** 邻居少于这个数 ⇒ 退化回原排序 */
      minNeighbors: z.number().default(3),
      /** 只对先验分 top-N 候选做调制，防冷门种子靠噪声上位 */
      topCandidates: z.number().default(8),
      /** 每轮最多取多少条历史 */
      topK: z.number().default(16),
      /** 发出后多久没回算负样本（默认 24h） */
      replyWindowMs: z.number().default(86400000),
      /** 记忆行数上限 */
      maxRows: z.number().default(500),
    }).default({}),
    /**
     * 搭讪 · 暂停—— 2026-11-17 加。
     *
     * ⚠️ **为什么这个开关在 Config 里，不在状态文件里**：
     *    原来 `paused` 存在 `proactive.json`，我手工用 PowerShell 改它，
     *    PS 5.1 的 `Set-Content -Encoding UTF8` 写 BOM ⇒ JSON.parse 抛错 ⇒
     *    状态静默归零 ⇒ **"别主动找我"被自动解除**，插件又开口了。
     *
     *    放进 Config 之后：
     *    - 用户在 **Settings 页面点一下**就行（`.volatile()` ⇒ 不重启插件）；
     *    - 配置写盘走 DSH 的 config editor（保留 YAML 注释 + 整体校验）；
     *    - **BOM 这个坑从根上消失** —— 因为不再需要手工改 JSON。
     *
     * `.volatile()` 很重要：非 volatile 字段改动会重建插件状态。
     */
    paused: z.boolean().default(false).volatile().description('搭讪 · 暂停'),
    /**
     * 飞书直发（2026-11-18，用户选的方案 A）。
     *
     * **为什么需要**：DSH 生态里没有"插件主动往渠道推消息"的通道——
     * 飞书插件只处理 `assistant/message`，且要求有**活跃 run**，
     * 而 run 是用户**在飞书发消息时**才建的（`beginPrompt`），
     * 它也不暴露任何服务给别的插件。
     * ⇒ 主动搭讪只能**自己调飞书 API**。
     *
     * 开启后：目标会话是飞书会话 ⇒ 直接发过去（成功就不再投 DSH 会话）；
     * 失败 ⇒ 回落投 DSH 会话。
     */
    feishu: z.object({
      /** 关掉就是完全不碰飞书（默认） */
      enabled: z.boolean().default(false),
      /** 飞书应用 ID */
      appId: z.string().default(''),
      /**
       * 应用密钥。**留空 = 自动取**：
       * ① 环境变量 `FEISHU_APP_SECRET`
       * ② `%DSH_HOME%\.secrets\feishu-app-secret.txt`
       * （profile 里飞书插件用的就是 `!!js 'process.env.FEISHU_APP_SECRET'`）
       */
      appSecret: z.string().default(''),
      /** 目标会话（chat_id）。留空 = 按 DSH 会话 id 自动查 */
      chatId: z.string().default(''),
      /** DSH home（查飞书 state 用）。留空 = 取环境变量 DSH_HOME */
      dshHome: z.string().default(''),
    }).default({}),
  }),

  /** per-turn 住相 */
  snapshot: z.object({
    enabled: z.boolean().default(true),
    model: snapshotModelSchema,
    fallbackModels: z.array(fallbackModelSchema).default([]),
    timeoutMs: z.number().default(90000),
    maxAttempts: z.number().default(2),
    maxTokens: z.number().default(160),
    temperature: z.number().default(0.7),
    dedupe: z.boolean().default(true),
    strictSecondPerson: z.boolean().default(false),
    strictSoftInstrumental: z.boolean().default(false),
  }),

  /** 四个 phase */
  memory: z.object({
    enabled: z.boolean().default(true),
    userName: z.string().default('用户'),
    assistantName: z.string().default('助手'),
    cleanup: z.boolean().default(true),
    /**
     * 记忆召回信用（2026-11-19，实验 L4/L5）：住相生成前按"主题长期重要性"加权召回。
     * 信用文件不存在时自动退回纯字面召回；这里只控制"要不要用信用"。
     */
    recallCredit: z.boolean().default(true).volatile().description('记忆 · 召回信用（主题长期重要性）'),
    reload: z.number().default(2),
    targetCwd: z.string().default(''),
  }),

  /**
   * **Phase 服务** —— 四个自动化 phase 的静默调度（2026-11-18）。
   *
   * 替代 DSH 的 `schedule` 服务（那个每次触发开新会话 ⇒ 要审批 + 污染会话列表）。
   * 现在跑在 `ctx.jobs` 里，不开会话、不弹审批、有 Jobs 面板可看。
   *
   * ⚠️ 默认 **false**：旧的 schedule 路径还在，先并存验证，
   *    确认 headless 路径稳定后再把这里打开、把 memory.cleanup 关掉。
   */
  phases: z.object({
    enabled: z.boolean().default(false),
    /** dsh 的入口脚本（headless 模式的 bin.js） */
    dshBin: z.string().default(''),
    /**
     * node 可执行文件。
     *
     * ⚠️ **不能用 process.execPath**：插件跑在 Electron 里，那是 GUI exe。
     *    留空 ⇒ 自己从 PATH 找 node。
     */
    nodeExe: z.string().default(''),
    /** 用哪个 profile 跑（默认 headless ⇒ 无 GUI/HTTP/browser 层） */
    headlessProfile: z.string().default('headless'),
    /** 权限预设（danger-full-access ⇒ 写文件不弹审批） */
    permissionMode: z.string().default('danger-full-access'),
    /** 跑 phase 时的工作目录 */
    cwd: z.string().default(''),
    /** phase 定义 */
    list: z
      .array(
        z.object({
          phase: z.string().required(),
          title: z.string().required(),
          /** 5 字段 cron（分 时 日 月 周） */
          cron: z.string().required(),
          /** 传给 headless 的任务正文 */
          task: z.string().required(),
          enabled: z.boolean().default(true),
        }),
      )
      .default([]),
  }),

  /** 人格入口（工作区根 AGENTS.md） */
  personaEntry: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default(null),
    overwrite: z.boolean().default(false),
  }),
})

export default Config
