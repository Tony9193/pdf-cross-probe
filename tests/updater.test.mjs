import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'

const require = createRequire(import.meta.url)
const { compareVersions, safeEntry, verifyManifest, inspectArchive } = require('../electron/update-core.cjs')
const { createUpdater, allowedURL } = require('../electron/updater.cjs')
const hash = value => createHash('sha256').update(value).digest('hex')
const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const contents = { 'PDF Cross Probe.exe': Buffer.from('test executable'), 'resources/app.asar': Buffer.from('test application') }

function fixture(version = '1.1.0') {
  const archive = zipSync(contents)
  const manifest = { schema: 1, version, platform: 'win32', arch: 'x64',
    asset: `PDF-Cross-Probe-${version}-win-x64.zip`, size: archive.length, sha256: hash(archive),
    files: Object.entries(contents).map(([name, buffer]) => ({ path: name, size: buffer.length, sha256: hash(buffer) })) }
  const envelope = { manifest, signature: sign(null, Buffer.from(JSON.stringify(manifest)), keys.privateKey).toString('base64') }
  const release = { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{
    name: manifest.asset, state: 'uploaded', size: archive.length, digest: `sha256:${manifest.sha256}`,
    browser_download_url: `https://github.com/Tony9193/pdf-cross-probe/releases/download/v${version}/${manifest.asset}`,
  }] }
  return { archive, envelope, release }
}

test('update signatures bind stable version, archive digest and Windows asset', () => {
  const sample = fixture()
  assert.equal(verifyManifest(sample.envelope, sample.release, '1.0.0', publicKey).manifest.version, '1.1.0')
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.throws(() => compareVersions('1.1.0-beta', '1.0.0'))
  assert.throws(() => verifyManifest(sample.envelope, sample.release, '1.1.0', publicKey))
  sample.envelope.manifest.sha256 = '0'.repeat(64)
  assert.throws(() => verifyManifest(sample.envelope, sample.release, '1.0.0', publicKey), /signature/)
})

test('ZIP extraction verifies all signed files and rejects Windows path tricks', async () => {
  for (const name of ['../escape', '/absolute', 'C:/escape', 'file:stream', 'CON.txt', 'folder/../escape', 'folder\\escape', 'file.']) {
    assert.throws(() => safeEntry(name), name)
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'pdf-update-'))
  try {
    const sample = fixture(), archive = path.join(directory, 'update.zip'), output = path.join(directory, 'stage')
    await writeFile(archive, sample.archive)
    await inspectArchive(archive, output, sample.envelope.manifest.files)
    assert.equal((await readFile(path.join(output, 'resources/app.asar'))).toString(), 'test application')
    await rm(output, { recursive: true })
    const wrongFiles = sample.envelope.manifest.files.map(file => ({ ...file, sha256: '0'.repeat(64) }))
    await assert.rejects(inspectArchive(archive, output, wrongFiles), /hash mismatch/)
    await writeFile(archive, zipSync({ '../escape.exe': Buffer.from('bad') }))
    await assert.rejects(inspectArchive(archive, output), /Unsafe|invalid relative path/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('update controller checks, streams and verifies a signed release without modifying the old application', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdf-update-controller-'))
  try {
    const sample = fixture(), target = path.join(directory, 'viewer'), status = []
    await mkdir(target)
    await writeFile(path.join(target, 'PDF Cross Probe.exe'), 'old application')
    sample.release.assets.push({ name: 'update-manifest.json', state: 'uploaded', size: 2000,
      browser_download_url: 'https://github.com/Tony9193/pdf-cross-probe/releases/download/v1.1.0/update-manifest.json' })
    const update = createUpdater({ version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64',
      publicKey, userData: path.join(directory, 'profile'), executablePath: path.join(target, 'PDF Cross Probe.exe'),
      onStatus: value => status.push(value.phase), fetch: async url => {
        if (url.endsWith('/latest')) return new Response(JSON.stringify(sample.release))
        if (url.endsWith('update-manifest.json')) return new Response(JSON.stringify(sample.envelope))
        return new Response(sample.archive)
      } })
    assert.equal((await update.check()).phase, 'available')
    assert.equal((await update.download()).phase, 'ready')
    assert.equal((await readFile(path.join(target, 'PDF Cross Probe.exe'))).toString(), 'old application')
    assert.ok(status.includes('downloading') && status.includes('verifying'))
    assert.equal(update.getStatus().progress, 100)

    // When api.github.com is rate-limited (403), updater falls back to github.com/releases/latest redirect + signed manifest.
    const rateLimited = createUpdater({ version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64',
      publicKey, userData: path.join(directory, 'profile-rl'), executablePath: path.join(target, 'PDF Cross Probe.exe'),
      fetch: async url => {
        if (url === 'https://api.github.com/repos/Tony9193/pdf-cross-probe/releases/latest') return new Response('rate limit', { status: 403 })
        if (url === 'https://github.com/Tony9193/pdf-cross-probe/releases/latest') {
          return new Response(null, { status: 302, headers: { location: 'https://github.com/Tony9193/pdf-cross-probe/releases/tag/v1.1.0' } })
        }
        if (url.endsWith('update-manifest.json')) return new Response(JSON.stringify(sample.envelope))
        return new Response(sample.archive)
      } })
    const rlCheck = await rateLimited.check(true)
    assert.equal(rlCheck.phase, 'available')
    assert.equal(rlCheck.version, '1.1.0')
    assert.equal((await rateLimited.download()).phase, 'ready')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('update controller rejects untrusted redirects, damaged downloads and cancellation leaves the old application intact', async () => {
  assert.throws(() => allowedURL('https://github.com.evil.example/update.zip'))
  assert.throws(() => allowedURL('http://github.com/update.zip'))
  const directory = await mkdtemp(path.join(tmpdir(), 'pdf-update-errors-'))
  try {
    const sample = fixture(), target = path.join(directory, 'viewer')
    await mkdir(target)
    await writeFile(path.join(target, 'PDF Cross Probe.exe'), 'old application')
    sample.release.assets.push({ name: 'update-manifest.json', state: 'uploaded', size: 2000,
      browser_download_url: 'https://github.com/Tony9193/pdf-cross-probe/releases/download/v1.1.0/update-manifest.json' })
    const options = { version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64', publicKey,
      userData: path.join(directory, 'profile'), executablePath: path.join(target, 'PDF Cross Probe.exe') }
    const redirect = createUpdater({ ...options, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } }) })
    assert.equal((await redirect.check(true)).phase, 'error')
    const damaged = sample.archive.slice(); damaged[0] ^= 1
    const update = createUpdater({ ...options, fetch: async url => {
      if (url.endsWith('/latest')) return new Response(JSON.stringify(sample.release))
      if (url.endsWith('update-manifest.json')) return new Response(JSON.stringify(sample.envelope))
      return new Response(damaged)
    } })
    await update.check(true)
    assert.equal((await update.download()).phase, 'error')
    await update.check(true)
    const download = update.download()
    update.cancel()
    assert.equal((await download).phase, 'available')
    assert.equal((await readFile(path.join(target, 'PDF Cross Probe.exe'))).toString(), 'old application')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('disposing updater removes unused downloads, awaits cancellation and preserves install recovery', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdf-update-dispose-'))
  try {
    const sample = fixture(), target = path.join(directory, 'viewer'), profile = path.join(directory, 'profile')
    const unrelated = path.join(directory, '.pdf-update-unrelated')
    await mkdir(target)
    await mkdir(unrelated)
    await writeFile(path.join(target, 'PDF Cross Probe.exe'), 'old application')
    await writeFile(path.join(unrelated, 'keep.txt'), 'unrelated local file')
    sample.release.assets.push({ name: 'update-manifest.json', state: 'uploaded', size: 2000,
      browser_download_url: 'https://github.com/Tony9193/pdf-cross-probe/releases/download/v1.1.0/update-manifest.json' })
    const fetch = async url => {
      if (url.endsWith('/latest')) return new Response(JSON.stringify(sample.release))
      if (url.endsWith('update-manifest.json')) return new Response(JSON.stringify(sample.envelope))
      return new Response(sample.archive)
    }
    const options = { version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64', publicKey,
      userData: profile, executablePath: path.join(target, 'PDF Cross Probe.exe'), fetch }
    const update = createUpdater(options)
    assert.equal((await update.check(true)).phase, 'available')
    assert.equal((await update.download()).phase, 'ready')
    await Promise.all([update.dispose(), update.dispose()])
    assert.deepEqual(await readdir(path.join(profile, 'updates')), [])
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.pdf-update-')), ['.pdf-update-unrelated'])

    const restarted = createUpdater(options)
    assert.equal((await restarted.check(true)).phase, 'available')
    assert.equal((await restarted.download()).phase, 'ready')
    const stages = (await readdir(directory)).filter(name => name.startsWith('.pdf-update-') && name !== '.pdf-update-unrelated')
    const jobs = await readdir(path.join(profile, 'updates'))
    assert.equal(stages.length, 1)
    assert.equal(jobs.length, 1)
    const work = path.join(profile, 'updates', jobs[0])
    const backup = `${target}.backup-${randomUUID()}`
    await mkdir(backup)
    await writeFile(path.join(backup, 'keep.txt'), 'recovery backup')
    await writeFile(path.join(work, 'transaction.json'), JSON.stringify({ stage: path.join(directory, stages[0]), backup }))
    await restarted.dispose()
    assert.ok(existsSync(path.join(directory, stages[0], 'resources', 'app.asar')))
    assert.ok(existsSync(path.join(work, 'update.zip')))
    assert.ok(existsSync(path.join(work, 'transaction.json')))
    assert.equal((await readFile(path.join(backup, 'keep.txt'))).toString(), 'recovery backup')

    let downloadStarted
    const started = new Promise(resolve => { downloadStarted = resolve })
    const cancelProfile = path.join(directory, 'cancel-profile')
    const cancelled = createUpdater({ ...options, userData: cancelProfile, fetch: async (url, request) => {
      if (!url.endsWith('.zip')) return fetch(url)
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        downloadStarted()
      })
    } })
    await cancelled.check(true)
    const download = cancelled.download()
    await started
    await cancelled.dispose()
    assert.equal((await download).phase, 'available')
    assert.deepEqual(await readdir(path.join(cancelProfile, 'updates')), [])
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.pdf-update-') && name !== '.pdf-update-unrelated'), stages)
    assert.equal((await readFile(path.join(target, 'PDF Cross Probe.exe'))).toString(), 'old application')
    assert.equal((await readFile(path.join(unrelated, 'keep.txt'))).toString(), 'unrelated local file')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Windows installer starts the real new viewer and rolls back a broken executable', {
  timeout: 180000, skip: process.platform !== 'win32' || process.env.PDF_TEST_INSTALLER !== '1',
}, async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const oldSource = path.resolve('release/1.0.0/win-unpacked')
  const newSource = path.resolve(pkg.build.directories.output, 'win-unpacked')
  assert.ok(existsSync(path.join(newSource, 'PDF Cross Probe.exe')), `Package version ${pkg.version} before running installer tests`)
  const directory = await mkdtemp(path.join(tmpdir(), 'PDF 更新 安装测试 '))
  const launched = []
  try {
    for (const scenario of ['success', 'broken', 'interrupted']) {
      const broken = scenario === 'broken'
      const root = path.join(directory, scenario)
      const target = path.join(root, 'viewer'), stage = path.join(root, '.pdf-update-test')
      const profile = path.join(root, 'profile'), work = path.join(profile, 'updates', 'job-test')
      const token = randomUUID(), oldFolder = scenario === 'interrupted' ? `${target}.backup-${token}` : target
      await mkdir(work, { recursive: true })
      await cp(oldSource, oldFolder, { recursive: true })
      await cp(newSource, stage, { recursive: true })
      const oldHash = hash(await readFile(path.join(oldFolder, 'PDF Cross Probe.exe')))
      await writeFile(path.join(oldFolder, 'local-note.txt'), 'user file remains local')
      const files = []
      const walk = async (folder, relative = '') => {
        for (const item of await readdir(folder, { withFileTypes: true })) {
          const name = relative ? `${relative}/${item.name}` : item.name
          if (item.isDirectory()) await walk(path.join(folder, item.name), name)
          else files.push(name)
        }
      }
      await walk(stage)
      if (broken) await writeFile(path.join(stage, 'PDF Cross Probe.exe'), 'not a Windows executable')
      const health = path.join(work, 'healthy.json'), status = path.join(work, 'result.json')
      const transaction = { schema: 1, target, stage, backup: `${target}.backup-${token}`, failed: `${target}.failed-${token}`,
        token, version: pkg.version, oldPid: 0, userData: profile, files, health, status }
      const journal = path.join(work, 'transaction.json')
      await writeFile(journal, JSON.stringify(transaction))
      if (scenario === 'interrupted') {
        await writeFile(status, JSON.stringify({ phase: 'backed-up' }))
      }
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve('electron/install-update.ps1'), '-TransactionFile', journal], {
        stdio: 'ignore', windowsHide: true, env: { ...process.env, PDF_CROSS_PROBE_MOCK_REGISTRY: '1' },
      })
      const [code] = await once(child, 'exit')
      assert.equal(code, 0)
      const result = JSON.parse(await readFile(status, 'utf8'))
      if (result.pid) launched.push(result.pid)
      assert.equal(result.phase, scenario === 'success' ? 'installed' : 'rolled-back')
      assert.equal((await readFile(path.join(target, 'local-note.txt'))).toString(), 'user file remains local')
      if (scenario !== 'success') assert.equal(hash(await readFile(path.join(target, 'PDF Cross Probe.exe'))), oldHash)
      else assert.equal(JSON.parse(await readFile(health, 'utf8')).version, pkg.version)
    }
  } finally {
    for (const pid of launched) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  }
})