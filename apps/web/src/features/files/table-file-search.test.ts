import { describe, expect, it, vi } from 'vitest'
import type { DelimitedDocument } from './delimited-document'
import { parseDelimitedDocument } from './delimited-document'
import { TableFileSearch } from './table-file-search'

function documentFor(rows: string[][]): DelimitedDocument {
  const columnCount = rows[0]?.length ?? 0
  return {
    headers: Array.from({ length: columnCount }, (_, index) => `c${index}`),
    rows,
    columnCount,
    truncated: false,
  }
}

describe('TableFileSearch', () => {
  it('finds a match beyond both displayed rows and columns with an exact count', () => {
    const rows = Array.from({ length: 800 }, () => Array<string>(60).fill('ordinary'))
    rows[799]![59] = 'Last NEEDLE'
    const search = new TableFileSearch(documentFor(rows), 'needle')

    expect(search.matchCount).toBe(1)
    expect(search.window(null)).toEqual({
      rows: [{ row: rows[799], sourceIndex: 799 }],
      columns: 50,
    })
    expect(new TableFileSearch(documentFor(rows), 'absent').window(null).rows).toEqual([])
  })

  it('selects the same numeric window as whole-file sorting, with stable ties', () => {
    const rows = Array.from({ length: 2_000 }, (_, index) => [
      String(((index * 997) % 400) / 10 - 20),
      index % 3 === 0 ? 'keep' : 'drop',
    ])
    const original = rows.slice()
    const search = new TableFileSearch(documentFor(rows), 'keep')
    const expected = rows
      .map((row, sourceIndex) => ({ row, sourceIndex }))
      .filter(({ row }) => row[1] === 'keep')
    expect(search.matchCount).toBe(expected.length)

    for (const direction of ['asc', 'desc'] as const) {
      const sign = direction === 'asc' ? 1 : -1
      const ordered = expected
        .slice()
        .sort(
          (a, b) => sign * (Number(a.row[0]) - Number(b.row[0])) || a.sourceIndex - b.sourceIndex,
        )
      expect(search.window({ column: 0, direction }).rows).toEqual(ordered.slice(0, 500))
    }
    expect(search.window(null).rows).toEqual(expected.slice(0, 500))
    expect(rows).toEqual(original)
  })

  it('keeps natural text order and handles blank/numeric cells', () => {
    const text = documentFor([['item20'], ['Item2'], ['item1'], ['item2']])
    expect(
      new TableFileSearch(text, '')
        .window({ column: 0, direction: 'asc' })
        .rows.map(({ sourceIndex }) => sourceIndex),
    ).toEqual([2, 1, 3, 0])
    const numeric = documentFor([['-2'], ['1.5'], ['-10'], ['1.10'], ['']])
    expect(
      new TableFileSearch(numeric, '')
        .window({ column: 0, direction: 'asc' })
        .rows.map(({ row }) => row[0]),
    ).toEqual(['', '-10', '-2', '1.10', '1.5'])
  })

  it('sorts all rows when unfiltered and respects the wide-table cell budget', () => {
    const rows = Array.from({ length: 800 }, (_, index) =>
      Array<string>(60).fill(String(800 - index)),
    )
    const search = new TableFileSearch(documentFor(rows), '')
    expect(search.matchCount).toBe(800)
    const window = search.window({ column: 0, direction: 'asc' })
    expect(window.columns).toBe(50)
    expect(window.rows).toHaveLength(100)
    expect(window.rows.map(({ row }) => row[0])).toEqual(
      Array.from({ length: 100 }, (_, index) => String(index + 1)),
    )
  })

  it('uses a consistent numeric-before-text order for mixed columns across the window boundary', () => {
    const values = ['1.7a', '1.5', '1.10']
    const search = new TableFileSearch(
      documentFor(Array.from({ length: 900 }, (_, index) => [values[index % 3]!])),
      '',
    )
    const group = (offset: number) => Array.from({ length: 300 }, (_, index) => index * 3 + offset)
    expect(
      search.window({ column: 0, direction: 'asc' }).rows.map(({ sourceIndex }) => sourceIndex),
    ).toEqual([...group(2), ...group(1)].slice(0, 500))
    expect(
      search.window({ column: 0, direction: 'desc' }).rows.map(({ sourceIndex }) => sourceIndex),
    ).toEqual([...group(0), ...group(1)].slice(0, 500))
  })

  it('searches only the parsed corpus when the file exceeds parser caps', () => {
    const table = parseDelimitedDocument(`name\n${'ordinary\n'.repeat(5_000)}outside`, ',')
    expect(table.truncated).toBe(true)
    expect(new TableFileSearch(table, 'outside').matchCount).toBe(0)
    expect(new TableFileSearch(table, 'ordinary').matchCount).toBe(5_000)
  })

  it('handles empty and header-only files, even with a retained sort', () => {
    for (const source of ['', 'name,count\n']) {
      const search = new TableFileSearch(parseDelimitedDocument(source, ','), 'missing')
      expect(search.matchCount).toBe(0)
      expect(search.window({ column: 3, direction: 'desc' }).rows).toEqual([])
    }
  })

  it.each([
    1_000, 4_000,
  ])('bounds projection for %i file rows while exposing linear search work', (count) => {
    let rowReads = 0
    let cellReads = 0
    const rows = Array.from(
      { length: count },
      (_, index) =>
        new Proxy(['ordinary', String(index), 'ordinary', 'needle'], {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) cellReads += 1
            return Reflect.get(target, key, receiver)
          },
        }),
    )
    const table = documentFor(
      new Proxy(rows, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) rowReads += 1
          return Reflect.get(target, key, receiver)
        },
      }),
    )
    rowReads = 0
    const unfiltered = new TableFileSearch(table, '')
    expect(unfiltered.window(null).rows).toHaveLength(500)
    expect(rowReads).toBe(500)
    expect(cellReads).toBe(0)

    rowReads = 0
    const search = new TableFileSearch(table, 'needle')
    expect(search.matchCount).toBe(count)
    expect(rowReads).toBe(count)
    expect(cellReads).toBe(count * 4)

    rowReads = 0
    cellReads = 0
    expect(search.window(null).rows).toHaveLength(500)
    expect(rowReads).toBe(500)
    expect(cellReads).toBe(0)
    const sort = vi.spyOn(Array.prototype, 'sort')
    const map = vi.spyOn(Array.prototype, 'map')
    let sorted: ReturnType<TableFileSearch['window']>
    const sortedSizes: number[] = []
    const projectedSizes: number[] = []
    try {
      sorted = search.window({ column: 1, direction: 'desc' })
      for (const array of sort.mock.contexts) {
        if (!Array.isArray(array)) throw new Error('Expected an array sort receiver')
        sortedSizes.push(array.length)
      }
      for (const array of map.mock.contexts) {
        if (!Array.isArray(array)) throw new Error('Expected an array map receiver')
        projectedSizes.push(array.length)
      }
    } finally {
      sort.mockRestore()
      map.mockRestore()
    }
    expect(sorted.rows).toHaveLength(500)
    expect(sortedSizes).toEqual([500])
    expect(projectedSizes).toEqual([500])
    // Sort reads one selected column, never re-runs text matching; allow the
    // heap's log-W comparisons plus the final bounded window sort.
    expect(cellReads).toBeLessThan(count * 48)
  })
})
