export type ReadingMode = 'off' | 'continuous-scroll' | 'wheel-page'
export type ViewSnapshot = {
  documentId: string; page: number; scale: number; rotation: number; mode: ReadingMode
  x: number; y: number
  unscaledY?: number
  navigationId?: string
  screenX?: number; screenY?: number
}
export type PageSize = { width: number; height: number }

export function pageLayout(sizes: PageSize[], scale: number, gap = 20) {
  let top = 0
  return sizes.map((size, index) => {
    const page = { page: index + 1, top, width: size.width * scale, height: size.height * scale }
    top += page.height + gap
    return page
  })
}

export function visiblePages(layout: ReturnType<typeof pageLayout>, top: number, height: number) {
  let low = 0, high = layout.length
  while (low < high) {
    const mid = (low + high) >>> 1
    const page = layout[mid]
    if (page.top + page.height <= top) low = mid + 1
    else high = mid
  }
  const pages = []
  for (let i = low; i < layout.length && layout[i].top < top + height; i++) pages.push(layout[i].page)
  return pages.length ? pages : layout.length ? [Math.min(layout.length, low + 1)] : []
}

export function flowPage(layout: ReturnType<typeof pageLayout>, y: number) {
  let low = 0, high = layout.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (layout[mid].top <= y) low = mid + 1
    else high = mid
  }
  return layout[Math.max(0, low - 1)]
}

export type WheelState = { time: number; direction: number; amount: number; locked: boolean }
export function wheelPage(state: WheelState, delta: number, now: number, atEdge: boolean, busy: boolean) {
  const idle = now - state.time > 240
  const direction = Math.sign(delta)
  const fresh = idle || direction !== state.direction
  const next: WheelState = { time: now, direction, amount: fresh ? 0 : state.amount, locked: fresh ? false : state.locked }
  if (!atEdge || busy || !direction) { next.amount = 0; return { state: next, turn: 0 } }
  next.amount += Math.abs(delta)
  if (next.locked || next.amount < 80) return { state: next, turn: 0 }
  next.locked = true; next.amount = 0
  return { state: next, turn: direction }
}