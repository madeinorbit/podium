import { describe, expect, it, vi } from 'vitest'
import type { SyncSubmitInput, SyncSubmitRefusal } from './sync-submit'
import {
  isMissingSyncSubmit,
  refusalSentence,
  SyncSubmitRefusedError,
  submitNow,
  writesThroughSubmit,
} from './sync-submit-client'

const receipt = { feedId: 'f', epoch: 'e', seq: 3 }

function transport(answer: (input: SyncSubmitInput) => unknown) {
  const sent: SyncSubmitInput[] = []
  return {
    sent,
    api: {
      sync: {
        submit: {
          mutate: async (input: SyncSubmitInput) => {
            sent.push(input)
            return answer(input)
          },
        },
      },
    },
  }
}

/** What tRPC throws for a path the server does not serve. */
const noProcedure = () =>
  Object.assign(new Error('No procedure found on path "sync.submit"'), {
    data: { code: 'NOT_FOUND', httpStatus: 404 },
  })

describe('submitNow', () => {
  it('sends one envelope on sync.submit and returns the applied result', async () => {
    const t = transport(() => ({ outcome: 'applied', result: { ok: 1 }, receipt, replayed: false }))

    expect(await submitNow(t.api, 'agentProfiles.create', { name: 'x' })).toEqual({ ok: 1 })
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toMatchObject({
      command: 'agentProfiles.create',
      version: 1,
      input: { name: 'x' },
    })
    expect(t.sent[0]?.mutationId).toMatch(/^mut_[0-9a-f-]{36}$/)
  })

  it('mints a fresh mutationId per call unless the caller names one', async () => {
    const t = transport(() => ({ outcome: 'applied', result: null, receipt, replayed: false }))

    await submitNow(t.api, 'readPosition.advance', {})
    await submitNow(t.api, 'readPosition.advance', {})
    await submitNow(t.api, 'readPosition.advance', {}, { mutationId: 'mut_mine', confirmed: true })

    expect(t.sent[0]?.mutationId).not.toBe(t.sent[1]?.mutationId)
    expect(t.sent[2]).toMatchObject({ mutationId: 'mut_mine', confirmed: true })
  })

  it("throws a refusal shaped like the old route's error, with the handler's message", async () => {
    const t = transport(() => ({
      outcome: 'rejected',
      refusal: { kind: 'conflict', message: "a profile named 'x' already exists" },
    }))

    const error = await submitNow(t.api, 'agentProfiles.create', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SyncSubmitRefusedError)
    expect((error as SyncSubmitRefusedError).message).toBe("a profile named 'x' already exists")
    expect((error as SyncSubmitRefusedError).data.code).toBe('CONFLICT')
    expect((error as SyncSubmitRefusedError).refusal.kind).toBe('conflict')
  })

  it('a refusal without a handler message reads as a plain sentence', async () => {
    const t = transport(() => ({ outcome: 'rejected', refusal: { kind: 'unauthorized' } }))

    await expect(
      submitNow(t.api, 'agentProfiles.delete', {}, { action: 'delete agent profiles' }),
    ).rejects.toMatchObject({
      message: 'You do not have permission to delete agent profiles.',
      data: { code: 'FORBIDDEN' },
      refusal: { kind: 'unauthorized' },
    })
    await expect(submitNow(t.api, 'x.y', {})).rejects.toMatchObject({
      message: 'You do not have permission to do this.',
    })
  })

  it.each([
    [{ kind: 'unauthorized' }, 'You do not have permission to rename it.'],
    [
      { kind: 'target-not-found' },
      'Could not rename it: it no longer exists, or you cannot see it.',
    ],
    [{ kind: 'conflict' }, 'Someone changed this first; try again.'],
    [{ kind: 'invalid' }, 'Could not rename it: the request was not valid.'],
    [
      { kind: 'invalid', details: ['name'] },
      'Could not rename it: these values are not valid: name.',
    ],
    [{ kind: 'confirmation-required' }, 'This is outside your scope; confirm to rename it.'],
    [{ kind: 'conflict', message: 'the handler said so' }, 'the handler said so'],
  ] as const)('refusalSentence(%o)', (refusal, sentence) => {
    expect(refusalSentence(refusal as SyncSubmitRefusal, 'rename it')).toBe(sentence)
  })

  it('an unreadable reply is a failure, never a result', async () => {
    const t = transport(() => ({ ok: true }))

    await expect(submitNow(t.api, 'x.y', {})).rejects.not.toBeInstanceOf(SyncSubmitRefusedError)
  })

  it('a server without sync.submit takes the legacy route when there is one', async () => {
    const t = transport(() => {
      throw noProcedure()
    })
    const legacy = vi.fn(async () => 'old')

    expect(await submitNow(t.api, 'x.y', {}, { legacy })).toBe('old')
    expect(await submitNow({}, 'x.y', {}, { legacy })).toBe('old')
    expect(legacy).toHaveBeenCalledTimes(2)
  })

  it("a relay to an older server: the gate's answer is a missing sync.submit", async () => {
    for (const answer of [
      'no such procedure: sync.submit',
      'sync.submit is not permitted via relay',
    ]) {
      const t = transport(() => {
        throw new Error(answer)
      })
      expect(await submitNow(t.api, 'issues.move', {}, { legacy: async () => 'old' })).toBe('old')
    }
    // The gate refusing the COMMAND inside the envelope is a refusal, not an old server.
    const t = transport(() => {
      throw new Error('issues.secret is not permitted via relay')
    })
    await expect(
      submitNow(t.api, 'issues.secret', {}, { legacy: async () => 'old' }),
    ).rejects.toThrow('issues.secret is not permitted via relay')
  })

  it('a command the server has not put on the entry point yet takes its route', async () => {
    const t = transport(() => ({
      outcome: 'rejected',
      refusal: { kind: 'invalid', details: ['command'] },
    }))
    expect(await submitNow(t.api, 'issues.move', {}, { legacy: async () => 'old' })).toBe('old')
    // Without a route to take, it is the refusal it is.
    await expect(submitNow(t.api, 'issues.move', {})).rejects.toMatchObject({
      data: { code: 'BAD_REQUEST' },
    })
  })

  it('without a legacy route, such a server refuses the command', async () => {
    await expect(submitNow({}, 'x.y', {})).rejects.toMatchObject({
      message: 'This server is too old for this; update it and try again.',
      data: { code: 'BAD_REQUEST' },
    })
  })

  it('any other transport error propagates unchanged', async () => {
    const boom = new Error('socket closed')
    const t = transport(() => {
      throw boom
    })

    await expect(submitNow(t.api, 'x.y', {}, { legacy: async () => 'old' })).rejects.toBe(boom)
  })

  it('isMissingSyncSubmit names only a missing sync.submit', () => {
    expect(isMissingSyncSubmit(noProcedure())).toBe(true)
    expect(
      isMissingSyncSubmit(
        Object.assign(new Error('No procedure found on path "issues.get"'), {
          data: { code: 'NOT_FOUND' },
        }),
      ),
    ).toBe(false)
    expect(isMissingSyncSubmit(new Error('No procedure found on path "sync.submit"'))).toBe(false)
  })

  it('writesThroughSubmit hands back a client without those procedures as it is', () => {
    expect(writesThroughSubmit({}, undefined as unknown as object, 'issues', () => true)).toBe(
      undefined,
    )
  })

  it('writesThroughSubmit sends the named writes on sync.submit and keeps the rest', async () => {
    const t = transport(() => ({
      outcome: 'applied',
      result: 'via submit',
      receipt,
      replayed: false,
    }))
    const route = vi.fn(async (_input?: unknown) => 'via route')
    const read = vi.fn(async (_input?: unknown) => 'read')
    const procs = { move: { mutate: route, query: read }, get: { query: read, mutate: route } }
    const wrapped = writesThroughSubmit(t.api, procs, 'issues', (proc) => proc === 'move')

    expect(await wrapped.move.mutate({ id: 'i' })).toBe('via submit')
    expect(t.sent[0]).toMatchObject({ command: 'issues.move', input: { id: 'i' } })
    expect(await wrapped.move.query()).toBe('read')
    expect(await wrapped.get.mutate({})).toBe('via route')
    expect(route).toHaveBeenCalledTimes(1)
  })
})
