import { describe, expect, it } from 'vitest'
import { parseMarkdown, safeExternalUrl, splitPodiumRefs } from './markdown'

describe('parseMarkdown', () => {
  it('uses GFM tables and keeps formatted cell tokens', () => {
    const tokens = parseMarkdown('| Name | State |\n| --- | ---: |\n| **Mobile** | ready |')
    const table = tokens.find((token) => token.type === 'table')

    expect(table?.align).toEqual([null, 'right'])
    expect(table?.header?.map((cell) => cell.text)).toEqual(['Name', 'State'])
    expect(table?.rows?.[0]?.[0]?.tokens[0]?.type).toBe('strong')
  })

  it('recognises the desktop Markdown block families', () => {
    const tokens = parseMarkdown(
      '# Heading\n\n> Quote\n\n- one\n- two\n\n~~~ts\nconst ok = true\n~~~',
    )
    expect(tokens.filter((token) => token.type !== 'space').map((token) => token.type)).toEqual([
      'heading',
      'blockquote',
      'list',
      'code',
    ])
  })
})

describe('splitPodiumRefs', () => {
  it('keeps issue references tappable inside ordinary text', () => {
    expect(splitPodiumRefs('See POD-1197 and POD-144.')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'ref', text: 'POD-1197', ref: 'POD-1197', offset: 4 },
      { kind: 'text', text: ' and ' },
      { kind: 'ref', text: 'POD-144', ref: 'POD-144', offset: 17 },
      { kind: 'text', text: '.' },
    ])
  })
})

describe('safeExternalUrl', () => {
  it('allows browser and OS link schemes', () => {
    expect(safeExternalUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeExternalUrl('mailto:operator@example.com')).toBe('mailto:operator@example.com')
  })

  it('rejects script, data, and relative links', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('data:text/html,bad')).toBeNull()
    expect(safeExternalUrl('../secret')).toBeNull()
  })
})
