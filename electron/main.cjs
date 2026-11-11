const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } = require('electron')
const { execFile } = require('node:child_process')
const { existsSync } = require('node:fs')
const { readFile } = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true,
} }])

const origin = 'app://viewer'
const progId = 'PDFCrossProbe.Document'
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
  '.json': 'application/json', '.bcmap': 'application/octet-stream', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream' }
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
let mainWindow
let closing = false
const secondaryWindows = new Set()
const pendingLaunchBatches = []

function parseLaunchArgv(argv, cwd = process.cwd()) {
  let targetSlot = null
  const files = []
  for (const raw of argv) {
    if (!raw || typeof raw !== 'string') continue
    if (raw === '--slot=0' || raw === '--slot=a' || raw === '--slot=A') { targetSlot = 0; continue }
    if (raw === '--slot=1' || raw === '--slot=b' || raw === '--slot=B') { targetSlot = 1; continue }
    if (raw.startsWith('-')) continue
    const cleaned = raw.replace(/^"+|"+$/g, '')
    if (!cleaned.toLowerCase().endsWith('.pdf')) continue
    const resolved = path.resolve(cwd, cleaned)
    if (existsSync(resolved)) files.push(resolved)
  }
  return { targetSlot, files }
}

async function enqueueLaunchFiles(argv, cwd = process.cwd()) {
  const { targetSlot, files } = parseLaunchArgv(argv, cwd)
  if (!files.length) return
  const loaded = []
  for (const filePath of files.slice(0, 2)) {
    try {
      const body = await readFile(filePath)
      loaded.push({ name: path.basename(filePath), bytes: new Uint8Array(body) })
    } catch { /* ignore unreadable external file */ }
  }
  if (!loaded.length) return
  const payload = { targetSlot, files: loaded }
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.send('desktop:launch-files', payload)
  } else {
    pendingLaunchBatches.push(payload)
  }
}

function launchCommandPrefix() {
  if (app.isPackaged) return `"${process.execPath}"`
  return `"${process.execPath}" "${path.resolve(app.getAppPath())}"`
}

async function queryShellIntegration() {
  if (process.platform !== 'win32') return { supported: false, enabled: false, executablePath: process.execPath }
  if (process.env.PDF_CROSS_PROBE_MOCK_REGISTRY === '1') {
    return { supported: true, enabled: globalThis.__mockShellEnabled === true, executablePath: process.execPath }
  }
  try {
    await execFileAsync('reg.exe', ['query', `HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`], { windowsHide: true })
    return { supported: true, enabled: true, executablePath: process.execPath }
  } catch {
    return { supported: true, enabled: false, executablePath: process.execPath }
  }
}

async function updateShellIntegration(enabled) {
  if (process.platform !== 'win32') return { supported: false, enabled: false, executablePath: process.execPath }
  if (process.env.PDF_CROSS_PROBE_MOCK_REGISTRY === '1') {
    globalThis.__mockShellEnabled = Boolean(enabled)
    return { supported: true, enabled: globalThis.__mockShellEnabled, executablePath: process.execPath }
  }
  const cmdPrefix = launchCommandPrefix()
  const exeName = path.basename(process.execPath)
  const addKey = (key, valueName, type, data) => {
    const args = ['add', key]
    if (valueName === '') args.push('/ve')
    else args.push('/v', valueName)
    args.push('/t', type, '/d', data, '/f')
    return execFileAsync('reg.exe', args, { windowsHide: true })
  }
  const removeKey = key => execFileAsync('reg.exe', ['delete', key, '/f'], { windowsHide: true }).catch(() => {})
  if (enabled) {
    await addKey(`HKCU\\Software\\Classes\\${progId}`, '', 'REG_SZ', 'PDF 联动查看器文档')
    await addKey(`HKCU\\Software\\Classes\\${progId}`, 'FriendlyTypeName', 'REG_SZ', 'PDF 联动查看器')
    await addKey(`HKCU\\Software\\Classes\\${progId}\\DefaultIcon`, '', 'REG_SZ', `"${process.execPath}",0`)
    await addKey(`HKCU\\Software\\Classes\\${progId}\\shell\\open`, '', 'REG_SZ', '用 PDF 联动查看器打开')
    await addKey(`HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, '', 'REG_SZ', `${cmdPrefix} "%1"`)
    await addKey(`HKCU\\Software\\Classes\\Applications\\${exeName}`, 'FriendlyAppName', 'REG_SZ', 'PDF 联动查看器 (PDF Cross Probe)')
    await addKey(`HKCU\\Software\\Classes\\Applications\\${exeName}\\SupportedTypes`, '.pdf', 'REG_SZ', '')
    await addKey(`HKCU\\Software\\Classes\\Applications\\${exeName}\\shell\\open\\command`, '', 'REG_SZ', `${cmdPrefix} "%1"`)
    await addKey('HKCU\\Software\\Classes\\.pdf\\OpenWithProgids', progId, 'REG_NONE', '')
    const menus = [
      ['PDFCrossProbe.Open', '用 PDF 联动查看器打开', `${cmdPrefix} "%1"`],
      ['PDFCrossProbe.OpenA', '用 PDF 联动查看器作为 A 图打开', `${cmdPrefix} --slot=0 "%1"`],
      ['PDFCrossProbe.OpenB', '用 PDF 联动查看器作为 B 图打开', `${cmdPrefix} --slot=1 "%1"`],
    ]
    for (const [keyName, title, command] of menus) {
      const base = `HKCU\\Software\\Classes\\SystemFileAssociations\\.pdf\\shell\\${keyName}`
      await addKey(base, '', 'REG_SZ', title)
      await addKey(base, 'Icon', 'REG_SZ', `"${process.execPath}",0`)
      await addKey(`${base}\\command`, '', 'REG_SZ', command)
    }
  } else {
    await removeKey(`HKCU\\Software\\Classes\\${progId}`)
    await removeKey(`HKCU\\Software\\Classes\\Applications\\${exeName}`)
    await execFileAsync('reg.exe', ['delete', 'HKCU\\Software\\Classes\\.pdf\\OpenWithProgids', '/v', progId, '/f'], { windowsHide: true }).catch(() => {})
    for (const keyName of ['PDFCrossProbe.Open', 'PDFCrossProbe.OpenA', 'PDFCrossProbe.OpenB']) {
      await removeKey(`HKCU\\Software\\Classes\\SystemFileAssociations\\.pdf\\shell\\${keyName}`)
    }
  }
  return queryShellIntegration()
}

function viewerOrigin(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'app:' && url.hostname === 'viewer'
  } catch { return false }
}

function viewerUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'app:' && url.hostname === 'viewer' && url.pathname === '/index.html'
  } catch { return false }
}

function secureWindow(window) {
  window.setMenu(null)
  window.webContents.on('will-navigate', (event, url) => { if (!viewerUrl(url)) event.preventDefault() })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.trim().length > 0
    if (!params.isEditable && !hasSelection) return
    const template = params.isEditable ? [
      { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: '全选', role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ] : [
      { label: '复制', role: 'copy', enabled: params.editFlags.canCopy || hasSelection },
    ]
    Menu.buildFromTemplate(template).popup({ window })
  })
}

function isClipboardPermission(permission, urlOrOrigin) {
  return viewerOrigin(urlOrOrigin) && (
    permission === 'clipboard-sanitized-write' ||
    permission === 'clipboard-write' ||
    permission === 'clipboard-read'
  )
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', (_event, commandLine, workingDirectory) => {
  void enqueueLaunchFiles(commandLine.slice(app.isPackaged ? 1 : 2), workingDirectory || process.cwd())
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

ipcMain.handle('desktop:consume-launch-queue', () => pendingLaunchBatches.splice(0, pendingLaunchBatches.length))
ipcMain.handle('desktop:get-shell-status', () => queryShellIntegration())
ipcMain.handle('desktop:set-shell-integration', (_event, enabled) => updateShellIntegration(Boolean(enabled)))

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return
  const preloadPath = path.join(__dirname, 'preload.cjs')
  await enqueueLaunchFiles(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd())
  const root = path.join(app.getAppPath(), 'dist')
  protocol.handle('app', async request => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'viewer' || request.method !== 'GET') return new Response(null, { status: 403 })
      const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`)
      const relative = path.relative(root, file)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return new Response(null, { status: 403 })
      const body = await readFile(file)
      return new Response(body, { headers: {
        'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream',
        'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff',
      } })
    } catch { return new Response(null, { status: 404 }) }
  })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isClipboardPermission(permission, details?.requestingUrl || contents?.getURL() || ''))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return isClipboardPermission(permission, requestingOrigin || details?.requestingUrl || contents?.getURL() || '')
  })
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: /^(https?|wss?|ftp):/i.test(details.url) })
  })
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600,
    title: 'PDF Cross Probe', backgroundColor: '#f4f6f5', show: false,
    webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
  secureWindow(mainWindow)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!viewerUrl(url)) return { action: 'deny' }
    const requested = new URL(url), current = new URL(mainWindow.webContents.getURL())
    if (requested.searchParams.get('panel') !== 'right' || requested.searchParams.get('session') !== current.searchParams.get('session')) return { action: 'deny' }
    for (const existing of secondaryWindows) {
      if (!existing.isDestroyed()) { existing.focus(); return { action: 'deny' } }
    }
    return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 850, minWidth: 640, minHeight: 480,
      title: 'PDF Cross Probe - B', backgroundColor: '#f4f6f5',
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } } }
  })
  mainWindow.webContents.on('did-create-window', secondary => {
    secondaryWindows.add(secondary)
    secureWindow(secondary)
    secondary.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    secondary.on('closed', () => secondaryWindows.delete(secondary))
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', () => { closing = true; for (const secondary of secondaryWindows) if (!secondary.isDestroyed()) secondary.close() })
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    if (!closing && code !== -3) console.error(`Unable to load the viewer: ${description}`)
  })
  await mainWindow.loadURL(`${origin}/index.html`)
}).catch(error => { if (!closing) { console.error(error); dialog.showErrorBox('PDF Cross Probe', String(error)) } app.quit() })

app.on('before-quit', () => { closing = true })
app.on('window-all-closed', () => app.quit())