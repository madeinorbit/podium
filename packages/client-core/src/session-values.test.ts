import { asSessionId, isSnoozed, returnedFromSnooze } from '@podium/model'
import { resolveSessionIdentifier } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { sessionValues, sessionView, sessionViews, type SessionHomes } from './session-values'

const active = '2026-10-01T12:00:00.000Z'
const earlier = '2026-10-01T11:00:00.000Z'
const later = '2026-10-01T13:00:00.000Z'
const legacy = {
  sessionId: asSessionId('s1'),
  lastActiveAt: active,
  machineId: 'm1',
  agentKind: 'codex',
  refRepoId: 'r1',
  refSeq: 42,
  refLetter: 'B',
  handoffTargetMachineId: 'm2',
  readAt: earlier,
  unread: true,
  snoozedUntil: null,
  displayRef: 'OLD-42-B',
  machineName: 'Old source',
  condition: 'logged-out' as const,
  handoffTarget: 'Old destination',
}
const homes: SessionHomes = {
  userState: { readAt: active },
  repo: { prefix: 'NEW' },
  machine: { name: 'Source', loggedOutHarnesses: [] },
  handoffMachine: { name: 'Destination' },
}

describe('session values from their new homes', () => {
  it('prefers present rows including cleared cells over stale legacy fields', () => {
    expect(sessionValues(legacy, homes)).toEqual({
      readAt: active,
      unread: false,
      snoozedUntil: undefined,
      displayRef: 'NEW-42-B',
      machineName: 'Source',
      condition: undefined,
      handoffTarget: 'Destination',
    })
    expect(
      sessionValues(legacy, {
        ...homes,
        repo: { prefix: null },
        machine: { name: '', loggedOutHarnesses: [] },
        handoffMachine: { name: '' },
      }),
    ).toMatchObject({ displayRef: undefined, machineName: '', handoffTarget: '' })
  })
  it('derives unread strictly after the cursor, with null meaning unread', () => {
    expect(sessionValues(legacy, { userState: { readAt: earlier } }).unread).toBe(true)
    expect(sessionValues(legacy, { userState: { readAt: active } }).unread).toBe(false)
    expect(sessionValues(legacy, { userState: { readAt: later } }).unread).toBe(false)
    expect(
      sessionValues({ ...legacy, unread: false }, { userState: { readAt: null } }).unread,
    ).toBe(true)
  })
  it('falls back independently only while each companion is missing', () => {
    expect(sessionValues(legacy)).toEqual({
      readAt: earlier,
      unread: true,
      snoozedUntil: null,
      displayRef: 'OLD-42-B',
      machineName: 'Old source',
      condition: 'logged-out',
      handoffTarget: 'Old destination',
    })
    expect(sessionView(legacy)).toBe(legacy)
    const partial = sessionValues(legacy, { machine: homes.machine })
    expect(partial).toMatchObject({
      readAt: earlier,
      unread: true,
      snoozedUntil: null,
      displayRef: 'OLD-42-B',
      machineName: 'Source',
      condition: undefined,
      handoffTarget: 'Old destination',
    })
  })
  it('resolves permanent birth and draft refs by repo id without the birth issue', () => {
    const born = sessionView(legacy, homes)
    expect(resolveSessionIdentifier('NEW-42-B', [born])).toBe(born)
    expect(resolveSessionIdentifier('OLD-42-B', [born])).toBeUndefined()
    expect(resolveSessionIdentifier('s1', [born])).toBe(born)
    expect(
      sessionValues({ ...legacy, refSeq: undefined, refLetter: undefined, refDraft: 3 }, homes)
        .displayRef,
    ).toBe('NEW-DRAFT-3')
  })
  it('uses only this harness login state and the target machine name', () => {
    expect(
      sessionValues(legacy, { machine: { name: 'Source', loggedOutHarnesses: ['claude-code'] } })
        .condition,
    ).toBeUndefined()
    expect(
      sessionValues(legacy, { machine: { name: 'Source', loggedOutHarnesses: ['codex'] } })
        .condition,
    ).toBe('logged-out')
  })
  it('feeds the shared snooze predicates including returned timed snoozes', () => {
    const now = Date.parse(active)
    expect(isSnoozed(sessionView(legacy, homes), now)).toBe(false)
    expect(
      isSnoozed(sessionView(legacy, { userState: { readAt: active, snoozedUntil: null } }), now),
    ).toBe(true)
    expect(
      isSnoozed(sessionView(legacy, { userState: { readAt: active, snoozedUntil: later } }), now),
    ).toBe(true)
    expect(
      returnedFromSnooze(
        sessionView(legacy, { userState: { readAt: active, snoozedUntil: earlier } }),
        now,
      ),
    ).toBe(true)
  })
  it('keeps borrowed identity stable, leaves wire facts unchanged and ignores another principal', () => {
    expect(sessionView(legacy, homes)).toBe(sessionView(legacy, homes))
    expect(
      sessionViews([legacy], {
        userId: 'b',
        userStates: [{ userId: 'a', sessionId: 's1', readAt: active }],
        repos: [],
        machines: [],
      })[0],
    ).toBe(legacy)
    expect(legacy.displayRef).toBe('OLD-42-B')
    expect(legacy.snoozedUntil).toBeNull()
    const changed = sessionView(legacy, { ...homes, repo: { prefix: 'RENAMED' } })
    expect(changed.displayRef).toBe('RENAMED-42-B')
    expect(changed).not.toBe(sessionView(legacy, homes))
    expect({ ...changed }).toMatchObject({
      displayRef: 'RENAMED-42-B',
      unread: false,
      condition: undefined,
    })
  })
  it('borrows frozen cached rows without allowing writes through the view', () => {
    const raw = Object.freeze({ ...legacy })
    const view = sessionView(raw, homes)
    expect(view.displayRef).toBe('NEW-42-B')
    expect(() => Reflect.set(view, 'displayRef', 'CHANGED')).toThrow(/read-only/)
    expect(raw.displayRef).toBe('OLD-42-B')
  })

})
