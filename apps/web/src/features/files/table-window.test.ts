import { describe, expect, it } from 'vitest'
import { tableRenderWindow } from './table-window'

describe('tableRenderWindow', () => {
  it('caps ordinary tables at 500 rows', () => {
    expect(tableRenderWindow(2_000, 4)).toEqual({ rows: 500, columns: 4 })
  })

  it('caps wide tables by both columns and total cells', () => {
    expect(tableRenderWindow(2_000, 200)).toEqual({ rows: 100, columns: 50 })
  })

  it('handles empty documents', () => {
    expect(tableRenderWindow(0, 0)).toEqual({ rows: 0, columns: 0 })
  })
})
