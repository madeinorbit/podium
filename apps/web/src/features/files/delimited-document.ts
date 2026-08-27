export interface DelimitedDocument {
  headers: string[]
  rows: string[][]
  columnCount: number
  truncated: boolean
}

const MAX_PARSED_ROWS = 5_000
const MAX_PARSED_COLUMNS = 200
const MAX_PARSED_CELLS = 50_000

/** Parse the RFC 4180-shaped subset used by CSV and its tab-delimited sibling.
 * Quoted separators, escaped quotes, and line breaks inside quoted cells are
 * handled here so the viewer does not quietly shift data into the wrong column. */
export function parseDelimitedDocument(source: string, delimiter: ',' | '\t'): DelimitedDocument {
  if (source === '') return { headers: [], rows: [], columnCount: 0, truncated: false }
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  if (text === '') return { headers: [], rows: [], columnCount: 0, truncated: false }

  const parsed: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let parsedCells = 0
  let truncated = false

  const endCell = (): boolean => {
    if (row.length >= MAX_PARSED_COLUMNS || parsedCells >= MAX_PARSED_CELLS) return false
    row.push(cell)
    parsedCells += 1
    cell = ''
    return true
  }
  const endRow = (): boolean => {
    if (parsed.length > MAX_PARSED_ROWS || !endCell()) return false
    parsed.push(row)
    row = []
    return true
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }

    if (char === '"' && cell === '') {
      quoted = true
    } else if (char === delimiter) {
      if (!endCell()) {
        truncated = true
        break
      }
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      if (!endRow()) {
        truncated = true
        break
      }
    } else {
      cell += char
    }
  }

  if (!truncated && (cell !== '' || row.length > 0 || !/[\r\n]$/.test(text)) && !endRow()) {
    truncated = true
  }
  // Preserve a bounded partial row when the cap is reached mid-row. This is
  // especially useful for a header wider than the preview limit.
  if (truncated && row.length > 0 && parsed.length <= MAX_PARSED_ROWS) parsed.push(row)

  const columnCount = parsed.reduce((largest, cells) => Math.max(largest, cells.length), 0)
  const first = parsed[0] ?? []
  const headers = Array.from({ length: columnCount }, (_, index) => {
    const value = first[index]?.trim()
    return value || `Column ${index + 1}`
  })
  const rows = parsed
    .slice(1)
    .map((cells) => Array.from({ length: columnCount }, (_, index) => cells[index] ?? ''))
  return { headers, rows, columnCount, truncated }
}
