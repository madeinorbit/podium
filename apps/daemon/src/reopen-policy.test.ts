/**
 * MODE-AWARE REOPEN — the four policy cases (POD-3918 P1b).
 *
 * The brief's THE POLICY, STATED PRECISELY is the contract; reconstitution
 * and repaint are NOT interchangeable:
 *
 * - Alternate, SAME size as the model: serialise the headless model and send
 *   that as the first frame, then go live. No replay of stale bytes.
 * - Alternate, DIFFERENT size: a model cannot produce a correct screen at a
 *   size the program never drew. Send the size FIRST, let the program
 *   repaint, and use the model serialisation only as a placeholder until the
 *   first repaint frame arrives.
 * - Normal: replay the bytes into a model sized as they were PRODUCED, then
 *   resize the model to the viewer's size so the emulator reflows.
 * - Daemon restart: the model is gone and is rebuilt from the host ring,
 *   which carries no size history — approximate by construction (POD-3925).
 */

import { describe, expect, it } from 'vitest'
import {
  decideReopenScreen,
  type ReopenInputs,
} from './reopen-policy'

const same = (over: Partial<ReopenInputs> = {}): ReopenInputs => ({
  mode: 'alternate',
  modelSize: { cols: 80, rows: 24 },
  viewerSize: { cols: 80, rows: 24 },
  modelAlive: true,
  ringReplayable: false,
  replayRequired: true,
  ...over,
})

describe('decideReopenScreen', () => {
  it('alternate at the SAME size reconstitutes from the model with no stale replay', () => {
    expect(decideReopenScreen(same())).toEqual({ kind: 'snapshot-then-live' })
  })

  it('alternate at a DIFFERENT size sends the size first and repaints, model as placeholder', () => {
    expect(decideReopenScreen(same({ viewerSize: { cols: 40, rows: 24 } }))).toEqual({
      kind: 'resize-repaint-with-placeholder',
    })
  })

  it('alternate with an unknown model size resizes first rather than trusting the model', () => {
    expect(decideReopenScreen(same({ modelSize: undefined }))).toEqual({
      kind: 'resize-repaint-with-placeholder',
    })
  })

  it('normal with no replay debt just repaints: the server bytes are the history', () => {
    expect(
      decideReopenScreen(same({ mode: 'normal', replayRequired: false })),
    ).toEqual({ kind: 'repaint-only' })
  })

  it('normal with replay debt and a ring replays the ring (restart-approximate until POD-3925)', () => {
    expect(
      decideReopenScreen(
        same({ mode: 'normal', ringReplayable: true, modelAlive: false }),
      ),
    ).toEqual({ kind: 'ring-replay' })
  })

  it('normal with replay debt and no ring can only repaint', () => {
    expect(decideReopenScreen(same({ mode: 'normal' }))).toEqual({ kind: 'repaint-only' })
  })

  it('alternate after a restart (model gone) repaints at the agreed size: approximate', () => {
    expect(
      decideReopenScreen(same({ modelAlive: false, viewerSize: { cols: 40, rows: 24 } })),
    ).toEqual({ kind: 'resize-repaint' })
    expect(decideReopenScreen(same({ modelAlive: false }))).toEqual({ kind: 'repaint' })
  })

  it('alternate never chooses the ring replay, however deep the debt', () => {
    expect(
      decideReopenScreen(same({ ringReplayable: true, viewerSize: { cols: 40, rows: 24 } })),
    ).not.toMatchObject({ kind: 'ring-replay' })
  })
})
