import { describe, expect, it, vi } from 'vitest'
import { isIssueNotStartedError, spawnIssueAgent } from './agent-launch'

const input = { id: 'iss_1', agentKind: 'codex' }

describe('spawnIssueAgent', () => {
  it('adds a session on a started issue', async () => {
    const addSession = vi.fn(async () => 'added')
    const start = vi.fn(async () => 'started')
    await expect(
      spawnIssueAgent({ addSession: { mutate: addSession }, start: { mutate: start } }, input),
    ).resolves.toBe('added')
    expect(addSession).toHaveBeenCalledWith(input)
    expect(start).not.toHaveBeenCalled()
  })

  it('starts only when the server says the issue has never been started', async () => {
    const addSession = vi.fn(async () => {
      throw new Error('issue not started')
    })
    const start = vi.fn(async () => 'started')
    await expect(
      spawnIssueAgent({ addSession: { mutate: addSession }, start: { mutate: start } }, input),
    ).resolves.toBe('started')
    expect(start).toHaveBeenCalledWith(input)
  })

  it('does not treat a real addSession failure as "not started"', async () => {
    const addSession = vi.fn(async () => {
      throw new Error('is offline')
    })
    const start = vi.fn(async () => 'started')
    await expect(
      spawnIssueAgent({ addSession: { mutate: addSession }, start: { mutate: start } }, input),
    ).rejects.toThrow(/is offline/)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('isIssueNotStartedError', () => {
  it('matches the server refusal, including a wrapped client error', () => {
    expect(isIssueNotStartedError(new Error('issue not started'))).toBe(true)
    expect(isIssueNotStartedError(new Error('TRPCClientError: issue not started'))).toBe(true)
    expect(isIssueNotStartedError(new Error('no repo registered'))).toBe(false)
  })
})
