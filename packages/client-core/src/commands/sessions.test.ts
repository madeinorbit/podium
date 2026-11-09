import { asMutationId, asSessionId, layoutRowId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { OutboxEntry } from '../outbox'
import { harness, sessionId, ME } from './test-support'
describe('engine action ownership boundary', () => {
  it('answers a question as a session.answer record created at once, never queued (POD-6415)', async () => {
    const h = harness()

    const id = await h.actions.answerSession(sessionId, {
      via: 'menu',
      interactionId: 'ask-1',
      choices: [{ optionIndices: [2] }],
    })

    expect(id).toMatch(/^eff_/)
    // Online-only: an answer that reached the server later would land on a
    // later menu, so it is never in the durable queue.
    expect(h.queued).toEqual([])
    expect(h.submit).toHaveBeenCalledTimes(1)
    expect(h.submit.mock.calls[0]?.[0]).toMatchObject({
      command: 'effects.create',
      input: {
        id,
        kind: 'session.answer',
        target: { kind: 'session', id: sessionId },
        input: { via: 'menu', interactionId: 'ask-1', choices: [{ optionIndices: [2] }] },
      },
    })
  })
})
describe('engine action ownership boundary', () => {
  it('a refused answer rejects in words, and nothing is queued', async () => {
    const h = harness()
    h.submit.mockResolvedValueOnce({
      outcome: 'rejected',
      refusal: { kind: 'target-not-found' },
    } as never)
    await expect(h.actions.answerSession(sessionId, { via: 'menu', skip: true })).rejects.toThrow(
      /answer the question/,
    )
    expect(h.queued).toEqual([])
  })
})

describe('ask superagent (BTW) attaches a session to the next turn (POD-1069)', () => {
  it('opens the dock and attaches the session, WITHOUT moving the rendered thread', async () => {
    // THE REGRESSION THIS PINS. The action used to point `superThreadId` at
    // `btw_<sessionId>`. Nothing has rendered a non-global thread since
    // POD-782, so the pane bound a thread with no headless session and went
    // blank — no composer, no way back, and no reset short of a reload, from
    // all three entry points. The dock must stay on the one chat.
    const h = harness()

    await h.actions.startBtw(asSessionId('sess-btw'))

    expect(h.state().superThreadId).toBe('global')
    expect(h.state().attachedSessionId).toBe('sess-btw')
    expect(h.state().superOpen).toBe(true)
    // Opening the dock is not the same as SHOWING the superagent — it also
    // holds Files, Git and Issue. Staging an attachment behind one of those is
    // the same "nothing happened" one surface further in.
    expect(h.state().dockTab).toBe('superagent')
  })

  it('keeps the attachment local while opening the synced dock', async () => {
    // The session rides the next `sendTurn` as `attachSessionId` and the server
    // digests it into that turn's preamble, so an offline client can still line
    // one up.
    const h = harness()

    await h.actions.startBtw(asSessionId('sess-btw'))

    expect(h.queued).toEqual([
      {
        kind: 'recordEdit',
        input: { kind: 'userLayout', id: layoutRowId(ME, 'superOpen'), patch: { value: '1' } },
      },
      {
        kind: 'recordEdit',
        input: {
          kind: 'userLayout',
          id: layoutRowId(ME, 'dockTab'),
          patch: { value: 'superagent' },
        },
      },
    ])
  })

  it("drops the attachment on clear, so the chip's × is not a lie", async () => {
    const h = harness()
    await h.actions.startBtw(asSessionId('sess-btw'))

    h.actions.clearAttachedSession()

    expect(h.state().attachedSessionId).toBeNull()
  })
})

describe('session lifecycle as edits of the session record (POD-6399)', () => {
  const sessionEdit = (input: unknown) =>
    input as { kind: string; id: string; patch: unknown; expectedRevision?: number }

  it('stop, hibernate and resume queue records.session edits against the replica revision', async () => {
    const h = harness({}, undefined, { sessionRevision: () => 4 })
    expect(await h.actions.endSession(sessionId)).toEqual({ ok: true })
    await h.actions.hibernateSession(sessionId)
    expect(await h.actions.resurrectSession(sessionId)).toEqual({ ok: true })
    const edits = h.queued.filter((q) => q.kind === 'recordEdit').map((q) => sessionEdit(q.input))
    expect(edits.map((e) => [e.kind, e.id, e.patch])).toEqual([
      ['session', sessionId, { desired: 'stopped' }],
      ['session', sessionId, { desired: 'hibernated' }],
      ['session', sessionId, { desired: 'running' }],
    ])
    expect(edits.every((e) => e.expectedRevision === 4)).toBe(true)
  })

  it('a second edit queued behind an unconfirmed one names the revision the first will make', async () => {
    const h = harness({}, undefined, { sessionRevision: () => 2 })
    h.pending.push({
      mutationId: asMutationId('m-earlier'),
      kind: 'recordEdit',
      input: { kind: 'session', id: sessionId, patch: { desired: 'stopped' }, expectedRevision: 2 },
      queuedAt: 0,
    } as OutboxEntry)
    await h.actions.endSession(sessionId, true)
    const edit = sessionEdit(h.queued.filter((q) => q.kind === 'recordEdit').at(-1)?.input)
    expect(edit).toMatchObject({ patch: { desired: 'stopped', force: true }, expectedRevision: 3 })
  })

  it('kill removes the session record against its revision', async () => {
    const h = harness({}, undefined, { sessionRevision: () => undefined })
    await h.actions.killSession(sessionId)
    const removes = h.queued
      .filter((q) => q.kind === 'recordRemove')
      .map((q) => sessionEdit(q.input))
    expect(removes).toEqual([{ kind: 'session', id: sessionId, expectedRevision: 1 }])
  })
})
