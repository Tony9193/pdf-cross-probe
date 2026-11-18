import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { _electron } from 'playwright-core'
import { clip, degrees, endPath, PDFDocument, popGraphicsState, pushGraphicsState, rectangle, rgb, StandardFonts } from 'pdf-lib'
import { encryptedPdf } from '../tests/encrypted-fixture.mjs'
import { createCanvas } from './benchmark-fixture.mjs'

// An isolated app://viewer probe, not a feature flag or code shipped with the viewer.
const profile = await mkdtemp(join(tmpdir(), 'pdf-render-probe-'))
const assets = await mkdtemp(join(resolve('dist'), 'render-probe-'))
let app
try {
  for (const file of ['pdf.mjs', 'pdf.worker.mjs', 'pdf.renderer.mjs']) {
    await cp(join('node_modules', 'pdfjs-dist', 'build', file), join(assets, file))
  }
  const [vector, scan] = await createCanvas()
  const small = await PDFDocument.create()
  const font = await small.embedFont(StandardFonts.Helvetica)
  const drawing = small.addPage([600, 800])
  drawing.pushOperators(pushGraphicsState(), rectangle(30, 20, 540, 750), clip(), endPath())
  for (let i = 0; i < 80; i++) {
    drawing.drawLine({ start: { x: 10, y: i * 10 }, end: { x: 590, y: i * 10 + 50 }, thickness: .28, opacity: .7 })
    drawing.drawText(`R${i}`, { x: 110 + i % 20 * 16, y: 30 + i * 9, size: 5.2, rotate: degrees(37), font })
  }
  drawing.drawRectangle({ x: 108, y: 120, width: 137, height: 227, rotate: degrees(16), opacity: .32, color: rgb(0, .6, .4) })
  drawing.pushOperators(popGraphicsState())
  const raster = await small.save()
  const env = { ...process.env, PDF_CROSS_PROBE_MOCK_REGISTRY: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ args: [resolve('.'), `--user-data-dir=${profile}`, ...(process.argv.includes('--disable-gpu') ? ['--disable-gpu'] : [])], env })
  const window = await app.firstWindow()
  await window.getByRole('heading', { name: 'PDF 联动查看器', exact: true }).waitFor()
  for (const [fixture, contents, rotation] of [['vector', vector, 0], ['scan', scan, 0], ['clip-transparency-text', raster, 90]]) {
    const bytes = Buffer.from(contents).toString('base64')
    const result = await window.evaluate(async ({ bytes, rotation, folder }) => {
      const { getDocument, GlobalWorkerOptions } = await import(new URL(`/${folder}/pdf.mjs`, location.href).href)
      GlobalWorkerOptions.workerSrc = new URL(`/${folder}/pdf.worker.mjs`, location.href).href
      const renderer = new URL(`/${folder}/pdf.renderer.mjs`, location.href).href
      const fixtures = new Uint8Array(Array.from(atob(bytes), char => char.charCodeAt(0)))
      const NativeWorker = globalThis.Worker
      let workers = []
      globalThis.Worker = class extends NativeWorker {
        constructor(url, options) { super(url, options); this.probe = { url: String(url), terminated: false }; workers.push(this.probe) }
        terminate() { this.probe.terminated = true; return super.terminate() }
      }
      let basePixels
      const results = []
      try {
        const configurations = [
          ['default', false, false, false], ['worker', true, false, false], ['hwa', false, true, false],
          ['worker+hwa', true, true, false], ['worker-missing', 'missing', false, false], ['operator-filter', false, false, true],
        ]
        for (const [mode, worker, enableHWA, filter] of configurations) {
          workers = []
          GlobalWorkerOptions.rendererSrc = worker === 'missing' ? `${renderer}.missing.mjs` : worker ? renderer : ''
          const task = getDocument({ data: fixtures.slice(), enableHWA, standardFontDataUrl: 'app://viewer/pdf-assets/standard_fonts/', wasmUrl: 'app://viewer/pdf-assets/wasm/' })
          let recordMs = 0, pixelDifferences = 0, largestDelta = 0
          const timings = []
          try {
            const pdf = await task.promise
            const page = await pdf.getPage(1)
            const base = page.getViewport({ scale: 1, rotation })
            const canvas = document.createElement('canvas')
            const repaint = async (viewport, options) => {
              const start = performance.now()
              const rendering = page.render({ canvas, viewport, background: '#ffffff', ...options })
              await rendering.promise
              return performance.now() - start
            }
            let boxes
            if (filter) {
              canvas.width = Math.ceil(base.width); canvas.height = Math.ceil(base.height)
              recordMs = await repaint(base, { recordOperations: true })
              boxes = page.recordedBBoxes
              if (!boxes) throw new Error('No completed operator bounds')
            }
            const viewport = page.getViewport({ scale: 4, rotation })
            const width = 720, height = 560
            if (!basePixels) basePixels = []
            for (let n = 0; n < 4; n++) {
              const x = Math.round(viewport.width * (.12 + n * .085))
              const y = Math.round(viewport.height * (.10 + n * .095))
              canvas.width = width; canvas.height = height
              const operationsFilter = boxes ? (index) => !boxes.isEmpty(index) &&
                boxes.minX(index) <= (x + width) / viewport.width && boxes.maxX(index) >= x / viewport.width &&
                boxes.minY(index) <= (y + height) / viewport.height && boxes.maxY(index) >= y / viewport.height : undefined
              await new Promise(resolve => requestAnimationFrame(resolve))
              const elapsed = await repaint(viewport, { transform: [1, 0, 0, 1, -x, -y], operationsFilter })
              timings.push(Number(elapsed.toFixed(2)))
              const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data
              if (mode === 'default') basePixels.push(pixels)
              else for (let i = 0; i < pixels.length; i += 4) {
                const baseline = basePixels[n]
                const delta = Math.max(Math.abs(pixels[i] - baseline[i]), Math.abs(pixels[i + 1] - baseline[i + 1]), Math.abs(pixels[i + 2] - baseline[i + 2]))
                if (delta) pixelDifferences++
                if (delta > largestDelta) largestDelta = delta
              }
            }
          } finally { await task.destroy() }
          results.push({ mode, timings, recordMs, pixelDifferences, largestDelta, workers })
        }
      } finally { globalThis.Worker = NativeWorker }
      return results
    }, { bytes, rotation, folder: basename(assets) })
    console.log(JSON.stringify({ fixture, noGpu: process.argv.includes('--disable-gpu'), result }))
  }
  const locked = await encryptedPdf()
  const cancellation = await window.evaluate(async ({ bytes, folder }) => {
    const { getDocument, GlobalWorkerOptions } = await import(new URL(`/${folder}/pdf.mjs`, location.href).href)
    GlobalWorkerOptions.rendererSrc = new URL(`/${folder}/pdf.renderer.mjs`, location.href).href
    const task = getDocument({ data: new Uint8Array(Array.from(atob(bytes), char => char.charCodeAt(0))) })
    const prompt = new Promise(resolve => { task.onPassword = () => resolve() })
    const result = task.promise.then(() => 'opened', error => error.message)
    await prompt
    await task.destroy()
    return result
  }, { bytes: Buffer.from(locked).toString('base64'), folder: basename(assets) })
  console.log(JSON.stringify({ cancelledPassword: cancellation }))
} finally {
  try { await app?.close() } finally {
    await rm(assets, { recursive: true, force: true })
    await rm(profile, { recursive: true, force: true })
  }
}
