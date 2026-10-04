import { describe, expect, it } from 'vitest'
import { hasOfferLink, segmentOfferText } from './offer-text'

const links = (message: string) =>
  segmentOfferText(message).filter((s) => s.kind === 'link') as Array<{
    kind: 'link'
    text: string
    href: string
  }>

describe('segmentOfferText', () => {
  it('leaves prose without a URL as one text segment', () => {
    expect(segmentOfferText('Login screen ready to merge')).toEqual([
      { kind: 'text', text: 'Login screen ready to merge' },
    ])
  })

  it('returns nothing for an empty message', () => {
    expect(segmentOfferText('')).toEqual([])
  })

  it('splits a bare URL out of the surrounding prose', () => {
    expect(segmentOfferText('Preview at https://example.com/a now')).toEqual([
      { kind: 'text', text: 'Preview at ' },
      { kind: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
      { kind: 'text', text: ' now' },
    ])
  })

  it('gives a markdown link its label and never re-matches the href', () => {
    expect(segmentOfferText('See [the preview](https://example.com/a).')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'the preview', href: 'https://example.com/a' },
      { kind: 'text', text: '.' },
    ])
  })

  it('keeps sentence punctuation out of the href', () => {
    // The period is far more often the writer's than the URL's.
    expect(links('Deployed to https://example.com/a.')[0]).toEqual({
      kind: 'link',
      text: 'https://example.com/a',
      href: 'https://example.com/a',
    })
    expect(links('Try https://example.com/a, then https://example.com/b!')).toEqual([
      { kind: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
      { kind: 'link', text: 'https://example.com/b', href: 'https://example.com/b' },
    ])
  })

  it('drops an unbalanced closing bracket but keeps a balanced one', () => {
    expect(links('(see https://example.com/a)')[0]?.href).toBe('https://example.com/a')
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')[0]?.href).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    )
  })

  it('never produces a non-http scheme', () => {
    const message = 'Run javascript:alert(1) or open data:text/html,x or mail a@b.com'
    expect(links(message)).toEqual([])
    expect(segmentOfferText(message)).toEqual([{ kind: 'text', text: message }])
  })

  it('does not link a bare scheme with nothing after it', () => {
    expect(links('the https:// prefix')).toEqual([])
  })

  it('spans line breaks without joining them into the href', () => {
    expect(segmentOfferText('done\nhttps://example.com/a\nnext')).toEqual([
      { kind: 'text', text: 'done\n' },
      { kind: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
      { kind: 'text', text: '\nnext' },
    ])
  })

  it('is reentrant — the shared regex does not carry lastIndex between calls', () => {
    const message = 'a https://example.com/a b https://example.com/b'
    expect(segmentOfferText(message)).toEqual(segmentOfferText(message))
  })
})

describe('hasOfferLink', () => {
  it('reports whether the renderers would make anything clickable', () => {
    expect(hasOfferLink('no links here')).toBe(false)
    expect(hasOfferLink('open https://example.com')).toBe(true)
    expect(hasOfferLink('open [it](https://example.com)')).toBe(true)
  })
})
