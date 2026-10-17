/**
 * Synthetic load for one bench round (POD-6146), in its own process so the driver's
 * CPU never lands in the server's event-loop accounting.
 *
 * - DAEMONS: one fake daemon per seeded machine dials the real `/daemon` socket with a
 *   machine token (`peerHello`), reports a minimal inventory, then sends a fixed frame
 *   mix for that machine's live sessions at `--frames-per-minute` in total, spread by
 *   live-session share. `hostMetrics` goes every 5 s per machine, as a real daemon does.
 *   It answers `runtimeLifecycleRequest` the way a daemon does and ignores the rest.
 * - CLIENTS: `--clients` logged-in `/client` sockets that say hello and read the feed.
 * - WRITES: tRPC `sessions.rename` and `issues.update` at fixed per-minute rates.
 *   `--session-write-targeting` picks the renamed session: `running` (default) sends
 *   RUNNING_WRITE_SHARE of them to live sessions and the rest to parked ones; `uniform`
 *   picks over the whole table, as the first bench did (~2% live at h1a1).
 * - MAIL (optional, `--mail-per-minute`, default 0): tRPC `messages.send` to the first
 *   `--mail-targets` live sessions in turn, so a few busy recipients each hold a queue
 *   that every delivery flush works through (POD-6161: per-attempt recipient reads).
 *
 * Prints one JSON line with what it sent and received. Usage (see run.ts):
 *   bun --conditions=@podium/source drive.ts --checkout=<arm> --fixture=<fixture.json>
 *     --port=<n> --password=<pw> --start-at=<epoch ms> --duration-ms=<n>
 *     --frames-per-minute=<n> --session-writes-per-minute=<n> --issue-writes-per-minute=<n> --clients=<n>
 *     [--session-write-targeting=running|uniform] [--mail-per-minute=<n>] [--mail-targets=<n>]
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchFixture } from './seed'
import { parseArgs } from './seed'

/**
 * Share of daemon frames by type, calibrated so the bench's SQL statements per daemon
 * frame land near the live server's (1.25, 24 h median, 2026-10-15). Live daemons'
 * acknowledgement counts put runtimeEvent and agentObservation at about one each; the
 * rest is terminal output. See docs/measurements/pod-6140-baseline.md § Load.
 */
export const FRAME_MIX = [
  ['agentFrameBatch', 0.9],
  ['runtimeEvent', 0.04],
  ['agentObservation', 0.04],
  ['agentState', 0.015],
  ['title', 0.005],
] as const
export type FrameKind = (typeof FRAME_MIX)[number][0]

/** Deterministic weighted pick: the k-th frame of a stream always has the same kind. */
export function frameKindAt(k: number): FrameKind {
  // A low-discrepancy sequence spreads every kind evenly through time.
  const u = (k * 0.6180339887498949) % 1
  let acc = 0
  for (const [kind, share] of FRAME_MIX) {
    acc += share
    if (u < acc) return kind
  }
  return FRAME_MIX[0][0]
}

/** How many frames are due at `elapsedMs` for a stream of `perMinute`. */
export function framesDue(perMinute: number, elapsedMs: number): number {
  return Math.floor((perMinute * elapsedMs) / 60_000)
}

/**
 * Share of session writes that go to running sessions under `running` targeting. An
 * assumption, not a measurement (the live database is not scanned, operator rule
 * 2026-10-15): live session updates come from running agents (state, titles, activity),
 * and parked sessions change only on the occasional rename or archive. 95% keeps a
 * parked share large enough to still show a parked write's cost.
 */
export const RUNNING_WRITE_SHARE = 0.95
export type SessionWriteTargeting = 'running' | 'uniform'

/** The session the k-th session write renames; deterministic for a fixture. */
export function sessionWriteTarget(
  k: number,
  targeting: SessionWriteTargeting,
  all: readonly string[],
  live: readonly string[],
  parked: readonly string[],
): string {
  if (targeting === 'uniform' || live.length === 0 || parked.length === 0) return all[(k * 7919) % all.length]!
  const toLive = (k * 0.6180339887498949) % 1 < RUNNING_WRITE_SHARE
  const pool = toLive ? live : parked
  return pool[(k * 7919) % pool.length]!
}

const PTY_CHUNK = Buffer.from('\x1b[32m✔\x1b[0m compiled 1 file in 12ms\r\n'.repeat(4)).toString('base64')

export function buildFrame(kind: FrameKind, sessionId: string, k: number, now: string): Record<string, unknown> {
  switch (kind) {
    case 'agentFrameBatch':
      return { type: 'agentFrameBatch', sessionId, frames: [PTY_CHUNK] }
    case 'runtimeEvent':
      return {
        type: 'runtimeEvent',
        deliveryId: `bench-${sessionId}-${k}`,
        sessionId,
        event: {
          t: 'state',
          change: { kind: 'state_snapshot', state: { phase: k % 2 ? 'working' : 'idle', since: now, nativeSubagentCount: 0 } },
          at: now,
          provenance: 'live',
          cursor: { segmentId: `bench-${sessionId}`, components: { seq: k } },
          observerGeneration: 1,
          turnEpoch: 0,
        },
      }
    case 'agentObservation':
      return {
        type: 'agentObservation',
        observation: {
          podiumSessionId: sessionId,
          provider: 'claude-code',
          providerSessionId: null,
          bindingVersion: 1,
          providerTurnId: null,
          providerPromptId: null,
          observerGeneration: 1,
          providerCursor: { segmentId: `bench-${sessionId}`, components: { seq: k } },
          providerAt: null,
          receivedAt: now,
          sourceEventKind: 'assistant',
          transitionKind: 'turn_opened',
          provenance: 'live',
          inputOrigin: 'human',
          turnEpoch: 1,
          priorPhase: 'idle',
          nextPhase: 'working',
          transitionId: `bench-${sessionId}-${k}`,
          state: { phase: 'working', since: now, nativeSubagentCount: 0 },
        },
      }
    case 'agentState':
      return { type: 'agentState', sessionId, state: { phase: k % 2 ? 'working' : 'idle', since: now, nativeSubagentCount: 0 } }
    case 'title':
      return { type: 'title', sessionId, title: `Bench session ${k % 97}` }
  }
}

interface Counters {
  sent: Record<string, number>
  /** Frames that came due while their daemon's socket was down (after the server dropped it). */
  dropped: Record<string, number>
  reconnects: number
  received: Record<string, number>
  writes: { ok: number; failed: number; lastError?: string }
  clientBytes: number
  clientMessages: number
  daemonsConnected: number
  clientsConnected: number
  errors: string[]
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const bump = (record: Record<string, number>, key: string, by = 1) => { record[key] = (record[key] ?? 0) + by }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const fixture = JSON.parse(readFileSync(args.fixture!, 'utf8')) as BenchFixture
  const protocol = await import(join(args.checkout!, 'packages/protocol/src/index.ts'))
  const origin = `http://127.0.0.1:${args.port}`
  const startAt = Number(args['start-at'])
  const durationMs = Number(args['duration-ms'])
  const framesPerMinute = Number(args['frames-per-minute'])
  const counters: Counters = { sent: {}, dropped: {}, reconnects: 0, received: {}, writes: { ok: 0, failed: 0 }, clientBytes: 0, clientMessages: 0, daemonsConnected: 0, clientsConnected: 0, errors: [] }
  const note = (error: unknown) => { if (counters.errors.length < 20) counters.errors.push(String(error)) }

  const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: args.password }) })
  if (!login.ok) throw new Error(`login failed (${login.status}): ${await login.text()}`)
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  const headers = { cookie, origin, 'content-type': 'application/json' }

  // ---- daemons ----
  // A daemon that the server drops (an overloaded server fails its liveness ping) reconnects
  // after 1 s, as a real daemon does. Frames that come due while it is down are counted as
  // dropped, not queued, so the schedule stays the same and the report shows the loss.
  const totalLive = fixture.machines.reduce((n, machine) => n + machine.liveSessionIds.length, 0)
  let finished = false
  type Daemon = { machine: (typeof fixture.machines)[number]; perMinute: number; socket?: WebSocket; open: boolean }
  const connect = (daemon: Daemon) => new Promise<void>((resolve, reject) => {
    const { machine } = daemon
    const socket = new WebSocket(`ws://127.0.0.1:${args.port}/daemon?v=${protocol.DAEMON_WIRE_VERSION}`)
    daemon.socket = socket
    const timer = setTimeout(() => reject(new Error(`daemon ${machine.name}: no peerHelloOk in 15 s`)), 15_000)
    socket.onopen = () => socket.send(JSON.stringify({
      type: 'peerHello',
      v: protocol.DAEMON_WIRE_VERSION,
      caps: [],
      credential: { kind: 'machineToken', token: machine.token, machineHint: machine.id },
      bindingSessionIds: machine.liveSessionIds,
      claims: { hostname: machine.name },
    }))
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') { bump(counters.received, 'binary'); return }
      let message: { type?: string; requestId?: string; sessionId?: string }
      try { message = JSON.parse(event.data) } catch { bump(counters.received, 'unparsed'); return }
      bump(counters.received, message.type ?? 'unknown')
      if (message.type === 'peerHelloOk') {
        clearTimeout(timer)
        counters.daemonsConnected++
        daemon.open = true
        socket.send(JSON.stringify({ type: 'inventoryReport', machineId: machine.id, inventory: { os: 'linux', arch: 'x64', agents: [] } }))
        resolve()
      } else if (message.type === 'peerHelloRejected') {
        clearTimeout(timer)
        reject(new Error(`daemon ${machine.name} rejected: ${event.data}`))
      } else if (message.type === 'runtimeLifecycleRequest') {
        socket.send(JSON.stringify({ type: 'runtimeLifecycleResult', requestId: message.requestId, sessionId: message.sessionId, result: { ok: true, retirement: 'confirmed' } }))
      }
    }
    socket.onerror = (event) => note(`daemon ${machine.name} socket error ${String((event as ErrorEvent).message ?? '')}`)
    socket.onclose = (event) => {
      daemon.open = false
      if (finished) return
      bump(counters.received, `close:${event.code}`)
      counters.reconnects++
      setTimeout(() => { if (!finished) connect(daemon).catch(note) }, 1_000)
    }
  })
  const daemons: Daemon[] = fixture.machines.filter((machine) => machine.liveSessionIds.length > 0)
    .map((machine) => ({ machine, perMinute: (framesPerMinute * machine.liveSessionIds.length) / totalLive, open: false }))
  await Promise.all(daemons.map(connect))

  // ---- clients ----
  const clients = await Promise.all(Array.from({ length: Number(args.clients ?? 0) }, (_, index) => new Promise<WebSocket>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${args.port}/client?v=${protocol.CLIENT_WIRE_VERSION}&cap=${protocol.CAP_SYNC_HTTP_V1}`, { headers } as unknown as string[])
    socket.onopen = () => {
      counters.clientsConnected++
      socket.send(JSON.stringify({ type: 'hello', clientId: `bench-client-${index}`, viewport: { cols: 120, rows: 40, dpr: 1 }, wireVersion: protocol.CLIENT_WIRE_VERSION, caps: ['metadataDelta', protocol.CAP_SYNC_HTTP_V1] }))
      resolve(socket)
    }
    socket.onmessage = (event) => { counters.clientMessages++; counters.clientBytes += typeof event.data === 'string' ? event.data.length : (event.data as ArrayBuffer).byteLength }
    socket.onerror = () => { note(`client ${index} socket error`); resolve(socket) }
  })))

  // ---- writes ----
  const rpc = async (path: string, input: unknown) => {
    try {
      const response = await fetch(`${origin}/trpc/${path}`, { method: 'POST', headers, body: JSON.stringify(input) })
      if (response.ok) counters.writes.ok++
      else { counters.writes.failed++; counters.writes.lastError = `${path} ${response.status} ${(await response.text()).slice(0, 300)}` }
    } catch (error) { counters.writes.failed++; counters.writes.lastError = String(error) }
  }

  const wait = startAt - Date.now()
  if (wait > 0) await pause(wait)
  const begin = Date.now()
  const streamSent = new Map<Daemon, number>()
  const metricsSent = new Map<Daemon, number>()
  let sessionWrites = 0
  let issueWrites = 0
  const sessionRate = Number(args['session-writes-per-minute'] ?? 0)
  const issueRate = Number(args['issue-writes-per-minute'] ?? 0)
  const targeting = (args['session-write-targeting'] ?? 'running') as SessionWriteTargeting
  if (targeting !== 'running' && targeting !== 'uniform') throw new Error(`--session-write-targeting must be running or uniform, not ${targeting}`)
  const liveIds = fixture.machines.flatMap((machine) => machine.liveSessionIds)
  const liveSet = new Set(liveIds)
  const parkedIds = fixture.sessionIds.filter((id) => !liveSet.has(id))
  let liveWrites = 0
  const mailRate = Number(args['mail-per-minute'] ?? 0)
  const mailTargets = liveIds.slice(0, Math.max(1, Number(args['mail-targets'] ?? 5)))
  let mails = 0
  const inflight = new Set<Promise<void>>()
  while (Date.now() - begin < durationMs) {
    const elapsed = Date.now() - begin
    const now = new Date().toISOString()
    for (const daemon of daemons) {
      const due = framesDue(daemon.perMinute, elapsed)
      let k = streamSent.get(daemon) ?? 0
      for (; k < due; k++) {
        const kind = frameKindAt(k)
        if (!daemon.open || !daemon.socket) { bump(counters.dropped, kind); continue }
        const sessionId = daemon.machine.liveSessionIds[k % daemon.machine.liveSessionIds.length]!
        daemon.socket.send(JSON.stringify(buildFrame(kind, sessionId, k, now)))
        bump(counters.sent, kind)
      }
      streamSent.set(daemon, k)
      const metricsDue = Math.floor(elapsed / 5_000) + 1
      for (let m = metricsSent.get(daemon) ?? 0; m < metricsDue; m++) {
        metricsSent.set(daemon, m + 1)
        if (!daemon.open || !daemon.socket) { bump(counters.dropped, 'hostMetrics'); continue }
        daemon.socket.send(JSON.stringify({ type: 'hostMetrics', hostname: daemon.machine.name, sampledAt: now, memory: { totalBytes: 32e9, availableBytes: 16e9, swapTotalBytes: 8e9, swapFreeBytes: 8e9 } }))
        bump(counters.sent, 'hostMetrics')
      }
    }
    for (; sessionWrites < framesDue(sessionRate, elapsed); sessionWrites++) {
      const id = sessionWriteTarget(sessionWrites, targeting, fixture.sessionIds, liveIds, parkedIds)
      if (liveSet.has(id)) liveWrites++
      const call = rpc('sessions.rename', { sessionId: id, name: `Bench rename ${sessionWrites}` }).finally(() => inflight.delete(call))
      inflight.add(call)
    }
    for (; issueWrites < framesDue(issueRate, elapsed); issueWrites++) {
      const id = fixture.issueIds[(issueWrites * 104729) % fixture.issueIds.length]!
      const call = rpc('issues.update', { id, patch: { priority: issueWrites % 4 } }).finally(() => inflight.delete(call))
      inflight.add(call)
    }
    for (; mails < framesDue(mailRate, elapsed); mails++) {
      const to = mailTargets[mails % mailTargets.length]!
      const call = rpc('messages.send', { to, body: `Bench mail ${mails}`, urgency: 'fyi' }).finally(() => inflight.delete(call))
      inflight.add(call)
    }
    await pause(50)
  }
  await Promise.allSettled([...inflight])
  finished = true
  for (const daemon of daemons) daemon.socket?.close()
  for (const client of clients) client.close()
  console.log(JSON.stringify({ benchDrive: true, wallMs: Date.now() - begin, sessionWrites, liveWrites, targeting, issueWrites, mails, ...counters }))
}

if (import.meta.main) await main()
