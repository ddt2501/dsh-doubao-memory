/**
 * 打分器：一次 LLM 调用，让模型给候选动作 0–100 分（verbalized logit 的入口）。
 *
 * 走 DSH 的 llm.stream（与插件其它生成调用同一条链），不碰 logprobs。
 * 失败/超时返回 null，调用方降级回规则先验——绝不因为打分失败而不说话。
 */

import { callLLM } from '../snapshot/generator.js'
import { buildVerbalizedPrompt, parseVerbalizedScores, toPseudoProbabilities } from './verbalized.js'

const DEFAULT_TIMEOUT_MS = 15000

/**
 * @param {object} ctx - 插件的 scope（有 .llm）
 * @param {object} cfg - { model: {provider, model}, ... }
 * @param {{state:string, candidates:string[], timeoutMs?:number}} input
 * @returns {Promise<Record<number, number> | null>} 候选索引(0-based) → 0–1 分；失败 null
 */
export async function scoreCandidates(ctx, cfg, input) {
  const { state, candidates } = input ?? {}
  if (!ctx?.llm || !Array.isArray(candidates) || !candidates.length) return null
  const model = cfg?.model
  if (!model?.provider || !model?.model) return null

  const system = 'You are a scoring function. Output JSON only.'
  const user = buildVerbalizedPrompt(state ?? '', candidates)
  try {
    const result = await callLLM(
      ctx,
      { model, maxTokens: 300, temperature: 0 },
      system,
      user,
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    if (!result?.text) return null
    const scores = parseVerbalizedScores(result.text)
    if (!scores) return null
    return toPseudoProbabilities(scores, candidates)
  } catch {
    return null
  }
}
