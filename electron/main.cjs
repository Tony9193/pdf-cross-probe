const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } = require('electron')
const { execFile } = require('node:child_process')
const { open, readFile } = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')

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
let closing = false
let updateCleanupComplete = false
let lastFocusedMainWindow
let updater
let nextWorkspaceNumber = 1
const mainWindows = new Map()
const windowOwners = new Map()
const externalOpenQueue = []
let activeExternalOpen = null

function emptySlots() {
  return [
    { status: 'empty', id: '', name: '' },
    { status: 'empty', id: '', name: '' },
  ]
}

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
    files.push(resolved)
  }
  return { targetSlot, files }
}

function deliverPayloadToWindow(target, payload, focusWindow = true) {
  if (!target || target.isDestroyed()) target = createMainWindow()
  const context = mainWindows.get(target)
  if (!context) return
  if (context.ready) target.webContents.send('desktop:launch-files', payload)
  else context.queue.push(payload)
  if (focusWindow) {
    if (target.isMinimized()) target.restore()
    target.focus()
    lastFocusedMainWindow = target
  }
}

function pickHostMainWindow(preferred = lastFocusedMainWindow) {
  if (preferred && !preferred.isDestroyed() && mainWindows.get(preferred) && !mainWindows.get(preferred).closing) return preferred
  for (const [window, context] of mainWindows.entries()) {
    if (!window.isDestroyed() && !context.closing) return window
  }
  return createMainWindow()
}

function listWorkspaceSummaries(hostWindow) {
  const summaries = []
  for (const [window, context] of mainWindows.entries()) {
    if (window.isDestroyed() || context.closing) continue
    summaries.push({
      sessionId: context.sessionId,
      workspaceNumber: context.workspaceNumber,
      isCurrent: window === hostWindow,
      separated: [...context.children].some(child => !child.isDestroyed()),
      slots: context.slots.map(slot => ({ status: slot.status, id: slot.id, name: slot.name })),
    })
  }
  return summaries
}

function buildExternalOpenView(request = activeExternalOpen) {
  if (!request || !request.ready || !request.hostWindow || request.hostWindow.isDestroyed()) return null
  const pendingCount = externalOpenQueue.filter(item => item !== request).length
  return {
    requestId: request.requestId,
    token: request.token,
    files: request.files.map(item => ({ name: item.name })),
    preferredSlot: request.preferredSlot,
    paired: request.paired,
    queueRemaining: pendingCount,
    workspaces: listWorkspaceSummaries(request.hostWindow),
  }
}

function sendExternalOpenView(window = activeExternalOpen?.hostWindow) {
  if (!window || window.isDestroyed()) return
  const context = mainWindows.get(window)
  if (!context || !context.ready || context.closing) return
  const payload = activeExternalOpen?.hostWindow === window ? buildExternalOpenView(activeExternalOpen) : null
  window.webContents.send('desktop:external-open-request', payload)
}

function pumpExternalOpenQueue(preferredHost = lastFocusedMainWindow) {
  if (closing || updater?.getStatus().phase === 'installing') return
  if (activeExternalOpen) {
    if (!activeExternalOpen.hostWindow || activeExternalOpen.hostWindow.isDestroyed() || mainWindows.get(activeExternalOpen.hostWindow)?.closing) {
      if (mainWindows.size === 0) {
        externalOpenQueue.length = 0
        activeExternalOpen = null
        return
      }
      activeExternalOpen.hostWindow = pickHostMainWindow(preferredHost)
      activeExternalOpen.token = randomUUID()
      activeExternalOpen.processing = false
      if (activeExternalOpen.ready) {
        if (activeExternalOpen.hostWindow.isMinimized()) activeExternalOpen.hostWindow.restore()
        activeExternalOpen.hostWindow.focus()
        sendExternalOpenView(activeExternalOpen.hostWindow)
      }
    } else if (activeExternalOpen.ready) {
      sendExternalOpenView(activeExternalOpen.hostWindow)
    }
    return
  }
  while (externalOpenQueue.length > 0) {
    const candidate = externalOpenQueue[0]
    if (!candidate.checked) return
    if (candidate.error) {
      externalOpenQueue.shift()
      const target = pickHostMainWindow(candidate.preferredHost ?? preferredHost)
      deliverPayloadToWindow(target, { targetSlot: null, files: [], error: candidate.error }, true)
      continue
    }
    activeExternalOpen = candidate
    activeExternalOpen.hostWindow = pickHostMainWindow(candidate.preferredHost ?? preferredHost)
    activeExternalOpen.token = randomUUID()
    activeExternalOpen.ready = true
    activeExternalOpen.processing = false
    if (activeExternalOpen.hostWindow.isMinimized()) activeExternalOpen.hostWindow.restore()
    activeExternalOpen.hostWindow.focus()
    lastFocusedMainWindow = activeExternalOpen.hostWindow
    sendExternalOpenView(activeExternalOpen.hostWindow)
    return
  }
}

async function checkReadablePdf(filePath) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const stat = await handle.stat()
    return stat.isFile()
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function enqueueLaunchFiles(argv, cwd = process.cwd(), preferredHost = lastFocusedMainWindow) {
  const { targetSlot, files } = parseLaunchArgv(argv, cwd)
  if (!files.length) return
  const bounded = files.slice(0, 20)
  const descriptors = bounded.length === 2 && targetSlot === null
    ? [{
        requestId: randomUUID(),
        token: '',
        files: bounded.map(filePath => ({ path: filePath, name: path.basename(filePath) })),
        preferredSlot: null,
        paired: true,
        checked: false,
        ready: false,
        processing: false,
        error: '',
        preferredHost,
        hostWindow: null,
      }]
    : bounded.map(filePath => ({
        requestId: randomUUID(),
        token: '',
        files: [{ path: filePath, name: path.basename(filePath) }],
        preferredSlot: targetSlot,
        paired: false,
        checked: false,
        ready: false,
        processing: false,
        error: '',
        preferredHost,
        hostWindow: null,
      }))
  externalOpenQueue.push(...descriptors)
  for (const descriptor of descriptors) {
    const checks = await Promise.all(descriptor.files.map(item => checkReadablePdf(item.path)))
    if (!checks.every(Boolean)) descriptor.error = '无法读取指定 PDF 文件'
    descriptor.checked = true
    pumpExternalOpenQueue(preferredHost)
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
  if (closing || updater?.getStatus().phase === 'installing') return
  const args = commandLine.slice(app.isPackaged ? 1 : 2)
  if (!parseLaunchArgv(args, workingDirectory).files.length) createMainWindow()
  else void enqueueLaunchFiles(args, workingDirectory || process.cwd()).catch(() => {})
})

function handleViewerIPC(name, callback) {
  ipcMain.handle(name, (event, ...args) => {
    const owner = windowOwners.get(event.sender.id)
    const context = owner && mainWindows.get(owner)
    if (!context || event.senderFrame !== event.sender.mainFrame || !viewerUrl(event.senderFrame.url) ||
      new URL(event.senderFrame.url).searchParams.get('session') !== context.sessionId) throw new Error('Untrusted viewer request')
    return callback(owner, event, ...args)
  })
}

handleViewerIPC('desktop:consume-launch-queue', owner => {
  const context = mainWindows.get(owner)
  context.ready = true
  void updater?.acknowledge()
  if (activeExternalOpen?.hostWindow === owner) setImmediate(() => sendExternalOpenView(owner))
  return context.queue.splice(0)
})
handleViewerIPC('desktop:report-workspace', (owner, event, rawSlots) => {
  if (event.sender !== owner.webContents) throw new Error('Untrusted workspace state sender')
  if (!Array.isArray(rawSlots) || rawSlots.length !== 2) throw new Error('Invalid workspace slots')
  const context = mainWindows.get(owner)
  const allowedStatuses = new Set(['empty', 'loading', 'password', 'ready'])
  context.slots = rawSlots.map(raw => {
    const status = allowedStatuses.has(raw?.status) ? raw.status : 'empty'
    if (status === 'empty') return { status: 'empty', id: '', name: '' }
    return {
      status,
      id: String(raw?.id ?? '').slice(0, 128),
      name: path.basename(String(raw?.name ?? '')).slice(0, 260),
    }
  })
  if (context.slots.some(slot => slot.status !== 'empty')) context.initialColdStart = false
  if (activeExternalOpen?.ready) sendExternalOpenView(activeExternalOpen.hostWindow)
})
handleViewerIPC('desktop:get-external-open', (owner, event) => {
  if (event.sender !== owner.webContents) return null
  return activeExternalOpen?.hostWindow === owner ? buildExternalOpenView(activeExternalOpen) : null
})
handleViewerIPC('desktop:resolve-external-open', async (owner, event, decision) => {
  if (event.sender !== owner.webContents) throw new Error('Untrusted external open resolver')
  if (!decision || typeof decision !== 'object') throw new Error('Invalid external open decision')
  const current = activeExternalOpen
  if (!current || !current.ready || current.hostWindow !== owner ||
    current.requestId !== decision.requestId || current.token !== decision.token || current.processing) {
    return { ok: false, reason: 'stale', request: current?.hostWindow === owner ? buildExternalOpenView(current) : null }
  }
  if (decision.action === 'cancel') {
    const index = externalOpenQueue.indexOf(current)
    if (index >= 0) externalOpenQueue.splice(index, 1)
    activeExternalOpen = null
    sendExternalOpenView(owner)
    pumpExternalOpenQueue(owner)
    return { ok: true }
  }
  if (decision.action !== 'open') throw new Error('Invalid external open action')
  const slot = current.paired ? null : (decision.slot === 1 ? 1 : decision.slot === 0 ? 0 : null)
  if (!current.paired && slot === null) throw new Error('Invalid external open slot')
  const affectedSlots = current.paired ? [0, 1] : [slot]
  current.processing = true
  let targetWindow = null
  let createdNewWindow = false
  const ownerContext = mainWindows.get(owner)
  if (decision.target === 'new') {
    if (ownerContext?.initialColdStart && mainWindows.size === 1 && ownerContext.slots.every(item => item.status === 'empty' && !item.id)) {
      ownerContext.initialColdStart = false
      targetWindow = owner
    } else {
      targetWindow = createMainWindow()
      createdNewWindow = true
    }
  } else if (decision.target && typeof decision.target === 'object' && typeof decision.target.sessionId === 'string') {
    for (const [window, context] of mainWindows.entries()) {
      if (context.sessionId === decision.target.sessionId && !window.isDestroyed() && !context.closing) {
        targetWindow = window
        break
      }
    }
    if (!targetWindow) {
      current.processing = false
      current.token = randomUUID()
      const nextView = buildExternalOpenView(current)
      sendExternalOpenView(owner)
      return { ok: false, reason: 'target-closed', message: '所选工作区已关闭，请重新选择打开位置', request: nextView }
    }
    const targetContext = mainWindows.get(targetWindow)
    const expected = Array.isArray(decision.target.expectedSlotIds) ? decision.target.expectedSlotIds : []
    const mismatch = affectedSlots.some(index => (targetContext.slots[index].status === 'empty' ? '' : targetContext.slots[index].id) !== String(expected[index] ?? ''))
    if (mismatch) {
      current.processing = false
      current.token = randomUUID()
      const nextView = buildExternalOpenView(current)
      sendExternalOpenView(owner)
      return { ok: false, reason: 'slot-changed', message: '目标面板的图纸已发生变化，请确认最新状态后再操作', request: nextView }
    }
  } else {
    current.processing = false
    throw new Error('Invalid external open target')
  }

  const loaded = []
  try {
    for (const item of current.files) {
      const body = await readFile(item.path)
      loaded.push({ id: randomUUID(), name: item.name, bytes: new Uint8Array(body) })
    }
  } catch {
    if (createdNewWindow && targetWindow && !targetWindow.isDestroyed()) targetWindow.close()
    const index = externalOpenQueue.indexOf(current)
    if (index >= 0) externalOpenQueue.splice(index, 1)
    activeExternalOpen = null
    sendExternalOpenView(owner)
    deliverPayloadToWindow(owner, { targetSlot: null, files: [], error: '无法读取指定 PDF 文件' }, false)
    pumpExternalOpenQueue(owner)
    return { ok: false, reason: 'read-error', message: '无法读取指定 PDF 文件' }
  }

  if (!targetWindow || targetWindow.isDestroyed() || mainWindows.get(targetWindow)?.closing) {
    current.processing = false
    current.token = randomUUID()
    const nextView = buildExternalOpenView(current)
    sendExternalOpenView(owner)
    return { ok: false, reason: 'target-closed', message: '所选工作区已关闭，请重新选择打开位置', request: nextView }
  }

  const targetContext = mainWindows.get(targetWindow)
  targetContext.initialColdStart = false
  if (current.paired) {
    targetContext.slots[0] = { status: 'loading', id: loaded[0].id, name: loaded[0].name }
    targetContext.slots[1] = { status: 'loading', id: loaded[1].id, name: loaded[1].name }
  } else {
    targetContext.slots[slot] = { status: 'loading', id: loaded[0].id, name: loaded[0].name }
  }
  const index = externalOpenQueue.indexOf(current)
  if (index >= 0) externalOpenQueue.splice(index, 1)
  activeExternalOpen = null
  sendExternalOpenView(owner)
  deliverPayloadToWindow(targetWindow, { targetSlot: current.paired ? null : slot, files: loaded }, true)
  pumpExternalOpenQueue(targetWindow)
  return { ok: true }
})
handleViewerIPC('desktop:get-shell-status', () => queryShellIntegration())
handleViewerIPC('desktop:set-shell-integration', (_owner, _event, enabled) => updateShellIntegration(enabled === true))
handleViewerIPC('desktop:new-window', () => { createMainWindow() })
handleViewerIPC('desktop:update-status', () => updater.getStatus())
handleViewerIPC('desktop:update-check', (_owner, _event, manual) => {
  if (!manual && process.env.PDF_CROSS_PROBE_MOCK_REGISTRY === '1') return updater.getStatus()
  return updater.check(manual === true)
})
handleViewerIPC('desktop:update-download', () => updater.download())
handleViewerIPC('desktop:update-cancel', () => updater.cancel())
handleViewerIPC('desktop:update-install', () => updater.install())
handleViewerIPC('desktop:update-page', () => shell.openExternal(updater.releasePage))

function createMainWindow(options = {}) {
  if (closing || updater?.getStatus().phase === 'installing') throw new Error('Application update is in progress')
  const sessionId = randomUUID(), preload = path.join(__dirname, 'preload.cjs')
  const window = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 600,
    title: 'PDF Cross Probe', backgroundColor: '#f4f6f5', show: false,
    webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
  const context = {
    sessionId,
    workspaceNumber: nextWorkspaceNumber++,
    ready: false,
    queue: [],
    children: new Set(),
    closing: false,
    initialColdStart: options.initialColdStart === true,
    slots: emptySlots(),
  }
  mainWindows.set(window, context)
  windowOwners.set(window.webContents.id, window)
  lastFocusedMainWindow = window
  window.on('focus', () => { lastFocusedMainWindow = window })
  secureWindow(window)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!viewerUrl(url)) return { action: 'deny' }
    const requested = new URL(url)
    if (requested.searchParams.get('panel') !== 'right' || requested.searchParams.get('session') !== sessionId) return { action: 'deny' }
    for (const child of context.children) {
      if (!child.isDestroyed()) { child.focus(); return { action: 'deny' } }
    }
    return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 850, minWidth: 640, minHeight: 480,
      title: 'PDF Cross Probe - B', backgroundColor: '#f4f6f5',
      webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } } }
  })
  window.webContents.on('did-create-window', child => {
    context.children.add(child)
    const id = child.webContents.id
    windowOwners.set(id, window)
    child.on('focus', () => { lastFocusedMainWindow = window })
    secureWindow(child)
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    child.on('closed', () => {
      context.children.delete(child)
      windowOwners.delete(id)
      if (activeExternalOpen?.ready) sendExternalOpenView(activeExternalOpen.hostWindow)
    })
    if (activeExternalOpen?.ready) sendExternalOpenView(activeExternalOpen.hostWindow)
  })
  window.once('ready-to-show', () => window.show())
  window.on('close', () => {
    context.closing = true
    for (const child of context.children) if (!child.isDestroyed()) child.close()
  })
  const id = window.webContents.id
  window.on('closed', () => {
    mainWindows.delete(window); windowOwners.delete(id)
    if (lastFocusedMainWindow === window) lastFocusedMainWindow = [...mainWindows.keys()].at(-1)
    if (activeExternalOpen) pumpExternalOpenQueue(lastFocusedMainWindow)
  })
  if (activeExternalOpen?.ready && activeExternalOpen.hostWindow && activeExternalOpen.hostWindow !== window) {
    sendExternalOpenView(activeExternalOpen.hostWindow)
  }
  void window.loadURL(`${origin}/index.html?session=${sessionId}`).catch(error => {
    if (!closing && !context.closing) console.error(`Unable to load the viewer: ${error.message}`)
  })
  return window
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return
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
  const { createUpdater } = require(app.isPackaged ? path.join(app.getAppPath(), 'dist/desktop/updater.cjs') : './updater.cjs')
  const updateSession = session.fromPartition('updates')
  updater = createUpdater({ version: app.getVersion(), userData: app.getPath('userData'), executablePath: process.execPath,
    packaged: app.isPackaged, helperPath: path.join(__dirname, 'install-update.ps1'),
    fetch: (url, options) => updateSession.fetch(url, options),
    onStatus: status => { for (const window of BrowserWindow.getAllWindows()) if (viewerUrl(window.webContents.getURL())) window.webContents.send('desktop:update-state', status) },
    onInstall: () => setImmediate(() => app.quit()) })
  const startupArgs = process.argv.slice(app.isPackaged ? 1 : 2)
  const hasStartupFiles = parseLaunchArgv(startupArgs, process.cwd()).files.length > 0
  const window = createMainWindow({ initialColdStart: hasStartupFiles })
  await enqueueLaunchFiles(startupArgs, process.cwd(), window)
}).catch(error => { if (!closing) { console.error(error); dialog.showErrorBox('PDF Cross Probe', String(error)) } app.quit() })

app.on('before-quit', event => {
  const alreadyClosing = closing
  closing = true
  externalOpenQueue.length = 0
  activeExternalOpen = null
  if (!updater || updater.getStatus().phase === 'installing' || updateCleanupComplete) return
  event.preventDefault()
  if (alreadyClosing) return
  void updater.dispose().catch(() => {}).finally(() => {
    updateCleanupComplete = true
    app.quit()
  })
})
app.on('window-all-closed', () => app.quit())