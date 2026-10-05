import { expect, it } from 'vitest'
import { foldRowOverlays } from './command-reducers'
import { sessionValues, sessionView, sessionViews } from './session-values'

const active = '2026-10-01T12:00:00Z'
const raw = { sessionId: 'session', machineId: 'host', agentKind: 'codex', refRepoId: 'repo', refSeq: 42, refLetter: 'B', handoffTargetMachineId: 'target', lastActiveAt: active }
const homes = { userState: { readAt: active }, repo: { prefix: 'POD' }, machine: { name: 'Host', loggedOutHarnesses: [] as string[] }, handoffMachine: { name: 'Target' } }

it('joins explicit companion inputs with authoritative cleared values', () => {
  expect(sessionValues(raw, homes)).toEqual({ readAt: active, unread: false, snoozedUntil: undefined,
    displayRef: 'POD-42-B', machineName: 'Host', condition: undefined, handoffTarget: 'Target' })
  expect(sessionValues({ ...raw, machineName: 'stale', displayRef: 'OLD', condition: 'logged-out' } as typeof raw, {
    ...homes, repo: { prefix: null }, machine: { name: '', loggedOutHarnesses: [] }, handoffMachine: undefined,
  })).toMatchObject({ displayRef: undefined, machineName: '', condition: undefined, handoffTarget: undefined })
})

it('reads getter-based joins each time, including cold summaries and ordinary copies', () => {
  let name = 'Host', prefix = 'POD'
  const joined = { ...raw, readAt: active, unread: false, get machineName() { return name }, get displayRef() { return `${prefix}-42-B` } }
  expect(sessionValues(joined)).toMatchObject({ machineName: 'Host', displayRef: 'POD-42-B', unread: false })
  name = 'Renamed'; prefix = 'NEW'
  expect(sessionValues(joined)).toMatchObject({ machineName: 'Renamed', displayRef: 'NEW-42-B' })
  expect(sessionValues({ ...joined })).toEqual(sessionValues(joined))
})

it('preserves joined labels when an explicit personal cursor replaces the read cursor', () => {
  const view = sessionView(raw, homes)
  const painted = sessionView(view, { userState: { readAt: null, snoozedUntil: active } })
  expect(sessionValues(painted)).toMatchObject({ readAt: null, unread: true, snoozedUntil: active,
    displayRef: 'POD-42-B', machineName: 'Host', handoffTarget: 'Target' })
  const patch = { key: 'rename', entity: 'sessions', id: raw.sessionId, op: 'patch', patch: { name: 'Pending' }, coveredBy: () => false } as const
  const copy = foldRowOverlays(view, [patch])!
  expect(sessionValues(copy)).toEqual(sessionValues(view))
  expect(sessionValues(JSON.parse(JSON.stringify(copy)))).toEqual(sessionValues(view))
})

it('derives draft refs and harness logout condition from explicit homes', () => {
  expect(sessionValues({ ...raw, refSeq: undefined, refLetter: undefined, refDraft: 3 }, homes).displayRef).toBe('POD-DRAFT-3')
  expect(sessionValues(raw, { ...homes, machine: { name: 'Host', loggedOutHarnesses: ['codex'] } }).condition).toBe('logged-out')
  expect(sessionValues(raw, { ...homes, machine: { name: 'Host', loggedOutHarnesses: ['claude-code'] } }).condition).toBeUndefined()
})

it('uses the loaded personal companion boundary for unread values', () => {
  expect(sessionValues(raw, { userStatesLoaded: false }).unread).toBe(false)
  expect(sessionValues(raw, { userStatesLoaded: true }).unread).toBe(true)
  expect(sessionValues(raw, { userState: { readAt: active } }).unread).toBe(false)
  expect(sessionValues(raw, { userState: { readAt: null } }).unread).toBe(true)
})

it('keeps snapshot adapters frozen and preserves nested facts and prototypes', () => {
  const geometry = { cols: 80, rows: 24 }, prototype = { marker: true }
  const input = Object.setPrototypeOf({ ...raw, geometry }, prototype)
  const view = sessionView(input, homes)
  expect(Object.isFrozen(view)).toBe(true)
  expect(Object.getPrototypeOf(view)).toBe(prototype)
  expect(view.geometry).toBe(geometry)
  expect(sessionView(input, homes)).toBe(view)
  expect(sessionViews([input], { userId: 'operator', userStates: [{ userId: 'operator', sessionId: raw.sessionId, ...homes.userState }],
    repos: [{ id: 'repo', ...homes.repo }], machines: [{ id: 'host', ...homes.machine }, { id: 'target', name: 'Target', loggedOutHarnesses: [] }] })[0]).toEqual(view)
})
