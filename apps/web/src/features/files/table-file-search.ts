import type { DelimitedDocument } from './delimited-document'
import { tableRenderWindow } from './table-window'

const VALUE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** A total order is required for bounded selection: blanks, numeric values,
 * then naturally ordered text/ids. Falling back to text only when ONE operand
 * is nonnumeric creates cycles (1.10 < 1.5 < 1.7a < 1.10). */
function compareCellValues(a: string, b: string): number {
  const leftBlank = a.trim() === ''
  const rightBlank = b.trim() === ''
  if (leftBlank || rightBlank) {
    return leftBlank === rightBlank ? VALUE_COLLATOR.compare(a, b) : leftBlank ? -1 : 1
  }
  const left = Number(a)
  const right = Number(b)
  const leftNumeric = Number.isFinite(left)
  const rightNumeric = Number.isFinite(right)
  if (leftNumeric && rightNumeric) {
    return left === right ? 0 : left < right ? -1 : 1
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return VALUE_COLLATOR.compare(a, b)
}

export type TableFileSort = { column: number; direction: 'asc' | 'desc' } | null

export interface TableFileWindow {
  rows: { row: string[]; sourceIndex: number }[]
  columns: number
}

/** One immutable owner per parsed file and normalized query. A nonempty query
 * searches ALL parsed rows/columns (including cells outside the DOM window):
 * O(file cells + text length), with one membership byte per parsed row and an
 * exact count. Parser caps still apply; this is not search over discarded data.
 * Only the first display window's row ordinals are retained. Sort changes reuse
 * membership, selecting W rows in O(file rows + matches log W) work / O(W) space.
 * An empty query reads only W rows; a file update replaces this entire owner. */
export class TableFileSearch {
  readonly matchCount: number
  private readonly matches: Uint8Array | null
  private readonly firstMatches: number[] = []

  constructor(
    private readonly table: DelimitedDocument,
    normalizedQuery: string,
  ) {
    const limit = tableRenderWindow(table.rows.length, table.columnCount).rows
    if (!normalizedQuery) {
      this.matches = null
      this.matchCount = table.rows.length
      for (let index = 0; index < limit; index += 1) this.firstMatches.push(index)
      return
    }

    this.matches = new Uint8Array(table.rows.length)
    let count = 0
    for (let index = 0; index < table.rows.length; index += 1) {
      const row = table.rows[index] ?? []
      if (!row.some((value) => value.toLocaleLowerCase().includes(normalizedQuery))) continue
      this.matches[index] = 1
      count += 1
      if (this.firstMatches.length < limit) this.firstMatches.push(index)
    }
    this.matchCount = count
  }

  window(sort: TableFileSort): TableFileWindow {
    const { rows: limit, columns } = tableRenderWindow(this.matchCount, this.table.columnCount)
    if (!sort || limit === 0) return this.materialize(this.firstMatches, columns)

    const compare = (a: number, b: number): number => {
      const order = compareCellValues(
        this.table.rows[a]?.[sort.column] ?? '',
        this.table.rows[b]?.[sort.column] ?? '',
      )
      return (sort.direction === 'asc' ? order : -order) || a - b
    }
    // A max heap keeps the worst retained row at the root. It never grows past
    // the render budget, even when every file row matches the query.
    const heap: number[] = []
    for (let index = 0; index < this.table.rows.length; index += 1) {
      if (this.matches && !this.matches[index]) continue
      if (heap.length < limit) {
        heap.push(index)
        let child = heap.length - 1
        while (child > 0) {
          const parent = Math.floor((child - 1) / 2)
          if (compare(heap[child]!, heap[parent]!) <= 0) break
          const previous = heap[parent]!
          heap[parent] = heap[child]!
          heap[child] = previous
          child = parent
        }
      } else if (compare(index, heap[0]!) < 0) {
        heap[0] = index
        let parent = 0
        while (parent * 2 + 1 < heap.length) {
          const left = parent * 2 + 1
          const right = left + 1
          const child = right < heap.length && compare(heap[right]!, heap[left]!) > 0 ? right : left
          if (compare(heap[child]!, heap[parent]!) <= 0) break
          const previous = heap[parent]!
          heap[parent] = heap[child]!
          heap[child] = previous
          parent = child
        }
      }
    }
    heap.sort(compare)
    return this.materialize(heap, columns)
  }

  private materialize(indices: number[], columns: number): TableFileWindow {
    return {
      rows: indices.map((sourceIndex) => ({
        row: this.table.rows[sourceIndex] ?? [],
        sourceIndex,
      })),
      columns,
    }
  }
}
