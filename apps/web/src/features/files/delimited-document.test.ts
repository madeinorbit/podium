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
    })
  })

  it('parses tab-delimited data and names blank headers', () => {
    expect(parseDelimitedDocument('\tvalue\nfirst\t1', '\t')).toEqual({
      headers: ['Column 1', 'value'],
      rows: [['first', '1']],
      columnCount: 2,
    })
  })

  it('does not leak a UTF-8 byte-order mark into the first header', () => {
    expect(parseDelimitedDocument('\ufeffname,count\na,1', ',').headers).toEqual(['name', 'count'])
  })
})
