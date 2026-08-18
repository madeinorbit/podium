import { describe, expect, it } from 'vitest'
import { dropEchoedPendingTurns } from './pending-turns'

describe('dropEchoedPendingTurns', () => {
  it('retires a prose turn once the transcript carries the same words', () => {
    const left = dropEchoedPendingTurns([{ text: 'ship it' }], [{ text: '  ship it  ' }])
    expect(left).toEqual([])
  })

  it('keeps a turn the transcript has not echoed yet', () => {
    const left = dropEchoedPendingTurns([{ text: 'ship it' }], [{ text: 'something else' }])
    expect(left).toHaveLength(1)
  })

  it('retires an attachment turn by its PATHS — the echoed text no longer contains them', () => {
    // The server lifts the paths out of the prompt and onto `toolPaths`, so
    // text equality can never match; this is the case that used to leave the
    // bubble saying "sending…" under a transcript that had already answered.
    const left = dropEchoedPendingTurns(
      [{ text: 'what is this?', files: [{ path: '/uploads/s1/shot.png' }] }],
      [{ text: 'what is this?', toolPaths: ['/uploads/s1/shot.png'] }],
    )
    expect(left).toEqual([])
  })

  it('does not match an attachment turn against a different upload', () => {
    const left = dropEchoedPendingTurns(
      [{ text: 'look', files: [{ path: '/uploads/s1/a.png' }] }],
      [{ text: 'look', toolPaths: ['/uploads/s1/b.png'] }],
    )
    expect(left).toHaveLength(1)
  })

  it('consumes echoes FIFO, so two identical prompts retire two bubbles', () => {
    const left = dropEchoedPendingTurns([{ text: 'again' }, { text: 'again' }], [{ text: 'again' }])
    expect(left).toHaveLength(1)
  })

  it('leaves an empty pending list alone', () => {
    expect(dropEchoedPendingTurns([], [{ text: 'anything' }])).toEqual([])
  })
})
