import { describe, expect, it } from 'vitest'
import { isUpdateRequestTimeout, retryUpdate, startUpdate } from './operations-client'

/**
 * "TRY AGAIN" MUST NOT WAIT FOREVER (POD-6240).
 *
 * A retry whose answer never came left the panel saying "Trying again…" with
 * no end. These stand a fake client in for tRPC: one that never answers but
 * honours the abort signal, the way the real link does.
 */
type Trpc = Parameters<typeof startUpdate>[0]

function neverAnswering(seen: { signal?: AbortSignal }[]): Trpc {
  const hang = (_input: unknown, options?: { signal?: AbortSignal }) => {
    seen.push({ ...(options?.signal ? { signal: options.signal } : {}) })
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  return {
    updates: { start: { mutate: hang }, retry: { mutate: hang } },
  } as unknown as Trpc
}

describe('update start/retry answer deadline', () => {
  it('gives up on a retry that never answers, as a named timeout', async () => {
    const seen: { signal?: AbortSignal }[] = []
    const error = await retryUpdate(neverAnswering(seen), 'op_1', 20).catch((e: unknown) => e)
    expect(isUpdateRequestTimeout(error)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.signal?.aborted).toBe(true)
  })

  it('gives up on a start that never answers, as a named timeout', async () => {
    const error = await startUpdate(neverAnswering([]), undefined, 20).catch((e: unknown) => e)
    expect(isUpdateRequestTimeout(error)).toBe(true)
  })

  it('passes an ordinary failure through unchanged, not as a timeout', async () => {
    const refusing = {
      updates: {
        retry: {
          mutate: async () => {
            throw new Error('refused')
          },
        },
      },
    } as unknown as Trpc
    const error = await retryUpdate(refusing, 'op_1', 1_000).catch((e: unknown) => e)
    expect(isUpdateRequestTimeout(error)).toBe(false)
    expect((error as Error).message).toBe('refused')
  })

  it('returns the answer when one arrives in time', async () => {
    const answering = {
      updates: {
        retry: { mutate: async () => ({ operationId: 'op_2', alreadyRunning: false }) },
      },
    } as unknown as Trpc
    const outcome = await retryUpdate(answering, 'op_1', 1_000)
    expect(outcome.operationId).toBe('op_2')
  })
})
