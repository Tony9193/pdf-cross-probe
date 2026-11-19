import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { BookOpen, ChevronLeft, ChevronRight, FilePlus2, Hand, Lock, MousePointer2, RotateCw, Scan, X, ZoomIn, ZoomOut } from 'lucide-react'
import { getPageText, indexPage } from './pdf'
import InkLayer from './InkLayer'
import type { InkAction, InkState, InkTool } from './ink'
import type { DocumentSession, PageIndex } from './pdf'
import { keywordAt } from './search'
import type { Match } from './search'
import { flowPage, pageLayout, visiblePages, wheelPage } from './reading'
import type { ReadingMode, ViewSnapshot, WheelState } from './reading'
import { createRenderQueue } from './renderQueue'
import { needsDetail, overlap } from './detailRegion'
import type { DetailRegion, Region } from './detailRegion'
import 'pdfjs-dist/web/pdf_viewer.css'

export type ColoredMatch = Match & { term: string; color: string }
export type Navigation = { id: string; documentId: string; term: string; match: Match; preservePosition?: boolean }
export type PasswordPrompt = { id: string; name: string; incorrect: boolean; attempts: number }
export type TextSelection = { page: number; start: number; length: number }
type Rectangle = { left: number; top: number; width: number; height: number; term: string; color: string; start: number; length: number }
const maxScale = 32
const detailPixelBudget = 6000000
const maxCachedTextDivs = 30000
const acquireRenderSlot = createRenderQueue(2)
const noMatches: ColoredMatch[] = []
type PreparedPage = {
  key: string; index: PageIndex; divs: HTMLElement[]; buffer: HTMLCanvasElement
  layer: HTMLDivElement; width: number; height: number; page: PDFPageProxy; error: string; textReady: boolean
  raster: { precision?: DetailRegion & { buffer: HTMLCanvasElement } }
}

function scheduleIdle(callback: () => void): { type: 'idle' | 'timeout'; handle: number } {
  if ('requestIdleCallback' in window) {
    return { type: 'idle', handle: window.requestIdleCallback(callback, { timeout: 1000 }) }
  }
  return { type: 'timeout', handle: globalThis.setTimeout(callback, 50) }
}

function cancelIdle(task: { type: 'idle' | 'timeout'; handle: number } | null) {
  if (!task) return
  if (task.type === 'idle' && 'cancelIdleCallback' in window) window.cancelIdleCallback(task.handle)
  else globalThis.clearTimeout(task.handle)
}

function preparePage(session: DocumentSession, pageNumber: number, rotation: number, slot: number, priority: () => number,
  onPreview?: (preview: PreparedPage) => void, maxItems?: number, previewPixels = 2000000) {
  let cancelled = false, finished = false
  const abort = new AbortController()
  let renderTask: RenderTask | undefined
  let textLayer: TextLayer | undefined
  let buffer: HTMLCanvasElement | undefined
  let published = false
  const pageKey = `${session.id}:${pageNumber}:${rotation}`
  const promise = (async (): Promise<PreparedPage> => {
    const page = await session.pdf.getPage(pageNumber)
    if (cancelled) throw new Error('Page preparation cancelled')
    const effectiveRotation = (page.rotate + rotation) % 360
    const viewport = page.getViewport({ scale: 1, rotation: effectiveRotation })
    const ratio = Math.min(1, 8192 / viewport.width, 8192 / viewport.height, Math.sqrt(previewPixels / (viewport.width * viewport.height)))
    const release = await acquireRenderSlot(slot, priority, abort.signal)
    try {
      abort.signal.throwIfAborted()
      buffer = document.createElement('canvas')
      buffer.width = Math.max(1, Math.floor(viewport.width * ratio))
      buffer.height = Math.max(1, Math.floor(viewport.height * ratio))
      renderTask = page.render({ canvas: buffer, viewport,
        transform: [buffer.width / viewport.width, 0, 0, buffer.height / viewport.height, 0, 0], background: '#ffffff' })
      await renderTask.promise
    } finally { renderTask = undefined; release() }
    abort.signal.throwIfAborted()
    const emptyLayer = document.createElement('div')
    emptyLayer.className = 'textLayer'
    const base: PreparedPage = { key: pageKey, index: { text: '', segments: [] }, divs: [], buffer,
      layer: emptyLayer, width: viewport.width, height: viewport.height, page, error: '', textReady: false, raster: {} }
    if (onPreview) {
      published = true
      onPreview(base)
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      abort.signal.throwIfAborted()
    }
    const unavailable = () => ({ ...base, textReady: true, error: `第 ${pageNumber} 页无法提取文字，仅查看` })
    try {
      const existingIndex = session.pages[pageNumber - 1]
      if (existingIndex?.error) return unavailable()
      const content = await getPageText(page)
      abort.signal.throwIfAborted()
      if (maxItems !== undefined && content.items.filter(item => 'str' in item).length > maxItems) {
        throw new Error('Prefetch skipped: exceeds text layer cache budget')
      }
      const stagingLayer = document.createElement('div')
      stagingLayer.className = 'textLayer'
      let smallestFont = 16
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue
        const height = Math.hypot(item.transform[2], item.transform[3])
        if (height > 0) smallestFont = Math.min(smallestFont, height)
      }
      // 先放大文字层再整体缩回页面尺寸，降低极小文字布局的精度损失。
      const textScale = Math.min(64, 2 ** Math.max(0, Math.ceil(Math.log2(16 / smallestFont))))
      stagingLayer.style.setProperty('--scale-factor', String(textScale))
      stagingLayer.style.setProperty('--total-scale-factor', String(textScale))
      stagingLayer.style.transform = `scale(${1 / textScale})`
      stagingLayer.style.transformOrigin = '0 0'
      textLayer = new TextLayer({ textContentSource: content, container: stagingLayer, viewport: page.getViewport({ scale: textScale, rotation: effectiveRotation }) })
      await textLayer.render()
      abort.signal.throwIfAborted()
      stagingLayer.style.width = `${viewport.width * textScale}px`
      stagingLayer.style.height = `${viewport.height * textScale}px`
      const index = session.pages[pageNumber - 1] ?? await indexPage(session.pdf, pageNumber, content)
      abort.signal.throwIfAborted()
      if (index.error) return unavailable()
      // 命中偏移依赖索引段与文字层逐项对应；不一致时禁用文字层，避免错位。
      const aligned = index.segments.length === textLayer.textDivs.length && !index.segments.some((segment, position) => segment.text !== textLayer!.textContentItemsStr[position])
      const error = aligned ? '' : '文字索引与文字层不一致，本页仅查看，已停止高亮以避免错位'
      if (!aligned) stagingLayer.replaceChildren()
      return { ...base, index: aligned ? index : { text: '', segments: [] }, divs: aligned ? textLayer.textDivs : [],
        layer: stagingLayer, error, textReady: true }
    } catch (error) {
      if (cancelled || !onPreview) throw error
      console.warn('PDF text layer unavailable:', error)
      return unavailable()
    }
  })().catch(error => {
    if (buffer && !published) buffer.width = buffer.height = 0
    throw error
  }).finally(() => { finished = true })
  return { promise, cancel() { if (!finished) { cancelled = true; abort.abort(); renderTask?.cancel(); textLayer?.cancel() } } }
}

type Props = {
  ink: InkState; inkTool: InkTool; onInk: (action: InkAction) => void; onExitInk?: () => void
  slot: number; session: DocumentSession | null; error: string; loading: boolean
  collapsed?: boolean; transitioning?: boolean
  dimOpacity?: number; autoFitOnLoad?: boolean; rotationTrigger?: number
  defaultReadingMode?: ReadingMode; continuousMode?: ReadingMode; restoreView?: ViewSnapshot | null
  embeddedPage?: number; sharedScroll?: RefObject<HTMLDivElement | null>; sharedScale?: number; sharedRotation?: number
  parentViewRevision?: number
  offscreen?: boolean
  sharedCache?: RefObject<Map<string, PreparedPage>>; protectedKeys?: Set<string>; previewPixels?: number; precisionPixels?: number
  cachePixels?: number
  passwordPrompt?: PasswordPrompt | null
  matches: { byPage: Map<number, ColoredMatch[]>; count: number }; navigation: Navigation | null; dim: boolean; tolerant: boolean; samples: string[]
  onFile: (file: File) => void; onSample: (name: string) => void
  onActivate?: () => void
  onClose?: () => void
  onPasswordSubmit?: (password: string) => void; onPasswordCancel?: () => void
  onTerm: (term: string, selection: TextSelection) => void; onTolerant: (value: boolean) => void
  onViewChange?: (documentId: string, page: number, view?: ViewSnapshot) => void
}

export default function PdfPane(props: Props) {
  const { slot, session, matches, navigation, dim, inkTool: tool } = props
  const [localPageNumber, setPageNumber] = useState(1)
  const [localScale, setScale] = useState(1)
  const [localRotation, setRotation] = useState(0)
  const pageNumber = props.embeddedPage ?? localPageNumber
  const scale = props.sharedScale ?? localScale, rotation = props.sharedRotation ?? localRotation
  const [readingMode, setReadingMode] = useState<ReadingMode>(props.defaultReadingMode ?? 'off')
  const [metadata, setPageMetadata] = useState<{ id: string; estimate?: PDFPageProxy; pages: (PDFPageProxy | undefined)[] }>({ id: '', pages: [] })
  const pageMetadata = metadata.id === session?.id ? metadata.pages : undefined
  const [visible, setVisible] = useState<number[]>([1])
  const selectedPages = useRef(new Set<number>())
  const [selectionPages, setSelectionPages] = useState<number[]>([])
  const pendingView = useRef<ViewSnapshot | null>(null)
  const lastView = useRef<ViewSnapshot | null>(null)
  const pendingEdge = useRef<'top' | 'bottom' | null>(null)
  const wheelState = useRef<WheelState>({ time: 0, direction: 0, amount: 0, locked: false })
  const [rectangles, setRectangles] = useState<Rectangle[]>([])
  const [rendered, setRendered] = useState<PreparedPage | null>(null)
  const [password, setPassword] = useState('')
  const [pageDraft, setPageDraft] = useState<{ value: string; base: number } | null>(null)
  const [zoomDraft, setZoomDraft] = useState<{ value: string; base: number } | null>(null)
  const pendingAutoFit = useRef('')
  const localCache = useRef(new Map<string, PreparedPage>())
  const pageCache = props.sharedCache ?? localCache
  const oversizedPrefetchKeys = useRef(new Set<string>())
  const backgroundJobs = useRef(new Set<ReturnType<typeof preparePage>>())
  const committedPage = useRef<PreparedPage | null>(null)
  const activeKey = useRef('')
  const [renderError, setRenderError] = useState('')
  const [busy, setBusy] = useState(false)
  const [detailBusy, setDetailBusy] = useState(false)
  const [viewRevision, setViewRevision] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [handTool, setHandTool] = useState(false)
  const [panning, setPanning] = useState(false)
  const localScrollRef = useRef<HTMLDivElement>(null)
  const scrollRef = props.sharedScroll ?? localScrollRef
  const paperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLCanvasElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const lastNavigation = useRef('')
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const committedKey = useRef('')
  const committedBuffer = useRef<HTMLCanvasElement | null>(null)
  const displayedScale = useRef(1)
  const detailRegion = useRef<DetailRegion | null>(null)
  const detailLatency = useRef(65)
  const detailAfter = useRef(0)
  const requestedScale = useRef(scale)
  requestedScale.current = scale
  const queuedScale = useRef(scale)
  const wheelFrame = useRef(0)
  const zoomAnchor = useRef<{ x: number; y: number; screenX: number; screenY: number } | null>(null)
  const committedFlow = useRef<{ documentId: string; scale: number; rotation: number; mode: ReadingMode; layout: ReturnType<typeof pageLayout> }>({
    documentId: '', scale, rotation, mode: readingMode, layout: [],
  })
  const activeZoom = useRef<{
    documentId: string; mode: ReadingMode; rotation: number; page: number
    x: number; y: number; unscaledY: number; screenX: number; screenY: number
    committed: boolean; clamped: boolean; scrollLeft: number; scrollTop: number
  } | null>(null)
  const panStart = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const suppressClick = useRef(false)
  const wasCollapsed = useRef(Boolean(props.collapsed))
  const expandingUntil = useRef(0)
  useLayoutEffect(() => {
    if (wasCollapsed.current && !props.collapsed) expandingUntil.current = performance.now() + 360
    wasCollapsed.current = Boolean(props.collapsed)
  }, [props.collapsed])

  const sizes = useMemo(() => {
    if (!pageMetadata || !metadata.estimate || readingMode !== 'continuous-scroll') return []
    const size = (page: PDFPageProxy) => page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 })
    const estimate = size(metadata.estimate)
    return Array.from({ length: pageMetadata.length }, (_, i) => pageMetadata[i] ? size(pageMetadata[i]!) : estimate)
  }, [pageMetadata, metadata.estimate, readingMode, rotation])
  const layout = useMemo(() => pageLayout(sizes, scale), [sizes, scale])
  const flowWidth = useMemo(() => layout.reduce((width, page) => Math.max(width, page.width), 0), [layout])
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const cacheLimit = props.cachePixels === undefined ? detailPixelBudget : Math.floor(props.cachePixels / 2)
  const pageLimit = props.cachePixels === undefined ? 3 : Math.min(7, Math.max(1, Math.floor(cacheLimit / 2000000)))
  const mountedPages = [...new Set([...visible, ...selectionPages, ...(pageLimit < 2 ? [] : [
    Math.max(1, visible[0] - 1), Math.min(session?.pdf.numPages ?? 1, visible.at(-1)! + 1)])])].sort((first, second) => first - second)
  const protectedKeys = new Set(mountedPages.map(number => `${session?.id}:${number}:${rotation}`))
  const cachePolicy = useRef({ cacheLimit, pageLimit, protectedKeys: props.protectedKeys ?? protectedKeys })
  cachePolicy.current = { cacheLimit, pageLimit, protectedKeys: props.protectedKeys ??
    (readingMode === 'continuous-scroll' ? protectedKeys : new Set<string>()) }

  function captureView(): ViewSnapshot | null {
    const scroll = scrollRef.current
    if (!session || !scroll) return null
    const style = getComputedStyle(scroll)
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
    const paddingTop = Number.parseFloat(style.paddingTop) || 0
    if (readingMode === 'continuous-scroll') {
      const committed = committedFlow.current.documentId === session.id && committedFlow.current.mode === 'continuous-scroll' && committedFlow.current.layout.length
        ? committedFlow.current
        : { scale, rotation, layout: layoutRef.current }
      const flowX = scroll.scrollLeft + scroll.clientWidth / 2 - paddingLeft
      const flowY = scroll.scrollTop + scroll.clientHeight / 2 - paddingTop
      const target = flowPage(committed.layout, flowY) ?? committed.layout[pageNumber - 1]
      const page = (target ? pageMetadata?.[target.page - 1] : pageMetadata?.[pageNumber - 1]) ?? committedPage.current?.page ?? metadata.estimate
      if (!page) return null
      const pageTop = target?.top ?? 0
      const rawLocalY = flowY - pageTop
      const clampedY = target ? Math.max(0, Math.min(target.height, rawLocalY)) : rawLocalY
      const unscaledY = rawLocalY - clampedY
      const viewport = page.getViewport({ scale: committed.scale, rotation: (page.rotate + committed.rotation) % 360 })
      const point = viewport.convertToPdfPoint(flowX, clampedY)
      return {
        documentId: session.id, page: target?.page ?? pageNumber, scale: committed.scale, rotation: committed.rotation,
        mode: readingMode, x: point[0], y: point[1], unscaledY, navigationId: navigation?.id,
      }
    }
    const page = committedPage.current?.key === `${session.id}:${pageNumber}:${rotation}` ? committedPage.current.page : pageMetadata?.[pageNumber - 1]
    if (!page) return null
    const activeScale = committedPage.current?.key === `${session.id}:${pageNumber}:${rotation}` ? displayedScale.current : scale
    const viewport = page.getViewport({ scale: activeScale, rotation: (page.rotate + rotation) % 360 })
    const point = viewport.convertToPdfPoint(
      scroll.scrollLeft + scroll.clientWidth / 2 - paddingLeft,
      scroll.scrollTop + scroll.clientHeight / 2 - paddingTop,
    )
    return { documentId: session.id, page: pageNumber, scale: activeScale, rotation, mode: readingMode, x: point[0], y: point[1], navigationId: navigation?.id }
  }

  const reportView = useEffectEvent(() => {
    if (props.embeddedPage || !session || pendingView.current) return
    const view = captureView()
    if (view) lastView.current = view
    props.onViewChange?.(session.id, pageNumber, view ?? undefined)
  })

  function releaseUnpublishedCommitted(old: PreparedPage | null, keepKey?: string) {
    if (!old || old.key === keepKey || pageCache.current.get(old.key) === old) return
    old.buffer.width = 0; old.buffer.height = 0; old.layer.replaceChildren()
    if (old.raster.precision) { old.raster.precision.buffer.width = 0; old.raster.precision.buffer.height = 0; old.raster.precision = undefined }
  }

  function changeReadingMode(mode: ReadingMode) {
    if (mode === readingMode) return
    activeZoom.current = null; zoomAnchor.current = null
    pendingView.current = captureView()
    if (pendingView.current) pendingView.current.mode = mode
    if (layerRef.current && committedPage.current) committedPage.current.layer.replaceChildren(...layerRef.current.childNodes)
    releaseUnpublishedCommitted(committedPage.current)
    committedPage.current = null; committedKey.current = ''; committedBuffer.current = null
    setRendered(null)
    setBusy(false); setDetailBusy(false)
    setReadingMode(mode)
  }

  function goToPage(number: number, edge: 'top' | 'bottom' = 'top') {
    const next = Math.max(1, Math.min(session?.pdf.numPages ?? 1, number))
    pendingView.current = null; activeZoom.current = null; zoomAnchor.current = null
    if (readingMode === 'continuous-scroll') {
      const target = layoutRef.current[next - 1]
      if (target && scrollRef.current) scrollRef.current.scrollTop = target.top
      setVisible([next])
    } else pendingEdge.current = edge
    setPageNumber(next)
  }

  function changeScale(value: number) {
    pendingAutoFit.current = ''
    cancelAnimationFrame(wheelFrame.current); wheelFrame.current = 0
    activeZoom.current = null; zoomAnchor.current = null
    queuedScale.current = value
    if (readingMode === 'continuous-scroll' && value !== scale) pendingView.current = captureView()
    setScale(value)
  }

  useEffect(() => {
    for (const job of backgroundJobs.current) job.cancel()
    backgroundJobs.current.clear()
    releaseUnpublishedCommitted(committedPage.current)
    for (const entry of props.embeddedPage ? [] : pageCache.current.values()) {
      entry.buffer.width = 0; entry.buffer.height = 0; entry.layer.replaceChildren()
      if (entry.raster.precision) { entry.raster.precision.buffer.width = 0; entry.raster.precision.buffer.height = 0 }
    }
    if (!props.embeddedPage) pageCache.current.clear()
    if (!props.embeddedPage) setPageMetadata({ id: '', pages: [] })
    oversizedPrefetchKeys.current.clear()
    committedPage.current = null; committedKey.current = ''; committedBuffer.current = null
    detailRegion.current = null; displayedScale.current = 1
    if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0 }
    if (detailRef.current) { detailRef.current.width = 0; detailRef.current.height = 0; detailRef.current.style.display = 'none' }
    layerRef.current?.replaceChildren()
    const view = props.restoreView?.documentId === session?.id ? props.restoreView ?? null : null
    pendingView.current = view
    lastView.current = view
    setPageDraft(null); setZoomDraft(null)
    setVisible([view?.page ?? 1]); selectedPages.current.clear(); setSelectionPages([])
    setPageNumber(view?.page ?? 1)
    const initialScale = view?.scale ?? 1, initialRotation = view?.rotation ?? 0, initialMode = view?.mode ?? readingMode
    queuedScale.current = initialScale
    setScale(initialScale); setRotation(initialRotation)
    if (view) setReadingMode(view.mode)
    setRectangles([]); setRendered(null)
    setBusy(false); setDetailBusy(false); setRenderError(''); setPanning(false)
    panStart.current = null; pointerStart.current = null; zoomAnchor.current = null; activeZoom.current = null
    committedFlow.current = { documentId: session?.id ?? '', scale: initialScale, rotation: initialRotation, mode: initialMode, layout: [] }
    lastNavigation.current = view?.navigationId ?? ''
    pendingAutoFit.current = ''
    if (!props.embeddedPage) scrollRef.current?.scrollTo(0, 0)
    if (session && props.autoFitOnLoad && !view && !props.embeddedPage) {
      if (props.collapsed || (scrollRef.current?.clientWidth ?? 0) < 1) pendingAutoFit.current = session.id
      else void fitPage(1, 0)
    }
  }, [session?.id])

  useEffect(() => {
    if (!session || props.embeddedPage || pendingAutoFit.current !== session.id || props.collapsed) return
    if (performance.now() < expandingUntil.current || (scrollRef.current?.clientWidth ?? 0) < 1) return
    pendingAutoFit.current = ''
    void fitPage(pageNumber, rotation)
  }, [props.collapsed, viewRevision, session?.id, pageNumber, rotation])

  useEffect(() => {
    if (!props.rotationTrigger || !session) return
    activeZoom.current = null; zoomAnchor.current = null
    if (!props.embeddedPage) pendingView.current = captureView()
    setRotation(value => (value + 90) % 360)
  }, [props.rotationTrigger])

  useEffect(() => {
    if (!props.embeddedPage && navigation && navigation.documentId === session?.id) {
      if (navigation.match.page !== pageNumber) goToPage(navigation.match.page)
    }
  }, [navigation, session?.id])

  useEffect(() => {
    reportView()
  }, [session?.id, pageNumber, scale, rotation, readingMode, rendered])

  useEffect(() => {
    if (!props.embeddedPage) changeReadingMode(props.defaultReadingMode ?? 'off')
  }, [props.defaultReadingMode])

  const metadataTarget = useRef(pageNumber)
  metadataTarget.current = pendingView.current?.page ?? pageNumber
  useEffect(() => {
    if (!session || props.embeddedPage || readingMode !== 'continuous-scroll') return
    if (metadata.id === session.id && metadata.pages.length === session.pdf.numPages && metadata.pages.every(Boolean)) return
    let cancelled = false
    const pages = new Array<PDFPageProxy | undefined>(session.pdf.numPages)
    const visited = new Set<number>()
    let estimate: PDFPageProxy | undefined, cursor = 1
    async function read(number: number) {
      visited.add(number)
      try {
        const page = await session!.pdf.getPage(number)
        pages[number - 1] = page
        estimate ??= page
      } catch (error) {
        if (!cancelled) console.warn(`PDF page geometry unavailable on page ${number}:`, error)
      }
    }
    void (async () => {
      while (!cancelled && visited.size < pages.length) {
        const target = metadataTarget.current
        if (!visited.has(target) && target >= 1 && target <= pages.length) {
          await read(target)
          if (!cancelled && estimate) setPageMetadata({ id: session.id, estimate, pages: [...pages] })
        }
        const batchSize = Math.max(16, Math.ceil(cursor / 12))
        for (let n = 0; !cancelled && n < batchSize && cursor <= pages.length; cursor++) {
          if (visited.has(cursor)) continue
          await read(cursor); n++
        }
        if (!cancelled && estimate) setPageMetadata({ id: session.id, estimate, pages: [...pages] })
        if (!cancelled && cursor <= pages.length) await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    })()
    return () => { cancelled = true }
  }, [session?.id, props.embeddedPage, readingMode])

  useLayoutEffect(() => {
    const layer = layerRef.current
    return () => {
      if (layer && committedPage.current) committedPage.current.layer.replaceChildren(...layer.childNodes)
      releaseUnpublishedCommitted(committedPage.current)
    }
  }, [session?.id, readingMode])

  useEffect(() => () => {
    for (const job of backgroundJobs.current) job.cancel()
    backgroundJobs.current.clear()
    if (!props.sharedCache) {
      for (const entry of localCache.current.values()) {
        entry.buffer.width = 0; entry.buffer.height = 0; entry.layer.replaceChildren()
        if (entry.raster.precision) { entry.raster.precision.buffer.width = 0; entry.raster.precision.buffer.height = 0 }
      }
      localCache.current.clear()
    }
    releaseUnpublishedCommitted(committedPage.current)
    committedPage.current = null; committedKey.current = ''; committedBuffer.current = null
  }, [props.sharedCache])

  useEffect(() => {
    setPassword('')
    if (props.passwordPrompt) passwordRef.current?.focus()
  }, [props.passwordPrompt?.id, props.passwordPrompt?.attempts])

  const renderKey = `${session?.id}:${pageNumber}:${rotation}`
  activeKey.current = renderKey
  const isOffscreen = Boolean(props.collapsed || props.offscreen)
  const offscreenRef = useRef(isOffscreen)
  offscreenRef.current = isOffscreen
  const direction = useRef({ page: pageNumber, step: 1 })
  if (direction.current.page !== pageNumber) {
    direction.current = { page: pageNumber, step: Math.sign(pageNumber - direction.current.page) }
  }

  function trimCache(newKey?: string) {
    const cache = pageCache.current
    const policy = cachePolicy.current
    const protectedKey = (key: string) => key === activeKey.current || key === committedKey.current || policy.protectedKeys.has(key)
    const overBudget = () => cache.size > policy.pageLimit || [...cache.values()].reduce((total, item) => total + item.buffer.width * item.buffer.height, 0) > policy.cacheLimit || [...cache.values()].reduce((total, item) => total + item.divs.length, 0) > maxCachedTextDivs
    while (overBudget()) {
      const victim = [...cache.keys()].find(key => !protectedKey(key))
      if (!victim) break
      if (victim === newKey) oversizedPrefetchKeys.current.add(newKey)
      const removed = cache.get(victim)!
      cache.delete(victim)
      removed.buffer.width = 0; removed.buffer.height = 0; removed.layer.replaceChildren()
      if (removed.raster.precision) { removed.raster.precision.buffer.width = 0; removed.raster.precision.buffer.height = 0 }
    }
    let precisionPixels = [...cache.values()].reduce((sum, item) => sum + (item.raster.precision ? item.raster.precision.buffer.width * item.raster.precision.buffer.height : 0), 0)
    for (const item of cache.values()) {
      if (precisionPixels <= policy.cacheLimit) break
      if (!item.raster.precision || (policy.cacheLimit > 0 && protectedKey(item.key))) continue
      const { buffer } = item.raster.precision
      precisionPixels -= buffer.width * buffer.height
      buffer.width = buffer.height = 0
      item.raster.precision = undefined
    }
    if (paperRef.current) {
      paperRef.current.dataset.cachedPrecisionPixels = String(precisionPixels)
      paperRef.current.dataset.cachedPages = String(cache.size)
      paperRef.current.dataset.cachedPixels = String([...cache.values()].reduce((total, item) => total + item.buffer.width * item.buffer.height, 0))
    }
  }
  function cachePage(entry: PreparedPage) {
    pageCache.current.delete(entry.key); pageCache.current.set(entry.key, entry)
    trimCache(entry.key)
  }
  useEffect(() => {
    oversizedPrefetchKeys.current.clear()
    trimCache()
  }, [cacheLimit])

  useEffect(() => {
    let cancelled = false
    for (const job of backgroundJobs.current) job.cancel()
    backgroundJobs.current.clear()
    const canvas = canvasRef.current, layer = layerRef.current, paper = paperRef.current
    if (!session || !canvas || !layer || !paper) return
    const cached = pageCache.current.get(renderKey)
    if (cached) {
      cachePage(cached); setRendered(cached); setRenderError(cached.error); setBusy(false)
      return
    }
    setBusy(true); setRenderError('')
    const job = preparePage(session, pageNumber, rotation, slot, () => offscreenRef.current ? 2 : 0,
      preview => { if (!cancelled) setRendered(preview) }, undefined, props.previewPixels)
    void job.promise.then(entry => {
      if (cancelled) return
      cachePage(entry); setRendered(entry); setRenderError(entry.error)
    }).catch(error => { if (!cancelled) setRenderError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true; job.cancel() }
  }, [session?.id, pageNumber, rotation, renderKey, readingMode])

  useEffect(() => {
    if (pageLimit < 2 || isOffscreen || props.embeddedPage || readingMode === 'continuous-scroll' || !session || busy || detailBusy || rendered?.key !== renderKey || !rendered.textReady) return
    let cancelled = false
    let idle: { type: 'idle' | 'timeout'; handle: number } | null = null
    const timer = window.setTimeout(() => {
      idle = scheduleIdle(() => {
        void (async () => {
          const step = direction.current.step
          for (const adjacent of [pageNumber + step, pageNumber - step, ...(pageLimit > 3 ? [pageNumber + step * 2, pageNumber - step * 2] : [])]) {
            if (cancelled || adjacent < 1 || adjacent > session.pdf.numPages) continue
            const key = `${session.id}:${adjacent}:${rotation}`
            if (oversizedPrefetchKeys.current.has(key)) continue
            const cached = pageCache.current.get(key)
            if (cached) { cachePage(cached); continue }
            const remainingDivBudget = maxCachedTextDivs - rendered.divs.length
            if (remainingDivBudget <= 0) break
            // Reserve room for the incoming preview before allocating its staging canvas.
            const previewBudget = props.cachePixels === undefined ? 2000000 : Math.min(2000000,
              cacheLimit - [...pageCache.current.values()].reduce((sum, item) => sum + item.buffer.width * item.buffer.height, 0))
            if (previewBudget < 1) break
            const job = preparePage(session, adjacent, rotation, slot, () => 3, undefined, remainingDivBudget, previewBudget)
            backgroundJobs.current.add(job)
            try {
              const entry = await job.promise
              if (!cancelled) cachePage(entry)
            } catch (error) {
              if (error instanceof Error && error.message.startsWith('Prefetch skipped:')) oversizedPrefetchKeys.current.add(key)
              if (cancelled) break
            } finally { backgroundJobs.current.delete(job) }
          }
        })()
      })
    }, 350)
    const jobs = backgroundJobs.current
    return () => {
      cancelled = true; clearTimeout(timer); cancelIdle(idle)
      for (const job of jobs) job.cancel()
      jobs.clear()
    }
  }, [session?.id, rendered, pageNumber, rotation, renderKey, busy, detailBusy, readingMode, pageLimit, cacheLimit, isOffscreen])

  useLayoutEffect(() => {
    if (!rendered || rendered.key !== renderKey || !paperRef.current) return
    const canvas = canvasRef.current, layer = layerRef.current, paper = paperRef.current
    const content = contentRef.current, scroll = scrollRef.current
    if (!canvas || !layer || !content || !scroll) return
    const pageChanged = committedKey.current !== rendered.key
    if (pageChanged || committedBuffer.current !== rendered.buffer) {
      canvas.width = rendered.buffer.width; canvas.height = rendered.buffer.height
      canvas.getContext('2d', { alpha: false })!.drawImage(rendered.buffer, 0, 0)
      canvas.style.width = `${rendered.width}px`; canvas.style.height = `${rendered.height}px`
      content.style.width = `${rendered.width}px`; content.style.height = `${rendered.height}px`
      committedBuffer.current = rendered.buffer
      session?.markInitialRaster()
      detailRegion.current = null
      if (detailRef.current) detailRef.current.style.display = 'none'
      const precision = rendered.raster.precision, detail = detailRef.current
      if (precision?.scale === scale && precision.dpr === (window.devicePixelRatio || 1) && precision.buffer.width && detail) {
        detail.width = precision.buffer.width; detail.height = precision.buffer.height
        detail.getContext('2d', { alpha: false })!.drawImage(precision.buffer, 0, 0)
        detail.style.left = `${precision.left}px`; detail.style.top = `${precision.top}px`
        detail.style.width = `${precision.width}px`; detail.style.height = `${precision.height}px`
        detail.style.display = 'block'; detail.dataset.scale = String(scale)
        detailRegion.current = precision
      }
    }
    if (pageChanged || committedPage.current?.layer !== rendered.layer) {
      if (committedPage.current) committedPage.current.layer.replaceChildren(...layer.childNodes)
      if (pageChanged) releaseUnpublishedCommitted(committedPage.current, rendered.key)
      layer.style.cssText = rendered.layer.style.cssText
      layer.replaceChildren(...rendered.layer.childNodes)
    }
    committedKey.current = rendered.key
    committedPage.current = rendered
    paper.dataset.renderedPage = String(rendered.page.pageNumber)
    paper.dataset.renderPhase = rendered.textReady ? 'ready' : 'preview'
    const textScale = Number.parseFloat(layer.style.getPropertyValue('--total-scale-factor')) || 1
    layer.style.width = `${rendered.width * textScale}px`
    layer.style.height = `${rendered.height * textScale}px`
    layer.style.transform = `scale(${scale / textScale})`
    layer.style.transformOrigin = '0 0'
    const paddingLeft = Number.parseFloat(getComputedStyle(scroll).paddingLeft)
    const paddingTop = Number.parseFloat(getComputedStyle(scroll).paddingTop)
    const anchor = zoomAnchor.current
    // 锚点使用未缩放的页面坐标；缩放后恢复滚动位置，使鼠标下的内容（或视图中心）不跳动。
    const centerX = anchor?.x ?? (scroll.scrollLeft + scroll.clientWidth / 2 - paddingLeft) / displayedScale.current
    const centerY = anchor?.y ?? (scroll.scrollTop + scroll.clientHeight / 2 - paddingTop) / displayedScale.current
    paper.style.width = `${rendered.width * scale}px`; paper.style.height = `${rendered.height * scale}px`
    content.style.transform = `scale(${scale})`
    const previousDetail = detailRegion.current
    if (previousDetail && detailRef.current) {
      const factor = scale / previousDetail.scale
      detailRef.current.style.left = `${previousDetail.left * factor}px`
      detailRef.current.style.top = `${previousDetail.top * factor}px`
      detailRef.current.style.width = `${previousDetail.width * factor}px`
      detailRef.current.style.height = `${previousDetail.height * factor}px`
    }
    if (!props.embeddedPage && !pageChanged && displayedScale.current !== scale && !pendingView.current) {
      const desiredLeft = centerX * scale + paddingLeft - (anchor?.screenX ?? scroll.clientWidth / 2)
      const desiredTop = centerY * scale + paddingTop - (anchor?.screenY ?? scroll.clientHeight / 2)
      scroll.scrollTo({ left: Math.max(0, desiredLeft), top: Math.max(0, desiredTop), behavior: 'instant' })
      if (activeZoom.current && anchor) {
        activeZoom.current.committed = true
        activeZoom.current.scrollLeft = scroll.scrollLeft
        activeZoom.current.scrollTop = scroll.scrollTop
        activeZoom.current.clamped = Math.abs(scroll.scrollLeft - desiredLeft) > 1.5 || Math.abs(scroll.scrollTop - desiredTop) > 1.5
      }
    }
    zoomAnchor.current = null
    displayedScale.current = scale
    queuedScale.current = scale
    if (!props.embeddedPage && pendingEdge.current) {
      scroll.scrollTop = pendingEdge.current === 'bottom' ? scroll.scrollHeight : 0
      pendingEdge.current = null
    }
  }, [rendered, pageNumber, renderKey, scale])

  useLayoutEffect(() => {
    if (!rendered?.textReady || rendered.key !== renderKey || !paperRef.current) {
      setRectangles([])
      return
    }
    const origin = paperRef.current.getBoundingClientRect()
    const measuredScale = displayedScale.current
    const next: Rectangle[] = []
    const segments = rendered.index.segments
    for (const match of matches.byPage.get(pageNumber) ?? noMatches) {
      let low = 0, high = segments.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (segments[mid].start + segments[mid].text.length <= match.start) low = mid + 1
        else high = mid
      }
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
      for (let segmentIndex = low; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex]
        if (segment.start >= match.start + match.length) break
        const start = Math.max(match.start, segment.start) - segment.start
        const end = Math.min(match.start + match.length, segment.start + segment.text.length) - segment.start
        if (end <= start) continue
        const node = rendered.divs[segmentIndex]?.firstChild
        if (!node || node.nodeType !== Node.TEXT_NODE) continue
        const boxes = start === 0 && end === segment.text.length ? [rendered.divs[segmentIndex].getBoundingClientRect()] : (() => {
          const range = document.createRange()
          range.setStart(node, start); range.setEnd(node, end)
          return range.getClientRects()
        })()
        for (const rect of boxes) {
          if (!rect.width || !rect.height) continue
          left = Math.min(left, rect.left); top = Math.min(top, rect.top)
          right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom)
        }
      }
      if (left !== Infinity) next.push({
        ...match, left: (left - origin.left) / measuredScale, top: (top - origin.top) / measuredScale,
        width: (right - left) / measuredScale, height: (bottom - top) / measuredScale,
      })
    }
    setRectangles(next)
  }, [rendered, matches, pageNumber, renderKey])

  useLayoutEffect(() => {
    if (props.embeddedPage) return
    const scroll = scrollRef.current
    if (session && scroll && pendingView.current && pendingView.current.documentId === session.id) {
      const view = pendingView.current
      const page = pageMetadata?.[view.page - 1] ?? (rendered?.key === renderKey && rendered.page.pageNumber === view.page ? rendered.page : undefined)
      const ready = Boolean(page) && (readingMode === 'continuous-scroll'
        ? Boolean(layout[view.page - 1])
        : rendered?.key === renderKey && rendered.page.pageNumber === view.page)
      if (ready && page) {
        const point = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 }).convertToViewportPoint(view.x, view.y)
        const style = getComputedStyle(scroll)
        const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
        const paddingTop = Number.parseFloat(style.paddingTop) || 0
        const desiredLeft = point[0] + paddingLeft - (view.screenX ?? scroll.clientWidth / 2)
        const desiredTop = point[1] + (readingMode === 'continuous-scroll' ? layout[view.page - 1].top : 0) +
          (view.unscaledY ?? 0) + paddingTop - (view.screenY ?? scroll.clientHeight / 2)
        scroll.scrollTo({ left: Math.max(0, desiredLeft), top: Math.max(0, desiredTop), behavior: 'instant' })
        pendingView.current = null
        queuedScale.current = scale
        if (activeZoom.current && !activeZoom.current.committed) {
          activeZoom.current.committed = true
          activeZoom.current.scrollLeft = scroll.scrollLeft
          activeZoom.current.scrollTop = scroll.scrollTop
          activeZoom.current.clamped = Math.abs(scroll.scrollLeft - desiredLeft) > 1.5 || Math.abs(scroll.scrollTop - desiredTop) > 1.5
        }
        if (readingMode === 'continuous-scroll' && layout.length) {
          const pages = visiblePages(layout, scroll.scrollTop, scroll.clientHeight)
          if (pages.length) {
            setVisible(previous => previous.join(',') === pages.join(',') ? previous : pages)
            const center = scroll.scrollTop + scroll.clientHeight / 2
            const current = flowPage(layout, center)
            if (current) setPageNumber(previous => previous === current.page ? previous : current.page)
          }
        }
        committedFlow.current = { documentId: session.id, scale, rotation, mode: readingMode, layout }
        reportView()
        return
      }
    }
    if (session) {
      const old = committedFlow.current
      if (scroll && readingMode === 'continuous-scroll' && old.layout !== layout && layout.length && !pendingView.current) {
        if (old.documentId === session.id && old.mode === readingMode && old.scale === scale && old.rotation === rotation && old.layout.length) {
          const padding = Number.parseFloat(getComputedStyle(scroll).paddingTop) || 0
          const y = scroll.scrollTop + scroll.clientHeight / 2 - padding
          const anchor = flowPage(old.layout, y)
          const replacement = layout[anchor.page - 1]
          const local = y - anchor.top
          const adjusted = local >= anchor.height ? replacement.height + local - anchor.height : local * replacement.height / anchor.height
          scroll.scrollTop += replacement.top + adjusted - y
        } else if (!old.layout.length && pageNumber > 1) {
          scroll.scrollTop = layout[pageNumber - 1]?.top ?? 0
        }
      }
      if (!wheelFrame.current) queuedScale.current = scale
      committedFlow.current = { documentId: session.id, scale, rotation, mode: readingMode, layout }
    }
  }, [session?.id, readingMode, pageMetadata, layout, scale, rotation, rendered, renderKey, viewRevision])

  useLayoutEffect(() => {
    if (!navigation || navigation.documentId !== session?.id || navigation.match.page !== pageNumber || lastNavigation.current === navigation.id) return
    if (navigation.preservePosition) { lastNavigation.current = navigation.id; return }
    const scroll = scrollRef.current
    if (props.collapsed || !scroll || scroll.clientWidth < 1 || scroll.clientHeight < 1) return
    const target = rectangles.find(rect => rect.start === navigation.match.start && rect.length === navigation.match.length && rect.term === navigation.term)
    if (!target) return
    const paddingLeft = Number.parseFloat(getComputedStyle(scroll).paddingLeft)
    const paddingTop = Number.parseFloat(getComputedStyle(scroll).paddingTop)
    const pageOffset = props.embeddedPage ? (paperRef.current?.getBoundingClientRect().top ?? 0) - scroll.getBoundingClientRect().top + scroll.scrollTop : paddingTop
    activeZoom.current = null
    scroll.scrollTo({
      left: Math.max(0, (target.left + target.width / 2) * scale + paddingLeft - scroll.clientWidth / 2),
      top: Math.max(0, (target.top + target.height / 2) * scale + pageOffset - scroll.clientHeight / 2), behavior: 'instant',
    })
    if (performance.now() >= expandingUntil.current) lastNavigation.current = navigation.id
  }, [rectangles, navigation, pageNumber, session?.id, props.collapsed, viewRevision, props.parentViewRevision])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || props.embeddedPage) return
    let frame = 0, reportTimer = 0
    const invalidate = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (readingMode === 'continuous-scroll') {
          const pages = visiblePages(layoutRef.current, scroll.scrollTop, scroll.clientHeight)
          if (pages.length) {
            setVisible(previous => previous.join(',') === pages.join(',') ? previous : pages)
            const center = scroll.scrollTop + scroll.clientHeight / 2
            const current = flowPage(layoutRef.current, center)
            if (current && !pendingView.current) setPageNumber(current.page)
          }
        }
      })
    }
    const onScroll = () => {
      if (readingMode === 'continuous-scroll') invalidate()
      if (!reportTimer) reportTimer = window.setTimeout(() => {
        reportTimer = 0; setViewRevision(value => value + 1); reportView()
      }, 120)
    }
    const onSelection = () => {
      const selection = getSelection()
      if (!selection?.toString()) {
        if (selectedPages.current.size) { selectedPages.current.clear(); setSelectionPages([]) }
        return
      }
      if (!scroll.contains(selection.anchorNode) && !scroll.contains(selection.focusNode)) {
        if (selectedPages.current.size) { selectedPages.current.clear(); setSelectionPages([]) }
        return
      }
      for (const element of scroll.querySelectorAll<HTMLElement>('.paper')) {
        if (selection.containsNode(element, true)) selectedPages.current.add(Number(element.dataset.page))
      }
      setSelectionPages([...selectedPages.current])
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('selectionchange', onSelection)
    let width = scroll.offsetWidth, height = scroll.offsetHeight
    const observer = new ResizeObserver(() => {
      if (scroll.offsetWidth !== width || scroll.offsetHeight !== height) {
        activeZoom.current = null
        if (!pendingView.current) pendingView.current = lastView.current
        width = scroll.offsetWidth; height = scroll.offsetHeight
      }
      invalidate(); onScroll()
    })
    observer.observe(scroll)
    invalidate()
    return () => { clearTimeout(reportTimer); cancelAnimationFrame(frame); observer.disconnect(); scroll.removeEventListener('scroll', onScroll); document.removeEventListener('selectionchange', onSelection) }
  }, [readingMode, session?.id, layout])

  const handleWheel = useEffectEvent((event: WheelEvent) => {
    const scroll = scrollRef.current
    if (!scroll || !session || !event.deltaY) return
    if (!event.ctrlKey) {
      if (readingMode !== 'wheel-page' || Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey || getSelection()?.toString()) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientHeight : 1)
      const atEdge = delta > 0 ? scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2 : scroll.scrollTop <= 2
      const next = wheelPage(wheelState.current, delta, performance.now(), atEdge, committedKey.current !== renderKey)
      wheelState.current = next.state
      if (next.turn && pageNumber + next.turn >= 1 && pageNumber + next.turn <= session.pdf.numPages) {
        event.preventDefault(); goToPage(pageNumber + next.turn, next.turn < 0 ? 'bottom' : 'top')
      }
      return
    }
    event.preventDefault()
    const bounds = scroll.getBoundingClientRect()
    const screenX = event.clientX - bounds.left - scroll.clientLeft
    const screenY = event.clientY - bounds.top - scroll.clientTop
    const style = getComputedStyle(scroll)
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
    const paddingTop = Number.parseFloat(style.paddingTop) || 0
    const committedScale = readingMode === 'continuous-scroll'
      ? (committedFlow.current.documentId === session.id && committedFlow.current.mode === 'continuous-scroll' ? committedFlow.current.scale : scale)
      : (committedPage.current?.key === renderKey ? displayedScale.current : scale)
    const nextScale = Math.max(0.1, Math.min(maxScale, queuedScale.current * (event.deltaY < 0 ? 1.15 : 1 / 1.15)))
    if (Math.abs(nextScale - committedScale) < 1e-9) {
      queuedScale.current = committedScale
      pendingView.current = null; zoomAnchor.current = null; activeZoom.current = null
      cancelAnimationFrame(wheelFrame.current); wheelFrame.current = 0
      return
    }
    const previousZoom = activeZoom.current
    const canReuse = Boolean(previousZoom &&
      previousZoom.documentId === session.id &&
      previousZoom.mode === readingMode &&
      previousZoom.rotation === rotation &&
      (readingMode === 'continuous-scroll' || previousZoom.page === pageNumber) &&
      Math.hypot(screenX - previousZoom.screenX, screenY - previousZoom.screenY) < 1 &&
      (!previousZoom.committed || (!previousZoom.clamped &&
        Math.abs(scroll.scrollLeft - previousZoom.scrollLeft) <= 1.5 &&
        Math.abs(scroll.scrollTop - previousZoom.scrollTop) <= 1.5)))

    if (readingMode === 'continuous-scroll') {
      const committed = committedFlow.current.documentId === session.id && committedFlow.current.mode === 'continuous-scroll' && committedFlow.current.layout.length
        ? committedFlow.current
        : { scale: committedScale, rotation, layout: layoutRef.current }
      if (canReuse && previousZoom) {
        previousZoom.committed = false
        pendingView.current = {
          documentId: session.id, page: previousZoom.page, scale: committed.scale, rotation: committed.rotation,
          mode: readingMode, x: previousZoom.x, y: previousZoom.y, unscaledY: previousZoom.unscaledY, screenX, screenY,
        }
      } else {
        const flowX = scroll.scrollLeft + screenX - paddingLeft
        const flowY = scroll.scrollTop + screenY - paddingTop
        const target = flowPage(committed.layout, flowY) ?? committed.layout[pageNumber - 1]
        const page = target && pageMetadata?.[target.page - 1]
        if (page) {
          const rawLocalY = flowY - target.top
          const clampedY = Math.max(0, Math.min(target.height, rawLocalY))
          const unscaledY = rawLocalY - clampedY
          const point = page.getViewport({ scale: committed.scale, rotation: (page.rotate + committed.rotation) % 360 }).convertToPdfPoint(flowX, clampedY)
          activeZoom.current = {
            documentId: session.id, mode: readingMode, rotation: committed.rotation, page: target.page,
            x: point[0], y: point[1], unscaledY, screenX, screenY,
            committed: false, clamped: false, scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop,
          }
          pendingView.current = {
            documentId: session.id, page: target.page, scale: committed.scale, rotation: committed.rotation,
            mode: readingMode, x: point[0], y: point[1], unscaledY, screenX, screenY,
          }
        }
      }
      zoomAnchor.current = null
    } else if (canReuse && previousZoom) {
      previousZoom.committed = false
      zoomAnchor.current = { x: previousZoom.x, y: previousZoom.y, screenX, screenY }
    } else {
      const x = (scroll.scrollLeft + screenX - paddingLeft) / committedScale
      const y = (scroll.scrollTop + screenY - paddingTop) / committedScale
      activeZoom.current = {
        documentId: session.id, mode: readingMode, rotation, page: pageNumber,
        x, y, unscaledY: 0, screenX, screenY,
        committed: false, clamped: false, scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop,
      }
      zoomAnchor.current = { x, y, screenX, screenY }
    }
    queuedScale.current = nextScale
    detailAfter.current = performance.now() + 140
    if (!wheelFrame.current) wheelFrame.current = requestAnimationFrame(() => {
      wheelFrame.current = 0
      setScale(queuedScale.current)
    })
  })

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || props.embeddedPage) return
    const listener = (event: WheelEvent) => handleWheel(event)
    scroll.addEventListener('wheel', listener, { passive: false })
    return () => {
      scroll.removeEventListener('wheel', listener)
      cancelAnimationFrame(wheelFrame.current); wheelFrame.current = 0
    }
  }, [props.embeddedPage, session?.id, rotation, readingMode])

  const graphics = rendered?.key === renderKey ? rendered : null
  useEffect(() => {
    if (!graphics || isOffscreen) { setDetailBusy(false); return }
    const rendered = graphics
    const scroll = scrollRef.current, paper = paperRef.current
    if (!scroll || !paper) return
    let cancelled = false
    const abort = new AbortController()
    let dirty = false, running = false, timer = 0, refillTimer = 0, refill = false
    let task: RenderTask | undefined
    let previousTop = scroll.scrollTop, previousLeft = scroll.scrollLeft, previousTime = performance.now()
    let velocityX = 0, velocityY = 0
    const pageWidth = rendered.width * scale, pageHeight = rendered.height * scale
    function currentVisible(): Region | null {
      if (!scroll || !paper || !scroll.clientWidth || !scroll.clientHeight) return null
      const area = scroll.getBoundingClientRect(), origin = paper.getBoundingClientRect()
      const left = Math.max(0, area.left + scroll.clientLeft - origin.left)
      const top = Math.max(0, area.top + scroll.clientTop - origin.top)
      const width = Math.min(pageWidth, area.left + scroll.clientLeft + scroll.clientWidth - origin.left) - left
      const height = Math.min(pageHeight, area.top + scroll.clientTop + scroll.clientHeight - origin.top) - top
      return width >= 1 && height >= 1 ? { left, top, width, height } : null
    }
    const schedule = (initialDelay = 0) => {
      if (!running && !timer) timer = window.setTimeout(draw, Math.max(initialDelay, detailAfter.current - performance.now()))
    }
    const request = (initialDelay = 0) => {
      if (cancelled) return
      const now = performance.now(), elapsed = Math.max(1, now - previousTime)
      velocityX = (scroll.scrollLeft - previousLeft) / elapsed
      velocityY = (scroll.scrollTop - previousTop) / elapsed
      previousLeft = scroll.scrollLeft; previousTop = scroll.scrollTop; previousTime = now
      dirty = true; refill = false
      schedule(initialDelay)
      clearTimeout(refillTimer)
      refillTimer = window.setTimeout(() => {
        refill = true; dirty = true
        velocityX = velocityY = 0
        schedule()
      }, 120)
    }
    const onMovement = () => request()
    const draw = async () => {
      timer = 0
      if (cancelled) return
      if (performance.now() < detailAfter.current - 1) { schedule(); return }
      dirty = false; running = true
      let release
      let buffer: HTMLCanvasElement | undefined
      let retained = false
      const started = performance.now()
      try {
        const dpr = window.devicePixelRatio || 1
        const lookAhead = Math.min(300, detailLatency.current + 45)
        const bias = (velocity: number, size: number) => performance.now() - previousTime > 200 ? 0 :
          Math.max(-size * 0.6, Math.min(size * 0.6, velocity * lookAhead))
        const aheadX = bias(velocityX, scroll.clientWidth), aheadY = bias(velocityY, scroll.clientHeight)
        const visible = currentVisible()
        if (!visible || !needsDetail(detailRegion.current, visible, pageWidth, pageHeight, scale, dpr, aheadX, aheadY, refill)) return
        release = await acquireRenderSlot(slot, () => 1, abort.signal)
        if (cancelled || requestedScale.current !== scale) return
        const detail = detailRef.current
        if (!detail) return
        const actual = currentVisible()
        if (!actual) return
        const ax = bias(velocityX, scroll.clientWidth), ay = bias(velocityY, scroll.clientHeight)
        const padX = scroll.clientWidth * 0.35, padY = scroll.clientHeight * 0.35
        const left = Math.max(0, Math.floor((actual.left - padX + Math.min(0, ax)) * dpr) / dpr)
        const top = Math.max(0, Math.floor((actual.top - padY + Math.min(0, ay)) * dpr) / dpr)
        const right = Math.min(pageWidth, Math.ceil((actual.left + actual.width + padX + Math.max(0, ax)) * dpr) / dpr)
        const bottom = Math.min(pageHeight, Math.ceil((actual.top + actual.height + padY + Math.max(0, ay)) * dpr) / dpr)
        const width = right - left, height = bottom - top
        const region = { left, top, width, height, scale, dpr }
        setDetailBusy(true)
        const ratio = Math.min(dpr, 2, 8192 / width, 8192 / height, Math.sqrt((props.precisionPixels ?? detailPixelBudget) / (width * height)))
        buffer = document.createElement('canvas')
        buffer.width = Math.max(1, Math.floor(width * ratio)); buffer.height = Math.max(1, Math.floor(height * ratio))
        const effectiveRotation = (rendered.page.rotate + rotation) % 360
        const sx = buffer.width / width, sy = buffer.height / height
        task = rendered.page.render({ canvas: buffer, viewport: rendered.page.getViewport({ scale, rotation: effectiveRotation }),
          transform: [sx, 0, 0, sy, -left * sx, -top * sy], background: '#ffffff' })
        try { await task.promise } finally { task = undefined }
        if (cancelled || requestedScale.current !== scale || activeKey.current !== renderKey) return
        const latest = currentVisible(), previousRegion = detailRegion.current
        if (!latest || overlap(region, latest) === 0 ||
          (!previousRegion && (Math.abs(latest.left - actual.left) > actual.width * 0.35 ||
            Math.abs(latest.top - actual.top) > actual.height * 0.35)) ||
          (previousRegion?.scale === scale && overlap(region, latest) + 1 < overlap(previousRegion, latest))) return
        detailLatency.current = Math.min(500, detailLatency.current * 0.75 + (performance.now() - started) * 0.25)
        detail.width = buffer.width; detail.height = buffer.height
        detail.getContext('2d', { alpha: false })!.drawImage(buffer, 0, 0)
        detail.style.left = `${left}px`; detail.style.top = `${top}px`
        detail.style.width = `${width}px`; detail.style.height = `${height}px`
        detail.style.display = 'block'
        detail.dataset.scale = String(scale)
        detailRegion.current = region
        if (cachePolicy.current.cacheLimit > 0) {
          const previous = rendered.raster.precision
          rendered.raster.precision = { ...region, buffer }
          retained = true
          if (previous) { previous.buffer.width = 0; previous.buffer.height = 0 }
          trimCache()
        }
      } catch (error) {
        if (!cancelled) setRenderError(error instanceof Error ? error.message : String(error))
      } finally {
        if (buffer && !retained) buffer.width = buffer.height = 0
        release?.()
        running = false
        if (!cancelled) {
          setDetailBusy(false)
          if (dirty) schedule()
        }
      }
    }
    scroll.addEventListener('scroll', onMovement, { passive: true })
    const observer = new ResizeObserver(onMovement)
    observer.observe(scroll)
    window.addEventListener('resize', onMovement)
    let dprMedia: MediaQueryList | null = null
    const watchDpr = () => {
      dprMedia?.removeEventListener('change', onDprChange)
      dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      dprMedia.addEventListener('change', onDprChange)
    }
    function onDprChange() { watchDpr(); onMovement() }
    watchDpr()
    request(40)
    return () => { cancelled = true; abort.abort(); clearTimeout(timer); clearTimeout(refillTimer); task?.cancel(); observer.disconnect(); dprMedia?.removeEventListener('change', onDprChange); window.removeEventListener('resize', onMovement); scroll.removeEventListener('scroll', onMovement) }
  }, [graphics?.buffer, renderKey, scale, rotation, props.precisionPixels, isOffscreen])

  async function fitPage(targetPage = pageNumber, targetRotation = rotation, preserveCenter = false) {
    if (!session || !scrollRef.current) return
    const scroll = scrollRef.current
    const key = activeKey.current
    const style = getComputedStyle(scroll)
    const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
    const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
    let page: PDFPageProxy
    try { page = await session.pdf.getPage(targetPage) }
    catch (error) {
      if (activeKey.current === key) console.warn(`PDF page geometry unavailable on page ${targetPage}:`, error)
      return
    }
    if (activeKey.current !== key || scrollRef.current !== scroll) return
    cancelAnimationFrame(wheelFrame.current); wheelFrame.current = 0
    const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + targetRotation) % 360 })
    const next = Math.max(0.1, Math.min(maxScale, Math.max(1, scroll.clientWidth - padX) / viewport.width,
      Math.max(1, scroll.clientHeight - padY) / viewport.height))
    activeZoom.current = null; zoomAnchor.current = null
    queuedScale.current = next
    if (preserveCenter && readingMode === 'continuous-scroll' && next !== scale) pendingView.current = captureView()
    setScale(next)
  }

  function clickText(event: React.MouseEvent) {
    const start = pointerStart.current
    if (event.detail > 1 || suppressClick.current || handTool || !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || !rendered || rendered.key !== renderKey) return
    if (window.getSelection()?.toString()) return
    const target = (event.target as HTMLElement).closest('span')
    const segmentIndex = rendered.divs.findIndex(div => div === target)
    const segment = rendered.index.segments[segmentIndex]
    if (!segment?.text.trim()) return
    const node = target?.firstChild
    if (!node || node.nodeType !== Node.TEXT_NODE) return
    if (segment.padReferenceOffset !== undefined) {
      const reference = segment.text.slice(segment.padReferenceOffset).trimEnd()
      props.onTerm(reference, { page: pageNumber, start: segment.start + segment.padReferenceOffset, length: reference.length })
      return
    }
    const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY)
    let localOffset: number | null = caret?.offsetNode === node ? caret.offset : null
    if (localOffset === null) {
      // 浏览器无法给出当前文字节点的光标位置时，按字符矩形命中；距离不唯一则不猜测。
      const candidates: { offset: number; distance: number }[] = []
      for (let offset = 0; offset < segment.text.length; offset++) {
        const range = document.createRange()
        range.setStart(node, offset); range.setEnd(node, offset + 1)
        for (const rect of range.getClientRects()) {
          if (event.clientX < rect.left - 0.5 || event.clientX > rect.right + 0.5 || event.clientY < rect.top - 0.5 || event.clientY > rect.bottom + 0.5) continue
          candidates.push({ offset, distance: Math.hypot(event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2) })
        }
      }
      candidates.sort((first, second) => first.distance - second.distance)
      if (!candidates.length || (candidates[1] && Math.abs(candidates[1].distance - candidates[0].distance) < 0.1)) return
      localOffset = candidates[0].offset
    }
    let offset = segment.start + localOffset
    let token = keywordAt(rendered.index.text, offset)
    if (!token && localOffset > 0) {
      const previousCharacter = document.createRange()
      previousCharacter.setStart(node, localOffset - 1); previousCharacter.setEnd(node, localOffset)
      const inside = [...previousCharacter.getClientRects()].some(rect => event.clientX >= rect.left - 0.5 && event.clientX <= rect.right + 0.5 && event.clientY >= rect.top - 0.5 && event.clientY <= rect.bottom + 0.5)
      if (inside) { offset--; token = keywordAt(rendered.index.text, offset) }
    }
    if (token) {
      let tokenStart = offset
      while (tokenStart > 0 && keywordAt(rendered.index.text, tokenStart - 1) === token) tokenStart--
      props.onTerm(token, { page: pageNumber, start: tokenStart, length: token.length })
    }
  }

  const paper = <div className="paper" ref={paperRef} data-page={pageNumber}>
    <div className="page-content" ref={contentRef}><canvas ref={canvasRef} className="base-canvas" /></div>
    <canvas ref={detailRef} className="detail-canvas" style={{ display: 'none' }} />
    <div ref={layerRef} className="textLayer" onPointerDown={event => { pointerStart.current = { x: event.clientX, y: event.clientY } }} onClick={clickText} />
    {dim && rectangles.length > 0 && <svg className="dim-layer" width="100%" height="100%">
      <defs><mask id={`mask-${slot}-${pageNumber}`}><rect width="100%" height="100%" fill="white" />
        {rectangles.map((rect, index) => <rect key={index} x={rect.left * scale - 2} y={rect.top * scale - 2} width={rect.width * scale + 4} height={rect.height * scale + 4} fill="black" />)}
      </mask></defs><rect width="100%" height="100%" fill={`rgba(0,0,0,${props.dimOpacity ?? 0.62})`} mask={`url(#mask-${slot}-${pageNumber})`} />
    </svg>}
    <div className="highlight-layer">{rectangles.map((rect, index) => <div key={index} data-term={rect.term}
      data-start={rect.start} data-length={rect.length} className={`hit-rectangle ${navigation?.match.page === pageNumber && navigation?.match.start === rect.start && navigation?.match.length === rect.length && navigation?.term === rect.term ? 'current-hit' : ''}`}
      style={{ left: rect.left * scale, top: rect.top * scale, width: rect.width * scale, height: rect.height * scale, borderColor: rect.color, background: `${rect.color}30` }} />)}</div>
    {session && rendered?.key === renderKey && (tool.mode !== 'read' || props.ink.strokes.length > 0) &&
      <InkLayer key={renderKey} page={rendered.page} rotation={rotation} tool={tool} strokes={props.ink.strokes} edit={props.onInk} />}
  </div>
  if (props.embeddedPage) return paper

  return <section className={`pdf-pane ${dragging ? 'drop-active' : ''} ${props.collapsed ? 'is-collapsed' : ''} ${props.transitioning ? 'is-transitioning' : ''}`}
    data-slot={slot} data-rotation={rotation} inert={props.collapsed || undefined}
    data-reading-mode={readingMode}
    onPointerDownCapture={() => props.onActivate?.()}
    onDragOver={event => { event.preventDefault(); setDragging(true) }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }}
    onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) props.onFile(file) }}>
    <header className="pane-header"><span className="slot-label">{slot === 0 ? 'A' : 'B'}</span>
      <strong title={session?.name ?? props.passwordPrompt?.name}>{session?.name ?? props.passwordPrompt?.name ?? (slot === 0 ? '原理图' : '位号 / 丝印 / 走线图')}</strong>
      <button title="打开 PDF" onClick={() => fileRef.current?.click()}><FilePlus2 size={17} /><span>打开 PDF</span></button>
      {(session || props.passwordPrompt || props.loading) && <button title="关闭图纸" aria-label={`关闭文档 ${slot === 0 ? 'A' : 'B'}`} onClick={props.onClose}><X size={16} /></button>}
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={event => {
        const file = event.target.files?.[0]; if (file) props.onFile(file); event.target.value = ''
      }} />
    </header>
    <div className="pane-toolbar">
      <button title="上一页" disabled={!session || pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}><ChevronLeft size={17} /></button>
      <input aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 页码`} type="number" min={1} max={session?.pdf.numPages ?? 1} disabled={!session}
        value={pageDraft?.base === pageNumber ? pageDraft.value : pageNumber}
        onChange={event => {
          const raw = event.target.value, parsed = Number(raw)
          if (raw.trim() !== '' && Number.isInteger(parsed) && parsed >= 1 && parsed <= (session?.pdf.numPages ?? 1)) {
            setPageDraft({ value: raw, base: parsed }); goToPage(parsed)
          } else setPageDraft({ value: raw, base: pageNumber })
        }}
        onBlur={() => {
          if (pageDraft && pageDraft.base === pageNumber && pageDraft.value.trim() !== '' && Number.isFinite(Number(pageDraft.value))) {
            goToPage(Math.round(Number(pageDraft.value)))
          }
          setPageDraft(null)
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur()
          else if (event.key === 'Escape') { setPageDraft(null); event.currentTarget.blur() }
        }} />
      <span>/ {session?.pdf.numPages ?? 0}</span>
      <button title="下一页" disabled={!session || pageNumber >= session.pdf.numPages} onClick={() => goToPage(pageNumber + 1)}><ChevronRight size={17} /></button><i />
      <button title="缩小" disabled={!session || scale <= 0.1} onClick={() => changeScale(Math.max(0.1, scale / 1.25))}><ZoomOut size={17} /></button>
      <input className="zoom-value" aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 缩放百分比`} title="缩放百分比" type="number" min={10} max={maxScale * 100} step={10} disabled={!session}
        value={zoomDraft?.base === Math.round(scale * 100) ? zoomDraft.value : Math.round(scale * 100)}
        onChange={event => {
          const raw = event.target.value, parsed = Number(raw)
          if (raw.trim() !== '' && Number.isFinite(parsed) && parsed >= 10 && parsed <= maxScale * 100) {
            const nextScale = parsed / 100
            setZoomDraft({ value: raw, base: Math.round(nextScale * 100) }); changeScale(nextScale)
          } else setZoomDraft({ value: raw, base: Math.round(scale * 100) })
        }}
        onBlur={() => {
          const currentPct = Math.round(scale * 100)
          if (zoomDraft && zoomDraft.base === currentPct && zoomDraft.value.trim() !== '' && Number.isFinite(Number(zoomDraft.value))) {
            changeScale(Math.max(0.1, Math.min(maxScale, Number(zoomDraft.value) / 100)))
          }
          setZoomDraft(null)
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur()
          else if (event.key === 'Escape') { setZoomDraft(null); event.currentTarget.blur() }
        }} /><span>%</span>
      <button title="放大" disabled={!session || scale >= maxScale} onClick={() => changeScale(Math.min(maxScale, scale * 1.25))}><ZoomIn size={17} /></button>
      <button title="整页适配" disabled={!session} onClick={() => void fitPage(pageNumber, rotation, true)}><Scan size={17} /></button>
      <button title="顺时针旋转 90°" disabled={!session} onClick={() => { activeZoom.current = null; zoomAnchor.current = null; pendingView.current = captureView(); setRotation(value => (value + 90) % 360) }}><RotateCw size={17} /></button>
      <button title="连续阅读" aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 连续阅读`} aria-pressed={readingMode !== 'off'} disabled={!session}
        onClick={() => changeReadingMode(readingMode === 'off' ? props.continuousMode ?? 'continuous-scroll' : 'off')}><BookOpen size={17} /></button>
      <button title={handTool ? '文字选择' : '抓手平移'} aria-pressed={handTool && tool.mode === 'read'} onClick={() => { if (tool.mode !== 'read') props.onExitInk?.(); setHandTool(value => !value) }}>{handTool ? <MousePointer2 size={17} /> : <Hand size={17} />}</button>
      <label className="tolerance"><input type="checkbox" checked={props.tolerant} onChange={event => props.onTolerant(event.target.checked)} />强制容错</label>
    </div>
    {props.samples.length > 0 && <div className="sample-bar"><select aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 样本`} value="" onChange={event => props.onSample(event.target.value)}>
      <option value="">本机验证样本</option>{props.samples.map(name => <option key={name}>{name}</option>)}
    </select></div>}
    {(props.error || renderError) && <div role="alert" className="error">{props.error || renderError}</div>}
    <div className={`pdf-scroll ${handTool && tool.mode === 'read' ? 'hand-tool' : ''} ${panning ? 'is-panning' : ''}`} ref={scrollRef}
      onPointerDownCapture={event => {
        suppressClick.current = false
        if (event.button !== 1 && !(handTool && tool.mode === 'read' && event.button === 0)) return
        event.preventDefault()
        activeZoom.current = null
        window.getSelection()?.removeAllRanges()
        const scroll = event.currentTarget
        panStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: scroll.scrollLeft, top: scroll.scrollTop }
        suppressClick.current = true; setPanning(true)
        scroll.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const start = panStart.current
        if (!start || start.pointerId !== event.pointerId) return
        event.currentTarget.scrollLeft = start.left + start.x - event.clientX
        event.currentTarget.scrollTop = start.top + start.y - event.clientY
      }}
      onPointerUp={event => {
        if (panStart.current?.pointerId !== event.pointerId) return
        panStart.current = null; setPanning(false)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => { panStart.current = null; setPanning(false) }}
      onLostPointerCapture={() => { panStart.current = null; setPanning(false) }}
      onAuxClick={event => { if (event.button === 1) event.preventDefault() }}>
      {!session ? (props.passwordPrompt ? <div className="empty-pane">
        <form className="password-card" autoComplete="off" onSubmit={event => {
          event.preventDefault()
          if (password) props.onPasswordSubmit?.(password)
        }}>
          <Lock size={34} />
          <h2>PDF 受密码保护</h2>
          <p className="password-file" title={props.passwordPrompt.name}>{props.passwordPrompt.name}</p>
          {props.passwordPrompt.incorrect && <div role="alert" className="error">密码错误，请重新输入</div>}
          <input ref={passwordRef} type="password" aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 密码`}
            placeholder="请输入打开密码" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} autoFocus />
          <div className="password-actions">
            <button type="button" onClick={() => props.onPasswordCancel?.()}>取消</button>
            <button type="submit" className="search-command" disabled={!password}>解锁打开</button>
          </div>
        </form>
      </div> : <div className="empty-pane"><FilePlus2 size={40} /><h2>{props.loading ? '正在打开 PDF' : '尚未打开 PDF'}</h2></div>) :
        readingMode === 'continuous-scroll' ? <div className="page-flow" style={{ width: flowWidth, height: (layout.at(-1)?.top ?? 0) + (layout.at(-1)?.height ?? 0) + 20 }}>
          {mountedPages.map(number => layout[number - 1]).filter(Boolean).map(page => <div key={page.page} className="page-slot" data-flow-page={page.page} style={{ width: page.width, height: page.height, top: page.top }}>
            <PdfPane {...props} embeddedPage={page.page} sharedScroll={scrollRef}
              sharedScale={scale} sharedRotation={rotation} sharedCache={pageCache} protectedKeys={protectedKeys}
              parentViewRevision={viewRevision}
              offscreen={!visible.includes(page.page)}
              previewPixels={Math.floor(6000000 / Math.max(3, mountedPages.length))}
              precisionPixels={Math.floor(detailPixelBudget / Math.max(1, visible.length))}
              navigation={navigation?.match.page === page.page ? navigation : null} />
          </div>)}
        </div> : paper}
    </div>
    <footer className="pane-status"><span className={busy || detailBusy || props.loading || props.passwordPrompt || (session && !session.ready) ? 'status-dot working' : 'status-dot'} />
      <span>{busy ? '渲染中' : detailBusy ? '精绘中' : props.passwordPrompt ? '等待输入密码' : session ? session.ready ? session.indexFailures ? `文字索引完成 · ${session.indexFailures} 页无法提取文字` : session.search.hasText ? `文字索引完成 · ${session.pdf.numPages} 页` : '无可提取文字 · 仅查看' : `索引中 ${session.indexed}/${session.pdf.numPages}` : '未加载'}</span>
      <span>{session?.ready ? `${matches.count} 处命中` : ''}</span>
    </footer>
  </section>
}