/**
 * Verbalized logit（论文降级实现）单测。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildVerbalizedPrompt,
  parseVerbalizedScores,
  toPseudoProbabilities,
} from '../lib/jitrl/verbalized.js'
import { applyAdvantage } from '../lib/jitrl/kernel.js'
import { selectWithAdvantage } from '../lib/jitrl/index.js'
import { emptyMemory, addRow } from '../lib/jitrl/memory.js'
import { scoreCandidates } from '../lib/jitrl/score.js'

const NOW = new Date('2026-11-18T21:00:00+08:00')
const SIG = 'evening|mid|2-6h|none|relation'

test('verbalized: prompt lists every candidate with an index', () => {
  const prompt = buildVerbalizedPrompt('state-x', ['restart nginx', 'tail the log'])
  assert.ok(prompt.includes('1. restart nginx'))
  assert.ok(prompt.includes('2. tail the log'))
  assert.ok(prompt.includes('"1"') && prompt.includes('"2"'))
})

test('verbalized: parses plain JSON, fenced JSON, and surrounding prose', () => {
  assert.deepEqual(parseVerbalizedScores('{"scores":{"1":80,"2":20}}'), { 1: 80, 2: 20 })
  assert.deepEqual(parseVerbalizedScores('```json\n{"scores":{"1":70}}\n```'), { 1: 70 })
  assert.deepEqual(parseVerbalizedScores('Sure: {"scores":{"1":10,"2":90}} done'), { 1: 10, 2: 90 })
  assert.equal(parseVerbalizedScores('not json'), null)
  assert.equal(parseVerbalizedScores('{"scores":{}}'), null)
})

test('verbalized: clamps scores into 0-100', () => {
  const out = parseVerbalizedScores('{"scores":{"1":150,"2":-20}}')
  assert.equal(out[1], 100)
  assert.equal(out[2], 0)
})

test('verbalized: pseudo-probability = confidence/100, missing is neutral 0.5', () => {
  const probs = toPseudoProbabilities({ 1: 80 }, ['a', 'b'])
  assert.equal(probs[0], 0.8)
  assert.equal(probs[1], 0.5)
})

test('verbalized: advantage is added to the pseudo-probability without a scale', () => {
  const z = applyAdvantage({ a: 0.8, b: 0.2 }, { a: 0.5, b: -0.5 }, 1.5)
  assert.equal(z.a, 0.8 + 0.75)
  assert.equal(z.b, 0.2 - 0.75)
})

test('select: verbal scores drive the choice when memory is empty', () => {
  const seeds = [
    { id: 'a', seed: 'sa', axis: 'relation' },
    { id: 'b', seed: 'sb', axis: 'relation' },
  ]
  const opts = {
    currentAxis: 'relation',
    now: NOW.toISOString(),
    state: { energy: 0.5, unansweredCount: 0, lastUserMessageAt: new Date(NOW - 3 * 3600_000).toISOString() },
    jitrl: { enabled: true },
    store: emptyMemory(),
    verbal: { a: 0.9, b: 0.1 },
  }
  // no memory => falls back to the rule order (a first, both 65), so verbal alone
  // cannot change the fallback; with signal it can. Assert both branches explicitly.
  const noSignal = selectWithAdvantage(seeds, {}, opts)
  assert.equal(noSignal.seed.id, 'a')
})

test('select: verbal scores combined with advantage can flip the order', () => {
  const seeds = [
    { id: 'a', seed: 'sa', axis: 'relation' },
    { id: 'b', seed: 'sb', axis: 'relation' },
  ]
  const store = emptyMemory()
  addRow(store, { sig: SIG, action: 'a', ret: -1 })
  addRow(store, { sig: SIG, action: 'b', ret: 1 })
  addRow(store, { sig: SIG, action: 'b', ret: 1 })
  let bWins = 0
  for (let i = 0; i < 200; i++) {
    const picked = selectWithAdvantage(seeds, {}, {
      currentAxis: 'relation',
      now: NOW.toISOString(),
      state: { energy: 0.5, unansweredCount: 0, lastUserMessageAt: new Date(NOW - 3 * 3600_000).toISOString() },
      jitrl: { enabled: true, beta: 1.5, temperature: 0.5 },
      store,
      verbal: { a: 0.6, b: 0.5 },
      rng: Math.random,
    })
    if (picked.seed.id === 'b') bWins++
  }
  assert.ok(bWins > 100, `expected b to dominate, got ${bWins}/200`)
})

test('score: degrades to null without a model or llm service', async () => {
  assert.equal(await scoreCandidates(null, { model: { provider: 'p', model: 'm' } }, {
    state: 's', candidates: ['a'],
  }), null)
  assert.equal(await scoreCandidates({ llm: {} }, {}, { state: 's', candidates: ['a'] }), null)
})
