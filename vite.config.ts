import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { createReadStream, existsSync, readdirSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'local-pdf-assets',
    buildStart() {
      const folders = ['cmaps', 'standard_fonts', 'wasm']
      const version = JSON.parse(readFileSync('node_modules/pdfjs-dist/package.json', 'utf8')).version
      const stamp = 'public/pdf-assets/.version'
      if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version && folders.every(folder => existsSync(`public/pdf-assets/${folder}`))) return
      for (const folder of folders) {
        mkdirSync(`public/pdf-assets/${folder}`, { recursive: true })
        cpSync(`node_modules/pdfjs-dist/${folder}`, `public/pdf-assets/${folder}`, { recursive: true })
      }
      writeFileSync(stamp, version)
    },
    configureServer(server) {
      const directory = process.env.PDF_SAMPLE_DIR
      if (!directory || !existsSync(directory)) return
      const names = readdirSync(directory).filter(name => name.toLowerCase().endsWith('.pdf'))
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (url.pathname === '/__samples') {
          response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(names))
        } else if (url.pathname.startsWith('/__samples/')) {
          const name = decodeURIComponent(url.pathname.slice('/__samples/'.length))
          if (!names.includes(name)) { response.statusCode = 404; response.end(); return }
          response.setHeader('Content-Type', 'application/pdf')
          createReadStream(path.join(directory, name)).pipe(response)
        } else next()
      })
    },
  }],
})
