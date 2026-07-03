import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import type { AppRouter } from './router'
import { startServer } from './server'
import { SessionStore } from './store'
import { UpstreamSync } from './upstream'

// Node⇄hub sync e2e over the REAL wiring (docs/spec/node-hub-sync.md §4): a
// booted HUB server (startServer — real WS upgrades, real HTTP tRPC), a NODE
// registry running UpstreamSync against it with a hub-minted token. Covers the
// acceptance flow end-to-end: mirror bootstrap, live delta updates, own-machine
// echo filtering, cursor resume across an UpstreamSync restart (delta, not
// snapshot), issues stored-not-merged, and hub-stop → stale-but-retained.
describe('node⇄hub upstream sync e2e (live hub server)', () => {
  let hubStateDir: string
  let hub: Awaited<ReturnType<typeof startServer>>
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>
  let token: string
  const NODE_DAEMON_MACHINE_ID = 'node-daemon-id'

  // The NODE: a bare registry + store (the same objects startServer would wire) —
  // env-free, so it can't collide with the hub's PODIUM_STATE_DIR.
  let nodeStore: SessionStore
  let nodeRegistry: SessionRegistry
  let sync: UpstreamSync
  let hubClosed = false

  const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  const nodeHubSessions = () => nodeRegistry.listSessions().filter((s) => s.viaHub)

  beforeAll(async () => {
    hubStateDir = mkdtempSync(join(tmpdir(), 'podium-upstream-hub-'))
    process.env.PODIUM_STATE_DIR = hubStateDir
    hub = await startServer({ port: 0 })
    trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${hub.port}/trpc` })],
    })
    token = hub.registry.mintUpstreamToken()

    nodeStore = new SessionStore(':memory:')
    nodeRegistry = new SessionRegistry(nodeStore)
    nodeRegistry.attachDaemon('local', () => {})
    nodeRegistry.setUpstreamOwnMachineIds([NODE_DAEMON_MACHINE_ID])
    sync = new UpstreamSync({
      url: `http://127.0.0.1:${hub.port}`,
      token,
      mirror: nodeRegistry,
      store: nodeStore,
      backoff: { minMs: 50, maxMs: 250 },
    })
    sync.start()
  })

  afterAll(async () => {
    sync.stop()
    nodeRegistry.dispose()
    nodeStore.close()
    if (!hubClosed) await hub.close()
    rmSync(hubStateDir, { recursive: true, force: true })
    delete process.env.PODIUM_STATE_DIR
  })

  it('mirrors hub sessions into the node registry, viaHub-marked', async () => {
    await trpc.sessions.create.mutate({ agentKind: 'shell', cwd: '/hub/repo-a' })
    await trpc.sessions.create.mutate({ agentKind: 'shell', cwd: '/hub/repo-b' })

    await until(() => nodeHubSessions().length === 2)
    const mirrored = nodeHubSessions()
    expect(mirrored.every((s) => s.viaHub === true)).toBe(true)
    expect(mirrored.every((s) => s.upstreamStale === undefined)).toBe(true)
    expect(mirrored.map((s) => s.cwd).sort()).toEqual(['/hub/repo-a', '/hub/repo-b'])
    // machineName from the hub payload rides through (the hub's local machine).
    expect(mirrored.every((s) => typeof s.machineName === 'string')).toBe(true)
  })

  it('flows LIVE delta updates (a hub-side rename shows up on the node)', async () => {
    const target = nodeHubSessions()[0]
    if (!target) throw new Error('no mirrored session')
    await trpc.sessions.rename.mutate({ sessionId: target.sessionId, name: 'renamed-on-hub' })
    await until(() =>
      nodeHubSessions().some(
        (s) => s.sessionId === target.sessionId && s.name === 'renamed-on-hub',
      ),
    )
  })

  it("filters the node's own machine out of the mirror (no echo)", async () => {
    // The node's daemon paired with the hub: its machine registers hub-side and
    // runs a session there. That session must NOT mirror back to the node.
    hub.registry.authenticateDaemon({
      type: 'pair',
      code: hub.registry.mintPairingCode(),
      machineId: NODE_DAEMON_MACHINE_ID,
      hostname: 'the-node',
    })
    hub.registry.attachDaemon(NODE_DAEMON_MACHINE_ID, () => {})
    const echo = hub.registry.createSession({
      agentKind: 'shell',
      cwd: '/node/own',
      machineId: NODE_DAEMON_MACHINE_ID,
    })
    // Detach the fake node daemon again so later unspecified creates don't route
    // to it (the hub would otherwise place them on the sole online machine).
    hub.registry.detachDaemon(NODE_DAEMON_MACHINE_ID)
    const other = await trpc.sessions.create.mutate({ agentKind: 'shell', cwd: '/hub/repo-c' })
    // The later non-echo session arriving proves the echo one was seen and skipped.
    await until(() => nodeHubSessions().some((s) => s.sessionId === other.sessionId))
    expect(nodeHubSessions().some((s) => s.sessionId === echo.sessionId)).toBe(false)
  })

  it('stores hub issues durably WITHOUT merging them into the node tracker', async () => {
    await trpc.issues.create.mutate({
      repoPath: '/hub/repo-a',
      title: 'hub issue',
      startNow: false,
    })
    await until(() => (nodeStore.getUpstreamIssuesJson() ?? '').includes('hub issue'))
    const parked = JSON.parse(nodeStore.getUpstreamIssuesJson() ?? '[]') as Array<{
      title: string
    }>
    expect(parked.some((i) => i.title === 'hub issue')).toBe(true)
    // Deliberately NOT merged (P7b): the node's own IssueService stays empty.
    expect(nodeRegistry.issues.allWire()).toHaveLength(0)
  })

  it('resumes from the persisted cursor across an UpstreamSync restart (delta, not snapshot)', async () => {
    sync.stop()
    // Hub state advances while the node's sync is down.
    const created = await trpc.sessions.create.mutate({ agentKind: 'shell', cwd: '/hub/repo-d' })

    sync = new UpstreamSync({
      url: `http://127.0.0.1:${hub.port}`,
      token,
      mirror: nodeRegistry,
      store: nodeStore, // same store — the persisted cursor is the resume point
      backoff: { minMs: 50, maxMs: 250 },
    })
    sync.start()
    await until(() => nodeHubSessions().some((s) => s.sessionId === created.sessionId))
    // The catch-up was a DELTA from the persisted cursor — the whole point of §2.2.
    expect(sync.lastCatchUpKind).toBe('delta')
  })

  it('hub stopped → mirrored entries stale-flagged and RETAINED; node-local work unaffected', async () => {
    const before = nodeHubSessions().length
    expect(before).toBeGreaterThan(0)
    const local = nodeRegistry.createSession({ agentKind: 'shell', cwd: '/node/local' })

    await hub.close()
    hubClosed = true
    await until(() => nodeHubSessions().every((s) => s.upstreamStale === true))
    // Retained (stale-visible, never blank) …
    expect(nodeHubSessions().length).toBe(before)
    // … while local entities never carry upstream flags and keep working.
    const localMeta = nodeRegistry.listSessions().find((s) => s.sessionId === local.sessionId)
    expect(localMeta).toBeDefined()
    expect(localMeta?.viaHub).toBeUndefined()
    expect(localMeta?.upstreamStale).toBeUndefined()
    expect(nodeRegistry.renameSession({ sessionId: local.sessionId, name: 'still-mine' }))
    expect(nodeRegistry.listSessions().find((s) => s.sessionId === local.sessionId)?.name).toBe(
      'still-mine',
    )
  })
})
