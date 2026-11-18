import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRenderQueue } from '../src/renderQueue.ts'
import { needsDetail, overlap } from '../src/detailRegion.ts'

test('one slot stays available for foreground work and queued cancellation frees no active slot', async () => {
  const queue = createRenderQueue(2)
  const signal = new AbortController().signal
  const background = await queue(0, () => 3, signal)
  const cancelled = new AbortController()
  const pending = queue(1, () => 3, cancelled.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  const foreground = await queue(1, () => 0, signal)
  cancelled.abort()
  await rejected
  foreground(); background()
})

test('next slot goes to visible base, then alternates panes at equal priority', async () => {
  const queue = createRenderQueue(2)
  const signal = new AbortController().signal
  const one = await queue(1, () => 0, signal), two = await queue(0, () => 0, signal)
  let basePriority = 2
  const order: string[] = []
  const schedule = (pane: number, priority: () => number, name: string) =>
    queue(pane, priority, signal).then(release => { order.push(name); return release })
  const same = schedule(0, () => 1, 'same')
  const other = schedule(1, () => 1, 'other')
  const base = schedule(0, () => basePriority, 'base')
  basePriority = 0
  one()
  ;(await base)()
  ;(await other)()
  ;(await same)()
  two()
  assert.deepEqual(order, ['base', 'other', 'same'])
})

test('directional precision starts before an extendable margin runs out but reuses small moves', () => {
  const current = { left: 100, top: 100, width: 600, height: 620, scale: 4, dpr: 1.25 }
  const viewport = { left: 220, top: 210, width: 300, height: 400 }
  const redraw = (x: number, ahead: number, limit = 1200, dpr = 1.25) =>
    needsDetail(current, { ...viewport, left: x }, limit, 1500, 4, dpr, ahead, 0)
  assert.equal(redraw(245, 50), false)
  assert.equal(redraw(370, 50), true)
  assert.equal(redraw(370, -50), false)
  assert.equal(redraw(370, 50, 700), false)
  assert.equal(redraw(410, 0), true)
  assert.equal(redraw(245, 0, 1200, 2), true)
  assert.equal(needsDetail(current, { ...viewport, left: 350 }, 1200, 1500, 4, 1.25, 0, 0, true), true)
  assert.equal(needsDetail(current, { ...viewport, left: 245 }, 1200, 1500, 4, 1.25, 0, 0, true), false)
  assert.equal(overlap(current, { ...viewport, left: 800 }), 0)
})
