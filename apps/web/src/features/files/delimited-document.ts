export interface DelimitedDocument {
  headers: string[]
  rows: string[][]
  columnCount: number
}

/** Parse the RFC 4180-shaped subset used by CSV and its tab-delimited sibling.
 * Quoted separators, escaped quotes, and line breaks inside quoted cells are
 * handled here so the viewer does not quietly shift data into the wrong column. */
export function parseDelimitedDocument(source: string, delimiter: ',' | '\t'): DelimitedDocument {
  if (source === '') return { headers: [], rows: [], columnCount: 0 }
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  if (text === '') return { headers: [], rows: [], columnCount: 0 }

  const parsed: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  const endCell = (): void => {
    row.push(cell)
    cell = ''
  }
  const endRow = (): void => {
    endCell()
    parsed.push(row)
    row = []
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
      endCell()
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      endRow()
    } else {
      cell += char
    }
  }

  if (cell !== '' || row.length > 0 || !/[\r\n]$/.test(text)) endRow()

  const columnCount = parsed.reduce((largest, cells) => Math.max(largest, cells.length), 0)
  const first = parsed[0] ?? []
  const headers = Array.from({ length: columnCount }, (_, index) => {
    const value = first[index]?.trim()
    return value || `Column ${index + 1}`
  })
  const rows = parsed
    .slice(1)
    .map((cells) => Array.from({ length: columnCount }, (_, index) => cells[index] ?? ''))
  return { headers, rows, columnCount }
}
