/**
 * 事实记忆工具 —— 按需召回通道（独立于住相，服务日常会话）。
 *
 * 注册两个工具（对齐 OpenClaw memory_search/memory_get、Letta archival_memory_search）：
 *   - recall_memory(query, max_tokens?, deep?)：按当前问题召回相关事实（gist，省 token）。
 *   - memory_get(id)：取某条的全量 + 出处（核对时才花这份 token）。
 *
 * ## 为什么纯对象注册（不 import defineTool）
 *   插件是 link 安装，裸包名 `@deepseek-ai/dsh-tools` 解析不到（见踩坑页）。
 *   `ctx.tools.register` 直接收定义对象（output.render + JSON schema 即可），
 *   故这里手写 JSON schema，不依赖 defineTool。
 *
 * ## 扩展余地
 *   工具是薄适配层，逻辑都在 recall.js/store.js。未来加 memory_add（主动记）、
 *   memory_graph（关系查询）等，只需在此追加注册，不动底层。
 */

import { recallMemories } from './recall.js'

const GUIDANCE = [
  '你有一份跨会话的长期事实记忆（SQLite）。它独立于你的人格，存的是具体事实：用户的 ID、配置、偏好、过往事件。',
  '当对话涉及用户过往的事实/ID/配置/偏好，或你不确定某个具体值时，先用 recall_memory 查，不要凭印象编。',
  'recall_memory 返回精简事实卡；要核对某条的原话与出处，用 memory_get(id)。记忆随时间衰减，以查到的当前值为准。',
].join('\n')

/** 全量记忆 → 核对文本（含出处） */
function formatFull(m) {
  return [
    `#${m.id} ${m.subject} · ${m.predicate} = ${m.object}`,
    `类型 ${m.type} · 强度 ${Number(m.importance).toFixed(2)} · 命中 ${m.recall_count}${m.pinned ? ' · 钉住' : ''} · ${m.status}`,
    `原话：${m.quote}`,
    `出处：${m.source_ref}`,
  ].join('\n')
}

/**
 * 挂载事实记忆工具 + 引导段。
 * @param {object} scope - 已 inject ['tools','systemPrompt'] 的 cordis scope
 * @param {() => object|null} getStore - 取当前记忆库句柄（live）
 */
export function mountFactMemoryTools(scope, getStore) {
  scope.tools.register({
    name: 'recall_memory',
    description: '召回与当前问题相关的长期事实记忆（跨会话）。返回精简事实卡（subject › predicate=object）。涉及用户过往的 ID/配置/偏好/事件且你不确定具体值时使用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '要召回的主题或问题，如「用户的飞书 open_id」「gitee 账号」。' },
        max_tokens: { type: 'number', description: '返回事实卡的 token 预算，默认 200。' },
        deep: { type: 'boolean', description: 'true 时连沉底（dormant/archived）记忆一起查，默认只查活跃+钉住。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'count', 'more'],
        properties: {
          text: { type: 'string', description: '事实卡文本（可能为空）。' },
          count: { type: 'number', description: '本次返回的事实条数。' },
          more: { type: 'number', description: '还有多少条相关但未返回（可细化 query 或调大 max_tokens）。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text || '（无相关事实记忆）' }],
    },
    async execute(args) {
      const r = recallMemories(getStore(), args.query, {
        maxTokens: Number.isFinite(args.max_tokens) ? args.max_tokens : 200,
        deep: args.deep === true,
      })
      return { text: r.text, count: r.hits.length, more: r.more }
    },
  })

  scope.tools.register({
    name: 'memory_get',
    description: '按 id 取一条事实记忆的全量内容与出处（原话 quote + source_ref）。仅在需要核对某条事实的来源时用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'number', description: 'recall_memory 返回的事实 id。' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'found'],
        properties: {
          text: { type: 'string', description: '记忆全量 + 出处，或未找到提示。' },
          found: { type: 'boolean', description: '是否找到该 id。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const store = getStore()
      const m = store ? store.get(args.id) : null
      if (!m) return { text: `未找到记忆 #${args.id}`, found: false }
      return { text: formatFull(m), found: true }
    },
  })

  // 引导段：告诉主对话模型有这份记忆、何时查（只给顶层 agent）
  scope.systemPrompt.section({
    name: 'doubao-fact-memory',
    order: 62,
    interpolate: false,
    text: (context) => {
      try {
        const agent = context?.agent
        if (!agent) return ''
        const depth = agent.session?.header?.delegationDepth
        if (agent.session?.header?.origin === 'subagent' || (depth ?? 0) > 0) return ''
        return GUIDANCE
      } catch {
        return ''
      }
    },
  })
}