/**
 * HOW A REOPENING VIEWER IS REPAINTED (POD-3918 P1b, rewritten by POD-4723).
 *
 * A reopen never touches the program (design rev 3, "Repaint"): every
 * decision names something the daemon already holds — the headless model's
 * snapshot or the host ring — and none of them is a resize or a SIGWINCH.
 */

import { describe, expect, it } from 'vitest'
import { decideReopenScreen, type ReopenInputs } from './reopen-policy'

const inputs = (over: Partial<ReopenInputs> = {}): ReopenInputs => ({
  mode: 'alternate',
  modelAlive: true,
  ringReplayable: false,
  replayRequired: true,
  ...over,
})

describe('decideReopenScreen', () => {
  it('alternate with a live model reconstitutes from the model, debt or not', () => {
    expect(decideReopenScreen(inputs())).toEqual({ kind: 'snapshot' })
    expect(decideReopenScreen(inputs({ replayRequired: false }))).toEqual({ kind: 'snapshot' })
  })

  it('alternate never chooses the ring replay, however deep the debt', () => {
    expect(decideReopenScreen(inputs({ ringReplayable: true }))).toEqual({ kind: 'snapshot' })
    expect(decideReopenScreen(inputs({ ringReplayable: true, modelAlive: false }))).toEqual({
      kind: 'none',
    })
  })

  it('normal with no replay debt sends nothing: the server bytes are the history', () => {
    expect(decideReopenScreen(inputs({ mode: 'normal', replayRequired: false }))).toEqual({
      kind: 'none',
    })
  })

  it('normal with replay debt and a ring replays the ring (restart-approximate until POD-3925)', () => {
    expect(
      decideReopenScreen(inputs({ mode: 'normal', ringReplayable: true, modelAlive: false })),
    ).toEqual({ kind: 'ring-replay' })
  })

  it('normal with replay debt and no ring falls back to the live model, else nothing', () => {
    expect(decideReopenScreen(inputs({ mode: 'normal' }))).toEqual({ kind: 'snapshot' })
    expect(decideReopenScreen(inputs({ mode: 'normal', modelAlive: false }))).toEqual({
      kind: 'none',
    })
  })
})
