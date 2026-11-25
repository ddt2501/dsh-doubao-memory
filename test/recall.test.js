/**
 * 记忆召回信用单测（实验依据：内部研究）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadRecallCredit, recallScore, rankRecall, charOverlap } from '../lib/jitrl/recall.js'
import { relevantThemes } from '../lib/snapshot/inputs.js'

test('recall: charOverlap is 0-1', () => {
  assert.equal(charOverlap('abc', 'abc'), 1)
  assert.equal(charOverlap('abc', 'xyz'), 0)
  assert.ok(charOverlap('他今天加班', '加班') > 0)
})

test('recall: without credit the score is monotonic in similarity', () => {
  const a = recallScore({ text: '工作加班', desc: '工作' })
  const b = recallScore({ text: '工作加班', desc: '跑步' })
  assert.ok(a > b)
})

test('recall: credit dominates similarity', () => {
  const credit = { '工作': 40, '跑步': 90 }
  // 字面重合：工作更高；但信用：跑步更高，0.8 权重应压过 0.2 的字面
  const work = recallScore({ text: '工作加班', desc: '工作', credit })
  const run = recallScore({ text: '工作加班', desc: '跑步', credit })
  assert.ok(run > work, `expected credit to dominate: run=${run} work=${work}`)
})

test('recall: rankRecall sorts and does not mutate input', () => {
  const entries = [{ desc: '工作' }, { desc: '跑步' }, { desc: '加班' }]
  const before = JSON.stringify(entries)
  const ranked = rankRecall(entries, '工作加班', { '工作': 90, '跑步': 95, '加班': 60 })
  assert.equal(JSON.stringify(entries), before)
  assert.equal(ranked.length, 3)
  assert.ok(ranked[0].score >= ranked[1].score && ranked[1].score >= ranked[2].score)
})

test('recall: loadRecallCredit degrades to null on missing/corrupt file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-'))
  try {
    const file = join(dir, 'credit.json')
    assert.equal(loadRecallCredit(file), null)
    writeFileSync(file, '{not json')
    assert.equal(loadRecallCredit(file), null)
    writeFileSync(file, JSON.stringify({ version: 1, topics: { 工作: 90 } }))
    assert.deepEqual(loadRecallCredit(file), { 工作: 90 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relevantThemes: with credit picks a high-credit weak-sim topic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-idx-'))
  try {
    const file = join(dir, '07-INDEX.md')
    writeFileSync(file, [
      '- [[工作页]] — 工作 加班 项目',
      '- [[跑步页]] — 跑步 配速 马拉松',
      '',
    ].join('\n'))
    // 无 credit：只按字面，工作命中，跑步不命中
    const noCredit = relevantThemes(file, '工作加班', 3, 100, null)
    assert.ok(noCredit.includes('工作'))
    // 有 credit：跑步信用 90，字面为 0 —— 本次实现只放行 credit>=70
    const withCredit = relevantThemes(file, '工作加班', 3, 100, { '跑步 配速 马拉松': 90 })
    assert.ok(withCredit.includes('跑步'), `expected 跑步 in: ${withCredit}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
