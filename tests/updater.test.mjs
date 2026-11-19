import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import { removeUpdateFixture } from './windows-update-fixture.mjs'

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

test('failed update helper startup keeps the old application and recovery transaction', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdf-update-helper-failure-'))
  try {
    const sample = fixture(), target = path.join(directory, 'viewer'), profile = path.join(directory, 'profile')
    const helper = path.join(directory, 'failing-helper.ps1')
    await mkdir(target)
    await writeFile(path.join(target, 'PDF Cross Probe.exe'), 'old application')
    await writeFile(helper, 'param([string]$TransactionFile, [switch]$Launch)\nexit 1\n')
    sample.release.assets.push({ name: 'update-manifest.json', state: 'uploaded', size: 2000,
      browser_download_url: 'https://github.com/Tony9193/pdf-cross-probe/releases/download/v1.1.0/update-manifest.json' })
    let closed = false
    const updater = createUpdater({ version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64', publicKey,
      userData: profile, executablePath: path.join(target, 'PDF Cross Probe.exe'), helperPath: helper,
      onInstall: () => { closed = true }, fetch: async url => {
        if (url.endsWith('/latest')) return new Response(JSON.stringify(sample.release))
        if (url.endsWith('update-manifest.json')) return new Response(JSON.stringify(sample.envelope))
        return new Response(sample.archive)
      } })
    assert.equal((await updater.check(true)).phase, 'available')
    assert.equal((await updater.download()).phase, 'ready')
    assert.equal((await updater.install()).phase, 'error')
    assert.equal(closed, false)
    assert.equal((await readFile(path.join(target, 'PDF Cross Probe.exe'))).toString(), 'old application')
    const jobs = await readdir(path.join(profile, 'updates'))
    assert.equal(jobs.length, 1)
    const journal = JSON.parse(await readFile(path.join(profile, 'updates', jobs[0], 'transaction.json'), 'utf8'))
    assert.ok(existsSync(journal.stage))
    await updater.dispose()
    assert.ok(existsSync(journal.stage))
    assert.ok(existsSync(path.join(profile, 'updates', jobs[0], 'transaction.json')))
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})

test('update controller enforces same/cross-volume disk budgets and protects unfinished transactions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdf-update-budget-'))
  try {
    const sample = fixture(), target = path.join(directory, 'viewer'), profile = path.join(directory, 'profile')
    await mkdir(target)
    await writeFile(path.join(target, 'PDF Cross Probe.exe'), 'old application')
    await writeFile(path.join(target, 'custom-user-data.bin'), Buffer.alloc(4096, 1))
    sample.release.assets.push({ name: 'update-manifest.json', state: 'uploaded', size: 2000,
      browser_download_url: 'https://github.com/Tony9193/pdf-cross-probe/releases/download/v1.1.0/update-manifest.json' })
    let zipRequests = 0
    const fetch = async url => {
      if (url.endsWith('/latest')) return new Response(JSON.stringify(sample.release))
      if (url.endsWith('update-manifest.json')) return new Response(JSON.stringify(sample.envelope))
      zipRequests++
      return new Response(sample.archive)
    }

    // 1. Same-volume insufficient space (archive + expanded + local files + 64MB margin)
    const sameVolSmall = createUpdater({ version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64', publicKey,
      userData: profile, executablePath: path.join(target, 'PDF Cross Probe.exe'), fetch,
      sameVolume: true, statfs: async () => ({ bavail: 64 * 1024 * 1024 + 10, bsize: 1 }) })
    assert.equal((await sameVolSmall.check(true)).phase, 'available')
    const sameVolResult = await sameVolSmall.download()
    assert.equal(sameVolResult.phase, 'error')
    assert.match(sameVolResult.message, /剩余空间不足/)
    assert.equal(zipRequests, 0)

    // 2. Cross-volume: install drive has space, download drive lacks archive + margin
    const crossVolSmall = createUpdater({ version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64', publicKey,
      userData: profile, executablePath: path.join(target, 'PDF Cross Probe.exe'), fetch,
      sameVolume: false,
      statfs: async targetPath => path.resolve(targetPath).startsWith(path.resolve(profile))
        ? { bavail: 1024 * 1024, bsize: 1 }
        : { bavail: 512 * 1024 * 1024, bsize: 1 } })
    assert.equal((await crossVolSmall.check(true)).phase, 'available')
    const crossVolResult = await crossVolSmall.download()
    assert.equal(crossVolResult.phase, 'error')
    assert.match(crossVolResult.message, /下载目录所在磁盘剩余空间不足/)
    assert.equal(zipRequests, 0)

    // 3. Ambiguous unfinished transaction blocks retry without deleting stage or journal
    const ambiguousJob = path.join(profile, 'updates', 'job-ambiguous')
    const ambiguousStage = path.join(directory, '.pdf-update-ambiguous')
    await mkdir(ambiguousJob, { recursive: true })
    await mkdir(ambiguousStage, { recursive: true })
    await writeFile(path.join(ambiguousJob, 'transaction.json'), JSON.stringify({
      target, stage: ambiguousStage, backup: `${target}.backup-00000000-0000-0000-0000-000000000001`,
    }))
    const blocked = createUpdater({ version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64', publicKey,
      userData: profile, executablePath: path.join(target, 'PDF Cross Probe.exe'), fetch })
    assert.equal((await blocked.check(true)).phase, 'available')
    const blockedResult = await blocked.download()
    assert.equal(blockedResult.phase, 'error')
    assert.match(blockedResult.message, /状态不明确/)
    assert.ok(existsSync(ambiguousStage))
    assert.ok(existsSync(path.join(ambiguousJob, 'transaction.json')))

    // 4. Terminal rolled-back transaction without backup is cleaned on retry so stages do not accumulate
    await writeFile(path.join(ambiguousJob, 'result.json'), JSON.stringify({ phase: 'rolled-back' }))
    const retry = createUpdater({ version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64', publicKey,
      userData: profile, executablePath: path.join(target, 'PDF Cross Probe.exe'), fetch })
    assert.equal((await retry.check(true)).phase, 'available')
    assert.equal((await retry.download()).phase, 'ready')
    assert.equal(existsSync(ambiguousStage), false)
    assert.equal(existsSync(ambiguousJob), false)
    assert.equal(zipRequests, 1)
    await retry.dispose()
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})

test('Windows installer starts the real new viewer and rolls back a broken executable', {
  timeout: 360000, skip: process.platform !== 'win32' || process.env.PDF_TEST_INSTALLER !== '1',
}, async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const oldSource = path.resolve('release/1.0.0/win-unpacked')
  const newSource = path.resolve(pkg.build.directories.output, 'win-unpacked')
  assert.ok(existsSync(path.join(newSource, 'PDF Cross Probe.exe')), `Package version ${pkg.version} before running installer tests`)
  const directory = await mkdtemp(path.join(tmpdir(), 'PDF 更新 安装测试 '))
  const targets = []
  const locks = []
  try {
    for (const scenario of ['success', 'broken', 'locked-cleanup', 'conflict', 'unrecoverable', 'interrupted']) {
      const broken = scenario === 'broken' || scenario === 'locked-cleanup'
      const root = path.join(directory, scenario)
      const target = path.join(root, 'viewer'), stage = path.join(root, '.pdf-update-test')
      targets.push(target)
      const profile = path.join(root, 'profile'), work = path.join(profile, 'updates', 'job-test')
      const token = randomUUID(), oldFolder = scenario === 'interrupted' || scenario === 'unrecoverable' ? `${target}.backup-${token}` : target
      await mkdir(work, { recursive: true })
      await cp(oldSource, oldFolder, { recursive: true })
      await cp(newSource, stage, { recursive: true })
      const oldHash = hash(await readFile(path.join(oldFolder, 'PDF Cross Probe.exe')))
      await writeFile(path.join(oldFolder, 'local-note.txt'), 'user file remains local')
      if (scenario === 'success') await writeFile(path.join(oldFolder, 'obsolete-official.dll'), 'old official file')
      if (scenario === 'conflict') {
        await rm(path.join(oldFolder, 'locales'), { recursive: true, force: true })
        await writeFile(path.join(oldFolder, 'locales'), 'user file colliding with new directory')
      }
      if (scenario === 'unrecoverable') await rm(path.join(oldFolder, 'PDF Cross Probe.exe'), { force: true })
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
      let lockProcess = null
      if (scenario === 'locked-cleanup') {
        const lockPath = path.join(stage, 'locked-by-av.tmp')
        await writeFile(lockPath, 'hold')
        const lockReady = path.join(root, 'lock-ready.txt')
        lockProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
          $stream = [IO.File]::Open($env:PDF_TEST_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
          [IO.File]::WriteAllText($env:PDF_TEST_LOCK_READY, 'locked')
          try { Start-Sleep -Seconds 60 } finally { $stream.Dispose() }
        `], {
          stdio: 'ignore', windowsHide: true,
          env: { ...process.env, PDF_TEST_LOCK_FILE: lockPath, PDF_TEST_LOCK_READY: lockReady },
        })
        locks.push(lockProcess)
        for (let i = 0; i < 60 && !existsSync(lockReady); i++) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        assert.ok(existsSync(lockReady), 'Lock helper did not acquire exclusive file lock')
      }
      const health = path.join(work, 'healthy.json'), status = path.join(work, 'result.json')
      const transaction = { schema: 1, target, stage, backup: `${target}.backup-${token}`, failed: `${target}.failed-${token}`,
        token, version: pkg.version, oldPid: 0, userData: profile, files,
        ...(scenario === 'success' ? { previousFiles: ['obsolete-official.dll'] } : {}),
        health, status }
      const journal = path.join(work, 'transaction.json')
      await writeFile(journal, JSON.stringify(transaction))
      if (scenario === 'interrupted' || scenario === 'unrecoverable') {
        await writeFile(status, JSON.stringify({ phase: 'backed-up' }))
      }
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.resolve('electron/install-update.ps1'), '-TransactionFile', journal], {
        stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true, env: { ...process.env, PDF_CROSS_PROBE_MOCK_REGISTRY: '1' },
      })
      const [code] = await once(child, 'exit')
      if (lockProcess && lockProcess.exitCode === null) {
        lockProcess.kill()
        await once(lockProcess, 'exit').catch(() => {})
      }
      assert.equal(code, 0)
      const result = JSON.parse(await readFile(status, 'utf8'))
      const expectedPhase = scenario === 'success' ? 'installed' : scenario === 'unrecoverable' ? 'recovery-needed' : 'rolled-back'
      assert.equal(result.phase, expectedPhase, `${scenario}: ${result.phase}: ${result.message}`)
      if (scenario === 'locked-cleanup') assert.equal(result.cleanupComplete, false)
      if (scenario !== 'unrecoverable') {
        assert.equal((await readFile(path.join(target, 'local-note.txt'))).toString(), 'user file remains local')
      }
      if (scenario === 'success') {
        assert.equal(JSON.parse(await readFile(health, 'utf8')).version, pkg.version)
        assert.equal(existsSync(path.join(target, 'obsolete-official.dll')), false)
      } else if (scenario === 'conflict') {
        assert.equal((await readFile(path.join(target, 'locales'))).toString(), 'user file colliding with new directory')
        assert.equal(hash(await readFile(path.join(target, 'PDF Cross Probe.exe'))), oldHash)
      } else if (scenario !== 'unrecoverable') {
        assert.equal(hash(await readFile(path.join(target, 'PDF Cross Probe.exe'))), oldHash)
      }
    }
  } finally {
    for (const proc of locks) if (proc.exitCode === null) proc.kill()
    await removeUpdateFixture(directory, targets)
  }
})