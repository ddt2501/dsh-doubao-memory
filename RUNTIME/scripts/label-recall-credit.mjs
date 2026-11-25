/**
 * 离线标注记忆召回信用（一次性任务）。
 *
 * 对 VAULT/07-INDEX.md 的每条主题，让模型打一个"长期重要性"（0-100），
 * 写入 <dataRoot>/RUNTIME/state/recall-credit.json。
 * 插件在生成住相时读取该文件，用 0.2·字面 + 0.8·信用 排序召回。
 *
 * 用法：
 *   node RUNTIME/scripts/label-recall-credit.mjs --data-root D:\dsh\persona\助手
 * 需要 DEEPSEEK_API_KEY（或 OPENAI_API_KEY）环境变量 / .env。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const MODEL = process.env.AGENTD_LABEL_MODEL || 'deepseek-v4-pro'
const API = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '') + '/chat/completions'

function loadKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY
  if (fromEnv) return fromEnv
  for (const f of [join(process.env.USERPROFILE || '', '.dsh', '.env')]) {
    try {
      for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(DEEPSEEK_API_KEY|OPENAI_API_KEY)\s*=\s*(.+)$/)
        if (m) return m[2].trim().replace(/^["']|["']$/g, '')
      }
    } catch { /* ignore */ }
  }
  return ''
}

const INDEX_RE = /^- \[\[([^\]]+)\]\][^—]*—\s*(.+)$/

function topicsOf(file) {
  const out = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(INDEX_RE)
    if (m) out.push({ page: m[1].trim(), desc: m[2].trim() })
  }
  return out
}

async function label(key, topic) {
  const body = {
    model: MODEL,
    messages: [{
      role: 'user',
      content: [
        '你在给一个长期陪伴型 AI 的记忆库做标注。',
        '下面是一条记忆主题（它概括了关于"对方"的一类事实或关系经验）。',
        `主题：${topic}`,
        '请评估：这条记忆对理解对方的长期偏好、关系模式、或他此刻的状态，有多重要？',
        '只输出一个 0-100 的整数：0=几乎无关，50=偶尔有用，100=长期关键。',
      ].join('\n'),
    }],
    max_tokens: 900,
    thinking: { type: 'enabled' },
    reasoning_effort: 'low',
    stream: false,
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content || ''
  const nums = text.match(/\d{1,3}/g) || []
  const v = nums.length ? parseInt(nums[nums.length - 1], 10) : NaN
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 50
}

async function main() {
  const args = process.argv.slice(2)
  const i = args.indexOf('--data-root')
  const dataRoot = i >= 0 ? args[i + 1] : process.env.DSH_PERSONA_ROOT
  if (!dataRoot) {
    console.error('missing --data-root')
    process.exit(2)
  }
  const key = loadKey()
  if (!key) {
    console.error('missing DEEPSEEK_API_KEY / OPENAI_API_KEY')
    process.exit(2)
  }
  const indexFile = join(dataRoot, 'VAULT', '07-INDEX.md')
  if (!existsSync(indexFile)) {
    console.error('index not found:', indexFile)
    process.exit(2)
  }
  const topics = topicsOf(indexFile)
  console.log(`topics: ${topics.length}`)
  const out = {}
  for (const t of topics) {
    const score = await label(key, t.desc)
    out[t.desc] = score
    console.log(`  ${String(score).padStart(3)}  ${t.desc.slice(0, 40)}`)
  }
  const file = join(dataRoot, 'RUNTIME', 'state', 'recall-credit.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    model: MODEL,
    topics: out,
  }, null, 2), 'utf8')
  console.log('written:', file)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
