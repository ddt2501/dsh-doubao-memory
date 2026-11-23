/**
 * JitRL 决策服务（全局接入层）单测。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { emptyMemory, addRow, neighbors, loadMemory, saveMemory } from '../lib/jitrl/memory.js'
import { decideWithAdvantage, settleDecision } from '../lib/jitrl/service.js'

const NOW = new Date('2026-11-18T21:00:00+08:00')

test('memory: rows are isolated by decision point', () => {
  const store = emptyMemory()
  addRow(store, { sig: 's', action: 'a', ret: 1, point: 'proactive.theme' })
  addRow(store, { sig: 's', action: 'b', ret: 1, point: 'snapshot.dims' })
  addRow(store, { sig: 's', action: 'c', ret: 1 })   // legacy row = shared
  assert.deepEqual(neighbors(store, 's', null, 0, 10, 'proactive.theme').map((r) => r.action).sort(), ['a', 'c'])
  assert.deepEqual(neighbors(store, 's', null, 0, 10, 'snapshot.dims').map((r) => r.action).sort(), ['b', 'c'])
})

test('service: settle writes a row that neighbours can see', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jitrl-svc-'))
  try {
    const file = join(dir, 'mem.json')
    const ok = settleDecision({
      memoryFile: file, point: 'snapshot.dims', sig: 'evening|mid|>24h|none|none',
      actions: ['0', '3'], reward: 0.7, at: NOW.toISOString(),
    })
    assert.equal(ok, true)
    const store = loadMemory(file)
    assert.equal(store.rows.length, 2)
    assert.ok(store.rows.every((r) => r.point === 'snapshot.dims' && r.ret === 0.7))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('service: disabled or no memory file degrades to null', async () => {
  assert.equal(await decideWithAdvantage({
    cfg: { enabled: false }, memoryFile: 'x', candidates: [{ id: 'a', text: 'A' }],
  }), null)
  assert.equal(await decideWithAdvantage({
    cfg: { enabled: true }, memoryFile: null, candidates: [{ id: 'a', text: 'A' }],
  }), null)
})

test('service: no signal degrades to null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jitrl-svc-'))
  try {
    const file = join(dir, 'mem.json')
    const out = await decideWithAdvantage({
      cfg: { enabled: true, scoring: 'rule' },
      memoryFile: file,
      point: 'snapshot.dims',
      candidates: [{ id: '0', text: 'a' }, { id: '1', text: 'b' }],
      prior: { 0: 0.7, 1: 0.3 },
      state: {},
      now: NOW,
    })
    assert.equal(out, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('service: with signal returns top-k by adjusted score', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jitrl-svc-'))
  try {
    const file = join(dir, 'mem.json')
    const store = emptyMemory()
    // 维度 1 历史上被回报好，维度 0 差
    const sig = 'evening|mid|>24h|none|none'
    for (let i = 0; i < 3; i++) {
      addRow(store, { sig, action: '0', ret: -1, point: 'snapshot.dims' })
      addRow(store, { sig, action: '1', ret: 1, point: 'snapshot.dims' })
    }
    saveMemory(file, store)

    const out = await decideWithAdvantage({
      cfg: { enabled: true, scoring: 'rule', beta: 2, temperature: 0.01 },
      memoryFile: file,
      point: 'snapshot.dims',
      candidates: [{ id: '0', text: 'a' }, { id: '1', text: 'b' }],
      prior: { 0: 0.6, 1: 0.4 },
      state: {},
      now: NOW,
      k: 2,
    })
    assert.ok(out)
    assert.deepEqual(out.ids, ['1', '0'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
