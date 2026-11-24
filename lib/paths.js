/**
 * 路径解析 —— 让插件**可复用**的关键。
 *
 * 两层结构：
 *   **包根（PACKAGE_ROOT）** = 本文件的上级目录 = 插件包自己。
 *     装在 profile 里的是**代码与协议**（prompts / manas 协议 / scripts / docs）。
 *     运行时 `import.meta.url` 会穿过 profile 的 node_modules junction 指回**真实路径**
 *     （DSH 依赖这个行为，见 dsh-app-boot 的注释），所以拿到的就是真实的包目录 ✅。
 *
 *   **数据根（dataRoot）** = 人格实例目录 = **每个用户自己的**。
 *     默认 = 包根（= "这份包自带一份人格"）；装了插件之后用配置 `dataRoot` 指到别处
 *     （= "这个包只带机制，带不带记忆由你决定"）。
 *     里面是：IDENTITY（人格）/ VAULT（记忆）/ RAW（每日摘要）/ MEMORY.md /
 *             RUNTIME\state（运行时状态）/ RUNTIME\manas-system\data（末那识 cycle）。
 *
 * 协议文件（prompts / manas 协议 / scripts / docs）一律从**包根**取，
 * 它们的路径在文件里写成 `{PKG}` / `{DATA}` 占位符，由 memory-system.js 在注册
 * schedule 时替换成真实路径 ⇒ 换机器、换目录都不用改协议。
 */

import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

/** 包根目录（插件代码与协议所在处） */
export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))

/**
 * 解析所有用到的路径。
 * @param {object} cfg - 插件配置
 * @param {string} [cfg.dataRoot] - 人格实例目录（**不配就自己挑一个，但绝不是包根**）
 * @param {string} [cfg.stateDir] - 运行时状态目录（默认 <dataRoot>\RUNTIME\state）
 * @returns {object} 全部路径
 */
export function resolvePaths(cfg = {}) {
  const root = PACKAGE_ROOT
  // 实例目录的默认位置（**绝不能是包根本身** —— 那会把人格写进插件包里）
  //   1) 显式配置的 dataRoot
  //   2) $DSH_HOME/personas/<名字>（DSH 自己的地盘，跟 profile 无关）
  //   3) <包>/instance/（兜底，已 gitignore）
  const fallbackRoot = process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'personas', (cfg.assistantName || 'default').replace(/\s+/g, '-'))
    : join(root, 'instance')
  const dataRoot = cfg.dataRoot ? resolve(cfg.dataRoot) : fallbackRoot
  const state = cfg.stateDir ? resolve(cfg.stateDir) : join(dataRoot, 'RUNTIME', 'state')
  return {
    // ── 包（机制）──────────────────────────────────────────
    root,
    prompts: join(root, 'RUNTIME', 'prompts'),
    manasProtocol: join(root, 'RUNTIME', 'manas-system'),
    scripts: join(root, 'RUNTIME', 'scripts'),
    docs: join(root, 'docs'),
    templates: join(root, 'templates'),
    registry: join(root, 'RUNTIME', 'manas-system', 'REGISTRY.json'),

    // ── 实例（人格与记忆）────────────────────────────────────
    dataRoot,
    identity: join(dataRoot, 'IDENTITY'),
    vault: join(dataRoot, 'VAULT'),
    raw: join(dataRoot, 'RAW'),
    memory: join(dataRoot, 'MEMORY'),
    state,
    manasData: join(dataRoot, 'RUNTIME', 'manas-system', 'data'),
    snapshotLatest: join(dataRoot, 'SNAPSHOT_LATEST.md'),
    // SQLite 事实记忆（v1.1.0）：库由插件首次挂载自动迁移创建，落在数据目录而非包内
    memoryDir: join(dataRoot, 'RUNTIME', 'memory'),
    memoryDb: join(dataRoot, 'RUNTIME', 'memory', 'memory.db'),

    // ── 日志与指标 ─────────────────────────────────────────
    log: cfg.logPath ? resolve(cfg.logPath) : join(state, 'snapshot-probe.log'),
    metrics: cfg.metricsDir ? resolve(cfg.metricsDir) : join(dataRoot, 'RUNTIME', 'manas-system', 'data', 'snapshots', 'metrics'),
    proactiveLog: cfg.proactiveLogPath ? resolve(cfg.proactiveLogPath) : join(state, 'proactive.log'),
    proactiveState: cfg.proactiveStatePath ? resolve(cfg.proactiveStatePath) : join(state, 'proactive.json'),
    memorySystemLog: join(state, 'memory-system.log'),
    pluginLog: join(state, 'doubao-memory.log'),

    // ── DSH profile（读别的插件的配置用）─────────────────────
    //
    // 飞书直发要拿飞书插件的 appId（同一个机器人，没必要让用户填两遍）
    // ⇒ 从 profile 的 cordis.patch.yml 里读飞书那一行。
    //
    // ⚠️ 优先用 `DSH_PROFILE_DIR`（DSH 进程里就有这个环境变量），
    //    退回 `$DSH_HOME/profiles/$DSH_PROFILE`。
    profileDir: process.env.DSH_PROFILE_DIR
      ?? (process.env.DSH_HOME && process.env.DSH_PROFILE
        ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE)
        : null),
    profilePatch: process.env.DSH_PROFILE_DIR
      ? join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml')
      : (process.env.DSH_HOME && process.env.DSH_PROFILE
        ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE, 'cordis.patch.yml')
        : null),
  }
}
