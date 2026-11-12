import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageLayout, visiblePages, wheelPage } from '../src/reading.ts'

test('continuous page geometry handles mixed sizes and many visible small pages', () => {
  const layout = pageLayout([{ width: 640, height: 800 }, { width: 800, height: 640 }, { width: 640, height: 800 }], 1)
  assert.equal(layout[1].top, 820)
  assert.deepEqual(visiblePages(layout, 780, 180), [1, 2])
  const small = pageLayout(Array.from({ length: 30 }, () => ({ width: 640, height: 800 })), 0.1)
  assert.ok(visiblePages(small, 0, 900).length > 3)
})

test('wheel paging rejects inertia cascades, reversal and in-progress page rendering', () => {
  let state = { time: 0, direction: 0, amount: 0, locked: false }
  const first = wheelPage(state, 100, 1000, true, false)
  assert.equal(first.turn, 1); state = first.state
  for (const time of [1020, 1050, 1100]) {
    const result = wheelPage(state, 120, time, true, false)
    assert.equal(result.turn, 0); state = result.state
  }
  assert.equal(wheelPage(state, 100, 1500, true, false).turn, 1)
  assert.equal(wheelPage(state, -100, 1120, true, false).turn, -1)
  assert.equal(wheelPage(state, 100, 1500, true, true).turn, 0)
  assert.equal(wheelPage(state, 100, 1500, false, false).turn, 0)
})