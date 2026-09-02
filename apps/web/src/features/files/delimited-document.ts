export interface DelimitedDocument {
  headers: string[]
  rows: string[][]
  columnCount: number
  truncated: boolean
}

const MAX_PARSED_ROWS = 5_000
const MAX_PARSED_COLUMNS = 200
const MAX_PARSED_CELLS = 50_000

/** Why a cap stopped a cell or a row. `columns` is per-row and recoverable — the
 * rest of that row is dropped and parsing resumes on the next one. `cells` and
 * `rows` are whole-document budgets, so they end the parse. */
type CapStop = 'ok' | 'columns' | 'cells' | 'rows'

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
  // The current row hit the column cap: keep scanning it for the newline that
  // ends it, but discard its remaining cells. Dropping the REST OF THE ROW is
  // what keeps a document whose first row is too wide from losing every row
  // after it as well.
  let rowOverflow = false
  let stopped = false

  const endCell = (): CapStop => {
    if (parsedCells >= MAX_PARSED_CELLS) return 'cells'
    if (row.length >= MAX_PARSED_COLUMNS) return 'columns'
    row.push(cell)
    parsedCells += 1
    cell = ''
    return 'ok'
  }
  const endRow = (): CapStop => {
    if (parsed.length > MAX_PARSED_ROWS) return 'rows'
    const stop = endCell()
    if (stop === 'cells') return 'cells'
    parsed.push(row)
    row = []
    cell = ''
    return stop
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          if (!rowOverflow) cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else if (!rowOverflow) {
        cell += char
      }
      continue
    }

    if (char === '"' && cell === '') {
      quoted = true
    } else if (char === delimiter) {
      if (rowOverflow) continue
      const stop = endCell()
      if (stop === 'cells') {
        truncated = true
        stopped = true
        break
      }
      if (stop === 'columns') {
        truncated = true
        rowOverflow = true
        cell = ''
      }
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      const stop = endRow()
      rowOverflow = false
      if (stop !== 'ok') {
        truncated = true
        if (stop === 'cells' || stop === 'rows') {
          stopped = true
          break
        }
      }
    } else if (!rowOverflow) {
      cell += char
    }
  }

  if (!stopped && (cell !== '' || row.length > 0 || rowOverflow || !/[\r\n]$/.test(text))) {
    if (endRow() !== 'ok') truncated = true
  }
  // Preserve a bounded partial row when a whole-document cap stopped the parse
  // mid-row. This is especially useful for a header wider than the preview limit.
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
