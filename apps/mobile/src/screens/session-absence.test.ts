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
import { SESSION_ABSENCE, sessionAbsence } from './session-absence'

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
    expect(`${absence.title} ${absence.body}`).not.toMatch(/delet|remov|access/i)
  })

  it('PRESENCE WINS over a stale exit record — a re-granted session is here again', () => {
    // Order matters: a row that was evicted and later re-shared is present, and
    // its leftover exit record must not make it read as invisible.
    expect(sessionAbsence(ID, PRESENT, () => 'evicted')).toBe(SESSION_ABSENCE.present)
  })

  it('every state has copy — a missing row would render an empty screen', () => {
    for (const state of ['present', 'not-visible', 'removed', 'pending'] as const) {
      expect(SESSION_ABSENCE[state].title.length).toBeGreaterThan(0)
    }
  })
})
