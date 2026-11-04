import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron } from 'playwright-core'
import { PDFDocument, StandardFonts } from 'pdf-lib'

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
  if (existsSync(packaged)) {
    const folder = path.join(temporary, 'app')
    cpSync(path.dirname(packaged), folder, { recursive: true })
    executablePath = path.join(folder, 'PDF Cross Probe.exe')
  }
  const env = { ...process.env }
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
    assert.equal(await main.evaluate(() => window.open('https://example.com') === null), true)
    assert.equal(await main.evaluate(() => fetch('app://viewer/%2e%2e%2fpackage.json').then(response => response.status)), 403)
    assert.deepEqual(requests, [])
    assert.deepEqual(await main.locator('[role=alert]').allTextContents(), [])
    assert.deepEqual(errors, [])
    mkdirSync('artifacts', { recursive: true })
    await main.screenshot({ path: 'artifacts/electron-desktop.png' })
    console.log(JSON.stringify({ packaged: !!executablePath, portablePath: !!temporary, nativeWindows: true, externalRequests: requests.length }))
  } finally {
    await app?.close()
    rmSync(temporary, { recursive: true, force: true })
  }
})