/**
 * AN ABSENT SESSION NAMES WHY IT IS ABSENT (POD-332, doc §3.1 ¶2).
 *
 * Three of the four states below produced ONE sentence before this issue — "it
 * may have been removed on the server" — so a person whose access had been
 * revoked was told their work was deleted, and a person whose row had not
 * arrived was told the same.
 *
 * WHAT THIS FILE COVERS AND WHAT IT DOES NOT, stated rather than implied: it
 * drives the DECISION, not the render. `SessionScreen` calls exactly this
 * function with the replica's `exitKind`, but mounting the screen pulls a
 * terminal pane into this lane; the render is covered by the Expo-web and
 * device passes (the device half is the human gate).
 */

import type { SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  SESSION_ABSENCE,
  SESSION_LINK_RESOLVING,
  SESSION_NOT_FOUND,
  sessionAbsence,
  sessionAbsenceShowsLoader,
  sessionLinkAbsence,
} from './session-absence'

const ID = asSessionId('sess-1')
const NO_EXIT = () => undefined
const PRESENT = { sessionId: ID } as unknown as SessionMeta

describe('why a session is not on screen', () => {
  it('EVICTED says no access, and says nothing about deletion', () => {
    const absence = sessionAbsence(ID, undefined, () => 'evicted')
    expect(absence).toBe(SESSION_ABSENCE['not-visible'])
    expect(`${absence.title} ${absence.body}`).toMatch(/access/i)
    expect(`${absence.title} ${absence.body}`).not.toMatch(/delet|remov/i)
  })

  it('REMOVED says deleted — the distinction holds in both directions', () => {
    const absence = sessionAbsence(ID, undefined, () => 'removed')
    expect(absence).toBe(SESSION_ABSENCE.removed)
    expect(`${absence.title} ${absence.body}`).not.toMatch(/access/i)
  })

  it('NO EXIT RECORD is pending — not-here-YET, never "gone"', () => {
    // The replica's `exitKind` is optional by contract: a correct read model may
    // keep no exit record at all. Absent must not be read as "still here" or as
    // "deleted", and this is the state the phone is in today, since the kernel
    // facade does not yet project exits.
    const absence = sessionAbsence(ID, undefined, NO_EXIT)
    expect(absence).toBe(SESSION_ABSENCE.pending)
    expect(absence.state).toBe('pending')
    expect(`${absence.title} ${absence.body}`).not.toMatch(/delet|remov|access/i)
  })

  it('PRESENCE WINS over a stale exit record — a re-granted session is here again', () => {
    // Order matters: a row that was evicted and later re-shared is present, and
    // its leftover exit record must not make it read as invisible.
    expect(sessionAbsence(ID, PRESENT, () => 'evicted')).toBe(SESSION_ABSENCE.present)
  })

  it('loads only while an optimistic session is genuinely arriving', () => {
    expect(sessionAbsenceShowsLoader(SESSION_ABSENCE.pending, true)).toBe(true)
    expect(sessionAbsenceShowsLoader(SESSION_ABSENCE.pending, false)).toBe(false)
    expect(sessionAbsenceShowsLoader(SESSION_ABSENCE.removed, true)).toBe(false)
    expect(sessionAbsenceShowsLoader(SESSION_ABSENCE['not-visible'], true)).toBe(false)
  })

  it('every state has copy — a missing row would render an empty screen', () => {
    for (const state of ['present', 'not-visible', 'removed', 'pending'] as const) {
      expect(SESSION_ABSENCE[state].title.length).toBeGreaterThan(0)
    }
  })
})

describe('what the server said about the link (POD-4637)', () => {
  const pending = SESSION_ABSENCE.pending

  it('a short id being asked about is "opening", never "not here yet"', () => {
    expect(sessionLinkAbsence(pending, { kind: 'resolving' }, true)).toBe(SESSION_LINK_RESOLVING)
  })

  it('a full id being asked about keeps the pending copy — it may be arriving', () => {
    expect(sessionLinkAbsence(pending, { kind: 'resolving' }, false)).toBe(pending)
  })

  it('absent on the server is not found, for short and full ids alike', () => {
    expect(sessionLinkAbsence(pending, { kind: 'absent' }, true)).toBe(SESSION_NOT_FOUND)
    expect(sessionLinkAbsence(pending, { kind: 'absent' }, false)).toBe(SESSION_NOT_FOUND)
  })

  it('ambiguous carries the server message as the body', () => {
    const absence = sessionLinkAbsence(
      pending,
      { kind: 'ambiguous', prefix: '2', candidates: [], message: 'the cli text' },
      true,
    )
    expect(absence.state).toBe('ambiguous')
    expect(absence.body).toBe('the cli text')
  })

  it('a settled replica answer is kept over the server', () => {
    const removed = SESSION_ABSENCE.removed
    expect(sessionLinkAbsence(removed, { kind: 'absent' }, true)).toBe(removed)
  })
})
