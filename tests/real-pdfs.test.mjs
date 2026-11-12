import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { _electron } from 'playwright-core'

const [documentA, documentB, keyword] = process.argv.slice(2)

async function waitForCurrent(page, slot, term, expectedPosition) {
  await page.waitForFunction(({ targetSlot, targetTerm, position }) => {
    const result = [...document.querySelectorAll('[data-position]')].find(item => item.getAttribute('data-position') === `${targetSlot}:${targetTerm}`)
    const pane = document.querySelector(`[data-slot="${targetSlot}"]`)
    const paper = pane?.querySelector('.paper'), hit = pane?.querySelector('.current-hit')
    const actualPosition = result?.textContent?.trim() ?? ''
    return (position ? actualPosition === position : /^1\s*\/\s*[1-9]\d*$/.test(actualPosition)) &&
      paper?.getAttribute('data-render-phase') === 'ready' &&
      paper.getAttribute('data-rendered-page') === paper.getAttribute('data-page') &&
      hit?.getAttribute('data-term') === targetTerm
  }, { targetSlot: slot, targetTerm: term, position: expectedPosition }, { timeout: 180000 })
}

async function hitAlignment(page, slot, term) {
  return page.locator(`[data-slot="${slot}"]`).evaluate((pane, targetTerm) => {
    const paper = pane.querySelector('.paper'), hit = pane.querySelector('.current-hit')
    const span = [...pane.querySelectorAll('.textLayer span')].find(element => element.textContent?.includes(targetTerm))
    if (!paper || !hit || !span?.firstChild) throw new Error('Missing current hit or text')
    const offset = span.textContent.indexOf(targetTerm), range = document.createRange()
    range.setStart(span.firstChild, offset)
    range.setEnd(span.firstChild, offset + targetTerm.length)
    const text = range.getBoundingClientRect(), origin = paper.getBoundingClientRect()
    return Math.max(Math.abs(text.left - origin.left - parseFloat(hit.style.left)),
      Math.abs(text.top - origin.top - parseFloat(hit.style.top)),
      Math.abs(text.width - parseFloat(hit.style.width)), Math.abs(text.height - parseFloat(hit.style.height)))
  }, term)
}

test('real PDFs support linked desktop workflows', {
  timeout: 600000,
  skip: !documentA || !documentB || !keyword ? 'Pass two PDF paths and a shared keyword' : false,
}, async () => {
  const configuration = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const source = process.argv.includes('--source')
  const executableOption = process.argv.find(argument => argument.startsWith('--executable='))
  const executablePath = source ? undefined : executableOption
    ? path.resolve(executableOption.slice('--executable='.length))
    : path.resolve(configuration.build.directories.output, 'win-unpacked/PDF Cross Probe.exe')
  if (executablePath) assert.ok(existsSync(executablePath), 'Build the portable desktop application first')
  const profile = mkdtempSync(path.join(tmpdir(), 'pdf-real-probe-'))
  const env = { ...process.env, PDF_CROSS_PROBE_MOCK_REGISTRY: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const errors = [], externalRequests = []
  let app
  try {
    const args = [...(source ? [path.resolve('.')] : []), `--user-data-dir=${profile}`]
    app = await _electron.launch({ executablePath, args, env, timeout: 60000 })
    const main = await app.firstWindow()
    main.on('pageerror', error => errors.push(error.message))
    main.on('request', request => { if (/^https?:/i.test(request.url())) externalRequests.push(request.url()) })
    await main.getByRole('heading', { name: 'PDF 联动查看器', exact: true }).waitFor({ timeout: 60000 })
    const started = Date.now()
    const loads = await Promise.all([documentA, documentB].map(async (file, slot) => {
      const pane = main.locator(`[data-slot="${slot}"]`)
      const start = Date.now()
      await pane.locator('input[type=file]').setInputFiles(file)
      await pane.locator('.pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 180000 })
      return { slot, indexedMs: Date.now() - start, status: await pane.locator('.pane-status').innerText() }
    }))
    await main.getByRole('textbox', { name: '关键词', exact: true }).fill(keyword)
    const searchStart = Date.now()
    await main.getByRole('button', { name: '追加高亮', exact: true }).click()
    for (const slot of [0, 1]) await waitForCurrent(main, slot, keyword)
    const searchMs = Date.now() - searchStart
    const resultModes = await main.locator('.term-result').first().locator('.document-result').evaluateAll(elements =>
      elements.map(element => element.querySelector('small') ? 'tolerant' : 'exact'))
    const positions = await main.locator('.term-result').first().locator('[data-position]').allTextContents()
    if (process.argv.includes('--exact')) assert.deepEqual(resultModes, ['exact', 'exact'])
    const panes = await main.locator('.pdf-pane').evaluateAll(elements => elements.map(pane => ({
      slot: pane.getAttribute('data-slot'),
      page: pane.querySelector('.paper')?.getAttribute('data-page'),
      currentHits: pane.querySelectorAll('.current-hit').length,
      textSpans: pane.querySelectorAll('.textLayer span').length,
    })))
    const pagesOption = process.argv.find(argument => argument.startsWith('--pages='))
    const countsOption = process.argv.find(argument => argument.startsWith('--counts='))
    if (pagesOption) assert.deepEqual(panes.map(pane => Number(pane.page)), pagesOption.slice('--pages='.length).split(',').map(Number))
    if (countsOption) assert.deepEqual(positions.map(value => Number(value.split('/')[1])), countsOption.slice('--counts='.length).split(',').map(Number))
    await main.getByRole('spinbutton', { name: '文档 B 缩放百分比', exact: true }).fill('1600')
    await main.waitForFunction(() => document.querySelector('[data-slot="1"] .detail-canvas')?.getAttribute('data-scale') === '16', null, { timeout: 180000 })
    const text = main.locator('[data-slot="1"] .textLayer span').filter({ hasText: keyword }).first()
    await text.scrollIntoViewIfNeeded({ timeout: 30000 })
    const glyph = await text.evaluate((element, term) => {
      const offset = element.textContent.indexOf(term)
      const range = document.createRange()
      range.setStart(element.firstChild, offset + 1)
      range.setEnd(element.firstChild, offset + 2)
      const bounds = range.getBoundingClientRect()
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
        width: bounds.width, height: bounds.height, context: element.textContent.slice(Math.max(0, offset - 3), offset + term.length + 3) }
    }, keyword)
    assert.ok(glyph.width > 0 && glyph.height > 0, 'The target character must be visible')
    if (process.argv.includes('--snapshot')) {
      const snapshot = path.join(tmpdir(), `pdf-real-probe-${process.pid}.png`)
      const viewport = await main.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      const left = Math.max(0, Math.floor(glyph.x - 150)), top = Math.max(0, Math.floor(glyph.y - 80))
      await main.screenshot({ path: snapshot, clip: { x: left, y: top,
        width: Math.min(300, viewport.width - left), height: Math.min(160, viewport.height - top) } })
      console.log(JSON.stringify({ snapshot }))
    }
    await main.mouse.click(glyph.x, glyph.y)
    await main.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const clickedTerms = await main.locator('.term-name strong').allTextContents()
    assert.deepEqual(clickedTerms, [keyword], 'Clicking a shared component must not include a hidden CAD marker')

    const checks = []
    if (process.argv.includes('--full')) {
      const countB = Number(positions[1].split('/')[1])
      if (countB > 1) {
        await main.getByTitle(`${keyword} · 文档 B · 下一处`, { exact: true }).click()
        await waitForCurrent(main, 1, keyword, `2 / ${countB}`)
        await main.getByTitle(`${keyword} · 文档 B · 上一处`, { exact: true }).click()
        await waitForCurrent(main, 1, keyword, `1 / ${countB}`)
        checks.push('match navigation')
      }

      await main.getByTitle('清空关键词', { exact: true }).click()
      await main.getByRole('spinbutton', { name: '文档 A 缩放百分比', exact: true }).fill('800')
      await main.waitForFunction(() => document.querySelector('[data-slot="0"] .detail-canvas')?.getAttribute('data-scale') === '8', null, { timeout: 180000 })
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const visibleText = main.locator('[data-slot="0"] .textLayer span').filter({ hasText: new RegExp(`^\\s*${escapedKeyword}\\s*$`) }).first()
      await visibleText.scrollIntoViewIfNeeded({ timeout: 30000 })
      const selection = await visibleText.evaluate((element, term) => {
        const node = element.firstChild, offset = element.textContent.indexOf(term)
        const firstRange = document.createRange(), lastRange = document.createRange()
        firstRange.setStart(node, offset); firstRange.setEnd(node, offset + 1)
        lastRange.setStart(node, offset + term.length - 1); lastRange.setEnd(node, offset + term.length)
        const first = firstRange.getBoundingClientRect(), last = lastRange.getBoundingClientRect()
        return { startX: first.left + first.width * 0.1, startY: first.top + first.height / 2,
          endX: last.right - last.width * 0.1, endY: last.top + last.height / 2 }
      }, keyword)
      await main.mouse.move(selection.startX, selection.startY)
      await main.mouse.down()
      await main.mouse.move(selection.endX, selection.endY, { steps: 12 })
      await main.mouse.up()
      const selected = await main.evaluate(() => getSelection()?.toString() ?? '')
      assert.ok(selected.includes(keyword), `Mouse selection must include the actual reference: ${JSON.stringify({ selected, selection })}`)
      assert.equal(await main.locator('.term-result').count(), 0)
      const selectionShot = await visibleText.screenshot()
      const bluePixels = await main.evaluate(async base64 => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0)
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
        let count = 0
        for (let index = 0; index < data.length; index += 4) {
          if (data[index + 2] > data[index] + 30 && data[index + 2] > data[index + 1] + 15) count++
        }
        return count
      }, selectionShot.toString('base64'))
      assert.ok(bluePixels > 20, `Blue selection must be visible, got ${bluePixels} pixels`)
      await main.evaluate(() => {
        window.realCopied = ''
        document.addEventListener('copy', event => { window.realCopied = getSelection()?.toString() ?? ''; event.preventDefault() }, { once: true })
        document.addEventListener('paste', event => { window.realPasteFired = true; event.preventDefault() }, { once: true })
      })
      await main.keyboard.press('Control+c')
      assert.equal(await main.evaluate(() => window.realCopied), selected)
      await main.getByRole('textbox', { name: '关键词', exact: true }).focus()
      await main.keyboard.press('Control+v')
      assert.equal(await main.evaluate(() => window.realPasteFired), true)
      await main.evaluate(() => getSelection()?.removeAllRanges())
      checks.push('visible selection and copy/paste events')

      const search = main.getByRole('textbox', { name: '关键词', exact: true })
      const secondOption = process.argv.find(argument => argument.startsWith('--second='))
      const second = secondOption?.slice('--second='.length)
      for (const term of [keyword, ...(second ? [second] : [])]) {
        await search.fill(term)
        await main.getByRole('button', { name: '追加高亮', exact: true }).click()
        for (const slot of [0, 1]) await waitForCurrent(main, slot, term)
      }
      if (second) {
        assert.equal(await main.locator('.term-result').count(), 2)
        checks.push('multiple keywords')
      }
      await main.locator('.term-name').filter({ hasText: keyword }).first().click()
      await waitForCurrent(main, 1, keyword)

      const paneB = main.locator('[data-slot="1"]')
      await main.getByRole('spinbutton', { name: '文档 B 缩放百分比', exact: true }).fill('3200')
      await main.waitForFunction(() => {
        const detail = document.querySelector('[data-slot="1"] .detail-canvas')
        return detail?.getAttribute('data-scale') === '32' && detail.style.display === 'block'
      }, null, { timeout: 180000 })
      assert.ok(await hitAlignment(main, 1, keyword) < 1)
      assert.ok(await paneB.locator('.detail-canvas').evaluate(canvas => canvas.width * canvas.height) <= 6000000)
      await main.getByRole('spinbutton', { name: '文档 B 缩放百分比', exact: true }).fill('1600')
      await main.waitForFunction(() => document.querySelector('[data-slot="1"] .detail-canvas')?.getAttribute('data-scale') === '16', null, { timeout: 180000 })
      checks.push('3200% precision rendering')

      const paperBefore = await paneB.locator('.paper').boundingBox()
      await paneB.getByTitle('顺时针旋转 90°', { exact: true }).click()
      await main.waitForFunction(({ width, height }) => {
        const pane = document.querySelector('[data-slot="1"]'), paper = pane?.querySelector('.paper')
        const bounds = paper?.getBoundingClientRect()
        return pane?.getAttribute('data-rotation') === '90' && paper?.getAttribute('data-render-phase') === 'ready' &&
          Math.abs((bounds?.width ?? 0) - height) < 2 && Math.abs((bounds?.height ?? 0) - width) < 2
      }, { width: paperBefore.width, height: paperBefore.height }, { timeout: 180000 })
      await waitForCurrent(main, 1, keyword)
      const alignmentError = await hitAlignment(main, 1, keyword)
      assert.ok(alignmentError < 1, `Rotated highlight differs from its text layer by ${alignmentError}px`)
      for (const angle of [180, 270, 0]) {
        await paneB.getByTitle('顺时针旋转 90°', { exact: true }).click()
        await main.waitForFunction(value => document.querySelector('[data-slot="1"]')?.getAttribute('data-rotation') === String(value), angle)
      }
      await main.waitForFunction(({ width, height }) => {
        const paper = document.querySelector('[data-slot="1"] .paper'), bounds = paper?.getBoundingClientRect()
        return paper?.getAttribute('data-render-phase') === 'ready' &&
          Math.abs((bounds?.width ?? 0) - width) < 2 && Math.abs((bounds?.height ?? 0) - height) < 2
      }, { width: paperBefore.width, height: paperBefore.height }, { timeout: 180000 })
      await waitForCurrent(main, 1, keyword)
      const detailPixels = await paneB.locator('.detail-canvas').evaluate(canvas => canvas.width * canvas.height)
      assert.ok(detailPixels <= 6000000, `Detail canvas exceeded its pixel budget: ${detailPixels}`)
      checks.push('1600% rendering and rotation alignment')

      const beforeSwap = await main.locator('.pdf-pane').evaluateAll(elements => elements.map(pane => ({
        slot: pane.getAttribute('data-slot'), page: pane.querySelector('.paper')?.getAttribute('data-page'),
        zoom: pane.querySelector('.zoom-value')?.value,
      })).sort((first, second) => first.slot.localeCompare(second.slot)))
      await main.getByTitle('互换 A/B 面板位置', { exact: true }).click()
      await main.waitForFunction(() => document.querySelector('[data-slot="1"]').getBoundingClientRect().left <
        document.querySelector('[data-slot="0"]').getBoundingClientRect().left)
      for (const slot of [0, 1]) await waitForCurrent(main, slot, keyword)
      const afterSwap = await main.locator('.pdf-pane').evaluateAll(elements => elements.map(pane => ({
        slot: pane.getAttribute('data-slot'), page: pane.querySelector('.paper')?.getAttribute('data-page'),
        zoom: pane.querySelector('.zoom-value')?.value,
      })).sort((first, second) => first.slot.localeCompare(second.slot)))
      assert.deepEqual(afterSwap, beforeSwap, 'Swapping panes must preserve each document view')
      await main.getByTitle('互换 A/B 面板位置', { exact: true }).click()
      await main.waitForFunction(() => document.querySelector('[data-slot="0"]').getBoundingClientRect().left <
        document.querySelector('[data-slot="1"]').getBoundingClientRect().left)
      checks.push('swap preserves document views')

      const scroll = paneB.locator('.pdf-scroll')
      await paneB.getByTitle('抓手平移', { exact: true }).click()
      const beforePan = await scroll.evaluate(element => {
        element.scrollLeft = Math.floor((element.scrollWidth - element.clientWidth) / 2)
        element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2)
        return { left: element.scrollLeft, top: element.scrollTop }
      })
      const scrollBounds = await scroll.boundingBox()
      await main.mouse.move(scrollBounds.x + scrollBounds.width / 2, scrollBounds.y + scrollBounds.height / 2)
      await main.mouse.down()
      await main.mouse.move(scrollBounds.x + scrollBounds.width / 2 - 60, scrollBounds.y + scrollBounds.height / 2 - 40, { steps: 6 })
      await main.mouse.up()
      const afterPan = await scroll.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))
      assert.ok(afterPan.left > beforePan.left + 30 && afterPan.top > beforePan.top + 20)
      await paneB.getByTitle('文字选择', { exact: true }).click()
      checks.push('high-zoom panning')

      const divider = main.getByRole('separator', { name: '调整文档面板大小' })
      const dividerBounds = await divider.boundingBox(), panesBounds = await main.locator('.panes').boundingBox()
      await main.mouse.move(dividerBounds.x + dividerBounds.width / 2, dividerBounds.y + dividerBounds.height / 2)
      await main.mouse.down()
      await main.mouse.move(panesBounds.x + panesBounds.width - 8, dividerBounds.y + dividerBounds.height / 2, { steps: 10 })
      await main.mouse.up()
      await main.waitForFunction(() => document.querySelector('[data-slot="1"]').getBoundingClientRect().width === 0, null, { timeout: 30000 })
      await main.getByRole('button', { name: '展开文档 B' }).click()
      await main.waitForFunction(() => document.querySelector('[data-slot="1"]').getBoundingClientRect().width > 200, null, { timeout: 30000 })
      await waitForCurrent(main, 1, keyword)
      checks.push('collapse and restore')

      const newWindow = app.waitForEvent('window')
      await main.getByRole('button', { name: '双屏窗口', exact: true }).click()
      const secondary = await newWindow
      secondary.on('pageerror', error => errors.push(error.message))
      secondary.on('request', request => { if (/^https?:/i.test(request.url())) externalRequests.push(request.url()) })
      await secondary.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 180000 })
      await waitForCurrent(secondary, 1, keyword)
      if (countB > 1) {
        await secondary.getByTitle(`${keyword} · 文档 B · 下一处`, { exact: true }).click()
        await main.waitForFunction(({ term, count }) => [...document.querySelectorAll('[data-position]')].some(element =>
          element.getAttribute('data-position') === `1:${term}` && element.textContent?.trim() === `2 / ${count}`),
        { term: keyword, count: countB }, { timeout: 180000 })
      }
      const closed = secondary.waitForEvent('close')
      await main.getByRole('button', { name: '恢复双栏', exact: true }).click()
      await closed
      await main.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 180000 })
      checks.push('dual-window synchronization')
    }
    if (process.argv.includes('--continuous')) {
      const pane = main.locator('[data-slot="0"]')
      await pane.getByRole('spinbutton', { name: '文档 A 缩放百分比', exact: true }).fill('100')
      await pane.getByRole('button', { name: '文档 A 连续阅读', exact: true }).click()
      await main.waitForFunction(() => document.querySelectorAll('[data-slot="0"] .page-slot').length === 20, null, { timeout: 180000 })
      const navigationMs = []
      for (const number of [8, 12, 20, 7]) {
        const start = Date.now()
        await pane.locator('.pdf-scroll').evaluate((element, value) => {
          element.scrollTop = element.querySelector(`[data-flow-page="${value}"]`).offsetTop
        }, number)
        await main.waitForFunction(value => document.querySelector(`[data-slot="0"] .paper[data-page="${value}"]`)?.getAttribute('data-render-phase') === 'ready',
          number, { timeout: 180000 })
        navigationMs.push(Date.now() - start)
        assert.ok(await pane.locator('.page-flow .paper').count() <= 8, 'Offscreen pages must be virtualized')
      }
      await pane.getByRole('button', { name: '文档 A 连续阅读', exact: true }).click()
      await main.waitForFunction(() => document.querySelector('[data-slot="0"] .paper[data-page="7"] .textLayer span'), null, { timeout: 180000 })
      assert.equal(await main.locator('[data-slot="1"]').getAttribute('data-reading-mode'), 'off')
      console.log(JSON.stringify({ realContinuousPageNavigationMs: navigationMs }))
      checks.push('real 20-page continuous scrolling and independent B mode')
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(externalRequests, [])
    assert.deepEqual(await main.locator('[role=alert]').allTextContents(), [])
    console.log(JSON.stringify({ packaged: !source, loads, totalMs: Date.now() - started, searchMs, panes,
      positions, resultModes, clickedContext: glyph.context, clickedTerms, checks, externalRequests: externalRequests.length }))
  } finally {
    await app?.close()
    rmSync(profile, { recursive: true, force: true })
  }
})