import { describe, expect, it } from 'vitest'
import {
  SILENCE_ELAPSED_AFTER_MS,
  SILENCE_HINT_AFTER_MS,
  sessionAgeMs,
  startupOverlay,
} from './startup-overlay'

// ---------------------------------------------------------------------------
// The two waits behind one blank terminal (POD-385). Before this, the panel had
// a single boot state dropped on the attach, so a child that had printed
// nothing yet — a CLI self-updating on launch went four minutes silent —
// showed exactly what a dead session shows.
// ---------------------------------------------------------------------------

const overlayOf = (over: { ready?: boolean; outputSeen?: boolean; ageMs?: number | null }) =>
  startupOverlay({
    ready: over.ready ?? true,
    outputSeen: over.outputSeen ?? false,
    ageMs: over.ageMs === undefined ? 0 : over.ageMs,
  })

describe('startupOverlay', () => {
  it('waits on the attach before it says anything about output', () => {
    expect(overlayOf({ ready: false, outputSeen: true })).toEqual({ kind: 'starting' })
    expect(overlayOf({ ready: false, outputSeen: false, ageMs: 60_000 })).toEqual({
      kind: 'starting',
    })
  })

  it('gets out of the way the moment the PTY has spoken', () => {
    expect(overlayOf({ outputSeen: true })).toEqual({ kind: 'hidden' })
    // Even a session that has been quiet for hours: output landed at SOME point,
    // so what the panel is missing is a screen, not a sign of life (POD-379).
    expect(overlayOf({ outputSeen: true, ageMs: 4 * 3_600_000 })).toEqual({ kind: 'hidden' })
  })

  it('holds a plain Starting… through a normal launch', () => {
    // A healthy CLI paints within a few hundred ms. Showing a counter there and
    // retracting it a tick later reads as a glitch, so the first seconds look
    // exactly as they did before.
    expect(overlayOf({ ageMs: SILENCE_ELAPSED_AFTER_MS - 1 })).toEqual({
      kind: 'silent',
      elapsedMs: null,
      hint: false,
    })
  })

  it('counts the silence once the wait outlasts every healthy start', () => {
    expect(overlayOf({ ageMs: SILENCE_ELAPSED_AFTER_MS })).toEqual({
      kind: 'silent',
      elapsedMs: SILENCE_ELAPSED_AFTER_MS,
      hint: false,
    })
  })

  it('explains a wait that has gone on long enough to look broken', () => {
    expect(overlayOf({ ageMs: SILENCE_HINT_AFTER_MS })).toMatchObject({ hint: true })
    expect(overlayOf({ ageMs: 4 * 60_000 })).toEqual({
      kind: 'silent',
      elapsedMs: 4 * 60_000,
      hint: true,
    })
  })

  it('still shows the wait when the session row has not landed yet', () => {
    // An optimistic spawn has no createdAt to date the silence by; the panel
    // says it is waiting without inventing a number.
    expect(overlayOf({ ageMs: null })).toEqual({ kind: 'silent', elapsedMs: null, hint: false })
  })
})

describe('sessionAgeMs', () => {
  it('measures from the session row', () => {
    expect(sessionAgeMs('2026-08-04T17:16:49.000Z', Date.parse('2026-08-04T17:20:43.000Z'))).toBe(
      234_000,
    )
  })

  it('never reports a negative wait', () => {
    // createdAt is the SERVER's clock; a browser sitting behind it must not
    // render a countdown.
    expect(sessionAgeMs('2026-08-04T17:16:49.000Z', Date.parse('2026-08-04T17:16:40.000Z'))).toBe(0)
  })

  it('is unknown without a parsable timestamp', () => {
    expect(sessionAgeMs(undefined, 0)).toBeNull()
    expect(sessionAgeMs('not a date', 0)).toBeNull()
  })
})
