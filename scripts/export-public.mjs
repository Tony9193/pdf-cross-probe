import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { auditPublicSource, projectRoot, sourceManifest } from './public-source.mjs'

const privateTerms = JSON.parse(process.env.PUBLIC_AUDIT_TERMS ?? '[]')
assert.ok(Array.isArray(privateTerms) && privateTerms.every(term => typeof term === 'string'), 'PUBLIC_AUDIT_TERMS must be a JSON string array')
const { files, findings } = auditPublicSource(projectRoot, undefined, privateTerms)
if (findings.length) {
  console.error(JSON.stringify({ passed: false, findings }, null, 2))
  process.exitCode = 1
} else {
  const configuration = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const entries = Object.fromEntries(files.map(name => [name, new Uint8Array(readFileSync(path.join(projectRoot, name)))]))
  const manifestName = 'PUBLIC-SOURCE-MANIFEST.json'
  entries[manifestName] = strToU8(JSON.stringify({ version: configuration.version, files: sourceManifest(projectRoot, files) }, null, 2))
  const archive = zipSync(entries, { level: 9, mtime: new Date('2020-01-01T00:00:00Z') })
  const verification = unzipSync(archive)
  assert.deepEqual(Object.keys(verification).sort(), [...files, manifestName].sort())
  for (const name of files) assert.deepEqual(verification[name], entries[name], `ZIP changed source: ${name}`)
  const output = `exports/pdf-cross-probe-public-source-${configuration.version}.zip`
  mkdirSync(path.join(projectRoot, 'exports'), { recursive: true })
  writeFileSync(path.join(projectRoot, output), archive)
  console.log(JSON.stringify({ passed: true, sourceFiles: files.length, output, bytes: archive.length, generatedFilesIncluded: false }, null, 2))
}