import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { makeIssueClient, makeRelayIssueClient } from './issue-client'

describe('makeIssueClient', () => {
  it('builds a client (smoke)', () => {
    expect(makeIssueClient('http://localhost:1')).toBeDefined()
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
      const client = makeRelayIssueClient(`http://127.0.0.1:${port}/issue/s1`, { outsideScope: true })
      const rows = await (client as any).issues.ready.query({ repoPath: '/r' })
      expect(rows).toEqual([{ seq: 1, title: 'X' }])
      expect(received[0]).toEqual({ router: 'issues', proc: 'ready', input: { repoPath: '/r' }, outsideScope: true })
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
      await expect((client as any).issues.update.mutate({ id: 'B' })).rejects.toThrow(/outside your subtree/)
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
