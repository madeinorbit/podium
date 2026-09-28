/**
 * THE DAEMON'S LINK, WITH A HAND ON IT (POD-4779).
 *
 * A WebSocket proxy between the daemon and the server. The daemon dials the
 * proxy as if it were the server; every frame is forwarded unchanged, in order,
 * and counted by its `type`, so a lane can both break the link the ways a real
 * one breaks and measure what crossed it afterwards (the storm check).
 *
 * The ways it breaks, and what each models:
 *
 *  - `cut`    every connection is torn down (no close handshake — `terminate`)
 *             and new upgrades are refused until the link is restored. Frames
 *             waiting in the proxy are lost, as bytes in a dead TCP connection
 *             are. The endpoints see a dead socket and reconnect.
 *  - `stall`  connections stay open but nothing crosses, pings included: the
 *             half-dead link where each side only learns by its own heartbeat.
 *             Held frames are delivered in order when the link recovers, as TCP
 *             would, unless a `cut` comes first.
 *  - delay    every frame waits `delayMs` before it is forwarded (order kept).
 *  - drop     the next N frames matching a predicate are swallowed, and only
 *             those — a targeted loss ("the delivery outcome never arrived")
 *             rather than random noise, so a lane can say which frame it lost.
 *
 * Pings and pongs are forwarded end to end (auto-pong is off on both legs), so
 * a stall is invisible to neither side's liveness check — the proxy never
 * answers for an endpoint that cannot.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import WebSocket, { type RawData, WebSocketServer } from 'ws'

export type LinkDirection = 'up' | 'down'
export type LinkMode = 'pass' | 'cut' | 'stall'

export interface LinkFrame {
  /** `up` = daemon → server, `down` = server → daemon. */
  readonly dir: LinkDirection
  /** The frame's JSON `type`, or `binary` / `unparsed`. */
  readonly type: string
  readonly at: number
  /** Which proxied connection carried it (1-based, in accept order). */
  readonly conn: number
  /** The parsed frame, when it was JSON. */
  readonly body?: Record<string, unknown>
  readonly dropped?: boolean
}

interface DropRule {
  readonly dir: LinkDirection
  readonly match: (frame: LinkFrame) => boolean
  remaining: number
}

interface Pair {
  readonly conn: number
  readonly client: WebSocket
  readonly upstream: WebSocket
  /** Frames from the daemon that arrived before the upstream leg opened. */
  readonly early: { data: RawData; isBinary: boolean }[]
  /** Frames held by a stall, per direction, delivered in order on recovery. */
  readonly held: { dir: LinkDirection; data: RawData; isBinary: boolean }[]
  chain: Promise<void>
  dead: boolean
}

function describeFrame(
  data: RawData,
  isBinary: boolean,
): { type: string; body?: Record<string, unknown> } {
  if (isBinary) return { type: 'binary' }
  try {
    const body = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as unknown
    if (body && typeof body === 'object' && typeof (body as { type?: unknown }).type === 'string') {
      return { type: (body as { type: string }).type, body: body as Record<string, unknown> }
    }
  } catch {}
  return { type: 'unparsed' }
}

export class LinkProxy {
  readonly frames: LinkFrame[] = []
  private mode: LinkMode = 'pass'
  private delayMs = 0
  private readonly drops: DropRule[] = []
  private readonly pairs = new Set<Pair>()
  private accepted = 0

  private constructor(
    private readonly http: Server,
    private readonly wss: WebSocketServer,
    private readonly upstreamUrl: string,
  ) {}

  /** `upstreamUrl` is the server's base (`ws://127.0.0.1:<port>`); the daemon's
   *  path and query are appended per connection. */
  static async start(upstreamUrl: string): Promise<LinkProxy> {
    const http = createServer((_req, res) => {
      res.writeHead(404).end()
    })
    const wss = new WebSocketServer({ noServer: true, autoPong: false })
    const proxy = new LinkProxy(http, wss, upstreamUrl)
    http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      if (proxy.mode === 'cut') {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (client) => proxy.accept(client, req))
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    return proxy
  }

  get port(): number {
    return (this.http.address() as AddressInfo).port
  }

  /** Connections accepted so far — each daemon reconnect is one. */
  get connections(): number {
    return this.accepted
  }

  /** Is a daemon connection currently up end to end? */
  get connected(): boolean {
    for (const pair of this.pairs) {
      if (!pair.dead && pair.upstream.readyState === WebSocket.OPEN) return true
    }
    return false
  }

  setDelay(ms: number): void {
    this.delayMs = ms
  }

  /** Swallow the next `count` frames in `dir` for which `match` holds. */
  drop(dir: LinkDirection, match: (frame: LinkFrame) => boolean, count = 1): void {
    this.drops.push({ dir, match, remaining: count })
  }

  /** Forget every drop rule, spent or not. */
  clearDrops(): void {
    this.drops.length = 0
  }

  cut(): void {
    this.mode = 'cut'
    for (const pair of this.pairs) this.kill(pair)
  }

  stall(): void {
    if (this.mode === 'pass') this.mode = 'stall'
  }

  /** Back to a working link. After a stall, held frames go out in order. */
  restore(): void {
    const wasStalled = this.mode === 'stall'
    this.mode = 'pass'
    if (!wasStalled) return
    for (const pair of this.pairs) {
      const held = pair.held.splice(0)
      for (const frame of held) this.forward(pair, frame.dir, frame.data, frame.isBinary, true)
    }
  }

  /** Frames a stall is holding right now, in `dir` — sent by one side, not yet
   *  seen by the other. */
  holding(dir: LinkDirection): { type: string; body?: Record<string, unknown> }[] {
    return [...this.pairs].flatMap((pair) =>
      pair.held
        .filter((frame) => frame.dir === dir)
        .map((frame) => describeFrame(frame.data, frame.isBinary)),
    )
  }

  /** Frames that crossed (not dropped), optionally filtered. */
  crossed(filter?: { dir?: LinkDirection; type?: string; since?: number }): LinkFrame[] {
    return this.frames.filter(
      (frame) =>
        !frame.dropped &&
        (filter?.dir === undefined || frame.dir === filter.dir) &&
        (filter?.type === undefined || frame.type === filter.type) &&
        (filter?.since === undefined || frame.at >= filter.since),
    )
  }

  async close(): Promise<void> {
    this.mode = 'cut'
    for (const pair of this.pairs) this.kill(pair)
    this.wss.close()
    await new Promise<void>((resolve) => this.http.close(() => resolve()))
  }

  private accept(client: WebSocket, req: IncomingMessage): void {
    this.accepted += 1
    const upstream = new WebSocket(`${this.upstreamUrl}${req.url ?? '/'}`, { autoPong: false })
    const pair: Pair = {
      conn: this.accepted,
      client,
      upstream,
      early: [],
      held: [],
      chain: Promise.resolve(),
      dead: false,
    }
    this.pairs.add(pair)
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.CONNECTING) {
        pair.early.push({ data, isBinary })
        return
      }
      this.forward(pair, 'up', data, isBinary)
    })
    upstream.on('open', () => {
      for (const frame of pair.early.splice(0)) this.forward(pair, 'up', frame.data, frame.isBinary)
    })
    upstream.on('message', (data, isBinary) => this.forward(pair, 'down', data, isBinary))
    client.on('ping', (data) => this.control(pair, () => upstream.ping(data)))
    client.on('pong', (data) => this.control(pair, () => upstream.pong(data)))
    upstream.on('ping', (data) => this.control(pair, () => client.ping(data)))
    upstream.on('pong', (data) => this.control(pair, () => client.pong(data)))
    const end = (): void => this.kill(pair)
    client.on('close', end)
    client.on('error', end)
    upstream.on('close', end)
    upstream.on('error', end)
  }

  private control(pair: Pair, send: () => void): void {
    if (pair.dead || this.mode !== 'pass') return
    try {
      send()
    } catch {}
  }

  private forward(
    pair: Pair,
    dir: LinkDirection,
    data: RawData,
    isBinary: boolean,
    released = false,
  ): void {
    if (pair.dead) return
    if (this.mode === 'stall' && !released) {
      pair.held.push({ dir, data, isBinary })
      return
    }
    const described = describeFrame(data, isBinary)
    const base = {
      dir,
      type: described.type,
      conn: pair.conn,
      ...(described.body ? { body: described.body } : {}),
    }
    const rule = this.drops.find(
      (candidate) =>
        candidate.dir === dir &&
        candidate.remaining > 0 &&
        candidate.match({ ...base, at: Date.now() }),
    )
    if (rule) {
      rule.remaining -= 1
      this.frames.push({ ...base, at: Date.now(), dropped: true })
      return
    }
    const target = dir === 'up' ? pair.upstream : pair.client
    // LATENCY, not a throughput cap: each frame is due `delayMs` after it
    // arrived, and frames pipeline behind one another. (Sleeping the full delay
    // per frame in the chain would make a chatty link fall further behind with
    // every frame — a saturated link, not a slow one.)
    const due = Date.now() + this.delayMs
    pair.chain = pair.chain.then(async () => {
      const wait = due - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      if (pair.dead || target.readyState !== WebSocket.OPEN) return
      this.frames.push({ ...base, at: Date.now() })
      target.send(data, { binary: isBinary })
    })
  }

  private kill(pair: Pair): void {
    if (pair.dead) return
    pair.dead = true
    pair.held.length = 0
    pair.early.length = 0
    this.pairs.delete(pair)
    pair.client.terminate()
    pair.upstream.terminate()
  }
}
