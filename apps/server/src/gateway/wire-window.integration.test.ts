/**
 * THE ROLLOUT WINDOW, AGAINST A REAL SERVER (POD-1203, POD-308 AC 4).
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
 * THE THREE PEERS, and what each one stands for:
 *
 *   1. A STALE PWA. A build cached before the cutover: its `hello` carries caps
 *      but NO `wireVersion` field, because it was compiled before that field
 *      existed. The absence IS the advertisement, and it must keep working —
 *      that is the whole point of the window.
 *   2. A CURRENT BUILD, announcing wire 2. Served the canonical frames.
 *   3. A PEER OUTSIDE THE WINDOW, announcing a version this server does not
 *      support. Refused: it must be served NO entity frames, because a frame it
 *      cannot parse is worse than none, and its self-update is driven by the
 *      `/version` contract asserted here.
 *
 * The refusing arm depends on a fact this file sets directly — a `wireVersion`
 * outside `[MIN_SUPPORTED_VERSION, WIRE_VERSION]` — and there is no privileged
 * client that skips the check.
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

const MACHINE = 'local'
const CLIENT_PASSWORD = 'wire-window-client-password'

describe('the wire window, over real sockets', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let cookieHeader: string
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
    handle.registry.gateway.attachDaemon(MACHINE, () => {})
    handle.registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo/before-the-deploy',
      machineId: MACHINE,
    })
    handle.registry.modules.sessions.flushBroadcasts()
  })

  afterAll(async () => {
    await handle?.close()
    delete process.env.PODIUM_STATE_DIR
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

  it('serves a stale PWA, a current build, and refuses one beyond the window', async () => {
    // 1. THE STALE PWA — no `wireVersion` in its hello, because its bundle
    //    predates the field. It announces the delta capability, which every
    //    shipped build does.
    const stale = await connect({ caps: [CAP_METADATA_DELTA] })
    // 2. THE CURRENT BUILD.
    const current = await connect({ caps: [CAP_METADATA_DELTA], wireVersion: WIRE_VERSION })
    // 3. BEYOND THE WINDOW.
    const beyond = await connect({ caps: [CAP_METADATA_DELTA], wireVersion: WIRE_VERSION + 1 })

    // The world reaches BOTH supported peers, each in its own wire's shape, and
    // both came out of the same feed.
    const staleWorld = (await stale.nextMatching((m) => m.type === 'issuesChanged')) as {
      type: string
    }
    expect(staleWorld.type).toBe('issuesChanged')
    // The session world of a REAL socket comes from the prepared-publication
    // worker, not from the feed's translation — that path predates the feed,
    // serves a scoped connection its filtered view, and POD-1203 preserved it
    // rather than absorbing it. Asserted here so the split is visible: this frame
    // is the worker's, the four lists above are the feed's.
    const staleSessions = (await stale.nextMatching((m) => m.type === 'sessionsChanged')) as {
      sessions: { cwd: string }[]
    }
    expect(staleSessions.sessions.map((s) => s.cwd)).toContain('/repo/before-the-deploy')

    // THE CURRENT BUILD IS RE-SERVED ITS WORLD IN ITS OWN VERSION. It was
    // admitted at wire 1 before it said anything — the only honest default for a
    // socket that has not spoken — so its first world went out as v1 lists; its
    // `hello` announced wire 2 and the world was re-served as a `feedBootstrap`.
    // A world expressed in a dialect the peer never advertised is exactly what
    // the window exists to prevent.
    const currentWorld = (await current.nextMatching((m) => m.type === 'feedBootstrap')) as {
      seq: number
      changes: { entity: string }[]
    }
    expect(currentWorld.changes.some((c) => c.entity === 'session')).toBe(true)

    // Everything this peer received BEFORE it announced itself. Its hello has
    // been processed by now — the two awaits above are later frames on sockets
    // that connected after it.
    const beyondAfterHello = beyond.frames.length

    // A write AFTER all three connected.
    handle.registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo/after-the-deploy',
      machineId: MACHINE,
    })
    handle.registry.modules.sessions.flushBroadcasts()

    // The stale build keeps working — it is told about the new session, in the
    // only shapes it understands. This is the rollout window doing its job.
    const staleUpdate = (await stale.nextMatching(
      (m) =>
        (m.type === 'sessionsChanged' &&
          m.sessions.some((session) => session.cwd === '/repo/after-the-deploy')) ||
        (m.type === 'metadataDelta' && m.changes.some((c) => c.entity === 'session')),
    )) as { type: string }
    expect(['sessionsChanged', 'metadataDelta']).toContain(staleUpdate.type)
    // The current build gets the canonical frame for the same write.
    const currentDelta = (await current.nextMatching((m) => m.type === 'feedDelta')) as {
      fromSeq: number
      seq: number
      minAvailableSeq: number
    }
    expect(currentDelta.fromSeq).toBe(currentWorld.seq)
    expect(currentDelta.minAvailableSeq).toBeGreaterThanOrEqual(0)

    // THE REFUSAL. Its control plane works — it is a real connection and it got
    // `welcome` — and from the moment it announced a version this server cannot
    // serve, it receives NO entity frame in either wire's vocabulary. It does
    // hold the v1 world it was served before it spoke, because until `hello` a
    // silent socket is indistinguishable from a legacy one; what it must never
    // get is a stream it cannot follow.
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
    expect(beyond.types()).toContain('welcome')
    expect(
      beyond
        .types()
        .slice(beyondAfterHello)
        .filter((t) => ENTITY_FRAMES.has(t)),
    ).toEqual([])
    // …and the paired half, or "it received nothing" is equally true of a socket
    // that was never connected: the two supported peers DID receive frames over
    // the same window.
    expect(stale.types().filter((t) => ENTITY_FRAMES.has(t)).length).toBeGreaterThan(0)
    expect(current.types().filter((t) => ENTITY_FRAMES.has(t)).length).toBeGreaterThan(0)

    // …and the contract its self-update is driven by. `apps/web`'s version guard
    // fetches exactly this and hard-reloads when its own WIRE_VERSION is below
    // `minSupportedVersion` or differs from `wireVersion`, which is the working
    // half of the 426 backstop for a browser holding a cached bundle.
    const version = (await (await fetch(`http://127.0.0.1:${handle.port}/version`)).json()) as {
      wireVersion: number
      minSupportedVersion: number
    }
    expect(version).toMatchObject({
      wireVersion: WIRE_VERSION,
      minSupportedVersion: MIN_SUPPORTED_VERSION,
    })

    for (const peer of [stale, current, beyond]) peer.ws.close()
  })
})
