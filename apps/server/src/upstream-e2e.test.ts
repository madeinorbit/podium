import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpstreamForwarder, UpstreamSync } from '@podium/sync'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPERATOR } from './issue-authz'
import { SessionRegistry, upstreamMirrorFor } from './relay'
import { type AppRouter, appRouter } from './router'
import { startServer } from './server'
import { SessionStore } from './store'

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
  let forwarder: UpstreamForwarder
  let hubClosed = false
  let hubPort = 0
  /** The hub issue under test (created below, edited via the node's router). */
  let hubIssueId = ''

  const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  const nodeHubSessions = () => nodeRegistry.modules.sessions.listSessions().filter((s) => s.viaHub)
  /** The node's issue WIRE (what a node client sees): local ∪ upstream. */
  const nodeIssueWire = () => {
    const snap = nodeRegistry.modules.sessions.syncChangesSince(null)
    return snap.kind === 'snapshot' ? snap.issues : []
  }
  /** An OPERATOR caller on the NODE's router — the real forwarding-detection seam. */
  const nodeCaller = () =>
    appRouter.createCaller({
      registry: nodeRegistry,
      repos: { list: () => [] } as never,
      superagent: {} as never,
      capability: OPERATOR,
    })

  beforeAll(async () => {
    hubStateDir = mkdtempSync(join(tmpdir(), 'podium-upstream-hub-'))
    process.env.PODIUM_STATE_DIR = hubStateDir
    hub = await startServer({ port: 0 })
    hubPort = hub.port
    trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${hub.port}/trpc` })],
    })
    token = hub.registry.mintUpstreamToken()

    nodeStore = new SessionStore(':memory:')
    nodeRegistry = new SessionRegistry(nodeStore)
    nodeRegistry.modules.sessions.attachDaemon('local', () => {})
    nodeRegistry.modules.sessions.setUpstreamOwnMachineIds([NODE_DAEMON_MACHINE_ID])
    // P7b write path: the forwarder shares the node store (durable outbox) and the
    // hub token; UpstreamSync's onConnected is its reconnect drain trigger.
    forwarder = new UpstreamForwarder({
      url: `http://127.0.0.1:${hubPort}`,
      token,
      store: nodeStore.sync,
      onQueueChanged: () => nodeRegistry.modules.upstreamIssues.outboxChanged(),
      retryMs: 100,
    })
    nodeRegistry.modules.upstreamIssues.setForwarder(forwarder)
    sync = new UpstreamSync({
      url: `http://127.0.0.1:${hub.port}`,
      token,
      mirror: upstreamMirrorFor(nodeRegistry.modules),
      store: nodeStore.settings,
      backoff: { minMs: 50, maxMs: 250 },
      onConnected: () => void forwarder.drain(),
    })
    sync.start()
  })

  afterAll(async () => {
    sync.stop()
    forwarder.stop()
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
    hub.registry.modules.machines.authenticateDaemon({
      type: 'pair',
      code: hub.registry.modules.machines.mintPairingCode(),
      machineId: NODE_DAEMON_MACHINE_ID,
      hostname: 'the-node',
    })
    hub.registry.modules.sessions.attachDaemon(NODE_DAEMON_MACHINE_ID, () => {})
    const echo = hub.registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/node/own',
      machineId: NODE_DAEMON_MACHINE_ID,
    })
    // Detach the fake node daemon again so later unspecified creates don't route
    // to it (the hub would otherwise place them on the sole online machine).
    hub.registry.modules.sessions.detachDaemon(NODE_DAEMON_MACHINE_ID)
    const other = await trpc.sessions.create.mutate({ agentKind: 'shell', cwd: '/hub/repo-c' })
    // The later non-echo session arriving proves the echo one was seen and skipped.
    await until(() => nodeHubSessions().some((s) => s.sessionId === other.sessionId))
    expect(nodeHubSessions().some((s) => s.sessionId === echo.sessionId)).toBe(false)
  })

  it('stores hub issues durably WITHOUT merging them into the node tracker', async () => {
    const created = await trpc.issues.create.mutate({
      repoPath: '/hub/repo-a',
      title: 'hub issue',
      startNow: false,
    })
    if ('queued' in created) throw new Error('hub-side create unexpectedly queued')
    hubIssueId = created.id
    await until(() => (nodeStore.settings.getUpstreamIssuesJson() ?? '').includes('hub issue'))
    const parked = JSON.parse(nodeStore.settings.getUpstreamIssuesJson() ?? '[]') as Array<{
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
      mirror: upstreamMirrorFor(nodeRegistry.modules),
      store: nodeStore.settings, // same store — the persisted cursor is the resume point
      backoff: { minMs: 50, maxMs: 250 },
      onConnected: () => void forwarder.drain(),
    })
    sync.start()
    await until(() => nodeHubSessions().some((s) => s.sessionId === created.sessionId))
    // The catch-up was a DELTA from the persisted cursor — the whole point of §2.2.
    expect(sync.lastCatchUpKind).toBe('delta')
  })

  // ---- P7b: viaHub issues on the node's wire + write forwarding ----
  // (docs/spec/node-hub-issues.md §4 — the acceptance narrative, end to end.)

  it("P7b: the hub issue appears in the node's issue STREAM, viaHub-marked, store-pure", async () => {
    await until(() => nodeIssueWire().some((i) => i.id === hubIssueId))
    const wire = nodeIssueWire().find((i) => i.id === hubIssueId)
    expect(wire?.viaHub).toBe(true)
    expect(wire?.title).toBe('hub issue')
    // Invariant 1: the wire is the ONLY place it exists node-side.
    expect(nodeRegistry.issues.get(hubIssueId)).toBeNull()
    expect(nodeStore.issues.listIssueRows()).toHaveLength(0)
  })

  it('P7b: editing a viaHub issue while the hub is UP changes the HUB store; the node converges via delta', async () => {
    const res = await nodeCaller().issues.update({
      id: hubIssueId,
      patch: { title: 'renamed-via-node' },
    })
    // Hub reachable → the hub's own result comes back, not a queue receipt.
    if ('queued' in res) throw new Error('unexpected queue while hub is up')
    expect(res.title).toBe('renamed-via-node')
    // Hub store truth changed…
    expect(hub.registry.issues.get(hubIssueId)?.title).toBe('renamed-via-node')
    // …and the node's replica converges through the live delta, no pendingSync.
    await until(() =>
      nodeIssueWire().some((i) => i.id === hubIssueId && i.title === 'renamed-via-node'),
    )
    expect(nodeIssueWire().find((i) => i.id === hubIssueId)?.pendingSync).toBeUndefined()
    expect(nodeStore.sync.listUpstreamOutbox()).toHaveLength(0)
  })

  it('P7b: editing while the hub is DOWN queues durably; a hub restart applies it EXACTLY once and clears pendingSync', async () => {
    await hub.close()
    hubClosed = true
    // Node-side edit while offline: queued receipt + optimistic pendingSync wire.
    const res = await nodeCaller().issues.addComment({
      id: hubIssueId,
      author: 'node-op',
      body: 'offline comment',
    })
    expect(res).toEqual({ queued: true })
    const outbox = nodeStore.sync.listUpstreamOutbox()
    expect(outbox).toHaveLength(1)
    const mutationId = outbox[0]?.mutationId ?? ''
    expect(mutationId).not.toBe('')
    const pending = nodeIssueWire().find((i) => i.id === hubIssueId)
    expect(pending?.pendingSync).toBe(true)
    // #175: comment bodies left the wire — the optimistic effect is the count bump.
    expect(pending?.commentCount).toBe(1)
    // Invariant 3: local issues are completely unaffected while the hub is down.
    const localIssue = await nodeRegistry.issues.createAndMaybeStart({
      repoPath: '/node/repo',
      title: 'purely local',
      startNow: false,
    })
    expect(nodeRegistry.issues.get(localIssue.id)?.title).toBe('purely local')

    // Hub returns (same state dir + port): reconnect heals, the outbox drains.
    hub = await startServer({ port: hubPort })
    hubClosed = false
    await until(() => nodeStore.sync.listUpstreamOutbox().length === 0, 10_000)
    // EXACTLY ONE application, asserted via hub issue state + the hub's
    // idempotency record for the entry's mutationId (invariant 2).
    const applied = () =>
      // #175: read the hub's thread via comments() — bodies are not on the wire.
      hub.registry.issues.comments(hubIssueId).filter((c) => c.body === 'offline comment')
    expect(applied()).toHaveLength(1)
    expect(hub.registry.sessionStore.sync.getAppliedMutation(mutationId)).toBeDefined()
    // Belt-and-braces: replay the SAME mutation again (a lost-ack retry) — the
    // hub returns the recorded result instead of applying twice.
    await forwarder.forward('addComment', {
      id: hubIssueId,
      author: 'node-op',
      body: 'offline comment',
      mutationId,
    })
    expect(applied()).toHaveLength(1)
    // The hub's post-restart truth reaches the node and pendingSync clears.
    await until(() => {
      const entry = nodeIssueWire().find((i) => i.id === hubIssueId)
      // #175: hub truth carries the count, not the bodies.
      return entry?.pendingSync === undefined && entry?.commentCount === 1
    }, 10_000)
  })

  it('hub stopped → mirrored entries stale-flagged and RETAINED; node-local work unaffected', async () => {
    const before = nodeHubSessions().length
    expect(before).toBeGreaterThan(0)
    const local = nodeRegistry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/node/local' })

    await hub.close()
    hubClosed = true
    await until(() => nodeHubSessions().every((s) => s.upstreamStale === true))
    // Retained (stale-visible, never blank) …
    expect(nodeHubSessions().length).toBe(before)
    // … while local entities never carry upstream flags and keep working.
    const localMeta = nodeRegistry.modules.sessions.listSessions().find((s) => s.sessionId === local.sessionId)
    expect(localMeta).toBeDefined()
    expect(localMeta?.viaHub).toBeUndefined()
    expect(localMeta?.upstreamStale).toBeUndefined()
    expect(nodeRegistry.modules.sessions.renameSession({ sessionId: local.sessionId, name: 'still-mine' }))
    expect(nodeRegistry.modules.sessions.listSessions().find((s) => s.sessionId === local.sessionId)?.name).toBe(
      'still-mine',
    )
  })
})
