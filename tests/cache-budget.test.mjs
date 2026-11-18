import assert from 'node:assert/strict'
import { test } from 'node:test'
import policy from '../electron/memory-budget.cjs'

test('optional cache shrinks immediately and expands only after sustained headroom', () => {
  const sample = policy.createMemoryPolicy()
  const read = free => sample({ free: free * 1024 ** 2, total: 16 * 1024 ** 2 })
  const normal = read(3)
  assert.equal(read(8), normal)
  assert.equal(read(8), normal)
  assert.ok(read(8) > normal)
  assert.equal(read(1), 0)
  for (const free of [2, 1, 2, 1, 2]) assert.equal(read(free), 0)
  assert.equal(read(4), 0)
  assert.equal(read(4), 0)
  assert.equal(read(4), normal)
  assert.throws(() => sample({ free: NaN, total: 100 }))
})
