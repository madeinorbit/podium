/**
 * THE RETIRED PLAIN-EDIT KINDS (POD-6404, LEGACY 2027-03): a record edit on a
 * server without `sync.submit` goes out as the old command it replaced, with
 * the same effect; an entry an older build queued under a retired kind drains
 * under its old command.
 */

import {
  asIssueId,
  asMutationId,
  asSessionId,
  asUserId,
  issueUserStateRowId,
  layoutRowId,
  sessionUserStateRowId,
} from '@podium/model'
import type { SyncSubmitInput } from '@podium/protocol'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { describe, expect, it } from 'vitest'
import type { PodiumClientApi } from '../../api'
import type { StoreNotices } from '../../engine/types'
import type { OutboxEntry, OutboxStorage } from '../../outbox'
import type { RecordEditEntry } from '../../records'
import type { Replica } from '../../replica/contract'
import { openKernelEngineOutbox } from './kernel-outbox'
import { legacyCallsForRecordEdit } from './legacy-outbox-kinds'
import { outboxExecutors } from './wiring'

const ME = asUserId('u-1')
const SESSION = asSessionId('00000000-0000-4000-8000-0000000000aa')
const ISSUE = asIssueId('iss_00000000-0000-4000-8000-000000000001')
const AT = '2026-11-05T00:00:00.000Z'
const mySession = (patch: Record<string, unknown>, unset?: string[]): RecordEditEntry => ({
  kind: 'sessionUserState',
  id: sessionUserStateRowId(ME, SESSION),
  patch,
  ...(unset === undefined ? {} : { unset }),
})
const myIssue = (patch: Record<string, unknown>): RecordEditEntry => ({
  kind: 'issueUserState',
  id: issueUserStateRowId(ME, ISSUE),
  patch,
})

/** An older server: the old routes, and no `sync.submit` at all. */
function olderServer() {
  const calls: { path: string; input: Record<string, unknown> }[] = []
  const route = (path: string) => ({
    mutate: async (input: Record<string, unknown>) => {
      calls.push({ path, input })
      return { ok: true }
    },
  })
  const api = {
    sessions: {
      markRead: route('sessions.markRead'),
      markUnread: route('sessions.markUnread'),
      stop: route('sessions.stop'),
      hibernate: route('sessions.hibernate'),
      resurrect: route('sessions.resurrect'),
      kill: route('sessions.kill'),
      rename: route('sessions.rename'),
      setArchived: route('sessions.setArchived'),
      setWorkState: route('sessions.setWorkState'),
    },
    snoozes: { set: route('snoozes.set'), clear: route('snoozes.clear') },
    layout: { set: route('layout.set'), clear: route('layout.clear') },
    issues: {
      markRead: route('issues.markRead'),
      markUnread: route('issues.markUnread'),
      setTucked: route('issues.setTucked'),
    },
  } as unknown as PodiumClientApi
  return { api, calls }
}

describe('a record edit on a server without sync.submit', () => {
  it.each([
    [
      'mark a session read',
      mySession({ readAt: AT }),
      'sessions.markRead',
      { sessionId: SESSION, readAt: AT },
    ],
    [
      'mark a session unread',
      mySession({ readAt: null }),
      'sessions.markUnread',
      { sessionId: SESSION },
    ],
    [
      'snooze a session',
      mySession({ snoozedUntil: AT }),
      'snoozes.set',
      { sessionId: SESSION, until: AT },
    ],
    [
      'snooze until the next message',
      mySession({ snoozedUntil: null }),
      'snoozes.set',
      { sessionId: SESSION, until: null },
    ],
    ['end a snooze', mySession({}, ['snoozedUntil']), 'snoozes.clear', { sessionId: SESSION }],
    ['mark an issue read', myIssue({ readAt: AT }), 'issues.markRead', { id: ISSUE, readAt: AT }],
    ['mark an issue unread', myIssue({ readAt: null }), 'issues.markUnread', { id: ISSUE }],
    ['tuck an issue', myIssue({ tuckedAt: AT }), 'issues.setTucked', { id: ISSUE, tucked: true }],
    [
      'bring an issue back',
      myIssue({ tuckedAt: null }),
      'issues.setTucked',
      { id: ISSUE, tucked: false },
    ],
  ] as const)('%s: the old route, with the same effect and the entry’s replay id', async (_what, edit, path, input) => {
    const { api, calls } = olderServer()
    const mutationId = asMutationId('m-1')

    await outboxExecutors(api).recordEdit({ ...edit, mutationId } as never)

    expect(calls).toEqual([{ path, input: { ...input, mutationId } }])
  })

  // The session lifecycle as desired state (POD-6399).
  const lifecycle = (patch: Record<string, unknown>): RecordEditEntry => ({
    kind: 'session',
    id: SESSION,
    patch,
    expectedRevision: 3,
  })
  it.each([
    ['stop', lifecycle({ desired: 'stopped' }), 'sessions.stop', { sessionId: SESSION }],
    [
      'stop, discarding unsaved work',
      lifecycle({ desired: 'stopped', force: true }),
      'sessions.stop',
      { sessionId: SESSION, force: true },
    ],
    [
      'hibernate',
      lifecycle({ desired: 'hibernated' }),
      'sessions.hibernate',
      { sessionId: SESSION },
    ],
    ['resume', lifecycle({ desired: 'running' }), 'sessions.resurrect', { sessionId: SESSION }],
  ] as const)('%s a session: its old route', async (_what, edit, path, input) => {
    const { api, calls } = olderServer()
    const mutationId = asMutationId('m-life')
    await outboxExecutors(api).recordEdit({ ...edit, mutationId } as never)
    expect(calls).toEqual([{ path, input: { ...input, mutationId } }])
  })

  it('a layout key: set is layout.set, a cleared value or a remove is layout.clear', async () => {
    const { api, calls } = olderServer()
    const id = layoutRowId(ME, 'sidebar.section.open')
    const executors = outboxExecutors(api)
    await executors.recordEdit({
      kind: 'userLayout',
      id,
      patch: { value: '1' },
      mutationId: asMutationId('l-1'),
    } as never)
    await executors.recordEdit({
      kind: 'userLayout',
      id,
      patch: {},
      unset: ['value'],
      mutationId: asMutationId('l-2'),
    } as never)
    await executors.recordRemove({
      kind: 'userLayout',
      id,
      mutationId: asMutationId('l-3'),
    } as never)
    expect(calls).toEqual([
      { path: 'layout.set', input: { values: { 'sidebar.section.open': '1' }, mutationId: 'l-1' } },
      { path: 'layout.clear', input: { keys: ['sidebar.section.open'], mutationId: 'l-2' } },
      { path: 'layout.clear', input: { keys: ['sidebar.section.open'], mutationId: 'l-3' } },
    ])
  })

  // The session's labels (POD-6406).
  const label = (patch: Record<string, unknown>, unset?: string[]): RecordEditEntry => ({
    kind: 'session',
    id: SESSION,
    patch,
    ...(unset === undefined ? {} : { unset }),
  })
  it.each([
    ['rename', label({ name: 'n' }), [['sessions.rename', { sessionId: SESSION, name: 'n' }]]],
    [
      'archive, with the work done',
      label({ archived: true, workState: 'done' }),
      [
        ['sessions.setArchived', { sessionId: SESSION, archived: true }],
        ['sessions.setWorkState', { sessionId: SESSION, workState: 'done' }],
      ],
    ],
    [
      'clear the work state',
      label({}, ['workState']),
      [['sessions.setWorkState', { sessionId: SESSION, workState: null }]],
    ],
  ] as const)('%s a session: its old routes', async (_what, edit, expected) => {
    const { api, calls } = olderServer()
    await outboxExecutors(api).recordEdit({ ...edit, mutationId: asMutationId('m-l') } as never)
    expect(calls.map((c) => [c.path, { ...c.input, mutationId: undefined }])).toEqual(
      expected.map(([path, input]) => [path, { ...input, mutationId: undefined }]),
    )
  })

  it('kill (a remove of the session record): sessions.kill', async () => {
    const { api, calls } = olderServer()
    const mutationId = asMutationId('m-kill')
    await outboxExecutors(api).recordRemove({
      kind: 'session',
      id: SESSION,
      expectedRevision: 3,
      mutationId,
    } as never)
    expect(calls).toEqual([{ path: 'sessions.kill', input: { sessionId: SESSION, mutationId } }])
  })

  it('an edit of two cells is two old calls, each with its own replay id', async () => {
    const { api, calls } = olderServer()
    await outboxExecutors(api).recordEdit({
      ...mySession({ readAt: AT, snoozedUntil: null }),
      mutationId: asMutationId('m-2'),
    } as never)
    expect(calls.map((c) => [c.path, c.input.mutationId])).toEqual([
      ['sessions.markRead', 'm-2:0'],
      ['snoozes.set', 'm-2:1'],
    ])
  })

  it('an edit no old command can carry is refused, not guessed', () => {
    expect(
      legacyCallsForRecordEdit({
        kind: 'issueProjection',
        id: ISSUE,
        patch: {},
        unset: ['acceptance'],
      }),
    ).toBeUndefined()
  })
})

function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
}

async function openOn(store: InMemoryOutboxStore, api: PodiumClientApi, online: boolean) {
  const create = await openKernelEngineOutbox({
    store,
    principal: 'u-1',
    api,
    onDegraded: (detail) => {
      throw detail instanceof Error ? detail : new Error(String(detail))
    },
    now: () => 5_000,
    confirmedThrough: () => null,
  })
  return create({
    api,
    replica: {
      outboxStorage: memoryStorage,
      outboxAwaitingStorage: memoryStorage,
      outboxDeadLetterStorage: memoryStorage,
    } as unknown as Replica,
    notices: { error: () => {}, info: () => {} } as unknown as StoreNotices,
    isOnline: () => online,
  })
}

describe('an entry an older build queued under a retired kind', () => {
  it('drains under its old command and mutationId, and paints nothing', async () => {
    const submits: SyncSubmitInput[] = []
    const api = {
      sync: {
        submit: {
          mutate: async (envelope: SyncSubmitInput) => {
            submits.push(envelope)
            return {
              outcome: 'applied',
              result: { ok: true },
              receipt: { feedId: 'f', epoch: 'e', seq: 3 },
              replayed: false,
            }
          },
        },
      },
    } as unknown as PodiumClientApi
    // A real durable record, queued offline, then spelled as an older build
    // left it: `sessions.markRead` with that command's input.
    const seed = new InMemoryOutboxStore([])
    const offline = await openOn(seed, api, false)
    const mutationId = asMutationId('m-old')
    await offline.enqueue(
      'dismissOffer',
      { sessionId: SESSION, offerCreatedAt: AT },
      { mutationId },
    )
    offline.dispose()
    const [queued] = await seed.read()
    if (queued === undefined) throw new Error('nothing queued')
    const { collapseKey: _collapse, ...record } = queued
    const store = new InMemoryOutboxStore([
      {
        ...record,
        command: { ...record.command, name: 'sessions.markRead' },
        input: { sessionId: SESSION },
      },
    ])

    const outbox = await openOn(store, api, true)
    expect(outbox.pending().map((e) => e.kind)).toEqual(['sessionMarkRead'])
    await outbox.drain()

    expect(submits).toEqual([
      {
        mutationId,
        command: 'sessions.markRead',
        version: 1,
        input: { sessionId: SESSION, mutationId },
      },
    ])
    outbox.dispose()
  })
})
