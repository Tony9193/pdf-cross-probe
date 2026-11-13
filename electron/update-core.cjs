const { createHash, createPublicKey, verify } = require('node:crypto')
const filesystem = process.versions.electron ? require('original-fs') : require('node:fs')
const { createWriteStream } = filesystem
const { mkdir, rm } = filesystem.promises
const path = require('node:path')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const yauzl = require('yauzl')

const limits = { entries: 5000, file: 256 * 1024 * 1024, total: 1536 * 1024 * 1024, archive: 512 * 1024 * 1024 }

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Invalid stable version')
  const parts = value.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid version number')
  return parts
}

function compareVersions(first, second) {
  const left = versionParts(first), right = versionParts(second)
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return Math.sign(left[index] - right[index])
  return 0
}

function safeEntry(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || /[\\:\x00-\x1f]/.test(name) || name.startsWith('/')) throw new Error('Unsafe archive path')
  const clean = name.replace(/\/$/, '')
  const parts = clean.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe Windows archive path')
  return clean
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length < 2 || files.length > limits.entries) throw new Error('Invalid file manifest')
  const names = new Set()
  let size = 0
  for (const file of files) {
    const name = safeEntry(file.path)
    if (name !== file.path || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.file ||
      typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid file manifest entry')
    const key = name.toLowerCase()
    if (names.has(key)) throw new Error('Duplicate manifest path')
    for (const existing of names) if (existing.startsWith(`${key}/`) || key.startsWith(`${existing}/`)) throw new Error('Conflicting manifest path')
    names.add(key); size += file.size
    if (size > limits.total) throw new Error('Update exceeds disk budget')
  }
  for (const required of ['pdf cross probe.exe', 'resources/app.asar']) if (!names.has(required)) throw new Error('Missing application files')
  return files
}

function verifyManifest(envelope, release, currentVersion, publicKey) {
  if (!envelope || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new Error('Invalid update signature')
  const manifest = envelope.manifest
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), type: 'spki', format: 'der' })
  if (!verify(null, Buffer.from(JSON.stringify(manifest)), key, Buffer.from(envelope.signature, 'base64'))) throw new Error('Update signature verification failed')
  if (!manifest || manifest.schema !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
    release.draft || release.prerelease || release.tag_name !== `v${manifest.version}` ||
    compareVersions(manifest.version, currentVersion) <= 0) throw new Error('Incompatible update release')
  const assetName = `PDF-Cross-Probe-${manifest.version}-win-x64.zip`
  if (manifest.asset !== assetName || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > limits.archive ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid update archive metadata')
  validateFiles(manifest.files)
  const asset = release.assets?.find(entry => entry.name === assetName)
  if (!asset || asset.state !== 'uploaded' || asset.size !== manifest.size ||
    (asset.digest && asset.digest !== `sha256:${manifest.sha256}`)) throw new Error('Release asset does not match signed manifest')
  const url = new URL(asset.browser_download_url)
  const expected = `/Tony9193/pdf-cross-probe/releases/download/v${manifest.version}/${assetName}`
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash ||
    decodeURIComponent(url.pathname).toLowerCase() !== expected.toLowerCase()) throw new Error('Untrusted release asset URL')
  return { manifest, url: url.href }
}

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
    (error, zip) => error ? reject(error) : resolve(zip)))
}

function nextEntry(zip) {
  return new Promise((resolve, reject) => {
    const finish = (error, entry) => {
      zip.removeListener('entry', entryHandler); zip.removeListener('end', endHandler); zip.removeListener('error', errorHandler)
      if (error) reject(error); else resolve(entry)
    }
    const entryHandler = entry => finish(null, entry), endHandler = () => finish(null, null), errorHandler = error => finish(error)
    zip.once('entry', entryHandler); zip.once('end', endHandler); zip.once('error', errorHandler)
    zip.readEntry()
  })
}

async function inspectArchive(file, destination, expectedFiles, signal) {
  const zip = await openZip(file), entries = [], names = new Set(), files = new Set()
  const expected = expectedFiles ? new Map(validateFiles(expectedFiles).map(entry => [entry.path, entry])) : null
  let total = 0, count = 0
  zip.on('error', () => {})
  try {
    for (;;) {
      signal?.throwIfAborted()
      const entry = await nextEntry(zip)
      if (!entry) break
      if (++count > limits.entries) throw new Error('Too many archive entries')
      const name = safeEntry(entry.fileName), directory = entry.fileName.endsWith('/'), key = name.toLowerCase()
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000
      if (mode === 0o120000 || (entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) throw new Error('Unsupported archive entry')
      if (names.has(key)) throw new Error('Duplicate archive path')
      for (const existing of files) if (key.startsWith(`${existing}/`)) throw new Error('Conflicting archive path')
      if (!directory && [...names].some(existing => existing.startsWith(`${key}/`))) throw new Error('Conflicting archive path')
      names.add(key)
      if (directory) continue
      files.add(key)
      total += entry.uncompressedSize
      if (entry.uncompressedSize > limits.file || total > limits.total) throw new Error('Archive exceeds extraction budget')
      const metadata = expected?.get(name)
      if (expected && (!metadata || metadata.size !== entry.uncompressedSize)) throw new Error('Archive contents differ from signed manifest')
      const hash = createHash('sha256')
      let size = 0
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length
        if (size > entry.uncompressedSize || size > limits.file) return callback(new Error('Expanded file exceeds declared size'))
        hash.update(chunk); callback(null, chunk)
      } })
      const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, input) => error ? reject(error) : resolve(input)))
      if (destination) {
        const target = path.join(destination, ...name.split('/'))
        await mkdir(path.dirname(target), { recursive: true })
        await pipeline(stream, meter, createWriteStream(target, { flags: 'wx' }), { signal })
      } else {
        const discard = new Transform({ transform(_chunk, _encoding, callback) { callback() } })
        await pipeline(stream, meter, discard, { signal })
      }
      const sha256 = hash.digest('hex')
      if (size !== entry.uncompressedSize || (metadata && metadata.sha256 !== sha256)) throw new Error('Extracted file hash mismatch')
      entries.push({ path: name, size, sha256 })
    }
    if (expected && entries.length !== expected.size) throw new Error('Signed archive is incomplete')
    return entries.sort((first, second) => first.path.localeCompare(second.path))
  } catch (error) {
    if (destination) await rm(destination, { recursive: true, force: true })
    throw error
  } finally { zip.close() }
}

module.exports = { compareVersions, limits, safeEntry, validateFiles, verifyManifest, inspectArchive }