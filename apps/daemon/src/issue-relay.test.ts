import { describe, expect, it, vi } from 'vitest'
import { createIssueRelayHub } from './issue-relay'

describe('issue relay hub', () => {
  it('sends an issueRelayRequest and resolves on the matching result', async () => {
    const sent: any[] = []
    const hub = createIssueRelayHub((m) => sent.push(m))
    const p = hub.relay({
      sessionId: 's1',
      router: 'issues',
      proc: 'ready',
      input: { repoPath: '/r' },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('issueRelayRequest')
    expect(sent[0].sessionId).toBe('s1')
    expect(hub.pendingCount()).toBe(1)
    hub.onResult({ requestId: sent[0].requestId, ok: true, result: 'DATA' })
    expect(await p).toEqual({ ok: true, result: 'DATA' })
    expect(hub.pendingCount()).toBe(0)
  })

  it('ignores an unknown or duplicate/late result', async () => {
    const sent: any[] = []
    const hub = createIssueRelayHub((m) => sent.push(m))
    const p = hub.relay({ sessionId: 's1', router: 'issues', proc: 'ready' })
    hub.onResult({ requestId: 'nope', ok: true, result: 'x' }) // unknown → ignored
    hub.onResult({ requestId: sent[0].requestId, ok: false, error: 'boom' })
    const r = await p
    expect(r).toEqual({ ok: false, error: 'boom' })
    hub.onResult({ requestId: sent[0].requestId, ok: true, result: 'late' }) // late → no throw, no effect
    expect(hub.pendingCount()).toBe(0)
  })

  it('times out with ok:false when no result arrives', async () => {
    vi.useFakeTimers()
    const hub = createIssueRelayHub(() => {}, { timeoutMs: 1000 })
    const p = hub.relay({ sessionId: 's1', router: 'issues', proc: 'ready' })
    vi.advanceTimersByTime(1001)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/timed out/)
    vi.useRealTimers()
  })
})
