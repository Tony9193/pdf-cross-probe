import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { BookOpen, ChevronLeft, ChevronRight, FilePlus2, Hand, Lock, MousePointer2, RotateCw, Scan, X, ZoomIn, ZoomOut } from 'lucide-react'
import { indexPage } from './pdf'
import type { DocumentSession, PageIndex } from './pdf'
import { keywordAt } from './search'
import type { Match } from './search'
import { pageLayout, visiblePages, wheelPage } from './reading'
import type { ReadingMode, ViewSnapshot, WheelState } from './reading'
import 'pdfjs-dist/web/pdf_viewer.css'

export type ColoredMatch = Match & { term: string; color: string }
export type Navigation = { id: string; documentId: string; term: string; match: Match; preservePosition?: boolean }
export type PasswordPrompt = { id: string; name: string; incorrect: boolean; attempts: number }
export type TextSelection = { page: number; start: number; length: number }
type Rectangle = { left: number; top: number; width: number; height: number; term: string; color: string; start: number; length: number }
const maxScale = 32
const detailPixelBudget = 6000000
const maxCachedTextDivs = 30000
let activeRenders = 0
const renderQueue: (() => void)[] = []
function acquireRenderSlot(): Promise<() => void> {
  return new Promise(resolve => {
    const enter = () => {
      activeRenders++
      resolve(() => { activeRenders--; renderQueue.shift()?.() })
    }
    if (activeRenders < 2) enter()
    else renderQueue.push(enter)
  })
}
type PreparedPage = {
  key: string; index: PageIndex; divs: HTMLElement[]; buffer: HTMLCanvasElement
  layer: HTMLDivElement; width: number; height: number; page: PDFPageProxy; error: string; textReady: boolean
  precision?: { buffer: HTMLCanvasElement; left: number; top: number; width: number; height: number; scale: number }
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

function preparePage(session: DocumentSession, pageNumber: number, rotation = 0, onPreview?: (preview: PreparedPage) => void, maxItems?: number, previewPixels = 2000000) {
  let cancelled = false, finished = false
  let renderTask: RenderTask | undefined
  let textLayer: TextLayer | undefined
  const pageKey = `${session.id}:${pageNumber}:${rotation}`
  const promise = (async (): Promise<PreparedPage> => {
    const page = await session.pdf.getPage(pageNumber)
    if (cancelled) throw new Error('Page preparation cancelled')
    const content = await page.getTextContent({ disableNormalization: true })
    if (cancelled) throw new Error('Page preparation cancelled')
    if (maxItems !== undefined) {
      const textItemCount = content.items.reduce((count, item) => count + ('str' in item ? 1 : 0), 0)
      if (textItemCount > maxItems) throw new Error('Prefetch skipped: exceeds text layer cache budget')
    }
    const effectiveRotation = (page.rotate + rotation) % 360
    const viewport = page.getViewport({ scale: 1, rotation: effectiveRotation })
    const ratio = Math.min(1, Math.sqrt(previewPixels / (viewport.width * viewport.height)))
    const buffer = document.createElement('canvas')
    buffer.width = Math.max(1, Math.floor(viewport.width * ratio))
    buffer.height = Math.max(1, Math.floor(viewport.height * ratio))
    const stagingLayer = document.createElement('div')
    stagingLayer.className = 'textLayer'
    const fontHeights = content.items.flatMap(item => 'str' in item && item.str.trim() ? [Math.hypot(item.transform[2], item.transform[3])] : []).filter(height => height > 0)
    const smallestFont = fontHeights.reduce((smallest, height) => Math.min(smallest, height), 16)
    // 先放大文字层再整体缩回页面尺寸，降低极小文字布局的精度损失。
    const textScale = Math.min(64, 2 ** Math.max(0, Math.ceil(Math.log2(16 / smallestFont))))
    stagingLayer.style.setProperty('--scale-factor', String(textScale))
    stagingLayer.style.setProperty('--total-scale-factor', String(textScale))
    stagingLayer.style.transform = `scale(${1 / textScale})`
    stagingLayer.style.transformOrigin = '0 0'
    const release = await acquireRenderSlot()
    try {
      if (cancelled) throw new Error('Page preparation cancelled')
      renderTask = page.render({ canvas: buffer, viewport, transform: [ratio, 0, 0, ratio, 0, 0], background: '#ffffff' })
      await renderTask.promise
    } finally { release() }
    if (cancelled) throw new Error('Page preparation cancelled')
    if (onPreview) {
      const emptyLayer = document.createElement('div')
      emptyLayer.className = 'textLayer'
      onPreview({ key: pageKey, index: { text: '', segments: [] }, divs: [], buffer,
        layer: emptyLayer, width: viewport.width, height: viewport.height, page, error: '', textReady: false })
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (cancelled) throw new Error('Page preparation cancelled')
    }
    textLayer = new TextLayer({ textContentSource: content, container: stagingLayer, viewport: page.getViewport({ scale: textScale, rotation: effectiveRotation }) })
    await Promise.all([renderTask.promise, textLayer.render()])
    if (cancelled) throw new Error('Page preparation cancelled')
    stagingLayer.style.width = `${viewport.width * textScale}px`
    stagingLayer.style.height = `${viewport.height * textScale}px`
    const index = session.pages[pageNumber - 1] ?? await indexPage(session.pdf, pageNumber)
    if (cancelled) throw new Error('Page preparation cancelled')
    // 命中偏移依赖索引段与文字层逐项对应；不一致时禁用文字层，避免错误高亮和取词。
    const aligned = index.segments.length === textLayer.textDivs.length && !index.segments.some((segment, position) => segment.text !== textLayer!.textContentItemsStr[position])
    const error = aligned ? '' : '文字索引与文字层不一致，本页仅查看，已停止高亮以避免错位'
    if (!aligned) stagingLayer.replaceChildren()
    finished = true
    return { key: pageKey, index: aligned ? index : { text: '', segments: [] }, divs: aligned ? textLayer.textDivs : [],
      buffer, layer: stagingLayer, width: viewport.width, height: viewport.height, page, error, textReady: true }
  })()
  return { promise, cancel() { if (!finished) { cancelled = true; renderTask?.cancel(); textLayer?.cancel() } } }
}

type Props = {
  slot: number; session: DocumentSession | null; error: string; loading: boolean
  collapsed?: boolean; transitioning?: boolean
  dimOpacity?: number; autoFitOnLoad?: boolean; rotationTrigger?: number
  defaultReadingMode?: ReadingMode; continuousMode?: ReadingMode; restoreView?: ViewSnapshot | null
  embeddedPage?: number; sharedScroll?: RefObject<HTMLDivElement | null>; sharedScale?: number; sharedRotation?: number
  sharedCache?: RefObject<Map<string, PreparedPage>>; protectedKeys?: Set<string>; previewPixels?: number; precisionPixels?: number
  passwordPrompt?: PasswordPrompt | null
  matches: ColoredMatch[]; navigation: Navigation | null; dim: boolean; tolerant: boolean; samples: string[]
  onFile: (file: File) => void; onSample: (name: string) => void
  onActivate?: () => void
  onClose?: () => void
  onPasswordSubmit?: (password: string) => void; onPasswordCancel?: () => void
  onTerm: (term: string, selection: TextSelection) => void; onTolerant: (value: boolean) => void
  onViewChange?: (documentId: string, page: number, view?: ViewSnapshot) => void
}

export default function PdfPane(props: Props) {
  const { slot, session, matches, navigation, dim } = props
  const [localPageNumber, setPageNumber] = useState(1)
  const [localScale, setScale] = useState(1)
  const [localRotation, setRotation] = useState(0)
  const pageNumber = props.embeddedPage ?? localPageNumber
  const scale = props.sharedScale ?? localScale, rotation = props.sharedRotation ?? localRotation
  const [readingMode, setReadingMode] = useState<ReadingMode>(props.defaultReadingMode ?? 'off')
  const [pageMetadata, setPageMetadata] = useState<PDFPageProxy[]>([])
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
  const detailRegion = useRef<{ left: number; top: number; width: number; height: number; scale: number } | null>(null)
  const requestedScale = useRef(scale)
  requestedScale.current = scale
  const queuedScale = useRef(scale)
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

  const sizes = pageMetadata.map(page => {
    const viewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 })
    return { width: viewport.width, height: viewport.height }
  })
  const layout = pageLayout(sizes, scale)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const mountedPages = [...new Set([...visible, ...selectionPages,
    Math.max(1, visible[0] - 1), Math.min(session?.pdf.numPages ?? 1, visible.at(-1)! + 1)])].sort((first, second) => first - second)
  const protectedKeys = new Set(mountedPages.map(number => `${session?.id}:${number}:${rotation}`))

  function findFlowPage(items: ReturnType<typeof pageLayout>, flowY: number) {
    let target = items[0]
    for (const item of items) {
      if (flowY < item.top) break
      target = item
      if (flowY <= item.top + item.height) break
    }
    return target
  }

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
      const target = findFlowPage(committed.layout, flowY) ?? committed.layout[pageNumber - 1]
      const page = target ? pageMetadata[target.page - 1] : (pageMetadata[pageNumber - 1] ?? committedPage.current?.page)
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
    const page = pageMetadata[pageNumber - 1] ?? committedPage.current?.page
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

  function changeReadingMode(mode: ReadingMode) {
    if (mode === readingMode) return
    activeZoom.current = null; zoomAnchor.current = null
    pendingView.current = captureView()
    if (pendingView.current) pendingView.current.mode = mode
    committedKey.current = ''; committedBuffer.current = null
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
    activeZoom.current = null; zoomAnchor.current = null
    queuedScale.current = value
    if (readingMode === 'continuous-scroll' && value !== scale) pendingView.current = captureView()
    setScale(value)
  }

  useEffect(() => {
    for (const job of backgroundJobs.current) job.cancel()
    backgroundJobs.current.clear()
    for (const entry of props.embeddedPage ? [] : pageCache.current.values()) {
      entry.buffer.width = 0; entry.buffer.height = 0; entry.layer.replaceChildren()
      if (entry.precision) { entry.precision.buffer.width = 0; entry.precision.buffer.height = 0 }
    }
    if (!props.embeddedPage) pageCache.current.clear()
    oversizedPrefetchKeys.current.clear()
    committedPage.current = null; committedKey.current = ''; committedBuffer.current = null
    detailRegion.current = null; displayedScale.current = 1
    if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0 }
    if (detailRef.current) { detailRef.current.width = 0; detailRef.current.height = 0; detailRef.current.style.display = 'none' }
    layerRef.current?.replaceChildren()
    const view = props.restoreView?.documentId === session?.id ? props.restoreView ?? null : null
    pendingView.current = view
    lastView.current = view
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
    if (!props.embeddedPage) scrollRef.current?.scrollTo(0, 0)
    if (session && props.autoFitOnLoad && !view && !props.embeddedPage) void fitPage(1, 0)
  }, [session?.id])

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

  useEffect(() => {
    if (!session || props.embeddedPage) return
    let cancelled = false
    void (async () => {
      const pages: PDFPageProxy[] = []
      for (let number = 1; number <= session.pdf.numPages; number++) {
        if (cancelled) return
        pages.push(await session.pdf.getPage(number))
      }
      if (!cancelled) setPageMetadata(pages)
    })().catch(() => {})
    return () => { cancelled = true; setPageMetadata([]) }
  }, [session?.id])

  useLayoutEffect(() => {
    const layer = layerRef.current
    return () => {
      if (layer && committedPage.current) committedPage.current.layer.replaceChildren(...layer.childNodes)
    }
  }, [session?.id, readingMode])

  useEffect(() => {
    setPassword('')
    if (props.passwordPrompt) passwordRef.current?.focus()
  }, [props.passwordPrompt?.id, props.passwordPrompt?.attempts])

  const renderKey = `${session?.id}:${pageNumber}:${rotation}`
  activeKey.current = renderKey

  function cachePage(entry: PreparedPage) {
    const cache = pageCache.current
    cache.delete(entry.key); cache.set(entry.key, entry)
    const overBudget = () => cache.size > 3 || [...cache.values()].reduce((total, item) => total + item.buffer.width * item.buffer.height, 0) > 6000000 || [...cache.values()].reduce((total, item) => total + item.divs.length, 0) > maxCachedTextDivs
    while (overBudget()) {
      const victim = [...cache.keys()].find(key => key !== activeKey.current && key !== committedKey.current && !props.protectedKeys?.has(key))
      if (!victim) break
      if (victim === entry.key) oversizedPrefetchKeys.current.add(entry.key)
      const removed = cache.get(victim)!
      cache.delete(victim)
      removed.buffer.width = 0; removed.buffer.height = 0; removed.layer.replaceChildren()
      if (removed.precision) { removed.precision.buffer.width = 0; removed.precision.buffer.height = 0 }
    }
    if (paperRef.current) {
      paperRef.current.dataset.cachedPages = String(cache.size)
      paperRef.current.dataset.cachedPixels = String([...cache.values()].reduce((total, item) => total + item.buffer.width * item.buffer.height, 0))
    }
  }

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
    const job = preparePage(session, pageNumber, rotation, preview => { if (!cancelled) setRendered(preview) }, undefined, props.previewPixels)
    void job.promise.then(entry => {
      if (cancelled) return
      cachePage(entry); setRendered(entry); setRenderError(entry.error)
    }).catch(error => { if (!cancelled) setRenderError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true; job.cancel() }
  }, [session?.id, pageNumber, rotation, renderKey, readingMode])

  useEffect(() => {
    if (props.embeddedPage || readingMode === 'continuous-scroll' || !session || busy || detailBusy || rendered?.key !== renderKey || !rendered.textReady) return
    let cancelled = false
    let idle: { type: 'idle' | 'timeout'; handle: number } | null = null
    const timer = window.setTimeout(() => {
      idle = scheduleIdle(() => {
        void (async () => {
          for (const adjacent of [pageNumber + 1, pageNumber - 1]) {
            if (cancelled || adjacent < 1 || adjacent > session.pdf.numPages) continue
            const key = `${session.id}:${adjacent}:${rotation}`
            if (oversizedPrefetchKeys.current.has(key)) continue
            const cached = pageCache.current.get(key)
            if (cached) { cachePage(cached); continue }
            const remainingDivBudget = maxCachedTextDivs - rendered.divs.length
            if (remainingDivBudget <= 0) break
            const job = preparePage(session, adjacent, rotation, undefined, remainingDivBudget)
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
    return () => {
      cancelled = true; clearTimeout(timer); cancelIdle(idle)
      for (const job of backgroundJobs.current) job.cancel()
      backgroundJobs.current.clear()
    }
  }, [session?.id, rendered, pageNumber, rotation, renderKey, busy, detailBusy, readingMode])

  useLayoutEffect(() => {
    if (!rendered || rendered.key !== renderKey || !paperRef.current) return
    const canvas = canvasRef.current, layer = layerRef.current, paper = paperRef.current
    const content = contentRef.current, scroll = scrollRef.current
    if (!canvas || !layer || !content || !scroll) return
    const pageChanged = committedKey.current !== rendered.key
    if (pageChanged || committedBuffer.current !== rendered.buffer || committedPage.current?.layer !== rendered.layer) {
      if (committedPage.current && committedPage.current !== rendered) committedPage.current.layer.replaceChildren(...layer.childNodes)
      canvas.width = rendered.buffer.width; canvas.height = rendered.buffer.height
      canvas.getContext('2d', { alpha: false })!.drawImage(rendered.buffer, 0, 0)
      canvas.style.width = `${rendered.width}px`; canvas.style.height = `${rendered.height}px`
      content.style.width = `${rendered.width}px`; content.style.height = `${rendered.height}px`
      layer.style.cssText = rendered.layer.style.cssText
      layer.replaceChildren(...rendered.layer.childNodes)
      committedKey.current = rendered.key
      committedBuffer.current = rendered.buffer
      committedPage.current = rendered
      paper.dataset.renderedPage = String(rendered.page.pageNumber)
      paper.dataset.renderPhase = rendered.textReady ? 'ready' : 'preview'
      detailRegion.current = null
      if (detailRef.current) detailRef.current.style.display = 'none'
      const precision = rendered.precision, detail = detailRef.current
      if (precision?.scale === scale && precision.buffer.width && detail) {
        detail.width = precision.buffer.width; detail.height = precision.buffer.height
        detail.getContext('2d', { alpha: false })!.drawImage(precision.buffer, 0, 0)
        detail.style.left = `${precision.left}px`; detail.style.top = `${precision.top}px`
        detail.style.width = `${precision.width}px`; detail.style.height = `${precision.height}px`
        detail.style.display = 'block'; detail.dataset.scale = String(scale)
        detailRegion.current = precision
      }
    }
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
    const origin = paperRef.current.getBoundingClientRect()
    const next: Rectangle[] = []
    for (const match of matches.filter(hit => hit.page === pageNumber)) {
      const fragments: Rectangle[] = []
      rendered.index.segments.forEach((segment, segmentIndex) => {
        const start = Math.max(match.start, segment.start) - segment.start
        const end = Math.min(match.start + match.length, segment.start + segment.text.length) - segment.start
        if (end <= start) return
        const node = rendered.divs[segmentIndex]?.firstChild
        if (!node || node.nodeType !== Node.TEXT_NODE) return
        const range = document.createRange()
        range.setStart(node, Math.min(start, node.textContent?.length ?? 0))
        range.setEnd(node, Math.min(end, node.textContent?.length ?? 0))
        const boxes = start === 0 && end === segment.text.length ? [rendered.divs[segmentIndex].getBoundingClientRect()] : range.getClientRects()
        for (const rect of boxes) {
          if (rect.width && rect.height) fragments.push({
            left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height,
            term: match.term, color: match.color, start: match.start, length: match.length,
          })
        }
      })
      if (fragments.length) {
        const left = Math.min(...fragments.map(rect => rect.left)), top = Math.min(...fragments.map(rect => rect.top))
        const right = Math.max(...fragments.map(rect => rect.left + rect.width)), bottom = Math.max(...fragments.map(rect => rect.top + rect.height))
        next.push({ ...fragments[0], left, top, width: right - left, height: bottom - top })
      }
    }
    setRectangles(next)
  }, [rendered, matches, pageNumber, renderKey, scale])

  useLayoutEffect(() => {
    if (props.embeddedPage) return
    const scroll = scrollRef.current
    if (session && scroll && pendingView.current && pendingView.current.documentId === session.id) {
      const view = pendingView.current
      const page = pageMetadata[view.page - 1] ?? (rendered?.page.pageNumber === view.page ? rendered.page : undefined)
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
            const current = layout.find(item => center >= item.top && center < item.top + item.height + 20)
            if (current) setPageNumber(previous => previous === current.page ? previous : current.page)
          }
        }
        committedFlow.current = { documentId: session.id, scale, rotation, mode: readingMode, layout }
        reportView()
        return
      }
    }
    if (session) {
      queuedScale.current = scale
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
      left: Math.max(0, target.left + target.width / 2 + paddingLeft - scroll.clientWidth / 2),
      top: Math.max(0, target.top + target.height / 2 + pageOffset - scroll.clientHeight / 2), behavior: 'instant',
    })
    if (performance.now() >= expandingUntil.current) lastNavigation.current = navigation.id
  }, [rectangles, navigation, pageNumber, session?.id, props.collapsed, viewRevision])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || props.embeddedPage) return
    let frame = 0, reportTimer = 0
    const invalidate = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        setViewRevision(value => value + 1)
        if (readingMode === 'continuous-scroll') {
          const pages = visiblePages(layoutRef.current, scroll.scrollTop, scroll.clientHeight)
          if (pages.length) {
            setVisible(previous => previous.join(',') === pages.join(',') ? previous : pages)
            const center = scroll.scrollTop + scroll.clientHeight / 2
            const current = layoutRef.current.find(page => center >= page.top && center < page.top + page.height + 20)
            if (current && !pendingView.current) setPageNumber(current.page)
          }
        }
        reportView()
      })
    }
    const onScroll = () => {
      if (!reportTimer) reportTimer = window.setTimeout(() => { reportTimer = 0; invalidate() }, 120)
    }
    const onSelection = () => {
      const selection = getSelection()
      if (!selection?.toString()) {
        if (selectedPages.current.size) { selectedPages.current.clear(); setSelectionPages([]) }
        return
      }
      if (!scroll.contains(selection.anchorNode) && !scroll.contains(selection.focusNode)) return
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
      invalidate()
    })
    observer.observe(scroll)
    invalidate()
    return () => { clearTimeout(reportTimer); cancelAnimationFrame(frame); observer.disconnect(); scroll.removeEventListener('scroll', onScroll); document.removeEventListener('selectionchange', onSelection) }
  }, [readingMode, pageMetadata])

  const handleWheel = useEffectEvent((event: WheelEvent) => {
    const scroll = scrollRef.current
    if (!scroll || !session || !event.deltaY) return
    if (!event.ctrlKey) {
      if (readingMode !== 'wheel-page' || Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey || getSelection()?.toString()) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientHeight : 1)
      const atEdge = delta > 0 ? scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2 : scroll.scrollTop <= 2
      const next = wheelPage(wheelState.current, delta, performance.now(), atEdge, busy || committedKey.current !== renderKey)
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
      setScale(committedScale)
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
        const target = findFlowPage(committed.layout, flowY) ?? committed.layout[pageNumber - 1]
        const page = target && pageMetadata[target.page - 1]
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
    setScale(nextScale)
  })

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || props.embeddedPage) return
    const listener = (event: WheelEvent) => handleWheel(event)
    scroll.addEventListener('wheel', listener, { passive: false })
    return () => scroll.removeEventListener('wheel', listener)
  }, [props.embeddedPage])

  useEffect(() => {
    if (!rendered || rendered.key !== renderKey || !rendered.textReady) return
    const scroll = scrollRef.current, paper = paperRef.current
    if (!scroll || !paper) return
    let cancelled = false
    let dirty = false, running = false, timer = 0
    let task: RenderTask | undefined
    let previousTop = scroll.scrollTop, previousLeft = scroll.scrollLeft, previousTime = performance.now()
    let aheadX = 0, aheadY = 0
    const request = () => {
      if (cancelled) return
      const now = performance.now(), elapsed = Math.max(1, now - previousTime)
      aheadX = Math.max(-scroll.clientWidth * 0.3, Math.min(scroll.clientWidth * 0.3, (scroll.scrollLeft - previousLeft) / elapsed * 120))
      aheadY = Math.max(-scroll.clientHeight * 0.3, Math.min(scroll.clientHeight * 0.3, (scroll.scrollTop - previousTop) / elapsed * 120))
      previousLeft = scroll.scrollLeft; previousTop = scroll.scrollTop; previousTime = now
      dirty = true
      if (!running && !timer) timer = window.setTimeout(draw, 60)
    }
    const draw = async () => {
      timer = 0; dirty = false; running = true
      let release
      try {
        release = await acquireRenderSlot()
        if (cancelled || requestedScale.current !== scale) return
        const detail = detailRef.current
        if (!detail) return
        const area = scroll.getBoundingClientRect(), origin = paper.getBoundingClientRect()
        const visibleLeft = Math.max(0, Math.min(rendered.width * scale, area.left - origin.left))
        const visibleTop = Math.max(0, Math.min(rendered.height * scale, area.top - origin.top))
        const visibleRight = Math.max(visibleLeft, Math.min(rendered.width * scale, area.left + scroll.clientWidth - origin.left))
        const visibleBottom = Math.max(visibleTop, Math.min(rendered.height * scale, area.top + scroll.clientHeight - origin.top))
        const cached = detailRegion.current
        if (cached?.scale === scale && cached.left <= visibleLeft && cached.top <= visibleTop &&
          cached.left + cached.width >= visibleRight && cached.top + cached.height >= visibleBottom) return
        const paddingX = Math.ceil(scroll.clientWidth * 0.35), paddingY = Math.ceil(scroll.clientHeight * 0.35)
        const left = Math.max(0, Math.floor(visibleLeft - paddingX + Math.min(0, aheadX)))
        const top = Math.max(0, Math.floor(visibleTop - paddingY + Math.min(0, aheadY)))
        const right = Math.min(rendered.width * scale, Math.ceil(visibleRight + paddingX + Math.max(0, aheadX)))
        const bottom = Math.min(rendered.height * scale, Math.ceil(visibleBottom + paddingY + Math.max(0, aheadY)))
        const width = right - left, height = bottom - top
        if (width < 1 || height < 1 || !scroll.clientWidth || !scroll.clientHeight) return
        setDetailBusy(true)
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt((props.precisionPixels ?? detailPixelBudget) / (width * height)))
        const buffer = document.createElement('canvas')
        buffer.width = Math.max(1, Math.floor(width * ratio)); buffer.height = Math.max(1, Math.floor(height * ratio))
        const effectiveRotation = (rendered.page.rotate + rotation) % 360
        task = rendered.page.render({ canvas: buffer, viewport: rendered.page.getViewport({ scale, rotation: effectiveRotation }),
          transform: [ratio, 0, 0, ratio, -left * ratio, -top * ratio], background: '#ffffff' })
        await task.promise
        if (cancelled || requestedScale.current !== scale) return
        detail.width = buffer.width; detail.height = buffer.height
        detail.getContext('2d', { alpha: false })!.drawImage(buffer, 0, 0)
        detail.style.left = `${left}px`; detail.style.top = `${top}px`
        detail.style.width = `${width}px`; detail.style.height = `${height}px`
        detail.style.display = 'block'
        detail.dataset.scale = String(scale)
        detailRegion.current = { left, top, width, height, scale }
        const cachedPage = pageCache.current.get(renderKey)
        if (cachedPage) {
          const previous = cachedPage.precision
          cachedPage.precision = { buffer, left, top, width, height, scale }
          if (previous) { previous.buffer.width = 0; previous.buffer.height = 0 }
          const precisionPixels = () => [...pageCache.current.values()].reduce((total, entry) => total + (entry.precision ? entry.precision.buffer.width * entry.precision.buffer.height : 0), 0)
          for (const entry of pageCache.current.values()) {
            if (precisionPixels() <= detailPixelBudget) break
            if (entry.key !== activeKey.current && !props.protectedKeys?.has(entry.key) && entry.precision) {
              entry.precision.buffer.width = 0; entry.precision.buffer.height = 0; entry.precision = undefined
            }
          }
          if (paperRef.current) paperRef.current.dataset.cachedPrecisionPixels = String(precisionPixels())
        }
      } catch (error) {
        if (!cancelled) setRenderError(error instanceof Error ? error.message : String(error))
      } finally {
        release?.()
        running = false
        if (!cancelled) {
          setDetailBusy(false)
          if (dirty && !timer) timer = window.setTimeout(draw, 60)
        }
      }
    }
    scroll.addEventListener('scroll', request, { passive: true })
    const observer = new ResizeObserver(request)
    observer.observe(scroll)
    request()
    return () => { cancelled = true; clearTimeout(timer); task?.cancel(); observer.disconnect(); scroll.removeEventListener('scroll', request) }
  }, [rendered, renderKey, scale, rotation, props.precisionPixels])

  async function fitPage(targetPage = pageNumber, targetRotation = rotation, preserveCenter = false) {
    if (!session || !scrollRef.current) return
    const scroll = scrollRef.current
    const style = getComputedStyle(scroll)
    const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
    const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
    const page = await session.pdf.getPage(targetPage)
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
        {rectangles.map((rect, index) => <rect key={index} x={rect.left - 2} y={rect.top - 2} width={rect.width + 4} height={rect.height + 4} fill="black" />)}
      </mask></defs><rect width="100%" height="100%" fill={`rgba(0,0,0,${props.dimOpacity ?? 0.62})`} mask={`url(#mask-${slot}-${pageNumber})`} />
    </svg>}
    <div className="highlight-layer">{rectangles.map((rect, index) => <div key={index} data-term={rect.term}
      data-start={rect.start} data-length={rect.length} className={`hit-rectangle ${navigation?.match.page === pageNumber && navigation?.match.start === rect.start && navigation?.match.length === rect.length && navigation?.term === rect.term ? 'current-hit' : ''}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, borderColor: rect.color, background: `${rect.color}30` }} />)}</div>
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
      <input aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 页码`} type="number" min={1} max={session?.pdf.numPages ?? 1} disabled={!session} value={pageNumber}
        onChange={event => goToPage(Number(event.target.value) || 1)} />
      <span>/ {session?.pdf.numPages ?? 0}</span>
      <button title="下一页" disabled={!session || pageNumber >= session.pdf.numPages} onClick={() => goToPage(pageNumber + 1)}><ChevronRight size={17} /></button><i />
      <button title="缩小" disabled={!session || scale <= 0.1} onClick={() => changeScale(Math.max(0.1, scale / 1.25))}><ZoomOut size={17} /></button>
      <input className="zoom-value" aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 缩放百分比`} title="缩放百分比" type="number" min={10} max={maxScale * 100} step={10} disabled={!session}
        value={Math.round(scale * 100)} onChange={event => changeScale(Math.max(0.1, Math.min(maxScale, (Number(event.target.value) || 10) / 100)))} /><span>%</span>
      <button title="放大" disabled={!session || scale >= maxScale} onClick={() => changeScale(Math.min(maxScale, scale * 1.25))}><ZoomIn size={17} /></button>
      <button title="整页适配" disabled={!session} onClick={() => void fitPage(pageNumber, rotation, true)}><Scan size={17} /></button>
      <button title="顺时针旋转 90°" disabled={!session} onClick={() => { activeZoom.current = null; zoomAnchor.current = null; pendingView.current = captureView(); setRotation(value => (value + 90) % 360) }}><RotateCw size={17} /></button>
      <button title="连续阅读" aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 连续阅读`} aria-pressed={readingMode !== 'off'} disabled={!session}
        onClick={() => changeReadingMode(readingMode === 'off' ? props.continuousMode ?? 'continuous-scroll' : 'off')}><BookOpen size={17} /></button>
      <button title={handTool ? '文字选择' : '抓手平移'} aria-pressed={handTool} onClick={() => setHandTool(value => !value)}>{handTool ? <MousePointer2 size={17} /> : <Hand size={17} />}</button>
      <label className="tolerance"><input type="checkbox" checked={props.tolerant} onChange={event => props.onTolerant(event.target.checked)} />强制容错</label>
    </div>
    {props.samples.length > 0 && <div className="sample-bar"><select aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 样本`} value="" onChange={event => props.onSample(event.target.value)}>
      <option value="">本机验证样本</option>{props.samples.map(name => <option key={name}>{name}</option>)}
    </select></div>}
    {(props.error || renderError) && <div role="alert" className="error">{props.error || renderError}</div>}
    <div className={`pdf-scroll ${handTool ? 'hand-tool' : ''} ${panning ? 'is-panning' : ''}`} ref={scrollRef}
      onPointerDownCapture={event => {
        suppressClick.current = false
        if (event.button !== 1 && !(handTool && event.button === 0)) return
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
        readingMode === 'continuous-scroll' ? <div className="page-flow" style={{ width: Math.max(0, ...layout.map(page => page.width)) }}>
          {layout.map(page => <div key={page.page} className="page-slot" data-flow-page={page.page} style={{ width: page.width, height: page.height, marginBottom: 20 }}>
            {mountedPages.includes(page.page) && <PdfPane {...props} embeddedPage={page.page} sharedScroll={scrollRef}
              sharedScale={scale} sharedRotation={rotation} sharedCache={pageCache} protectedKeys={protectedKeys}
              previewPixels={Math.floor(6000000 / Math.max(3, mountedPages.length))}
              precisionPixels={Math.floor(detailPixelBudget / Math.max(1, visible.length))}
              navigation={navigation?.match.page === page.page ? navigation : null} />}
          </div>)}
        </div> : paper}
    </div>
    <footer className="pane-status"><span className={busy || detailBusy || props.loading || props.passwordPrompt || (session && !session.ready) ? 'status-dot working' : 'status-dot'} />
      <span>{busy ? '渲染中' : detailBusy ? '精绘中' : props.passwordPrompt ? '等待输入密码' : session ? session.ready ? session.pages.some(page => page.text.trim()) ? `文字索引完成 · ${session.pdf.numPages} 页` : '无可提取文字 · 仅查看' : `索引中 ${session.indexed}/${session.pdf.numPages}` : '未加载'}</span>
      <span>{session?.ready ? `${matches.length} 处命中` : ''}</span>
    </footer>
  </section>
}