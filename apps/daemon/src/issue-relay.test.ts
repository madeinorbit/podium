import { describe, expect, it, vi } from 'vitest'
import { createIssueRelayHub, startIssueRelayServer } from './issue-relay'

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

describe('issue relay server', () => {
  it('POST /issue/<sessionId> relays and returns the result', async () => {
    const seen: any[] = []
    const srv = await startIssueRelayServer({
      port: 0,
      relay: async (req) => {
        seen.push(req)
        return { ok: true, result: `ran ${req.proc}` }
      },
    })
    try {
      const res = await fetch(srv.endpointFor('sX'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proc: 'ready', input: { repoPath: '/r' } }),
      })
      const body = await res.json()
      expect(body).toEqual({ ok: true, result: 'ran ready' })
      expect(seen[0]).toMatchObject({ sessionId: 'sX', router: 'issues', proc: 'ready' })
    } finally {
      await srv.close()
    }
  })

  it('rejects a non-POST or bad path with 404', async () => {
    const srv = await startIssueRelayServer({ port: 0, relay: async () => ({ ok: true }) })
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/nope`, { method: 'GET' })
      expect(res.status).toBe(404)
    } finally {
      await srv.close()
    }
  })
})
