import assert from 'node:assert/strict'
import { test } from 'node:test'
import { angleDistance, DocumentSearchIndex, keywordAt, nextMatchIndex, searchDocument, splitKeywords } from '../src/search.ts'
test('upside-down angle comparison wraps around positive and negative pi', () => {
  assert.ok(angleDistance(Math.PI, -Math.PI) < 0.001)
  assert.ok(angleDistance(Math.PI - 0.01, -Math.PI + 0.01) < 0.05)
  assert.ok(angleDistance(0, Math.PI) > 3)
})

test('exact identifiers exclude longer components and net names', () => {
  const result = searchDocument(['R1 R10 XR1 R1, VDD VDD_IO'], 'R1')
  assert.equal(result.mode, 'exact')
  assert.equal(result.matches.length, 2)
  assert.equal(searchDocument(['VDD VDD_IO'], 'VDD').matches.length, 1)
})

test('fallback is decided across the whole document, not per page', () => {
  const result = searchDocument(['COR3501', 'R3501'], 'R3501')
  assert.equal(result.mode, 'exact')
  assert.deepEqual(result.matches.map(match => match.page), [2])
})

test('forced and automatic substring matching report their mode honestly', () => {
  assert.equal(searchDocument(['COR3501'], 'R3501').mode, 'tolerant')
  assert.equal(searchDocument(['COR3501', 'R3501'], 'R3501', true).matches.length, 2)
  assert.equal(searchDocument(['COC0RK3576S0501'], 'R3501').matches.length, 0)
})

test('case and fullwidth normalization preserve source offsets', () => {
  const text = 'Ａ r3501 Ｒ３５０１'
  const result = searchDocument([text], 'R3501')
  assert.equal(result.matches.length, 2)
  assert.deepEqual(result.matches.map(match => text.slice(match.start, match.start + match.length)), ['r3501', 'Ｒ３５０１'])
})

test('counts include every page and repeated occurrence', () => {
  const result = searchDocument(['GND GND', '', 'GND'], 'GND')
  assert.deepEqual(result.matches.map(match => match.page), [1, 1, 3])
})

test('keywords are newline separated and keep spaces within a keyword', () => {
  assert.deepEqual(splitKeywords('R1\nVDD IO\r\nR1\n'), ['R1', 'VDD IO'])
  assert.equal(searchDocument(['R1'], ' ').matches.length, 0)
})

test('document index reuses results and invalidates them when a page arrives', () => {
  const index = new DocumentSearchIndex(['COR3501'])
  const first = index.search('R3501')
  assert.equal(first.mode, 'tolerant')
  assert.equal(index.search('R3501'), first)
  index.append('R3501')
  assert.notEqual(index.search('R3501'), first)
  assert.deepEqual(index.search('R3501').matches.map(match => match.page), [2])
  assert.equal(index.search('R3501', true).matches.length, 2)
})

test('global offsets recover identifiers spanning multiple PDF fragments', () => {
  const text = 'GND\nR' + '3501' + '\nRESET#'
  assert.equal(keywordAt(text, 4), 'R3501')
  assert.equal(keywordAt(text, 7), 'R3501')
  assert.equal(keywordAt(text, 14), 'RESET#')
  assert.equal(keywordAt(text, 3), null)
  assert.equal(keywordAt(text, -1), null)
  assert.equal(keywordAt(text, Number.NaN), null)
})

test('next and previous navigation wrap through all matches or one page', () => {
  const matches = searchDocument(['GND GND GND', 'GND'], 'GND').matches
  assert.equal(nextMatchIndex(matches, -1, 1, 1), 0)
  assert.equal(nextMatchIndex(matches, 0, 1, 1), 1)
  assert.equal(nextMatchIndex(matches, 1, 1, 1), 2)
  assert.equal(nextMatchIndex(matches, 2, 1, 1), 0)
  assert.equal(nextMatchIndex(matches, 0, -1, 1), 2)
  assert.equal(nextMatchIndex(matches, 2, 1), 3)
  assert.equal(nextMatchIndex(matches, 0, -1), 3)
  assert.equal(nextMatchIndex(matches, 0, 1, 9), -1)
})