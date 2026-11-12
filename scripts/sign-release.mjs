import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { inspectArchive } = require('../electron/update-core.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const keyPath = process.env.PDF_UPDATE_SIGNING_KEY ?? path.join(process.env.LOCALAPPDATA ?? homedir(), 'PDFCrossProbePublisher', 'update-signing.pem')
const relative = path.relative(root, path.resolve(keyPath))
assert.ok(relative.startsWith('..') || path.isAbsolute(relative), 'The signing key must be outside the repository')

if (process.argv.includes('--init')) {
  if (!existsSync(keyPath)) {
    const pair = generateKeyPairSync('ed25519')
    await mkdir(path.dirname(keyPath), { recursive: true })
    await writeFile(keyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
  }
  const privateKey = createPrivateKey(await readFile(keyPath))
  console.log(JSON.stringify({ publicKey: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyStoredOutsideRepository: true }))
} else if (!existsSync(keyPath)) {
  console.log('Signing key unavailable; package is for manual installation only')
} else {
  const privateKey = createPrivateKey(await readFile(keyPath))
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64')
  assert.equal(publicKey, require('../electron/update-key.cjs'), 'Signing key does not match the viewer trust key')
  const configuration = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const asset = `PDF-Cross-Probe-${configuration.version}-win-x64.zip`
  const filename = path.join(root, configuration.build.directories.output, asset)
  const notesPath = path.join(root, 'exports', `release-notes-${configuration.version}.md`)
  const notes = existsSync(notesPath) ? (await readFile(notesPath, 'utf8')).trim().slice(0, 8000) : undefined
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(filename)) { hash.update(chunk); size += chunk.length }
  const manifest = { schema: 1, version: configuration.version, platform: 'win32', arch: 'x64', asset, size,
    sha256: hash.digest('hex'), ...(notes ? { notes } : {}), files: await inspectArchive(filename) }
  const signature = sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString('base64')
  await writeFile(path.join(root, configuration.build.directories.output, 'update-manifest.json'), JSON.stringify({ manifest, signature }, null, 2))
  console.log(JSON.stringify({ signed: true, asset, files: manifest.files.length }))
}