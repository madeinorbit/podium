/**
 * THE SESSION FAMILY'S OUTBOX COMMANDS ON THE SYNC WRITE ENTRY POINT (POD-6350).
 *
 * For every command: through `sync.submit` the rows it writes carry its
 * provenance, its receipt is the head after the call, and a replay returns the
 * recorded result and runs nothing. Then the refusals the family's gates make,
 * and the old routes as adapters.
 */

import type { SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appliedReply,
  envelope,
  expectAppliedOnPath,
  rowsOf,
  submit,
} from '../sync-write/outbox-test-support'
import { disposeOracles, makeOracle, type Oracle } from './oracle-support'

afterEach(() => disposeOracles())

async function shellSession(o: Oracle): Promise<SessionId> {
  return (await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })).sessionId
}

/** Each queued session command, its input for a session, and whether it
 *  appends a change row (some of these rows are not synced kinds yet). */
const CASES: ReadonlyArray<{
  command: string
  input: (sessionId: SessionId) => Record<string, unknown>
  writes: boolean
}> = [
  {
    command: 'sessions.rename',
    input: (sessionId) => ({ sessionId, name: 'renamed' }),
    writes: true,
  },
  {
    command: 'sessions.setArchived',
    input: (sessionId) => ({ sessionId, archived: true }),
    writes: true,
  },
  {
    command: 'sessions.setWorkState',
    input: (sessionId) => ({ sessionId, workState: 'testing' }),
    writes: true,
  },
  { command: 'sessions.markRead', input: (sessionId) => ({ sessionId }), writes: true },
  { command: 'sessions.markUnread', input: (sessionId) => ({ sessionId }), writes: true },
  {
    command: 'snoozes.set',
    input: (sessionId) => ({ sessionId, until: '2099-01-01T00:00:00.000Z' }),
    writes: true,
  },
  { command: 'snoozes.clear', input: (sessionId) => ({ sessionId }), writes: false },
  {
    command: 'sessions.dismissOffer',
    input: (sessionId) => ({ sessionId, offerCreatedAt: '2026-11-04T00:00:00.000Z' }),
    writes: false,
  },
  {
    command: 'pins.set',
    input: () => ({ kind: 'worktree', id: '/p', pinned: true }),
    writes: false,
  },
  {
    command: 'tabs.setOrder',
    input: (sessionId) => ({ worktree: '/p', sessionIds: [sessionId] }),
    writes: false,
  },
  {
    command: 'sessions.sendText',
    input: (sessionId) => ({ sessionId, text: 'hello over the path' }),
    writes: false,
  },
  {
    command: 'sessions.resumeAndSend',
    input: (sessionId) => ({ sessionId, text: 'hello and wake' }),
    writes: false,
  },
]

describe('the session family on sync.submit', () => {
  for (const c of CASES) {
    it(`${c.command}: provenance, the receipt at the head, a replay runs nothing`, async () => {
      const o = await makeOracle()
      const sessionId = await shellSession(o)
      const mutationId = `msg_00000000-0000-4000-8000-${String(CASES.indexOf(c)).padStart(12, '0')}`

      await expectAppliedOnPath(o, envelope(c.command, c.input(sessionId), mutationId), {
        writes: c.writes,
      })
    })
  }

  it('a chat send stores its message under the envelope id when the input omits it', async () => {
    const o = await makeOracle()
    const sessionId = await shellSession(o)
    const id = 'msg_00000000-0000-4000-8000-0000000000aa'

    appliedReply(
      await submit(
        o,
        envelope('sessions.sendText', { sessionId, text: 'named by the envelope' }, id),
      ),
    )

    expect(await o.store.messages.getMessage(id)).not.toBeNull()
  })

  it('a send naming a model stays off this path until POD-6356', async () => {
    const o = await makeOracle()
    const sessionId = await shellSession(o)

    const reply = await submit(
      o,
      envelope(
        'sessions.sendText',
        { sessionId, text: 'hi', model: 'opus' },
        'msg_00000000-0000-4000-8000-0000000000ab',
      ),
    )

    expect(reply).toEqual({
      outcome: 'rejected',
      refusal: { kind: 'invalid', details: ['model'] },
    })
  })

  it('a write to a session that does not exist is refused, and nothing is written', async () => {
    const o = await makeOracle()

    const reply = await submit(
      o,
      envelope('sessions.setArchived', { sessionId: 'ses_ghost', archived: true }, 'm-ghost'),
    )

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(await rowsOf(o, 'm-ghost')).toEqual([])
  })

  it('a chat send to a session that does not exist answers the pinned dead letter', async () => {
    const o = await makeOracle()

    const reply = appliedReply(
      await submit(
        o,
        envelope(
          'sessions.sendText',
          { sessionId: 'ses_ghost', text: 'anyone' },
          'msg_00000000-0000-4000-8000-0000000000ac',
        ),
      ),
    )

    expect(reply.result).toMatchObject({ ok: false, disposition: 'dead_letter' })
  })
})

describe('the old session routes are adapters onto sync.submit', () => {
  it('a session-state route deduplicates by its mutationId and keeps its no-op refusal', async () => {
    const o = await makeOracle()
    const sessionId = await shellSession(o)

    await o.call.sessions.setWorkState({
      sessionId,
      workState: 'testing',
      mutationId: 'm-ws',
    } as never)
    await o.call.sessions.setWorkState({
      sessionId,
      workState: 'done',
      mutationId: 'm-ws',
    } as never)

    expect((await o.meta(sessionId)).workState).toBe('testing')
    expect((await rowsOf(o, 'm-ws')).length).toBeGreaterThan(0)
    // A refusal is still the silent no-op (§3.1.5).
    await expect(
      o.call.sessions.setArchived({ sessionId: 'ses_ghost' as SessionId, archived: true }),
    ).resolves.toBeUndefined()
  })

  it('rename keeps its void reply and records its provenance', async () => {
    const o = await makeOracle()
    const sessionId = await shellSession(o)

    await expect(
      o.call.sessions.rename({ sessionId, name: 'via route', mutationId: 'm-rename' } as never),
    ).resolves.toBeUndefined()

    expect((await o.meta(sessionId)).name).toBe('via route')
    expect((await rowsOf(o, 'm-rename')).length).toBeGreaterThan(0)
  })

  it('a pins route still answers the pin state it wrote', async () => {
    const o = await makeOracle()

    const pins = await o.call.pins.set({ kind: 'worktree', id: '/p', pinned: true })

    expect(pins).toMatchObject({ worktrees: ['/p'] })
  })
})
