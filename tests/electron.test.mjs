import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron } from 'playwright-core'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { zipSync } from 'fflate'
import { encryptedPdf } from './encrypted-fixture.mjs'

test('desktop updater processes trusted redirects and rejects untrusted or endless redirects', { timeout: 60000 }, async () => {
  const configuration = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const packaged = path.resolve(process.env.PDF_TEST_EXECUTABLE ?? path.join(configuration.build.directories.output, 'win-unpacked/PDF Cross Probe.exe'))
  const executablePath = !process.env.PDF_TEST_SOURCE && existsSync(packaged) ? packaged : undefined
  const temporary = mkdtempSync(path.join(tmpdir(), 'pdf-update-redirect-'))
  const env = { ...process.env, PDF_CROSS_PROBE_MOCK_REGISTRY: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    const args = [...(executablePath ? [] : [path.resolve('.')]), `--user-data-dir=${path.join(temporary, 'profile')}`]
    app = await _electron.launch({ executablePath, args, env, timeout: 60000 })
    const main = await app.firstWindow()
    await main.getByRole('heading', { name: 'PDF 联动查看器', exact: true }).waitFor({ timeout: 30000 })
    await app.evaluate(({ session }, version) => {
      globalThis.updateProbeUrls = []
      globalThis.updateProbeMode = 'trusted'
      session.fromPartition('updates').protocol.handle('https', request => {
        const url = new URL(request.url)
        globalThis.updateProbeUrls.push(`${url.hostname}${url.pathname}`)
        if (globalThis.updateProbeMode === 'untrusted') {
          return new Response(null, { status: 302, headers: { location: 'https://evil.example/blocked' } })
        }
        if (globalThis.updateProbeMode === 'loop') {
          return new Response(null, { status: 302, headers: { location: `https://api.github.com/loop-${globalThis.updateProbeUrls.length}` } })
        }
        if (url.pathname === '/repos/Tony9193/pdf-cross-probe/releases/latest') {
          return new Response(null, { status: 302, headers: { location: 'https://api.github.com/test-release' } })
        }
        if (url.hostname === 'api.github.com' && url.pathname === '/test-release') {
          return new Response(JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [] }),
            { headers: { 'Content-Type': 'application/json' } })
        }
        return new Response('Unexpected request', { status: 404 })
      })
    }, configuration.version)
    const status = await main.evaluate(() => window.pdfCrossProbeDesktop.checkForUpdates(true))
    assert.equal(status.phase, 'up-to-date')
    assert.deepEqual(await app.evaluate(() => globalThis.updateProbeUrls), [
      'api.github.com/repos/Tony9193/pdf-cross-probe/releases/latest', 'api.github.com/test-release',
    ])
    await app.evaluate(() => { globalThis.updateProbeMode = 'untrusted'; globalThis.updateProbeUrls = [] })
    assert.equal((await main.evaluate(() => window.pdfCrossProbeDesktop.checkForUpdates(true))).phase, 'error')
    assert.deepEqual(await app.evaluate(() => globalThis.updateProbeUrls), ['api.github.com/repos/Tony9193/pdf-cross-probe/releases/latest'])
    await app.evaluate(() => { globalThis.updateProbeMode = 'loop'; globalThis.updateProbeUrls = [] })
    assert.equal((await main.evaluate(() => window.pdfCrossProbeDesktop.checkForUpdates(true))).phase, 'error')
    assert.equal((await app.evaluate(() => globalThis.updateProbeUrls)).length, 6)
  } finally {
    await app?.close()
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('desktop updater verifies and downloads signed releases through redirects, rate limits and cancellation', { timeout: 120000 }, async () => {
  const configuration = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const packaged = path.resolve(process.env.PDF_TEST_EXECUTABLE ?? path.join(configuration.build.directories.output, 'win-unpacked/PDF Cross Probe.exe'))
  const executablePath = !process.env.PDF_TEST_SOURCE && existsSync(packaged) ? packaged : undefined
  const temporary = mkdtempSync(path.join(tmpdir(), 'pdf-update-electron-'))
  const target = path.join(temporary, 'viewer')
  mkdirSync(target)
  writeFileSync(path.join(target, 'PDF Cross Probe.exe'), 'old application')
  const keys = generateKeyPairSync('ed25519')
  const hash = value => createHash('sha256').update(value).digest('hex')
  const asarSource = path.join(temporary, 'asar-source'), asarFile = path.join(temporary, 'fixture.asar')
  mkdirSync(asarSource)
  writeFileSync(path.join(asarSource, 'index.js'), 'new resources')
  await createRequire(import.meta.url)('@electron/asar').createPackage(asarSource, asarFile)
  const contents = { 'PDF Cross Probe.exe': Buffer.from('new application'), 'resources/app.asar': readFileSync(asarFile) }
  const archive = zipSync(contents)
  const manifest = { schema: 1, version: '99.0.0', platform: 'win32', arch: 'x64',
    asset: 'PDF-Cross-Probe-99.0.0-win-x64.zip', size: archive.length, sha256: hash(archive),
    files: Object.entries(contents).map(([name, value]) => ({ path: name, size: value.length, sha256: hash(value) })) }
  const envelope = { manifest, signature: sign(null, Buffer.from(JSON.stringify(manifest)), keys.privateKey).toString('base64') }
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const release = { tag_name: 'v99.0.0', draft: false, prerelease: false, assets: [
    { name: 'update-manifest.json', state: 'uploaded', size: 4096,
      browser_download_url: 'https://github.com/Tony9193/pdf-cross-probe/releases/download/v99.0.0/update-manifest.json' },
    { name: manifest.asset, state: 'uploaded', size: manifest.size, digest: `sha256:${manifest.sha256}`,
      browser_download_url: `https://github.com/Tony9193/pdf-cross-probe/releases/download/v99.0.0/${manifest.asset}` },
  ] }
  const env = { ...process.env, PDF_CROSS_PROBE_MOCK_REGISTRY: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    const args = [...(executablePath ? [] : [path.resolve('.')]), `--user-data-dir=${path.join(temporary, 'profile')}`]
    app = await _electron.launch({ executablePath, args, env, timeout: 60000 })
    const main = await app.firstWindow()
    await main.getByRole('heading', { name: 'PDF 联动查看器', exact: true }).waitFor({ timeout: 30000 })
    await app.evaluate(({ session }, fixture) => {
      globalThis.updateFixture = fixture
      globalThis.updateRequests = []
      globalThis.updateMode = 'normal'
      globalThis.updateArchiveStarted = null
      session.fromPartition('updates').protocol.handle('https', request => {
        const url = new URL(request.url)
        globalThis.updateRequests.push(`${url.hostname}${url.pathname}`)
        if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases/latest')) {
          return globalThis.updateMode === 'fallback'
            ? new Response('rate limited', { status: 403 })
            : new Response(JSON.stringify(fixture.release), { headers: { 'Content-Type': 'application/json' } })
        }
        if (url.hostname === 'github.com' && url.pathname.endsWith('/releases/latest')) {
          return new Response(null, { status: 302, headers: { location: 'https://github.com/Tony9193/pdf-cross-probe/releases/tag/v99.0.0' } })
        }
        if (url.hostname === 'github.com' && url.pathname.endsWith('/update-manifest.json')) {
          return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/test-manifest' } })
        }
        if (url.hostname === 'release-assets.githubusercontent.com' && url.pathname === '/test-manifest') {
          const value = structuredClone(fixture.envelope)
          if (globalThis.updateMode === 'tampered') value.manifest.sha256 = '0'.repeat(64)
          return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
        }
        if (url.hostname === 'github.com' && url.pathname.endsWith('.zip')) {
          return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/test-archive' } })
        }
        if (url.hostname === 'release-assets.githubusercontent.com' && url.pathname === '/test-archive') {
          if (globalThis.updateMode === 'cancel') {
            return new Response(new ReadableStream({ start(controller) {
              controller.enqueue(Uint8Array.from(fixture.archive.slice(0, 8)))
              globalThis.updateArchiveStarted?.()
            } }))
          }
          return new Response(Uint8Array.from(fixture.archive))
        }
        return new Response('Unexpected request', { status: 404 })
      })
    }, { envelope, release, archive: [...archive] })
    for (const mode of ['normal', 'fallback', 'tampered', 'cancel']) {
      const result = await app.evaluate(async ({ app, net, session }, options) => {
        globalThis.updateMode = options.mode
        globalThis.updateRequests = []
        const createRequire = process.getBuiltinModule('module').createRequire
        const path = process.getBuiltinModule('path')
        const requireFromApp = createRequire(path.join(app.getAppPath(), 'package.json'))
        const modulePath = app.isPackaged ? 'dist/desktop/updater.cjs' : 'electron/updater.cjs'
        const { createUpdater, createElectronFetch, fileHash } = requireFromApp(path.join(app.getAppPath(), modulePath))
        const updater = createUpdater({ version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64',
          publicKey: options.publicKey, userData: path.join(options.temporary, `profile-${options.mode}`),
          executablePath: path.join(options.target, 'PDF Cross Probe.exe'), fetch: createElectronFetch(net, session.fromPartition('updates')) })
        const check = await updater.check(true)
        let download = null
        if (check.phase === 'available' && options.mode === 'cancel') {
          const started = new Promise(resolve => { globalThis.updateArchiveStarted = resolve })
          const operation = updater.download()
          await started
          updater.cancel()
          download = await operation
        } else if (check.phase === 'available') download = await updater.download()
        let stagedAsarHash = null
        if (download?.phase === 'ready') {
          const names = await process.getBuiltinModule('fs').promises.readdir(options.temporary)
          const stage = names.find(name => name.startsWith('.pdf-update-'))
          stagedAsarHash = await fileHash(path.join(options.temporary, stage, 'resources', 'app.asar'))
        }
        const urls = [...globalThis.updateRequests]
        await updater.dispose()
        return { check: check.phase, version: check.version, download: download?.phase ?? null, stagedAsarHash, urls }
      }, { mode, publicKey, temporary, target })
      if (mode === 'tampered') {
        assert.equal(result.check, 'error')
        assert.equal(result.download, null)
        assert.ok(!result.urls.some(url => url.endsWith('/test-archive')))
      } else {
        assert.equal(result.check, 'available')
        assert.equal(result.version, '99.0.0')
        assert.equal(result.download, mode === 'cancel' ? 'available' : 'ready', JSON.stringify({ mode, ...result }))
        if (mode !== 'cancel') assert.equal(result.stagedAsarHash, hash(contents['resources/app.asar']))
        assert.ok(result.urls.includes('release-assets.githubusercontent.com/test-manifest'))
        assert.ok(result.urls.includes('release-assets.githubusercontent.com/test-archive'))
        if (mode === 'fallback') assert.ok(result.urls.includes('github.com/Tony9193/pdf-cross-probe/releases/latest'))
      }
      assert.equal(readFileSync(path.join(target, 'PDF Cross Probe.exe'), 'utf8'), 'old application')
    }
  } finally {
    await app?.close()
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('packaged desktop completes signed download and installation handoff', {
  timeout: 240000, skip: process.platform !== 'win32' || process.env.PDF_TEST_FULL_UPDATE !== '1',
}, async () => {
  const configuration = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const release = path.resolve(configuration.build.directories.output)
  const source = path.join(release, 'win-unpacked')
  const envelope = JSON.parse(readFileSync(path.join(release, 'update-manifest.json'), 'utf8'))
  const archive = path.join(release, envelope.manifest.asset)
  const temporary = mkdtempSync(path.join(tmpdir(), 'PDF 完整更新测试 '))
  const target = path.join(temporary, 'viewer'), profile = path.join(temporary, 'profile')
  cpSync(source, target, { recursive: true })
  writeFileSync(path.join(target, 'local-note.txt'), 'preserve local file')
  const env = { ...process.env, PDF_CROSS_PROBE_MOCK_REGISTRY: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  let runner, statusPath, launchedPid, helperPid
  try {
    mkdirSync(profile)
    const configPath = path.join(temporary, 'driver-config.json')
    const driverStatus = path.join(temporary, 'driver-status.json')
    writeFileSync(configPath, JSON.stringify({ target, profile, envelope, archive, driverStatus }))
    runner = spawn(path.resolve('node_modules/electron/dist/electron.exe'),
      [path.resolve('tests/update-electron-driver.cjs'), configPath], { env, windowsHide: true, stdio: 'ignore' })
    const [exitCode] = await once(runner, 'exit')
    assert.equal(exitCode, 0, existsSync(driverStatus) ? readFileSync(driverStatus, 'utf8') : 'Update driver exited before reporting status')
    runner = null
    const result = JSON.parse(readFileSync(driverStatus, 'utf8'))
    assert.deepEqual(result, { checked: 'available', downloaded: 'ready', installing: 'installing' })
    const jobs = readdirSync(path.join(profile, 'updates')).filter(name => name.startsWith('job-'))
    assert.equal(jobs.length, 1)
    const work = path.join(profile, 'updates', jobs[0])
    statusPath = path.join(work, 'result.json')
    const completion = new Promise((resolve, reject) => {
      let watcher, timer
      const observed = []
      const finish = (error, value) => {
        watcher?.close()
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const check = () => {
        try {
          const value = JSON.parse(readFileSync(statusPath, 'utf8'))
          if (observed.at(-1) !== value.phase) observed.push(value.phase)
          if (['installed', 'rolled-back', 'recovery-needed'].includes(value.phase)) finish(null, value)
        } catch {}
      }
      watcher = watch(work, check)
      timer = setTimeout(() => finish(new Error(`Update installation did not finish: ${JSON.stringify(observed)}`)), 120000)
      check()
    })
    const installed = await completion
    launchedPid = installed.pid
    helperPid = installed.helperPid
    assert.equal(installed.phase, 'installed', JSON.stringify(installed))
    assert.equal(readFileSync(path.join(target, 'local-note.txt'), 'utf8'), 'preserve local file')
    const sessionCheck = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$viewer = Get-Process -Id ${Number(launchedPid)}; $current = Get-Process -Id $PID; if ($viewer.SessionId -eq $current.SessionId) { exit 0 } else { exit 1 }`],
    { stdio: 'ignore', windowsHide: true, timeout: 15000 })
    assert.equal(sessionCheck.status, 0, 'The restarted viewer must remain in the current desktop session')
    const asar = createRequire(import.meta.url)('@electron/asar')
    const installedVersion = JSON.parse(asar.extractFile(path.join(target, 'resources', 'app.asar'), 'package.json').toString('utf8')).version
    assert.equal(installedVersion, configuration.version)
    console.log(JSON.stringify({ signedDownload: 'verified', installerHandoff: 'completed', healthyVersion: installedVersion,
      simulatedPreviousVersion: '1.0.0', preservedLocalFile: true }))
  } finally {
    if (runner && runner.exitCode === null) runner.kill()
    if (!launchedPid && statusPath && existsSync(statusPath)) {
      try {
        const status = JSON.parse(readFileSync(statusPath, 'utf8'))
        launchedPid = status.pid
        helperPid = status.helperPid
      } catch {}
    }
    if (launchedPid) spawnSync('taskkill.exe', ['/PID', String(launchedPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    if (helperPid) spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$helper = Get-Process -Id ${Number(helperPid)} -ErrorAction SilentlyContinue; if ($helper) { $helper.WaitForExit(30000) | Out-Null }`],
    { stdio: 'ignore', windowsHide: true, timeout: 35000 })
    rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  }
})

test('desktop loads PDFs offline and links native windows from a portable path', { timeout: 180000 }, async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['R3501 GND', 'GND']) {
    const drawing = pdf.addPage([640, 800])
    drawing.drawText(label, { x: 100, y: 500, size: 16, font })
  }
  const buffer = Buffer.from(await pdf.save())
  const configuration = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const packaged = process.env.PDF_TEST_EXECUTABLE ? path.resolve(process.env.PDF_TEST_EXECUTABLE)
    : path.resolve(configuration.build.directories.output, 'win-unpacked/PDF Cross Probe.exe')
  if (process.env.PDF_TEST_EXECUTABLE) assert.ok(existsSync(packaged), 'The specified desktop executable does not exist')
  const temporary = mkdtempSync(path.join(tmpdir(), 'PDF 便携测试 '))
  let executablePath
  if (!process.env.PDF_TEST_SOURCE && existsSync(packaged)) {
    const folder = path.join(temporary, 'app')
    cpSync(path.dirname(packaged), folder, { recursive: true })
    executablePath = path.join(folder, 'PDF Cross Probe.exe')
  }
  const env = { ...process.env, PDF_CROSS_PROBE_MOCK_REGISTRY: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  const errors = [], requests = []
  try {
    const args = [...(executablePath ? [] : [path.resolve('.')]), `--user-data-dir=${path.join(temporary, 'profile')}`]
    app = await _electron.launch({ executablePath, args, env, timeout: 60000 })
    const main = await app.firstWindow()
    main.on('pageerror', error => errors.push(error.message))
    main.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()) })
    await main.getByRole('heading', { name: 'PDF 联动查看器', exact: true }).waitFor({ timeout: 30000 })
    assert.equal(await main.evaluate(() => location.origin), 'app://viewer')
    assert.deepEqual(await main.evaluate(() => ({ require: typeof window.require, process: typeof window.process, secure: isSecureContext })),
      { require: 'undefined', process: 'undefined', secure: true })
    assert.equal(await app.evaluate(async ({ app }) => {
      const fs = process.getBuiltinModule('fs').promises, path = process.getBuiltinModule('path')
      const target = path.join(app.getPath('userData'), 'helper-check.ps1')
      await fs.copyFile(path.join(app.getAppPath(), 'electron/install-update.ps1'), target)
      const content = await fs.readFile(target, 'utf8')
      await fs.rm(target)
      return content.startsWith('param(') && content.includes('Encoding]::UTF8')
    }), true)
    for (const slot of [0, 1]) {
      await main.locator(`[data-slot="${slot}"] input[type=file]`).setInputFiles({ name: `中文 图纸 ${slot}.pdf`, mimeType: 'application/pdf', buffer })
      await main.locator(`[data-slot="${slot}"] .pane-status`).filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    }
    const clipboard = process.env.PDF_TEST_OS_CLIPBOARD === '1' ? await app.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read()
      const formats = items.flatMap(item => item.types)
      const textOnly = formats.every(format => format === 'text/plain' || format === 'text/plain;charset=utf-8')
      if (!textOnly) return { formats, text: '', writable: false }
      const text = await clipboard.readText()
      const probe = '__pdf_cross_probe_test__'
      let writable = false
      try {
        await clipboard.writeText(probe)
        writable = (await clipboard.readText()) === probe
      } finally {
        if (formats.length) await clipboard.writeText(text)
        else await clipboard.clear()
      }
      return { formats, text, writable }
    }) : { formats: [], text: '', writable: false }
    await main.bringToFront()
    if (clipboard.writable) {
      try {
        await main.evaluate(() => navigator.clipboard.writeText('clip-perm-ok'))
      } finally {
        await app.evaluate(async ({ clipboard }, backup) => {
          if (backup.formats.length) await clipboard.writeText(backup.text)
          else await clipboard.clear()
        }, clipboard)
      }
    }
    const text = main.locator('[data-slot="0"] .textLayer span').filter({ hasText: /^R3501 GND$/ })
    const bounds = await text.boundingBox()
    await main.waitForFunction(() => document.querySelector('[data-slot="0"] .detail-canvas')?.style.display === 'block')
    await main.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
    await main.mouse.down()
    await main.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 12 })
    await main.mouse.up()
    const selected = await main.evaluate(() => getSelection().toString())
    assert.ok(selected.includes('R3501') && selected.includes('GND'))
    const selectionShot = await text.screenshot()
    const bluePixels = await main.evaluate(async base64 => {
      const img = new Image()
      img.src = `data:image/png;base64,${base64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 2] > data[i] + 30 && data[i + 2] > data[i + 1] + 15) count++
      }
      return count
    }, selectionShot.toString('base64'))
    assert.ok(bluePixels > 20, `Expected visible blue selection pixels in Electron, got ${bluePixels}`)
    if (clipboard.writable) {
      try {
        await main.keyboard.press('Control+c')
        assert.equal(await app.evaluate(async ({ clipboard }) => await clipboard.readText()), selected)
        await main.getByRole('textbox', { name: '关键词', exact: true }).focus()
        await main.keyboard.press('Control+v')
        assert.equal(await main.getByRole('textbox', { name: '关键词', exact: true }).inputValue(), selected)
        await main.getByRole('textbox', { name: '关键词', exact: true }).fill('')
      } finally {
        await app.evaluate(async ({ clipboard }, backup) => { if (backup.formats.length) await clipboard.writeText(backup.text); else await clipboard.clear() }, clipboard)
      }
      console.log(JSON.stringify({ nativeCopyPaste: 'verified-os-clipboard', clipboardRestored: true }))
    } else {
      await main.evaluate(() => {
        window.desktopCopied = ''
        window.desktopPasteFired = false
        document.addEventListener('copy', event => { window.desktopCopied = getSelection().toString(); event.preventDefault() }, { once: true })
        document.addEventListener('paste', event => { window.desktopPasteFired = true; event.preventDefault() }, { once: true })
      })
      await main.keyboard.press('Control+c')
      assert.equal(await main.evaluate(() => window.desktopCopied), selected)
      await main.getByRole('textbox', { name: '关键词', exact: true }).focus()
      await main.keyboard.press('Control+v')
      assert.equal(await main.evaluate(() => window.desktopPasteFired), true)
      console.log(JSON.stringify({ nativeCopyPaste: 'verified-copy-paste-events', preservedHostClipboard: true }))
    }
    await main.evaluate(() => getSelection()?.removeAllRanges())
    const divider = main.getByRole('separator', { name: '调整文档面板大小' })
    const dividerBounds = await divider.boundingBox()
    await main.mouse.move(dividerBounds.x + dividerBounds.width / 2, dividerBounds.y + dividerBounds.height / 2)
    await main.mouse.down()
    await main.mouse.move(dividerBounds.x + 120, dividerBounds.y + dividerBounds.height / 2, { steps: 6 })
    await main.mouse.up()
    assert.ok(Number(await divider.getAttribute('aria-valuenow')) > 50)
    await divider.dblclick()
    assert.equal(await divider.getAttribute('aria-valuenow'), '50')
    const panesBox = await main.locator('.panes').boundingBox()
    await main.waitForFunction(expected => Math.abs(document.querySelector('[data-slot="0"]').getBoundingClientRect().width - expected) < 15, (panesBox.width - 10) / 2)
    const resetDividerBox = await divider.boundingBox()
    await main.mouse.move(resetDividerBox.x + resetDividerBox.width / 2, resetDividerBox.y + resetDividerBox.height / 2)
    await main.mouse.down()
    await main.mouse.move(panesBox.x + panesBox.width - 8, resetDividerBox.y + resetDividerBox.height / 2, { steps: 10 })
    await main.mouse.up()
    const expandB = main.getByRole('button', { name: '展开文档 B' })
    await expandB.waitFor()
    await main.waitForFunction(() => document.querySelector('[data-slot="1"]').getBoundingClientRect().width === 0)
    await expandB.click()
    await main.waitForFunction(expected => Math.abs(document.querySelector('[data-slot="1"]').getBoundingClientRect().width - expected) < 15, (panesBox.width - 10) / 2)
    await main.getByRole('textbox', { name: '关键词', exact: true }).fill('GND')
    await main.getByRole('button', { name: '追加高亮', exact: true }).click()
    await main.locator('[data-slot="0"] .current-hit').first().waitFor()
    assert.equal(await main.locator('[data-position="1:GND"]').textContent(), '1 / 2')
    const secondWindow = app.waitForEvent('window')
    await main.getByRole('button', { name: '双屏窗口', exact: true }).click()
    const secondary = await secondWindow
    secondary.on('pageerror', error => errors.push(error.message))
    await secondary.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(await main.locator('.pdf-pane').count(), 1)
    assert.equal(await secondary.locator('.pdf-pane').count(), 1)
    await secondary.getByTitle('GND · 文档 B · 下一处', { exact: true }).click()
    await main.waitForFunction(() => document.querySelector('[data-position="1:GND"]')?.textContent === '2 / 2')
    const closed = secondary.waitForEvent('close')
    await main.getByRole('button', { name: '恢复双栏', exact: true }).click()
    await closed
    await main.locator('[data-slot="1"] .current-hit').waitFor()
    assert.equal(await main.locator('.pdf-pane').count(), 2)
    const encrypted = await encryptedPdf('1.7ext3')
    await main.locator('[data-slot="0"] input[type=file]').setInputFiles({ name: 'AES256 locked A.pdf', mimeType: 'application/pdf', buffer: encrypted })
    await main.getByLabel('文档 A 密码', { exact: true }).fill('wrong')
    await main.locator('[data-slot="0"]').getByRole('button', { name: '解锁打开', exact: true }).click()
    await main.getByRole('alert').filter({ hasText: '密码错误，请重新输入' }).waitFor()
    await main.getByLabel('文档 A 密码', { exact: true }).fill('1234')
    await main.locator('[data-slot="0"]').getByRole('button', { name: '解锁打开', exact: true }).click()
    await main.locator('[data-slot="0"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    await main.locator('[data-slot="1"] input[type=file]').setInputFiles({ name: 'AES256 locked B.pdf', mimeType: 'application/pdf', buffer: encrypted })
    await main.getByLabel('文档 B 密码', { exact: true }).waitFor()
    await main.locator('[data-slot="1"]').getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await main.locator('[data-slot="1"] .pane-status').textContent(), '未加载')
    await main.locator('[data-slot="1"] input[type=file]').setInputFiles({ name: 'AES256 locked B.pdf', mimeType: 'application/pdf', buffer: encrypted })
    await main.getByLabel('文档 B 密码', { exact: true }).fill('5678')
    await main.locator('[data-slot="1"]').getByRole('button', { name: '解锁打开', exact: true }).click()
    await main.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    const encryptedWindow = app.waitForEvent('window')
    await main.getByRole('button', { name: '双屏窗口', exact: true }).click()
    const unlockedSecondary = await encryptedWindow
    unlockedSecondary.on('pageerror', error => errors.push(error.message))
    await unlockedSecondary.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(await unlockedSecondary.getByLabel('文档 B 密码', { exact: true }).count(), 0)
    const encryptedClosed = unlockedSecondary.waitForEvent('close')
    await main.getByRole('button', { name: '恢复双栏', exact: true }).click()
    await encryptedClosed
    await main.locator('[data-slot="1"] .current-hit').waitFor()
    await main.getByRole('button', { name: '偏好设置' }).click()
    const settingsDialog = main.getByRole('dialog', { name: '偏好设置' })
    await settingsDialog.waitFor()
    assert.ok((await settingsDialog.textContent()).includes('未注册系统关联'))
    await settingsDialog.getByRole('button', { name: '注册右键与打开方式' }).click()
    await main.waitForFunction(() => document.querySelector('.shell-status-badge')?.classList.contains('is-enabled'))
    await settingsDialog.getByRole('button', { name: '取消右键与关联' }).click()
    await main.waitForFunction(() => !document.querySelector('.shell-status-badge')?.classList.contains('is-enabled'))
    await app.evaluate(({ session }) => session.fromPartition('updates').protocol.handle('https', () =>
      new Response(JSON.stringify({ tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [] }), { headers: { 'Content-Type': 'application/json' } })))
    await settingsDialog.getByRole('button', { name: '检查更新', exact: true }).click()
    const updateDialog = main.getByRole('dialog', { name: '软件更新', exact: true })
    await updateDialog.getByRole('status').filter({ hasText: '当前已是最新版本' }).waitFor()
    await updateDialog.getByRole('button', { name: '关闭更新' }).click()
    await app.evaluate(({ session }) => session.fromPartition('updates').protocol.unhandle('https'))
    await settingsDialog.getByRole('button', { name: '关闭设置' }).click()
    await main.evaluate(() => window.open('https://example.com'))
    assert.equal(await main.evaluate(() => window.open('https://example.com') === null), true)
    assert.equal(await main.evaluate(() => fetch('app://viewer/%2e%2e%2fpackage.json').then(response => response.status)), 403)
    assert.deepEqual(requests, [])
    assert.deepEqual(await main.locator('[role=alert]').allTextContents(), [])
    assert.deepEqual(errors, [])
    mkdirSync('artifacts', { recursive: true })
    await main.screenshot({ path: 'artifacts/electron-desktop.png' })
    console.log(JSON.stringify({ packaged: !!executablePath, portablePath: !!temporary, nativeWindows: true, aes256Password: true, retryAndCancel: true, externalRequests: requests.length }))
  } finally {
    await app?.close()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('relaunch creates independent blank windows and external PDF launches route across isolated workspaces', { timeout: 240000 }, async () => {
  const configuration = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const packaged = path.resolve(process.env.PDF_TEST_EXECUTABLE ?? path.join(configuration.build.directories.output, 'win-unpacked/PDF Cross Probe.exe'))
  const executablePath = !process.env.PDF_TEST_SOURCE && existsSync(packaged) ? packaged : undefined
  const temporary = mkdtempSync(path.join(tmpdir(), 'pdf-windows-'))
  const env = { ...process.env, PDF_CROSS_PROBE_MOCK_REGISTRY: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const args = [...(executablePath ? [] : [path.resolve('.')]), `--user-data-dir=${path.join(temporary, 'profile')}`]

  async function writeDrawing(fileName, text) {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([640, 800]).drawText(text, { x: 80, y: 600, size: 16, font })
    const filePath = path.join(temporary, fileName)
    writeFileSync(filePath, await pdf.save())
    return filePath
  }

  function findActiveSelectorWindow(windows) {
    return Promise.any(windows.filter(win => !win.isClosed()).map(async win => {
      await win.getByRole('dialog', { name: '选择打开位置' }).waitFor({ timeout: 15000 })
      return win
    }))
  }

  let app
  try {
    const p1Sch = await writeDrawing('proj1-sch.pdf', 'U101 NET_ALPHA')
    const p1Pcb = await writeDrawing('proj1-pcb.pdf', 'U101 PAD_ALPHA')
    const p2Sch = await writeDrawing('proj2-sch.pdf', 'U202 NET_BETA')
    const p2Pcb = await writeDrawing('proj2-pcb.pdf', 'U202 PAD_BETA')
    const replaceSch = await writeDrawing('replace-sch.pdf', 'U101 REPLACED_ALPHA')

    // Cold start WITH a PDF argument: choosing "新建工作区 · 放入 A" reuses the untouched initial window (no extra orphan window).
    app = await _electron.launch({ executablePath, args: [...args, p1Sch], env, timeout: 60000 })
    const workspace1 = await app.firstWindow()
    await workspace1.getByRole('heading', { name: 'PDF 联动查看器', exact: true }).waitFor()
    const coldModal = workspace1.getByRole('dialog', { name: '选择打开位置' })
    await coldModal.waitFor({ timeout: 15000 })
    assert.ok((await coldModal.textContent()).includes('proj1-sch.pdf'))
    await coldModal.getByRole('button', { name: '新建工作区 · 放入 A' }).click()
    await workspace1.locator('[data-slot="0"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(app.windows().length, 1)
    assert.equal(await workspace1.locator('[data-slot="0"] .pane-header strong').textContent(), 'proj1-sch.pdf')

    const runningExecutable = await app.evaluate(() => process.execPath)

    // Right-click "作为 B 图打开" (--slot=1) for Project 1 PCB -> load into Workspace 1 Slot B.
    assert.equal(spawnSync(runningExecutable, [...args, '--slot=1', p1Pcb], { env, timeout: 30000, windowsHide: true }).status, 0)
    await coldModal.waitFor({ timeout: 15000 })
    assert.ok((await coldModal.textContent()).includes('右键指定 B'))
    await coldModal.getByRole('button', { name: '工作区 1 放入 B' }).click()
    await workspace1.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(await workspace1.locator('[data-slot="1"] .pane-header strong').textContent(), 'proj1-pcb.pdf')

    // Detach B in Workspace 1 and focus the detached B child window.
    const childEvent = app.waitForEvent('window')
    await workspace1.getByRole('button', { name: '双屏窗口', exact: true }).click()
    const child1B = await childEvent
    await child1B.getByRole('heading', { name: 'PDF 联动查看器', exact: true }).waitFor()
    await child1B.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    await child1B.bringToFront()

    // Queue two consecutive single-file external opens (proj2-sch.pdf then proj2-pcb.pdf) without losing the first one.
    assert.equal(spawnSync(runningExecutable, [...args, p2Sch], { env, timeout: 30000, windowsHide: true }).status, 0)
    assert.equal(spawnSync(runningExecutable, [...args, p2Pcb], { env, timeout: 30000, windowsHide: true }).status, 0)

    await coldModal.waitFor({ timeout: 15000 })
    assert.equal(await child1B.getByRole('dialog', { name: '选择打开位置' }).count(), 0)
    assert.ok((await coldModal.textContent()).includes('proj2-sch.pdf'))
    assert.ok((await coldModal.textContent()).includes('双屏 B 已分离'))
    await workspace1.waitForFunction(() => document.querySelector('[aria-label="选择打开位置"]')?.textContent?.includes('还有 1 份待选择'))

    const ws2Event = app.waitForEvent('window')
    await coldModal.getByRole('button', { name: '新建工作区 · 放入 A' }).click()
    const workspace2 = await ws2Event
    await workspace2.getByRole('heading', { name: 'PDF 联动查看器', exact: true }).waitFor()
    await workspace2.locator('[data-slot="0"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(await workspace2.locator('[data-slot="0"] .pane-header strong').textContent(), 'proj2-sch.pdf')

    // Second queued file (proj2-pcb.pdf) automatically advances; put it into Workspace 2 Slot B.
    const hostForP2B = await findActiveSelectorWindow([workspace1, workspace2])
    const modalP2B = hostForP2B.getByRole('dialog', { name: '选择打开位置' })
    assert.ok((await modalP2B.textContent()).includes('proj2-pcb.pdf'))
    assert.ok((await modalP2B.textContent()).includes('proj2-sch.pdf'))
    await modalP2B.getByRole('button', { name: '工作区 2 放入 B' }).click()
    await workspace2.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(await workspace2.locator('[data-slot="1"] .pane-header strong').textContent(), 'proj2-pcb.pdf')

    // Verify 4 PDFs across 2 independent A/B workspaces: linked within each pair, completely isolated across workspaces!
    await workspace1.getByRole('textbox', { name: '关键词', exact: true }).fill('U101')
    await workspace1.getByRole('button', { name: '追加高亮', exact: true }).click()
    await workspace1.waitForFunction(() => document.querySelector('[data-position="0:U101"]')?.textContent === '1 / 1')
    await child1B.waitForFunction(() => document.querySelector('[data-position="1:U101"]')?.textContent === '1 / 1')
    assert.equal(await workspace2.locator('.term-result').count(), 0)

    await workspace2.getByRole('textbox', { name: '关键词', exact: true }).fill('U202')
    await workspace2.getByRole('button', { name: '追加高亮', exact: true }).click()
    await workspace2.waitForFunction(() => document.querySelector('[data-position="0:U202"]')?.textContent === '1 / 1')
    await workspace2.waitForFunction(() => document.querySelector('[data-position="1:U202"]')?.textContent === '1 / 1')
    assert.equal(await workspace1.locator('.term-result').count(), 1)
    assert.equal(await workspace1.locator('[data-position="0:U202"]').count(), 0)

    // Replacement confirmation + cancel preserves original file; explicit target works even when another workspace had focus.
    await workspace2.bringToFront()
    assert.equal(spawnSync(runningExecutable, [...args, replaceSch], { env, timeout: 30000, windowsHide: true }).status, 0)
    const hostReplace1 = await findActiveSelectorWindow([workspace1, workspace2])
    const modalReplace1 = hostReplace1.getByRole('dialog', { name: '选择打开位置' })
    await modalReplace1.getByRole('button', { name: '工作区 1 替换 A' }).click()
    assert.ok((await modalReplace1.textContent()).includes('proj1-sch.pdf'))
    assert.ok((await modalReplace1.textContent()).includes('replace-sch.pdf'))
    await modalReplace1.getByRole('button', { name: '返回重选' }).click()
    await modalReplace1.getByRole('button', { name: '取消本次打开' }).click()
    await hostReplace1.waitForFunction(() => !document.querySelector('[aria-label="选择打开位置"]'))
    assert.equal(await workspace1.locator('[data-slot="0"] .pane-header strong').textContent(), 'proj1-sch.pdf')

    // Confirm replacement into Workspace 1 Slot A while Workspace 2 remains untouched.
    assert.equal(spawnSync(runningExecutable, [...args, replaceSch], { env, timeout: 30000, windowsHide: true }).status, 0)
    const hostReplace2 = await findActiveSelectorWindow([workspace1, workspace2])
    const modalReplace2 = hostReplace2.getByRole('dialog', { name: '选择打开位置' })
    await modalReplace2.getByRole('button', { name: '工作区 1 替换 A' }).click()
    await modalReplace2.getByRole('button', { name: '确认替换' }).click()
    await workspace1.waitForFunction(() => document.querySelector('[data-slot="0"] .pane-header strong')?.textContent === 'replace-sch.pdf')
    await workspace1.locator('[data-slot="0"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(await workspace2.locator('[data-slot="0"] .pane-header strong').textContent(), 'proj2-sch.pdf')

    // Relaunch with no arguments still creates an independent blank workspace.
    const blankEvent = app.waitForEvent('window')
    assert.equal(spawnSync(runningExecutable, args, { env, timeout: 30000, windowsHide: true }).status, 0)
    const workspace3 = await blankEvent
    await workspace3.getByRole('heading', { name: 'PDF 联动查看器', exact: true }).waitFor()
    assert.equal(await workspace3.getByRole('heading', { name: '尚未打开 PDF' }).count(), 2)

    // Closing the host window while an external open request is pending migrates the selector to a surviving main window.
    await workspace3.bringToFront()
    assert.equal(spawnSync(runningExecutable, [...args, p1Sch], { env, timeout: 30000, windowsHide: true }).status, 0)
    await workspace3.getByRole('dialog', { name: '选择打开位置' }).waitFor({ timeout: 15000 })
    await workspace3.close()
    const migratedHost = await findActiveSelectorWindow([workspace1, workspace2])
    await migratedHost.getByRole('dialog', { name: '选择打开位置' }).getByRole('button', { name: '取消本次打开' }).click()
    await migratedHost.waitForFunction(() => !document.querySelector('[aria-label="选择打开位置"]'))

    // Unreadable external PDF reports error without opening a selector or disturbing loaded drawings.
    assert.equal(spawnSync(runningExecutable, [...args, path.join(temporary, 'missing-file.pdf')], { env, timeout: 30000, windowsHide: true }).status, 0)
    await migratedHost.getByRole('alert').filter({ hasText: '无法读取指定 PDF 文件' }).waitFor({ timeout: 15000 })
    assert.equal(await workspace1.locator('[data-slot="0"] .pane-header strong').textContent(), 'replace-sch.pdf')
    assert.equal(await workspace2.locator('[data-slot="0"] .pane-header strong').textContent(), 'proj2-sch.pdf')

    // Closing Workspace 1 closes its detached B child window while Workspace 2 stays open and independent.
    const childClosed = child1B.waitForEvent('close')
    await workspace1.close()
    await childClosed
    assert.equal(workspace2.isClosed(), false)
    assert.equal(await workspace2.locator('[data-slot="0"] .pane-header strong').textContent(), 'proj2-sch.pdf')
    assert.equal(await workspace2.locator('[data-slot="1"] .pane-header strong').textContent(), 'proj2-pcb.pdf')

    // Paired 2-file external launch opens A + B together into a newly chosen workspace.
    assert.equal(spawnSync(runningExecutable, [...args, p1Sch, p1Pcb], { env, timeout: 30000, windowsHide: true }).status, 0)
    await workspace2.getByRole('dialog', { name: '选择打开位置' }).waitFor({ timeout: 15000 })
    assert.ok((await workspace2.getByRole('dialog', { name: '选择打开位置' }).textContent()).includes('A：proj1-sch.pdf · B：proj1-pcb.pdf'))
    const pairedWinEvent = app.waitForEvent('window')
    await workspace2.getByRole('dialog', { name: '选择打开位置' }).getByRole('button', { name: '新建工作区并载入 A + B' }).click()
    const pairedWorkspace = await pairedWinEvent
    await pairedWorkspace.locator('[data-slot="0"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    await pairedWorkspace.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(await pairedWorkspace.locator('[data-slot="0"] .pane-header strong').textContent(), 'proj1-sch.pdf')
    assert.equal(await pairedWorkspace.locator('[data-slot="1"] .pane-header strong').textContent(), 'proj1-pcb.pdf')

    await workspace2.bringToFront()
    const collapsedDivider = await workspace2.getByRole('separator', { name: '调整文档面板大小' }).boundingBox()
    const workspaceBounds = await workspace2.locator('.panes').boundingBox()
    await workspace2.mouse.move(collapsedDivider.x + collapsedDivider.width / 2, collapsedDivider.y + collapsedDivider.height / 2)
    await workspace2.mouse.down()
    await workspace2.mouse.move(workspaceBounds.x + workspaceBounds.width - 8, collapsedDivider.y + collapsedDivider.height / 2, { steps: 10 })
    await workspace2.mouse.up()
    await workspace2.waitForFunction(() => document.querySelector('[data-slot="1"]').getBoundingClientRect().width === 0)
    assert.equal(spawnSync(runningExecutable, [...args, replaceSch], { env, timeout: 30000, windowsHide: true }).status, 0)
    const collapsedReplacement = workspace2.getByRole('dialog', { name: '选择打开位置' })
    await collapsedReplacement.waitFor({ timeout: 15000 })
    await collapsedReplacement.getByRole('button', { name: '工作区 2 替换 B', exact: true }).click()
    await collapsedReplacement.getByRole('button', { name: '确认替换', exact: true }).click()
    await workspace2.waitForFunction(() => document.querySelector('[data-slot="1"] .pane-header strong')?.textContent === 'replace-sch.pdf' &&
      document.querySelector('[data-slot="1"]').getBoundingClientRect().width > 100)
    await workspace2.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(await workspace2.locator('[data-slot="0"] .pane-header strong').textContent(), 'proj2-sch.pdf')

    // >2 files in one launch are queued sequentially in order without silently dropping the 3rd file.
    assert.equal(spawnSync(runningExecutable, [...args, p1Sch, p1Pcb, replaceSch], { env, timeout: 30000, windowsHide: true }).status, 0)
    for (const expectedCount of ['还有 2 份待选择', '还有 1 份待选择', 'replace-sch.pdf']) {
      const host = await findActiveSelectorWindow([workspace2, pairedWorkspace])
      const dialog = host.getByRole('dialog', { name: '选择打开位置' })
      assert.ok((await dialog.textContent()).includes(expectedCount))
      await dialog.getByRole('button', { name: '取消本次打开' }).click()
    }
  } finally {
    await app?.close()
    rmSync(temporary, { recursive: true, force: true })
  }
})