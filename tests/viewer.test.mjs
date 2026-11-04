import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib'

let server, browser, context, page, url
let fixture, replacement
let errors = []

async function makePdf(ground = true) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const alternate = await pdf.embedFont(StandardFonts.HelveticaBold)
  const first = pdf.addPage([640, 800])
  first.drawText('R', { x: 80, y: 600, size: 14, font })
  first.drawText('3501', { x: 80 + font.widthOfTextAtSize('R', 14), y: 600, size: 14, font: alternate })
  first.drawText(ground ? 'VDD GND' : 'CHANGE_A', { x: 80, y: 530, size: 14, font })
  first.drawText('VDD_IO', { x: 80, y: 470, size: 14, font })
  if (ground) {
    for (const [left, top] of [[80, 700], [280, 400], [480, 200]]) first.drawText('GND', { x: left, y: top, size: 14, font })
  }
  const second = pdf.addPage([640, 800])
  second.drawText(ground ? 'GND' : 'CHANGE_A', { x: 200, y: 400, size: 14, font })
  return Buffer.from(await pdf.save())
}

async function upload(target, slot, buffer = fixture, name = `drawing ${slot}.pdf`) {
  await target.locator(`[data-slot="${slot}"] input[type=file]`).setInputFiles({ name, mimeType: 'application/pdf', buffer })
  await target.locator(`[data-slot="${slot}"] .pane-status`).filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
}

async function addTerm(target, text) {
  await target.getByRole('textbox', { name: '关键词', exact: true }).fill(text)
  await target.getByRole('button', { name: '追加高亮', exact: true }).click()
}

function termResult(target, term = 'GND') {
  return target.locator('.term-result').filter({ has: target.locator('.term-name', { hasText: new RegExp(`^${term}$`) }) })
}

before(async () => {
  fixture = await makePdf()
  replacement = await makePdf(false)
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  url = server.resolvedUrls.local[0]
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  mkdirSync('artifacts', { recursive: true })
})

beforeEach(async () => {
  errors = []
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => {
    const OriginalWorker = window.Worker
    window.workerCounts = { created: 0, terminated: 0 }
    const terminated = new WeakSet()
    window.Worker = class extends OriginalWorker {
      constructor(...args) { super(...args); window.workerCounts.created++ }
      terminate() {
        if (!terminated.has(this)) { terminated.add(this); window.workerCounts.terminated++ }
        return super.terminate()
      }
    }
  })
  context.on('page', target => target.on('pageerror', error => errors.push(error.message)))
  page = await context.newPage()
  await page.goto(url)
  await upload(page, 0)
  await upload(page, 1)
})

afterEach(async () => {
  await context?.close()
  assert.deepEqual(errors, [])
})

after(async () => { await browser?.close(); await server?.close() })

test('subpixel rotated CAD text stays aligned at high zoom', { timeout: 60000 }, async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Courier)
  const drawing = pdf.addPage([80, 80])
  drawing.drawText('C3422', { x: 30, y: 35, size: 0.79, font, rotate: degrees(90) })
  drawing.drawText('C3428', { x: 35, y: 30, size: 0.79, font })
  await upload(page, 1, Buffer.from(await pdf.save()), 'small rotated CAD.pdf')
  await page.getByRole('spinbutton', { name: '文档 B 缩放百分比', exact: true }).fill('3200')
  await addTerm(page, 'C3422\nC3428')
  await page.waitForFunction(() => document.querySelector('[data-slot="1"] .detail-canvas').dataset.scale === '32')
  const errors = await page.locator('[data-slot="1"] .textLayer span').evaluateAll(spans =>
    spans.filter(span => /^C342[28]$/.test(span.textContent)).map(span => {
      const paper = span.closest('.paper').getBoundingClientRect()
      const hit = [...span.closest('.paper').querySelectorAll('.hit-rectangle')].find(element => element.dataset.term === span.textContent)
      const box = span.getBoundingClientRect()
      const scale = Number(span.closest('.pdf-pane').querySelector('.zoom-value').value) / 100
      return { x: Math.abs(box.x - paper.x - parseFloat(hit.style.left)), y: Math.abs(box.y - paper.y - parseFloat(hit.style.top)),
        width: Math.abs(box.width - parseFloat(hit.style.width)), height: Math.abs(box.height - parseFloat(hit.style.height)),
        pdfX: (box.x - paper.x) / scale, pdfY: (box.y - paper.y) / scale, label: span.textContent }
    }))
  assert.equal(errors.length, 2)
  assert.ok(errors.every(error => [error.x, error.y, error.width, error.height].every(value => value < 0.1)), JSON.stringify(errors))
  for (const error of errors) {
    const expected = error.label === 'C3422' ? { x: 30, y: 42.63 } : { x: 35, y: 49.5 }
    assert.ok(Math.abs(error.pdfX - expected.x) < 1.5 && Math.abs(error.pdfY - expected.y) < 1.5, JSON.stringify(error))
  }
  const span = page.locator('[data-slot="1"] .textLayer span').filter({ hasText: /^C3422$/ })
  await span.click()
  assert.equal(await termResult(page, 'C3422').count(), 1)
  await page.screenshot({ path: 'artifacts/viewer-rotated-text.png' })
})

test('same-page buttons cycle every hit and arrows cross pages and wrap', { timeout: 60000 }, async () => {
  await addTerm(page, 'GND')
  const result = termResult(page)
  const position = result.locator('[data-position="0:GND"]')
  assert.equal(await position.textContent(), '1 / 5')
  const firstPage = result.locator('.document-result').nth(0).getByRole('button', { name: 'p.1 4', exact: true })
  const offsets = []
  for (const expected of ['2 / 5', '3 / 5', '4 / 5', '1 / 5']) {
    await firstPage.click()
    assert.equal(await position.textContent(), expected)
    offsets.push(await page.locator('[data-slot="0"] .current-hit').first().getAttribute('data-start'))
  }
  assert.equal(new Set(offsets).size, 4)
  await result.locator('.document-result').nth(0).getByRole('button', { name: 'p.2 1', exact: true }).click()
  assert.equal(await position.textContent(), '5 / 5')
  await page.locator('[data-slot="0"] .current-hit').first().waitFor()
  assert.equal(await page.getByRole('spinbutton', { name: '文档 A 页码', exact: true }).inputValue(), '2')
  await page.getByTitle('GND · 文档 A · 下一处', { exact: true }).click()
  assert.equal(await position.textContent(), '1 / 5')
  await page.getByTitle('GND · 文档 A · 上一处', { exact: true }).click()
  assert.equal(await position.textContent(), '5 / 5')
  await page.getByTitle('删除 GND', { exact: true }).click()
  await addTerm(page, 'GND')
  assert.equal(await position.textContent(), '1 / 5')
})

test('returning from another page starts with its first match', { timeout: 60000 }, async () => {
  await addTerm(page, 'GND')
  await page.getByRole('spinbutton', { name: '文档 A 页码', exact: true }).fill('2')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="0"] .textLayer span')].filter(element => element.textContent === 'GND').length === 1)
  await termResult(page).locator('.document-result').nth(0).getByRole('button', { name: 'p.1 4', exact: true }).click()
  assert.equal(await page.locator('[data-position="0:GND"]').textContent(), '1 / 5')
})

test('word-tail clicks keep the source page and locate the peer document', { timeout: 60000 }, async () => {
  await page.getByRole('spinbutton', { name: '文档 A 页码', exact: true }).fill('2')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="0"] .textLayer span')].filter(element => element.textContent === 'GND').length === 1)
  const coordinates = await page.locator('[data-slot="0"] .textLayer span').filter({ hasText: /^GND$/ }).evaluate(element => {
    const range = document.createRange()
    range.setStart(element.firstChild, 2); range.setEnd(element.firstChild, 3)
    const rect = range.getBoundingClientRect()
    return { x: rect.x + rect.width * 0.9, y: rect.y + rect.height / 2 }
  })
  const before = await page.locator('[data-slot="0"] .pdf-scroll').evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))
  await page.mouse.click(coordinates.x, coordinates.y)
  await page.locator('[data-position="0:GND"]').waitFor()
  assert.equal(await page.locator('[data-position="0:GND"]').textContent(), '5 / 5')
  assert.equal(await page.getByRole('spinbutton', { name: '文档 A 页码', exact: true }).inputValue(), '2')
  assert.deepEqual(await page.locator('[data-slot="0"] .pdf-scroll').evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop })), before)
  assert.equal(await page.locator('[data-position="1:GND"]').textContent(), '1 / 5')
})

test('split words have one full outline and partial keywords cannot share current identity', { timeout: 60000 }, async () => {
  await addTerm(page, 'R3501')
  assert.equal(await page.locator('[data-slot="0"] .hit-rectangle[data-term="R3501"]').count(), 1)
  const covered = await page.locator('[data-slot="0"]').evaluate(pane => {
    const hit = pane.querySelector('[data-term="R3501"]').getBoundingClientRect()
    const words = [...pane.querySelectorAll('.textLayer span')].filter(element => ['R', '3501'].includes(element.textContent))
    return words.every(element => { const rect = element.getBoundingClientRect(); return hit.left <= rect.left && hit.right >= rect.right })
  })
  assert.equal(covered, true)
  await page.getByRole('spinbutton', { name: '文档 A 缩放百分比', exact: true }).fill('3200')
  await page.locator('.term-name').filter({ hasText: /^R3501$/ }).click()
  const centered = await page.locator('[data-slot="0"]').evaluate(pane => {
    const hit = pane.querySelector('[data-term="R3501"]').getBoundingClientRect(), viewport = pane.querySelector('.pdf-scroll').getBoundingClientRect()
    return Math.abs(hit.x + hit.width / 2 - viewport.x - viewport.width / 2)
  })
  assert.ok(centered < 12, String(centered))
  await addTerm(page, 'VDD\nVDD_IO')
  assert.equal(await page.locator('[data-position="0:VDD"]').textContent(), '未定位')
  await page.locator('[data-slot="0"] input[type=checkbox]').check()
  await page.locator('.term-name').filter({ hasText: /^VDD_IO$/ }).click()
  assert.equal(await page.locator('[data-slot="0"] .current-hit[data-term="VDD_IO"]').count(), 1)
  assert.equal(await page.locator('[data-slot="0"] .current-hit[data-term="VDD"]').count(), 0)
  await addTerm(page, 'DOES_NOT_EXIST')
  assert.equal(await termResult(page, 'DOES_NOT_EXIST').locator('small').count(), 0)
})

test('tolerance toggles reselect active results and preloaded words stay unlocated', { timeout: 60000 }, async () => {
  await addTerm(page, 'VDD')
  const slot = page.locator('[data-slot="0"]')
  await slot.locator('input[type=checkbox]').check()
  await page.waitForFunction(() => document.querySelector('[data-position="0:VDD"]')?.textContent === '1 / 2')
  await slot.locator('input[type=checkbox]').uncheck()
  await page.waitForFunction(() => document.querySelector('[data-position="0:VDD"]')?.textContent === '1 / 1')
  await page.getByTitle('清空关键词', { exact: true }).click()
  await page.goto(url)
  await addTerm(page, 'GND\nR3501')
  await upload(page, 0)
  await page.locator('[data-slot="0"] .current-hit').waitFor()
  assert.equal(await page.locator('[data-position="0:GND"]').textContent(), '未定位')
  assert.equal(await page.locator('[data-position="0:R3501"]').textContent(), '1 / 1')
})

test('initial popup positions and cleared navigation agree in both windows', { timeout: 60000 }, async () => {
  await addTerm(page, 'GND')
  await page.locator('[data-slot="0"] input[type=checkbox]').check()
  await page.waitForFunction(() => document.querySelector('[data-position="0:GND"]')?.textContent === '1 / 5' && document.querySelector('.term-result .document-result small')?.textContent === '容错')
  await page.getByTitle('GND · 文档 A · 下一处', { exact: true }).click()
  await page.getByTitle('GND · 文档 A · 下一处', { exact: true }).click()
  await page.getByTitle('GND · 文档 B · 下一处', { exact: true }).click()
  await page.getByTitle('GND · 文档 B · 下一处', { exact: true }).click()
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: '双屏窗口', exact: true }).click()
  const secondary = await popup
  await secondary.waitForFunction(() => document.querySelector('[data-position="1:GND"]')?.textContent === '3 / 5')
  assert.equal(await secondary.locator('[data-position="0:GND"]').textContent(), '3 / 5')
  await page.getByTitle('清空关键词', { exact: true }).click()
  await secondary.waitForFunction(() => document.querySelectorAll('.term-result').length === 0 && document.querySelectorAll('.current-hit').length === 0)
  await addTerm(secondary, 'GND')
  await page.waitForFunction(() => document.querySelector('[data-position="1:GND"]')?.textContent === '1 / 5')
  await secondary.close()
})

test('text-layer mismatch still commits the new page and damaged files reset busy state', { timeout: 60000 }, async () => {
  await page.route('**/src/PdfPane.tsx', async route => {
    const response = await route.fetch()
    const source = await response.text()
    assert.ok(source.includes('const aligned = '))
    await route.fulfill({ response, body: source.replace('const aligned = ', 'const aligned = pageNumber !== 2 && ') })
  })
  await page.reload()
  await upload(page, 0)
  const checksum = () => page.locator('[data-slot="0"] .base-canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    return data.reduce((sum, value) => sum + value, 0)
  })
  const first = await checksum()
  await page.getByRole('spinbutton', { name: '文档 A 页码', exact: true }).fill('2')
  await page.getByRole('alert').filter({ hasText: /本页仅查看/ }).waitFor()
  await page.waitForFunction(() => !document.querySelector('[data-slot="0"] .pane-status').textContent.includes('渲染中'))
  assert.notEqual(await checksum(), first)
  assert.equal(await page.locator('[data-slot="0"] .textLayer span').count(), 0)
  await page.getByRole('spinbutton', { name: '文档 A 缩放百分比', exact: true }).fill('200')
  await page.locator('[data-slot="0"] input[type=file]').setInputFiles({ name: 'damaged.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') })
  await page.getByRole('alert').filter({ hasText: /文件不是有效的 PDF/ }).waitFor()
  assert.equal(await page.locator('[data-slot="0"] .pane-status').textContent(), '未加载')
})

test('split identifiers and geometry fallback select the actual clicked word', { timeout: 60000 }, async () => {
  await page.locator('[data-slot="0"] .textLayer span').filter({ hasText: /^3501$/ }).click()
  assert.equal(await termResult(page, 'R3501').count(), 1)
  assert.equal(await termResult(page, '3501').count(), 0)
  await page.evaluate(() => Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => null }))
  const coordinates = await page.locator('[data-slot="0"] .textLayer span').filter({ hasText: /^VDD GND$/ }).evaluate(element => {
    const range = document.createRange()
    range.setStart(element.firstChild, 4); range.setEnd(element.firstChild, 7)
    const rect = range.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  await page.mouse.click(coordinates.x, coordinates.y)
  assert.equal(await termResult(page, 'GND').count(), 1)
  assert.equal(await termResult(page, 'VDD').count(), 0)
})

test('empty text items retain their textDivs index in the installed PDF.js', { timeout: 60000 }, async () => {
  const result = await page.evaluate(async bytes => {
    const library = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
    library.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs'
    const task = library.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: '/pdf-assets/standard_fonts/' })
    const pdf = await task.promise
    const pdfPage = await pdf.getPage(1)
    const content = await pdfPage.getTextContent()
    const original = content.items.find(item => typeof item.str === 'string')
    content.items.splice(1, 0, { ...original, str: '', width: 0, hasEOL: false })
    const container = document.createElement('div')
    container.className = 'textLayer'
    container.style.position = 'fixed'; container.style.left = '-10000px'
    document.body.append(container)
    const layer = new library.TextLayer({ textContentSource: content, container, viewport: pdfPage.getViewport({ scale: 1 }) })
    await layer.render()
    const textItems = content.items.filter(item => typeof item.str === 'string')
    const matches = layer.textDivs.length === textItems.length && layer.textDivs.every((div, index) => div.textContent === textItems[index].str)
    container.remove(); await task.destroy()
    return { matches }
  }, [...fixture])
  assert.equal(result.matches, true)
})

test('two windows share A statistics, B navigation, and dispose replaced workers', { timeout: 90000 }, async () => {
  await addTerm(page, 'GND')
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: '双屏窗口', exact: true }).click()
  const secondary = await popup
  await secondary.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
  assert.equal(await secondary.locator('.pdf-pane').count(), 1)
  assert.equal(await secondary.evaluate(() => window.workerCounts.created - window.workerCounts.terminated), 1)
  await secondary.getByTitle('GND · 文档 B · 下一处', { exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-position="1:GND"]')?.textContent === '2 / 5')
  assert.equal(await secondary.locator('[data-position="1:GND"]').textContent(), '2 / 5')
  await upload(page, 0, replacement, 'changed A.pdf')
  await secondary.waitForFunction(() => {
    const result = [...document.querySelectorAll('.term-result')].find(element => element.querySelector('.term-name')?.textContent === 'GND')
    return result?.querySelector('.document-result')?.textContent.includes('未命中')
  })
  for (let index = 0; index < 3; index++) await upload(page, 0, fixture, `replaced A ${index}.pdf`)
  await page.waitForFunction(() => window.workerCounts.created - window.workerCounts.terminated === 2)
  await secondary.waitForFunction(() => document.querySelector('[data-position="0:GND"]')?.textContent?.endsWith('/ 5'))
  await secondary.close()
  await page.locator('[data-slot="1"] .paper').waitFor()
  assert.equal(await page.locator('.pdf-pane').count(), 2)
})

test('page previews prefetch neighbors, reuse text layers and evict old pages', { timeout: 60000 }, async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= 6; number++) {
    const drawing = pdf.addPage([640, 800])
    drawing.drawText(`PAGE${number}`, { x: 100, y: 500, size: 16, font })
  }
  await upload(page, 0, Buffer.from(await pdf.save()), 'six pages.pdf')
  await page.waitForFunction(() => Number(document.querySelector('[data-slot="0"] .paper')?.dataset.cachedPages) >= 2)
  await page.waitForFunction(() => Number(document.querySelector('[data-slot="0"] .paper')?.dataset.cachedPrecisionPixels) > 0)
  const firstPrecision = await page.locator('[data-slot="0"] .detail-canvas').getAttribute('style')
  await page.evaluate(() => { window.originalPageText = document.querySelector('[data-slot="0"] .textLayer span') })
  const timings = []
  for (const target of [2, 1]) {
    const started = performance.now()
    await page.getByRole('spinbutton', { name: '文档 A 页码', exact: true }).fill(String(target))
    await page.waitForFunction(expected => {
      const paper = document.querySelector('[data-slot="0"] .paper')
      return paper?.dataset.renderedPage === String(expected) && paper.dataset.renderPhase === 'ready'
    }, target)
    timings.push(Math.round(performance.now() - started))
  }
  assert.equal(await page.evaluate(() => window.originalPageText === document.querySelector('[data-slot="0"] .textLayer span')), true)
  assert.equal(await page.locator('[data-slot="0"] .detail-canvas').getAttribute('style'), firstPrecision)
  for (const target of [3, 4, 5, 6]) {
    await page.getByRole('spinbutton', { name: '文档 A 页码', exact: true }).fill(String(target))
    await page.waitForFunction(expected => {
      const paper = document.querySelector('[data-slot="0"] .paper')
      return paper?.dataset.renderedPage === String(expected) && paper.dataset.renderPhase === 'ready'
    }, target)
    const budget = await page.locator('[data-slot="0"] .paper').evaluate(element => ({ pages: Number(element.dataset.cachedPages), pixels: Number(element.dataset.cachedPixels), precision: Number(element.dataset.cachedPrecisionPixels) }))
    assert.ok(budget.pages <= 3 && budget.pixels <= 6000000 && budget.precision <= 6000000, JSON.stringify(budget))
  }
  console.log(JSON.stringify({ cachedPageNavigationMs: timings, reusedTextLayer: true, maxCachedPages: 3 }))
})

test('new-page graphics appear before a delayed text layer without stale highlights', { timeout: 60000 }, async () => {
  await page.route('**/src/PdfPane.tsx', async route => {
    const response = await route.fetch(), source = await response.text()
    assert.ok(source.includes('textLayer = new TextLayer'))
    await route.fulfill({ response, body: source.replace('textLayer = new TextLayer', 'await new Promise(resolve => setTimeout(resolve, 400)); textLayer = new TextLayer') })
  })
  await page.reload()
  await page.locator('[data-slot="0"] input[type=file]').setInputFiles({ name: 'preview first.pdf', mimeType: 'application/pdf', buffer: fixture })
  await page.waitForFunction(() => document.querySelector('[data-slot="0"] .paper')?.dataset.renderPhase === 'preview')
  assert.equal(await page.locator('[data-slot="0"] .textLayer span').count(), 0)
  assert.equal(await page.locator('[data-slot="0"] .hit-rectangle').count(), 0)
  assert.equal(await page.locator('[data-slot="0"] .base-canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    return data.some((value, index) => index % 4 !== 3 && value < 200)
  }), true)
  await page.waitForFunction(() => document.querySelector('[data-slot="0"] .paper')?.dataset.renderPhase === 'ready')
  assert.ok(await page.locator('[data-slot="0"] .textLayer span').count() > 0)
})

test('precision padding reuses small pans and redraws only outside its buffer', { timeout: 60000 }, async () => {
  await addTerm(page, 'R3501')
  await page.getByRole('spinbutton', { name: '文档 A 缩放百分比', exact: true }).fill('1000')
  await page.locator('.term-name').filter({ hasText: /^R3501$/ }).click()
  await page.waitForFunction(() => {
    const pane = document.querySelector('[data-slot="0"]'), tile = pane.querySelector('.detail-canvas')
    const viewport = pane.querySelector('.pdf-scroll').getBoundingClientRect(), box = tile.getBoundingClientRect()
    return tile.dataset.scale === '10' && box.left <= viewport.left && box.top <= viewport.top && box.right >= viewport.left + pane.querySelector('.pdf-scroll').clientWidth && box.bottom >= viewport.top + pane.querySelector('.pdf-scroll').clientHeight
  })
  const initial = await page.locator('[data-slot="0"]').evaluate(pane => {
    const tile = pane.querySelector('.detail-canvas'), viewport = pane.querySelector('.pdf-scroll')
    const box = tile.getBoundingClientRect(), bounds = viewport.getBoundingClientRect()
    window.precisionMutations = 0
    window.precisionObserver = new MutationObserver(records => { window.precisionMutations += records.length })
    window.precisionObserver.observe(tile, { attributes: true, attributeFilter: ['width', 'height'] })
    return { left: tile.style.left, top: tile.style.top, marginX: bounds.left - box.left, marginY: bounds.top - box.top, width: viewport.clientWidth, height: viewport.clientHeight }
  })
  assert.ok(initial.marginX >= initial.width * 0.15 - 2)
  assert.ok(initial.marginY >= initial.height * 0.15 - 2)
  await page.locator('[data-slot="0"] .pdf-scroll').evaluate(element => element.scrollBy(element.clientWidth * 0.08, element.clientHeight * 0.08))
  await page.evaluate(() => new Promise(resolve => {
    let frames = 0
    function tick() { if (++frames >= 25) resolve(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }))
  assert.equal(await page.evaluate(() => window.precisionMutations), 0)
  assert.ok(!(await page.locator('[data-slot="0"] .pane-status').textContent()).includes('精绘中'))
  await page.locator('[data-slot="0"] .pdf-scroll').evaluate(element => element.scrollBy(element.clientWidth * 0.3, element.clientHeight * 0.3))
  await page.waitForFunction(old => document.querySelector('[data-slot="0"] .detail-canvas').style.left !== old, initial.left)
  assert.ok(await page.evaluate(() => window.precisionMutations > 0))
  assert.ok(await page.locator('[data-slot="0"] .detail-canvas').evaluate(canvas => canvas.width * canvas.height <= 6000000))
  await page.evaluate(() => window.precisionObserver.disconnect())
})

test('high zoom remains bounded, cursor anchored and draggable on desktop and mobile', { timeout: 60000 }, async () => {
  await addTerm(page, 'R3501')
  await page.getByRole('spinbutton', { name: '文档 A 缩放百分比', exact: true }).fill('1000')
  await page.waitForFunction(() => document.querySelector('[data-slot="0"] .detail-canvas').dataset.scale === '10')
  const scroll = page.locator('[data-slot="0"] .pdf-scroll')
  const anchor = await scroll.evaluate(element => {
    const padding = getComputedStyle(element)
    return { x: (element.scrollLeft + 120 - parseFloat(padding.paddingLeft)) / 10,
      y: (element.scrollTop + 100 - parseFloat(padding.paddingTop)) / 10 }
  })
  const bounds = await scroll.boundingBox()
  await page.mouse.move(bounds.x + 120, bounds.y + 100)
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control')
  await page.waitForFunction(() => document.querySelector('[aria-label="文档 A 缩放百分比"]').value === '1150')
  const afterZoom = await scroll.evaluate(element => {
    const padding = getComputedStyle(element)
    return { x: (element.scrollLeft + 120 - parseFloat(padding.paddingLeft)) / 11.5,
      y: (element.scrollTop + 100 - parseFloat(padding.paddingTop)) / 11.5 }
  })
  assert.ok(Math.abs(anchor.x - afterZoom.x) < 1 && Math.abs(anchor.y - afterZoom.y) < 1)
  const beforePan = await scroll.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))
  await page.mouse.down({ button: 'middle' }); await page.mouse.move(bounds.x + 80, bounds.y + 70); await page.mouse.up({ button: 'middle' })
  const afterPan = await scroll.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))
  assert.ok(afterPan.left > beforePan.left && afterPan.top > beforePan.top)
  await page.getByRole('spinbutton', { name: '文档 A 缩放百分比', exact: true }).fill('3200')
  await page.locator('.term-name').filter({ hasText: /^R3501$/ }).click()
  await page.waitForFunction(() => document.querySelector('[data-slot="0"] .detail-canvas').dataset.scale === '32')
  const pixels = await page.locator('[data-slot="0"] .detail-canvas').evaluate(canvas => canvas.width * canvas.height)
  assert.ok(pixels <= 6000000)
  await page.screenshot({ path: 'artifacts/viewer-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await page.screenshot({ path: 'artifacts/viewer-mobile.png' })
})