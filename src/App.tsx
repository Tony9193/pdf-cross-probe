import { Fragment, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { PasswordResponses } from 'pdfjs-dist'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import { ArrowLeftRight, ArrowUpCircle, Check, ChevronLeft, ChevronRight, Columns2, Download, ExternalLink, Moon, Monitor, MonitorUp, PanelLeftClose, PanelLeftOpen, PanelsTopLeft, Plus, RefreshCw, Rows2, Search, Settings, Spotlight, Square, Sun, Trash2, X } from 'lucide-react'
import PdfPane from './PdfPane'
import type { ColoredMatch, Navigation, PasswordPrompt, TextSelection } from './PdfPane'
import { createPdfTask, indexPage } from './pdf'
import type { DocumentSession } from './pdf'
import { DocumentSearchIndex, nextMatchIndex, splitKeywords } from './search'
import type { SearchResult } from './search'
import type { ReadingMode, ViewSnapshot } from './reading'
import packageInfo from '../package.json'
import './App.css'

const palette = ['#e33c41', '#14856d', '#1975d2', '#c27700', '#bc438f', '#5b64bc', '#008b9b', '#765629']
const settingsStorageKey = 'pdf-cross-probe:settings:v1'
type ThemeMode = 'light' | 'dark' | 'system'
type AppSettings = {
  theme: ThemeMode
  dimOpacity: number
  defaultDim: boolean
  defaultTolerant: boolean
  autoFitOnLoad: boolean
  rememberLayout: boolean
  savedVertical: boolean
  savedSplits: { horizontal: number; vertical: number }
  defaultReadingMode: ReadingMode
  continuousMode: ReadingMode
  autoCheckUpdates: boolean
}
const defaultSettings: AppSettings = {
  theme: 'light',
  dimOpacity: 0.62,
  defaultDim: false,
  defaultTolerant: false,
  autoFitOnLoad: false,
  rememberLayout: true,
  savedVertical: false,
  savedSplits: { horizontal: 50, vertical: 50 },
  defaultReadingMode: 'off',
  continuousMode: 'continuous-scroll',
  autoCheckUpdates: true,
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(settingsStorageKey)
    if (!raw) return defaultSettings
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return {
      theme: parsed.theme === 'dark' || parsed.theme === 'system' ? parsed.theme : 'light',
      dimOpacity: typeof parsed.dimOpacity === 'number' ? Math.max(0.25, Math.min(0.85, parsed.dimOpacity)) : 0.62,
      defaultDim: Boolean(parsed.defaultDim),
      defaultTolerant: Boolean(parsed.defaultTolerant),
      autoFitOnLoad: Boolean(parsed.autoFitOnLoad),
      rememberLayout: parsed.rememberLayout !== false,
      defaultReadingMode: parsed.defaultReadingMode === 'continuous-scroll' || parsed.defaultReadingMode === 'wheel-page' ? parsed.defaultReadingMode : 'off',
      continuousMode: parsed.continuousMode === 'wheel-page' ? 'wheel-page' : 'continuous-scroll',
      autoCheckUpdates: parsed.autoCheckUpdates !== false,
      savedVertical: Boolean(parsed.savedVertical),
      savedSplits: {
        horizontal: typeof parsed.savedSplits?.horizontal === 'number' ? Math.max(15, Math.min(85, parsed.savedSplits.horizontal)) : 50,
        vertical: typeof parsed.savedSplits?.vertical === 'number' ? Math.max(15, Math.min(85, parsed.savedSplits.vertical)) : 50,
      },
    }
  } catch { return defaultSettings }
}

type LaunchPayload = { targetSlot: number | null; files: { id?: string; name: string; bytes: Uint8Array }[]; error?: string }
type WorkspaceSlotSummary = { status: 'empty' | 'loading' | 'password' | 'ready'; id: string; name: string }
type WorkspaceSummary = {
  sessionId: string
  workspaceNumber: number
  isCurrent: boolean
  separated: boolean
  slots: WorkspaceSlotSummary[]
}
type ExternalOpenRequest = {
  requestId: string
  token: string
  files: { name: string }[]
  preferredSlot: 0 | 1 | null
  paired: boolean
  queueRemaining: number
  workspaces: WorkspaceSummary[]
}
type ExternalOpenDecision =
  | { requestId: string; token: string; action: 'cancel' }
  | {
      requestId: string
      token: string
      action: 'open'
      target: 'new' | { sessionId: string; expectedSlotIds: string[] }
      slot?: 0 | 1
    }
type ExternalOpenResult = { ok: boolean; reason?: string; message?: string; request?: ExternalOpenRequest | null }
type ExternalReplaceConfirm = {
  sessionId: string
  workspaceNumber: number
  slot: 0 | 1 | null
  expectedSlotIds: string[]
  replaced: { slotLabel: 'A' | 'B'; oldName: string; newName: string }[]
}
type UpdateStatus = { phase: string; currentVersion: string; version?: string; notes?: string; message?: string;
  progress?: number; received?: number; total?: number; releasePage?: string }
type DesktopBridge = {
  isDesktop: boolean
  openNewWindow: () => Promise<void>
  getUpdateStatus: () => Promise<UpdateStatus>
  checkForUpdates: (manual?: boolean) => Promise<UpdateStatus>
  downloadUpdate: () => Promise<UpdateStatus>
  cancelUpdate: () => Promise<UpdateStatus>
  installUpdate: () => Promise<UpdateStatus>
  openUpdatePage: () => Promise<void>
  onUpdateStatus: (callback: (value: UpdateStatus) => void) => () => void
  consumeLaunchQueue: () => Promise<LaunchPayload[]>
  onLaunchFiles: (callback: (payload: LaunchPayload) => void) => () => void
  reportWorkspaceState: (slots: WorkspaceSlotSummary[]) => Promise<void>
  getExternalOpenRequest: () => Promise<ExternalOpenRequest | null>
  resolveExternalOpen: (decision: ExternalOpenDecision) => Promise<ExternalOpenResult>
  onExternalOpenRequest: (callback: (request: ExternalOpenRequest | null) => void) => () => void
  getShellStatus: () => Promise<{ supported: boolean; enabled: boolean; executablePath: string }>
  setShellIntegration: (enabled: boolean) => Promise<{ supported: boolean; enabled: boolean; executablePath: string }>
}
declare global {
  interface Window { pdfCrossProbeDesktop?: DesktopBridge }
}

type Term = { id: string; value: string; color: string }
type DocumentInfo = { id: string; name: string; bytes: Uint8Array; password?: string }
type SharedState = { terms: Term[]; dim: boolean; tolerant: boolean[]; settings?: AppSettings }
type DocumentMetadata = { id: string; name: string; indexed: number; ready: boolean; waitingPassword?: boolean; texts: string[]; padReferenceBoundaries?: number[][] }
type RemoteDocument = { id: string; name: string; indexed: number; ready: boolean; waitingPassword?: boolean; search: DocumentSearchIndex }
type MatchPosition = { documentId: string; index: number; mode: SearchResult['mode'] }
type FocusTarget = { slot: number; termId: string; position: MatchPosition; navigation: Navigation; active?: boolean }

function App() {
  const detached = new URLSearchParams(location.search).get('panel') === 'right'
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ phase: 'idle', currentVersion: packageInfo.version })
  const [shellStatus, setShellStatus] = useState<{ supported: boolean; enabled: boolean; executablePath: string } | null>(null)
  const [shellBusy, setShellBusy] = useState(false)
  const [externalRequest, setExternalRequest] = useState<ExternalOpenRequest | null>(null)
  const [externalConfirm, setExternalConfirm] = useState<ExternalReplaceConfirm | null>(null)
  const [externalNotice, setExternalNotice] = useState('')
  const [externalSubmitting, setExternalSubmitting] = useState(false)
  const externalRequestRef = useRef<ExternalOpenRequest | null>(null)
  externalRequestRef.current = externalRequest
  const externalConfirmRef = useRef<ExternalReplaceConfirm | null>(null)
  externalConfirmRef.current = externalConfirm
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [swapped, setSwapped] = useState(false)
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0)
  const activeSlotRef = useRef<0 | 1>(0)
  activeSlotRef.current = activeSlot
  const [rotationTriggers, setRotationTriggers] = useState([0, 0])
  const searchInputRef = useRef<HTMLTextAreaElement>(null)
  const activeTermIdRef = useRef<string | null>(null)
  const [documents, setDocuments] = useState<(DocumentSession | null)[]>([null, null])
  const [remoteLeft, setRemoteLeft] = useState<RemoteDocument | null>(null)
  const remoteLeftRef = useRef(remoteLeft)
  const tasksRef = useRef<(PDFDocumentLoadingTask | null)[]>([null, null])
  const passwordCallbacks = useRef<(((password: string | Error) => void) | null)[]>([null, null])
  const passwordsRef = useRef<(string | undefined)[]>([undefined, undefined])
  const passwordAttempts = useRef([0, 0])
  const queuedPasswords = useRef<string[][]>([[], []])
  const pendingFilesRef = useRef<(DocumentInfo | null)[]>([null, null])
  const readRequests = useRef(['', ''])
  const pendingFocus = useRef<FocusTarget[]>([])
  const viewsRef = useRef<(ViewSnapshot | null)[]>([null, null])
  const [errors, setErrors] = useState(['', '']), [loading, setLoading] = useState([false, false])
  const [passwordPrompts, setPasswordPrompts] = useState<(PasswordPrompt | null)[]>([null, null])
  const passwordPromptsRef = useRef(passwordPrompts)
  passwordPromptsRef.current = passwordPrompts
  const [terms, setTerms] = useState<Term[]>([]), [input, setInput] = useState('')
  const [tolerant, setTolerant] = useState(() => [settings.defaultTolerant, settings.defaultTolerant])
  const [dim, setDim] = useState(() => settings.defaultDim)
  const previousTolerance = useRef(tolerant)
  const [vertical, setVertical] = useState(() => settings.rememberLayout ? settings.savedVertical : false), [separated, setSeparated] = useState(false)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 650px)').matches)
  const [splitSizes, setSplitSizes] = useState(() => settings.rememberLayout ? settings.savedSplits : { horizontal: 50, vertical: 50 })
  const [collapsedPane, setCollapsedPane] = useState<0 | 1 | null>(null)
  const [dragSplit, setDragSplit] = useState<number | null>(null)
  const [dragHint, setDragHint] = useState<0 | 1 | null>(null)
  const [transitioningSlot, setTransitioningSlot] = useState<0 | 1 | null>(null)
  const transitionTimerRef = useRef(0)
  const dividerDragRef = useRef<{ pointerId: number; originSplit: number; fromCollapsed: 0 | 1 | null; startX: number; startY: number; moved: boolean } | null>(null)
  const suppressTabClickRef = useRef(false)
  const panesRef = useRef<HTMLDivElement>(null)
  const [navigation, setNavigation] = useState<(Navigation | null)[]>([null, null])
  const [positions, setPositions] = useState<Record<string, MatchPosition>>({})
  const positionsRef = useRef(positions), navigationRef = useRef(navigation)
  positionsRef.current = positions; navigationRef.current = navigation
  const [samples, setSamples] = useState<string[]>([]), [connectionError, setConnectionError] = useState('')
  const documentsRef = useRef(documents), revisions = useRef([0, 0]), termsRef = useRef(terms)
  const statsDocuments = [detached ? remoteLeft : documents[0], documents[1]]
  const statsRef = useRef(statsDocuments)
  statsRef.current = statsDocuments
  const channel = useRef<BroadcastChannel | null>(null), childWindow = useRef<Window | null>(null)
  const stateRef = useRef<SharedState>({ terms, dim, tolerant, settings }), colorCounter = useRef(0)
  documentsRef.current = documents; termsRef.current = terms; stateRef.current = { terms, dim, tolerant, settings }

  const resolvedTheme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
  }, [resolvedTheme])

  useEffect(() => {
    try { localStorage.setItem(settingsStorageKey, JSON.stringify(settings)) } catch { /* ignore storage errors */ }
  }, [settings])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 650px)')
    const update = () => setNarrow(query.matches)
    query.addEventListener('change', update)
    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const updateDark = () => setSystemDark(darkQuery.matches)
    darkQuery.addEventListener('change', updateDark)
    return () => { query.removeEventListener('change', update); darkQuery.removeEventListener('change', updateDark) }
  }, [])

  function searchResult(session: DocumentSession | RemoteDocument, term: Term, slot: number): SearchResult {
    const result = session.search.search(term.value, stateRef.current.tolerant[slot])
    // 索引尚未完成时不能判定全文没有精确命中，避免过早回退到容错结果。
    return !session.ready && !stateRef.current.tolerant[slot] && result.mode === 'tolerant' ? { mode: 'exact', matches: [] } : result
  }

  const results = useMemo(() => statsDocuments.map((session, slot) => {
    const values = new Map<string, SearchResult>()
    if (session) for (const term of terms) values.set(term.id, searchResult(session, term, slot))
    return values
  }), [documents, remoteLeft, terms, tolerant])
  const colored = useMemo(() => results.map(result => terms.flatMap(term =>
    (result.get(term.id)?.matches ?? []).map(match => ({ ...match, term: term.value, color: term.color } as ColoredMatch)))), [results, terms])

  function applyFocus(targets: FocusTarget[]) {
    const next = [...navigationRef.current]
    const updated = { ...positionsRef.current }
    for (const target of targets) {
      if (!termsRef.current.some(term => term.id === target.termId)) continue
      pendingFocus.current = pendingFocus.current.filter(value => value.slot !== target.slot || value.termId !== target.termId)
      const document = statsRef.current[target.slot]
      // 跨窗口定位可能先于文档及索引到达；按文档 ID 暂存，等对应索引就绪后再应用。
      if (document?.id !== target.position.documentId || !document.ready) {
        pendingFocus.current.push(target)
        continue
      }
      if (target.active !== false) next[target.slot] = target.navigation
      updated[`${target.slot}:${target.termId}`] = target.position
    }
    navigationRef.current = next; positionsRef.current = updated
    setNavigation(next); setPositions(updated)
  }

  function locate(termId: string, page?: number, onlySlot?: number, direction?: number, source?: { slot: number; selection: TextSelection }): FocusTarget[] {
    const term = termsRef.current.find(value => value.id === termId)
    if (!term) return []
    const operation = crypto.randomUUID()
    const targets: FocusTarget[] = []
    for (const slot of [0, 1]) {
      if (onlySlot !== undefined && onlySlot !== slot) continue
      const session = statsRef.current[slot]
      if (!session) continue
      const result = searchResult(session, term, slot)
      const previous = positionsRef.current[`${slot}:${termId}`]
      let current = previous?.documentId === session.id && previous.mode === result.mode ? previous.index : -1
      if (page !== undefined && (viewsRef.current[slot]?.documentId !== session.id || viewsRef.current[slot]?.page !== page || navigationRef.current[slot]?.term !== term.value)) current = -1
      const index = source?.slot === slot ? result.matches.findIndex(match => match.page === source.selection.page && match.start === source.selection.start && match.length === source.selection.length)
        : direction === undefined ? nextMatchIndex(result.matches, -1, 1, page) : nextMatchIndex(result.matches, current, direction, page)
      if (index < 0) continue
      targets.push({ slot, termId, position: { documentId: session.id, index, mode: result.mode },
        navigation: { id: operation, documentId: session.id, term: term.value, match: result.matches[index], preservePosition: source?.slot === slot } })
    }
    applyFocus(targets)
    return targets
  }

  function changeCollapsed(next: 0 | 1 | null) {
    setCollapsedPane(previous => {
      if (previous === next) return previous
      const affected = next ?? previous
      if (affected !== null) {
        window.clearTimeout(transitionTimerRef.current)
        setTransitioningSlot(affected)
        transitionTimerRef.current = window.setTimeout(() => setTransitioningSlot(null), 340)
      }
      return next
    })
  }

  function sendFocus(termId: string, page?: number, slot?: number, direction?: number) {
    activeTermIdRef.current = termId
    if (slot !== undefined && collapsedPane === slot) changeCollapsed(null)
    const targets = locate(termId, page, slot, direction)
    channel.current?.postMessage({ type: 'focus', targets })
  }

  function setKeywordState(next: Term[]) {
    const allowed = new Set(next.map(term => term.id))
    if (activeTermIdRef.current && !allowed.has(activeTermIdRef.current)) activeTermIdRef.current = next.at(-1)?.id ?? null
    const updated = Object.fromEntries(Object.entries(positionsRef.current).filter(([key]) => allowed.has(key.slice(key.indexOf(':') + 1))))
    const navigation = navigationRef.current.map(value => value && next.some(term => term.value === value.term) ? value : null)
    pendingFocus.current = pendingFocus.current.filter(target => allowed.has(target.termId))
    termsRef.current = next; positionsRef.current = updated; navigationRef.current = navigation
    stateRef.current = { ...stateRef.current, terms: next }
    setTerms(next); setPositions(updated); setNavigation(navigation)
  }

  function snapshotFocus(): FocusTarget[] {
    return Object.entries(positionsRef.current).flatMap(([key, position]) => {
      const separator = key.indexOf(':')
      const slot = Number(key.slice(0, separator)), termId = key.slice(separator + 1)
      const term = termsRef.current.find(value => value.id === termId), session = statsRef.current[slot]
      if (!term || session?.id !== position.documentId) return []
      const result = searchResult(session, term, slot), match = result.matches[position.index]
      if (!match || result.mode !== position.mode) return []
      const current = navigationRef.current[slot]
      const active = current?.term === term.value && current.match.page === match.page && current.match.start === match.start && current.match.length === match.length
      return [{ slot, termId, position, active, navigation: active ? { ...current!, preservePosition: false } : { id: crypto.randomUUID(), documentId: session.id, term: term.value, match } }]
    })
  }

  function broadcast(state: SharedState, targets?: FocusTarget[]) { channel.current?.postMessage({ type: 'state', state, targets }) }
  function updateSettings(patch: Partial<AppSettings>) {
    setSettings(current => {
      const next = { ...current, ...patch, savedSplits: patch.savedSplits ?? current.savedSplits }
      stateRef.current = { ...stateRef.current, settings: next }
      channel.current?.postMessage({ type: 'settings', settings: next })
      return next
    })
  }
  function addTerms(values: string[], source?: { slot: number; selection: TextSelection }) {
    const next = [...termsRef.current]
    for (const value of values) {
      if (!next.some(term => term.value.toUpperCase() === value.toUpperCase())) next.push({ id: crypto.randomUUID(), value, color: palette[colorCounter.current++ % palette.length] })
    }
    setKeywordState(next)
    const focus = next.find(term => term.value.toUpperCase() === values.at(-1)?.toUpperCase())?.id ?? null
    activeTermIdRef.current = focus
    const targets = focus ? locate(focus, undefined, undefined, undefined, source) : []
    broadcast({ ...stateRef.current, terms: next }, targets)
  }

  function metadata(session: DocumentSession): DocumentMetadata {
    return { id: session.id, name: session.name, indexed: session.indexed, ready: session.ready, texts: session.pages.map(page => page.text),
      padReferenceBoundaries: session.pages.map(page => page.padReferenceBoundaries ?? []) }
  }

  function receiveLeft(value: DocumentMetadata | null) {
    if (!detached) return
    const current = remoteLeftRef.current
    if (!value) {
      remoteLeftRef.current = null; setRemoteLeft(null)
      return
    }
    if (current?.id === value.id && current.indexed > value.indexed) return
    const search = current?.id === value.id ? current.search : new DocumentSearchIndex()
    const start = current?.id === value.id ? current.indexed : 0
    for (const [index, text] of value.texts.slice(start).entries()) search.append(text, value.padReferenceBoundaries?.[start + index])
    const next = { id: value.id, name: value.name, indexed: value.indexed, ready: value.ready, waitingPassword: value.waitingPassword, search }
    remoteLeftRef.current = next
    statsRef.current = [next, documentsRef.current[1]]
    setRemoteLeft(next)
  }

  async function loadDocument(slot: number, name: string, bytes: Uint8Array, id: string = crypto.randomUUID(), initialPassword?: string) {
    if (detached && slot === 0) return
    // 异步加载或索引完成时用版本号排除已被新文件或取消操作替代的任务。
    const revision = ++revisions.current[slot]
    readRequests.current[slot] = id
    const previous = tasksRef.current[slot]
    tasksRef.current[slot] = null
    passwordCallbacks.current[slot] = null
    passwordsRef.current[slot] = initialPassword
    queuedPasswords.current[slot] = []
    pendingFilesRef.current[slot] = { id, name, bytes, password: initialPassword }
    setPasswordPrompts(value => value.map((item, index) => index === slot ? null : item))
    let task: PDFDocumentLoadingTask | null = null
    documentsRef.current = documentsRef.current.map((item, index) => index === slot ? null : item)
    setDocuments(value => value.map((item, index) => index === slot ? null : item))
    const nextNavigation = navigationRef.current.map((item, index) => index === slot ? null : item)
    navigationRef.current = nextNavigation; setNavigation(nextNavigation)
    setLoading(value => value.map((item, index) => index === slot ? true : item))
    setErrors(value => value.map((item, index) => index === slot ? '' : item))
    if (slot === 0) channel.current?.postMessage({ type: 'left-index', left: { id, name, indexed: 0, ready: false, texts: [] } })
    try {
      await previous?.destroy()
      if (revisions.current[slot] !== revision) return
      if (!name.toLowerCase().endsWith('.pdf')) throw new Error('仅支持 PDF 文件')
      task = createPdfTask(bytes, initialPassword)
      tasksRef.current[slot] = task
      passwordAttempts.current[slot] = 0
      task.onPassword = (updatePassword: (password: string | Error) => void, reason: number) => {
        if (revisions.current[slot] !== revision) return
        if (queuedPasswords.current[slot].length > 0) {
          const queued = queuedPasswords.current[slot].shift()!
          passwordsRef.current[slot] = queued
          updatePassword(queued)
          return
        }
        const attempts = ++passwordAttempts.current[slot]
        passwordCallbacks.current[slot] = updatePassword
        passwordsRef.current[slot] = undefined
        if (pendingFilesRef.current[slot]?.id === id) {
          pendingFilesRef.current[slot] = { id, name, bytes }
        }
        const incorrect = reason === PasswordResponses.INCORRECT_PASSWORD
        setLoading(value => value.map((item, index) => index === slot ? false : item))
        setErrors(value => value.map((item, index) => index === slot ? '' : item))
        setPasswordPrompts(value => value.map((item, index) => index === slot ? { id, name, incorrect, attempts } : item))
        if (slot === 0) channel.current?.postMessage({ type: 'left-index', left: { id, name, indexed: 0, ready: false, waitingPassword: true, texts: [] } })
      }
      const pdf = await task.promise
      if (revisions.current[slot] !== revision) { await pdf.loadingTask.destroy(); return }
      passwordCallbacks.current[slot] = null
      pendingFilesRef.current[slot] = null
      setPasswordPrompts(value => value.map((item, index) => index === slot ? null : item))
      if (slot === 0) channel.current?.postMessage({ type: 'left-index', left: { id, name, indexed: 0, ready: false, waitingPassword: false, texts: [] } })
      const session: DocumentSession = { id, name, bytes, password: passwordsRef.current[slot], pdf, pages: [], indexed: 0, ready: false, search: new DocumentSearchIndex() }
      setDocuments(value => value.map((item, index) => index === slot ? session : item))
      for (let page = 1; page <= pdf.numPages; page++) {
        const indexedPage = await indexPage(pdf, page)
        if (revisions.current[slot] !== revision) { await pdf.loadingTask.destroy(); return }
        session.pages.push(indexedPage); session.indexed = page
        session.search.append(indexedPage.text, indexedPage.padReferenceBoundaries)
        if (page % 3 === 0 || page === pdf.numPages) {
          const snapshot = { ...session, pages: [...session.pages], ready: page === pdf.numPages }
          setDocuments(value => value.map((item, index) => index === slot ? snapshot : item))
          if (slot === 0) channel.current?.postMessage({ type: 'left-index', left: metadata(snapshot) })
        }
      }
    } catch (error) {
      if (task) {
        await task.destroy().catch(() => {})
        if (tasksRef.current[slot] === task) tasksRef.current[slot] = null
      }
      if (revisions.current[slot] === revision) {
        passwordCallbacks.current[slot] = null
        pendingFilesRef.current[slot] = null
        setPasswordPrompts(value => value.map((item, index) => index === slot ? null : item))
        setErrors(value => value.map((item, index) => index === slot ? error instanceof Error ? error.message : String(error) : item))
        setDocuments(value => value.map((item, index) => index === slot ? null : item))
        if (slot === 0) channel.current?.postMessage({ type: 'left-index', left: null })
      }
    } finally {
      if (revisions.current[slot] === revision) setLoading(value => value.map((item, index) => index === slot ? false : item))
    }
  }

  function submitPassword(slot: number, password: string, notify = true) {
    passwordsRef.current[slot] = password
    if (pendingFilesRef.current[slot]) pendingFilesRef.current[slot] = { ...pendingFilesRef.current[slot]!, password }
    if (slot === 1 && notify && readRequests.current[1]) channel.current?.postMessage({ type: 'password', id: readRequests.current[1], password })
    const callback = passwordCallbacks.current[slot]
    if (!callback) {
      queuedPasswords.current[slot].push(password)
      return
    }
    passwordCallbacks.current[slot] = null
    setPasswordPrompts(value => value.map((item, index) => index === slot ? null : item))
    setErrors(value => value.map((item, index) => index === slot ? '' : item))
    setLoading(value => value.map((item, index) => index === slot ? true : item))
    if (slot === 0 && readRequests.current[0]) {
      const pendingName = pendingFilesRef.current[0]?.name ?? ''
      channel.current?.postMessage({ type: 'left-index', left: { id: readRequests.current[0], name: pendingName, indexed: 0, ready: false, waitingPassword: false, texts: [] } })
    }
    callback(password)
  }

  function cancelPassword(slot: number, notify = true) {
    const id = readRequests.current[slot]
    revisions.current[slot]++
    readRequests.current[slot] = ''
    passwordCallbacks.current[slot] = null
    passwordsRef.current[slot] = undefined
    queuedPasswords.current[slot] = []
    pendingFilesRef.current[slot] = null
    const currentTask = tasksRef.current[slot]
    tasksRef.current[slot] = null
    setPasswordPrompts(value => value.map((item, index) => index === slot ? null : item))
    setLoading(value => value.map((item, index) => index === slot ? false : item))
    setErrors(value => value.map((item, index) => index === slot ? '' : item))
    if (slot === 0) channel.current?.postMessage({ type: 'left-index', left: null })
    if (slot === 1 && notify && id) channel.current?.postMessage({ type: 'cancel-file', id })
    void currentTask?.destroy().catch(() => {})
  }

  function closeDocument(slot: number, notify = true) {
    const id = documentsRef.current[slot]?.id ?? readRequests.current[slot]
    cancelPassword(slot, false)
    documentsRef.current = documentsRef.current.map((value, index) => index === slot ? null : value)
    setDocuments(documentsRef.current)
    navigationRef.current = navigationRef.current.map((value, index) => index === slot ? null : value)
    setNavigation(navigationRef.current)
    positionsRef.current = Object.fromEntries(Object.entries(positionsRef.current).filter(([key]) => !key.startsWith(`${slot}:`)))
    setPositions(positionsRef.current)
    pendingFocus.current = pendingFocus.current.filter(value => value.slot !== slot)
    viewsRef.current[slot] = null
    if (notify && slot === 1) channel.current?.postMessage({ type: 'close-file', id })
  }

  function openNewWindow() {
    if (window.pdfCrossProbeDesktop) { void window.pdfCrossProbeDesktop.openNewWindow(); return }
    const url = new URL(location.href)
    url.searchParams.delete('panel'); url.searchParams.set('session', crypto.randomUUID())
    window.open(url.href, '_blank')
  }

  async function loadBytesToSlot(slot: 0 | 1, name: string, bytes: Uint8Array, id: string = crypto.randomUUID()) {
    readRequests.current[slot] = id
    const copy = new Uint8Array(bytes)
    if (slot === 1) channel.current?.postMessage({ type: 'file', file: { id, name, bytes: copy } })
    await loadDocument(slot, name, copy, id)
  }

  function applyExternalOpenRequest(next: ExternalOpenRequest | null) {
    const previous = externalRequestRef.current
    if (!next) {
      setExternalRequest(null)
      setExternalConfirm(null)
      setExternalNotice('')
      setExternalSubmitting(false)
      return
    }
    if (!previous || previous.requestId !== next.requestId) {
      setExternalRequest(next)
      setExternalConfirm(null)
      setExternalNotice('')
      setExternalSubmitting(false)
      return
    }
    const confirm = externalConfirmRef.current
    if (confirm) {
      const target = next.workspaces.find(item => item.sessionId === confirm.sessionId)
      if (!target) {
        setExternalConfirm(null)
        setExternalNotice('所选工作区已关闭，请重新选择打开位置')
      } else {
        const affected = confirm.slot === null ? [0, 1] : [confirm.slot]
        const changed = affected.some(index => (target.slots[index].status === 'empty' ? '' : target.slots[index].id) !== confirm.expectedSlotIds[index])
        if (changed) {
          setExternalConfirm(null)
          setExternalNotice('目标面板的图纸已发生变化，请确认最新状态后再操作')
        }
      }
    }
    setExternalRequest(next)
  }

  async function cancelExternalOpen() {
    const current = externalRequestRef.current
    const desktop = window.pdfCrossProbeDesktop
    if (!current || !desktop || externalSubmitting) return
    setExternalSubmitting(true)
    try {
      await desktop.resolveExternalOpen({ requestId: current.requestId, token: current.token, action: 'cancel' })
    } finally {
      setExternalSubmitting(false)
    }
  }

  async function submitExternalOpen(target: 'new' | { sessionId: string; expectedSlotIds: string[] }, slot: 0 | 1 | null) {
    const current = externalRequestRef.current
    const desktop = window.pdfCrossProbeDesktop
    if (!current || !desktop || externalSubmitting) return
    setExternalSubmitting(true)
    setExternalNotice('')
    try {
      const result = await desktop.resolveExternalOpen({
        requestId: current.requestId,
        token: current.token,
        action: 'open',
        target,
        ...(slot === null ? {} : { slot }),
      })
      if (!result.ok) {
        setExternalConfirm(null)
        if (result.request !== undefined) setExternalRequest(result.request)
        if (result.reason === 'read-error') {
          setExternalRequest(null)
          if (result.message) setConnectionError(result.message)
        } else if (result.message) {
          setExternalNotice(result.message)
        }
      }
    } catch (error) {
      setExternalNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setExternalSubmitting(false)
    }
  }

  function chooseWorkspaceTarget(workspace: WorkspaceSummary, slot: 0 | 1 | null) {
    const current = externalRequestRef.current
    if (!current || externalSubmitting) return
    const affectedSlots = slot === null ? ([0, 1] as const) : ([slot] as const)
    const expectedSlotIds = workspace.slots.map(item => item.status === 'empty' ? '' : item.id)
    const replaced = affectedSlots.flatMap((slotIndex, idx) => {
      const existing = workspace.slots[slotIndex]
      if (existing.status === 'empty') return []
      const incoming = slot === null ? current.files[idx]?.name ?? '' : current.files[0]?.name ?? ''
      return [{ slotLabel: (slotIndex === 0 ? 'A' : 'B') as 'A' | 'B', oldName: existing.name || '未命名图纸', newName: incoming }]
    })
    if (replaced.length > 0) {
      setExternalNotice('')
      setExternalConfirm({
        sessionId: workspace.sessionId,
        workspaceNumber: workspace.workspaceNumber,
        slot,
        expectedSlotIds,
        replaced,
      })
      return
    }
    void submitExternalOpen({ sessionId: workspace.sessionId, expectedSlotIds }, slot)
  }

  function slotStatusText(slot: WorkspaceSlotSummary) {
    if (slot.status === 'empty') return '空'
    if (slot.status === 'password') return `${slot.name}（等待密码）`
    if (slot.status === 'loading') return `${slot.name}（加载中）`
    return slot.name
  }

  const handleLaunchPayload = useEffectEvent((payload: LaunchPayload) => {
    if (payload.error) { setConnectionError(payload.error); return }
    if (detached || !payload?.files?.length) return
    setConnectionError('')
    if (payload.targetSlot === 0 || payload.targetSlot === 1) {
      const target = payload.targetSlot
      if (collapsedPane === target) changeCollapsed(null)
      void loadBytesToSlot(target, payload.files[0].name, payload.files[0].bytes, payload.files[0].id)
      return
    }
    if (payload.files.length >= 2) {
      changeCollapsed(null)
      void loadBytesToSlot(0, payload.files[0].name, payload.files[0].bytes, payload.files[0].id)
      void loadBytesToSlot(1, payload.files[1].name, payload.files[1].bytes, payload.files[1].id)
      return
    }
    if (collapsedPane === 0) changeCollapsed(null)
    void loadBytesToSlot(0, payload.files[0].name, payload.files[0].bytes, payload.files[0].id)
  })

  async function loadFile(slot: number, file: File) {
    const id = crypto.randomUUID(); readRequests.current[slot] = id
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (readRequests.current[slot] !== id) return
      if (slot === 1) channel.current?.postMessage({ type: 'file', file: { id, name: file.name, bytes } })
      await loadDocument(slot, file.name, bytes, id)
    } catch (error) {
      if (readRequests.current[slot] !== id) return
      cancelPassword(slot)
      setErrors(value => value.map((item, index) => index === slot ? (error instanceof Error ? error.message : String(error)) : item))
    }
  }
  async function loadSample(slot: number, name: string) {
    const id = crypto.randomUUID(); readRequests.current[slot] = id
    try {
      const response = await fetch(`/__samples/${encodeURIComponent(name)}`)
      if (!response.ok) throw new Error('样本读取失败')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (readRequests.current[slot] !== id) return
      if (slot === 1) channel.current?.postMessage({ type: 'file', file: { id, name, bytes } })
      await loadDocument(slot, name, bytes, id)
    } catch (error) {
      if (readRequests.current[slot] !== id) return
      cancelPassword(slot)
      setErrors(value => value.map((item, index) => index === slot ? (error instanceof Error ? error.message : String(error)) : item))
    }
  }

  useEffect(() => {
    const id = new URLSearchParams(location.search).get('session') ?? crypto.randomUUID()
    const url = new URL(location.href); url.searchParams.set('session', id); history.replaceState(null, '', url)
    const communication = new BroadcastChannel(`pdf-probe:${id}`); channel.current = communication
    communication.onmessage = event => {
      const message = event.data
      if (message.type === 'ready' && !detached) {
        setSeparated(true)
        const left = documentsRef.current[0], right = documentsRef.current[1]
        const rightFile: DocumentInfo | null = right ? { id: right.id, name: right.name, bytes: right.bytes, password: right.password } : pendingFilesRef.current[1]
        const promptA = passwordPromptsRef.current[0]
        communication.postMessage({ type: 'state', state: { ...stateRef.current, settings: settingsRef.current }, left: left ? metadata(left) : (promptA ? { id: promptA.id, name: promptA.name, indexed: 0, ready: false, waitingPassword: true, texts: [] } : null), right: rightFile, rightView: viewsRef.current[1], targets: snapshotFocus() })
      } else if (message.type === 'state') {
        const state = message.state as SharedState
        setKeywordState(state.terms); stateRef.current = state
        if (state.settings) setSettings(state.settings)
        if ('left' in message) previousTolerance.current = state.tolerant
        colorCounter.current = Math.max(colorCounter.current, state.terms.length)
        setDim(state.dim); setTolerant(state.tolerant)
        if ('left' in message) receiveLeft(message.left)
        if (message.rightView) viewsRef.current[1] = message.rightView
        if (message.right) void loadDocument(1, message.right.name, new Uint8Array(message.right.bytes), message.right.id, message.right.password)
        if (message.targets) applyFocus(message.targets)
        else if (message.focus) locate(message.focus)
      } else if (message.type === 'settings' && message.settings) {
        setSettings(message.settings)
      } else if (message.type === 'file') void loadDocument(1, message.file.name, new Uint8Array(message.file.bytes), message.file.id, message.file.password)
      else if (message.type === 'password' && readRequests.current[1] === message.id) submitPassword(1, message.password, false)
      else if (message.type === 'cancel-file' && readRequests.current[1] === message.id) cancelPassword(1, false)
      else if (message.type === 'close-file' && (documentsRef.current[1]?.id ?? readRequests.current[1]) === message.id) closeDocument(1, false)
      else if (message.type === 'left-index') receiveLeft(message.left)
      else if (message.type === 'view') viewsRef.current[message.slot] = message.view
      else if (message.type === 'closed' && !detached) setSeparated(false)
      else if (message.type === 'restore' && detached) window.close()
      else if (message.type === 'focus') {
        if (message.targets) applyFocus(message.targets)
        else locate(message.termId, message.page, message.slot)
      }
    }
    if (detached) communication.postMessage({ type: 'ready' })
    const unload = () => communication.postMessage({ type: detached ? 'closed' : 'restore' })
    window.addEventListener('beforeunload', unload)
    if (import.meta.env.DEV) void fetch('/__samples').then(response => response.ok ? response.json() : []).then(setSamples).catch(() => {})
    return () => { window.removeEventListener('beforeunload', unload); communication.close() }
  }, [])

  useEffect(() => {
    const desktop = window.pdfCrossProbeDesktop
    if (!desktop || detached) return
    void desktop.getShellStatus().then(setShellStatus).catch(() => {})
    void desktop.consumeLaunchQueue().then(batches => {
      for (const batch of batches) handleLaunchPayload(batch)
    }).catch(() => {})
    void desktop.getExternalOpenRequest().then(request => applyExternalOpenRequest(request)).catch(() => {})
    const offLaunch = desktop.onLaunchFiles(payload => handleLaunchPayload(payload))
    const offExternal = desktop.onExternalOpenRequest(request => applyExternalOpenRequest(request))
    return () => { offLaunch(); offExternal() }
  }, [])

  useEffect(() => {
    const desktop = window.pdfCrossProbeDesktop
    if (!desktop || detached) return
    const slots: WorkspaceSlotSummary[] = ([0, 1] as const).map(slot => {
      if (documents[slot]) return { status: 'ready', id: documents[slot]!.id, name: documents[slot]!.name }
      if (passwordPrompts[slot]) return { status: 'password', id: passwordPrompts[slot]!.id, name: passwordPrompts[slot]!.name }
      if (loading[slot] && pendingFilesRef.current[slot]) {
        return { status: 'loading', id: pendingFilesRef.current[slot]!.id, name: pendingFilesRef.current[slot]!.name }
      }
      return { status: 'empty', id: '', name: '' }
    })
    void desktop.reportWorkspaceState(slots).catch(() => {})
  }, [
    documents[0]?.id, documents[0]?.name, documents[0]?.ready,
    documents[1]?.id, documents[1]?.name, documents[1]?.ready,
    loading[0], loading[1],
    passwordPrompts[0]?.id, passwordPrompts[0]?.name,
    passwordPrompts[1]?.id, passwordPrompts[1]?.name,
  ])

  useEffect(() => {
    const desktop = window.pdfCrossProbeDesktop
    if (!desktop) return
    void desktop.getUpdateStatus().then(setUpdateStatus).catch(() => {})
    const unsubscribe = desktop.onUpdateStatus(setUpdateStatus)
    const timer = settings.autoCheckUpdates ? window.setTimeout(() => {
      void desktop.checkForUpdates(false).then(setUpdateStatus).catch(() => {})
    }, 3000) : 0
    return () => { clearTimeout(timer); unsubscribe() }
  }, [settings.autoCheckUpdates])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editable = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable))
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSidebarCollapsed(false)
        window.setTimeout(() => { searchInputRef.current?.focus(); searchInputRef.current?.select() }, 20)
        return
      }
      if (event.key === 'Escape') {
        if (updateOpen) { event.preventDefault(); setUpdateOpen(false); return }
        if (settingsOpen) { event.preventDefault(); setSettingsOpen(false); return }
        if (externalConfirmRef.current) { event.preventDefault(); setExternalConfirm(null); return }
        if (externalRequestRef.current) { event.preventDefault(); void cancelExternalOpen(); return }
      }
      if (event.key === 'F3' && termsRef.current.length > 0) {
        event.preventDefault()
        const termId = activeTermIdRef.current && termsRef.current.some(t => t.id === activeTermIdRef.current)
          ? activeTermIdRef.current : termsRef.current.at(-1)!.id
        sendFocus(termId, undefined, undefined, event.shiftKey ? -1 : 1)
        return
      }
      if (!editable && !event.ctrlKey && !event.metaKey && !event.altKey && !externalRequestRef.current && event.key.toLowerCase() === 'r') {
        const slot = detached ? 1 : activeSlotRef.current
        if (!documentsRef.current[slot]) return
        event.preventDefault()
        setRotationTriggers(current => current.map((v, idx) => idx === slot ? v + 1 : v))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen, externalRequest?.requestId, externalConfirm, updateOpen, externalSubmitting])

  useEffect(() => {
    for (const slot of [0, 1]) {
      if (previousTolerance.current[slot] === tolerant[slot]) continue
      const active = termsRef.current.find(term => term.value === navigationRef.current[slot]?.term) ?? termsRef.current.at(-1)
      const session = statsRef.current[slot]
      if (active && session?.ready) {
        const updated = { ...positionsRef.current }
        for (const key of Object.keys(updated)) if (key.startsWith(`${slot}:`)) delete updated[key]
        positionsRef.current = updated; setPositions(updated)
        locate(active.id, undefined, slot)
      }
    }
    previousTolerance.current = tolerant
    const readyTargets = pendingFocus.current.filter(target => statsRef.current[target.slot]?.ready && statsRef.current[target.slot]?.id === target.position.documentId)
    if (readyTargets.length) applyFocus(readyTargets)
    const last = termsRef.current.at(-1)
    if (last) for (const slot of [0, 1]) {
      const session = statsRef.current[slot]
      if (session?.ready && navigationRef.current[slot]?.documentId !== session.id) locate(last.id, undefined, slot)
    }
  }, [documents[0]?.id, documents[0]?.ready, documents[1]?.id, documents[1]?.ready, remoteLeft?.id, remoteLeft?.ready, tolerant])

  useEffect(() => () => {
    window.clearTimeout(transitionTimerRef.current)
    for (const slot of [0, 1]) {
      revisions.current[slot]++
      readRequests.current[slot] = ''
      void tasksRef.current[slot]?.destroy().catch(() => {})
      tasksRef.current[slot] = null
    }
  }, [])

  useEffect(() => {
    if (detached || !separated) return
    const timer = window.setInterval(() => {
      if (childWindow.current?.closed) setSeparated(false)
    }, 500)
    return () => clearInterval(timer)
  }, [detached, separated])
  function separate() {
    setCollapsedPane(null); setDragSplit(null); setDragHint(null)
    const url = new URL(location.href); url.searchParams.set('panel', 'right')
    childWindow.current = window.open(url.href, '_blank')
    setConnectionError(childWindow.current ? '' : '新窗口未打开，请允许弹出窗口后重试')
  }
  function restore() {
    setCollapsedPane(null); setDragSplit(null); setDragHint(null)
    channel.current?.postMessage({ type: 'restore' }); childWindow.current?.close(); setSeparated(false)
  }
  const visibleSlots = detached ? [1] : separated ? [0] : swapped ? [1, 0] : [0, 1]
  const firstSlot = visibleSlots[0] as 0 | 1
  const secondSlot = (visibleSlots[1] ?? 1) as 0 | 1
  const stacked = vertical || narrow
  const splitAxis = stacked ? 'vertical' : 'horizontal'
  const split = splitSizes[splitAxis]
  const activeCollapsed = visibleSlots.length === 2 ? collapsedPane : null
  const visualSplit = activeCollapsed === firstSlot ? 0 : activeCollapsed === secondSlot ? 100 : (dragSplit ?? split)
  const panesAnimated = dragSplit === null || activeCollapsed !== null
  const persistSplits = (nextSplits: { horizontal: number; vertical: number }, nextVertical = vertical) => {
    if (!settingsRef.current.rememberLayout) return
    setSettings(current => ({ ...current, savedVertical: nextVertical, savedSplits: nextSplits }))
  }
  const resizeSplit = (value: number) => {
    changeCollapsed(null)
    const clamped = Math.max(15, Math.min(85, value))
    setSplitSizes(current => {
      const next = { ...current, [splitAxis]: clamped }
      persistSplits(next)
      return next
    })
  }
  const startDividerDrag = (event: React.PointerEvent<HTMLElement>, fromCollapsed: 0 | 1 | null = null) => {
    if (event.button !== 0) return
    if (fromCollapsed === null) event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    dividerDragRef.current = { pointerId: event.pointerId, originSplit: split, fromCollapsed, startX: event.clientX, startY: event.clientY, moved: false }
  }
  const moveDivider = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dividerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId || !panesRef.current) return
    const bounds = panesRef.current.getBoundingClientRect()
    const length = stacked ? bounds.height : bounds.width
    if (length <= 20) return
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
    if (!drag.moved) {
      if (distance < (drag.fromCollapsed !== null ? 6 : 1)) return
      drag.moved = true
      if (drag.fromCollapsed !== null) suppressTabClickRef.current = true
    }
    const coordinate = Math.max(0, Math.min(length, stacked ? event.clientY - bounds.top : event.clientX - bounds.left))
    const edgePx = Math.min(56, Math.max(24, length * 0.06))
    const releasePx = edgePx + 20
    const raw = drag.fromCollapsed !== null ? (coordinate / length) * 100 : ((coordinate - 5) / (length - 10)) * 100
    const clampedRaw = Math.max(0, Math.min(100, raw))
    if (drag.fromCollapsed !== null) {
      const isStartEdge = drag.fromCollapsed === firstSlot
      const edgeDist = isStartEdge ? coordinate : length - coordinate
      if (edgeDist <= 14) {
        changeCollapsed(drag.fromCollapsed); setDragSplit(null); setDragHint(null)
        return
      }
      if (edgeDist > releasePx) drag.fromCollapsed = null
      setCollapsedPane(null); setDragSplit(clampedRaw)
      setDragHint(clampedRaw < 15 ? firstSlot : clampedRaw > 85 ? secondSlot : null)
      if (edgeDist > edgePx) {
        const nextVal = Math.max(15, Math.min(85, clampedRaw))
        setSplitSizes(current => { const next = { ...current, [splitAxis]: nextVal }; persistSplits(next); return next })
      }
      return
    }
    if (collapsedPane === firstSlot) {
      if (coordinate > releasePx) {
        const nextVal = Math.max(15, Math.min(85, clampedRaw))
        changeCollapsed(null); setDragSplit(clampedRaw); setDragHint(null)
        setSplitSizes(current => { const next = { ...current, [splitAxis]: nextVal }; persistSplits(next); return next })
      }
      return
    }
    if (collapsedPane === secondSlot) {
      if (length - coordinate > releasePx) {
        const nextVal = Math.max(15, Math.min(85, clampedRaw))
        changeCollapsed(null); setDragSplit(clampedRaw); setDragHint(null)
        setSplitSizes(current => { const next = { ...current, [splitAxis]: nextVal }; persistSplits(next); return next })
      }
      return
    }
    if (coordinate <= edgePx) {
      setDragHint(null); setDragSplit(null)
      setSplitSizes(current => { const next = { ...current, [splitAxis]: drag.originSplit }; persistSplits(next); return next })
      changeCollapsed(firstSlot)
    } else if (length - coordinate <= edgePx) {
      setDragHint(null); setDragSplit(null)
      setSplitSizes(current => { const next = { ...current, [splitAxis]: drag.originSplit }; persistSplits(next); return next })
      changeCollapsed(secondSlot)
    } else {
      const nextVal = Math.max(15, Math.min(85, clampedRaw))
      setDragSplit(clampedRaw)
      setDragHint(clampedRaw < 15 ? firstSlot : clampedRaw > 85 ? secondSlot : null)
      setSplitSizes(current => { const next = { ...current, [splitAxis]: nextVal }; persistSplits(next); return next })
    }
  }
  const stopDividerDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const drag = dividerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dividerDragRef.current = null
    if (drag.moved && drag.fromCollapsed !== null && panesRef.current) {
      const bounds = panesRef.current.getBoundingClientRect()
      const length = stacked ? bounds.height : bounds.width
      const coordinate = Math.max(0, Math.min(length, stacked ? event.clientY - bounds.top : event.clientX - bounds.left))
      const edgePx = Math.min(56, Math.max(24, length * 0.06))
      const isStartEdge = drag.fromCollapsed === firstSlot
      const edgeDist = isStartEdge ? coordinate : length - coordinate
      if (edgeDist <= edgePx) {
        setSplitSizes(current => { const next = { ...current, [splitAxis]: drag.originSplit }; persistSplits(next); return next })
        changeCollapsed(drag.fromCollapsed)
      } else {
        const percent = Math.max(15, Math.min(85, (coordinate / length) * 100))
        setSplitSizes(current => { const next = { ...current, [splitAxis]: percent }; persistSplits(next); return next })
        changeCollapsed(null)
      }
    }
    setDragSplit(null); setDragHint(null)
  }
  async function toggleShellIntegration(nextEnabled: boolean) {
    const desktop = window.pdfCrossProbeDesktop
    if (!desktop || shellBusy) return
    setShellBusy(true)
    try {
      const updated = await desktop.setShellIntegration(nextEnabled)
      setShellStatus(updated)
    } catch { /* ignore */ } finally {
      setShellBusy(false)
    }
  }
  const noText = (slot: number) => statsDocuments[slot]?.ready && !statsDocuments[slot]?.search.hasText

  return <main className="app-shell">
    <header className="app-header">
      <div className="brand">
        <button className="icon-button sidebar-toggle" title={sidebarCollapsed ? '展开搜索栏 (Ctrl+F)' : '收起搜索栏'} aria-label={sidebarCollapsed ? '展开搜索栏' : '收起搜索栏'} aria-pressed={!sidebarCollapsed} onClick={() => setSidebarCollapsed(value => !value)}>
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
        <div className="brand-badge"><PanelsTopLeft size={19} /></div>
        <div><h1>PDF 联动查看器</h1><span>Cross Probe · v{packageInfo.version}</span></div>
      </div>
      <div className="header-actions">
        <button className="command icon-command" title="新建窗口" aria-label="新建窗口" onClick={openNewWindow}><Plus size={16} /><span>新建窗口</span></button>
        {!detached && !separated && <button className="command icon-command" title="互换 A/B 面板位置" aria-pressed={swapped} onClick={() => setSwapped(value => !value)}><ArrowLeftRight size={16} /><span>互换 A/B</span></button>}
        {!detached && !separated && !narrow && <div className="segmented"><button title="左右分屏" aria-pressed={!vertical} onClick={() => { changeCollapsed(null); setVertical(false); persistSplits(splitSizes, false) }}><Columns2 size={17} /></button><button title="上下分屏" aria-pressed={vertical} onClick={() => { changeCollapsed(null); setVertical(true); persistSplits(splitSizes, true) }}><Rows2 size={17} /></button></div>}
        <div className="segmented"><button title="色块描边" aria-pressed={!dim} onClick={() => { setDim(false); broadcast({ ...stateRef.current, dim: false }) }}><Square size={17} /></button><button title="PADS 高亮模式" aria-pressed={dim} onClick={() => { setDim(true); broadcast({ ...stateRef.current, dim: true }) }}><Spotlight size={17} /></button></div>
        {!detached && <button className="command" onClick={separated ? restore : separate}><MonitorUp size={16} />{separated ? '恢复双栏' : '双屏窗口'}</button>}
        <button className="command icon-command" title="偏好设置" aria-label="偏好设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}><Settings size={16} /><span>设置</span></button>
        {['available', 'downloading', 'verifying', 'ready'].includes(updateStatus.phase) && <button className="command update-badge" onClick={() => setUpdateOpen(true)}><ArrowUpCircle size={16} />更新 v{updateStatus.version}</button>}
        <span className="local-badge">仅本机</span>
      </div>
    </header>
    {connectionError && <div className="error" role="alert">{connectionError}</div>}
    <div className="workspace"><aside className={`search-sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`} inert={sidebarCollapsed || undefined}>
      <div className="sidebar-title"><h2>联动搜索</h2><span className="term-count-pill">{terms.length} 个关键词</span></div>
      <form onSubmit={event => { event.preventDefault(); addTerms(splitKeywords(input)); setInput('') }}>
        <textarea ref={searchInputRef} aria-label="关键词" placeholder={'每行输入位号或网络名\n例如：R3501 / VDD_IO'} value={input}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && input.trim()) {
              event.preventDefault()
              addTerms(splitKeywords(input))
              setInput('')
            }
          }}
          onChange={event => setInput(event.target.value)} />
        <button className="search-command" type="submit" disabled={!input.trim()}><Search size={15} />追加高亮</button>
      </form>
      <div className="results-heading"><h2>命中清单</h2><button title="清空关键词" disabled={!terms.length} onClick={() => { setKeywordState([]); broadcast({ ...stateRef.current, terms: [] }) }}><Trash2 size={15} /></button></div>
      <div className="term-list">{terms.length === 0 ? <div className="empty-terms">点击图纸上的位号/网络名，或在上方输入关键词开始双图联动定位</div> : terms.map(term => <section className="term-result" key={term.id}>
        <div className="term-heading"><button className="term-name" onClick={() => sendFocus(term.id)}><span className="swatch" style={{ background: term.color }} /><strong>{term.value}</strong></button>
          <button className="term-remove" title={`删除 ${term.value}`} onClick={() => { const next = termsRef.current.filter(value => value.id !== term.id); setKeywordState(next); broadcast({ ...stateRef.current, terms: next }) }}><X size={14} /></button></div>
        {[0, 1].map(slot => {
          const result = results[slot].get(term.id), pages = [...new Set(result?.matches.map(match => match.page) ?? [])]
          const position = positions[`${slot}:${term.id}`]
          const current = position?.documentId === statsDocuments[slot]?.id && position?.mode === result?.mode && result?.matches[position.index] ? position.index : -1
          const waitingPwd = passwordPrompts[slot] !== null || (slot === 0 && detached && remoteLeft?.waitingPassword)
          return <div className="document-result" key={slot}><div><b className={`doc-tag doc-tag-${slot}`}>{slot === 0 ? 'A' : 'B'}</b><span>{waitingPwd ? '等待密码' : !statsDocuments[slot] ? '未加载' : !statsDocuments[slot]?.ready ? `${result?.matches.length ?? 0} 处 · 索引中` : noText(slot) ? '仅查看' : result?.matches.length ? `${result.matches.length} 处` : '未命中'}</span>
            {result?.mode === 'tolerant' && !!result.matches.length && !noText(slot) && <small>容错</small>}</div>
            {!!result?.matches.length && <div className="match-navigation">
              <button title={`${term.value} · 文档 ${slot === 0 ? 'A' : 'B'} · 上一处`} onClick={() => sendFocus(term.id, undefined, slot, -1)}><ChevronLeft size={14} /></button>
              <span data-position={`${slot}:${term.value}`}>{current < 0 ? '未定位' : `${current + 1} / ${result.matches.length}`}</span>
              <button title={`${term.value} · 文档 ${slot === 0 ? 'A' : 'B'} · 下一处`} onClick={() => sendFocus(term.id, undefined, slot, 1)}><ChevronRight size={14} /></button>
            </div>}
            {!!pages.length && <div className="page-links">{pages.map(page => <button key={page} title={`${term.value} · 第 ${page} 页`} onClick={() => sendFocus(term.id, page, slot, 1)}>p.{page}<span>{result!.matches.filter(match => match.page === page).length}</span></button>)}</div>}
          </div>
        })}
      </section>)}</div>
      <footer className="sidebar-footer"><span>PDF.js · {import.meta.env.DEV ? '开发验证版' : '离线引擎'}</span><span>Ctrl+F 搜索 · F3 跳处</span></footer>
    </aside>
    <div ref={panesRef} className={`panes ${stacked ? 'vertical' : ''} ${visibleSlots.length === 1 ? 'single' : ''} ${panesAnimated ? 'panes-animated' : ''}`}
      style={visibleSlots.length === 2 ? (stacked
        ? { gridTemplateRows: `${visualSplit}fr ${activeCollapsed !== null ? 0 : 10}px ${100 - visualSplit}fr` }
        : { gridTemplateColumns: `${visualSplit}fr ${activeCollapsed !== null ? 0 : 10}px ${100 - visualSplit}fr` }) : undefined}>
      {visibleSlots.map((slot, index) => <Fragment key={slot}>{index === 1 && <div
        className={`pane-divider ${activeCollapsed !== null ? 'is-hidden' : ''} ${dragHint !== null ? 'collapse-hint' : ''}`}
        role="separator" tabIndex={activeCollapsed !== null ? -1 : 0} inert={activeCollapsed !== null || undefined}
        aria-label="调整文档面板大小" aria-orientation={stacked ? 'horizontal' : 'vertical'} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(split)}
        title="拖动调整大小（拖到底可收起面板），双击重置" onPointerDown={event => startDividerDrag(event)}
        onPointerMove={moveDivider} onPointerUp={stopDividerDrag} onPointerCancel={stopDividerDrag}
        onDoubleClick={() => resizeSplit(50)} onKeyDown={event => {
          const decrease = stacked ? 'ArrowUp' : 'ArrowLeft', increase = stacked ? 'ArrowDown' : 'ArrowRight'
          if (event.key === decrease || event.key === increase) { event.preventDefault(); resizeSplit(split + (event.key === increase ? 2 : -2)) }
          else if (event.key === 'Home') { event.preventDefault(); resizeSplit(15) }
          else if (event.key === 'End') { event.preventDefault(); resizeSplit(85) }
        }}><span /></div>}<PdfPane slot={slot} session={documents[slot]} error={errors[slot]} loading={loading[slot]}
        collapsed={activeCollapsed === slot} transitioning={transitioningSlot === slot}
        dimOpacity={settings.dimOpacity} autoFitOnLoad={settings.autoFitOnLoad} rotationTrigger={rotationTriggers[slot]}
        defaultReadingMode={settings.defaultReadingMode} continuousMode={settings.continuousMode} restoreView={viewsRef.current[slot]}
        passwordPrompt={passwordPrompts[slot]} matches={colored[slot]} navigation={navigation[slot]} dim={dim} tolerant={tolerant[slot]} samples={samples}
        onActivate={() => setActiveSlot(slot as 0 | 1)}
        onFile={file => void loadFile(slot, file)} onSample={name => void loadSample(slot, name)}
        onClose={() => closeDocument(slot)}
        onPasswordSubmit={password => submitPassword(slot, password)} onPasswordCancel={() => cancelPassword(slot)}
        onTerm={(value, selection) => addTerms([value], { slot, selection })}
        onViewChange={(_documentId, _page, view) => { if (view) { viewsRef.current[slot] = view; channel.current?.postMessage({ type: 'view', slot, view }) } }}
        onTolerant={value => { const next = tolerant.map((item, index) => index === slot ? value : item); setTolerant(next); broadcast({ ...stateRef.current, tolerant: next }) }} /></Fragment>)}
      {visibleSlots.length === 2 && ([0, 1] as const).map(slot => {
        const visible = activeCollapsed === slot
        const isStartEdge = slot === firstSlot
        const label = `展开文档 ${slot === 0 ? 'A' : 'B'}`
        return <button key={`expand-${slot}`} type="button"
          className={`pane-collapse-tab ${isStartEdge ? 'edge-start' : 'edge-end'} ${visible ? 'is-visible' : ''}`}
          aria-label={label} title={`${label}（点击展开或向内拖动）`} inert={!visible || undefined}
          onPointerDown={event => startDividerDrag(event, slot)} onPointerMove={moveDivider} onPointerUp={stopDividerDrag} onPointerCancel={stopDividerDrag}
          onClick={() => { if (suppressTabClickRef.current) { suppressTabClickRef.current = false; return } changeCollapsed(null) }}>
          <svg className="collapse-triangle" width="11" height="12" viewBox="0 0 12 14" aria-hidden="true">
            <path d="M9.5 2.2L2.5 7L9.5 11.8Z" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
        </button>
      })}
    </div></div>
    {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="偏好设置" onClick={event => event.stopPropagation()}>
        <header className="modal-header">
          <div><h2>偏好设置</h2><span>定制外观主题、看图体验与系统右键打开行为</span></div>
          <button className="icon-button" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}><X size={17} /></button>
        </header>
        <div className="modal-body">
          <section className="setting-section">
            <h3>外观主题</h3>
            <div className="theme-options" role="radiogroup" aria-label="外观主题">
              {([
                ['light', '浅色清爽', Sun],
                ['dark', '暗黑 CAD', Moon],
                ['system', '跟随系统', Monitor],
              ] as const).map(([value, label, Icon]) => (
                <button key={value} type="button" role="radio" aria-checked={settings.theme === value}
                  className={`theme-card ${settings.theme === value ? 'is-active' : ''}`}
                  onClick={() => updateSettings({ theme: value })}>
                  <Icon size={16} /><span>{label}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="setting-section">
            <h3>看图与高亮偏好</h3>
            <div className="setting-row setting-column">
              <label htmlFor="reading-mode">阅读模式</label>
              <select id="reading-mode" aria-label="阅读模式" value={settings.defaultReadingMode}
                onChange={event => updateSettings({
                  defaultReadingMode: event.target.value as ReadingMode,
                  ...(event.target.value === 'off' ? {} : { continuousMode: event.target.value as ReadingMode }),
                })}>
                <option value="off">不翻页</option>
                <option value="continuous-scroll">多页滚动</option>
                <option value="wheel-page">单页</option>
              </select>
            </div>
            <div className="setting-row">
              <div><strong>聚光灯遮罩浓度</strong><span>调节 PADS 聚光灯模式下非命中区域的变暗程度</span></div>
              <div className="slider-control">
                <input type="range" aria-label="聚光灯遮罩浓度" min={25} max={85} step={1}
                  value={Math.round(settings.dimOpacity * 100)}
                  onChange={event => updateSettings({ dimOpacity: Number(event.target.value) / 100 })} />
                <span>{Math.round(settings.dimOpacity * 100)}%</span>
              </div>
            </div>
            <label className="setting-toggle">
              <div><strong>默认开启 PADS 聚光灯模式</strong><span>启动应用时默认使用聚光灯高亮</span></div>
              <input type="checkbox" checked={settings.defaultDim} onChange={event => {
                const checked = event.target.checked
                updateSettings({ defaultDim: checked })
                setDim(checked); broadcast({ ...stateRef.current, dim: checked })
              }} />
            </label>
            <label className="setting-toggle">
              <div><strong>默认开启强制容错匹配</strong><span>启动时对 A / B 面板默认勾选子串容错</span></div>
              <input type="checkbox" checked={settings.defaultTolerant} onChange={event => {
                const checked = event.target.checked
                updateSettings({ defaultTolerant: checked })
                const next = [checked, checked]
                setTolerant(next); broadcast({ ...stateRef.current, tolerant: next })
              }} />
            </label>
            <label className="setting-toggle">
              <div><strong>打开 PDF 时自动整页适配</strong><span>加载新图纸后自动缩放到完整显示第 1 页</span></div>
              <input type="checkbox" checked={settings.autoFitOnLoad} onChange={event => updateSettings({ autoFitOnLoad: event.target.checked })} />
            </label>
            <label className="setting-toggle">
              <div><strong>记忆分屏布局与比例</strong><span>下次启动时自动恢复上次的分屏方向与拖拽比例</span></div>
              <input type="checkbox" checked={settings.rememberLayout} onChange={event => updateSettings({ rememberLayout: event.target.checked, savedVertical: vertical, savedSplits: splitSizes })} />
            </label>
          </section>
          <section className="setting-section">
            <h3>外部打开与系统右键集成</h3>
            <div className="setting-row">
              <div><strong>从资源管理器打开 PDF 时每次选择工作区</strong><span>可选新建独立 A/B 工作区，或放入已有工作区的 A/B；若目标已有图纸，会先显示原文件名并确认替换</span></div>
            </div>
            {shellStatus?.supported && <div className="shell-integration-card">
              <div className="shell-info">
                <strong><ExternalLink size={15} />Windows 右键菜单与「打开方式」关联</strong>
                <span>无需管理员权限，一键注册到当前用户的 PDF 右键菜单（支持直接打开 / 作为 A 图打开 / 作为 B 图打开）及系统「打开方式」列表。</span>
              </div>
              <div className="shell-actions">
                <span className={`shell-status-badge ${shellStatus.enabled ? 'is-enabled' : ''}`}>
                  {shellStatus.enabled ? <><Check size={13} />已启用系统右键关联</> : '未注册系统关联'}
                </span>
                <button type="button" className={shellStatus.enabled ? 'command' : 'search-command'} disabled={shellBusy}
                  onClick={() => void toggleShellIntegration(!shellStatus.enabled)}>
                  {shellStatus.enabled ? '取消右键与关联' : '注册右键与打开方式'}
                </button>
              </div>
            </div>}
          </section>
          <section className="setting-section shortcut-section">
            {window.pdfCrossProbeDesktop && <><h3>软件更新</h3>
              <label className="setting-toggle"><strong>自动检查 GitHub 更新</strong>
                <input type="checkbox" checked={settings.autoCheckUpdates} onChange={event => updateSettings({ autoCheckUpdates: event.target.checked })} />
              </label>
              <div className="update-row"><span>当前版本 v{updateStatus.currentVersion}</span>
                <button className="command" disabled={['checking', 'downloading', 'verifying', 'installing'].includes(updateStatus.phase)}
                  onClick={() => { setUpdateOpen(true); void window.pdfCrossProbeDesktop?.checkForUpdates(true).then(setUpdateStatus) }}><RefreshCw size={15} />检查更新</button>
              </div>
            </>}
            <h3>全局快捷键</h3>
            <div className="shortcut-grid">
              <div><kbd>Ctrl + F</kbd><span>聚焦关键词搜索框</span></div>
              <div><kbd>F3 / Shift+F3</kbd><span>下一处 / 上一处命中</span></div>
              <div><kbd>R</kbd><span>旋转当前活动图纸 90°</span></div>
              <div><kbd>Ctrl + 滚轮</kbd><span>以鼠标为中心缩放图纸</span></div>
            </div>
          </section>
        </div>
      </div>
    </div>}
    {updateOpen && <div className="modal-backdrop" onClick={() => setUpdateOpen(false)}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label="软件更新" onClick={event => event.stopPropagation()}>
        <header className="modal-header"><h2>软件更新</h2><button aria-label="关闭更新" onClick={() => setUpdateOpen(false)}><X size={17} /></button></header>
        <div className="modal-body">
          <p>当前版本 v{updateStatus.currentVersion}{updateStatus.version && updateStatus.version !== updateStatus.currentVersion ? ` · 新版本 v${updateStatus.version}` : ''}</p>
          {updateStatus.phase === 'checking' && <p role="status">正在检查更新</p>}
          {updateStatus.notes && <pre className="update-notes">{updateStatus.notes}</pre>}
          {updateStatus.message && <p role="status">{updateStatus.message}</p>}
          {['downloading', 'verifying'].includes(updateStatus.phase) && <><progress aria-label="更新下载进度" value={updateStatus.progress ?? 0} max={100} />
            <span>{updateStatus.phase === 'verifying' ? '正在校验签名和文件' : `${updateStatus.progress ?? 0}%`}</span>
            <button className="command" onClick={() => void window.pdfCrossProbeDesktop?.cancelUpdate()}>取消下载</button></>}
          {updateStatus.phase === 'available' && <button className="search-command" onClick={() => void window.pdfCrossProbeDesktop?.downloadUpdate().then(setUpdateStatus)}><Download size={16} />下载更新</button>}
          {updateStatus.phase === 'ready' && <><p>安装将关闭所有查看器窗口。原图不会修改，加密图纸需重新输入密码。</p>
            <button className="search-command" onClick={() => {
              if (window.confirm('关闭所有查看器窗口并重启安装更新？')) void window.pdfCrossProbeDesktop?.installUpdate().then(setUpdateStatus)
            }}><RefreshCw size={16} />重启全部窗口并安装</button></>}
          {updateStatus.phase === 'error' && <button className="command" onClick={() => void window.pdfCrossProbeDesktop?.checkForUpdates(true).then(setUpdateStatus)}><RefreshCw size={16} />重试检查</button>}
          <button className="command" onClick={() => void window.pdfCrossProbeDesktop?.openUpdatePage()}><ExternalLink size={16} />GitHub 手动下载</button>
        </div>
      </div>
    </div>}
    {externalRequest && <div className="modal-backdrop">
      <div className="settings-modal external-open-modal" role="dialog" aria-modal="true" aria-label="选择打开位置" onClick={event => event.stopPropagation()}>
        <header className="modal-header">
          <div className="external-open-heading">
            <h2>{externalConfirm ? '确认替换已有图纸' : '选择打开位置'}</h2>
            <span className="external-file-summary" title={externalRequest.files.map(item => item.name).join(' · ')}>
              {externalRequest.paired
                ? `A：${externalRequest.files[0]?.name} · B：${externalRequest.files[1]?.name}`
                : externalRequest.files[0]?.name}
              {externalRequest.preferredSlot !== null ? ` · 右键指定 ${externalRequest.preferredSlot === 0 ? 'A' : 'B'}` : ''}
              {externalRequest.queueRemaining > 0 ? ` · 还有 ${externalRequest.queueRemaining} 份待选择` : ''}
            </span>
          </div>
          <button className="icon-button" aria-label="取消外部打开" disabled={externalSubmitting} onClick={() => void cancelExternalOpen()}><X size={17} /></button>
        </header>
        {externalNotice && <div role="alert" className="error external-open-notice">{externalNotice}</div>}
        <div className="modal-body external-open-body">
          {externalConfirm ? <>
            <p className="replace-confirm-lead">工作区 {externalConfirm.workspaceNumber} 的目标位置已有图纸，确认后将替换：</p>
            <div className="replace-confirm-list">
              {externalConfirm.replaced.map(item => <div key={item.slotLabel} className="replace-confirm-item">
                <span className={`doc-tag ${item.slotLabel === 'B' ? 'doc-tag-1' : ''}`}>{item.slotLabel}</span>
                <div className="replace-confirm-names">
                  <div title={item.oldName}><strong>原图纸：</strong><span>{item.oldName}</span></div>
                  <div title={item.newName}><strong>新图纸：</strong><span>{item.newName}</span></div>
                </div>
              </div>)}
            </div>
            <div className="external-confirm-actions">
              <button type="button" className="command" disabled={externalSubmitting} onClick={() => setExternalConfirm(null)}>返回重选</button>
              <button type="button" autoFocus className="search-command" disabled={externalSubmitting}
                onClick={() => void submitExternalOpen({ sessionId: externalConfirm.sessionId, expectedSlotIds: externalConfirm.expectedSlotIds }, externalConfirm.slot)}>确认替换</button>
            </div>
          </> : <>
            <div className="workspace-card is-new" data-workspace-target="new">
              <div className="workspace-card-info">
                <strong><Plus size={15} />新建独立工作区</strong>
                <span>创建独立的 A/B 查看窗口，与已有工作区的搜索和定位互不影响</span>
              </div>
              <div className="workspace-card-actions">
                {externalRequest.paired ? (
                  <button type="button" autoFocus className="search-command" disabled={externalSubmitting}
                    onClick={() => void submitExternalOpen('new', null)}>新建工作区并载入 A + B</button>
                ) : <>
                  <button type="button" autoFocus={externalRequest.preferredSlot !== 1}
                    className={externalRequest.preferredSlot === 1 ? 'command' : 'search-command'} disabled={externalSubmitting}
                    onClick={() => void submitExternalOpen('new', 0)}>新建工作区 · 放入 A</button>
                  <button type="button" autoFocus={externalRequest.preferredSlot === 1}
                    className={externalRequest.preferredSlot === 1 ? 'search-command' : 'command'} disabled={externalSubmitting}
                    onClick={() => void submitExternalOpen('new', 1)}>新建工作区 · 放入 B</button>
                </>}
              </div>
            </div>
            {externalRequest.workspaces.length > 0 && <div className="setting-section">
              <h3>放入已有工作区</h3>
              <div className="workspace-list">
                {externalRequest.workspaces.map(workspace => <div key={workspace.sessionId} className="workspace-card"
                  data-workspace-number={workspace.workspaceNumber} data-workspace-session={workspace.sessionId}>
                  <div className="workspace-card-top">
                    <strong>工作区 {workspace.workspaceNumber}</strong>
                    <div className="workspace-badges">
                      {workspace.isCurrent && <span className="workspace-badge">当前窗口</span>}
                      {workspace.separated && <span className="workspace-badge">双屏 B 已分离</span>}
                    </div>
                  </div>
                  <div className="workspace-slots">
                    <div className="workspace-slot-line" title={slotStatusText(workspace.slots[0])}>
                      <span className="doc-tag">A</span>
                      <span className={workspace.slots[0].status === 'empty' ? 'is-empty' : ''}>{slotStatusText(workspace.slots[0])}</span>
                    </div>
                    <div className="workspace-slot-line" title={slotStatusText(workspace.slots[1])}>
                      <span className="doc-tag doc-tag-1">B</span>
                      <span className={workspace.slots[1].status === 'empty' ? 'is-empty' : ''}>{slotStatusText(workspace.slots[1])}</span>
                    </div>
                  </div>
                  <div className="workspace-card-actions">
                    {externalRequest.paired ? (
                      <button type="button" className="command" aria-label={`工作区 ${workspace.workspaceNumber} 载入 A 和 B`} disabled={externalSubmitting}
                        onClick={() => chooseWorkspaceTarget(workspace, null)}>
                        {workspace.slots[0].status === 'empty' && workspace.slots[1].status === 'empty' ? '载入 A + B（空）' : '载入 A + B（替换确认）'}
                      </button>
                    ) : <>
                      <button type="button" className={externalRequest.preferredSlot === 0 ? 'search-command' : 'command'}
                        aria-label={`工作区 ${workspace.workspaceNumber} ${workspace.slots[0].status === 'empty' ? '放入 A' : '替换 A'}`}
                        disabled={externalSubmitting} onClick={() => chooseWorkspaceTarget(workspace, 0)}>
                        {workspace.slots[0].status === 'empty' ? '放入 A（空）' : '替换 A'}
                      </button>
                      <button type="button" className={externalRequest.preferredSlot === 1 ? 'search-command' : 'command'}
                        aria-label={`工作区 ${workspace.workspaceNumber} ${workspace.slots[1].status === 'empty' ? '放入 B' : '替换 B'}`}
                        disabled={externalSubmitting} onClick={() => chooseWorkspaceTarget(workspace, 1)}>
                        {workspace.slots[1].status === 'empty' ? '放入 B（空）' : '替换 B'}
                      </button>
                    </>}
                  </div>
                </div>)}
              </div>
            </div>}
            <div className="external-open-footer">
              <button type="button" className="command" disabled={externalSubmitting} onClick={() => void cancelExternalOpen()}>取消本次打开</button>
            </div>
          </>}
        </div>
      </div>
    </div>}
  </main>
}
export default App