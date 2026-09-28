import { MessageId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { isUnanswered, newMessageId, repeatUntilAnswered } from './send-once'

const noPause = { sleep: async () => {} }

describe('repeatUntilAnswered (POD-4763)', () => {
  it('mints ids the server accepts as message ids', () => {
    expect(MessageId.safeParse(newMessageId()).success).toBe(true)
    expect(newMessageId()).not.toBe(newMessageId())
  })

  it('repeats an attempt that got no answer, and returns the first answer', async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('agent relay timed out'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('stored')
    await expect(repeatUntilAnswered(attempt, noPause)).resolves.toBe('stored')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('never repeats a refusal: an error the server answered with is an answer', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('spawn budget exhausted for issue #7')
    })
    await expect(repeatUntilAnswered(attempt, noPause)).rejects.toThrow('spawn budget exhausted')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('gives up after its attempts with the last silence', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('agent relay timed out')
    })
    await expect(repeatUntilAnswered(attempt, { ...noPause, attempts: 2 })).rejects.toThrow(
      'agent relay timed out',
    )
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('tells silence from an answer', () => {
    expect(isUnanswered(new Error('agent relay timed out'))).toBe(true)
    expect(isUnanswered(new TypeError('fetch failed'))).toBe(true)
    expect(isUnanswered(new Error('issue relay HTTP 413'))).toBe(false)
    expect(isUnanswered(new TypeError('x is not a function'))).toBe(false)
  })
})
