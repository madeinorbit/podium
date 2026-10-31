import { describe, expect, it } from 'vitest'
import type { Quote } from './quote-sinks'
import {
  findTokens,
  healTokens,
  placeToken,
  quoteLabel,
  serializeDraft,
  tokenAfter,
  tokenAround,
  tokenBefore,
  uniqueLabel,
} from './quote-tokens'

// INLINE QUOTE TOKENS (POD-2207). What this pins: what a token looks like,
// where one lands, that edits treat it as one thing, and the wire format the
// agent reads.

const NB = '\u00A0'
const quote = (text: string, source: string): Quote => ({
  id: text,
  text,
  source,
  label: quoteLabel(text),
})

describe('quoteLabel', () => {
  it('is the passage head on one unbreakable line', () => {
    expect(quoteLabel('die Bitte,\n  s')).toBe(`${NB}❝die${NB}Bitte,${NB}s❞${NB}`)
  })

  it('cuts a long passage with an ellipsis', () => {
    const label = quoteLabel('Ich habe dir ein Dokument geschickt, bitte lies es')
    expect(label.endsWith(`…❞${NB}`)).toBe(true)
    expect(label.length).toBeLessThan(30)
  })

  it('tells apart two passages that start alike', () => {
    const first = quote('same opening words here, then one thing', 'a')
    const other = { text: 'same opening words here, then another', source: 'a' }
    expect(uniqueLabel(other, [first])).not.toBe(first.label)
    expect(uniqueLabel(first, [first])).toBe(first.label)
  })

  it('tells apart one passage quoted from two places', () => {
    const first = quote('return null', '/r/a.ts:3')
    expect(uniqueLabel({ text: 'return null', source: '/r/b.ts:9' }, [first])).not.toBe(first.label)
  })

  it('never reuses the label of an orphan in the draft', () => {
    const label = quoteLabel('foo bar')
    expect(uniqueLabel({ text: 'foo bar', source: 's' }, [], new Set([label]))).not.toBe(label)
  })
})

describe('placeToken', () => {
  const label = quoteLabel('q')

  it('starts its own line after words at the end of a line', () => {
    expect(placeToken('see this', 8, 8, label)).toEqual({
      insert: `\n${label} `,
      caret: 8 + label.length + 2,
    })
  })

  it('stays where the caret put it mid-sentence', () => {
    expect(placeToken('compare  with', 8, 8, label).insert).toBe(label)
  })

  it('needs no new line in an empty box', () => {
    expect(placeToken('', 0, 0, label).insert).toBe(`${label} `)
  })
})

describe('token edits', () => {
  const label = quoteLabel('q')
  const value = `a ${label} b`
  const start = 2
  const end = 2 + label.length

  it('finds the token and the caret positions inside it', () => {
    expect(findTokens(value)).toEqual([{ start, end, label }])
    expect(tokenAround(value, start)).toBeNull()
    expect(tokenAround(value, start + 2)?.start).toBe(start)
  })

  it('takes the token whole from either side', () => {
    expect(tokenBefore(value, end)?.start).toBe(start)
    expect(tokenBefore(value, start)).toBeNull()
    expect(tokenAfter(value, start)?.end).toBe(end)
    expect(tokenAfter(value, end)).toBeNull()
  })

  it('heals a delete that cut into a token', () => {
    const cut = value.slice(0, end - 1) + value.slice(end)
    expect(healTokens(value, cut)).toEqual({ value: 'a  b', caret: start })
  })

  it('leaves edits outside tokens alone', () => {
    expect(healTokens(value, value.slice(0, -1))).toBeNull()
    expect(healTokens(value, `${value}x`)).toBeNull()
  })
})

describe('serializeDraft', () => {
  it('puts each passage in place, before what was said about it', () => {
    const a = quote('a\n\nb', '/r/doc.md:6-8')
    const b = quote('two', 'your reply, 10:04')
    const draft = `${a.label} cut this\n${b.label} and this `
    expect(serializeDraft(draft, [a, b])).toBe(
      '> a\n>\n> b\n> — /r/doc.md:6-8\n\ncut this\n\n> two\n> — your reply, 10:04\n\nand this',
    )
  })

  it('keeps the words ahead of a quote', () => {
    const a = quote('x', 's')
    expect(serializeDraft(`look:\n${a.label} `, [a])).toBe('look:\n\n> x\n> — s')
  })

  it('sends an orphan as the words it shows', () => {
    expect(serializeDraft(`see ${quoteLabel('gone passage')} please`, [])).toBe(
      'see “gone passage” please',
    )
  })

  it('leaves a draft without tokens as typed, trimmed', () => {
    expect(serializeDraft('  hi  ', [])).toBe('hi')
  })
})
