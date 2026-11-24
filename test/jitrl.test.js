/**
 * JitRL 优势调制 —— 纯函数与接入层单测。
 * 运行：node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stateSignature, slotOf, energyBucket, silenceBucket } from '../lib/jitrl/signature.js'
import { estimateAdvantage, modulate, applyAdvantage, maturityWeight, softmaxSample, argmax } from '../lib/jitrl/kernel.js'
import { emptyMemory, addRow, neighbors, loadMemory, saveMemory } from '../lib/jitrl/memory.js'
import { selectWithAdvantage, settleOnSend, settleOnReply } from '../lib/jitrl/index.js'
import { selectTheme } from '../lib/proactive/themes.js'

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOW = new Date('2026-11-18T21:00:00+08:00')
const SIG = 'evening|mid|2-6h|none|relation'

test('signature: slotOf covers all buckets', () => {
  assert.equal(slotOf(7), 'morning')
  assert.equal(slotOf(11), 'forenoon')
  assert.equal(slotOf(13), 'noon')
  assert.equal(slotOf(16), 'afternoon')
  assert.equal(slotOf(21), 'evening')
  assert.equal(slotOf(3), 'night')
})

test('signature: energy and silence buckets', () => {
  assert.equal(energyBucket(0.2), 'low')
  assert.equal(energyBucket(0.5), 'mid')
  assert.equal(energyBucket(0.9), 'high')
  assert.equal(silenceBucket(NOW.getTime(), null), '>24h')
  assert.equal(silenceBucket(NOW.getTime(), new Date(NOW - 10 * 60_000).toISOString()), '<30m')
  assert.equal(silenceBucket(NOW.getTime(), new Date(NOW - 3 * 3600_000).toISOString()), '2-6h')
})

test('signature: full state signature', () => {
  const state = {
    energy: 0.5,
    unansweredCount: 0,
    lastUserMessageAt: new Date(NOW - 3 * 3600_000).toISOString(),
  }
  assert.equal(stateSignature(state, NOW, 'relation'), SIG)
})

test('kernel: advantage is shrunk then max-normalized', () => {
  const rows = [
    { action: 'a', ret: 1 },
    { action: 'a', ret: 1 },
    { action: 'b', ret: -1 },
  ]
  const adv = estimateAdvantage(rows, ['a', 'b', 'c'], { shrink: 4 })
  // baseline = mean(Q(a)=1, Q(b)=-1) = 0
  // raw a = 1 * 2/6, raw b = -1 * 1/5
  // max-normalize by max positive (1/3): a = 1, b = -0.6
  assert.equal(adv.a, 1)
  assert.ok(Math.abs(adv.b - (-0.2 / (1 / 3))) < 1e-9)
  assert.equal(adv.c, 0)   // unseen action stays neutral
})

test('kernel: maturity weight grows from 1.0 to 1.5', () => {
  assert.equal(maturityWeight(0), 1)
  assert.equal(maturityWeight(25, { rowsToFull: 50 }), 1.25)
  assert.equal(maturityWeight(500, { rowsToFull: 50 }), 1.5)
})

test('kernel: relaxed neighbours lose advantage strength', () => {
  const rows = [
    { action: 'a', ret: 1 },                        // exact
    { action: 'b', ret: 1, relaxed: true },          // only same-axis
  ]
  const adv = estimateAdvantage(rows, ['a', 'b'], { shrink: 0, relaxedWeight: 0.5 })
  // Q(a)=1, Q(b)=0.5, baseline=0.75 -> a is the only positive, b is negative
  assert.equal(adv.a, 1)
  assert.equal(adv.b, -1)
})

test('kernel: advantage is clipped to [-1, 1]', () => {
  const adv = estimateAdvantage([{ action: 'a', ret: 100 }, { action: 'b', ret: -100 }], ['a', 'b'], { shrink: 0 })
  assert.equal(adv.a, 1)
  assert.equal(adv.b, -1)
})

test('kernel: modulate adds beta * advantage', () => {
  const z = modulate({ a: 40, b: 40 }, { a: 1, b: -1 }, { beta: 1.5, scale: 40 })
  assert.equal(z.a, 1 + 1.5)
  assert.equal(z.b, 1 - 1.5)
})

test('kernel: softmax sample and argmax', () => {
  assert.equal(softmaxSample({}), null)
  assert.equal(argmax({ a: 0.1, b: 0.9 }), 'b')
  assert.equal(softmaxSample({ a: 5, b: -5 }, 0.5, () => 0), 'a')
  assert.equal(softmaxSample({ a: -5, b: 5 }, 0.5, () => 0.999999), 'b')
})

test('memory: load/save roundtrip and corrupt file degrades to empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jitrl-mem-'))
  try {
    const file = join(dir, 'memory.json')
    assert.deepEqual(loadMemory(file), emptyMemory())

    const store = emptyMemory()
    addRow(store, { sig: SIG, action: 'a', ret: 1, at: NOW.toISOString() })
    assert.equal(saveMemory(file, store), true)
    assert.equal(loadMemory(file).rows.length, 1)

    writeFileSync(file, '{not json')
    assert.deepEqual(loadMemory(file), emptyMemory())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory: maxRows evicts oldest', () => {
  const store = emptyMemory()
  for (let i = 0; i < 5; i++) addRow(store, { sig: SIG, action: `a${i}`, ret: 1 }, 3)
  assert.equal(store.rows.length, 3)
  assert.equal(store.rows[0].action, 'a2')
})

test('memory: neighbours prefer exact signature, relax to axis', () => {
  const store = emptyMemory()
  addRow(store, { sig: SIG, action: 'a', ret: 1 })
  addRow(store, { sig: 'other|sig', axis: 'relation', action: 'b', ret: 1 })
  assert.equal(neighbors(store, SIG, 'relation', 3).length, 2) // relaxes
  addRow(store, { sig: SIG, action: 'c', ret: 1 })
  addRow(store, { sig: SIG, action: 'd', ret: 1 })
  const exact = neighbors(store, SIG, 'relation', 3)
  assert.ok(exact.every((row) => row.sig === SIG))
})

test('select: disabled is identical to selectTheme', () => {
  const seeds = [
    { id: 'a', seed: 'sa', axis: 'relation' },
    { id: 'b', seed: 'sb', axis: 'current' },
  ]
  const opts = { currentAxis: 'relation', now: NOW.toISOString() }
  const base = selectTheme(seeds, {}, opts)
  const off = selectWithAdvantage(seeds, {}, { ...opts, jitrl: { enabled: false }, store: emptyMemory() })
  assert.deepEqual(off, base)
})

test('select: no memory / no signal is identical to selectTheme', () => {
  const seeds = [
    { id: 'a', seed: 'sa', axis: 'relation' },
    { id: 'b', seed: 'sb', axis: 'relation' },
  ]
  const opts = {
    currentAxis: 'relation',
    now: NOW.toISOString(),
    state: { energy: 0.5, unansweredCount: 0, lastUserMessageAt: new Date(NOW - 3 * 3600_000).toISOString() },
  }
  const base = selectTheme(seeds, {}, opts)
  const noMemory = selectWithAdvantage(seeds, {}, { ...opts, jitrl: { enabled: true }, store: emptyMemory() })
  assert.deepEqual(noMemory, base)
  const noSignal = selectWithAdvantage(seeds, {}, {
    ...opts, jitrl: { enabled: true }, store: emptyMemory(),
  })
  assert.deepEqual(noSignal, base)
})

test('select: positive history makes the rewarded action more likely', () => {
  const seeds = [
    { id: 'a', seed: 'sa', axis: 'relation' },
    { id: 'b', seed: 'sb', axis: 'relation' },
  ]
  const store = emptyMemory()
  addRow(store, { sig: SIG, action: 'a', ret: 1 })
  addRow(store, { sig: SIG, action: 'b', ret: -1 })
  const state = { energy: 0.5, unansweredCount: 0, lastUserMessageAt: new Date(NOW - 3 * 3600_000).toISOString() }
  const rng = mulberry32(42)
  let a = 0
  let b = 0
  for (let i = 0; i < 400; i++) {
    const picked = selectWithAdvantage(seeds, {}, {
      currentAxis: 'relation', now: NOW.toISOString(), state,
      jitrl: { enabled: true }, store, rng,
    })
    if (picked.seed.id === 'a') a++
    else b++
  }
  assert.ok(a > b, `expected a to dominate, got a=${a} b=${b}`)
})

test('settle: send registers pending, reply settles positive', () => {
  const store = emptyMemory()
  settleOnSend(store, { sig: SIG, action: 'a' }, { at: NOW.toISOString(), replyWindowMs: 3600_000 })
  assert.equal(Object.keys(store.pending).length, 1)

  const settled = settleOnReply(store, { at: new Date(NOW.getTime() + 5 * 60_000).toISOString() })
  assert.equal(settled, true)
  assert.equal(store.rows.length, 1)
  assert.equal(store.rows[0].action, 'a')
  assert.equal(store.rows[0].ret, 1.2) // replied within 15 minutes
  assert.equal(Object.keys(store.pending).length, 0)
})

test('settle: expired pending becomes a negative row on next send', () => {
  const store = emptyMemory()
  settleOnSend(store, { sig: SIG, action: 'a' }, { at: NOW.toISOString(), replyWindowMs: 60_000 })
  settleOnSend(store, { sig: SIG, action: 'b' }, {
    at: new Date(NOW.getTime() + 2 * 60_000).toISOString(),
    replyWindowMs: 60_000,
  })
  const rowA = store.rows.find((row) => row.action === 'a')
  assert.ok(rowA)
  assert.equal(rowA.ret, -1)
  assert.equal(Object.keys(store.pending).length, 1)
})
