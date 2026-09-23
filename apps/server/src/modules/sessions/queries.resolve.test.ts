/**
 * `sessions.resolve` (POD-4637): the link resolver's READER gate. The rule
 * itself is the read toolkit's (read-toolkit.test.ts); this pins what the tRPC
 * arm adds — an unreadable match neither resolves nor makes a readable one
 * ambiguous, because either answer would reveal that it exists (D20.2).
 */
import { asSessionId, type SessionId } from '@podium/model'
import type { SessionIdentifierResolution } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { FamilyState } from '../derived-family'
import { resolveReadableIdentifier } from './queries'

const MINE = asSessionId('aaaaaaaa-1111-4111-8111-111111111111')
const HIDDEN = asSessionId('aaaaaaaa-2222-4222-8222-222222222222')
const ALSO_MINE = asSessionId('aaaaaaaa-3333-4333-8333-333333333333')

function state(answer: SessionIdentifierResolution): FamilyState {
  const owners: Record<string, string> = { [MINE]: 'u1', [HIDDEN]: 'u2', [ALSO_MINE]: 'u1' }
  return {
    caller: { userId: 'u1' },
    modules: {
      readToolkit: { resolveIdentifier: async () => answer },
      sessions: {
        sessionOwner: async (id: SessionId) =>
          owners[id] ? { owner: owners[id], grants: [] } : undefined,
      },
    },
  } as unknown as FamilyState
}

const ambiguous = (candidates: SessionId[]): SessionIdentifierResolution => ({
  kind: 'ambiguous',
  prefix: 'aaaaaaaa',
  candidates,
  message: 'unused',
})

describe('sessions.resolve reader gate', () => {
  it('passes a readable session through', async () => {
    expect(await resolveReadableIdentifier(state({ kind: 'session', sessionId: MINE }), 'aaaa')).toEqual({
      kind: 'session',
      sessionId: MINE,
    })
  })

  it('answers absent for an unreadable session, exactly like a missing one', async () => {
    expect(
      await resolveReadableIdentifier(state({ kind: 'session', sessionId: HIDDEN }), 'aaaa'),
    ).toEqual({ kind: 'absent' })
  })

  it('a hidden candidate does not make a readable one ambiguous', async () => {
    expect(await resolveReadableIdentifier(state(ambiguous([MINE, HIDDEN])), 'aaaaaaaa')).toEqual({
      kind: 'session',
      sessionId: MINE,
    })
  })

  it('ambiguous among readable candidates names only those', async () => {
    const res = await resolveReadableIdentifier(state(ambiguous([MINE, HIDDEN, ALSO_MINE])), 'aaaaaaaa')
    expect(res).toEqual({
      kind: 'ambiguous',
      prefix: 'aaaaaaaa',
      candidates: [MINE, ALSO_MINE],
      message: `ambiguous session id prefix 'aaaaaaaa' matches 2 sessions: ${MINE}, ${ALSO_MINE}`,
    })
  })
})
