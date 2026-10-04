import { asSessionId, isSnoozed, returnedFromSnooze } from '@podium/model'
import { resolveSessionIdentifier } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {  foldRowOverlays } from './engine/overlay'
import { type SessionHomes, inheritSessionHomes, sessionValues, sessionView, sessionViews } from './session-values'

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
  it('memoizes by the row and each home, rather than the homes wrapper', () => {
    const view = sessionView(legacy, homes)
    expect(sessionView(legacy, { ...homes })).toBe(view)
    expect(sessionView(view)).toBe(view)
    expect(sessionView({ ...legacy }, homes)).not.toBe(view)
    for (const changed of [
      { ...homes, userState: { ...homes.userState! } },
      { ...homes, repo: { ...homes.repo! } },
      { ...homes, machine: { ...homes.machine! } },
      { ...homes, handoffMachine: { ...homes.handoffMachine! } },
    ]) {
      expect(sessionView(legacy, changed)).not.toBe(view)
      expect(sessionView(legacy, changed)).toBe(sessionView(legacy, { ...changed }))
    }
    // Loaded status matters only while the personal row is missing.
    expect(sessionView(legacy, { ...homes, userStatesLoaded: false })).toBe(view)
  })
  it('inherits authoritative homes when a view is copied for an own-field edit', () => {
    const view = sessionView(legacy, homes)
    const copy = inheritSessionHomes(view, { ...view, title: 'Pending rename' })
    expect(sessionView(copy)).toMatchObject({
      title: 'Pending rename', displayRef: 'NEW-42-B', machineName: 'Source',
      handoffTarget: 'Destination', readAt: active, unread: false,
    })
    expect(sessionValues(copy)).toEqual(sessionValues(view))
    expect(sessionView(copy, { userState: { readAt: null } })).toMatchObject({
      title: 'Pending rename', displayRef: 'NEW-42-B', machineName: 'Source',
      handoffTarget: 'Destination', readAt: null, unread: true,
    })
    expect(sessionView(copy)).toBe(sessionView(copy))
    expect(copy).not.toBe(view)
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
    const rowPaint = foldRowOverlays(loaded, [patch])!
    for (const painted of [rowPaint]) {
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
  })
  it('preserves prototype membership, own keys and copies with authoritative undefined cells', () => {
    const symbol = Symbol('session annotation')
    const prototype = { inherited: 'from prototype' }
    const raw = Object.setPrototypeOf({ ...legacy, title: 'Session title', [symbol]: 'annotation' }, prototype)
    const view = sessionView(raw, homes)
    expect(Object.getPrototypeOf(view)).toBe(prototype)
    expect('inherited' in view).toBe(true)
    expect(Object.hasOwn(view, 'inherited')).toBe(false)
    expect(Reflect.get(view, 'inherited')).toBe('from prototype')
    expect(Reflect.ownKeys(view)).toEqual([...new Set([...Reflect.ownKeys(raw), ...Object.keys(sessionValues(raw, homes))])])
    expect({ ...view }).toMatchObject({ title: 'Session title', displayRef: 'NEW-42-B', [symbol]: 'annotation' })
    expect(Object.assign({}, view)).toEqual({ ...raw, ...sessionValues(raw, homes) })
    expect(Object.hasOwn(view, 'condition')).toBe(true)
    expect('condition' in view).toBe(true)
    expect(Object.getOwnPropertyDescriptor(view, 'condition')).toEqual({
      value: undefined, writable: false, enumerable: true, configurable: false,
    })
    const nullPrototype = Object.setPrototypeOf({ ...legacy }, null)
    expect(Object.getPrototypeOf(sessionView(nullPrototype, homes))).toBeNull()
    expect(Object.hasOwn(sessionView(nullPrototype, homes), 'sessionId')).toBe(true)
  })
  it('freezes cached read views without freezing or copying their nested wire facts', () => {
    const geometry = { cols: 80, rows: 24 }
    const raw = Object.freeze({ ...legacy, geometry })
    const view = sessionView(raw, homes)
    expect(view.displayRef).toBe('NEW-42-B')
    expect(Object.isFrozen(view)).toBe(true)
    expect(view.geometry).toBe(geometry)
    expect(Object.isFrozen(geometry)).toBe(false)
    expect(() => { view.displayRef = 'CHANGED' }).toThrow(TypeError)
    expect(() => { Object.assign(view, { title: 'CHANGED' }) }).toThrow(TypeError)
    expect(() => { delete (view as { displayRef?: string }).displayRef }).toThrow(TypeError)
    expect(() => Object.defineProperty(view, 'displayRef', { value: 'CHANGED' })).toThrow(TypeError)
    expect(() => Object.setPrototypeOf(view, {})).toThrow(TypeError)
    // Native frozen-object reflection rejects mutations with false.
    expect(Reflect.set(view, 'displayRef', 'CHANGED')).toBe(false)
    expect(Reflect.set(view, 'newField', 'CHANGED')).toBe(false)
    expect(Reflect.deleteProperty(view, 'displayRef')).toBe(false)
    expect(Reflect.defineProperty(view, 'displayRef', { value: 'CHANGED' })).toBe(false)
    expect(Reflect.setPrototypeOf(view, {})).toBe(false)
    expect(raw.displayRef).toBe('OLD-42-B')
    expect(view.displayRef).toBe('NEW-42-B')
  })
})
