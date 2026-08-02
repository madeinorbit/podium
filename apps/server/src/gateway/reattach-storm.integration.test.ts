/**
 * REATTACH-STORM VERIFICATION (POD-391 AC 1: "/health stays responsive under storm").
 *
 * This is the verification half of the per-plane policy work, and it is not
 * hypothetical: the redeploy watchdog-kill incident (see
 * `relay.bind-storm.test.ts`) was a daemon reattach replaying one `bind` per
 * surviving session, whose broadcast pipeline burned 21–27s of CPU inside a 30s
 * systemd watchdog window. `relay.bind-storm.test.ts` pins the pipeline fixes at
 * the REGISTRY level, against a plain function sink. This file pins the property
 * one layer out, where the incident was actually observed: a REAL server, a real
 * HTTP surface, real `/client` WebSockets receiving the fan-out, and the storm
 * driven through the real gateway.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO TIMING ASSERTION HERE
 * ---------------------------------------------------------------------------
 * The obvious test — "assert /health answered within N ms" — measures the HOST,
 * not the code, and this repo's lanes run under heavy parallel load where such a
 * bound flakes without the product ever changing. The regression being guarded is
 * not "slow"; it is "the event loop does not come back", which is what the
 * watchdog killed the process for. So the assertion is LIVENESS: every probe
 * issued during the storm resolves, and resolves with the right body. A blocked
 * loop fails it by exhausting the (generous, watchdog-scale) test timeout rather
 * than by missing a millisecond budget. Nothing here sleeps.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES *NOT* COVER — read before treating it as cap coverage
 * ---------------------------------------------------------------------------
 * It does not exercise the 16 MB budget's binding arm, and it cannot. Measured,
 * not assumed: mutating the client cap to **0** leaves both tests below GREEN,
 * because a loopback socket drains synchronously and its `bufferedAmount` never
 * leaves 0 — so `bufferedAmount > limit` stays false however low the limit goes.
 * The assertion is not vacuous (mutating the cap to **-1**, where every send
 * exceeds, DOES fail it), but its real content is "a healthy recipient is neither
 * reaped nor starved during a storm", not "the cap is 16 MB".
 *
 * The cap's arms are pinned where they can be forced exactly — `wsServer.test.ts`,
 * against a socket double whose `bufferedAmount` the test sets: at the budget
 * (sends), one byte over (terminates), not-OPEN and over (dropped, not
 * terminated), and on both of the client plane's outbound doors.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type MachineId } from '@podium/model'
import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startServer } from '../server'

const SESSIONS = 40
const ROUNDS = 6
const CLIENTS = 3
/** Watchdog-scale, not latency-scale: this bounds "the loop never came back". */
const STORM_TIMEOUT_MS = 30_000

const geometry = { cols: 80, rows: 24 }

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('a daemon reattach storm', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let machineId: MachineId
  let sessionIds: string[]

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-reattach-storm-'))
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({ port: 0 })
    machineId = handle.registry.modules.machines.hostMachineId
    // A session can only be created on an ONLINE machine, so the host has to be
    // attached before the fixture exists. This sink is superseded by the storm's
    // first round, which is exactly the reattach shape under test.
    handle.registry.gateway.attachDaemon(machineId, () => {})
    sessionIds = Array.from(
      { length: SESSIONS },
      (_, i) =>
        handle.registry.modules.sessions.createSession({
          agentKind: 'shell',
          cwd: `/repo/w${i}`,
          machineId,
        }).sessionId,
    )
    handle.registry.modules.sessions.flushBroadcasts()
  })

  afterAll(async () => {
    await handle?.close()
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  /** Connect a real /client socket and collect its frames. Resolves once open. */
  async function connectClient(port: number) {
    const frames: ServerMessage[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/client`)
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerMessage))
    let closedWith: number | undefined
    ws.on('close', (code) => {
      closedWith = code
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    return {
      ws,
      frames,
      closed: () => closedWith,
      /** Event-driven wait — no polling interval, no fixed sleep. */
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

  it(
    'keeps /health answering, and keeps every client socket alive and fed',
    async () => {
      const clients = await Promise.all(
        Array.from({ length: CLIENTS }, () => connectClient(handle.port)),
      )
      const room = { kind: 'session' as const, id: asSessionId(sessionIds[0] as string) }
      for (const client of clients) {
        client.ws.send(JSON.stringify({ type: 'presenceSubscribe', room }))
      }
      await Promise.all(
        clients.map((client) =>
          client.nextMatching(
            (message) => message.type === 'presenceRoomState' && message.room.id === room.id,
          ),
        ),
      )

      const health = `http://127.0.0.1:${handle.port}/health`
      const probes: Promise<string>[] = []

      // THE STORM. Each round is a full reattach: the old socket's sink is
      // detached, a new one attaches, and every surviving session replays its
      // `bind` — the exact shape that pinned the loop in the incident. A `/health`
      // probe is issued per round WITHOUT awaiting it, so the probes are genuinely
      // in flight while the storm runs rather than neatly between rounds.
      let send: ((msg: ControlMessage) => void) | undefined
      for (let round = 0; round < ROUNDS; round++) {
        if (send) handle.registry.gateway.detachDaemon(machineId, send)
        const current: (msg: ControlMessage) => void = () => {}
        handle.registry.gateway.attachDaemon(machineId, current)
        send = current
        probes.push(fetch(health).then((r) => r.text()))
        for (const [i, sessionId] of sessionIds.entries()) {
          handle.registry.gateway.routeDaemonFrame(machineId, {
            type: 'bind',
            sessionId: asSessionId(sessionId),
            cmd: 'sh',
            cwd: `/repo/w${i}`,
            agentKind: 'shell',
            geometry,
          })
        }
        // A populated room publishes full cursor state at a real 50Hz cadence.
        // These frames share the client socket with the durable reattach feed,
        // but use the lower lossy stream budget.
        for (let tick = 0; tick < 6; tick += 1) {
          for (const client of clients) {
            client.ws.send(
              JSON.stringify({
                type: 'presenceUpdate',
                room,
                payload: { cursor: round * 6 + tick },
              }),
            )
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }

        // Yield to the loop between rounds so the probes above can actually be
        // served — a storm that never yields is a different (and unshipped) bug.
        await Promise.resolve()
      }
      handle.registry.modules.sessions.flushBroadcasts()

      // AC 1: /health stayed responsive. Every probe issued mid-storm resolved,
      // and resolved with the real body — a 500 or an empty response would satisfy
      // "it answered" while proving the surface was broken.
      const answers = await Promise.all(probes)
      expect(answers).toHaveLength(ROUNDS)
      expect(answers.every((a) => a === 'ok')).toBe(true)
      // The surface is still healthy AFTER the storm, not merely during it.
      expect(await fetch(health).then((r) => r.text())).toBe('ok')

      // WHAT MUST NOT STARVE: the client plane's 16 MB budget terminates a socket
      // that is not draining. A healthy loopback client under a full storm is
      // nowhere near it, so if any of these were reaped, the cap (or the sweep)
      // is binding on live recipients — the failure mode the budget exists to
      // avoid, not to cause.
      for (const client of clients) {
        expect(client.closed(), 'a healthy client was reaped during the storm').toBeUndefined()
        expect(client.ws.readyState).toBe(WebSocket.OPEN)
      }

      // …and the fan-out actually reached them. "Socket still open" alone would
      // pass for a client that received nothing, which is starvation by another
      // name. Every client must see the storm's settled state: all sessions live.
      for (const client of clients) {
        const settled = await client.nextMatching(
          (m) => m.type === 'sessionsChanged' && m.sessions.length === SESSIONS,
        )
        if (settled.type !== 'sessionsChanged') throw new Error('expected sessionsChanged')
        expect(settled.sessions.every((s) => s.status === 'live')).toBe(true)
      }
      for (const client of clients) {
        expect(
          client.frames.some(
            (message) => message.type === 'presenceRoomDelta' && message.room.id === room.id,
          ),
          'a populated room was starved during the storm',
        ).toBe(true)
      }

      for (const client of clients) client.ws.close()
    },
    STORM_TIMEOUT_MS,
  )

  it('a superseded socket s late close does not evict the reattached daemon', () => {
    // The reattach half of the storm, isolated — and the point at which THIS
    // issue's two halves meet. `MachinesService.detach` documents the ordering
    // exactly: "the keepalive sweep terminates a wedged socket a beat AFTER the
    // new one has attached", so the dead socket's `close` lands after the
    // reconnect. That is the daemon plane's 10s sweep, and if the sink identity
    // were not checked the sweep's own reaping would leave the machine
    // permanently unroutable while its daemon sits happily connected.
    const machines = handle.registry.modules.machines
    const stale: ControlMessage[] = []
    const fresh: ControlMessage[] = []
    const staleSend = (msg: ControlMessage): void => void stale.push(msg)
    const freshSend = (msg: ControlMessage): void => void fresh.push(msg)

    handle.registry.gateway.attachDaemon(machineId, staleSend)
    handle.registry.gateway.attachDaemon(machineId, freshSend) // reconnect wins the slot
    handle.registry.gateway.detachDaemon(machineId, staleSend) // …then the late close arrives
    expect(machines.hasDaemon(machineId)).toBe(true)

    // Routed to the LIVE socket, and the counterfactual: the superseded sink must
    // receive nothing. Asserting only "fresh got it" would pass for a fan-out to
    // both, which is a different bug (a detached daemon still being written to).
    stale.length = 0
    fresh.length = 0
    machines.toMachine(machineId, { type: 'inventoryRequest' })
    expect(fresh).toEqual([{ type: 'inventoryRequest' }])
    expect(stale).toEqual([])

    // The instrument must be able to say YES: a close from the CURRENT socket
    // does detach. Without this, "hasDaemon stayed true" is equally satisfied by
    // a detach path that never removes anything.
    handle.registry.gateway.detachDaemon(machineId, freshSend)
    expect(machines.hasDaemon(machineId)).toBe(false)
  })
})
