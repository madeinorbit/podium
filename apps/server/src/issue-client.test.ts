import { createServer } from 'node:http'
import { makeIssueClient, makeRelayIssueClient } from '@podium/issue-client'
import { describe, expect, it } from 'vitest'

/** Start a one-shot HTTP server; returns its base URL and a close(). Each test gets
 *  its own so the port is never shared under a parallel run. */
async function serve(
  handler: (req: any, res: any) => void,
): Promise<{ url: string; close: () => void }> {
  const srv = createServer(handler)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as any).port
  return { url: `http://127.0.0.1:${port}`, close: () => srv.close() }
}

describe('makeIssueClient', () => {
  it('builds a client (smoke)', () => {
    expect(makeIssueClient('http://localhost:1')).toBeDefined()
  })

  // POD-1376: a password-protected instance answers the gated /trpc surface with
  // `{"error":"unauthorized"}` — plain JSON, NOT a tRPC envelope. Left to tRPC that
  // dies in the transformer as "Unable to transform response from server", which names
  // a serialization mismatch and sends the reader to the wrong file. Surface the status
  // and the body instead.
  it('surfaces an unauthorized non-envelope body instead of a transform error', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
    })
    try {
      const client = makeIssueClient(srv.url)
      const p = (client as any).issues.stats.query({})
      await expect(p).rejects.toThrow(/HTTP 401/)
      await expect(p).rejects.toThrow(/unauthorized/)
      await expect(p).rejects.not.toThrow(/transform/i)
    } finally {
      srv.close()
    }
  })

  // The 401 is the one status where the CLI can say what to DO about it.
  it('names the credential fix on a 401', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
    })
    try {
      const client = makeIssueClient(srv.url)
      await expect((client as any).issues.stats.query({})).rejects.toThrow(
        /podium auth mint-session/,
      )
    } finally {
      srv.close()
    }
  })

  // POD-1376 follow-up. "Mint a session" is the WRONG advice when a session was already
  // sent — that told an operator to do the thing they had just done, and the message never
  // said the credential had been rejected. Expired and revoked both land here.
  it('says the credential was rejected when one WAS carried', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
    })
    try {
      const client = makeIssueClient(srv.url, { sessionToken: 'stale-token' })
      const call = (client as any).issues.stats.query({})
      await expect(call).rejects.toThrow(/rejected/)
      await expect(call).rejects.toThrow(/expired or been revoked/)
      await expect(call).rejects.toThrow(/HTTP 401/)
    } finally {
      srv.close()
    }
  })

  // The guard must NOT swallow ordinary procedure errors: tRPC answers those with a
  // real envelope under a 4xx/5xx, and their message is the whole point.
  it('lets a tRPC error envelope through so the procedure message still renders', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify([
          {
            error: {
              message: 'issue is not proposed',
              code: -32600,
              data: { code: 'BAD_REQUEST', httpStatus: 400, path: 'issues.promote' },
            },
          },
        ]),
      )
    })
    try {
      const client = makeIssueClient(srv.url)
      await expect((client as any).issues.promote.mutate({ id: 'POD-1' })).rejects.toThrow(
        /issue is not proposed/,
      )
    } finally {
      srv.close()
    }
  })

  // A 2xx envelope is the ordinary path — the guard must be invisible to it.
  it('returns a successful result unchanged', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ result: { data: { open: 3 } } }]))
    })
    try {
      const client = makeIssueClient(srv.url)
      expect(await (client as any).issues.stats.query({})).toEqual({ open: 3 })
    } finally {
      srv.close()
    }
  })

  // POD-1376 part 2: the operator's credential rides as the same podium_session cookie
  // the browser login uses, so the server's existing clientAuthGuard accepts it as-is.
  it('sends the session token as the podium_session cookie', async () => {
    const cookies: (string | undefined)[] = []
    const srv = await serve((req, res) => {
      cookies.push(req.headers.cookie)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ result: { data: { open: 0 } } }]))
    })
    try {
      const client = makeIssueClient(srv.url, { sessionToken: 'tok-abc' })
      await (client as any).issues.stats.query({})
      expect(cookies[0]).toContain('podium_session=tok-abc')
    } finally {
      srv.close()
    }
  })

  it('sends no cookie when there is no session token', async () => {
    const cookies: (string | undefined)[] = []
    const srv = await serve((req, res) => {
      cookies.push(req.headers.cookie)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ result: { data: { open: 0 } } }]))
    })
    try {
      const client = makeIssueClient(srv.url)
      await (client as any).issues.stats.query({})
      expect(cookies[0]).toBeUndefined()
    } finally {
      srv.close()
    }
  })
})

describe('makeRelayIssueClient', () => {
  it('relay client POSTs router/proc/input and returns result', async () => {
    const received: any[] = []
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString()))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: [{ seq: 1, title: 'X' }] }))
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as any).port
    try {
      const client = makeRelayIssueClient(`http://127.0.0.1:${port}/issue/s1`, {
        outsideScope: true,
      })
      const rows = await (client as any).issues.ready.query({ repoPath: '/r' })
      expect(rows).toEqual([{ seq: 1, title: 'X' }])
      expect(received[0]).toEqual({
        router: 'issues',
        proc: 'ready',
        input: { repoPath: '/r' },
        outsideScope: true,
      })
    } finally {
      srv.close()
    }
  })

  it('relay client throws the server error on ok:false', async () => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'outside your subtree' }))
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as any).port
    try {
      const client = makeRelayIssueClient(`http://127.0.0.1:${port}/issue/s1`)
      await expect((client as any).issues.update.mutate({ id: 'B' })).rejects.toThrow(
        /outside your subtree/,
      )
    } finally {
      srv.close()
    }
  })

  // The daemon relay answers 404/413 with an EMPTY body; parsing that as JSON yields
  // "Unexpected end of JSON input", masking the real HTTP failure. The client must
  // surface the status instead.
  it('relay client throws the HTTP status on a non-ok empty response', async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as any).port
    try {
      const client = makeRelayIssueClient(`http://127.0.0.1:${port}/issue/s1`)
      const p = (client as any).issues.ready.query({ repoPath: '/r' })
      await expect(p).rejects.toThrow(/HTTP 404/)
      await expect(p).rejects.not.toThrow(/JSON/)
    } finally {
      srv.close()
    }
  })
})
