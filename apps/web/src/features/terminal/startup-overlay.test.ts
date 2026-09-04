import { describe, expect, it } from 'vitest'
import {
  ATTACH_STALLED_AFTER_MS,
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

const overlayOf = (over: {
  ready?: boolean
  outputSeen?: boolean
  ageMs?: number | null
  attachWaitMs?: number | null
  awaitingMachineMs?: number | null
}) =>
  startupOverlay({
    ready: over.ready ?? true,
    outputSeen: over.outputSeen ?? false,
    ageMs: over.ageMs === undefined ? 0 : over.ageMs,
    attachWaitMs: over.attachWaitMs === undefined ? 0 : over.attachWaitMs,
    // NULL by default: the caller only dates this wait for a reconnecting
    // session whose driver family nobody has stated, which is a narrow tail —
    // every other case in this file is not in it.
    awaitingMachineMs: over.awaitingMachineMs ?? null,
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

  // POD-2290 — `starting` was the one state here with no exit. A spawn that
  // failed before its session row reconciled left it on screen forever: no
  // elapsed line (nothing to date it by), and no view switch to escape through
  // (no row ⇒ nothing known to be chat-capable). A spinner claims progress, so
  // past the point where that can still be true it has to stop.
  describe('an attach that never lands', () => {
    it('holds Starting… while the attach could still be merely slow', () => {
      expect(overlayOf({ ready: false, attachWaitMs: ATTACH_STALLED_AFTER_MS - 1 })).toEqual({
        kind: 'starting',
      })
    })

    it('names the wait once it outlasts every attach that has ever landed', () => {
      expect(overlayOf({ ready: false, attachWaitMs: ATTACH_STALLED_AFTER_MS })).toEqual({
        kind: 'stalled',
        elapsedMs: ATTACH_STALLED_AFTER_MS,
      })
    })

    it('measures the ATTACH, not the session — opening an old session starts a new wait', () => {
      // The session has been running for an hour; this mount has been waiting
      // for a second. Reading the session's age here would declare a perfectly
      // healthy attach stalled before it had a chance to confirm.
      expect(overlayOf({ ready: false, ageMs: 3_600_000, attachWaitMs: 1_000 })).toEqual({
        kind: 'starting',
      })
    })

    it('says nothing about a wait the caller cannot date', () => {
      expect(overlayOf({ ready: false, attachWaitMs: null })).toEqual({ kind: 'starting' })
    })

    it('yields to the machine being away, which explains the attach it is describing', () => {
      // Both clocks past their threshold: "we have not heard from the machine"
      // is the cause and "the attach has not landed" is its symptom.
      expect(
        overlayOf({ ready: false, attachWaitMs: 60_000, awaitingMachineMs: 60_000 }),
      ).toEqual({ kind: 'awaiting-machine', elapsedMs: 60_000 })
    })

    it('is unreachable once the attach confirms, however long it took', () => {
      // `stalled` describes a wait in progress, not a slow one that ended: a
      // terminal that attaches on its 90th second is a working terminal.
      expect(overlayOf({ ready: true, outputSeen: true, attachWaitMs: 90_000 })).toEqual({
        kind: 'hidden',
      })
    })
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

// ---------------------------------------------------------------------------
// POD-2290 ROUND 2 — the seam the reviewer DROVE. A server restart rehydrates
// live rows as `reconnecting`; a headless row that came back with no driver
// family sat on "Starting OpenCode… / no output yet · 4:35 / Still attached —
// some CLIs update themselves…", every clause of which was false. `stalled`
// could not rescue it, because the attach HAD confirmed (the server answers it
// without the daemon), so the wait fell into `silent`, which has no exit.
// ---------------------------------------------------------------------------

describe('a session whose machine has not checked in', () => {
  it('names the machine instead of the harness, once the wait is real', () => {
    // The reviewer's exact screen: ready, no output, minutes elapsed.
    expect(
      overlayOf({ ready: true, outputSeen: false, ageMs: 275_000, awaitingMachineMs: 275_000 }),
    ).toEqual({ kind: 'awaiting-machine', elapsedMs: 275_000 })
  })

  it('holds the ordinary silent wait while the absence could still be a blip', () => {
    // A reconnecting session usually reconnects. Below the threshold this is an
    // ordinary quiet start and must read as one, or every daemon hiccup becomes
    // an alarm.
    expect(
      overlayOf({ ready: true, outputSeen: false, ageMs: 30_000, awaitingMachineMs: 30_000 }),
    ).toMatchObject({ kind: 'silent' })
  })

  it('never fires for the sessions that are not in that window', () => {
    // The caller dates this wait only for a reconnecting row with no known
    // driver family. Everything else passes null and is untouched — which is
    // what keeps every row written since the family became durable, PTY
    // included, on exactly the behaviour it had.
    expect(overlayOf({ ready: true, outputSeen: false, ageMs: 275_000 })).toMatchObject({
      kind: 'silent',
    })
    expect(overlayOf({ ready: false, attachWaitMs: 60_000 })).toMatchObject({ kind: 'stalled' })
  })

  it('does not cover a terminal that has already painted', () => {
    // The last frame is the truest thing on screen; an overlay over it would
    // hide the work the session actually did before its machine went away.
    expect(
      overlayOf({ ready: true, outputSeen: true, awaitingMachineMs: 275_000 }),
    ).toEqual({ kind: 'hidden' })
  })
})
