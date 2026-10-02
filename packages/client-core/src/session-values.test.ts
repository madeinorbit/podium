import { asSessionId, isSnoozed, returnedFromSnooze } from '@podium/model'
import { resolveSessionIdentifier } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { foldOverlays, foldRowOverlays } from './engine/overlay'
import { type SessionHomes, sessionValues, sessionView, sessionViews } from './session-values'

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
    expect(sessionValues(legacy, { userState: { readAt: null } }).unread).toBe(true)
  })
  it('ignores every stale legacy cell even when all or some companions are absent', () => {
    const empty = {
      readAt: null,
      unread: true,
      snoozedUntil: undefined,
      displayRef: undefined,
      machineName: '',
      condition: undefined,
      handoffTarget: undefined,
    }
    expect(sessionValues(legacy)).toEqual(empty)
    expect({ ...sessionView(legacy) }).toMatchObject(empty)
    expect(sessionView(legacy)).not.toBe(legacy)
    expect(sessionView(legacy)).toBe(sessionView(legacy))
    expect(sessionValues(legacy, { machine: homes.machine })).toEqual({
      ...empty,
      machineName: 'Source',
    })
  })
  it('keeps unread pending until bootstrap completes, while a present personal row is immediately authoritative', () => {
    const loading = sessionView(legacy, { userStatesLoaded: false })
    expect(loading).toMatchObject({ readAt: null, unread: false, displayRef: undefined })
    const ready = sessionView(legacy, { userStatesLoaded: true })
    expect(ready).not.toBe(loading)
    expect(ready).toMatchObject({ readAt: null, unread: true })
    expect(sessionView(loading, { userStatesLoaded: true })).toBe(ready)
    expect(sessionView(legacy, { userStatesLoaded: false, userState: { readAt: null } }).unread).toBe(true)
    expect(sessionView(legacy, { userStatesLoaded: false, userState: { readAt: later } }).unread).toBe(false)
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
    ).toMatchObject({
      readAt: null,
      unread: true,
      snoozedUntil: undefined,
      displayRef: undefined,
      machineName: '',
      condition: undefined,
      handoffTarget: undefined,
    })
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
  it('keeps normalized labels and machine condition when optimism replaces only the personal home', () => {
    const loaded = sessionView(legacy, {
      ...homes,
      machine: { name: 'Source', loggedOutHarnesses: ['codex'] },
    })
    const painted = sessionView(loaded, { userState: { readAt: null, snoozedUntil: later } })
    expect(sessionValues(loaded)).toMatchObject({
      displayRef: 'NEW-42-B',
      machineName: 'Source',
      condition: 'logged-out',
      handoffTarget: 'Destination',
    })
    expect(sessionValues(painted)).toMatchObject({
      unread: true,
      readAt: null,
      snoozedUntil: later,
      displayRef: 'NEW-42-B',
    })
    expect(painted).toMatchObject({
      unread: true,
      readAt: null,
      snoozedUntil: later,
      displayRef: 'NEW-42-B',
      machineName: 'Source',
      condition: 'logged-out',
      handoffTarget: 'Destination',
    })
    expect(sessionView(painted, { userState: homes.userState })).toBe(loaded)
  })
  it('keeps normalized homes through optimistic own-field edits and their rollback', () => {
    const loaded = sessionView(legacy, homes)
    const patch = {
      key: 'rename', entity: 'sessions', id: legacy.sessionId, op: 'patch', patch: { name: 'Pending' }, coveredBy: () => false,
    } as const
    const listPaint = foldOverlays([loaded], [patch], row => row.sessionId).rows[0]!
    const rowPaint = foldRowOverlays(loaded, [patch])!
    for (const painted of [listPaint, rowPaint]) {
      expect(painted).toHaveProperty('name', 'Pending')
      expect(sessionValues(painted)).toEqual(sessionValues(loaded))
      expect(sessionView(painted, { userState: { readAt: null } })).toMatchObject({
        unread: true, displayRef: 'NEW-42-B', machineName: 'Source', handoffTarget: 'Destination',
      })
      // Persisting an old-shaped row drops the in-memory input association.
      expect(sessionValues(JSON.parse(JSON.stringify(painted)))).toMatchObject({
        unread: true, displayRef: undefined, machineName: '', handoffTarget: undefined,
      })
    }
    expect(foldOverlays([loaded], [], row => row.sessionId).rows[0]).toBe(loaded)
  })
  it('borrows frozen cached rows without allowing writes through the view', () => {
    const raw = Object.freeze({ ...legacy })
    const view = sessionView(raw, homes)
    expect(view.displayRef).toBe('NEW-42-B')
    expect(() => Reflect.set(view, 'displayRef', 'CHANGED')).toThrow(/read-only/)
    expect(raw.displayRef).toBe('OLD-42-B')
  })
})
