import { describe, expect, it } from 'vitest'
import { parseDelimitedDocument } from './delimited-document'

describe('parseDelimitedDocument', () => {
  it('reads headers and ragged rows without inventing a trailing row', () => {
    expect(parseDelimitedDocument('name,count\nalpha,10\nbeta\n', ',')).toEqual({
      headers: ['name', 'count'],
      rows: [
        ['alpha', '10'],
        ['beta', ''],
      ],
      columnCount: 2,
      truncated: false,
    })
  })

  it('keeps quoted separators, newlines, and escaped quotes in their cells', () => {
    expect(
      parseDelimitedDocument('name,note\r\n"A, B","line 1\nline 2"\r\nC,"say ""hi"""', ','),
    ).toEqual({
      headers: ['name', 'note'],
      rows: [
        ['A, B', 'line 1\nline 2'],
        ['C', 'say "hi"'],
      ],
      columnCount: 2,
      truncated: false,
    })
  })

  it('parses tab-delimited data and names blank headers', () => {
    expect(parseDelimitedDocument('\tvalue\nfirst\t1', '\t')).toEqual({
      headers: ['Column 1', 'value'],
      rows: [['first', '1']],
      columnCount: 2,
      truncated: false,
    })
  })

  it('does not leak a UTF-8 byte-order mark into the first header', () => {
    expect(parseDelimitedDocument('\ufeffname,count\na,1', ',').headers).toEqual(['name', 'count'])
  })

  it('caps newline-heavy documents before they allocate an array per source row', () => {
    const result = parseDelimitedDocument(`name\n${'\n'.repeat(20_000)}`, ',')

    expect(result.truncated).toBe(true)
    expect(result.rows).toHaveLength(5_000)
  })

  it('caps very wide documents before materializing unbounded cells', () => {
    const result = parseDelimitedDocument(
      Array.from({ length: 500 }, (_, i) => `c${i}`).join(','),
      ',',
    )

    expect(result.truncated).toBe(true)
    expect(result.columnCount).toBe(200)
  })

  it('keeps the data rows of a document whose rows are wider than the column cap', () => {
    const wide = (prefix: string) =>
      Array.from({ length: 250 }, (_, i) => `${prefix}${i}`).join(',')
    const result = parseDelimitedDocument(`${wide('c')}\n${wide('a')}\n${wide('b')}\n`, ',')

    // The overflow costs the RIGHT-HAND COLUMNS of each row, never the rows below it.
    expect(result.truncated).toBe(true)
    expect(result.columnCount).toBe(200)
    expect(result.rows).toHaveLength(2)
    expect(result.headers[0]).toBe('c0')
    expect(result.rows[0]?.[0]).toBe('a0')
    expect(result.rows[0]?.[199]).toBe('a199')
    expect(result.rows[1]?.[0]).toBe('b0')
  })

  it('resumes on the next row when a quoted cell overflows the column cap', () => {
    const wide = Array.from({ length: 250 }, (_, i) => `"c,${i}"`).join(',')
    const result = parseDelimitedDocument(`${wide}\nkeep,me\n`, ',')

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.[0]).toBe('keep')
    expect(result.rows[0]?.[1]).toBe('me')
  })

  it('reads a header-only document as zero rows rather than a truncated parse', () => {
    expect(parseDelimitedDocument('name,count\n', ',')).toEqual({
      headers: ['name', 'count'],
      rows: [],
      columnCount: 2,
      truncated: false,
    })
  })
})
