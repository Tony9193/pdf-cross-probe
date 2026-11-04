import { useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import { ChevronLeft, ChevronRight, Columns2, Rows2, Search, Spotlight, Square, X, PanelsTopLeft, MonitorUp, Trash2 } from 'lucide-react'
import PdfPane from './PdfPane'
import type { ColoredMatch, Navigation, TextSelection } from './PdfPane'
import { createPdfTask, indexPage } from './pdf'
import type { DocumentSession } from './pdf'
import { DocumentSearchIndex, nextMatchIndex, splitKeywords } from './search'
import type { SearchResult } from './search'
import './App.css'

const palette = ['#e33c41', '#14856d', '#1975d2', '#c27700', '#bc438f', '#5b64bc', '#008b9b', '#765629']
type Term = { id: string; value: string; color: string }
type DocumentInfo = { id: string; name: string; bytes: Uint8Array }
type SharedState = { terms: Term[]; dim: boolean; tolerant: boolean[] }
type DocumentMetadata = { id: string; name: string; indexed: number; ready: boolean; texts: string[] }
type RemoteDocument = { id: string; name: string; indexed: number; ready: boolean; search: DocumentSearchIndex }
type MatchPosition = { documentId: string; index: number; mode: SearchResult['mode'] }
type FocusTarget = { slot: number; termId: string; position: MatchPosition; navigation: Navigation; active?: boolean }

function App() {
  const detached = new URLSearchParams(location.search).get('panel') === 'right'
  const [documents, setDocuments] = useState<(DocumentSession | null)[]>([null, null])
  const [remoteLeft, setRemoteLeft] = useState<RemoteDocument | null>(null)
  const remoteLeftRef = useRef(remoteLeft)
  const tasksRef = useRef<(PDFDocumentLoadingTask | null)[]>([null, null])
  const readRequests = useRef(['', ''])
  const pendingFocus = useRef<FocusTarget[]>([])
  const viewsRef = useRef<(null | { documentId: string; page: number })[]>([null, null])
  const [errors, setErrors] = useState(['', '']), [loading, setLoading] = useState([false, false])
  const [terms, setTerms] = useState<Term[]>([]), [input, setInput] = useState('')
  const [tolerant, setTolerant] = useState([false, false]), [dim, setDim] = useState(false)
  const previousTolerance = useRef(tolerant)
  const [vertical, setVertical] = useState(false), [separated, setSeparated] = useState(false)
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
  const stateRef = useRef<SharedState>({ terms, dim, tolerant }), colorCounter = useRef(0)
  documentsRef.current = documents; termsRef.current = terms; stateRef.current = { terms, dim, tolerant }

  function searchResult(session: DocumentSession | RemoteDocument, term: Term, slot: number): SearchResult {
    const result = session.search.search(term.value, stateRef.current.tolerant[slot])
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

  function sendFocus(termId: string, page?: number, slot?: number, direction?: number) {
    const targets = locate(termId, page, slot, direction)
    channel.current?.postMessage({ type: 'focus', targets })
  }

  function setKeywordState(next: Term[]) {
    const allowed = new Set(next.map(term => term.id))
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
  function addTerms(values: string[], source?: { slot: number; selection: TextSelection }) {
    const next = [...termsRef.current]
    for (const value of values) {
      if (!next.some(term => term.value.toUpperCase() === value.toUpperCase())) next.push({ id: crypto.randomUUID(), value, color: palette[colorCounter.current++ % palette.length] })
    }
    setKeywordState(next)
    const focus = next.find(term => term.value.toUpperCase() === values.at(-1)?.toUpperCase())?.id
    const targets = focus ? locate(focus, undefined, undefined, undefined, source) : []
    broadcast({ ...stateRef.current, terms: next }, targets)
  }

  function metadata(session: DocumentSession): DocumentMetadata {
    return { id: session.id, name: session.name, indexed: session.indexed, ready: session.ready, texts: session.pages.map(page => page.text) }
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
    for (const text of value.texts.slice(start)) search.append(text)
    const next = { id: value.id, name: value.name, indexed: value.indexed, ready: value.ready, search }
    remoteLeftRef.current = next
    statsRef.current = [next, documentsRef.current[1]]
    setRemoteLeft(next)
  }

  async function loadDocument(slot: number, name: string, bytes: Uint8Array, id = crypto.randomUUID()) {
    if (detached && slot === 0) return
    const revision = ++revisions.current[slot]
    readRequests.current[slot] = id
    const previous = tasksRef.current[slot]
    tasksRef.current[slot] = null
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
      task = createPdfTask(bytes)
      tasksRef.current[slot] = task
      const pdf = await task.promise
      if (revisions.current[slot] !== revision) { await pdf.loadingTask.destroy(); return }
      const session: DocumentSession = { id, name, bytes, pdf, pages: [], indexed: 0, ready: false, search: new DocumentSearchIndex() }
      setDocuments(value => value.map((item, index) => index === slot ? session : item))
      for (let page = 1; page <= pdf.numPages; page++) {
        const indexedPage = await indexPage(pdf, page)
        if (revisions.current[slot] !== revision) { await pdf.loadingTask.destroy(); return }
        session.pages.push(indexedPage); session.indexed = page
        session.search.append(indexedPage.text)
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
        setErrors(value => value.map((item, index) => index === slot ? error instanceof Error ? error.message : String(error) : item))
        setDocuments(value => value.map((item, index) => index === slot ? null : item))
        if (slot === 0) channel.current?.postMessage({ type: 'left-index', left: null })
      }
    } finally {
      if (revisions.current[slot] === revision) setLoading(value => value.map((item, index) => index === slot ? false : item))
    }
  }

  async function loadFile(slot: number, file: File) {
    const id = crypto.randomUUID(); readRequests.current[slot] = id
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (readRequests.current[slot] !== id) return
      if (slot === 1) channel.current?.postMessage({ type: 'file', file: { id, name: file.name, bytes } })
      await loadDocument(slot, file.name, bytes, id)
    } catch (error) { setErrors(value => value.map((item, index) => index === slot ? String(error) : item)) }
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
    } catch (error) { setErrors(value => value.map((item, index) => index === slot ? String(error) : item)) }
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
        const rightFile: DocumentInfo | null = right ? { id: right.id, name: right.name, bytes: right.bytes } : null
        communication.postMessage({ type: 'state', state: stateRef.current, left: left ? metadata(left) : null, right: rightFile, targets: snapshotFocus() })
      } else if (message.type === 'state') {
        const state = message.state as SharedState
        setKeywordState(state.terms); stateRef.current = state
        if ('left' in message) previousTolerance.current = state.tolerant
        colorCounter.current = Math.max(colorCounter.current, state.terms.length)
        setDim(state.dim); setTolerant(state.tolerant)
        if ('left' in message) receiveLeft(message.left)
        if (message.right) void loadDocument(1, message.right.name, new Uint8Array(message.right.bytes), message.right.id)
        if (message.targets) applyFocus(message.targets)
        else if (message.focus) locate(message.focus)
      } else if (message.type === 'file') void loadDocument(1, message.file.name, new Uint8Array(message.file.bytes), message.file.id)
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
    const url = new URL(location.href); url.searchParams.set('panel', 'right')
    childWindow.current = window.open(url.href, '_blank')
    setConnectionError(childWindow.current ? '' : '新窗口未打开，请允许弹出窗口后重试')
  }
  function restore() { channel.current?.postMessage({ type: 'restore' }); childWindow.current?.close(); setSeparated(false) }
  const visibleSlots = detached ? [1] : separated ? [0] : [0, 1]
  const noText = (slot: number) => statsDocuments[slot]?.ready && !statsDocuments[slot]?.search.hasText

  return <main className="app-shell">
    <header className="app-header"><div className="brand"><PanelsTopLeft size={22} /><div><h1>PDF 联动查看器</h1><span>Cross Probe / 本地原型</span></div></div>
      <div className="header-actions">
        {!detached && !separated && <div className="segmented"><button title="左右分屏" aria-pressed={!vertical} onClick={() => setVertical(false)}><Columns2 size={18} /></button><button title="上下分屏" aria-pressed={vertical} onClick={() => setVertical(true)}><Rows2 size={18} /></button></div>}
        <div className="segmented"><button title="色块描边" aria-pressed={!dim} onClick={() => { setDim(false); broadcast({ ...stateRef.current, dim: false }) }}><Square size={18} /></button><button title="PADS 高亮模式" aria-pressed={dim} onClick={() => { setDim(true); broadcast({ ...stateRef.current, dim: true }) }}><Spotlight size={18} /></button></div>
        {!detached && <button className="command" onClick={separated ? restore : separate}><MonitorUp size={17} />{separated ? '恢复双栏' : '双屏窗口'}</button>}<span className="local-badge">仅本机</span>
      </div>
    </header>
    {connectionError && <div className="error" role="alert">{connectionError}</div>}
    <div className="workspace"><aside className="search-sidebar">
      <div className="sidebar-title"><h2>联动搜索</h2><span>{terms.length} 个关键词</span></div>
      <form onSubmit={event => { event.preventDefault(); addTerms(splitKeywords(input)); setInput('') }}>
        <textarea aria-label="关键词" placeholder={'R3501\nVDD_IO'} value={input} onChange={event => setInput(event.target.value)} />
        <button className="search-command" type="submit" disabled={!input.trim()}><Search size={16} />追加高亮</button>
      </form>
      <div className="results-heading"><h2>命中清单</h2><button title="清空关键词" disabled={!terms.length} onClick={() => { setKeywordState([]); broadcast({ ...stateRef.current, terms: [] }) }}><Trash2 size={16} /></button></div>
      <div className="term-list">{terms.map(term => <section className="term-result" key={term.id}>
        <div className="term-heading"><button className="term-name" onClick={() => sendFocus(term.id)}><span className="swatch" style={{ background: term.color }} /><strong>{term.value}</strong></button>
          <button title={`删除 ${term.value}`} onClick={() => { const next = termsRef.current.filter(value => value.id !== term.id); setKeywordState(next); broadcast({ ...stateRef.current, terms: next }) }}><X size={15} /></button></div>
        {[0, 1].map(slot => {
          const result = results[slot].get(term.id), pages = [...new Set(result?.matches.map(match => match.page) ?? [])]
          const position = positions[`${slot}:${term.id}`]
          const current = position?.documentId === statsDocuments[slot]?.id && position?.mode === result?.mode && result?.matches[position.index] ? position.index : -1
          return <div className="document-result" key={slot}><div><b>{slot === 0 ? 'A' : 'B'}</b><span>{!statsDocuments[slot] ? '未加载' : !statsDocuments[slot]?.ready ? `${result?.matches.length ?? 0} 处 · 索引中` : noText(slot) ? '仅查看' : result?.matches.length ? `${result.matches.length} 处` : '未命中'}</span>
            {result?.mode === 'tolerant' && !!result.matches.length && !noText(slot) && <small>容错</small>}</div>
            {!!result?.matches.length && <div className="match-navigation">
              <button title={`${term.value} · 文档 ${slot === 0 ? 'A' : 'B'} · 上一处`} onClick={() => sendFocus(term.id, undefined, slot, -1)}><ChevronLeft size={14} /></button>
              <span data-position={`${slot}:${term.value}`}>{current < 0 ? '未定位' : `${current + 1} / ${result.matches.length}`}</span>
              <button title={`${term.value} · 文档 ${slot === 0 ? 'A' : 'B'} · 下一处`} onClick={() => sendFocus(term.id, undefined, slot, 1)}><ChevronRight size={14} /></button>
            </div>}
            <div className="page-links">{pages.map(page => <button key={page} title={`${term.value} · 第 ${page} 页`} onClick={() => sendFocus(term.id, page, slot, 1)}>p.{page}<span>{result!.matches.filter(match => match.page === page).length}</span></button>)}</div>
          </div>
        })}
      </section>)}</div><footer className="sidebar-footer">PDF.js · {import.meta.env.DEV ? '开发验证版' : '离线查看'}</footer>
    </aside>
    <div className={`panes ${vertical ? 'vertical' : ''} ${visibleSlots.length === 1 ? 'single' : ''}`}>
      {visibleSlots.map(slot => <PdfPane key={slot} slot={slot} session={documents[slot]} error={errors[slot]} loading={loading[slot]} matches={colored[slot]} navigation={navigation[slot]} dim={dim} tolerant={tolerant[slot]} samples={samples}
        onFile={file => void loadFile(slot, file)} onSample={name => void loadSample(slot, name)} onTerm={(value, selection) => addTerms([value], { slot, selection })}
        onViewChange={(documentId, page) => { const view = { documentId, page }; viewsRef.current[slot] = view; channel.current?.postMessage({ type: 'view', slot, view }) }}
        onTolerant={value => { const next = tolerant.map((item, index) => index === slot ? value : item); setTolerant(next); broadcast({ ...stateRef.current, tolerant: next }) }} />)}
    </div></div>
  </main>
}
export default App