/**
 * POD-1585 — A CONNECTED DAEMON MUST READ ONLINE.
 *
 * Filed as "connected machine reads offline forever", with two supporting
 * measurements that were both real and both non-evidence:
 *
 *   1. `machines.last_seen_at` was frozen across two reads while the daemon
 *      process was alive. It is written on HANDSHAKE only (see the notes in
 *      `maintenance/service.ts` and `janitor.ts`), so a long-lived connection
 *      legitimately leaves it untouched for hours. It is NOT a heartbeat, and
 *      nothing in the UI reads it to decide reachability.
 *   2. The server log carried no daemon/registration line. It carried none on a
 *      HEALTHY fleet either, because attach logged nothing at all — an
 *      instrument that could not say NO. It says both words now.
 *
 * THE THRESHOLD THE UI APPLIES IS: none. `MachinesService.listMachines` sets
 * `online: this.daemons.has(m.id)` — live socket membership in the gateway mux,
 * not a staleness comparison against `lastSeenAt` — and `RepoPickerModal` /
 * `MachinesPanel` render that boolean directly. So "pick a test interval against
 * the real rule" resolves to: there is no interval to beat. The assertion that
 * protects the reported symptom is that ATTACHING FLIPS `online`, which is what
 * this file pins over a real WebSocket against a really-booted server.
 *
 * `lastSeenAt` is asserted to ADVANCE across two handshakes rather than merely
 * to exist — a frozen timestamp reads identically to a fresh one, which is the
 * trap that produced the report.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandshakeDialer } from '@podium/protocol'
import { readOrCreateDaemonSecret, readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startServer } from './server'

const priorStateDir = process.env.PODIUM_STATE_DIR

/** One real daemon handshake over a real socket; resolves when the link is up. */
async function connectDaemon(port: number, stateDir: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon`)
  const dialer = createHandshakeDialer({
    peerRole: 'machine',
    credential: { kind: 'daemonSecret', secret: readOrCreateDaemonSecret(stateDir) },
    claims: { machineId: readOrCreateLocalMachineId(stateDir), hostname: hostname() },
  })
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify(dialer.hello())))
    ws.on('error', reject)
    ws.on('message', (raw: Buffer) => {
      const step = dialer.receive(raw.toString())
      if (step.action === 'established') resolve()
      else if (step.action !== 'deliver') reject(new Error(`handshake ${step.action}`))
    })
  })
  return ws
}

describe('machine presence (live server, real daemon socket)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-presence-'))
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({ port: 0 })
  })
  afterAll(async () => {
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
  })

  const listing = () => {
    const rows = server.registry.modules.machines.listMachines()
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      throw new Error(`expected exactly one machine row, got ${rows.length}`)
    return row
  }

  it('flips the machine ONLINE while a daemon is attached, and back OFFLINE when it goes', async () => {
    // Boot writes the host row (`ensureHostMachine`) before any daemon exists —
    // the row's mere presence, and its `lastSeenAt`, prove nothing about reach.
    expect(listing().online).toBe(false)
    const beforeConnect = listing().lastSeenAt

    const ws = await connectDaemon(server.port, stateDir)
    expect(listing().online).toBe(true)

    // The handshake DID reach the presence writer. Asserted as an advance past a
    // captured value, so a `touchMachine` that stopped being called cannot pass
    // on the boot-time timestamp still sitting in the column.
    const afterConnect = listing().lastSeenAt
    expect(new Date(afterConnect).getTime()).toBeGreaterThan(new Date(beforeConnect).getTime())

    await new Promise<void>((resolve) => {
      ws.on('close', () => resolve())
      ws.close()
    })
    // Detach is observed through the same field the UI reads, so a socket that
    // closes without evicting its registration is caught here rather than as a
    // machine that stays permanently, wrongly online.
    await expect.poll(() => listing().online).toBe(false)

    // A SECOND handshake must advance it AGAIN: the reported symptom was a value
    // written once at connect and never after, which a single-connect assertion
    // would happily accept.
    const ws2 = await connectDaemon(server.port, stateDir)
    expect(listing().online).toBe(true)
    expect(new Date(listing().lastSeenAt).getTime()).toBeGreaterThan(
      new Date(afterConnect).getTime(),
    )
    ws2.close()
  })

  it('stays ONLINE across heartbeat sweeps even though lastSeenAt never moves', async () => {
    // THE ANSWER TO "does presence stay fresh once attached?", pinned rather than
    // assumed: `online` is live socket membership in the gateway mux
    // (`listMachines` → `this.daemons.has(id)`), NOT a staleness comparison, so
    // there is no threshold to beat and a frozen `lastSeenAt` is correct rather
    // than a bug. Two reads MORE THAN ONE DAEMON HEARTBEAT INTERVAL APART
    // (`DAEMON_PLANE_LIVENESS.heartbeatIntervalMs` = 10s) — the row does not
    // move and the machine is still online.
    //
    // This also pins WHY `lastSeenAt` must not be turned into a heartbeat: it is
    // the handshake identity behind the janitor's
    // `connect-scan/{machineId}/{lastSeenAt}` run key and MaintenanceService's
    // equality revalidation, both of which read a CHANGED value as a NEW
    // connection occurrence. Rewriting it on a timer would re-fire connect-scan
    // every interval and fail that revalidation.
    const ws = await connectDaemon(server.port, stateDir)
    expect(listing().online).toBe(true)
    const atConnect = listing().lastSeenAt

    // Two full sweeps: a live socket must be ponged, not reaped.
    await new Promise((resolve) => setTimeout(resolve, 22_000))

    expect(listing().online).toBe(true)
    expect(listing().lastSeenAt).toBe(atConnect)

    ws.close()
    await expect.poll(() => listing().online).toBe(false)
  }, 60_000)
})
