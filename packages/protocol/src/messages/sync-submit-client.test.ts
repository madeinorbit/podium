import { describe, expect, it, vi } from 'vitest'
import type { SyncSubmitInput } from './sync-submit'
import {
  isMissingSyncSubmit,
  refusalSentence,
  SyncSubmitRefusedError,
  submitNow,
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
    expect(refusalSentence(refusal, 'rename it')).toBe(sentence)
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
})
