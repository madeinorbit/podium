import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '@podium/runtime/config'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { noJanitorWorkerForTests } from './janitor-host'
import type { AppRouter } from './router'
import { startServer } from './server'
import { attachHostDaemon } from './test-support/host-daemon'

// Outbox write path e2e (docs/spec/outbox-write-path.md §4): idempotent replays
// over the REAL wiring — a booted server and actual HTTP tRPC, the seams the
// registry-level tests can't cover. The fixture daemon disappears before binding,
// so the accepted session stays 'starting' and a queued message remains durably
// parked — exactly the unreachable-agent shape the spec closes.
const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('outbox write path e2e (live server)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>
  const tmpDirs: string[] = []

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-outbox-e2e-'))
    tmpDirs.push(stateDir)
    process.env.PODIUM_STATE_DIR = stateDir
    saveConfig({ mode: 'all-in-one' })
    server = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port: 0 })
    await attachHostDaemon(server.registry, () => {}, { repos: ['/repo'] })
    trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${server.port}/trpc` })],
    })
  })
  afterAll(async () => {
    await server.close()
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
    process.env.PODIUM_STATE_DIR = priorStateDir
  })

  it('replayed resumeAndSend returns the recorded result and leaves exactly ONE queued message', async () => {
    const mutationId = `msg_${randomUUID()}`
    const cwd = mkdtempSync(join(tmpdir(), 'podium-outbox-e2e-cwd-'))
    tmpDirs.push(cwd)
    await attachHostDaemon(server.registry, () => {}, { repos: [cwd, '/repo'] })
    const { sessionId } = await trpc.sessions.create.mutate({ agentKind: 'shell', cwd })

    // The machine accepted the spawn but disappeared before binding it.
    // Creation itself requires an available execution machine.
    await server.registry.gateway.detachDaemon(server.registry.sessionStore.hostMachineId)

    // No daemon → the session never binds; the send goes to the durable queue.
    const first = await trpc.sessions.resumeAndSend.mutate({
      sessionId,
      text: 'queued while offline',
      mutationId,
    })
    // Parked/unbound session → durably queued to its boot queue; the honest
    // disposition rides the result (#834) and is recorded/replayed with it.
    expect(first).toEqual({ ok: true, queued: true, disposition: 'queued' })

    // Network-retry replay with the SAME mutationId: same result, no second row.
    const replay = await trpc.sessions.resumeAndSend.mutate({
      sessionId,
      text: 'queued while offline',
      mutationId,
    })
    expect(replay).toEqual(first)

    // The session remains unbound, and the durable mail ledger contains one
    // accepted send. Queued chat sends no longer use the legacy typing queue.
    const sessions = await trpc.sessions.list.query()
    const meta = sessions.find((s) => s.sessionId === sessionId)
    expect(meta?.status).toBe('starting')
    const queued = await server.registry.sessionStore.messages.listMessagesFor({
      kind: 'session',
      id: sessionId,
    })
    expect(queued).toEqual([
      expect.objectContaining({ body: 'queued while offline', deliveryStatus: 'stored' }),
    ])
    expect(new Set(queued.map((message) => message.id)).size).toBe(1)

    // Reconnecting the machine is not evidence that this PTY exists yet.
    const sent: import('@podium/protocol/daemon').ControlMessage[] = []
    await attachHostDaemon(server.registry, (message) => {
      sent.push(message)
    })
    expect(sent.filter((message) => message.type === 'input')).toEqual([])
    const stillQueued = await server.registry.sessionStore.messages.listMessagesFor({
      kind: 'session',
      id: sessionId,
    })
    expect(stillQueued).toEqual([
      expect.objectContaining({ body: 'queued while offline', deliveryStatus: 'stored' }),
    ])

    await server.registry.gateway.routeDaemonFrame(server.registry.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'sh',
      cwd,
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    const inputs = () => sent.filter((message) => message.type === 'input')
    expect(inputs()).toHaveLength(2)
    const delivered = await server.registry.sessionStore.messages.listMessagesFor({
      kind: 'session',
      id: sessionId,
    })
    expect(delivered).toEqual([
      expect.objectContaining({ id: queued[0]!.id, deliveryStatus: 'confirmed' }),
    ])
    expect(
      await trpc.sessions.resumeAndSend.mutate({
        sessionId,
        text: 'queued while offline',
        mutationId,
      }),
    ).toEqual(first)
    expect(inputs()).toHaveLength(2)
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
