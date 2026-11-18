import { PDFDocument, StandardFonts } from 'pdf-lib'

export async function createCanvas() {
  const make = async (count, kind) => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const image = kind === 'scan' ? await pdf.embedPng(await makeScan()) : null
    for (let p = 0; p < count; p++) {
      const page = pdf.addPage(p % 2 ? [1800, 1300] : [1300, 1800])
      if (image) page.drawImage(image, { x: 0, y: 0, width: 1300, height: 1800 })
      else {
        page.drawText(`PAGE${p + 1}`, { x: 90, y: 900, font, size: 12 })
        for (let i = 0; i < (kind === 'vector' ? 10000 : 400); i++) {
          const x = 20 + i * 19 % 1200, y = 20 + i * 47 % 1200
          page.drawLine({ start: { x, y }, end: { x: x + 37, y: y + 28 }, thickness: 0.3 })
          if (i % 5 === 0) page.drawText(`R${i}`, { x, y, font, size: 5 })
        }
      }
    }
    return Buffer.from(await pdf.save())
  }
  return Promise.all([make(3, 'vector'), make(1, 'scan'), make(100, 'mixed')])
}

async function makeScan() {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage()
    return await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 2000; canvas.height = 2700
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fcfcf8'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#202020'; ctx.font = '22px monospace'
      for (let i = 0; i < 1200; i++) ctx.fillText(`R${i} —————`, i * 137 % 1840, 32 + i * 59 % 2600)
      return canvas.toDataURL()
    })
  } finally { await browser.close() }
}
