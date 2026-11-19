export type ReleasePageTarget = 'latest' | `${number}.${number}.${number}`

export type ReleaseNoteInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: ReleaseNoteInline[] }
  | { type: 'link'; label: string; target: ReleasePageTarget }

export type ReleaseNoteBlock =
  | { type: 'heading'; level: 1 | 2 | 3; children: ReleaseNoteInline[] }
  | { type: 'paragraph'; lines: ReleaseNoteInline[][] }
  | { type: 'list'; items: ReleaseNoteInline[][] }

const tagPathPattern = /^\/tony9193\/pdf-cross-probe\/releases\/tag\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/i
const latestPathPattern = /^\/tony9193\/pdf-cross-probe\/releases\/latest$/i

export function parseReleaseLink(rawUrl: string): ReleasePageTarget | null {
  try {
    const url = new URL(rawUrl.trim())
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
    if (url.search || url.hash || url.username || url.password) return null
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '')
    if (latestPathPattern.test(pathname)) return 'latest'
    const tagMatch = tagPathPattern.exec(pathname)
    if (tagMatch) return tagMatch[1] as ReleasePageTarget
    return null
  } catch {
    return null
  }
}

function findStrongEnd(text: string, from: number): number {
  let inCode = false
  for (let i = from; i < text.length; i++) {
    if (text[i] === '`') {
      inCode = !inCode
      continue
    }
    if (!inCode && text[i] === '*' && text[i + 1] === '*') return i
  }
  return -1
}

export function parseReleaseInline(text: string, allowStrong = true): ReleaseNoteInline[] {
  const nodes: ReleaseNoteInline[] = []
  const pushText = (chunk: string) => {
    if (!chunk) return
    const previous = nodes.at(-1)
    if (previous?.type === 'text') previous.text += chunk
    else nodes.push({ type: 'text', text: chunk })
  }

  let i = 0
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        nodes.push({ type: 'code', text: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    // Images are never rendered; keep the opening prefix as plain text so the inner [...] is not parsed as a link.
    if (text[i] === '!' && text[i + 1] === '[') {
      pushText('![')
      i += 2
      continue
    }

    if (allowStrong && text[i] === '*' && text[i + 1] === '*') {
      const end = findStrongEnd(text, i + 2)
      if (end > i + 2) {
        nodes.push({ type: 'strong', children: parseReleaseInline(text.slice(i + 2, end), false) })
        i = end + 2
        continue
      }
    }

    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1)
      if (closeBracket > i + 1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2)
        const label = text.slice(i + 1, closeBracket)
        if (closeParen > closeBracket + 2 && !label.includes('[')) {
          const url = text.slice(closeBracket + 2, closeParen)
          if (!/\s/.test(url)) {
            const target = parseReleaseLink(url)
            if (target) nodes.push({ type: 'link', label, target })
            else pushText(label)
            i = closeParen + 1
            continue
          }
        }
      }
    }

    pushText(text[i])
    i++
  }

  return nodes
}

export function parseReleaseNotes(markdown: string): ReleaseNoteBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReleaseNoteBlock[] = []
  let paragraphLines: ReleaseNoteInline[][] = []
  let listItems: ReleaseNoteInline[][] = []

  const flushParagraph = () => {
    if (!paragraphLines.length) return
    blocks.push({ type: 'paragraph', lines: paragraphLines })
    paragraphLines = []
  }
  const flushList = () => {
    if (!listItems.length) return
    blocks.push({ type: 'list', items: listItems })
    listItems = []
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed) {
      flushParagraph()
      flushList()
      continue
    }

    const heading = /^(#{1,3})\s+(.+?)\s*#*$/.exec(trimmed)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        children: parseReleaseInline(heading[2]),
      })
      continue
    }

    const listItem = /^[-*]\s+(.+)$/.exec(trimmed)
    if (listItem) {
      flushParagraph()
      listItems.push(parseReleaseInline(listItem[1]))
      continue
    }

    flushList()
    paragraphLines.push(parseReleaseInline(trimmed))
  }

  flushParagraph()
  flushList()
  return blocks
}
