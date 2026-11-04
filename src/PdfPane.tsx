import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { ChevronLeft, ChevronRight, FilePlus2, Hand, MousePointer2, Scan, ZoomIn, ZoomOut } from 'lucide-react'
import { indexPage } from './pdf'
import type { DocumentSession, PageIndex } from './pdf'
import { keywordAt } from './search'
import type { Match } from './search'
import 'pdfjs-dist/web/pdf_viewer.css'

export type ColoredMatch = Match & { term: string; color: string }
export type Navigation = { id: string; documentId: string; term: string; match: Match; preservePosition?: boolean }
export type TextSelection = { page: number; start: number; length: number }
type Rectangle = { left: number; top: number; width: number; height: number; term: string; color: string; start: number; length: number }
const maxScale = 32
const detailPixelBudget = 6000000
type PreparedPage = {
  key: string; index: PageIndex; divs: HTMLElement[]; buffer: HTMLCanvasElement
  layer: HTMLDivElement; width: number; height: number; page: PDFPageProxy; error: string; textReady: boolean
  precision?: { buffer: HTMLCanvasElement; left: number; top: number; width: number; height: number; scale: number }
}

function preparePage(session: DocumentSession, pageNumber: number, onPreview?: (preview: PreparedPage) => void) {
  let cancelled = false, finished = false
  let renderTask: RenderTask | undefined
  let textLayer: TextLayer | undefined
  const promise = (async (): Promise<PreparedPage> => {
    const page = await session.pdf.getPage(pageNumber)
    if (cancelled) throw new Error('Page preparation cancelled')
    const viewport = page.getViewport({ scale: 1 })
    const ratio = Math.min(1, Math.sqrt(2000000 / (viewport.width * viewport.height)))
    const buffer = document.createElement('canvas')
    buffer.width = Math.max(1, Math.floor(viewport.width * ratio))
    buffer.height = Math.max(1, Math.floor(viewport.height * ratio))
    const stagingLayer = document.createElement('div')
    stagingLayer.className = 'textLayer'
    const content = await page.getTextContent({ disableNormalization: true })
    if (cancelled) throw new Error('Page preparation cancelled')
    const fontHeights = content.items.flatMap(item => 'str' in item && item.str.trim() ? [Math.hypot(item.transform[2], item.transform[3])] : []).filter(height => height > 0)
    const smallestFont = fontHeights.reduce((smallest, height) => Math.min(smallest, height), 16)
    const textScale = Math.min(64, 2 ** Math.max(0, Math.ceil(Math.log2(16 / smallestFont))))
    stagingLayer.style.setProperty('--scale-factor', String(textScale))
    stagingLayer.style.setProperty('--total-scale-factor', String(textScale))
    stagingLayer.style.transform = `scale(${1 / textScale})`
    stagingLayer.style.transformOrigin = '0 0'
    renderTask = page.render({ canvas: buffer, viewport, transform: [ratio, 0, 0, ratio, 0, 0], background: '#ffffff' })
    await renderTask.promise
    if (cancelled) throw new Error('Page preparation cancelled')
    if (onPreview) {
      const emptyLayer = document.createElement('div')
      emptyLayer.className = 'textLayer'
      onPreview({ key: `${session.id}:${pageNumber}`, index: { text: '', segments: [] }, divs: [], buffer,
        layer: emptyLayer, width: viewport.width, height: viewport.height, page, error: '', textReady: false })
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (cancelled) throw new Error('Page preparation cancelled')
    }
    textLayer = new TextLayer({ textContentSource: content, container: stagingLayer, viewport: page.getViewport({ scale: textScale }) })
    await Promise.all([renderTask.promise, textLayer.render()])
    if (cancelled) throw new Error('Page preparation cancelled')
    stagingLayer.style.width = `${viewport.width * textScale}px`
    stagingLayer.style.height = `${viewport.height * textScale}px`
    const index = session.pages[pageNumber - 1] ?? await indexPage(session.pdf, pageNumber)
    if (cancelled) throw new Error('Page preparation cancelled')
    const aligned = index.segments.length === textLayer.textDivs.length && !index.segments.some((segment, position) => segment.text !== textLayer!.textContentItemsStr[position])
    const error = aligned ? '' : '文字索引与文字层不一致，本页仅查看，已停止高亮以避免错位'
    if (!aligned) stagingLayer.replaceChildren()
    finished = true
    return { key: `${session.id}:${pageNumber}`, index: aligned ? index : { text: '', segments: [] }, divs: aligned ? textLayer.textDivs : [],
      buffer, layer: stagingLayer, width: viewport.width, height: viewport.height, page, error, textReady: true }
  })()
  return { promise, cancel() { if (!finished) { cancelled = true; renderTask?.cancel(); textLayer?.cancel() } } }
}

type Props = {
  slot: number; session: DocumentSession | null; error: string; loading: boolean
  matches: ColoredMatch[]; navigation: Navigation | null; dim: boolean; tolerant: boolean; samples: string[]
  onFile: (file: File) => void; onSample: (name: string) => void
  onTerm: (term: string, selection: TextSelection) => void; onTolerant: (value: boolean) => void
  onViewChange?: (documentId: string, page: number) => void
}

export default function PdfPane(props: Props) {
  const { slot, session, matches, navigation, dim } = props
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1)
  const [rectangles, setRectangles] = useState<Rectangle[]>([])
  const [rendered, setRendered] = useState<PreparedPage | null>(null)
  const pageCache = useRef(new Map<string, PreparedPage>())
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLCanvasElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const lastNavigation = useRef('')
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const committedKey = useRef('')
  const committedBuffer = useRef<HTMLCanvasElement | null>(null)
  const displayedScale = useRef(1)
  const detailRegion = useRef<{ left: number; top: number; width: number; height: number; scale: number } | null>(null)
  const requestedScale = useRef(scale)
  requestedScale.current = scale
  const zoomAnchor = useRef<{ x: number; y: number; screenX: number; screenY: number } | null>(null)
  const panStart = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const suppressClick = useRef(false)

  useEffect(() => {
    for (const job of backgroundJobs.current) job.cancel()
    backgroundJobs.current.clear()
    for (const entry of pageCache.current.values()) {
      entry.buffer.width = 0; entry.buffer.height = 0; entry.layer.replaceChildren()
      if (entry.precision) { entry.precision.buffer.width = 0; entry.precision.buffer.height = 0 }
    }
    pageCache.current.clear(); committedPage.current = null
    setPageNumber(1); setScale(1); setRectangles([]); setRendered(null)
    setBusy(false); setDetailBusy(false); setRenderError(''); setPanning(false)
    panStart.current = null; pointerStart.current = null; zoomAnchor.current = null
    lastNavigation.current = ''
    scrollRef.current?.scrollTo(0, 0)
  }, [session?.id])

  useEffect(() => {
    if (navigation && navigation.documentId === session?.id) setPageNumber(navigation.match.page)
  }, [navigation, session?.id])

  useEffect(() => {
    if (session) props.onViewChange?.(session.id, pageNumber)
  }, [session?.id, pageNumber])

  const renderKey = `${session?.id}:${pageNumber}`
  activeKey.current = renderKey

  function cachePage(entry: PreparedPage) {
    const cache = pageCache.current
    cache.delete(entry.key); cache.set(entry.key, entry)
    const overBudget = () => cache.size > 3 || [...cache.values()].reduce((total, item) => total + item.buffer.width * item.buffer.height, 0) > 6000000 || [...cache.values()].reduce((total, item) => total + item.divs.length, 0) > 30000
    while (overBudget()) {
      const victim = [...cache.keys()].find(key => key !== activeKey.current && key !== committedKey.current)
      if (!victim) break
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
    const job = preparePage(session, pageNumber, preview => { if (!cancelled) setRendered(preview) })
    void job.promise.then(entry => {
      if (cancelled) return
      cachePage(entry); setRendered(entry); setRenderError(entry.error)
    }).catch(error => { if (!cancelled) setRenderError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true; job.cancel() }
  }, [session?.id, pageNumber, renderKey])

  useEffect(() => {
    if (!session || busy || detailBusy || rendered?.key !== renderKey) return
    let cancelled = false, idle = 0
    const timer = window.setTimeout(() => {
      idle = window.requestIdleCallback(() => {
        void (async () => {
          for (const adjacent of [pageNumber + 1, pageNumber - 1]) {
            if (cancelled || adjacent < 1 || adjacent > session.pdf.numPages) continue
            const key = `${session.id}:${adjacent}`
            const cached = pageCache.current.get(key)
            if (cached) { cachePage(cached); continue }
            const job = preparePage(session, adjacent)
            backgroundJobs.current.add(job)
            try {
              const entry = await job.promise
              if (!cancelled) cachePage(entry)
            } catch { if (cancelled) break }
            finally { backgroundJobs.current.delete(job) }
          }
        })()
      }, { timeout: 1000 })
    }, 350)
    return () => {
      cancelled = true; clearTimeout(timer); if (idle) window.cancelIdleCallback(idle)
      for (const job of backgroundJobs.current) job.cancel()
      backgroundJobs.current.clear()
    }
  }, [session?.id, rendered, pageNumber, renderKey, busy, detailBusy])

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
    const paddingLeft = Number.parseFloat(getComputedStyle(scroll).paddingLeft)
    const paddingTop = Number.parseFloat(getComputedStyle(scroll).paddingTop)
    const anchor = zoomAnchor.current
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
    if (!pageChanged && displayedScale.current !== scale) scroll.scrollTo({
      left: Math.max(0, centerX * scale + paddingLeft - (anchor?.screenX ?? scroll.clientWidth / 2)),
      top: Math.max(0, centerY * scale + paddingTop - (anchor?.screenY ?? scroll.clientHeight / 2)), behavior: 'instant',
    })
    zoomAnchor.current = null
    displayedScale.current = scale
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
    if (!navigation || navigation.documentId !== session?.id || navigation.match.page !== pageNumber || lastNavigation.current === navigation.id) return
    const target = next.find(rect => rect.start === navigation.match.start && rect.length === navigation.match.length && rect.term === navigation.term)
    if (navigation.preservePosition) { lastNavigation.current = navigation.id; return }
    if (target && scrollRef.current) {
      scrollRef.current.scrollTo({
        left: Math.max(0, target.left + target.width / 2 + paddingLeft - scrollRef.current.clientWidth / 2),
        top: Math.max(0, target.top + target.height / 2 + paddingTop - scrollRef.current.clientHeight / 2), behavior: 'instant',
      })
      lastNavigation.current = navigation.id
    }
  }, [rendered, matches, navigation, pageNumber, renderKey, session?.id, scale])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    let frame = 0
    const invalidate = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setViewRevision(value => value + 1))
    }
    scroll.addEventListener('scroll', invalidate, { passive: true })
    const observer = new ResizeObserver(invalidate)
    observer.observe(scroll)
    return () => { scroll.removeEventListener('scroll', invalidate); cancelAnimationFrame(frame); observer.disconnect() }
  }, [])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const zoom = (event: WheelEvent) => {
      if (!event.ctrlKey || !session || !event.deltaY) return
      event.preventDefault()
      const bounds = scroll.getBoundingClientRect()
      const screenX = event.clientX - bounds.left, screenY = event.clientY - bounds.top
      const paddingLeft = Number.parseFloat(getComputedStyle(scroll).paddingLeft)
      const paddingTop = Number.parseFloat(getComputedStyle(scroll).paddingTop)
      zoomAnchor.current = {
        x: (scroll.scrollLeft + screenX - paddingLeft) / requestedScale.current,
        y: (scroll.scrollTop + screenY - paddingTop) / requestedScale.current,
        screenX, screenY,
      }
      setScale(value => Math.max(0.1, Math.min(maxScale, value * (event.deltaY < 0 ? 1.15 : 1 / 1.15))))
    }
    scroll.addEventListener('wheel', zoom, { passive: false })
    return () => scroll.removeEventListener('wheel', zoom)
  }, [session?.id])

  useEffect(() => {
    if (!rendered || rendered.key !== renderKey || !rendered.textReady) return
    const scroll = scrollRef.current, paper = paperRef.current
    if (!scroll || !paper) return
    const area = scroll.getBoundingClientRect(), origin = paper.getBoundingClientRect()
    const visibleLeft = Math.max(0, Math.min(rendered.width * scale, area.left - origin.left))
    const visibleTop = Math.max(0, Math.min(rendered.height * scale, area.top - origin.top))
    const visibleRight = Math.max(visibleLeft, Math.min(rendered.width * scale, area.left + scroll.clientWidth - origin.left))
    const visibleBottom = Math.max(visibleTop, Math.min(rendered.height * scale, area.top + scroll.clientHeight - origin.top))
    const cached = detailRegion.current
    if (cached?.scale === scale && cached.left <= visibleLeft && cached.top <= visibleTop &&
      cached.left + cached.width >= visibleRight && cached.top + cached.height >= visibleBottom) {
      setDetailBusy(false)
      return
    }
    const paddingX = Math.ceil(scroll.clientWidth * 0.15), paddingY = Math.ceil(scroll.clientHeight * 0.15)
    const left = Math.max(0, Math.floor(visibleLeft - paddingX))
    const top = Math.max(0, Math.floor(visibleTop - paddingY))
    const right = Math.min(rendered.width * scale, Math.ceil(visibleRight + paddingX))
    const bottom = Math.min(rendered.height * scale, Math.ceil(visibleBottom + paddingY))
    const width = right - left, height = bottom - top
    if (width < 1 || height < 1) { setDetailBusy(false); return }
    let cancelled = false
    let task: RenderTask | undefined
    setDetailBusy(true)
    const timer = window.setTimeout(async () => {
      try {
        const detail = detailRef.current
        if (!detail) return
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(detailPixelBudget / (width * height)))
        const buffer = document.createElement('canvas')
        buffer.width = Math.max(1, Math.floor(width * ratio)); buffer.height = Math.max(1, Math.floor(height * ratio))
        task = rendered.page.render({ canvas: buffer, viewport: rendered.page.getViewport({ scale }),
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
            if (entry.key !== activeKey.current && entry.precision) {
              entry.precision.buffer.width = 0; entry.precision.buffer.height = 0; entry.precision = undefined
            }
          }
          if (paperRef.current) paperRef.current.dataset.cachedPrecisionPixels = String(precisionPixels())
        }
      } catch (error) {
        if (!cancelled) setRenderError(error instanceof Error ? error.message : String(error))
      } finally { if (!cancelled) setDetailBusy(false) }
    }, 120)
    return () => { cancelled = true; clearTimeout(timer); task?.cancel() }
  }, [rendered, renderKey, scale, viewRevision])

  async function fitPage() {
    if (!session || !scrollRef.current) return
    const viewport = (await session.pdf.getPage(pageNumber)).getViewport({ scale: 1 })
    setScale(Math.max(0.1, Math.min(maxScale, (scrollRef.current.clientWidth - 48) / viewport.width,
      (scrollRef.current.clientHeight - 48) / viewport.height)))
  }

  function clickText(event: React.MouseEvent) {
    const start = pointerStart.current
    if (suppressClick.current || handTool || !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || !rendered || rendered.key !== renderKey) return
    if (window.getSelection()?.toString()) return
    const target = (event.target as HTMLElement).closest('span')
    const segmentIndex = rendered.divs.findIndex(div => div === target)
    const segment = rendered.index.segments[segmentIndex]
    if (!segment?.text.trim()) return
    const node = target?.firstChild
    if (!node || node.nodeType !== Node.TEXT_NODE) return
    const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY)
    let localOffset: number | null = caret?.offsetNode === node ? caret.offset : null
    if (localOffset === null) {
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

  return <section className={`pdf-pane ${dragging ? 'drop-active' : ''}`} data-slot={slot}
    onDragOver={event => { event.preventDefault(); setDragging(true) }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }}
    onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) props.onFile(file) }}>
    <header className="pane-header"><span className="slot-label">{slot === 0 ? 'A' : 'B'}</span>
      <strong title={session?.name}>{session?.name ?? (slot === 0 ? '原理图' : '位号 / 丝印 / 走线图')}</strong>
      <button title="打开 PDF" onClick={() => fileRef.current?.click()}><FilePlus2 size={17} /><span>打开 PDF</span></button>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={event => {
        const file = event.target.files?.[0]; if (file) props.onFile(file); event.target.value = ''
      }} />
    </header>
    <div className="pane-toolbar">
      <button title="上一页" disabled={!session || pageNumber <= 1} onClick={() => setPageNumber(value => value - 1)}><ChevronLeft size={17} /></button>
      <input aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 页码`} type="number" min={1} max={session?.pdf.numPages ?? 1} value={pageNumber}
        onChange={event => setPageNumber(Math.max(1, Math.min(session?.pdf.numPages ?? 1, Number(event.target.value) || 1)))} />
      <span>/ {session?.pdf.numPages ?? 0}</span>
      <button title="下一页" disabled={!session || pageNumber >= session.pdf.numPages} onClick={() => setPageNumber(value => value + 1)}><ChevronRight size={17} /></button><i />
      <button title="缩小" disabled={!session || scale <= 0.1} onClick={() => setScale(value => Math.max(0.1, value / 1.25))}><ZoomOut size={17} /></button>
      <input className="zoom-value" aria-label={`文档 ${slot === 0 ? 'A' : 'B'} 缩放百分比`} title="缩放百分比" type="number" min={10} max={maxScale * 100} step={10} disabled={!session}
        value={Math.round(scale * 100)} onChange={event => setScale(Math.max(0.1, Math.min(maxScale, (Number(event.target.value) || 10) / 100)))} /><span>%</span>
      <button title="放大" disabled={!session || scale >= maxScale} onClick={() => setScale(value => Math.min(maxScale, value * 1.25))}><ZoomIn size={17} /></button>
      <button title="整页适配" disabled={!session} onClick={() => void fitPage()}><Scan size={17} /></button>
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
      {!session ? <div className="empty-pane"><FilePlus2 size={40} /><h2>{props.loading ? '正在打开 PDF' : '尚未打开 PDF'}</h2></div> :
        <div className="paper" ref={paperRef} data-page={pageNumber}>
          <div className="page-content" ref={contentRef}>
            <canvas ref={canvasRef} className="base-canvas" />
            <div ref={layerRef} className="textLayer" onPointerDown={event => { pointerStart.current = { x: event.clientX, y: event.clientY } }} onClick={clickText} />
          </div>
          <canvas ref={detailRef} className="detail-canvas" style={{ display: 'none' }} />
          {dim && rectangles.length > 0 && <svg className="dim-layer" width="100%" height="100%">
            <defs><mask id={`mask-${slot}`}><rect width="100%" height="100%" fill="white" />
              {rectangles.map((rect, index) => <rect key={index} x={rect.left - 2} y={rect.top - 2} width={rect.width + 4} height={rect.height + 4} fill="black" />)}
            </mask></defs><rect width="100%" height="100%" fill="rgba(0,0,0,.62)" mask={`url(#mask-${slot})`} />
          </svg>}
          <div className="highlight-layer">{rectangles.map((rect, index) => <div key={index} data-term={rect.term}
            data-start={rect.start} data-length={rect.length} className={`hit-rectangle ${navigation?.match.page === pageNumber && navigation?.match.start === rect.start && navigation?.match.length === rect.length && navigation?.term === rect.term ? 'current-hit' : ''}`} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, borderColor: rect.color, background: `${rect.color}30` }} />)}</div>
        </div>}
    </div>
    <footer className="pane-status"><span className={busy || detailBusy || props.loading || (session && !session.ready) ? 'status-dot working' : 'status-dot'} />
      <span>{busy ? '渲染中' : detailBusy ? '精绘中' : session ? session.ready ? session.pages.some(page => page.text.trim()) ? `文字索引完成 · ${session.pdf.numPages} 页` : '无可提取文字 · 仅查看' : `索引中 ${session.indexed}/${session.pdf.numPages}` : '未加载'}</span>
      <span>{session?.ready ? `${matches.length} 处命中` : ''}</span>
    </footer>
  </section>
}