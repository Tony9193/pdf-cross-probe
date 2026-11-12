const { createHash, randomUUID } = require('node:crypto')
const { createWriteStream, createReadStream, constants } = require('node:fs')
const { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, statfs, writeFile } = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Transform, Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { compareVersions, inspectArchive, limits, verifyManifest } = require('./update-core.cjs')
const trustKey = require('./update-key.cjs')

const repository = 'https://api.github.com/repos/Tony9193/pdf-cross-probe/releases/latest'
const releasePage = 'https://github.com/Tony9193/pdf-cross-probe/releases/latest'
const allowedHosts = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com',
  'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'])

function allowedURL(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHosts.has(url.hostname)) throw new Error('Untrusted update URL')
  return url
}

async function fileHash(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

function createUpdater(options) {
  let state = { phase: 'idle', currentVersion: options.version, releasePage }
  let selected = null, active = null, checking = null, downloading = null, lastCheck = 0
  let work = null, stage = null
  const root = path.join(options.userData, 'updates')
  const notify = patch => { state = { ...state, ...patch }; options.onStatus?.({ ...state }); return { ...state } }
  const getStatus = () => ({ ...state })

  async function request(value, signal, timeout = 30000) {
    let url = allowedURL(value)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    for (let count = 0; count <= 5; count++) {
      const response = await (options.fetch ?? fetch)(url.href, { redirect: 'manual', signal: deadline,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PDF-Cross-Probe-Updater' } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new Error('Invalid update redirect')
        url = allowedURL(new URL(location, url).href)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        const error = new Error('Update request failed')
        error.status = response.status
        throw error
      }
      return response
    }
    throw new Error('Too many update redirects')
  }

  async function json(value, signal) {
    const response = await request(value, signal), chunks = []
    let bytes = 0
    if (!response.body) throw new Error('Empty update metadata')
    const reader = response.body.getReader()
    try {
      for (;;) {
        signal.throwIfAborted()
        const { done, value: chunk } = await reader.read()
        if (done) break
        bytes += chunk.length
        if (bytes > 1024 * 1024) throw new Error('Update metadata too large')
        chunks.push(Buffer.from(chunk))
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally { await reader.cancel().catch(() => {}) }
  }

  async function checkViaRedirect(signal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)])
    const response = await (options.fetch ?? fetch)(releasePage, {
      redirect: 'manual',
      signal: deadline,
      headers: { 'User-Agent': 'PDF-Cross-Probe-Updater' },
    })
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) throw new Error('Invalid latest release redirect')
    const target = allowedURL(new URL(location, releasePage).href)
    if (target.hostname !== 'github.com' || target.search || target.hash) throw new Error('Untrusted latest release redirect')
    const match = /^\/tony9193\/pdf-cross-probe\/releases\/tag\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/i.exec(decodeURIComponent(target.pathname))
    if (!match) throw new Error('Invalid latest release tag')
    const version = match[1]
    if (compareVersions(version, options.version) <= 0) {
      selected = null
      return notify({ phase: 'up-to-date', version: options.version, message: '当前已是最新版本' })
    }
    const manifestUrl = `https://github.com/Tony9193/pdf-cross-probe/releases/download/v${version}/update-manifest.json`
    const envelope = await json(manifestUrl, signal)
    const assetName = `PDF-Cross-Probe-${version}-win-x64.zip`
    const syntheticRelease = {
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      assets: [{
        name: assetName,
        state: 'uploaded',
        size: envelope?.manifest?.size,
        digest: typeof envelope?.manifest?.sha256 === 'string' ? `sha256:${envelope.manifest.sha256}` : undefined,
        browser_download_url: `https://github.com/Tony9193/pdf-cross-probe/releases/download/v${version}/${assetName}`,
      }],
    }
    selected = verifyManifest(envelope, syntheticRelease, options.version, options.publicKey ?? trustKey)
    const notes = typeof envelope?.manifest?.notes === 'string' ? envelope.manifest.notes.slice(0, 8000) : ''
    return notify({ phase: 'available', version, notes, total: selected.manifest.size, message: '' })
  }

  function check(manual = false) {
    if (['downloading', 'verifying', 'ready', 'installing'].includes(state.phase)) return Promise.resolve(getStatus())
    if (checking) return checking
    if (!manual && Date.now() - lastCheck < 6 * 60 * 60 * 1000) return Promise.resolve(getStatus())
    const controller = new AbortController()
    active = controller; lastCheck = Date.now()
    notify({ phase: 'checking', message: '', received: 0, total: 0, progress: 0 })
    checking = (async () => {
      try {
        let release
        try {
          release = await json(repository, controller.signal)
        } catch (error) {
          if (error?.status === 403 || error?.status === 429) return await checkViaRedirect(controller.signal)
          throw error
        }
        const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : ''
        if (release.draft || release.prerelease) throw new Error('Invalid stable release')
        if (compareVersions(version, options.version) <= 0) {
          selected = null
          return notify({ phase: 'up-to-date', version: options.version, message: '当前已是最新版本' })
        }
        const asset = release.assets?.find(entry => entry.name === 'update-manifest.json' && entry.state === 'uploaded')
        if (!asset || asset.size > 1024 * 1024) throw new Error('Missing signed update manifest')
        const url = allowedURL(asset.browser_download_url)
        const expected = `/tony9193/pdf-cross-probe/releases/download/v${version}/update-manifest.json`
        if (url.hostname !== 'github.com' || decodeURIComponent(url.pathname).toLowerCase() !== expected.toLowerCase() || url.search || url.hash) throw new Error('Invalid manifest source')
        const envelope = await json(url.href, controller.signal)
        selected = verifyManifest(envelope, release, options.version, options.publicKey ?? trustKey)
        const notes = typeof release.body === 'string' && release.body
          ? release.body.slice(0, 8000)
          : (typeof envelope?.manifest?.notes === 'string' ? envelope.manifest.notes.slice(0, 8000) : '')
        return notify({ phase: 'available', version, notes, total: selected.manifest.size, message: '' })
      } catch {
        return notify({ phase: controller.signal.aborted ? 'idle' : 'error',
          message: controller.signal.aborted ? '' : '无法验证更新，请重试或手动下载' })
      } finally { checking = null; if (active === controller) active = null }
    })()
    return checking
  }

  function download() {
    if (downloading) return downloading
    if (!selected || state.phase !== 'available') return Promise.resolve(getStatus())
    if (!options.packaged || (options.platform ?? process.platform) !== 'win32' || (options.arch ?? process.arch) !== 'x64') {
      return Promise.resolve(notify({ phase: 'error', message: '此运行方式不支持安装更新，请手动下载便携版' }))
    }
    const controller = new AbortController(), candidate = selected
    active = controller
    notify({ phase: 'downloading', received: 0, progress: 0, total: candidate.manifest.size, message: '' })
    downloading = (async () => {
      try {
        const target = await realpath(path.dirname(options.executablePath)), parent = path.dirname(target)
        if (target === parent || path.basename(options.executablePath) !== 'PDF Cross Probe.exe' || (await lstat(path.dirname(options.executablePath))).isSymbolicLink()) throw new Error('Unsafe portable directory')
        const userRelative = path.relative(target, options.userData)
        if (!userRelative.startsWith('..') && !path.isAbsolute(userRelative)) throw new Error('Configuration is inside install directory')
        await access(parent, constants.W_OK)
        const disk = await statfs(parent), expanded = candidate.manifest.files.reduce((total, file) => total + file.size, 0)
        if (disk.bavail * disk.bsize < expanded + 64 * 1024 * 1024) throw new Error('Insufficient disk space')
        await mkdir(root, { recursive: true })
        work = await mkdtemp(path.join(root, 'job-'))
        stage = await mkdtemp(path.join(parent, '.pdf-update-'))
        const archive = path.join(work, 'update.zip'), hash = createHash('sha256')
        let received = 0, lastReport = 0
        const response = await request(candidate.url, controller.signal, 600000)
        if (!response.body) throw new Error('Empty update download')
        const meter = new Transform({ transform(chunk, _encoding, callback) {
          received += chunk.length
          if (received > candidate.manifest.size || received > limits.archive) return callback(new Error('Update download too large'))
          hash.update(chunk)
          if (Date.now() - lastReport > 100) {
            lastReport = Date.now()
            notify({ received, progress: Math.floor(received / candidate.manifest.size * 100) })
          }
          callback(null, chunk)
        } })
        await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(archive, { flags: 'wx' }), { signal: controller.signal })
        if (received !== candidate.manifest.size || hash.digest('hex') !== candidate.manifest.sha256) throw new Error('Download hash mismatch')
        notify({ phase: 'verifying', received, progress: 100 })
        await inspectArchive(archive, stage, candidate.manifest.files, controller.signal)
        return notify({ phase: 'ready', message: '校验完成，可以重启安装' })
      } catch {
        if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {})
        if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
        stage = null; work = null
        return notify({ phase: controller.signal.aborted ? 'available' : 'error', progress: 0,
          message: controller.signal.aborted ? '' : '更新下载或校验失败，原程序未改动；可重试或手动下载' })
      } finally { downloading = null; if (active === controller) active = null }
    })()
    return downloading
  }

  async function install() {
    if (state.phase !== 'ready' || !work || !stage || !selected) return getStatus()
    notify({ phase: 'installing', message: '正在准备重启安装' })
    try {
      for (const file of selected.manifest.files) {
        if (await fileHash(path.join(stage, ...file.path.split('/'))) !== file.sha256) throw new Error('Staged update changed')
      }
      const target = await realpath(path.dirname(options.executablePath)), token = randomUUID()
      const transaction = { schema: 1, token, version: selected.manifest.version, target, stage,
        backup: `${target}.backup-${token}`, failed: `${target}.failed-${token}`,
        oldPid: process.pid, userData: options.userData, files: selected.manifest.files.map(file => file.path),
        health: path.join(work, 'healthy.json'), status: path.join(work, 'result.json') }
      const journal = path.join(work, 'transaction.json'), helper = path.join(work, 'install-update.ps1')
      await writeFile(journal, JSON.stringify(transaction), { flag: 'wx' })
      await copyFile(options.helperPath, helper)
      await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
          '-TransactionFile', journal], { detached: true, windowsHide: true, stdio: 'ignore', cwd: work })
        child.once('error', reject)
        child.once('spawn', () => { child.unref(); resolve() })
      })
      options.onInstall?.()
      return getStatus()
    } catch {
      return notify({ phase: 'error', message: '无法启动更新安装，原程序未改动；请手动下载' })
    }
  }

  async function acknowledge() {
    const argument = process.argv.find(value => value.startsWith('--update-health='))
    const token = process.argv.find(value => value.startsWith('--update-token='))?.slice('--update-token='.length)
    if (!argument || !token) return
    const filename = path.resolve(argument.slice('--update-health='.length)), relative = path.relative(root, filename)
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.basename(filename) !== 'healthy.json') return
    try {
      const journal = JSON.parse(await readFile(path.join(path.dirname(filename), 'transaction.json'), 'utf8'))
      if (journal.token !== token || journal.version !== options.version || journal.health !== filename ||
        await realpath(journal.target) !== await realpath(path.dirname(options.executablePath))) return
      await writeFile(filename, JSON.stringify({ token, version: options.version }), { flag: 'wx' })
    } catch {}
  }

  return { getStatus, check, download, install, acknowledge, cancel: () => { active?.abort(); return getStatus() }, releasePage }
}

module.exports = { createUpdater, allowedURL, fileHash }