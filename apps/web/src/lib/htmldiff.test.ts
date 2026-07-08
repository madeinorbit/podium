import { describe, expect, it } from 'vitest'
import { diffHtml } from './htmldiff'

describe('diffHtml', () => {
  it('marks word-level changes inside a paragraph', () => {
    const merged = diffHtml('<p>exports are JSON only</p>', '<p>exports are CSV with headers</p>')
    expect(merged).toContain('<p>exports are ')
    expect(merged).toContain('<del>JSON</del>')
    expect(merged).toContain('<ins>CSV</ins>')
    expect(merged).toContain('<del>only</del>')
    expect(merged).toContain('<ins>with headers</ins>')
  })

  it('handles added and removed whole documents', () => {
    expect(diffHtml(null, '<p>new</p>')).toBe('<ins><p>new</p></ins>')
    expect(diffHtml('<p>old</p>', null)).toBe('<del><p>old</p></del>')
    expect(diffHtml(null, null)).toBe('')
  })

  it('keeps list structure when items are added', () => {
    const merged = diffHtml('<ul><li>a</li></ul>', '<ul><li>a</li><li>b</li></ul>')
    expect(merged).toContain('<li>a</li>')
    expect(merged).toContain('<ins>')
    expect(merged).toContain('b')
    // unchanged tokens are not wrapped
    expect(merged.indexOf('<ins>')).toBeGreaterThan(merged.indexOf('<li>a</li>'))
  })

  it('returns identical html unchanged', () => {
    const html = '<p>same <strong>thing</strong></p>'
    expect(diffHtml(html, html)).toBe(html)
  })
})
