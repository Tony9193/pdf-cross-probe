import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootFiles = ['.gitignore', '.oxlintrc.json', 'index.html', 'package.json', 'package-lock.json', 'README.md', 'PUBLISHING.md',
  'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']
const sourceDirectories = ['src', 'electron', 'tests', 'scripts', 'portable']
const textExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.cmd', '.md', '.txt', '.html'])

export function publicSourceFiles(root = projectRoot) {
  const files = rootFiles.filter(name => existsSync(path.join(root, name)))
  for (const directory of sourceDirectories) {
    function walk(relative) {
      for (const item of readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const next = `${relative}/${item.name}`
        if (item.isSymbolicLink()) throw new Error(`Symlink is not allowed in public sources: ${next}`)
        if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'assets') continue
        if (item.isDirectory()) walk(next)
        else if (textExtensions.has(path.extname(item.name))) files.push(next)
      }
    }
    if (existsSync(path.join(root, directory))) {
      assert.ok(lstatSync(path.join(root, directory)).isDirectory(), `Source root must not be a symlink: ${directory}`)
      walk(directory)
    }
  }
  for (const name of ['public/favicon.svg', 'public/icons.svg']) if (existsSync(path.join(root, name))) files.push(name)
  for (const name of files) assert.ok(lstatSync(path.join(root, name)).isFile(), `Not a regular source file: ${name}`)
  return files.sort()
}

export function auditText(text, privateTerms = []) {
  const rules = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['user-path', /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"'<>]+|\/(?:Users|home)\/[^\s"'<>]+/i],
    ['private-network', /https?:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?/i],
    ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/i],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
    ['cloud-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['credential-assignment', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|_authToken)\s*[:=]\s*["'][^"'\s$]{12,}["']/i],
    ['private-host', /https?:\/\/[A-Za-z0-9._-]+\.(?:internal|corp|intranet|lan|local)\b/i],
  ]
  const findings = rules.filter(([, expression]) => expression.test(text)).map(([name]) => name)
  if (privateTerms.some(term => term && text.toLowerCase().includes(term.toLowerCase()))) findings.push('private-term')
  return findings
}

export function auditPublicSource(root = projectRoot, files = publicSourceFiles(root), privateTerms = []) {
  const findings = []
  for (const name of files) {
    const text = readFileSync(path.join(root, name), 'utf8')
    for (const category of auditText(`${name}\n${text}`, privateTerms)) {
      findings.push({ file: name, category })
    }
  }
  return { files, findings }
}

export function sourceManifest(root, files) {
  return files.map(name => ({ file: name, sha256: createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex') }))
}