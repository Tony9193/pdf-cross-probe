import { GlobalWorkerOptions, OPS, getDocument } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { angleDistance, DocumentSearchIndex } from './search'

GlobalWorkerOptions.workerSrc = workerUrl

export type Segment = { start: number; text: string; padReferenceOffset?: number }
export type PageIndex = { text: string; segments: Segment[]; padReferenceBoundaries?: number[] }
export type DocumentSession = {
  id: string
  name: string
  bytes: Uint8Array
  password?: string
  pdf: PDFDocumentProxy
  pages: PageIndex[]
  indexed: number
  ready: boolean
  search: DocumentSearchIndex
}

export function createPdfTask(bytes: Uint8Array, password?: string) {
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('文件不是有效的 PDF')
  return getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: `${import.meta.env.BASE_URL}pdf-assets/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${import.meta.env.BASE_URL}pdf-assets/standard_fonts/`,
    wasmUrl: `${import.meta.env.BASE_URL}pdf-assets/wasm/`,
  })
}

export async function openPdf(bytes: Uint8Array, password?: string) {
  return createPdfTask(bytes, password).promise
}

export async function indexPage(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageIndex> {
  const page = await pdf.getPage(pageNumber)
  // 保留 PDF 原始文本，让搜索索引自行归一化并映射回文本位置。
  const content = await page.getTextContent({ disableNormalization: true })
  const padTagPattern = /^PAU(?:FB|TP|R|C|U|L|Q|D|J|F)[0-9]+$/i
  const candidates = new Set(content.items.flatMap(item =>
    'str' in item && padTagPattern.test(item.str.trim()) ? [item.str.trim().toUpperCase()] : []))
  const invisibleTags = new Set<string>()
  if (candidates.size >= 3) {
    try {
      const operators = await page.getOperatorList()
      const visibleTags = new Set<string>(), savedModes: number[] = []
      let mode = 0
      for (let index = 0; index < operators.fnArray.length; index++) {
        const operator = operators.fnArray[index], args = operators.argsArray[index] as unknown[] | null
        if (operator === OPS.save) savedModes.push(mode)
        else if (operator === OPS.restore) mode = savedModes.pop() ?? mode
        else if (operator === OPS.setTextRenderingMode && typeof args?.[0] === 'number') mode = args[0]
        else if (operator === OPS.showText && Array.isArray(args?.[0])) {
          const value = (args[0] as unknown[]).map(glyph => {
            if (typeof glyph !== 'object' || glyph === null || !('unicode' in glyph)) return ''
            return typeof glyph.unicode === 'string' ? glyph.unicode : ''
          }).join('').trim().toUpperCase()
          if (!candidates.has(value)) continue
          if (mode === 3) invisibleTags.add(value)
          else visibleTags.add(value)
        }
      }
      if (invisibleTags.size < 3) invisibleTags.clear()
      else for (const value of visibleTags) invisibleTags.delete(value)
    } catch { invisibleTags.clear() }
  }
  let text = ''
  const segments: Segment[] = []
  const padReferenceBoundaries: number[] = []
  let previous: { endX: number; endY: number; angle: number; hasEOL: boolean } | undefined
  for (const item of content.items) {
    if (!('str' in item)) continue
    const angle = Math.atan2(item.transform[1], item.transform[0])
    const height = Math.max(item.height, Math.hypot(item.transform[2], item.transform[3]), 1)
    if (previous && item.str) {
      const deltaX = item.transform[4] - previous.endX
      const deltaY = item.transform[5] - previous.endY
      // 按当前文字方向分解间距，使旋转文本也能判断片段是否相邻。
      const along = deltaX * Math.cos(angle) + deltaY * Math.sin(angle)
      const across = Math.abs(-deltaX * Math.sin(angle) + deltaY * Math.cos(angle))
      const adjacent = !previous.hasEOL && angleDistance(angle, previous.angle) < 0.05 &&
        across < height * 0.3 && along >= -height * 0.2 && along < height * 0.3
      // 非相邻片段插入分隔符，避免跨行或远距离文本被拼成一个搜索词。
      if (!adjacent && text && !/\s$/.test(text)) text += '\n'
    }
    const padReferenceOffset = invisibleTags.has(item.str.trim().toUpperCase())
      ? item.str.length - item.str.trimStart().length + 3 : undefined
    if (padReferenceOffset !== undefined) padReferenceBoundaries.push(text.length + padReferenceOffset)
    segments.push({ start: text.length, text: item.str, padReferenceOffset })
    text += item.str
    if (item.str) previous = {
      endX: item.transform[4] + Math.cos(angle) * item.width,
      endY: item.transform[5] + Math.sin(angle) * item.width,
      angle, hasEOL: item.hasEOL,
    }
  }
  return { text, segments, padReferenceBoundaries }
}