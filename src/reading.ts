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
  const visible = layout.filter(page => page.top + page.height > top && page.top < top + height)
  if (!visible.length) return layout.length ? [Math.max(1, Math.min(layout.length, layout.findIndex(page => page.top > top) + 1 || layout.length))] : []
  return visible.map(page => page.page)
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