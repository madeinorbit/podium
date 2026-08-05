/**
 * The @-mention mechanism's promises, in the terms a person types (POD-412).
 */

import { describe, expect, it } from 'vitest'
import { type AtTrigger, applyMention, readAtTrigger } from './at-mention'

const at = (value: string, caret = value.length) => readAtTrigger(value, caret)

describe('readAtTrigger', () => {
  it('opens on a bare @ at the start of the draft', () => {
    expect(at('@')).toEqual({ at: 0, query: '', caret: 1 })
  })

  it('opens after whitespace and carries what has been typed', () => {
    expect(at('look at @POD-4')).toEqual({ at: 8, query: 'POD-4', caret: 14 })
  })

  it('opens on a newline, not just a space', () => {
    expect(at('first line\n@src')).toMatchObject({ query: 'src' })
  })

  it('stays closed mid-word — user@host and an email are not mentions', () => {
    expect(at('mail me at tim@example.com')).toBeNull()
    expect(at('tim@')).toBeNull()
  })

  it('closes once the mention is followed by a space', () => {
    expect(at('@POD-412 and then')).toBeNull()
  })

  it('reads the mention under the CARET, not the one at the end', () => {
    // Caret sits just after `@fi`, with more text to its right.
    expect(at('see @fi later', 7)).toEqual({ at: 4, query: 'fi', caret: 7 })
  })

  it('accepts the characters paths and refs are made of', () => {
    expect(at('@apps/web/src/lib.ts')).toMatchObject({ query: 'apps/web/src/lib.ts' })
  })
})

/** The trigger at `caret`, asserting there is one — every case below is about
 *  what happens to an OPEN mention. */
function triggerIn(value: string, caret = value.length): AtTrigger {
  const trigger = readAtTrigger(value, caret)
  if (!trigger) throw new Error(`no mention open in ${JSON.stringify(value)} at ${caret}`)
  return trigger
}

describe('applyMention', () => {
  it('replaces the whole mention and reports where the caret belongs', () => {
    expect(applyMention('look at @POD-4', triggerIn('look at @POD-4'), 'POD-412')).toEqual({
      value: 'look at POD-412 ',
      caret: 16,
    })
  })

  it('keeps the text to the right of the caret and lands the caret before it', () => {
    const value = 'see @fi later'
    const next = applyMention(value, triggerIn(value, 7), '`src/file.ts`')
    expect(next.value).toBe('see `src/file.ts` later')
    // Caret sits at the end of what was inserted — the space in front of
    // 'later' was already in the draft and is not consumed by the insertion.
    expect(next.value.slice(0, next.caret)).toBe('see `src/file.ts`')
  })

  it('does not double a space that is already there', () => {
    const value = '@fi rest'
    expect(applyMention(value, triggerIn(value, 3), 'X').value).toBe('X rest')
  })
})
