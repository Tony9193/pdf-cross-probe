export type Match = { page: number; start: number; length: number }
export type SearchResult = { mode: 'exact' | 'tolerant'; matches: Match[] }

const identifierCharacter = /[A-Z0-9_+./#~[\]-]/i

function normalize(text: string) {
  let value = ''
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of text) {
    const normalized = character.normalize('NFKC').toUpperCase()
    // 归一化或大写可能改变长度；为每个 UTF-16 单元保留原文范围，供结果定位。
    for (let index = 0; index < normalized.length; index++) {
      starts.push(offset)
      ends.push(offset + character.length)
    }
    value += normalized
    offset += character.length
  }
  return { value, starts: Uint32Array.from(starts), ends: Uint32Array.from(ends) }
}

type PreparedSearchPage = ReturnType<typeof normalize> & { boundaries: Set<number> }

function prepareSearchPage(text: string, boundaries: readonly number[] = []): PreparedSearchPage {
  return { ...normalize(text), boundaries: new Set(boundaries) }
}

function scanPage(normalized: PreparedSearchPage, pageIndex: number, query: string, exact: Match[], contained: Match[]) {
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
    if ((!identifierCharacter.test(before) || normalized.boundaries.has(match.start)) && !identifierCharacter.test(after)) exact.push(match)
    cursor = found + query.length
  }
}

type IncrementalEntry = {
  scanned: number
  exact: Match[]
  contained: Match[]
  exactSnapshot: SearchResult | null
  tolerantSnapshot: SearchResult | null
  autoSnapshot: SearchResult | null
}

const maxCachedQueries = 64

export class DocumentSearchIndex {
  private pages: PreparedSearchPage[] = []
  private anyText = false
  private cache = new Map<string, IncrementalEntry>()

  constructor(pages: string[] = []) {
    this.pages = pages.map(text => {
      const prepared = prepareSearchPage(text)
      if (prepared.value.trim().length > 0) this.anyText = true
      return prepared
    })
  }

  append(text: string, boundaries: readonly number[] = []) {
    const prepared = prepareSearchPage(text, boundaries)
    if (prepared.value.trim().length > 0) this.anyText = true
    this.pages.push(prepared)
  }

  get hasText() {
    return this.anyText
  }

  search(keyword: string, forceTolerant = false): SearchResult {
    const query = normalize(keyword.trim()).value
    if (!query) return { mode: forceTolerant ? 'tolerant' : 'exact', matches: [] }
    let entry = this.cache.get(query)
    if (entry) {
      // Refresh LRU order so deleted keywords are evicted under churn.
      this.cache.delete(query)
      this.cache.set(query, entry)
    } else {
      if (this.cache.size >= maxCachedQueries) {
        const oldest = this.cache.keys().next().value
        if (oldest !== undefined) this.cache.delete(oldest)
      }
      entry = { scanned: 0, exact: [], contained: [], exactSnapshot: null, tolerantSnapshot: null, autoSnapshot: null }
      this.cache.set(query, entry)
    }
    if (entry.scanned < this.pages.length) {
      const prevExact = entry.exact.length
      const prevContained = entry.contained.length
      for (let pageIndex = entry.scanned; pageIndex < this.pages.length; pageIndex++) {
        scanPage(this.pages[pageIndex], pageIndex, query, entry.exact, entry.contained)
      }
      entry.scanned = this.pages.length
      if (entry.exact.length !== prevExact) {
        entry.exactSnapshot = null
        entry.autoSnapshot = null
      }
      if (entry.contained.length !== prevContained) {
        entry.tolerantSnapshot = null
        if (!entry.exact.length) entry.autoSnapshot = null
      }
    }
    if (forceTolerant) {
      entry.tolerantSnapshot ??= { mode: 'tolerant', matches: [...entry.contained] }
      return entry.tolerantSnapshot
    }
    // 未强制宽松搜索时，全文有完整标识符匹配就优先返回它们；否则回退到包含匹配。
    if (entry.exact.length) {
      entry.exactSnapshot ??= { mode: 'exact', matches: [...entry.exact] }
      entry.autoSnapshot = entry.exactSnapshot
      return entry.exactSnapshot
    }
    entry.autoSnapshot ??= { mode: 'tolerant', matches: [...entry.contained] }
    return entry.autoSnapshot
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