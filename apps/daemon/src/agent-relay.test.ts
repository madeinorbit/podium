import { describe, expect, it, vi } from 'vitest'
import { createAgentRelayHub, startAgentRelayServer } from './agent-relay'

describe('agent relay hub', () => {
  it('sends an agentRelayRequest and resolves on the matching result', async () => {
    const sent: any[] = []
    const hub = createAgentRelayHub((m) => sent.push(m))
    const p = hub.relay({
      sessionId: 's1',
      router: 'issues',
      proc: 'ready',
      input: { repoPath: '/r' },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('agentRelayRequest')
    expect(sent[0].sessionId).toBe('s1')
    expect(hub.pendingCount()).toBe(1)
    hub.onResult({ requestId: sent[0].requestId, ok: true, result: 'DATA' })
    expect(await p).toEqual({ ok: true, result: 'DATA' })
    expect(hub.pendingCount()).toBe(0)
  })

  it('ignores an unknown or duplicate/late result', async () => {
    const sent: any[] = []
    const hub = createAgentRelayHub((m) => sent.push(m))
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
    const hub = createAgentRelayHub(() => {}, { timeoutMs: 1000 })
    const p = hub.relay({ sessionId: 's1', router: 'issues', proc: 'ready' })
    vi.advanceTimersByTime(1001)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/timed out/)
    vi.useRealTimers()
  })
})

describe('agent relay server', () => {
  it('POST /agent/<sessionId> relays and returns the result', async () => {
    const seen: any[] = []
    const srv = await startAgentRelayServer({
      port: 0,
      relay: async (req) => {
        seen.push(req)
        return { ok: true, result: `ran ${req.proc}` }
      },
    })
    try {
      // endpointFor emits the new /agent/ path.
      expect(srv.endpointFor('sX')).toMatch(/\/agent\/sX$/)
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

  // Read-side tolerance (one release): a session spawned before the rename keeps
  // POSTing to the legacy /issue/<sid> path after a daemon redeploy. The server
  // must still serve it, even though endpointFor only ever emits /agent/.
  it('POST legacy /issue/<sessionId> is still served (read-side tolerance)', async () => {
    const seen: any[] = []
    const srv = await startAgentRelayServer({
      port: 0,
      relay: async (req) => {
        seen.push(req)
        return { ok: true, result: `ran ${req.proc}` }
      },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/issue/sLegacy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proc: 'ready', input: { repoPath: '/r' } }),
      })
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body).toEqual({ ok: true, result: 'ran ready' })
      expect(seen[0]).toMatchObject({ sessionId: 'sLegacy', router: 'issues', proc: 'ready' })
    } finally {
      await srv.close()
    }
  })

  it('rejects a non-POST or bad path with 404', async () => {
    const srv = await startAgentRelayServer({ port: 0, relay: async () => ({ ok: true }) })
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/nope`, { method: 'GET' })
      expect(res.status).toBe(404)
    } finally {
      await srv.close()
    }
  })

  // Regression for the null-body crash: JSON.parse('null') returns null, and the old
  // `if (!body.proc)` guard dereferenced null → TypeError inside the `req.on('end')`
  // listener → uncaughtException → the daemon process exits (local crash-loop DoS).
  it('returns 400 for a null JSON body and stays up (crash regression)', async () => {
    let relayCalls = 0
    const srv = await startAgentRelayServer({
      port: 0,
      relay: async () => {
        relayCalls++
        return { ok: true, result: 'ok' }
      },
    })
    try {
      const res = await fetch(srv.endpointFor('sX'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: 'missing proc' })
      expect(relayCalls).toBe(0)
      // Server must still be alive and serving after the malformed request.
      const res2 = await fetch(srv.endpointFor('sX'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proc: 'ready' }),
      })
      expect(res2.status).toBe(200)
      expect(await res2.json()).toEqual({ ok: true, result: 'ok' })
      expect(relayCalls).toBe(1)
    } finally {
      await srv.close()
    }
  })

  it.each([['[]'], ['42'], ['"str"'], ['true']])(
    'returns 400 for a non-object JSON body %s',
    async (payload) => {
      const srv = await startAgentRelayServer({ port: 0, relay: async () => ({ ok: true }) })
      try {
        const res = await fetch(srv.endpointFor('sX'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ ok: false, error: 'missing proc' })
      } finally {
        await srv.close()
      }
    },
  )

  // Contract: a rejected relay is reported as a 200 with {ok:false, error} (not an HTTP 5xx),
  // so the CLI always parses a structured result rather than a transport failure.
  it('returns 200 {ok:false,error} when the relay rejects', async () => {
    const srv = await startAgentRelayServer({
      port: 0,
      relay: async () => {
        throw new Error('boom')
      },
    })
    try {
      const res = await fetch(srv.endpointFor('sX'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proc: 'ready' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: false, error: 'boom' })
    } finally {
      await srv.close()
    }
  })

  it('rejects an over-cap body with 413', async () => {
    let relayCalls = 0
    const srv = await startAgentRelayServer({
      port: 0,
      relay: async () => {
        relayCalls++
        return { ok: true }
      },
    })
    try {
      const huge = 'x'.repeat(1024 * 1024 + 1024) // > 1 MB cap
      const res = await fetch(srv.endpointFor('sX'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proc: 'ready', input: huge }),
      })
      expect(res.status).toBe(413)
      expect(relayCalls).toBe(0)
    } finally {
      await srv.close()
    }
  })
})
