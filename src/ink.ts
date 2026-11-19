export type Point = readonly [number, number]
export type Stroke = { id: string; page: number; color: string; width: number; path: string; points: Point[] }
export type InkAction = { add: Stroke } | { remove: string } | 'undo'
export type InkHistoryEntry = { stroke: Stroke; removedAt: number; seq: number }
export type InkState = { id: string; strokes: Stroke[]; history: InkHistoryEntry[] }
export type InkTool = { mode: 'read' | 'draw' | 'erase'; color: string; width: number }

let nextSeq = 1

export const emptyInk = (id: string): InkState => ({ id, strokes: [], history: [] })

export function formatPoint(x: number, y: number): Point {
  return [+x.toFixed(3), +y.toFixed(3)]
}

export function strokePath(points: readonly Point[]): string {
  if (!points.length) return ''
  const [first, ...rest] = points
  if (!rest.length) return `M${first[0]} ${first[1]}L${first[0]} ${first[1]}`
  return `M${first[0]} ${first[1]}${rest.map(([x, y]) => `L${x} ${y}`).join('')}`
}

export function editInk(state: InkState, action: InkAction): InkState {
  const { strokes, history } = state
  if (action === 'undo') {
    const last = history.at(-1)
    if (!last) return state
    const next = last.removedAt < 0 ? strokes.filter(s => s.id !== last.stroke.id) : [...strokes]
    if (last.removedAt >= 0) next.splice(Math.min(last.removedAt, next.length), 0, last.stroke)
    return { ...state, strokes: next, history: history.slice(0, -1) }
  }
  if ('add' in action) {
    return {
      ...state,
      strokes: [...strokes, action.add],
      history: [...history, { stroke: action.add, removedAt: -1, seq: nextSeq++ }],
    }
  }
  const index = strokes.findIndex(s => s.id === action.remove)
  if (index < 0) return state
  return {
    ...state,
    strokes: strokes.filter(s => s.id !== action.remove),
    history: [...history, { stroke: strokes[index], removedAt: index, seq: nextSeq++ }],
  }
}

function pointToSegmentDistSq(p: Point, a: Point, b: Point): number {
  const abx = b[0] - a[0], aby = b[1] - a[1]
  const lenSq = abx * abx + aby * aby
  if (lenSq <= 1e-9) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq))
  const cx = a[0] + t * abx, cy = a[1] + t * aby
  return (p[0] - cx) ** 2 + (p[1] - cy) ** 2
}

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b)
  const d3 = cross(a, b, c), d4 = cross(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function segmentToSegmentDistSq(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    pointToSegmentDistSq(a, c, d),
    pointToSegmentDistSq(b, c, d),
    pointToSegmentDistSq(c, a, b),
    pointToSegmentDistSq(d, a, b),
  )
}

export function strokeHitsSegment(stroke: Stroke, start: Point, end: Point, radiusPdf: number): boolean {
  const threshold = radiusPdf + stroke.width / 2
  const thresholdSq = threshold * threshold
  const pts = stroke.points
  if (!pts.length) return false
  if (pts.length === 1) return pointToSegmentDistSq(pts[0], start, end) <= thresholdSq
  for (let i = 1; i < pts.length; i++) {
    if (segmentToSegmentDistSq(pts[i - 1], pts[i], start, end) <= thresholdSq) return true
  }
  return false
}
