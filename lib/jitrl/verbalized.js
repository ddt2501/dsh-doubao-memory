/**
 * Verbalized logit —— 论文给出的降级实现（官方代码 `--confidence_mode verbalized`）。
 *
 * 拿不到 logprobs 的端点（MiniMax、大多数中转、API 黑盒模型）用这条路：
 *  1. 让模型对每个候选动作输出一个 0–100 的置信度；
 *  2. 置信度 / 100 = pseudo-probability（官方实现就是这么映射的，不做 softmax）；
 *  3. 再叠加 JitRL 的优势：z' = p + β·Â；
 *  4. 取最大（官方实现是 argmax；这里保留采样开关，默认 argmax 以求可复现）。
 *
 * 与 token 档的区别：分数来自模型的自评，不是真实分布；它平滑得多，
 * 所以优势项真的能翻转它（DeepSeek 的 top_logprobs 在选择题上会饱和到 0.99999）。
 */

/** 把候选动作渲染成带编号的打分指令（一次调用拿全部分数）。 */
export function buildVerbalizedPrompt(state, candidates) {
  const lines = candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')
  return [
    'You are choosing the next action for a companion agent.',
    `State: ${state}`,
    'Candidates:',
    lines,
    '',
    'Rate every candidate from 0 to 100 for how good it is as the next action.',
    'Higher is better. Give each candidate its own score; do not rank.',
    `Output JSON only: {"scores": {${candidates.map((_, i) => `"${i + 1}": <0-100>`).join(', ')}}}`,
  ].join('\n')
}

/**
 * 解析模型返回的 JSON。容忍 ```json 围栏、前后废话。
 * @returns {Record<number, number> | null} 1-based 索引 → 0–100 分
 */
export function parseVerbalizedScores(text) {
  const raw = String(text ?? '')
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(body.slice(start, end + 1))
    const scores = parsed?.scores
    if (!scores || typeof scores !== 'object') return null
    const out = {}
    for (const [key, value] of Object.entries(scores)) {
      const index = Number(key)
      const score = Number(value)
      if (Number.isInteger(index) && index >= 1 && Number.isFinite(score)) {
        out[index] = Math.max(0, Math.min(100, score))
      }
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

/**
 * 1-based 分数 → 每个候选的 pseudo-probability（0–1）。
 * 官方实现直接用 confidence/100；缺失的候选给 0.5（中性）。
 */
export function toPseudoProbabilities(scoresByIndex, candidates) {
  const out = {}
  candidates.forEach((_, i) => {
    const score = scoresByIndex?.[i + 1]
    out[i] = Number.isFinite(score) ? score / 100 : 0.5
  })
  return out
}
