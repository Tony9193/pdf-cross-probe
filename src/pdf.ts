import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { angleDistance, DocumentSearchIndex } from './search'

GlobalWorkerOptions.workerSrc = workerUrl

export type Segment = { start: number; text: string }
export type PageIndex = { text: string; segments: Segment[] }
export type DocumentSession = {
  id: string
  name: string
  bytes: Uint8Array
  pdf: PDFDocumentProxy
  pages: PageIndex[]
  indexed: number
  ready: boolean
  search: DocumentSearchIndex
}

export function createPdfTask(bytes: Uint8Array) {
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('文件不是有效的 PDF')
  return getDocument({
    data: bytes.slice(),
    cMapUrl: `${import.meta.env.BASE_URL}pdf-assets/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${import.meta.env.BASE_URL}pdf-assets/standard_fonts/`,
    wasmUrl: `${import.meta.env.BASE_URL}pdf-assets/wasm/`,
  })
}

export async function openPdf(bytes: Uint8Array) {
  return createPdfTask(bytes).promise
}

export async function indexPage(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageIndex> {
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent({ disableNormalization: true })
  let text = ''
  const segments: Segment[] = []
  let previous: { endX: number; endY: number; angle: number; hasEOL: boolean } | undefined
  for (const item of content.items) {
    if (!('str' in item)) continue
    const angle = Math.atan2(item.transform[1], item.transform[0])
    const height = Math.max(item.height, Math.hypot(item.transform[2], item.transform[3]), 1)
    if (previous && item.str) {
      const deltaX = item.transform[4] - previous.endX
      const deltaY = item.transform[5] - previous.endY
      const along = deltaX * Math.cos(angle) + deltaY * Math.sin(angle)
      const across = Math.abs(-deltaX * Math.sin(angle) + deltaY * Math.cos(angle))
      const adjacent = !previous.hasEOL && angleDistance(angle, previous.angle) < 0.05 &&
        across < height * 0.3 && along >= -height * 0.2 && along < height * 0.3
      if (!adjacent && text && !/\s$/.test(text)) text += '\n'
    }
    segments.push({ start: text.length, text: item.str })
    text += item.str
    if (item.str) previous = {
      endX: item.transform[4] + Math.cos(angle) * item.width,
      endY: item.transform[5] + Math.sin(angle) * item.width,
      angle, hasEOL: item.hasEOL,
    }
  }
  return { text, segments }
}