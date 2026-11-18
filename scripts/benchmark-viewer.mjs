import { createCanvas } from './benchmark-fixture.mjs'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

const controlDir = process.argv[2]
const servers = []
const start = async (label, outDir) => {
  const instance = await preview({ preview: { host: '127.0.0.1', port: 0 }, build: { outDir } })
  const server = { label, instance, url: instance.resolvedUrls.local[0] }
  servers.push(server)
  return server
}
async function sample(browser, server, name, buffer) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
      try {
        const page = await context.newPage()
        await page.goto(server.url)
        const pane = page.locator('[data-slot="0"]')
        await pane.locator('input[type=file]').evaluate(input => {
          window.pdfBenchStart = 0
          window.pdfFirstFrame = new Promise(resolve => {
            const read = now => {
              const paper = input.closest('.pdf-pane').querySelector('.paper')
              if (window.pdfBenchStart && paper?.dataset.renderedPage === '1') resolve(now - window.pdfBenchStart)
              else requestAnimationFrame(read)
            }
            requestAnimationFrame(read)
          })
          input.addEventListener('change', () => { window.pdfBenchStart = performance.now() }, { once: true })
        })
        await pane.locator('input[type=file]').setInputFiles({ name: `${name}.pdf`, mimeType: 'application/pdf', buffer })
        await pane.locator('.paper[data-rendered-page="1"]').waitFor()
        const firstFrameMs = await page.evaluate(() => window.pdfFirstFrame)
        const zoom = pane.locator('.zoom-value')
        await zoom.fill('400')
        await pane.locator('.detail-canvas[data-scale="4"]').waitFor()
        const pan = await pane.evaluate(element => new Promise(resolve => {
          const scroll = element.querySelector('.pdf-scroll')
          const covers = () => {
            const page = element.querySelector('.paper'), detail = page.querySelector('.detail-canvas')
            const area = scroll.getBoundingClientRect(), paper = page.getBoundingClientRect()
            const box = detail.getBoundingClientRect()
            return box.left <= Math.max(area.left, paper.left) + 2 && box.top <= Math.max(area.top, paper.top) + 2 &&
              box.right >= Math.min(area.left + scroll.clientWidth, paper.right) - 2 &&
              box.bottom >= Math.min(area.top + scroll.clientHeight, paper.bottom) - 2
          }
          const frames = []
          let previous, hits = 0, stopped
          const step = now => {
            if (previous !== undefined && !stopped) frames.push(now - previous)
            previous = now
            if (frames.length < 72) {
              const direction = frames.length < 48 ? 1 : -1
              scroll.scrollBy(direction * 11, direction * 17)
              if (covers()) hits++
            } else {
              stopped ??= now
              if (covers() || now - stopped > 5000) {
                frames.sort((a, b) => a - b)
                resolve({ frameP95Ms: frames[Math.ceil(frames.length * 0.95) - 1], sharpPercent: hits / 72 * 100,
                  settleMs: now - stopped, backingBytesInPane: [...element.querySelectorAll('canvas')].reduce((n, c) => n + c.width * c.height * 4, 0) })
                return
              }
            }
            requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        }))
        const cdp = await context.newCDPSession(page)
        const heap = await cdp.send('Runtime.getHeapUsage')
        return { firstFrameMs, ...pan, sampledJsHeapBytes: heap.usedSize }
      } finally { await context.close() }
}

let browser
try {
  const candidate = await start('candidate', 'dist')
  const control = controlDir ? await start('control', controlDir) : null
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const [vector, scanned, mixed] = await createCanvas()
  for (const [name, buffer] of [['vector', vector], ['scan', scanned], ['mixed', mixed]]) {
    const runs = { candidate: [], control: [] }
    for (let run = 0; run < 3; run++) {
      for (const server of control ? (run % 2 ? [candidate, control] : [control, candidate]) : [candidate]) {
        runs[server.label].push(await sample(browser, server, name, buffer))
      }
    }
    const stats = values => Object.fromEntries(Object.keys(values[0]).map(key => [key, values.map(run => run[key]).sort((a, b) => a - b)[1]]))
    for (const server of servers) console.log(JSON.stringify({ fixture: name, build: server.label, median: stats(runs[server.label]), runs: runs[server.label] }))
  }
} finally {
  await browser?.close()
  await Promise.all(servers.map(({ instance }) => new Promise(resolve => instance.httpServer.close(resolve))))
}
