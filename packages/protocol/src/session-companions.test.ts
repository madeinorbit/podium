import {
  asSessionId,
  asUserId,
  parseSessionUserStateRowId,
  sessionUserStateRowId,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { FeedChange } from './messages/feed'
import {
  MachineProjection,
  MetadataChange,
  SessionUserStateWire,
  SyncChangesSinceResult,
} from './messages/sync'

const state = { userId: asUserId('user:a'), sessionId: asSessionId('session:a'), readAt: null }
const machine = { id: 'machine:a', name: 'Host', loggedOutHarnesses: ['codex'] }

describe('S1 additive wire records', () => {
  it('round-trips both records on the global and scoped feed and the optional snapshot arrays', () => {
    for (const [entity, value, id] of [
      ['sessionUserState', state, sessionUserStateRowId(state.userId, state.sessionId)],
      ['machine', machine, machine.id],
    ] as const) {
      expect(MetadataChange.parse({ seq: 1, entity, id, op: 'upsert', value }).value).toEqual(value)
      expect(FeedChange.parse({ seq: 1, entity, entityId: id, op: 'upsert', value }).value).toEqual(
        value,
      )
    }
    const old = {
      kind: 'snapshot',
      sessions: [],
      issues: [],
      conversations: [],
      diagnostics: [],
      cursor: 1,
    }
    expect(SyncChangesSinceResult.parse(old)).toEqual(old)
    expect(
      SyncChangesSinceResult.parse({ ...old, sessionUserStates: [state], machines: [machine] }),
    ).toEqual({ ...old, sessionUserStates: [state], machines: [machine] })
    expect(SessionUserStateWire.parse({ ...state, snoozedUntil: null }).snoozedUntil).toBeNull()
    expect(SessionUserStateWire.parse(state)).not.toHaveProperty('snoozedUntil')
    expect(MachineProjection.safeParse({ ...machine, tokenHash: 'private' }).success).toBe(true)
    expect(MachineProjection.parse({ ...machine, tokenHash: 'private' })).not.toHaveProperty(
      'tokenHash',
    )
  })

  it('uses the shared escaped composite key and fails closed on malformed or wrong-kind keys', () => {
    expect(
      parseSessionUserStateRowId(sessionUserStateRowId(state.userId, state.sessionId)),
    ).toEqual({ userId: state.userId, sessionId: state.sessionId })
    expect(() => parseSessionUserStateRowId('malformed')).toThrow()
    expect(() => parseSessionUserStateRowId('user:issue:id')).toThrow()
    expect(sessionUserStateRowId(asUserId('user:a:b'), asSessionId('c'))).not.toBe(
      sessionUserStateRowId(asUserId('user:a'), asSessionId('b:c')),
    )
  })
})
