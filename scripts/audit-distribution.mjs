import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { auditText, projectRoot } from './public-source.mjs'

const asar = createRequire(import.meta.url)('@electron/asar')
const configuration = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const privateTerms = JSON.parse(process.env.PUBLIC_AUDIT_TERMS ?? '[]')
assert.ok(Array.isArray(privateTerms) && privateTerms.every(term => typeof term === 'string'), 'PUBLIC_AUDIT_TERMS must be a JSON string array')
const folders = process.argv.slice(2)
if (!folders.length) folders.push(`${configuration.build.directories.output}/win-unpacked`)
const reports = []

for (const folder of folders) {
  const root = path.resolve(projectRoot, folder)
  const archive = path.join(root, 'resources', 'app.asar')
  assert.ok(existsSync(archive), `Missing app archive under: ${folder}`)
  const findings = []
  const companionFiles = []
  let checked = 0, licensesPreserved = 0
  function inspect(name, buffer) {
    if (/license|notice|copyright/i.test(name)) { licensesPreserved++; return }
    if (/\.(pdf|sch|pcb|brd|xlsx|csv|dmp)$/i.test(name)) findings.push({ file: name, category: 'private-document-type' })
    if (!/\.(js|mjs|cjs|json|html|css|svg|md|txt|cmd|map|ya?ml)$/i.test(name)) return
    checked++
    for (const category of auditText(`${name}\n${buffer.toString('utf8')}`, privateTerms)) findings.push({ file: name, category })
  }
  for (const entry of asar.listPackage(archive)) {
    const name = entry.replaceAll('\\', '/').replace(/^\//, '')
    if (asar.statFile(archive, path.normalize(name)).files) continue
    inspect(`app.asar/${name}`, asar.extractFile(archive, path.normalize(name)))
  }
  function walk(directory, relative = '') {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${item.name}` : item.name
      if (item.isSymbolicLink()) { findings.push({ file: name, category: 'symlink' }); continue }
      if (item.isDirectory()) walk(path.join(directory, item.name), name)
      else {
        companionFiles.push(name)
        if (name === 'resources/app.asar') continue
        if (/\.(pdf|sch|pcb|brd|xlsx|csv|dmp|log|map|ya?ml)$/i.test(name) && !/license|notice|copyright/i.test(name)) findings.push({ file: name, category: 'unexpected-release-file' })
        if (/\.(js|mjs|cjs|json|html|css|svg|md|txt|cmd|map|ya?ml)$/i.test(name)) inspect(name, readFileSync(path.join(directory, item.name)))
      }
    }
  }
  walk(root)
  const archives = []
  for (const archiveName of readdirSync(path.dirname(root)).filter(name => name.endsWith('.zip'))) {
    const names = []
    const selected = new Set(['resources/app.asar', 'README.txt', 'Start.cmd', 'PDFJS-LICENSE.txt'])
    const contents = unzipSync(readFileSync(path.join(path.dirname(root), archiveName)), { filter: entry => {
      if (!entry.name.endsWith('/')) names.push(entry.name)
      return selected.has(entry.name)
    } })
    assert.deepEqual(names.sort(), [...companionFiles].sort(), `Release ZIP file list differs: ${archiveName}`)
    for (const name of selected) assert.equal(Buffer.compare(Buffer.from(contents[name]), readFileSync(path.join(root, name))), 0, `Release ZIP contains a different file: ${name}`)
    archives.push({ file: archiveName, verifiedEntries: names.length })
  }
  reports.push({ folder: path.relative(projectRoot, root).replaceAll('\\', '/'), checkedTextFiles: checked, licensesPreserved, archives, findings })
}
console.log(JSON.stringify({ passed: reports.every(report => report.findings.length === 0), reports }, null, 2))
if (reports.some(report => report.findings.length)) process.exitCode = 1