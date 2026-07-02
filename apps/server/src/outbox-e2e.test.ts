import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppRouter } from './router'
import { startServer } from './server'

// Outbox write path e2e (docs/spec/outbox-write-path.md §4): idempotent replays
// over the REAL wiring — a booted server and actual HTTP tRPC, the seams the
// registry-level tests can't cover. No daemon attaches in this harness, so a
// created session stays 'starting' forever and a queued message remains durably
// parked — exactly the unreachable-agent shape the spec closes.
describe('outbox write path e2e (live server)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>
  const tmpDirs: string[] = []

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-outbox-e2e-'))
    tmpDirs.push(stateDir)
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({ port: 0 })
    trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${server.port}/trpc` })],
    })
  })
  afterAll(async () => {
    await server.close()
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
    delete process.env.PODIUM_STATE_DIR
  })

  it('replayed resumeAndSend returns the recorded result and leaves exactly ONE queued message', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'podium-outbox-e2e-cwd-'))
    tmpDirs.push(cwd)
    const { sessionId } = await trpc.sessions.create.mutate({ agentKind: 'shell', cwd })

    // No daemon → the session never binds; the send goes to the durable queue.
    const first = await trpc.sessions.resumeAndSend.mutate({
      sessionId,
      text: 'queued while offline',
      mutationId: 'e2e-send-1',
    })
    expect(first).toEqual({ ok: true, queued: true })

    // Network-retry replay with the SAME mutationId: same result, no second row.
    const replay = await trpc.sessions.resumeAndSend.mutate({
      sessionId,
      text: 'queued while offline',
      mutationId: 'e2e-send-1',
    })
    expect(replay).toEqual(first)

    // Verified through a separate query surface: the wire meta carries ONE
    // queued message, not two (invariant 4: wire count == table count).
    const sessions = await trpc.sessions.list.query()
    const meta = sessions.find((s) => s.sessionId === sessionId)
    expect(meta?.status).toBe('starting')
    expect(meta?.queuedMessageCount).toBe(1)
  })

  it('replayed issues.create returns the original issue; issues.list shows ONE issue', async () => {
    const input = {
      repoPath: '/repo',
      title: 'outbox e2e issue',
      startNow: false,
      mutationId: 'e2e-issue-1',
    }
    const created = await trpc.issues.create.mutate(input)
    expect(created.id).toBeTruthy()

    const replay = await trpc.issues.create.mutate(input)
    expect(replay.id).toBe(created.id)
    expect(replay.title).toBe('outbox e2e issue')

    const list = await trpc.issues.list.query({ repoPath: '/repo' })
    expect(list.filter((i) => i.title === 'outbox e2e issue')).toHaveLength(1)
  })
})
