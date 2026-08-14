/**
 * THE TERMINAL FAMILY'S APP-INDEPENDENT HALF (POD-1761 W3).
 *
 * These are the pieces a second terminal host would take unchanged — the
 * exemption table, the capability declaration, the envelope assembly — so they
 * are tested here rather than through the daemon that happens to be their first
 * consumer. The daemon's own suites prove the composition; this proves the parts
 * mean what they say on their own.
 */

import { describe, expect, it } from 'vitest'
import { PERMITTED_FAILURES } from '../../permitted-failures.js'
import {
  cursorSeq,
  driverLocalCursor,
  isDriverLocalCursor,
  SUBMIT_CR_DELAY_MS,
  SUBMIT_MAX_RETRIES,
  SUBMIT_VERIFY_DELAY_MS,
  stampRuntimeEvent,
  TERMINAL_EXEMPTION_NAMES,
  TERMINAL_PERMITTED_FAILURES,
  terminalCapabilities,
  VERIFICATION_WINDOW_MS,
} from './index.js'

const PROFILE = {
  driverId: 'claude-pty',
  sendProof: ['hook', 'transcript-echo'],
  interactionsFromHooks: true,
  draftReadable: true,
  reportsContextPercent: true,
  archivable: true,
} as const

describe('the exemption table', () => {
  it('is the spec’s three, derived rather than retyped', () => {
    expect([...TERMINAL_PERMITTED_FAILURES]).toEqual([...TERMINAL_EXEMPTION_NAMES])
    // The derivation is the point: widening the family row is the edit that has
    // to be made, in the file whose header calls it a high-bar decision.
    expect(TERMINAL_PERMITTED_FAILURES).toBe(PERMITTED_FAILURES.terminal)
  })

  it('does NOT claim the embedded family’s exemption', () => {
    // `no-attach` is what an embedded driver declares because it hosts the loop
    // in a worker and there is nothing to attach to. A terminal session's engine
    // terminal is exactly the thing it has.
    expect(TERMINAL_PERMITTED_FAILURES).not.toContain('no-attach')
  })
})

describe('the injection constants', () => {
  it('carries the shipped values over verbatim', () => {
    // Each one is a measured fact about a shipped CLI's key parser or startup
    // settle. Re-deriving them from first principles is how a working stack
    // quietly stops working, so they are pinned as identity against `inbox.ts`.
    expect(SUBMIT_CR_DELAY_MS).toBe(90)
    expect(SUBMIT_VERIFY_DELAY_MS).toBe(1_600)
    expect(SUBMIT_MAX_RETRIES).toBe(2)
  })

  it('derives the verification window from the retry ladder, one tick longer', () => {
    // Anything shorter would report `unverified` for sends the existing
    // mechanism was still in the middle of rescuing.
    expect(VERIFICATION_WINDOW_MS).toBe(SUBMIT_VERIFY_DELAY_MS * (SUBMIT_MAX_RETRIES + 1))
  })
})

describe('the capability declaration', () => {
  it('claims the family’s weaknesses and no strengths it lacks', () => {
    const caps = terminalCapabilities({ ...PROFILE, sendProof: [...PROFILE.sendProof] })
    expect(caps.send.mayReturnUnverified).toBe(true)
    expect(caps.send.verificationWindowMs).toBe(VERIFICATION_WINDOW_MS)
    // No native steer: a TUI has no way to append into an open turn, so the
    // receipt reports the downgrade instead of the driver pretending.
    expect([...caps.send.native]).toEqual(['when-ready', 'queue', 'interrupt'])
    // No token deltas: a PTY produces bytes, and a `fine` watch built out of
    // frame boundaries would be a fabricated stream.
    expect([...caps.observation.watchLevels]).toEqual(['coarse'])
    expect(caps.placement).toBe('dedicated')
  })

  it('claims at-least-once on BOTH sources, because its ask identity is a phase transition', () => {
    for (const interactionsFromHooks of [true, false]) {
      const caps = terminalCapabilities({
        ...PROFILE,
        sendProof: [...PROFILE.sendProof],
        interactionsFromHooks,
      })
      expect(caps.interactions.supported).toBe(true)
      if (!caps.interactions.supported) return
      expect(caps.interactions.value.source).toBe(
        interactionsFromHooks ? 'hook' : 'screen-classifier',
      )
      // The hook path COULD decline this — a causal hook gives an ask the
      // harness's own identity — but this driver keys asks on the observation's
      // transitionId, which is a phase-transition id: a re-rendered menu mints a
      // second one, and the PermissionRequest/Notification double subscription
      // mints two for a single prompt. Declaring `false` would claim exactly-once
      // and stop consumers deduping. See the capability's own note.
      expect(caps.interactions.value.atLeastOnce).toBe(true)
      // The ANSWER is a separate axis and is emulated on both.
      expect(caps.interactions.value.answerable).toBe('keystroke-emulated')
    }
  })

  it('declines what this phase did not build, with the reason attached', () => {
    const caps = terminalCapabilities({
      ...PROFILE,
      sendProof: [...PROFILE.sendProof],
      archivable: false,
      draftReadable: false,
      reportsContextPercent: false,
    })
    // A consumer degrades against a STATED gap rather than an undefined field —
    // and the reason is what a later item has to argue with.
    expect(caps.archive.supported).toBe(false)
    expect(caps.draft.supported).toBe(false)
    expect(caps.usage.supported).toBe(false)
    expect(caps.configure.supported).toBe(false)
    expect(caps.attach.supported).toBe(true)
  })
})

describe('the causal envelope', () => {
  it('stamps event time and provenance exactly as given', () => {
    const event = stampRuntimeEvent(
      { t: 'state', change: { kind: 'activity' } },
      '2026-01-01T00:00:00.000Z',
      'bootstrap',
      {
        cursor: { segmentId: 'seg', components: { seq: 7 } },
        observerGeneration: 3,
        turnEpoch: 2,
      },
    )
    // There is no fallback to `Date.now()` on purpose: a missing event time is a
    // producer bug, and a default would hide it behind a number that looks right.
    expect(event.at).toBe('2026-01-01T00:00:00.000Z')
    expect(event.provenance).toBe('bootstrap')
    expect(event.observerGeneration).toBe(3)
    expect(event.turnEpoch).toBe(2)
  })

  it('keeps a driver-local cursor unmistakable for a provider position', () => {
    const local = driverLocalCursor('podium-abc', 4)
    expect(isDriverLocalCursor(local)).toBe(true)
    expect(cursorSeq(local)).toBe(4)
    // A consumer comparing this against a real provider cursor sees a different
    // segment and refuses to merge — which is the correct answer, and the one a
    // zero-filled provider cursor would have gotten silently wrong.
    expect(isDriverLocalCursor({ segmentId: 'claude:abc', components: { transcript: 9 } })).toBe(
      false,
    )
  })
})
