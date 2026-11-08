/**
 * GENERIC SYNCED EDITS ON THE CLIENT (ADR 12 D3/D4, POD-6392): the one API, the
 * one overlay case, and the outbox rows behind them, held to the declarations.
 */

import { issueSeqPending, RECORD_CONTRACTS, SYNCED_KINDS } from '@podium/commands'
import {
  asMutationId,
  asSessionId,
  asUserId,
  IssueProjection,
  sessionUserStateRowId,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { PodiumClientApi } from './api'
import { foldRowOverlays, overlaysForOutboxEntry } from './command-reducers'
import {
  deadLetterHandlingFor,
  OUTBOX_ROUTING,
  outboxCommandFor,
  outboxCommandOf,
  outboxExecutors,
} from './engine/wiring'
import { classifyRefusal, type OutboxEntry } from './outbox'
import {
  createRecordsApi,
  newRecordId,
  RECORD_HOMES,
  RecordInputError,
  type RecordKind,
  recordEditEntry,
  recordKinds,
  recordWireCommands,
  UNSET,
} from './records'

const ISSUE = 'iss_00000000-0000-4000-8000-000000000001'
const USER = asUserId('u-1')
const SESSION = asSessionId('00000000-0000-4000-8000-0000000000aa')
const READ_ROW = sessionUserStateRowId(USER, SESSION)

const entry = (kind: string, input: unknown, id = 'm-1'): OutboxEntry => ({
  mutationId: asMutationId(id),
  kind,
  input,
  queuedAt: 0,
})

describe('the record kinds the client knows', () => {
  it('are exactly the declared synced kinds', () => {
    expect(Object.values(recordKinds())).toEqual(expect.arrayContaining([...SYNCED_KINDS]))
    expect(Object.keys(recordKinds()).sort()).toEqual(SYNCED_KINDS.map((d) => d.kind).sort())
    for (const [name, d] of Object.entries(recordKinds())) expect(d.kind).toBe(name)
  })

  it('reach every generated record command, and only those', () => {
    expect(
      recordWireCommands()
        .map(([name]) => name)
        .sort(),
    ).toEqual(Object.keys(RECORD_CONTRACTS).sort())
  })

  it('mint new ids of the declared shape', () => {
    for (const d of SYNCED_KINDS) {
      if (d.ops.create === undefined) continue
      const id = newRecordId(d.kind as RecordKind)
      expect(d.newId?.safeParse(id).success, id).toBe(true)
    }
  })

  it('send each op under its own contract, with the contract’s confirmation', () => {
    for (const [name, outboxKind] of recordWireCommands()) {
      const [, kind] = name.split('.') as [string, RecordKind]
      const command = outboxCommandOf(outboxKind, { kind, id: 'x', patch: {}, fields: {} } as never)
      const contract = RECORD_CONTRACTS[name]!
      expect(command).toMatchObject({
        name,
        version: contract.version,
        confirmation: contract.policy.confirmation,
      })
    }
    // Without its input a record kind has no contract to name.
    expect(outboxCommandFor('recordEdit')).toBeUndefined()
    expect(deadLetterHandlingFor('recordEdit')).toBe('recover')
  })

  it('order with the per-command writes to the same row', () => {
    expect(OUTBOX_ROUTING.recordEdit({ kind: 'issueProjection', id: ISSUE, patch: {} })).toEqual({
      partitionKey: OUTBOX_ROUTING.issueUpdate({ id: ISSUE, patch: {} }).partitionKey,
    })
    expect(
      OUTBOX_ROUTING.recordRemove({ kind: 'sessionUserState', id: READ_ROW }).partitionKey,
    ).toBe(OUTBOX_ROUTING.dismissOffer({ sessionId: SESSION, offerCreatedAt: 'T1' }).partitionKey)
    // The session's own record orders with them too (POD-6406).
    expect(
      OUTBOX_ROUTING.recordEdit({ kind: 'session', id: SESSION, patch: { name: 'n' } })
        .partitionKey,
    ).toBe(`session:${SESSION}`)
  })

  it('collapse only into a later revision-free edit of exactly the same cells (POD-6404)', () => {
    const read = (patch: Record<string, unknown>, extra: object = {}) =>
      OUTBOX_ROUTING.recordEdit({ kind: 'sessionUserState', id: READ_ROW, patch, ...extra })
        .collapseKey
    expect(read({ readAt: null })).toBe(read({ readAt: '2026-11-05T00:00:00.000Z' }))
    expect(read({ readAt: null })).not.toBe(read({ snoozedUntil: null }))
    expect(read({ readAt: null })).not.toBe(read({ readAt: null, snoozedUntil: null }))
    expect(read({ snoozedUntil: null })).toBe(read({}, { unset: ['snoozedUntil'] }))
    // A revision-checked edit never collapses: its base is part of what it says.
    expect(
      OUTBOX_ROUTING.recordEdit({
        kind: 'issueProjection',
        id: ISSUE,
        patch: { title: 'x' },
        expectedRevision: 2,
      }).collapseKey,
    ).toBeUndefined()
  })
})

describe('the generic API refuses what the declaration refuses, before anything paints', () => {
  const writes: unknown[] = []
  const api = createRecordsApi(async (kind, input) => {
    writes.push({ kind, input })
  })

  it.each([
    ['a status field', { revision: 3 }],
    ['a label field', { seq: 12 }],
    ['an undeclared field', { stage: 'done' }],
  ])('%s', async (_what, patch) => {
    writes.length = 0
    await expect(
      api.edit({ kind: 'issueProjection', id: ISSUE }, patch as never, 1),
    ).rejects.toBeInstanceOf(RecordInputError)
    expect(writes).toEqual([])
  })

  it('a key field', () => {
    expect(() =>
      recordEditEntry({ kind: 'sessionUserState', id: READ_ROW }, { userId: 'u-2' } as never),
    ).toThrow(RecordInputError)
  })

  it('a cell that can only be set, cleared (POD-6403)', () => {
    // `readAt: null` is unread; the cell is never absent.
    expect(() =>
      recordEditEntry({ kind: 'sessionUserState', id: READ_ROW }, { readAt: UNSET }),
    ).toThrow(/readAt cannot be cleared/)
  })

  it('a single-writer edit names no revision (POD-6403)', () => {
    expect(
      recordEditEntry(
        { kind: 'sessionUserState', id: READ_ROW },
        { readAt: '2026-11-01T00:00:00.000Z' },
      ),
    ).toEqual({
      kind: 'sessionUserState',
      id: READ_ROW,
      patch: { readAt: '2026-11-01T00:00:00.000Z' },
    })
  })

  it('an exp-rev edit without its revision', async () => {
    // The session's desired state is exp-rev (POD-6356).
    await expect(
      api.edit({ kind: 'session', id: SESSION }, { desired: 'stopped' }),
    ).rejects.toBeInstanceOf(RecordInputError)
  })

  it('a plain issue field names no revision: its last writer wins (POD-6405)', async () => {
    writes.length = 0
    await api.edit({ kind: 'issueProjection', id: ISSUE }, { title: 'x' })
    expect(writes).toEqual([
      { kind: 'recordEdit', input: { kind: 'issueProjection', id: ISSUE, patch: { title: 'x' } } },
    ])
  })

  it('an op the kind does not offer, and a human ref as a new id', async () => {
    await expect(api.remove({ kind: 'issueProjection', id: ISSUE }, 1)).rejects.toThrow(
      /does not offer remove/,
    )
    await expect(api.create('sessionUserState', READ_ROW, {})).rejects.toThrow(
      /does not offer create/,
    )
    await expect(
      api.create('issueProjection', 'POD-12', { title: 'x', repoPath: '/r' }),
    ).rejects.toBeInstanceOf(RecordInputError)
  })

  it('stores the value as the server will: parsed by the command’s schema', async () => {
    writes.length = 0
    await api.edit({ kind: 'issueProjection', id: ISSUE }, { title: '  Renamed  ' }, 4)
    expect(writes).toEqual([
      {
        kind: 'recordEdit',
        input: {
          kind: 'issueProjection',
          id: ISSUE,
          patch: { title: 'Renamed' },
          expectedRevision: 4,
        },
      },
    ])
  })
})

describe('the one generic overlay case', () => {
  it('an edit paints its patch on the kind’s row, in the wire spelling', () => {
    expect(
      overlaysForOutboxEntry(
        entry('recordEdit', {
          kind: 'issueProjection',
          id: ISSUE,
          patch: { title: 'Mine', description: 'Text' },
          expectedRevision: 1,
        }),
      ),
    ).toEqual([
      {
        op: 'patch',
        key: 'm-1',
        entity: 'issueProjections',
        id: ISSUE,
        patch: { title: 'Mine', description: { value: 'Text' } },
      },
    ])
  })

  it('a per-user row lands on its entity in the pool', () => {
    const [overlay] = overlaysForOutboxEntry(
      entry('recordEdit', { kind: 'sessionUserState', id: READ_ROW, patch: { readAt: null } }),
    )
    expect(overlay).toMatchObject({ entity: 'sessionUserStates', id: SESSION })
    expect(RECORD_HOMES.sessionUserState?.row(READ_ROW)).toBe(SESSION)
  })

  it('a remove hides the row; a later patch folds over the absent row', () => {
    const [removal] = overlaysForOutboxEntry(
      entry('recordRemove', { kind: 'sessionUserState', id: READ_ROW }),
    )
    expect(removal).toEqual({ op: 'remove', key: 'm-1', entity: 'sessionUserStates', id: SESSION })
    const truth = { userId: USER, sessionId: SESSION, readAt: '2026-11-01T00:00:00.000Z' }
    expect(foldRowOverlays(truth, [removal!])).toBeUndefined()
    const absent = { userId: USER, sessionId: SESSION, readAt: null }
    const later = {
      op: 'patch' as const,
      key: 'm-2',
      entity: 'sessionUserStates' as const,
      id: SESSION,
      patch: { readAt: '2026-11-02T00:00:00.000Z' },
      absent,
    }
    expect(foldRowOverlays(truth, [removal!, later])).toEqual({
      ...absent,
      readAt: '2026-11-02T00:00:00.000Z',
    })
  })

  it('a create paints the whole row a new record has, the server’s cells pending (POD-6400)', () => {
    const [overlay] = overlaysForOutboxEntry(
      entry('recordCreate', {
        kind: 'issueProjection',
        id: ISSUE,
        fields: { title: 'New', repoPath: '/repo', priority: 1 },
      }),
      { userId: USER },
    )
    expect(overlay?.op).toBe('insert')
    const row = (overlay as { insert: Record<string, unknown> }).insert
    // A whole wire row, so every reader of the kind can show it.
    expect(IssueProjection.safeParse(row).success).toBe(true)
    expect(row).toMatchObject({
      id: ISSUE,
      title: 'New',
      priority: 1,
      // Defaults and constants, as the server stores them.
      type: 'task',
      description: { value: '' },
      stage: 'backlog',
      archived: false,
      // Server-assigned: the placeholder, read as pending.
      seq: 0,
      owner: USER,
      createdAt: '1970-01-01T00:00:00.000Z',
    })
    expect(issueSeqPending(row as { seq: number })).toBe(true)
    // The placement input is not a wire cell.
    expect(row).not.toHaveProperty('repoPath')
  })

  it('a create from an older build whose row is not whole paints nothing', () => {
    expect(
      overlaysForOutboxEntry(
        entry('recordCreate', { kind: 'issueProjection', id: ISSUE, fields: { repoPath: '/r' } }),
      ),
    ).toEqual([])
  })
})

describe('the executor the compatibility queue calls', () => {
  function serverAnswering(reply: unknown) {
    const submits: unknown[] = []
    const api = {
      sync: {
        submit: {
          mutate: async (envelope: unknown) => {
            submits.push(envelope)
            return reply
          },
        },
      },
    } as unknown as PodiumClientApi
    return { submits, execute: outboxExecutors(api).recordEdit }
  }
  const input = {
    kind: 'issueProjection' as const,
    id: ISSUE,
    patch: { title: 'Mine' },
    expectedRevision: 2,
    mutationId: asMutationId('m-9'),
  }

  it('submits the command under its record name, without the entry’s kind', async () => {
    const receipt = { feedId: 'f', epoch: 'e', seq: 3 }
    const { submits, execute } = serverAnswering({
      outcome: 'applied',
      result: { ok: true },
      receipt,
      replayed: false,
    })
    await expect(execute(input)).resolves.toEqual({ ok: true })
    expect(submits).toEqual([
      {
        mutationId: 'm-9',
        command: 'records.issueProjection.edit',
        version: 1,
        input: { id: ISSUE, patch: { title: 'Mine' }, expectedRevision: 2 },
      },
    ])
  })

  it('chains this device’s next edit of the record onto the revision its last one wrote (POD-6403)', async () => {
    let revision = 2
    const submits: { input: { expectedRevision?: number } }[] = []
    const api = {
      sync: {
        submit: {
          mutate: async (envelope: { input: { expectedRevision?: number } }) => {
            submits.push(envelope)
            revision += 1
            return {
              outcome: 'applied',
              result: { revision },
              receipt: { feedId: 'f', epoch: 'e', seq: revision },
              replayed: false,
            }
          },
        },
      },
    } as unknown as PodiumClientApi
    const execute = outboxExecutors(api).recordEdit
    await execute(input)
    const next = { ...input, mutationId: asMutationId('m-10') }
    await execute(next)
    expect(submits.map((s) => s.input.expectedRevision)).toEqual([2, 3])
  })

  it('a refusal in the reply is the same refusal to the queue', async () => {
    const { execute } = serverAnswering({ outcome: 'rejected', refusal: { kind: 'conflict' } })
    const error = await execute(input).catch((e: unknown) => e)
    expect(classifyRefusal(error)).toEqual({ kind: 'conflict' })
  })

  it('a server without the entry point cannot serve one no old command carries: refused, not retried', async () => {
    const execute = outboxExecutors({ sync: {} } as unknown as PodiumClientApi).recordEdit
    const error = await execute({ ...input, patch: {}, unset: ['acceptance'] }).catch(
      (e: unknown) => e,
    )
    expect(classifyRefusal(error)).toEqual({
      kind: 'invalid',
      message: 'this server does not serve records.issueProjection.edit',
    })
  })
})
