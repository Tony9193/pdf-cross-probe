import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auditPublicSource, auditText, publicSourceFiles } from '../scripts/public-source.mjs'

test('public source selection excludes generated and potentially sensitive files', () => {
  const files = publicSourceFiles()
  assert.ok(files.includes('src/App.tsx'))
  assert.ok(files.includes('tests/viewer.test.mjs'))
  assert.ok(files.every(name => !/^(?:release|artifacts|dist|node_modules|exports)\//.test(name)))
  assert.ok(files.every(name => !/\.(?:pdf|png|jpg|zip|pem|pfx|key|log|map)$/i.test(name)))
  assert.equal(files.some(name => name.startsWith('public/pdf-assets/')), false)
})

test('public-source checks recognize private material without echoing its contents', () => {
  assert.deepEqual(auditText(['C:', 'Users', 'example-user', 'design.pdf'].join('\\')), ['user-path'])
  assert.deepEqual(auditText(['-----BEGIN ', 'PRIVATE KEY-----'].join('')), ['private-key'])
  assert.deepEqual(auditText(['https://', 'user:secret', '@example.invalid'].join('')), ['credential-url'])
  assert.deepEqual(auditText(['https://', '192.168.10.20', '/private'].join('')), ['private-network'])
  assert.deepEqual(auditText('https://registry.npmjs.org/'), [])
  assert.deepEqual(auditText('http://localhost:5173/'), [])
  assert.deepEqual(auditText('confidential-project', ['CONFIDENTIAL-PROJECT']), ['private-term'])
})

test('current publishable source has no detected local-user paths or credentials', () => {
  assert.deepEqual(auditPublicSource().findings, [])
})