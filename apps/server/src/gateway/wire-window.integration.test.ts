/**
 * THE ROLLOUT WINDOW, AGAINST A REAL SERVER (POD-1203, POD-308 AC 4, POD-1316).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AND WHY POD-308 REFUSED TO WRITE IT
 * ---------------------------------------------------------------------------
 *
 * POD-308 shipped the version-negotiation mechanism with nothing calling it, and
 * declined this verification in one line: *"verifying a 426 against an edge
 * nothing constructs would be a test of my fixture."* That was right. The
 * construction site exists now — `gateway/feed-serving.ts`, wired into the client
 * mux — so the claim is testable against the product, and the shape of the test
 * is what makes it a product claim: a real `startServer`, real WebSockets, real
 * JSON frames, and clients that announce themselves exactly as the shipped
 * builds do.
 *
 * ---------------------------------------------------------------------------
 * AUTHENTICATION IS NOT OPTIONAL (POD-317 / POD-1356 / this issue)
 * ---------------------------------------------------------------------------
 *
 * Every real `/client` upgrade is refused unless the handshake carries a
 * session cookie minted through the real login route. An unauthenticated
 * socket never reaches version negotiation — it dies at the cookie gate
 * (`client-socket.ts`), and waiting for frames from it is a 20s false positive
 * for "the wire window is broken". This suite logs in once via
 * `loginTestClient` and passes `Cookie` on every handshake.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PEERS, under today's composition
 * ---------------------------------------------------------------------------
 *
 * Production names `GrantEdgeVisibilityPolicy` (relay.ts) — grade
 * `per-principal`. That makes TWO independent refusal arms live on the same
 * edge (POD-376): the version window, and the scoping gate.
 *
 *   1. A STALE PWA. `hello` carries caps but NO `wireVersion` field (pre-cutover
 *      builds). Absence means wire 1. Wire 1 cannot express `evict`, so against
 *      a per-principal authority the peer is refused at admission with
 *      `scoping-requires-eviction` — silence on the entity plane. The advertised
 *      window still includes 1 (`MIN_SUPPORTED_VERSION`); what refuses it is this
 *      deployment's visibility grade, not the version floor. (Under
 *      `device-unscoped` the same peer would be admitted; that arm is covered by
 *      `wire-feed-edge.test.ts`, not by a real-server integration.)
 *   2. A CURRENT BUILD, announcing wire 2. Served the canonical frames.
 *   3. A PEER OUTSIDE THE WINDOW, announcing a version this server does not
 *      support. Refused with `unsupported-version`: no entity frames after
 *      `hello`, control plane still works (`welcome`).
 *
 * The refusing arms depend on facts this file sets directly — a missing
 * `wireVersion` (→ 1) and a `wireVersion` outside
 * `[MIN_SUPPORTED_VERSION, WIRE_VERSION]` — and there is no privileged client
 * that skips the check. Do not raise the test deadline to paper over a refusal:
 * a fixed-deadline wait that always times out can no longer say NO.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage } from '@podium/protocol'
import { CAP_METADATA_DELTA, MIN_SUPPORTED_VERSION, WIRE_VERSION } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startServer } from '../server'
import { loginTestClient } from '../test-support/client-auth'

const CLIENT_PASSWORD = 'wire-window-client-password'

const ENTITY_FRAMES = new Set([
  'sessionsChanged',
  'issuesChanged',
  'conversationsChanged',
  'automationsChanged',
  'automationRunsChanged',
  'metadataDelta',
  'feedBootstrap',
  'feedDelta',
])

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('the wire window, over real sockets', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let cookieHeader: string
  let machineId: string
  let originalPassword: string | undefined

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-wire-window-'))
    process.env.PODIUM_STATE_DIR = stateDir
    originalPassword = process.env.PODIUM_PASSWORD
    process.env.PODIUM_PASSWORD = CLIENT_PASSWORD
    handle = await startServer({ port: 0 })
    cookieHeader = (
      await loginTestClient({
        origin: `http://127.0.0.1:${handle.port}`,
        password: CLIENT_PASSWORD,
      })
    ).cookieHeader
    machineId = handle.registry.modules.machines.hostMachineId
    handle.registry.gateway.attachDaemon(machineId, () => {})
    handle.registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo/before-the-deploy',
      machineId,
    })
    handle.registry.modules.sessions.flushBroadcasts()
  })

  afterAll(async () => {
    await handle?.close()
    process.env.PODIUM_STATE_DIR = priorStateDir
    if (originalPassword === undefined) delete process.env.PODIUM_PASSWORD
    else process.env.PODIUM_PASSWORD = originalPassword
    rmSync(stateDir, { recursive: true, force: true })
  })

  /** A real `/client` socket that announces itself the way a build does. */
  async function connect(hello: Record<string, unknown>) {
    const frames: ServerMessage[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/client`, {
      headers: { Cookie: cookieHeader },
    })
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerMessage))
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    // `clientId` and `viewport` are required by the frame schema; every shipped
    // client sends them and a frame without them is dropped before it is routed.
    ws.send(
      JSON.stringify({
        type: 'hello',
        clientId: '',
        viewport: { cols: 80, rows: 24, dpr: 1 },
        ...hello,
      }),
    )
    return {
      ws,
      frames,
      types: () => frames.map((m) => m.type),
      nextMatching(pred: (m: ServerMessage) => boolean): Promise<ServerMessage> {
        const already = frames.find(pred)
        if (already) return Promise.resolve(already)
        return new Promise((resolve) => {
          const onMessage = (raw: import('ws').RawData) => {
            const msg = JSON.parse(raw.toString()) as ServerMessage
            if (!pred(msg)) return
            ws.off('message', onMessage)
            resolve(msg)
          }
          ws.on('message', onMessage)
        })
      },
    }
  }

  it('serves a current build; refuses wire-1 under per-principal scoping and peers beyond the window', async () => {
    // 1. THE STALE PWA — no `wireVersion` in its hello. Under production
    //    `GrantEdgeVisibilityPolicy` this is refused at admission (see header).
    const stale = await connect({ caps: [CAP_METADATA_DELTA] })
    // 2. THE CURRENT BUILD.
    const current = await connect({ caps: [CAP_METADATA_DELTA], wireVersion: WIRE_VERSION })
    // 3. BEYOND THE WINDOW.
    const beyond = await connect({ caps: [CAP_METADATA_DELTA], wireVersion: WIRE_VERSION + 1 })

    // Control plane works for every admitted socket (auth + welcome), including
    // the two peers the entity plane will refuse. Wait on current's world first
    // so the refusals below are asserted after hello has been processed, not by
    // spinning until the deadline.
    await Promise.all([
      stale.nextMatching((m) => m.type === 'welcome'),
      current.nextMatching((m) => m.type === 'welcome'),
      beyond.nextMatching((m) => m.type === 'welcome'),
    ])

    // THE CURRENT BUILD IS SERVED ITS WORLD IN ITS OWN VERSION. It was admitted
    // at wire 1 before it said anything — the only honest default for a socket
    // that has not spoken — but against a per-principal authority that pre-hello
    // attach is itself refused (wire 1 cannot express `evict`). Its `hello` then
    // announces wire 2 and the world is served as a `feedBootstrap`. A world
    // expressed in a dialect the peer never advertised is exactly what the window
    // exists to prevent.
    const currentWorld = (await current.nextMatching((m) => m.type === 'feedBootstrap')) as {
      seq: number
      changes: { entity: string; value?: { cwd?: string } | null }[]
    }
    expect(currentWorld.changes.some((c) => c.entity === 'session')).toBe(true)
    expect(
      currentWorld.changes.some(
        (c) => c.entity === 'session' && c.value?.cwd === '/repo/before-the-deploy',
      ),
    ).toBe(true)

    // Snapshot refused peers AFTER the admitted peer has been fully served: by
    // then their hellos have been processed (connect order is stale → current →
    // beyond, and current's bootstrap only runs after its own hello).
    const staleAfterHello = stale.frames.length
    const beyondAfterHello = beyond.frames.length

    // A write AFTER all three connected.
    handle.registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo/after-the-deploy',
      machineId,
    })
    handle.registry.modules.sessions.flushBroadcasts()

    // The current build gets the canonical frame for the write.
    const currentDelta = (await current.nextMatching((m) => m.type === 'feedDelta')) as {
      fromSeq: number
      seq: number
      minAvailableSeq: number
      changes: { entity: string; value?: { cwd?: string } | null }[]
    }
    expect(currentDelta.fromSeq).toBe(currentWorld.seq)
    expect(currentDelta.minAvailableSeq).toBeGreaterThanOrEqual(0)
    expect(
      currentDelta.changes.some(
        (c) => c.entity === 'session' && c.value?.cwd === '/repo/after-the-deploy',
      ),
    ).toBe(true)

    // THE REFUSALS. Control plane works (`welcome` asserted above). From the
    // moment each peer announced a version this server will not serve on the
    // entity plane, it receives NO entity frame in either wire's vocabulary.
    //
    //   stale  → scoping-requires-eviction (wire 1 + per-principal)
    //   beyond → unsupported-version (outside [min, wire])
    //
    // There is no `426` ServerMessage for either — client-mux leaves the peer
    // registered for control traffic and sets `entityServingRefused` so the
    // prepared-publication worker also stops (see client-mux.renegotiate). The
    // browser's own version guard polls `/version` and hard-reloads; that is the
    // working half of the backstop, asserted below.
    expect(stale.types().slice(staleAfterHello).filter((t) => ENTITY_FRAMES.has(t))).toEqual([])
    expect(beyond.types().slice(beyondAfterHello).filter((t) => ENTITY_FRAMES.has(t))).toEqual([])
    // …and the paired half, or "it received nothing" is equally true of a socket
    // that was never connected: the supported peer DID receive entity frames over
    // the same window.
    expect(current.types().filter((t) => ENTITY_FRAMES.has(t)).length).toBeGreaterThan(0)

    // …and the contract its self-update is driven by. `apps/web`'s version guard
    // fetches exactly this and hard-reloads when its own WIRE_VERSION is below
    // `minSupportedVersion` or differs from `wireVersion`, which is the working
    // half of the 426 backstop for a browser holding a cached bundle.
    // `feedScoping` is why wire 1 is refused here even though min is still 1.
    const version = (await (await fetch(`http://127.0.0.1:${handle.port}/version`)).json()) as {
      wireVersion: number
      minSupportedVersion: number
      feedScoping: string
    }
    expect(version).toMatchObject({
      wireVersion: WIRE_VERSION,
      minSupportedVersion: MIN_SUPPORTED_VERSION,
      feedScoping: 'per-principal',
    })
    // The floor still admits 1 in the advertised window — the stale refusal is
    // the scoping gate, not a raised MIN_SUPPORTED_VERSION.
    expect(version.minSupportedVersion).toBeLessThanOrEqual(1)

    for (const peer of [stale, current, beyond]) peer.ws.close()
  })
})
