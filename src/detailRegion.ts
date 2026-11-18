export type Region = { left: number; top: number; width: number; height: number }
export type DetailRegion = Region & { scale: number; dpr: number }

export function overlap(a: Region, b: Region) {
  return Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))
}

export function needsDetail(current: DetailRegion | null, visible: Region, pageWidth: number, pageHeight: number,
  scale: number, dpr: number, aheadX: number, aheadY: number, refill = false) {
  if (!current || current.scale !== scale || current.dpr !== dpr) return true
  const left = visible.left - current.left, top = visible.top - current.top
  const right = current.width - visible.width - left, bottom = current.height - visible.height - top
  if (Math.min(left, top, right, bottom) < -0.5) return true
  // Restore the depleted margin once at rest; while moving, only refill the leading edge.
  const x = refill ? visible.width * 0.26 : Math.min(visible.width * 0.17, Math.abs(aheadX))
  const y = refill ? visible.height * 0.26 : Math.min(visible.height * 0.17, Math.abs(aheadY))
  return ((refill || aheadX < 0) && current.left > 0 && left < x) ||
    ((refill || aheadX > 0) && current.left + current.width < pageWidth - 0.5 && right < x) ||
    ((refill || aheadY < 0) && current.top > 0 && top < y) ||
    ((refill || aheadY > 0) && current.top + current.height < pageHeight - 0.5 && bottom < y)
}
