export type Match = { page: number; start: number; length: number }
export type SearchResult = { mode: 'exact' | 'tolerant'; matches: Match[] }

const identifierCharacter = /[A-Z0-9_+./#~\[\]-]/i

function normalize(text: string) {
  let value = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of text) {
    const normalized = character.normalize('NFKC').toUpperCase()
    for (let index = 0; index < normalized.length; index++) {
      starts.push(offset)
      ends.push(offset + character.length)
    }
    value += normalized
    offset += character.length
  }
  return { value, starts, ends }
}

function searchPreparedPages(pages: ReturnType<typeof normalize>[], keyword: string, forceTolerant = false): SearchResult {
  const query = normalize(keyword.trim()).value
  if (!query) return { mode: forceTolerant ? 'tolerant' : 'exact', matches: [] }
  const exact: Match[] = []
  const contained: Match[] = []
  pages.forEach((normalized, pageIndex) => {
    let cursor = 0
    while (cursor <= normalized.value.length - query.length) {
      const found = normalized.value.indexOf(query, cursor)
      if (found < 0) break
      const match = {
        page: pageIndex + 1,
        start: normalized.starts[found],
        length: normalized.ends[found + query.length - 1] - normalized.starts[found],
      }
      contained.push(match)
      const before = normalized.value[found - 1] ?? ''
      const after = normalized.value[found + query.length] ?? ''
      if (!identifierCharacter.test(before) && !identifierCharacter.test(after)) exact.push(match)
      cursor = found + query.length
    }
  })
  if (!forceTolerant && exact.length) return { mode: 'exact', matches: exact }
  return { mode: 'tolerant', matches: contained }
}

export class DocumentSearchIndex {
  private pages: ReturnType<typeof normalize>[] = []
  private results = new Map<string, SearchResult>()

  constructor(pages: string[] = []) {
    this.pages = pages.map(normalize)
  }

  append(text: string) {
    this.pages.push(normalize(text))
    this.results.clear()
  }

  get hasText() {
    return this.pages.some(page => page.value.trim().length > 0)
  }

  search(keyword: string, forceTolerant = false): SearchResult {
    const key = JSON.stringify([keyword.trim(), forceTolerant])
    let result = this.results.get(key)
    if (!result) {
      result = searchPreparedPages(this.pages, keyword, forceTolerant)
      this.results.set(key, result)
    }
    return result
  }
}

export function searchDocument(pages: string[], keyword: string, forceTolerant = false): SearchResult {
  return new DocumentSearchIndex(pages).search(keyword, forceTolerant)
}

export function keywordAt(text: string, offset: number): string | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length || !text.length) return null
  const position = Math.min(offset, text.length - 1)
  if (!identifierCharacter.test(text[position])) return null
  let start = position, end = position + 1
  while (start > 0 && identifierCharacter.test(text[start - 1])) start--
  while (end < text.length && identifierCharacter.test(text[end])) end++
  return text.slice(start, end)
}

export function angleDistance(first: number, second: number): number {
  return Math.abs(Math.atan2(Math.sin(first - second), Math.cos(first - second)))
}

export function nextMatchIndex(matches: Match[], current: number, direction: number, page?: number): number {
  const candidates = matches.flatMap((match, index) => page === undefined || match.page === page ? [index] : [])
  if (!candidates.length) return -1
  const position = candidates.indexOf(current)
  if (position < 0) return direction < 0 ? candidates[candidates.length - 1] : candidates[0]
  return candidates[(position + direction + candidates.length) % candidates.length]
}

export function splitKeywords(input: string): string[] {
  return [...new Set(input.split(/\r?\n/).map(term => term.trim()).filter(Boolean))]
}