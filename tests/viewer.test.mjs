import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { mkdirSync } from 'node:fs'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { beginText, degrees, endText, moveText, PDFDocument, PDFHexString, popGraphicsState, pushGraphicsState,
  setFontAndSize, setTextRenderingMode, showText, StandardFonts, TextRenderingMode } from 'pdf-lib'
import { encryptedPdf } from './encrypted-fixture.mjs'

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

function rc4(key, input) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 0xff
    ;[state[i], state[j]] = [state[j], state[i]]
  }
  const output = new Uint8Array(input.length)
  let a = 0, b = 0
  for (let i = 0; i < input.length; i++) {
    a = (a + 1) & 0xff
    b = (b + state[a]) & 0xff
    ;[state[a], state[b]] = [state[b], state[a]]
    output[i] = input[i] ^ state[(state[a] + state[b]) & 0xff]
  }
  return Buffer.from(output)
}

async function makeEncryptedPdf(userCode = '1234', ownerCode = '5678') {
  const loaded = await PDFDocument.load(await makePdf(), { updateMetadata: false })
  const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')
  const pad = value => Buffer.concat([Buffer.from(value, 'latin1'), padding]).subarray(0, 32)
  const fileId = Buffer.alloc(16, 7)
  const ownerKey = createHash('md5').update(pad(ownerCode)).digest().subarray(0, 5)
  const O = rc4(ownerKey, pad(userCode))
  const flags = Buffer.from([0xfc, 0xff, 0xff, 0xff])
  const encryptionKey = createHash('md5').update(Buffer.concat([pad(userCode), O, flags, fileId])).digest().subarray(0, 5)
  const U = rc4(encryptionKey, padding)
  for (const [ref, object] of loaded.context.enumerateIndirectObjects()) {
    if (object.contents instanceof Uint8Array) {
      const suffix = Buffer.from([ref.objectNumber & 0xff, (ref.objectNumber >> 8) & 0xff, (ref.objectNumber >> 16) & 0xff, ref.generationNumber & 0xff, (ref.generationNumber >> 8) & 0xff])
      const streamKey = createHash('md5').update(Buffer.concat([encryptionKey, suffix])).digest().subarray(0, 10)
      object.contents = rc4(streamKey, object.contents)
    }
  }
  delete loaded.context.trailerInfo.Info
  loaded.context.trailerInfo.ID = loaded.context.obj([PDFHexString.of(fileId.toString('hex')), PDFHexString.of(fileId.toString('hex'))])
  loaded.context.trailerInfo.Encrypt = loaded.context.register(loaded.context.obj({
    Filter: 'Standard', V: 1, R: 2, Length: 40, P: -4,
    O: PDFHexString.of(O.toString('hex')), U: PDFHexString.of(U.toString('hex')),
  }))
  return Buffer.from(await loaded.save({ useObjectStreams: false }))
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

test('drag selects diagram text and copies it without triggering linked search', { timeout: 60000 }, async () => {
  await page.waitForFunction(() => document.querySelector('[data-slot="0"] .detail-canvas')?.style.display === 'block')
  const text = page.locator('[data-slot="0"] .textLayer span').filter({ hasText: /^VDD GND$/ })
  const bounds = await text.boundingBox()
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 12 })
  await page.mouse.up()
  const selected = await page.evaluate(() => getSelection()?.toString())
  assert.ok(selected.includes('VDD') && selected.includes('GND'), selected)
  assert.equal(await page.locator('.term-result').count(), 0)
  const highlight = await text.evaluate(element => getComputedStyle(element, '::selection').backgroundColor)
  assert.equal(highlight, 'rgba(36, 110, 229, 0.4)')
  assert.equal(await page.locator('.pane-toolbar').first().evaluate(el => getComputedStyle(el).userSelect), 'none')
  const shot = await page.screenshot({ clip: { x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) } })
  const bluePixels = await page.evaluate(async base64 => {
    const img = new Image()
    img.src = `data:image/png;base64,${base64}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width; canvas.height = img.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 2] > data[i] + 30 && data[i + 2] > data[i + 1] + 15) count++
    }
    return count
  }, shot.toString('base64'))
  assert.ok(bluePixels > 20, `Expected visible blue selection pixels above detail canvas, got ${bluePixels}`)
  await page.evaluate(() => {
    window.copiedText = ''
    document.addEventListener('copy', event => { window.copiedText = getSelection().toString(); event.preventDefault() }, { once: true })
  })
  await page.keyboard.press('Control+c')
  assert.equal(await page.evaluate(() => window.copiedText), selected)
  await page.locator('[data-slot="1"] .textLayer span').filter({ hasText: /^3501$/ }).click()
  assert.equal(await termResult(page, 'R3501').count(), 1)
})

test('divider resizes both layouts without losing documents, highlights or dual-window state', { timeout: 60000 }, async () => {
  await addTerm(page, 'R3501')
  const divider = page.getByRole('separator', { name: '调整文档面板大小' })
  await page.waitForFunction(() => document.querySelectorAll('.current-hit').length === 2)
  const initial = await page.locator('[data-slot="0"]').boundingBox()
  let bounds = await divider.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down(); await page.mouse.move(bounds.x + 150, bounds.y + bounds.height / 2, { steps: 8 }); await page.mouse.up()
  const resized = await page.locator('[data-slot="0"]').boundingBox()
  assert.ok(resized.width > initial.width + 100)
  assert.ok(Number(await divider.getAttribute('aria-valuenow')) > 50)
  assert.equal(await page.locator('.current-hit').count(), 2)
  await divider.dblclick()
  assert.equal(await divider.getAttribute('aria-valuenow'), '50')
  await divider.click(); await page.keyboard.press('ArrowLeft')
  assert.equal(await divider.getAttribute('aria-valuenow'), '48')
  await page.getByTitle('上下分屏', { exact: true }).click()
  assert.equal(await divider.getAttribute('aria-orientation'), 'horizontal')
  const upper = await page.locator('[data-slot="0"]').boundingBox()
  bounds = await divider.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100, { steps: 8 }); await page.mouse.up()
  assert.ok((await page.locator('[data-slot="0"]').boundingBox()).height > upper.height + 70)
  const saved = await divider.getAttribute('aria-valuenow')
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: '双屏窗口', exact: true }).click()
  const secondary = await popup
  await secondary.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
  assert.equal(await divider.count(), 0)
  const closed = secondary.waitForEvent('close')
  await page.getByRole('button', { name: '恢复双栏', exact: true }).click()
  await closed
  assert.equal(await divider.getAttribute('aria-valuenow'), saved)
  await page.getByTitle('左右分屏', { exact: true }).click()
  assert.equal(await divider.getAttribute('aria-valuenow'), '48')
  await divider.focus(); await page.keyboard.press('Home')
  assert.equal(await divider.getAttribute('aria-valuenow'), '15')
  await page.keyboard.press('End')
  assert.equal(await divider.getAttribute('aria-valuenow'), '85')
  await divider.dblclick()
  assert.equal(await divider.getAttribute('aria-valuenow'), '50')
  const panesBounds = await page.locator('.panes').boundingBox()
  await page.waitForFunction(expected => Math.abs(document.querySelector('[data-slot="0"]').getBoundingClientRect().width - expected) < 12, (panesBounds.width - 10) / 2)
  bounds = await divider.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(panesBounds.x + panesBounds.width - 8, bounds.y + bounds.height / 2, { steps: 10 })
  await page.mouse.up()
  const expandB = page.getByRole('button', { name: '展开文档 B' })
  await expandB.waitFor()
  await page.waitForFunction(() => document.querySelector('[data-slot="1"]').getBoundingClientRect().width === 0)
  assert.ok((await page.locator('[data-slot="0"]').boundingBox()).width > panesBounds.width - 5)
  const expandSamples = page.evaluate(() => new Promise(resolve => {
    const widths = []
    const start = performance.now()
    const step = () => {
      widths.push(Math.round(document.querySelector('[data-slot="1"]').getBoundingClientRect().width))
      if (performance.now() - start < 380) requestAnimationFrame(step)
      else resolve(widths)
    }
    requestAnimationFrame(step)
  }))
  await expandB.click()
  const widths = await expandSamples
  assert.ok(widths.some(w => w > 20 && w < panesBounds.width * 0.45), `Expected smooth intermediate widths, got ${JSON.stringify(widths)}`)
  await page.waitForFunction(expected => Math.abs(document.querySelector('[data-slot="1"]').getBoundingClientRect().width - expected) < 12, (panesBounds.width - 10) / 2)
  assert.equal(await divider.getAttribute('aria-valuenow'), '50')
  assert.equal(await page.locator('.current-hit').count(), 2)
  bounds = await divider.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(panesBounds.x + 8, bounds.y + bounds.height / 2, { steps: 10 })
  await page.mouse.up()
  const expandA = page.getByRole('button', { name: '展开文档 A' })
  await expandA.waitFor()
  await page.waitForFunction(() => document.querySelector('[data-slot="0"]').getBoundingClientRect().width === 0)
  const tabBounds = await expandA.boundingBox()
  await page.mouse.move(tabBounds.x + tabBounds.width / 2, tabBounds.y + tabBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(panesBounds.x + panesBounds.width * 0.4, tabBounds.y + tabBounds.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelector('[data-slot="0"]').getBoundingClientRect().width > 200)
  await divider.dblclick()
  await page.waitForFunction(expected => Math.abs(document.querySelector('[data-slot="0"]').getBoundingClientRect().width - expected) < 12, (panesBounds.width - 10) / 2)
  bounds = await divider.boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(panesBounds.x + panesBounds.width - 8, bounds.y + bounds.height / 2, { steps: 10 })
  await page.mouse.up()
  await expandB.waitFor()
  await page.waitForFunction(() => document.querySelector('[data-slot="1"]').getBoundingClientRect().width === 0)
  await page.getByTitle('R3501 · 文档 B · 下一处', { exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-slot="1"]').getBoundingClientRect().width > 200)
  await page.screenshot({ path: 'artifacts/divider-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => document.querySelector('[role="separator"]')?.getAttribute('aria-orientation') === 'horizontal')
  assert.equal(await divider.getAttribute('aria-orientation'), 'horizontal')
  assert.equal(await page.getByTitle('左右分屏', { exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await page.screenshot({ path: 'artifacts/divider-mobile.png' })
})

test('hidden CAD pad references are exact and visible identifiers remain unchanged', { timeout: 60000 }, async () => {
  const normal = await PDFDocument.create()
  const normalFont = await normal.embedFont(StandardFonts.Helvetica)
  const normalPage = normal.addPage([640, 800])
  normalPage.drawText('C104 C105 C106', { x: 80, y: 600, size: 16, font: normalFont })
  const annotated = await PDFDocument.create()
  const font = await annotated.embedFont(StandardFonts.Helvetica)
  const drawing = annotated.addPage([640, 800])
  const fontKey = drawing.node.newFontDictionary(font.name, font.ref)
  for (const [label, top] of [['PAUC104', 600], ['PAUC105', 540], ['PAUR101', 480], ['PAUC106', 420]]) {
    drawing.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(fontKey, 16),
      setTextRenderingMode(TextRenderingMode.Invisible), moveText(80, top), showText(font.encodeText(label)), endText(), popGraphicsState())
  }
  drawing.drawText('PAUC106', { x: 300, y: 420, size: 16, font })
  const normalBytes = Buffer.from(await normal.save()), annotatedBytes = Buffer.from(await annotated.save())
  await upload(page, 0, normalBytes, 'normal.pdf')
  await upload(page, 1, annotatedBytes, 'annotations.pdf')
  await addTerm(page, 'C104')
  await page.waitForFunction(() => document.querySelector('[data-position="1:C104"]')?.textContent === '1 / 1')
  assert.equal(await termResult(page, 'C104').locator('.document-result').nth(1).locator('small').count(), 0)
  await page.locator('[data-slot="1"] .textLayer span').filter({ hasText: /^PAUC105$/ }).click()
  await page.waitForFunction(() => document.querySelector('[data-position="0:C105"]')?.textContent === '1 / 1')
  assert.equal(await termResult(page, 'C105').count(), 1)
  assert.equal(await termResult(page, 'PAUC105').count(), 0)
  await addTerm(page, 'PAUC104')
  await page.waitForFunction(() => document.querySelector('[data-position="1:PAUC104"]')?.textContent === '1 / 1')
  await page.locator('[data-slot="1"] .textLayer span').filter({ hasText: /^PAUC106$/ }).last().click()
  assert.equal(await termResult(page, 'PAUC106').count(), 1)
  assert.equal(await termResult(page, 'C106').count(), 0)
  await upload(page, 0, annotatedBytes, 'annotations-left.pdf')
  await upload(page, 1, normalBytes, 'normal-right.pdf')
  await addTerm(page, 'C104')
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: '双屏窗口', exact: true }).click()
  const secondary = await popup
  await secondary.waitForFunction(() => document.querySelector('[data-position="0:C104"]')?.textContent === '1 / 1')
  assert.equal(await termResult(secondary, 'C104').locator('.document-result').nth(0).locator('small').count(), 0)
  await secondary.close()
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

test('precision rendering makes progress during sustained scrolling', { timeout: 60000 }, async () => {
  await addTerm(page, 'R3501')
  await page.getByRole('spinbutton', { name: '文档 A 缩放百分比', exact: true }).fill('1000')
  await page.waitForFunction(() => document.querySelector('[data-slot="0"] .detail-canvas')?.dataset.scale === '10')
  const commits = await page.locator('[data-slot="0"]').evaluate(pane => new Promise(resolve => {
    const scroll = pane.querySelector('.pdf-scroll'), canvas = pane.querySelector('.detail-canvas')
    let count = 0, frames = 0
    const observer = new MutationObserver(() => count++)
    observer.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] })
    const step = () => {
      scroll.scrollTop += 12
      if (++frames < 90) requestAnimationFrame(step)
      else { observer.disconnect(); resolve(count) }
    }
    requestAnimationFrame(step)
  }))
  assert.ok(commits > 0, 'A continuous scroll must not starve precision rendering')
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

test('password-protected PDFs support retry, cancellation, unlock, and dual-window sync', { timeout: 60000 }, async () => {
  const encrypted = await makeEncryptedPdf('1234', '5678')
  await page.locator('[data-slot="0"] input[type=file]').setInputFiles({ name: 'encrypted-A.pdf', mimeType: 'application/pdf', buffer: encrypted })
  await page.locator('[data-slot="0"] .pane-status').filter({ hasText: '等待输入密码' }).waitFor()
  const inputA = page.getByLabel('文档 A 密码', { exact: true })
  await inputA.fill('wrong')
  await page.locator('[data-slot="0"]').getByRole('button', { name: '解锁打开', exact: true }).click()
  await page.locator('[data-slot="0"]').getByRole('alert').filter({ hasText: '密码错误，请重新输入' }).waitFor()
  assert.equal(await inputA.inputValue(), '')
  await inputA.fill('1234')
  await page.locator('[data-slot="0"]').getByRole('button', { name: '解锁打开', exact: true }).click()
  await page.locator('[data-slot="0"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })

  await page.locator('[data-slot="1"] input[type=file]').setInputFiles({ name: 'encrypted-B.pdf', mimeType: 'application/pdf', buffer: encrypted })
  await page.locator('[data-slot="1"] .pane-status').filter({ hasText: '等待输入密码' }).waitFor()
  await page.locator('[data-slot="1"]').getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await page.locator('[data-slot="1"] .pane-status').textContent(), '未加载')
  await page.waitForFunction(() => window.workerCounts.created - window.workerCounts.terminated === 1)

  await page.locator('[data-slot="1"] input[type=file]').setInputFiles({ name: 'encrypted-B.pdf', mimeType: 'application/pdf', buffer: encrypted })
  await page.getByLabel('文档 B 密码', { exact: true }).fill('5678')
  await page.locator('[data-slot="1"]').getByRole('button', { name: '解锁打开', exact: true }).click()
  await page.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })

  await addTerm(page, 'R3501')
  assert.equal(await page.locator('[data-position="0:R3501"]').textContent(), '1 / 1')
  assert.equal(await page.locator('[data-position="1:R3501"]').textContent(), '1 / 1')

  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: '双屏窗口', exact: true }).click()
  const secondary = await popup
  await secondary.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
  assert.equal(await secondary.locator('[data-position="1:R3501"]').textContent(), '1 / 1')
  await secondary.close()
})

for (const [algorithm, version] of [['AES-128', '1.6'], ['AES-256', '1.7ext3']]) {
  test(`${algorithm} password PDFs unlock and synchronize while the second window is waiting`, { timeout: 60000 }, async () => {
    const encrypted = await encryptedPdf(version)
    await page.locator('[data-slot="0"] input[type=file]').setInputFiles({ name: `${algorithm}-A.pdf`, mimeType: 'application/pdf', buffer: encrypted })
    await page.getByLabel('文档 A 密码', { exact: true }).fill('5678')
    await page.locator('[data-slot="0"]').getByRole('button', { name: '解锁打开', exact: true }).click()
    await page.locator('[data-slot="0"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    await page.locator('[data-slot="1"] input[type=file]').setInputFiles({ name: `${algorithm}-B.pdf`, mimeType: 'application/pdf', buffer: encrypted })
    await page.getByLabel('文档 B 密码', { exact: true }).waitFor()
    const popup = page.waitForEvent('popup')
    await page.getByRole('button', { name: '双屏窗口', exact: true }).click()
    const secondary = await popup
    await secondary.getByLabel('文档 B 密码', { exact: true }).fill('wrong')
    await secondary.getByRole('button', { name: '解锁打开', exact: true }).click()
    await secondary.getByRole('alert').filter({ hasText: '密码错误，请重新输入' }).waitFor()
    await secondary.getByLabel('文档 B 密码', { exact: true }).fill('1234')
    await secondary.getByRole('button', { name: '解锁打开', exact: true }).click()
    await secondary.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    await addTerm(secondary, 'GND')
    await page.waitForFunction(() => document.querySelector('[data-position="1:GND"]')?.textContent === '1 / 2')
    await secondary.getByTitle('GND · 文档 B · 下一处', { exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-position="1:GND"]')?.textContent === '2 / 2')
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }).includes('1234') || JSON.stringify({ ...sessionStorage }).includes('1234')), false)
    await secondary.close()
    await page.locator('[data-slot="1"] .paper').waitFor()
    assert.equal(await page.getByLabel('文档 B 密码', { exact: true }).count(), 0)
  })
}

test('stale password cancellation cannot destroy a replacement PDF', { timeout: 60000 }, async () => {
  await page.evaluate(() => {
    const original = BroadcastChannel.prototype.postMessage
    BroadcastChannel.prototype.postMessage = function (message) {
      if (message.type === 'file') window.lastFileId = message.file.id
      return original.call(this, message)
    }
  })
  const encrypted = await encryptedPdf()
  await page.locator('[data-slot="1"] input[type=file]').setInputFiles({ name: 'locked-old.pdf', mimeType: 'application/pdf', buffer: encrypted })
  await page.getByLabel('文档 B 密码', { exact: true }).waitFor()
  const old = await page.evaluate(() => window.lastFileId)
  await upload(page, 1, fixture, 'replacement.pdf')
  await page.evaluate(async id => {
    const channel = new BroadcastChannel(`pdf-probe:${new URLSearchParams(location.search).get('session')}`)
    channel.postMessage({ type: 'cancel-file', id })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    channel.close()
  }, old)
  await addTerm(page, 'GND')
  await page.getByTitle('GND · 文档 B · 下一处', { exact: true }).click()
  assert.equal(await page.locator('[data-position="1:GND"]').textContent(), '2 / 5')
  assert.deepEqual(await page.locator('[role=alert]').allTextContents(), [])
  assert.equal(await page.getByLabel('文档 B 密码', { exact: true }).count(), 0)
})

test('wrong password does not leak to secondary window and slot A waiting status syncs', { timeout: 60000 }, async () => {
  const encrypted = await encryptedPdf('1.7ext3')
  await addTerm(page, 'GND')
  await page.locator('[data-slot="1"] input[type=file]').setInputFiles({ name: 'wrong-first-B.pdf', mimeType: 'application/pdf', buffer: encrypted })
  await page.getByLabel('文档 B 密码', { exact: true }).fill('wrong')
  await page.locator('[data-slot="1"]').getByRole('button', { name: '解锁打开', exact: true }).click()
  await page.locator('[data-slot="1"]').getByRole('alert').filter({ hasText: '密码错误，请重新输入' }).waitFor()
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: '双屏窗口', exact: true }).click()
  const secondary = await popup
  await secondary.getByLabel('文档 B 密码', { exact: true }).waitFor()
  assert.equal(await secondary.getByRole('alert').filter({ hasText: '密码错误，请重新输入' }).count(), 0)
  await page.locator('[data-slot="0"] input[type=file]').setInputFiles({ name: 'locked-A.pdf', mimeType: 'application/pdf', buffer: encrypted })
  await page.getByLabel('文档 A 密码', { exact: true }).waitFor()
  await secondary.waitForFunction(() => document.querySelector('.term-result .document-result')?.textContent?.includes('等待密码'))
  await secondary.close()
})

test('three reading modes support wheel navigation and closing a document', { timeout: 90000 }, async () => {
  const pane = page.locator('[data-slot="0"]'), scroll = pane.locator('.pdf-scroll')
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  await scroll.dispatchEvent('wheel', { deltaY: 120 })
  assert.equal(await pane.getByRole('spinbutton', { name: '文档 A 页码', exact: true }).inputValue(), '1')
  await pane.getByRole('button', { name: '文档 A 连续阅读' }).click()
  await page.waitForFunction(() => document.querySelector('[data-slot="0"] .page-flow .textLayer span'))
  assert.equal(await pane.getAttribute('data-reading-mode'), 'continuous-scroll')
  const second = pane.locator('[data-flow-page="2"]')
  await second.scrollIntoViewIfNeeded()
  await page.waitForFunction(() => document.querySelector('[aria-label="文档 A 页码"]').value === '2')
  await second.locator('.textLayer span').filter({ hasText: /^GND$/ }).click()
  await page.waitForFunction(() => document.querySelector('[data-position="0:GND"]')?.textContent?.trim() === '5 / 5')
  await pane.getByRole('button', { name: '文档 A 连续阅读' }).click()
  await page.waitForFunction(() => document.querySelector('[data-slot="0"] .paper[data-page="2"] .textLayer span'))
  assert.equal(await pane.getAttribute('data-reading-mode'), 'off')
  await page.getByRole('button', { name: '偏好设置' }).click()
  await page.getByLabel('阅读模式', { exact: true }).selectOption('wheel-page')
  await page.getByRole('button', { name: '关闭设置' }).click()
  await pane.getByRole('spinbutton', { name: '文档 A 页码', exact: true }).fill('1')
  await page.waitForFunction(() => document.querySelector('[data-slot="0"] .paper')?.dataset.renderedPage === '1')
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  await scroll.dispatchEvent('wheel', { deltaY: 120 })
  await page.waitForFunction(() => document.querySelector('[aria-label="文档 A 页码"]').value === '2')
  await page.getByRole('button', { name: '关闭文档 A', exact: true }).click()
  await pane.getByRole('heading', { name: '尚未打开 PDF' }).waitFor()
  assert.equal(await pane.locator('.paper').count(), 0)
  assert.equal(await pane.locator('.pane-status').textContent(), '未加载')
  assert.ok((await page.evaluate(() => window.workerCounts.terminated)) >= 1)
})

test('continuous flow virtualizes mixed pages while retaining a cross-page selection', { timeout: 90000 }, async () => {
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < 20; index++) {
    const drawing = document.addPage(index % 2 ? [1000, 500] : [640, 800])
    drawing.drawText(`PAGE${index + 1}`, { x: 80, y: 350, size: 16, font })
  }
  await upload(page, 0, Buffer.from(await document.save()), 'mixed-pages.pdf')
  const pane = page.locator('[data-slot="0"]')
  await pane.getByRole('button', { name: '文档 A 连续阅读' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-slot="0"] [data-flow-page="2"] .textLayer span').length > 0)
  const selected = await pane.evaluate(element => {
    const first = element.querySelector('[data-flow-page="1"] .textLayer span').firstChild
    const last = element.querySelector('[data-flow-page="2"] .textLayer span').firstChild
    const range = window.document.createRange()
    range.setStart(first, 0); range.setEnd(last, last.textContent.length)
    getSelection().removeAllRanges(); getSelection().addRange(range)
    return getSelection().toString()
  })
  assert.ok(selected.includes('PAGE1') && selected.includes('PAGE2'))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await pane.locator('.pdf-scroll').evaluate(element => { element.scrollTop = element.querySelector('[data-flow-page="20"]').offsetTop })
  await page.waitForFunction(() => document.querySelector('[data-slot="0"] .paper[data-page="20"]')?.dataset.renderPhase === 'ready')
  assert.equal(await pane.locator('.paper[data-page="1"]').count(), 1)
  assert.equal(await page.evaluate(() => getSelection().toString()), selected)
  await page.evaluate(() => getSelection().removeAllRanges())
  await page.waitForFunction(() => !document.querySelector('[data-slot="0"] .paper[data-page="1"]'))
  assert.ok(await pane.locator('.page-flow .paper').count() <= 5)
  await pane.getByRole('spinbutton', { name: '文档 A 缩放百分比', exact: true }).fill('10')
  await page.waitForFunction(() => document.querySelectorAll('[data-slot="0"] .page-flow .paper').length > 3)
  assert.deepEqual(await pane.locator('.page-slot').evaluateAll(elements => elements.slice(0, 2).map(element => element.getBoundingClientRect().height)), [80, 50])
  await page.screenshot({ path: 'artifacts/viewer-continuous-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await page.screenshot({ path: 'artifacts/viewer-continuous-mobile.png' })
})

test('continuous wheel zoom keeps cursor PDF anchor across frames, rotations, mixed pages and page gaps', { timeout: 90000 }, async () => {
  const specs = [[640, 800], [1000, 500], [640, 800], [800, 640]]
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica)
  specs.forEach(([width, height], index) => {
    const drawing = document.addPage([width, height])
    drawing.drawText(`ZOOM_PAGE_${index + 1}`, { x: Math.round(width * 0.35), y: Math.round(height * 0.45), size: 16, font })
  })
  await upload(page, 0, Buffer.from(await document.save()), 'continuous-zoom.pdf')
  const pane = page.locator('[data-slot="0"]'), scroll = pane.locator('.pdf-scroll')
  await pane.getByRole('button', { name: '文档 A 连续阅读' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-slot="0"] [data-flow-page="2"] .textLayer span').length > 0)

  async function assertAnchoredBurst({ pageNum, baseSize, rotation, steps, inGap = false, startScale = 150, offsetX = 135, offsetY = 165 }) {
    await pane.getByRole('spinbutton', { name: '文档 A 缩放百分比', exact: true }).fill(String(startScale))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await scroll.evaluate((element, { pageNum, inGap, offsetY }) => {
      const slot = element.querySelector(`[data-flow-page="${pageNum}"]`)
      element.scrollLeft = 180
      element.scrollTop = inGap
        ? slot.offsetTop + slot.offsetHeight + 8 - offsetY
        : slot.offsetTop + Math.min(220, slot.offsetHeight * 0.45) - offsetY + 60
    }, { pageNum, inGap, offsetY })
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 160)))
    const bounds = await scroll.boundingBox()
    const clientX = Math.round(bounds.x + offsetX), clientY = Math.round(bounds.y + offsetY)
    await page.mouse.move(clientX, clientY)

    const anchor = await scroll.evaluate((element, { pageNum, baseSize, rotation, clientX, clientY, inGap }) => {
      const slot = element.querySelector(`[data-flow-page="${pageNum}"]`)
      const rect = slot.getBoundingClientRect()
      const [W, H] = baseSize
      const u = (clientX - rect.left) / rect.width
      const v = inGap ? 1 : (clientY - rect.top) / rect.height
      const gapY = inGap ? clientY - rect.bottom : 0
      let pdfX, pdfY
      if (rotation === 0) { pdfX = u * W; pdfY = (1 - v) * H }
      else if (rotation === 90) { pdfX = v * W; pdfY = u * H }
      else if (rotation === 180) { pdfX = (1 - u) * W; pdfY = v * H }
      else { pdfX = (1 - v) * W; pdfY = (1 - u) * H }
      window.__zoomSamples = []
      window.__zoomSampling = true
      const record = source => {
        const current = element.querySelector(`[data-flow-page="${pageNum}"]`)
        if (!current) return
        const box = current.getBoundingClientRect()
        let nu, nv
        if (rotation === 0) { nu = pdfX / W; nv = (H - pdfY) / H }
        else if (rotation === 90) { nu = pdfY / H; nv = pdfX / W }
        else if (rotation === 180) { nu = (W - pdfX) / W; nv = pdfY / H }
        else { nu = (H - pdfY) / H; nv = (W - pdfX) / W }
        const sx = box.left + nu * box.width
        const sy = box.top + nv * box.height + gapY
        window.__zoomSamples.push({
          source,
          dx: sx - clientX,
          dy: sy - clientY,
          scrollLeft: element.scrollLeft,
          scrollTop: element.scrollTop,
          slotWidth: box.width,
        })
      }
      const tick = () => {
        if (!window.__zoomSampling) return
        record('raf')
        requestAnimationFrame(tick)
      }
      window.__zoomOnScroll = () => record('scroll')
      element.addEventListener('scroll', window.__zoomOnScroll, { passive: true })
      record('initial')
      requestAnimationFrame(tick)
      return { pdfX, pdfY, gapY }
    }, { pageNum, baseSize, rotation, clientX, clientY, inGap })

    for (const batch of steps) {
      if (Array.isArray(batch)) {
        await scroll.evaluate((element, { deltas, clientX, clientY }) => {
          for (const deltaY of deltas) {
            element.dispatchEvent(new WheelEvent('wheel', { deltaY, ctrlKey: true, clientX, clientY, bubbles: true, cancelable: true }))
          }
        }, { deltas: batch, clientX, clientY })
      } else {
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, batch)
        await page.keyboard.up('Control')
      }
    }
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 220)))
    const samples = await scroll.evaluate(element => {
      window.__zoomSampling = false
      element.removeEventListener('scroll', window.__zoomOnScroll)
      return window.__zoomSamples
    })
    assert.ok(samples.length >= 3)
    const worst = samples.reduce((acc, item) => Math.max(Math.abs(item.dx), Math.abs(item.dy)) > Math.max(Math.abs(acc.dx), Math.abs(acc.dy)) ? item : acc, samples[0])
    assert.ok(Math.abs(worst.dx) <= 2 && Math.abs(worst.dy) <= 2,
      `Anchor drifted on page ${pageNum} (rot=${rotation}, gap=${inGap}): worst=${JSON.stringify(worst)}, anchor=${JSON.stringify(anchor)}`)
  }

  // 1. Page 2 (mixed landscape 1000x500): zoom in burst, same-frame multi-wheel, zoom out, rapid direction reversal, plus scrollbar threshold crossing.
  await assertAnchoredBurst({ pageNum: 2, baseSize: specs[1], rotation: 0, startScale: 60, offsetX: 110, offsetY: 140, steps: [[-100, -100], -100, -100, 100, -100] })
  await assertAnchoredBurst({ pageNum: 2, baseSize: specs[1], rotation: 0, startScale: 160, steps: [[-100, -100, -100], -100, 100, [100, -100, 100], 100] })

  // 2. Pointer on second simultaneously visible page (Page 3 while Page 2 is also visible) and inside the 20px inter-page gap.
  await assertAnchoredBurst({ pageNum: 3, baseSize: specs[2], rotation: 0, startScale: 80, offsetX: 145, offsetY: 320, steps: [-100, [-100, -100], 100] })
  await assertAnchoredBurst({ pageNum: 2, baseSize: specs[1], rotation: 0, startScale: 150, inGap: true, offsetX: 150, offsetY: 180, steps: [-100, -100, 100] })

  // 3. Rotated 90deg and 270deg on mixed-size pages.
  await pane.getByTitle('顺时针旋转 90°').click()
  await page.waitForFunction(() => document.querySelector('[data-slot="0"]')?.getAttribute('data-rotation') === '90')
  await assertAnchoredBurst({ pageNum: 2, baseSize: specs[1], rotation: 90, startScale: 150, steps: [[-100, -100], 100, -100] })
  await pane.getByTitle('顺时针旋转 90°').click()
  await pane.getByTitle('顺时针旋转 90°').click()
  await page.waitForFunction(() => document.querySelector('[data-slot="0"]')?.getAttribute('data-rotation') === '270')
  await assertAnchoredBurst({ pageNum: 4, baseSize: specs[3], rotation: 270, startScale: 150, steps: [-100, [-100, 100], 100] })

  // 4. Top-left boundary clamping remains valid without NaN or negative scroll offsets.
  await scroll.evaluate(element => element.scrollTo(0, 0))
  await page.mouse.move(Math.round((await scroll.boundingBox()).x + 40), Math.round((await scroll.boundingBox()).y + 40))
  await page.keyboard.down('Control'); await page.mouse.wheel(0, 100); await page.keyboard.up('Control')
  const clamped = await scroll.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))
  assert.ok(Number.isFinite(clamped.left) && Number.isFinite(clamped.top) && clamped.left >= 0 && clamped.top >= 0)
})

test('detaching B preserves its page, zoom and reading position', { timeout: 60000 }, async () => {
  const pane = page.locator('[data-slot="1"]')
  await pane.getByRole('spinbutton', { name: '文档 B 页码', exact: true }).fill('2')
  await page.waitForFunction(() => document.querySelector('[data-slot="1"] .paper')?.dataset.renderedPage === '2')
  await pane.getByRole('spinbutton', { name: '文档 B 缩放百分比', exact: true }).fill('400')
  await pane.locator('.pdf-scroll').evaluate(element => element.scrollTo(800, 950))
  const point = async target => target.locator('[data-slot="1"] .pdf-scroll').evaluate(element => {
    const scale = Number(element.closest('.pdf-pane').querySelector('.zoom-value').value) / 100
    const style = getComputedStyle(element)
    return { x: (element.scrollLeft + element.clientWidth / 2 - parseFloat(style.paddingLeft)) / scale,
      y: (element.scrollTop + element.clientHeight / 2 - parseFloat(style.paddingTop)) / scale }
  })
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)))
  const before = await point(page)
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: '双屏窗口', exact: true }).click()
  const secondary = await popup
  await secondary.waitForFunction(() => document.querySelector('[aria-label="文档 B 缩放百分比"]')?.value === '400')
  await secondary.waitForFunction(() => document.querySelector('[data-slot="1"] .paper')?.dataset.renderedPage === '2')
  await secondary.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)))
  const after = await point(secondary)
  assert.ok(Math.abs(after.x - before.x) < 2 && Math.abs(after.y - before.y) < 2, JSON.stringify({ before, after }))
  await secondary.close()
  await page.waitForFunction(() => document.querySelector('[aria-label="文档 B 缩放百分比"]')?.value === '400')
})

test('settings dialog, theme switch, sidebar collapse, pane swap, 90deg rotation and shortcuts work smoothly', { timeout: 60000 }, async () => {
  await addTerm(page, 'GND')
  await page.waitForFunction(() => document.querySelector('[data-position="0:GND"]')?.textContent === '1 / 5')
  await page.keyboard.press('F3')
  await page.waitForFunction(() => document.querySelector('[data-position="0:GND"]')?.textContent === '2 / 5')
  await page.keyboard.press('Shift+F3')
  await page.waitForFunction(() => document.querySelector('[data-position="0:GND"]')?.textContent === '1 / 5')
  await page.getByRole('button', { name: '收起搜索栏' }).click()
  await page.waitForFunction(() => document.querySelector('.search-sidebar')?.classList.contains('is-collapsed'))
  await page.keyboard.press('Control+f')
  await page.waitForFunction(() => !document.querySelector('.search-sidebar')?.classList.contains('is-collapsed') && document.activeElement?.getAttribute('aria-label') === '关键词')
  await page.keyboard.press('Escape')
  const beforeSwapA = await page.locator('[data-slot="0"]').boundingBox()
  const beforeSwapB = await page.locator('[data-slot="1"]').boundingBox()
  assert.ok(beforeSwapA.x < beforeSwapB.x)
  await page.getByTitle('互换 A/B 面板位置').click()
  const afterSwapA = await page.locator('[data-slot="0"]').boundingBox()
  const afterSwapB = await page.locator('[data-slot="1"]').boundingBox()
  assert.ok(afterSwapB.x < afterSwapA.x)
  await page.getByTitle('互换 A/B 面板位置').click()
  const paperBefore = await page.locator('[data-slot="0"] .paper').boundingBox()
  await page.locator('[data-slot="0"]').getByTitle('顺时针旋转 90°').click()
  await page.waitForFunction(() => document.querySelector('[data-slot="0"]')?.getAttribute('data-rotation') === '90')
  await page.waitForFunction(prevW => Math.abs((document.querySelector('[data-slot="0"] .paper')?.getBoundingClientRect().height ?? 0) - prevW) < 5, paperBefore.width)
  await page.locator('[data-slot="0"] .textLayer span').filter({ hasText: /^3501$/ }).click()
  assert.equal(await termResult(page, 'R3501').count(), 1)
  await page.getByRole('button', { name: '偏好设置' }).click()
  const dialog = page.getByRole('dialog', { name: '偏好设置' })
  await dialog.waitFor()
  await dialog.getByRole('radio', { name: '暗黑 CAD' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  await dialog.getByLabel('聚光灯遮罩浓度').fill('75')
  await dialog.getByLabel('聚光灯遮罩浓度').dispatchEvent('change')
  assert.ok((await dialog.textContent()).includes('从资源管理器打开 PDF 时每次选择工作区'))
  assert.equal(await dialog.locator('[aria-label="外部打开面板分配策略"]').count(), 0)
  await dialog.getByRole('radio', { name: '浅色清爽' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  await dialog.getByRole('button', { name: '关闭设置' }).click()
  assert.equal(await dialog.count(), 0)
})

test('external open selector handles legacy settings migration, replacement confirmation, races, mobile layout and collapsed replacements', { timeout: 60000 }, async () => {
  const custom = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const tab = await custom.newPage()
  try {
    await tab.addInitScript(() => {
      localStorage.setItem('pdf-cross-probe:settings:v1', JSON.stringify({
        theme: 'dark',
        externalOpenPolicy: 'single-a-dual-ab',
        dimOpacity: 0.7,
      }))
      window.__resolvedDecisions = []
      window.__externalListeners = []
      window.__launchListeners = []
      window.__currentExternalRequest = {
        requestId: 'req-1',
        token: 'tok-1',
        files: [{ name: 'CE.RK3588.EB701A_SUPER_LONG_SCHEMATIC_DRAWING_REV_B02_20261112.pdf' }],
        preferredSlot: 1,
        paired: false,
        queueRemaining: 1,
        workspaces: [
          {
            sessionId: 'ws-1',
            workspaceNumber: 1,
            isCurrent: true,
            separated: false,
            slots: [
              { status: 'ready', id: 'doc-1a', name: 'Project1_Schematic_A0.pdf' },
              { status: 'empty', id: '', name: '' },
            ],
          },
          {
            sessionId: 'ws-2',
            workspaceNumber: 2,
            isCurrent: false,
            separated: true,
            slots: [
              { status: 'ready', id: 'doc-2a', name: 'Project2_Schematic_Very_Long_Name_V3.pdf' },
              { status: 'password', id: 'doc-2b', name: 'Project2_Silkscreen_Locked.pdf' },
            ],
          },
        ],
      }
      window.pdfCrossProbeDesktop = {
        isDesktop: true,
        openNewWindow: async () => {},
        getUpdateStatus: async () => ({ phase: 'idle', currentVersion: '1.1.0' }),
        checkForUpdates: async () => ({ phase: 'idle', currentVersion: '1.1.0' }),
        downloadUpdate: async () => ({ phase: 'idle', currentVersion: '1.1.0' }),
        cancelUpdate: async () => ({ phase: 'idle', currentVersion: '1.1.0' }),
        installUpdate: async () => ({ phase: 'idle', currentVersion: '1.1.0' }),
        openUpdatePage: async () => {},
        onUpdateStatus: () => () => {},
        consumeLaunchQueue: async () => [],
        onLaunchFiles: callback => {
          window.__launchListeners.push(callback)
          return () => { window.__launchListeners = window.__launchListeners.filter(listener => listener !== callback) }
        },
        reportWorkspaceState: async () => {},
        getExternalOpenRequest: async () => window.__currentExternalRequest,
        resolveExternalOpen: async decision => {
          window.__resolvedDecisions.push(decision)
          window.__currentExternalRequest = null
          for (const fn of window.__externalListeners) fn(null)
          return { ok: true }
        },
        onExternalOpenRequest: callback => {
          window.__externalListeners.push(callback)
          return () => {}
        },
        getShellStatus: async () => ({ supported: true, enabled: true, executablePath: 'PDF Cross Probe.exe' }),
        setShellIntegration: async enabled => ({ supported: true, enabled, executablePath: 'PDF Cross Probe.exe' }),
      }
    })
    await tab.goto(url)
    assert.equal(await tab.evaluate(() => document.documentElement.dataset.theme), 'dark')
    const modal = tab.getByRole('dialog', { name: '选择打开位置' })
    await modal.waitFor()
    assert.ok((await modal.textContent()).includes('还有 1 份待选择'))
    assert.ok((await modal.textContent()).includes('双屏 B 已分离'))
    assert.ok((await modal.textContent()).includes('Project2_Silkscreen_Locked.pdf（等待密码）'))
    await tab.screenshot({ path: 'artifacts/external-selector-desktop.png' })

    await tab.setViewportSize({ width: 390, height: 844 })
    assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth), 390)
    await tab.screenshot({ path: 'artifacts/external-selector-mobile.png' })
    await tab.setViewportSize({ width: 1280, height: 900 })

    // Selecting occupied slot A on workspace 1 opens replacement confirmation showing original filename.
    await modal.getByRole('button', { name: '工作区 1 替换 A' }).click()
    assert.ok((await modal.textContent()).includes('确认替换已有图纸'))
    assert.ok((await modal.textContent()).includes('Project1_Schematic_A0.pdf'))

    // Live slot change while confirmation is open aborts stale confirmation and shows notice.
    await tab.evaluate(() => {
      const updated = structuredClone(window.__currentExternalRequest)
      updated.token = 'tok-2'
      updated.workspaces[0].slots[0] = { status: 'ready', id: 'doc-1a-new', name: 'Changed_Schematic_A1.pdf' }
      window.__currentExternalRequest = updated
      for (const fn of window.__externalListeners) fn(updated)
    })
    await modal.getByRole('alert').filter({ hasText: '目标面板的图纸已发生变化' }).waitFor()
    assert.equal(await modal.getByRole('button', { name: '确认替换' }).count(), 0)

    // Selecting occupied slot B on workspace 2, then workspace 2 closes -> resets confirmation with target-closed notice.
    await modal.getByRole('button', { name: '工作区 2 替换 B' }).click()
    assert.ok((await modal.textContent()).includes('Project2_Silkscreen_Locked.pdf'))
    await tab.evaluate(() => {
      const updated = structuredClone(window.__currentExternalRequest)
      updated.token = 'tok-3'
      updated.workspaces = updated.workspaces.slice(0, 1)
      window.__currentExternalRequest = updated
      for (const fn of window.__externalListeners) fn(updated)
    })
    await modal.getByRole('alert').filter({ hasText: '所选工作区已关闭' }).waitFor()

    // Selecting empty slot B on workspace 1 submits immediately without extra confirmation.
    await modal.getByRole('button', { name: '工作区 1 放入 B' }).click()
    await tab.waitForFunction(() => !document.querySelector('[aria-label="选择打开位置"]'))
    const decisions = await tab.evaluate(() => window.__resolvedDecisions)
    assert.equal(decisions.length, 1)
    assert.deepEqual(decisions[0], {
      requestId: 'req-1',
      token: 'tok-3',
      action: 'open',
      slot: 1,
      target: { sessionId: 'ws-1', expectedSlotIds: ['doc-1a-new', ''] },
    })

    await upload(tab, 0)
    await upload(tab, 1)
    const names = ['drawing 0.pdf', 'drawing 1.pdf']
    for (const slot of [1, 0]) {
      const divider = await tab.getByRole('separator', { name: '调整文档面板大小' }).boundingBox()
      const panes = await tab.locator('.panes').boundingBox()
      await tab.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
      await tab.mouse.down()
      await tab.mouse.move(panes.x + (slot === 0 ? 8 : panes.width - 8), divider.y + divider.height / 2, { steps: 10 })
      await tab.mouse.up()
      await tab.waitForFunction(target => document.querySelector(`[data-slot="${target}"]`).getBoundingClientRect().width === 0, slot)
      names[slot] = `replacement-${slot}.pdf`
      await tab.evaluate(({ target, name, bytes }) => {
        for (const listener of window.__launchListeners) listener({ targetSlot: target, files: [{ name, bytes: new Uint8Array(bytes) }] })
      }, { target: slot, name: names[slot], bytes: [...replacement] })
      await tab.waitForFunction(({ target, name }) => document.querySelector(`[data-slot="${target}"] .pane-header strong`)?.textContent === name &&
        document.querySelector(`[data-slot="${target}"] .pane-status`)?.textContent?.includes('文字索引完成'), { target: slot, name: names[slot] })
      await tab.waitForFunction(target => document.querySelector(`[data-slot="${target}"]`).getBoundingClientRect().width > 100, slot, { timeout: 5000 })
      assert.equal(await tab.locator(`[data-slot="${1 - slot}"] .pane-header strong`).textContent(), names[1 - slot])
    }
    assert.equal(await tab.evaluate(() => window.__launchListeners.length), 1)
  } finally {
    await custom.close()
  }
})