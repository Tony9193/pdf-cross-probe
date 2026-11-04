const { app, BrowserWindow, dialog, protocol, session } = require('electron')
const { readFile } = require('node:fs/promises')
const path = require('node:path')

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true,
} }])

const origin = 'app://viewer'
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
  '.json': 'application/json', '.bcmap': 'application/octet-stream', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream' }
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
let mainWindow
let closing = false
const secondaryWindows = new Set()

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
}

app.whenReady().then(async () => {
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
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: /^(https?|wss?|ftp):/i.test(details.url) })
  })
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600,
    title: 'PDF Cross Probe', backgroundColor: '#f4f6f5', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
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
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } } }
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