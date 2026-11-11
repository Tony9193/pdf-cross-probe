import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron } from 'playwright-core'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { encryptedPdf } from './encrypted-fixture.mjs'

test('desktop loads PDFs offline and links native windows from a portable path', { timeout: 180000 }, async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['R3501 GND', 'GND']) {
    const drawing = pdf.addPage([640, 800])
    drawing.drawText(label, { x: 100, y: 500, size: 16, font })
  }
  const buffer = Buffer.from(await pdf.save())
  const configuration = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const packaged = path.resolve(configuration.build.directories.output, 'win-unpacked/PDF Cross Probe.exe')
  const temporary = mkdtempSync(path.join(tmpdir(), 'PDF 便携测试 '))
  let executablePath
  if (!process.env.PDF_TEST_SOURCE && existsSync(packaged)) {
    const folder = path.join(temporary, 'app')
    cpSync(path.dirname(packaged), folder, { recursive: true })
    executablePath = path.join(folder, 'PDF Cross Probe.exe')
  }
  const env = { ...process.env, PDF_CROSS_PROBE_MOCK_REGISTRY: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  const errors = [], requests = []
  try {
    const args = [...(executablePath ? [] : [path.resolve('.')]), `--user-data-dir=${path.join(temporary, 'profile')}`]
    app = await _electron.launch({ executablePath, args, env, timeout: 60000 })
    const main = await app.firstWindow()
    main.on('pageerror', error => errors.push(error.message))
    main.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()) })
    await main.getByRole('heading', { name: 'PDF 联动查看器', exact: true }).waitFor({ timeout: 30000 })
    assert.equal(await main.evaluate(() => location.origin), 'app://viewer')
    assert.deepEqual(await main.evaluate(() => ({ require: typeof window.require, process: typeof window.process, secure: isSecureContext })),
      { require: 'undefined', process: 'undefined', secure: true })
    for (const slot of [0, 1]) {
      await main.locator(`[data-slot="${slot}"] input[type=file]`).setInputFiles({ name: `中文 图纸 ${slot}.pdf`, mimeType: 'application/pdf', buffer })
      await main.locator(`[data-slot="${slot}"] .pane-status`).filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    }
    const clipboard = await app.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read()
      const formats = items.flatMap(item => item.types)
      const textOnly = formats.every(format => format === 'text/plain' || format === 'text/plain;charset=utf-8')
      if (!textOnly) return { formats, text: '', writable: false }
      const text = await clipboard.readText()
      const probe = '__pdf_cross_probe_test__'
      await clipboard.writeText(probe)
      const writable = (await clipboard.readText()) === probe
      if (formats.length) await clipboard.writeText(text)
      else await clipboard.clear()
      return { formats, text, writable }
    })
    await main.bringToFront()
    await main.evaluate(() => navigator.clipboard.writeText('clip-perm-ok'))
    if (clipboard.writable) {
      await app.evaluate(async ({ clipboard }, backup) => {
        if (backup.formats.length) await clipboard.writeText(backup.text)
        else await clipboard.clear()
      }, clipboard)
    }
    const text = main.locator('[data-slot="0"] .textLayer span').filter({ hasText: /^R3501 GND$/ })
    const bounds = await text.boundingBox()
    await main.waitForFunction(() => document.querySelector('[data-slot="0"] .detail-canvas')?.style.display === 'block')
    await main.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
    await main.mouse.down()
    await main.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 12 })
    await main.mouse.up()
    const selected = await main.evaluate(() => getSelection().toString())
    assert.ok(selected.includes('R3501') && selected.includes('GND'))
    const selectionShot = await text.screenshot()
    const bluePixels = await main.evaluate(async base64 => {
      const img = new Image()
      img.src = `data:image/png;base64,${base64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 2] > data[i] + 30 && data[i + 2] > data[i + 1] + 15) count++
      }
      return count
    }, selectionShot.toString('base64'))
    assert.ok(bluePixels > 20, `Expected visible blue selection pixels in Electron, got ${bluePixels}`)
    if (clipboard.writable) {
      try {
        await main.keyboard.press('Control+c')
        assert.equal(await app.evaluate(async ({ clipboard }) => await clipboard.readText()), selected)
        await main.getByRole('textbox', { name: '关键词', exact: true }).focus()
        await main.keyboard.press('Control+v')
        assert.equal(await main.getByRole('textbox', { name: '关键词', exact: true }).inputValue(), selected)
        await main.getByRole('textbox', { name: '关键词', exact: true }).fill('')
      } finally {
        await app.evaluate(async ({ clipboard }, backup) => { if (backup.formats.length) await clipboard.writeText(backup.text); else await clipboard.clear() }, clipboard)
      }
      console.log(JSON.stringify({ nativeCopyPaste: 'verified-os-clipboard', clipboardRestored: true }))
    } else {
      await main.evaluate(() => {
        window.desktopCopied = ''
        window.desktopPasteFired = false
        document.addEventListener('copy', event => { window.desktopCopied = getSelection().toString(); event.preventDefault() }, { once: true })
        document.addEventListener('paste', event => { window.desktopPasteFired = true; event.preventDefault() }, { once: true })
      })
      await main.keyboard.press('Control+c')
      assert.equal(await main.evaluate(() => window.desktopCopied), selected)
      await main.getByRole('textbox', { name: '关键词', exact: true }).focus()
      await main.keyboard.press('Control+v')
      assert.equal(await main.evaluate(() => window.desktopPasteFired), true)
      console.log(JSON.stringify({ nativeCopyPaste: 'verified-copy-paste-events', preservedHostClipboard: true }))
    }
    await main.evaluate(() => getSelection()?.removeAllRanges())
    const divider = main.getByRole('separator', { name: '调整文档面板大小' })
    const dividerBounds = await divider.boundingBox()
    await main.mouse.move(dividerBounds.x + dividerBounds.width / 2, dividerBounds.y + dividerBounds.height / 2)
    await main.mouse.down()
    await main.mouse.move(dividerBounds.x + 120, dividerBounds.y + dividerBounds.height / 2, { steps: 6 })
    await main.mouse.up()
    assert.ok(Number(await divider.getAttribute('aria-valuenow')) > 50)
    await divider.dblclick()
    assert.equal(await divider.getAttribute('aria-valuenow'), '50')
    const panesBox = await main.locator('.panes').boundingBox()
    await main.waitForFunction(expected => Math.abs(document.querySelector('[data-slot="0"]').getBoundingClientRect().width - expected) < 15, (panesBox.width - 10) / 2)
    const resetDividerBox = await divider.boundingBox()
    await main.mouse.move(resetDividerBox.x + resetDividerBox.width / 2, resetDividerBox.y + resetDividerBox.height / 2)
    await main.mouse.down()
    await main.mouse.move(panesBox.x + panesBox.width - 8, resetDividerBox.y + resetDividerBox.height / 2, { steps: 10 })
    await main.mouse.up()
    const expandB = main.getByRole('button', { name: '展开文档 B' })
    await expandB.waitFor()
    await main.waitForFunction(() => document.querySelector('[data-slot="1"]').getBoundingClientRect().width === 0)
    await expandB.click()
    await main.waitForFunction(expected => Math.abs(document.querySelector('[data-slot="1"]').getBoundingClientRect().width - expected) < 15, (panesBox.width - 10) / 2)
    await main.getByRole('textbox', { name: '关键词', exact: true }).fill('GND')
    await main.getByRole('button', { name: '追加高亮', exact: true }).click()
    await main.locator('[data-slot="0"] .current-hit').first().waitFor()
    assert.equal(await main.locator('[data-position="1:GND"]').textContent(), '1 / 2')
    const secondWindow = app.waitForEvent('window')
    await main.getByRole('button', { name: '双屏窗口', exact: true }).click()
    const secondary = await secondWindow
    secondary.on('pageerror', error => errors.push(error.message))
    await secondary.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(await main.locator('.pdf-pane').count(), 1)
    assert.equal(await secondary.locator('.pdf-pane').count(), 1)
    await secondary.getByTitle('GND · 文档 B · 下一处', { exact: true }).click()
    await main.waitForFunction(() => document.querySelector('[data-position="1:GND"]')?.textContent === '2 / 2')
    const closed = secondary.waitForEvent('close')
    await main.getByRole('button', { name: '恢复双栏', exact: true }).click()
    await closed
    await main.locator('[data-slot="1"] .current-hit').waitFor()
    assert.equal(await main.locator('.pdf-pane').count(), 2)
    const encrypted = await encryptedPdf('1.7ext3')
    await main.locator('[data-slot="0"] input[type=file]').setInputFiles({ name: 'AES256 locked A.pdf', mimeType: 'application/pdf', buffer: encrypted })
    await main.getByLabel('文档 A 密码', { exact: true }).fill('wrong')
    await main.locator('[data-slot="0"]').getByRole('button', { name: '解锁打开', exact: true }).click()
    await main.getByRole('alert').filter({ hasText: '密码错误，请重新输入' }).waitFor()
    await main.getByLabel('文档 A 密码', { exact: true }).fill('1234')
    await main.locator('[data-slot="0"]').getByRole('button', { name: '解锁打开', exact: true }).click()
    await main.locator('[data-slot="0"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    await main.locator('[data-slot="1"] input[type=file]').setInputFiles({ name: 'AES256 locked B.pdf', mimeType: 'application/pdf', buffer: encrypted })
    await main.getByLabel('文档 B 密码', { exact: true }).waitFor()
    await main.locator('[data-slot="1"]').getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await main.locator('[data-slot="1"] .pane-status').textContent(), '未加载')
    await main.locator('[data-slot="1"] input[type=file]').setInputFiles({ name: 'AES256 locked B.pdf', mimeType: 'application/pdf', buffer: encrypted })
    await main.getByLabel('文档 B 密码', { exact: true }).fill('5678')
    await main.locator('[data-slot="1"]').getByRole('button', { name: '解锁打开', exact: true }).click()
    await main.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    const encryptedWindow = app.waitForEvent('window')
    await main.getByRole('button', { name: '双屏窗口', exact: true }).click()
    const unlockedSecondary = await encryptedWindow
    unlockedSecondary.on('pageerror', error => errors.push(error.message))
    await unlockedSecondary.locator('[data-slot="1"] .pane-status').filter({ hasText: /文字索引完成/ }).waitFor({ timeout: 30000 })
    assert.equal(await unlockedSecondary.getByLabel('文档 B 密码', { exact: true }).count(), 0)
    const encryptedClosed = unlockedSecondary.waitForEvent('close')
    await main.getByRole('button', { name: '恢复双栏', exact: true }).click()
    await encryptedClosed
    await main.locator('[data-slot="1"] .current-hit').waitFor()
    await main.getByRole('button', { name: '偏好设置' }).click()
    const settingsDialog = main.getByRole('dialog', { name: '偏好设置' })
    await settingsDialog.waitFor()
    assert.ok((await settingsDialog.textContent()).includes('未注册系统关联'))
    await settingsDialog.getByRole('button', { name: '注册右键与打开方式' }).click()
    await main.waitForFunction(() => document.querySelector('.shell-status-badge')?.classList.contains('is-enabled'))
    await settingsDialog.getByRole('button', { name: '取消右键与关联' }).click()
    await main.waitForFunction(() => !document.querySelector('.shell-status-badge')?.classList.contains('is-enabled'))
    await settingsDialog.getByRole('button', { name: '关闭设置' }).click()
    await main.evaluate(() => window.open('https://example.com'))
    assert.equal(await main.evaluate(() => window.open('https://example.com') === null), true)
    assert.equal(await main.evaluate(() => fetch('app://viewer/%2e%2e%2fpackage.json').then(response => response.status)), 403)
    assert.deepEqual(requests, [])
    assert.deepEqual(await main.locator('[role=alert]').allTextContents(), [])
    assert.deepEqual(errors, [])
    mkdirSync('artifacts', { recursive: true })
    await main.screenshot({ path: 'artifacts/electron-desktop.png' })
    console.log(JSON.stringify({ packaged: !!executablePath, portablePath: !!temporary, nativeWindows: true, aes256Password: true, retryAndCancel: true, externalRequests: requests.length }))
  } finally {
    await app?.close()
    rmSync(temporary, { recursive: true, force: true })
  }
})