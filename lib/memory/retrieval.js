/**
 * 检索策略（Retriever）—— 召回的"相关性"来源，可插拔。
 *
 * ## 接口（冗余扩展点）
 *   Retriever.retrieve(query, gists, opts) → gists 附 `sim`（0-1 相关性）。
 *   召回编排器（recall.js）只依赖这个接口，不关心相关性怎么算。于是：
 *     - 现在：LexicalRetriever（字面 charOverlap，零依赖、零调用）。
 *     - 未来：SemanticRetriever（embedding 余弦）、HybridRetriever（字面+语义加权）、
 *       GraphRetriever（实体关系多跳）——都实现同一接口，配置切换，不改编排器。
 *
 * ## 为什么先字面
 *   事实按实体/关键词查时字面足够；零依赖零成本。语义检索要 embedding（依赖/调用），
 *   是后续项。接口先留好，届时插入即可。
 */

import { charOverlap } from '../jitrl/recall.js'

/** 事实的自然语言描述（相关性计算与展示用） */
export function factDesc(m) {
  return `${m.subject} ${m.predicate} ${m.object}`.trim()
}

/**
 * 字面检索器：charOverlap（字符集重合），大小写归一（gitee ↔ Gitee）。
 * 对传入的候选池逐条算 sim（池已由温度层收窄，量级可控）。
 */
export class LexicalRetriever {
  constructor(opts = {}) { this.opts = opts }
  /** @returns {Array} gists 附 sim（不修改输入） */
  retrieve(query, gists /* , opts */) {
    const q = String(query ?? '').toLowerCase()
    return (gists ?? []).map((g) => ({
      ...g,
      sim: charOverlap(q, factDesc(g).toLowerCase()),
    }))
  }
}

/** 默认检索器（编排器未显式指定时用）。未来可经配置换成 semantic/hybrid。 */
export const defaultRetriever = new LexicalRetriever()

/**
 * 语义检索器占位（接口冗余，尚未实装）。
 * 实装时：embed(query) 与 gist 向量余弦 → sim；向量存 memory_vector（schema 追加迁移）。
 * 保留此类是为了让"换检索策略"的扩展点显式可见，而非散落注释。
 */
export class SemanticRetriever {
  constructor(/* embedder, vectorStore */) {
    throw new Error('SemanticRetriever 尚未实装（规划中：embedding + memory_vector）')
  }
}