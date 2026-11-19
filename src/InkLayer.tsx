import { useEffect, useRef } from 'react'
import type { PDFPageProxy } from 'pdfjs-dist'
import { formatPoint, strokeHitsSegment, strokePath } from './ink'
import type { InkAction, InkTool, Point, Stroke } from './ink'

const eraserRadiusCssPx = 12
const minSampleStepCssPx = 1.5

export default function InkLayer({ page, rotation, tool, strokes, edit }: {
  page: PDFPageProxy; rotation: number; tool: InkTool; strokes: Stroke[]; edit: (action: InkAction) => void
}) {
  const vp = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 })
  const path = useRef<SVGPathElement>(null)
  const draft = useRef<{ pointer: number; points: Point[]; d: string; lastClientX: number; lastClientY: number } | null>(null)
  const erasing = useRef<{ pointer: number; last: Point; removed: Set<string> } | null>(null)
  const frame = useRef(0)

  function reset() {
    cancelAnimationFrame(frame.current); frame.current = 0
    draft.current = null; erasing.current = null
    path.current?.removeAttribute('d')
  }

  useEffect(() => reset, [tool.mode, page.pageNumber, rotation])

  function toPdfPoint(rect: DOMRect, x: number, y: number): { point: Point; radiusPdf: number } {
    const scaleX = rect.width > 0 ? rect.width / vp.width : 1
    const scaleY = rect.height > 0 ? rect.height / vp.height : 1
    const [px, py] = vp.convertToPdfPoint((x - rect.left) / scaleX, (y - rect.top) / scaleY)
    return {
      point: formatPoint(px, py),
      radiusPdf: eraserRadiusCssPx / Math.max(0.05, Math.min(scaleX, scaleY)),
    }
  }

  function append(pt: Point, clientX: number, clientY: number, force = false) {
    const s = draft.current
    if (!s) return
    if (!force && Math.hypot(clientX - s.lastClientX, clientY - s.lastClientY) < minSampleStepCssPx) return
    const prev = s.points.at(-1)
    if (prev && prev[0] === pt[0] && prev[1] === pt[1]) return
    s.points.push(pt)
    s.lastClientX = clientX
    s.lastClientY = clientY
    s.d += `L${pt[0]} ${pt[1]}`
  }

  function eraseSegment(start: Point, end: Point, radiusPdf: number) {
    const state = erasing.current
    if (!state) return
    for (const stroke of strokes) {
      if (stroke.page !== page.pageNumber || state.removed.has(stroke.id)) continue
      if (strokeHitsSegment(stroke, start, end, radiusPdf)) {
        state.removed.add(stroke.id)
        edit({ remove: stroke.id })
      }
    }
  }

  return <svg className="ink-layer" data-mode={tool.mode} width="100%" height="100%" viewBox={`0 0 ${vp.width} ${vp.height}`} preserveAspectRatio="none"
    onPointerDown={e => {
      if (!e.isPrimary || e.button !== 0 || tool.mode === 'read') return
      e.preventDefault()
      const svg = e.currentTarget
      const rect = svg.getBoundingClientRect()
      svg.setPointerCapture(e.pointerId)
      const { point, radiusPdf } = toPdfPoint(rect, e.clientX, e.clientY)
      if (tool.mode === 'erase') {
        erasing.current = { pointer: e.pointerId, last: point, removed: new Set() }
        eraseSegment(point, point, radiusPdf)
        return
      }
      const d = strokePath([point])
      draft.current = { pointer: e.pointerId, points: [point], d, lastClientX: e.clientX, lastClientY: e.clientY }
      path.current?.setAttribute('d', d)
    }}
    onPointerMove={e => {
      if (erasing.current?.pointer !== e.pointerId && draft.current?.pointer !== e.pointerId) return
      const rect = e.currentTarget.getBoundingClientRect()
      if (erasing.current?.pointer === e.pointerId) {
        const samples = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]
        for (const sample of samples.length ? samples : [e.nativeEvent]) {
          const { point, radiusPdf } = toPdfPoint(rect, sample.clientX, sample.clientY)
          eraseSegment(erasing.current.last, point, radiusPdf)
          erasing.current.last = point
        }
        return
      }
      for (const sample of e.nativeEvent.getCoalescedEvents?.() ?? []) {
        append(toPdfPoint(rect, sample.clientX, sample.clientY).point, sample.clientX, sample.clientY)
      }
      append(toPdfPoint(rect, e.clientX, e.clientY).point, e.clientX, e.clientY)
      if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; if (draft.current) path.current?.setAttribute('d', draft.current.d) })
    }}
    onPointerUp={e => {
      if (erasing.current?.pointer !== e.pointerId && draft.current?.pointer !== e.pointerId) return
      const rect = e.currentTarget.getBoundingClientRect()
      if (erasing.current?.pointer === e.pointerId) {
        const { point, radiusPdf } = toPdfPoint(rect, e.clientX, e.clientY)
        eraseSegment(erasing.current.last, point, radiusPdf)
        reset()
        return
      }
      if (!draft.current) return
      append(toPdfPoint(rect, e.clientX, e.clientY).point, e.clientX, e.clientY, true)
      edit({ add: { id: crypto.randomUUID(), page: page.pageNumber, color: tool.color, width: tool.width, path: draft.current.d, points: draft.current.points } })
      reset()
    }} onPointerCancel={reset} onLostPointerCapture={reset}>
    <g transform={`matrix(${vp.transform.join(' ')})`} fill="none" strokeLinecap="round" strokeLinejoin="round">
      {strokes.filter(s => s.page === page.pageNumber).map(s => <path key={s.id} data-stroke={s.id} d={s.path} stroke={s.color} strokeWidth={s.width} />)}
      <path ref={path} stroke={tool.color} strokeWidth={tool.width} pointerEvents="none" />
    </g>
  </svg>
}
