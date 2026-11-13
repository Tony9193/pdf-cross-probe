const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { app, net, session } = require('electron')

const fixture = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'))
app.setPath('userData', fixture.profile)

app.whenReady().then(async () => {
  const connection = session.fromPartition('updates')
  connection.protocol.handle('https', request => {
    const url = new URL(request.url), manifest = fixture.envelope.manifest
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases/latest')) {
      const base = `https://github.com/Tony9193/pdf-cross-probe/releases/download/v${manifest.version}`
      return new Response(JSON.stringify({ tag_name: `v${manifest.version}`, draft: false, prerelease: false, assets: [
        { name: 'update-manifest.json', state: 'uploaded', size: 100000, browser_download_url: `${base}/update-manifest.json` },
        { name: manifest.asset, state: 'uploaded', size: manifest.size, digest: `sha256:${manifest.sha256}`,
          browser_download_url: `${base}/${manifest.asset}` },
      ] }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (url.hostname === 'github.com' && url.pathname.endsWith('/update-manifest.json')) {
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/test-manifest' } })
    }
    if (url.hostname === 'release-assets.githubusercontent.com' && url.pathname === '/test-manifest') {
      return new Response(JSON.stringify(fixture.envelope), { headers: { 'Content-Type': 'application/json' } })
    }
    if (url.hostname === 'github.com' && url.pathname.endsWith('.zip')) {
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/test-archive' } })
    }
    if (url.hostname === 'release-assets.githubusercontent.com' && url.pathname === '/test-archive') {
      return new Response(Readable.toWeb(fs.createReadStream(fixture.archive)))
    }
    return new Response('Unexpected request', { status: 404 })
  })
  const packaged = path.join(fixture.target, 'resources', 'app.asar')
  const { createUpdater, createElectronFetch } = require(path.join(packaged, 'dist', 'desktop', 'updater.cjs'))
  const updater = createUpdater({ version: '1.0.0', packaged: true, platform: 'win32', arch: 'x64',
    userData: fixture.profile, executablePath: path.join(fixture.target, 'PDF Cross Probe.exe'),
    helperPath: path.join(packaged, 'electron', 'install-update.ps1'), fetch: createElectronFetch(net, connection),
    onInstall: () => setImmediate(() => app.quit()) })
  const checked = await updater.check(true)
  if (checked.phase !== 'available') throw new Error(`Update check: ${checked.phase}`)
  const downloaded = await updater.download()
  if (downloaded.phase !== 'ready') throw new Error(`Update download: ${downloaded.phase}`)
  const installing = await updater.install()
  if (installing.phase !== 'installing') throw new Error(`Update install: ${installing.phase}`)
  fs.writeFileSync(fixture.driverStatus, JSON.stringify({ checked: checked.phase, downloaded: downloaded.phase, installing: installing.phase }))
}).catch(error => {
  fs.writeFileSync(fixture.driverStatus, JSON.stringify({ error: error.message }))
  app.exit(1)
})