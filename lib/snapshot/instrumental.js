/**
 * 住相质量校验 —— 移植自 OpenClaw 时期的 `RUNTIME/manas-system/src/instrumental.py`，
 * 但**硬/软划分以用户手写的 `docs/snapshot-sop.md` §5 为准**：
 *   §5.1 硬约束（违反 → 重试/截断）：token ≤150 / 中文 / 第一人称 / 工具理性黑名单（11 词）
 *   §5.2 软约束（违反 → 只警告，保留输出）：连续性 / 主题覆盖 / 情感词
 *
 * instrumental.py 额外把「第二人称」和一批常用词（然后/最后/可以/需要…）当硬约束，
 * 那不是 SOP 的约定——中文里这些词太常见，硬拦会导致频繁重试、迅速掉进模式 B。
 * 所以这里降级成**软警告**（可在配置里调回硬）。
 */

/** SOP §5.1 的工具理性词汇黑名单（硬） */
export const INSTRUMENTAL_BLACKLIST = [
  '建议', '应该', '必须', '让我', '需要你', '我可以帮你',
  '解决方案', '第一步', '下一步', '推荐', '请考虑',
]

/** instrumental.py 的扩展词表（软） */
export const SOFT_INSTRUMENTAL = [
  '或许', '可以', '需要', '大概', '然后', '最后', '思考如下', '先从',
  '作为一个AI', '作为AI', '作为AI助手', 'AI助手', '您的', '你好', '请问',
]

/** 第二人称（软；住相是关于「我」的视角，不该是对用户的回应） */
export const SECOND_PERSON = ['你', '您']

/** 名字变体（软）——prompt 里要求固定叫「用户」或「他」 */
export const NAME_VARIANTS = ['大宝', '小明', '提问者', '用户', '豆豆', '妹妹', '小登']

/** 第一人称标识 */
export const FIRST_PERSON_MARKERS = [
  '我作为', '我看到', '我意识到', '我感受到', '我察觉到',
  '我是', '我有', '我知', '我想', '我',
]

const CHINESE_RE = /[一-鿿]/g

/** 粗估 token 数（1 token ≈ 1.5 中文字，与 instrumental.py 一致） */
export function tokenEstimate(text) {
  if (!text) return 0
  const chinese = (text.match(CHINESE_RE) || []).length
  const other = text.length - chinese
  return Math.floor(chinese / 1.5 + other / 4)
}

/** 中文占比 */
export function chineseRatio(text) {
  if (!text || !text.length) return 0
  return (text.match(CHINESE_RE) || []).length / text.length
}

/** 是否含第一人称 */
export function hasFirstPerson(text) {
  return FIRST_PERSON_MARKERS.some((m) => text.includes(m))
}

/** 命中的黑名单词 */
export function instrumentalHits(text, list = INSTRUMENTAL_BLACKLIST) {
  return list.filter((w) => text.includes(w))
}

/** 在句子边界截断（instrumental.py 的 truncate_at_sentence） */
export function truncateAtSentence(text, maxChars = 280) {
  if (!text || text.length <= maxChars) return text
  const truncated = text.slice(0, maxChars)
  let best = -1
  for (const boundary of ['。', '！', '？', '!', '?']) {
    const idx = truncated.lastIndexOf(boundary)
    if (idx > best) best = idx
  }
  if (best > maxChars - 80) return truncated.slice(0, best + 1)
  return `${truncated}…`
}

/**
 * 校验住相文本。
 * @returns {{ok: boolean, reason: string|null, hard: boolean, warnings: string[]}}
 *   reason 形如 'non_chinese' / 'too_long' / 'too_short' / 'no_first_person' / 'instrumental_vocab:建议'
 *   hard=true 表示该原因值得重试（SOP §7 的 retry_on）；hard=false 表示直接截断或兜底。
 */
export function validate(text, opts = {}) {
  const {
    maxTokens = 150,
    minTokens = 30,
    strictSecondPerson = false,
    strictSoftInstrumental = false,
  } = opts

  const warnings = []
  if (!text || !text.trim()) {
    return { ok: false, reason: 'empty_response', hard: false, warnings }
  }
  const t = text.trim()

  // 1) 中文（SOP §5.1 硬）
  if (chineseRatio(t) < 0.5) {
    return { ok: false, reason: 'non_chinese', hard: true, warnings }
  }

  // 2) 长度（SOP §5.1 硬；>150 截断不重试，<30 重试）
  const tokens = tokenEstimate(t)
  if (tokens > maxTokens) {
    return { ok: false, reason: 'too_long', hard: false, warnings, tokens }
  }
  if (tokens < minTokens) {
    return { ok: false, reason: 'too_short', hard: true, warnings, tokens }
  }

  // 3) 第一人称（硬）
  if (!hasFirstPerson(t)) {
    return { ok: false, reason: 'no_first_person', hard: true, warnings, tokens }
  }

  // 4) 工具理性黑名单（硬，SOP §5.1 的 11 词）
  const hard = instrumentalHits(t, INSTRUMENTAL_BLACKLIST)
  if (hard.length) {
    return { ok: false, reason: `instrumental_vocab:${hard[0]}`, hard: true, warnings, tokens }
  }

  // 5) 软约束：只警告
  const soft = instrumentalHits(t, SOFT_INSTRUMENTAL)
  if (soft.length) {
    if (strictSoftInstrumental) {
      return { ok: false, reason: `instrumental_vocab:${soft[0]}`, hard: true, warnings, tokens }
    }
    warnings.push(`soft_instrumental:${soft.join(',')}`)
  }
  const second = SECOND_PERSON.filter((w) => t.includes(w))
  if (second.length) {
    if (strictSecondPerson) {
      return { ok: false, reason: `second_person:${second[0]}`, hard: true, warnings, tokens }
    }
    warnings.push(`second_person:${second.join(',')}`)
  }
  const variants = NAME_VARIANTS.filter((w) => t.includes(w))
  if (variants.length) warnings.push(`name_variant:${variants.join(',')}`)

  return { ok: true, reason: null, hard: false, warnings, tokens }
}

/** 连续性（软）：与上轮住相的字符 Jaccard 相似度 —— 没有语义相似度工具时的近似 */
export function similarity(a, b) {
  if (!a || !b) return 0
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const ch of sa) if (sb.has(ch)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}
