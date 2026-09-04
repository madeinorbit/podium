import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import type { Geometry } from '@podium/model'
import { stateDir } from '@podium/runtime/config'
import { assertLinuxUnixSocketPath, resolveInstanceId } from '@podium/runtime/instance'
import { resolveScopeBudget } from '@podium/runtime/scope'
import {
  type AbducoSpawnOptions,
  applySessionsSliceBudget,
  canScopeMaster,
  execCreate,
  liveEnv,
  scopeEnv,
  scopeReclaimArgvs,
  scopeUnitName,
  stopSessionScope,
  type SystemctlRunner,
  systemdScopeArgv,
  userRuntimeDir,
} from './abduco.js'
import type { PtyProcess } from './backends/types.js'
import { resolveHostBin } from './host-bin.js'
import { type AgentSession, withHardRepaint, wrapPty } from './session.js'

const log = createLogger('pty:host')

/**
 * podium-host-backed durable sessions (SPEC-6). The host is our own process: it
 * owns the child and its pty, keeps a byte-sequenced ring of output, grants one
 * writer lease, applies resizes itself and answers with the kernel's size, and
 * reports the child's real exit status. This module exposes the abduco module's
 * shape one for one, so the daemon swaps by backend and nothing else moves.
 */

// ---- wire protocol -----------------------------------------------------------

export const HOST_PROTO_VERSION = 1

export const HostFrame = {
  HELLO: 0x01,
  WRITE: 0x02,
  RESIZE: 0x03,
  SIZE: 0x04,
  STATUS: 0x05,
  SIGNAL: 0x06,
  DETACH: 0x07,
  KILL: 0x08,
  REPLAY: 0x09,
  WELCOME: 0x81,
  DATA: 0x82,
  GAP: 0x83,
  RESIZED: 0x84,
  SIZE_REPLY: 0x85,
  STATUS_REPLY: 0x86,
  WRITTEN: 0x87,
  EXITED: 0x88,
  LEASE_LOST: 0x89,
  REPLAYING: 0x8a,
  REPLAYED: 0x8b,
  ERR: 0x8f,
} as const

export const HostErr = { NOT_WRITER: 1, NO_PTY: 2, BAD_FRAME: 3, EXITED: 4 } as const

/** `fromSeq` meaning "from the tail: replay nothing". */
export const HOST_TAIL = 0xffff_ffff_ffff_ffffn

export function encodeHostFrame(type: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const out = Buffer.alloc(5 + payload.byteLength)
  out.writeUInt32BE(payload.byteLength + 1, 0)
  out[4] = type
  out.set(payload, 5)
  return out
}

export function encodeHello(mode: 'writer' | 'reader', fromSeq: bigint): Buffer {
  const p = Buffer.alloc(2 + 1 + 8)
  p.writeUInt16BE(HOST_PROTO_VERSION, 0)
  p[2] = mode === 'writer' ? 1 : 2
  p.writeBigUInt64BE(fromSeq, 3)
  return encodeHostFrame(HostFrame.HELLO, p)
}

/** Incremental frame decoder: feed bytes in any chunking, get whole frames. */
export function createHostFrameDecoder(): (chunk: Uint8Array) => Array<{ type: number; payload: Buffer }> {
  let acc = Buffer.alloc(0)
  return (chunk) => {
    acc = acc.length ? Buffer.concat([acc, chunk]) : Buffer.from(chunk)
    const frames: Array<{ type: number; payload: Buffer }> = []
    for (;;) {
      if (acc.length < 5) break
      const len = acc.readUInt32BE(0)
      if (acc.length < 4 + len) break
      frames.push({ type: acc[4] as number, payload: acc.subarray(5, 4 + len) })
      acc = acc.subarray(4 + len)
    }
    return frames
  }
}

export interface HostWelcome {
  version: number
  hostPid: number
  childPid: number
  hasPty: boolean
  cols: number
  rows: number
  seqLow: bigint
  seqHigh: bigint
  lease: boolean
}

export interface HostStatus {
  alive: boolean
  exitCode: number
  signal: number
  seqLow: bigint
  seqHigh: bigint
  writers: number
  readers: number
}

export interface HostResized {
  cols: number
  rows: number
  changed: boolean
}

export class HostError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`podium-host: ${message} (err ${code})`)
  }
}

type Pending = { kind: 'resize' | 'size' | 'status'; resolve: (v: unknown) => void; reject: (e: Error) => void }
type PendingWrite = { id: number; resolve: (bytes: number) => void; reject: (e: Error) => void }
type PendingReplay = { resolve: (r: { from: bigint; bytes: number }) => void; reject: (e: Error) => void }

/**
 * One connection to a host: framing, request/response correlation and events.
 * Requests of one kind are answered in order; WRITTEN carries its own id; an
 * ERR answers the oldest request that could still fail.
 */
export class HostConnection {
  readonly welcome: Promise<HostWelcome>
  private readonly sock: Socket
  private readonly decode = createHostFrameDecoder()
  private readonly pending: Pending[] = []
  private readonly pendingWrites: PendingWrite[] = []
  private readonly pendingReplays: PendingReplay[] = []
  private replaying: { from: bigint; bytes: number } | undefined
  private nextWriteId = 1
  private welcomed: HostWelcome | undefined
  private resolveWelcome!: (w: HostWelcome) => void
  private rejectWelcome!: (e: Error) => void
  private readonly dataCbs = new Set<(seq: bigint, data: Buffer) => void>()
  private readonly gapCbs = new Set<(seqLow: bigint) => void>()
  private readonly exitCbs = new Set<(code: number, signal: number) => void>()
  private readonly closeCbs = new Set<(err?: Error) => void>()
  private readonly errCbs = new Set<(err: HostError) => void>()
  private closed = false
  /** The seq of the byte AFTER the last DATA byte received: the resume point. */
  lastSeq: bigint | undefined
  exited: { code: number; signal: number } | undefined

  constructor(socketPath: string, mode: 'writer' | 'reader', fromSeq: bigint) {
    this.welcome = new Promise<HostWelcome>((resolve, reject) => {
      this.resolveWelcome = resolve
      this.rejectWelcome = reject
    })
    // Node queues writes issued before 'connect', so HELLO is always first.
    this.sock = createConnection(socketPath)
    this.sock.write(encodeHello(mode, fromSeq))
    this.sock.on('data', (chunk: Buffer) => {
      for (const f of this.decode(chunk)) this.onFrame(f.type, f.payload)
    })
    this.sock.on('error', (err) => this.finish(err))
    this.sock.on('close', () => this.finish())
  }

  get isOpen(): boolean {
    return !this.closed
  }

  private finish(err?: Error): void {
    if (this.closed) return
    this.closed = true
    const e = err ?? new Error('podium-host connection closed')
    if (!this.welcomed) this.rejectWelcome(e)
    for (const p of this.pending.splice(0)) p.reject(e)
    for (const w of this.pendingWrites.splice(0)) w.reject(e)
    for (const r of this.pendingReplays.splice(0)) r.reject(e)
    for (const cb of [...this.closeCbs]) cb(err)
  }

  private onFrame(type: number, p: Buffer): void {
    switch (type) {
      case HostFrame.WELCOME: {
        const w: HostWelcome = {
          version: p.readUInt16BE(0),
          hostPid: p.readUInt32BE(2),
          childPid: p.readUInt32BE(6),
          hasPty: p[10] === 1,
          cols: p.readUInt16BE(11),
          rows: p.readUInt16BE(13),
          seqLow: p.readBigUInt64BE(15),
          seqHigh: p.readBigUInt64BE(23),
          lease: p[31] === 1,
        }
        this.welcomed = w
        this.resolveWelcome(w)
        return
      }
      case HostFrame.DATA: {
        const seq = p.readBigUInt64BE(0)
        const data = p.subarray(8)
        // A replay re-sends old bytes with their ORIGINAL seqs: lastSeq is a
        // max, so the resume point never moves backwards.
        const end = seq + BigInt(data.length)
        if (this.lastSeq === undefined || end > this.lastSeq) this.lastSeq = end
        if (this.replaying) this.replaying.bytes += data.length
        for (const cb of [...this.dataCbs]) cb(seq, data)
        return
      }
      case HostFrame.REPLAYING:
        this.replaying = { from: p.readBigUInt64BE(0), bytes: 0 }
        return
      case HostFrame.REPLAYED: {
        const done = this.replaying ?? { from: 0n, bytes: 0 }
        this.replaying = undefined
        this.pendingReplays.shift()?.resolve(done)
        return
      }
      case HostFrame.GAP: {
        const low = p.readBigUInt64BE(0)
        for (const cb of [...this.gapCbs]) cb(low)
        return
      }
      case HostFrame.RESIZED:
        this.answer('resize', { cols: p.readUInt16BE(0), rows: p.readUInt16BE(2), changed: p[4] === 1 })
        return
      case HostFrame.SIZE_REPLY:
        this.answer('size', { cols: p.readUInt16BE(0), rows: p.readUInt16BE(2) })
        return
      case HostFrame.STATUS_REPLY:
        this.answer('status', {
          alive: p[0] === 1,
          exitCode: p.readInt32BE(1),
          signal: p[5] as number,
          seqLow: p.readBigUInt64BE(6),
          seqHigh: p.readBigUInt64BE(14),
          writers: p[22] as number,
          readers: p[23] as number,
        })
        return
      case HostFrame.WRITTEN: {
        const id = p.readUInt32BE(0)
        const bytes = p.readUInt32BE(4)
        const i = this.pendingWrites.findIndex((w) => w.id === id)
        if (i >= 0) (this.pendingWrites.splice(i, 1)[0] as PendingWrite).resolve(bytes)
        return
      }
      case HostFrame.EXITED: {
        const code = p.readInt32BE(0)
        const signal = p[4] as number
        this.exited = { code, signal }
        for (const cb of [...this.exitCbs]) cb(code, signal)
        return
      }
      case HostFrame.ERR: {
        const code = p.readUInt16BE(0)
        const n = p.readUInt32BE(2)
        const err = new HostError(code, p.subarray(6, 6 + n).toString('utf8'))
        const req = this.pending.shift()
        if (req) req.reject(err)
        else if (this.pendingWrites.length) (this.pendingWrites.shift() as PendingWrite).reject(err)
        else for (const cb of [...this.errCbs]) cb(err)
        return
      }
      default:
        return // LEASE_LOST and anything newer: ignored
    }
  }

  private answer(kind: Pending['kind'], value: unknown): void {
    const i = this.pending.findIndex((p) => p.kind === kind)
    if (i >= 0) (this.pending.splice(i, 1)[0] as Pending).resolve(value)
  }

  private request<T>(kind: Pending['kind'], frame: Buffer): Promise<T> {
    if (this.closed) return Promise.reject(new Error('podium-host connection closed'))
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ kind, resolve: resolve as (v: unknown) => void, reject })
      this.sock.write(frame)
    })
  }

  /** Raw frame out (tests; DETACH/KILL/SIGNAL below use it too). */
  send(type: number, payload?: Uint8Array): void {
    if (this.closed) return
    this.sock.write(encodeHostFrame(type, payload))
  }

  write(data: Uint8Array): Promise<number> {
    if (this.closed) return Promise.reject(new Error('podium-host connection closed'))
    const id = this.nextWriteId++
    const p = Buffer.alloc(4 + data.byteLength)
    p.writeUInt32BE(id, 0)
    p.set(data, 4)
    return new Promise<number>((resolve, reject) => {
      this.pendingWrites.push({ id, resolve, reject })
      this.sock.write(encodeHostFrame(HostFrame.WRITE, p))
    })
  }

  resize(cols: number, rows: number): Promise<HostResized> {
    const p = Buffer.alloc(4)
    p.writeUInt16BE(cols, 0)
    p.writeUInt16BE(rows, 2)
    return this.request<HostResized>('resize', encodeHostFrame(HostFrame.RESIZE, p))
  }

  size(): Promise<Geometry> {
    return this.request<Geometry>('size', encodeHostFrame(HostFrame.SIZE))
  }

  status(): Promise<HostStatus> {
    return this.request<HostStatus>('status', encodeHostFrame(HostFrame.STATUS))
  }

  /**
   * Ask the host to re-send the last `tailBytes` of its ring on this connection
   * (SPEC-6 REPLAY). The bytes arrive as ordinary DATA with their original seqs,
   * so `onData` listeners see them like live output; the child is not touched.
   * Resolves with where the replay started and how many bytes it carried.
   */
  replay(tailBytes: number): Promise<{ from: bigint; bytes: number }> {
    if (this.closed) return Promise.reject(new Error('podium-host connection closed'))
    const p = Buffer.alloc(4)
    p.writeUInt32BE(Math.max(0, Math.min(0xffff_ffff, Math.floor(tailBytes))), 0)
    return new Promise((resolve, reject) => {
      this.pendingReplays.push({ resolve, reject })
      this.sock.write(encodeHostFrame(HostFrame.REPLAY, p))
    })
  }

  signal(signo: number): void {
    this.send(HostFrame.SIGNAL, Uint8Array.of(signo))
  }

  kill(): void {
    this.send(HostFrame.KILL)
  }

  /** Orderly close: DETACH, then end the socket. */
  detach(): void {
    if (this.closed) return
    this.send(HostFrame.DETACH)
    this.sock.end()
    // The host closes its end after the DETACH; do not wait for it.
    setTimeout(() => this.sock.destroy(), 500).unref?.()
  }

  destroy(): void {
    this.sock.destroy()
  }

  onData(cb: (seq: bigint, data: Buffer) => void): () => void {
    this.dataCbs.add(cb)
    return () => this.dataCbs.delete(cb)
  }
  onGap(cb: (seqLow: bigint) => void): () => void {
    this.gapCbs.add(cb)
    return () => this.gapCbs.delete(cb)
  }
  onExit(cb: (code: number, signal: number) => void): () => void {
    this.exitCbs.add(cb)
    return () => this.exitCbs.delete(cb)
  }
  onClose(cb: (err?: Error) => void): () => void {
    this.closeCbs.add(cb)
    return () => this.closeCbs.delete(cb)
  }
  onError(cb: (err: HostError) => void): () => void {
    this.errCbs.add(cb)
    return () => this.errCbs.delete(cb)
  }
}

export function connectHost(
  socketPath: string,
  opts: { mode?: 'writer' | 'reader'; fromSeq?: bigint } = {},
): HostConnection {
  return new HostConnection(socketPath, opts.mode ?? 'writer', opts.fromSeq ?? HOST_TAIL)
}

// ---- socket directory --------------------------------------------------------

/**
 * Where a label's host socket lives: `<root>/hosts/<instance>/<label>.sock`, root
 * being the user runtime dir when there is one (tmpfs, per-login) else the state
 * dir. `PODIUM_HOST_SOCKET_DIR` overrides the root for tests and odd hosts, the
 * way `ABDUCO_SOCKET_DIR` does for abduco.
 */
export function hostSocketDir(env: NodeJS.ProcessEnv = process.env): string {
  const instance = resolveInstanceId(env)
  if (env.PODIUM_HOST_SOCKET_DIR) return join(env.PODIUM_HOST_SOCKET_DIR, instance)
  return join(userRuntimeDir() ?? stateDir(), 'hosts', instance)
}

/** Every directory a label's socket may be found in — the current root and the alternate one. */
function hostSocketDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const instance = resolveInstanceId(env)
  const dirs = [hostSocketDir(env)]
  if (!env.PODIUM_HOST_SOCKET_DIR) {
    const rt = userRuntimeDir()
    if (rt) dirs.push(join(stateDir(), 'hosts', instance))
  }
  return dirs.filter((d, i) => dirs.indexOf(d) === i)
}

export function hostSocketPath(label: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(hostSocketDir(env), `${label}.sock`)
}

/** Connect probe: does anything answer at this path? */
export function probeHostSocket(path: string): Promise<'live' | 'refused' | 'missing'> {
  return new Promise((resolve) => {
    if (!existsSync(path)) {
      resolve('missing')
      return
    }
    const s = createConnection(path)
    const done = (r: 'live' | 'refused' | 'missing'): void => {
      s.destroy()
      resolve(r)
    }
    s.once('connect', () => done('live'))
    s.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ENOENT' ? 'missing' : 'refused'))
  })
}

const HOST_SOCKET_WAIT_MS = 5000
const HOST_SOCKET_POLL_MS = 10

/** Wait until the label's host accepts a connection; returns the socket path. */
export async function waitForHostSocket(
  label: string,
  env: NodeJS.ProcessEnv = liveEnv(),
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? HOST_SOCKET_WAIT_MS
  const pollMs = options.pollMs ?? HOST_SOCKET_POLL_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await liveHostSocket(label, env)
    if (found) return found
    if (Date.now() >= deadline) break
    await new Promise<void>((r) => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
  }
  throw new Error(`podium-host session ${label} did not publish a live socket within ${timeoutMs}ms`)
}

/** The path of a live host for `label` in any of its directories, else undefined. */
export async function liveHostSocket(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  for (const dir of hostSocketDirs(env)) {
    const path = join(dir, `${label}.sock`)
    if ((await probeHostSocket(path)) === 'live') return path
  }
  return undefined
}

/**
 * Whether a live host owns this label AND its child is still running. Connects
 * and asks STATUS — never `stat` alone: a lingering host after the child's exit
 * owns the name but is not a session.
 */
export async function hostHasSession(label: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = await liveHostSocket(label, env)
  if (!path) return false
  return hostSocketAlive(path)
}

async function hostSocketAlive(path: string): Promise<boolean> {
  const c = connectHost(path, { mode: 'reader' })
  try {
    await c.welcome
    const st = await c.status()
    return st.alive
  } catch {
    return false
  } finally {
    c.destroy()
  }
}

/**
 * Every durable label a live host on this machine is still RUNNING: readdir plus
 * one connect probe per socket. A socket nobody answers is unlinked; a host whose
 * child exited (lingering) is excluded, as abduco's terminated masters are.
 */
export async function listLiveHostLabels(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const labels = new Set<string>()
  for (const dir of hostSocketDirs(env)) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.sock') || name.startsWith('.')) continue
      const path = join(dir, name)
      const probe = await probeHostSocket(path)
      if (probe === 'refused') {
        try {
          unlinkSync(path)
        } catch {
          // raced with the host's own unlink
        }
        continue
      }
      if (probe !== 'live') continue
      if (await hostSocketAlive(path)) labels.add(name.slice(0, -'.sock'.length))
    }
  }
  return [...labels]
}

/**
 * End the session: a writer HELLO followed by KILL (SIGTERM, SIGKILL after 5 s,
 * EXITED, host exits). When the lease is held by someone else the host itself is
 * signalled instead — SIGTERM, which the host turns into the same KILL sequence
 * and escalates on its own. The systemd scope is swept in parallel, as for abduco.
 */
export async function killHostSession(
  label: string,
  run: SystemctlRunner = execFileAsync,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const scope = stopSessionScope(label, run)
  const path = await liveHostSocket(label, env)
  if (path) {
    const c = connectHost(path, { mode: 'writer' })
    try {
      const w = await c.welcome
      if (w.lease) {
        c.kill()
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 7000)
          c.onExit(() => {
            clearTimeout(t)
            resolve()
          })
          c.onClose(() => {
            clearTimeout(t)
            resolve()
          })
        })
      } else {
        try {
          process.kill(w.hostPid, 'SIGTERM')
        } catch {
          // already gone
        }
      }
    } catch {
      // the host went away under us
    } finally {
      c.destroy()
    }
  }
  await scope
}

const execFileAsync = promisify(execFile)

/** Free a stale scope squatting this label's unit name, guarded on no live host. */
async function reclaimStaleHostScope(
  label: string,
  env: NodeJS.ProcessEnv,
  run: SystemctlRunner = execFileAsync,
): Promise<void> {
  if (await liveHostSocket(label, env)) return
  for (const args of scopeReclaimArgvs(scopeUnitName(label))) {
    try {
      await run('systemctl', args, { timeout: 8000, env: scopeEnv(env) })
    } catch {
      // best-effort
    }
  }
}

// ---- AgentSession over a host connection ------------------------------------

const CTRL_L = Uint8Array.of(0x0c)

export interface HostAttachOptions {
  label: string
  /** Existing socket path; resolved from the label when absent. */
  socketPath?: string
  /**
   * Resume point: the seq after the last DATA byte the caller saw (a reconnect
   * replays exactly what was missed), `0n` for everything the ring holds (the
   * attach right after a create), or `'tail'` for new output only.
   */
  fromSeq?: bigint | 'tail'
  /** Reattaching a shell: `redraw()` defaults to the hard Ctrl-L repaint. */
  hardRepaint?: boolean
  env?: Record<string, string>
}

/**
 * An {@link AgentSession} over the host, plus what only this backend can say:
 * `ready` resolves with the WELCOME (child pid, kernel size, seq range, lease),
 * `connection` is the wire for callers that need STATUS or the resume seq.
 */
export interface HostAgentSession extends AgentSession {
  readonly ready: Promise<HostWelcome>
  readonly connection: HostConnection
  /** Kernel-reported size after the last RESIZED (or WELCOME); undefined until then. */
  readonly appliedGeometry: Geometry | undefined
  /**
   * Replay the last `tailBytes` of the host's ring through `onFrame` — what a
   * viewer needs after a joint server+daemon restart, when the server's log is
   * empty and this daemon knows no seq. Nothing reaches the program (no signal,
   * no resize), unlike `redraw()`.
   */
  replay(tailBytes: number): Promise<void>
}

/**
 * Attach to a host as the writer. The connection is wrapped as a
 * `PtyProcess`-shaped view and handed to {@link wrapPty}, so frame/title/exit
 * plumbing is the one every backend uses. Differences from abduco, all in the
 * host's favour: `resize()` is acknowledged and `appliedGeometry` is the size the
 * KERNEL reports after it; the attach announces nothing to the program; `pid` is
 * the child's; `onExit` carries the real status; DATA arrives with sequence
 * numbers so a reconnect replays what was missed instead of asking for a repaint.
 */
export function attachHostAgent(opts: HostAttachOptions): HostAgentSession {
  const env = { ...process.env, ...opts.env } as NodeJS.ProcessEnv
  const socketPath = opts.socketPath ?? hostSocketPath(opts.label, env)
  const from = opts.fromSeq === undefined || opts.fromSeq === 'tail' ? HOST_TAIL : opts.fromSeq
  const conn = connectHost(socketPath, { mode: 'writer', fromSeq: from })

  let applied: Geometry | undefined
  let childPid = 0
  let dataCb: ((bytes: Uint8Array) => void) | undefined
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined
  let disposed = false

  conn.onData((_seq, data) => dataCb?.(data))
  conn.onExit((code, signal) => exitCb?.({ exitCode: code, ...(signal ? { signal } : {}) }))
  conn.onClose((err) => {
    // A connection lost while the child is alive is not an exit; the daemon's
    // reattach path resumes from `connection.lastSeq`. Only surface the drop.
    if (err && !disposed) log.warn('podium-host connection dropped', { label: opts.label, err })
  })
  conn.onError((err) => log.warn('podium-host refused a request', { label: opts.label, err: err.message }))

  const ready = conn.welcome.then((w) => {
    childPid = w.childPid
    if (w.hasPty) applied = { cols: w.cols, rows: w.rows }
    if (!w.lease) log.warn('podium-host granted no writer lease — another writer is attached', { label: opts.label })
    return w
  })
  ready.catch(() => {})

  const proc: PtyProcess = {
    get pid() {
      return childPid
    },
    onData(cb) {
      dataCb = cb
    },
    onExit(cb) {
      exitCb = cb
    },
    write(data) {
      conn.write(data).catch(() => {})
    },
    resize(cols, rows) {
      conn
        .resize(cols, rows)
        .then((r) => {
          applied = { cols: r.cols, rows: r.rows }
        })
        .catch(() => {})
    },
    kill() {
      conn.detach()
    },
  }

  const base = wrapPty(proc, { cols: 0, rows: 0 })
  const session = withHardRepaint(base, opts.hardRepaint ?? false)
  let restoreOff: (() => void) | undefined

  return {
    ...session,
    ready,
    connection: conn,
    async replay(tailBytes) {
      if (disposed) return
      await ready
      await conn.replay(tailBytes)
    },
    get pid() {
      return childPid
    },
    get appliedGeometry() {
      return applied
    },
    geometry() {
      return applied ?? { cols: 0, rows: 0 }
    },
    redraw(o) {
      if (disposed) return
      // A repaint is the program's behaviour, so the nudge is unchanged: Ctrl-L
      // for idle shells, then a one-row shrink restored on the program's next
      // frame — every step an acknowledged RESIZE through the host. Needs the
      // kernel size, so it waits for WELCOME.
      void ready.then(() => {
        if (disposed) return
        if (o?.hard) proc.write(CTRL_L)
        const g = applied
        if (!g || g.rows <= 1) {
          if (!o?.hard) proc.write(CTRL_L)
          return
        }
        restoreOff?.()
        proc.resize(g.cols, g.rows - 1)
        const off = conn.onData(() => {
          off()
          restoreOff = undefined
          if (!disposed) proc.resize(g.cols, g.rows)
        })
        restoreOff = off
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      restoreOff?.()
      session.dispose() // calls proc.kill → DETACH
    },
  }
}

// ---- spawn -------------------------------------------------------------------

/**
 * Create a host running the agent, then attach as the writer. Mirrors
 * {@link spawnAbducoAgent}: a live host under the label is ADOPTED; a create that
 * finds one already running (exit 3) adopts it too; on Linux the host is launched
 * in the same transient systemd scope, with the same unit name and budget, so it
 * outlives a redeploy.
 */
export async function spawnHostAgent(opts: AbducoSpawnOptions): Promise<HostAgentSession> {
  const bin = resolveHostBin()
  if (!bin) throw new Error('podium-host unavailable: no managed build could be made')
  const childEnv: Record<string, string> = {
    ...scopeEnv(liveEnv()),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...opts.env,
  }
  for (const key of opts.stripEnv ?? []) delete childEnv[key]
  const dir = hostSocketDir(childEnv)
  const socketPath = join(dir, `${opts.label}.sock`)
  assertLinuxUnixSocketPath(socketPath, resolveInstanceId(childEnv), 'a podium-host session socket')
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const adopt = async (path: string): Promise<HostAgentSession> => {
    log.info('durable label already owned by a live host — adopting it', { label: opts.label, path })
    const s = attachHostAgent({ label: opts.label, socketPath: path, fromSeq: 'tail', ...(opts.env ? { env: opts.env } : {}) })
    await s.ready
    return Object.assign(s, { adopted: true })
  }
  const live = await liveHostSocket(opts.label, childEnv)
  if (live && (await hostSocketAlive(live))) return adopt(live)

  const createArgs = [
    'create',
    '--socket',
    socketPath,
    '--cols',
    String(opts.cols),
    '--rows',
    String(opts.rows),
    '--cwd',
    opts.cwd ?? process.cwd(),
    '--',
    opts.cmd,
    ...(opts.args ?? []),
  ]
  const execOpts = { cwd: opts.cwd ?? process.cwd(), env: childEnv } as const
  const attachCreated = async (): Promise<HostAgentSession> => {
    const path = await waitForHostSocket(opts.label, childEnv)
    // From seq 0: the child's first bytes are in the ring already; nothing is missed.
    const s = attachHostAgent({ label: opts.label, socketPath: path, fromSeq: 0n, ...(opts.env ? { env: opts.env } : {}) })
    await s.ready
    return s
  }
  const adoptRaceWinner = async (): Promise<HostAgentSession | undefined> => {
    const raced = await liveHostSocket(opts.label, childEnv)
    return raced ? adopt(raced) : undefined
  }

  if (await canScopeMaster()) {
    await reclaimStaleHostScope(opts.label, childEnv)
    let createdInScope = false
    try {
      await execCreate(
        'systemd-run',
        systemdScopeArgv(scopeUnitName(opts.label), [bin, ...createArgs], {
          budget: resolveScopeBudget(opts.scopeRole ?? 'session'),
        }),
        execOpts,
      )
      createdInScope = true
      void applySessionsSliceBudget()
    } catch (err) {
      const raced = await adoptRaceWinner()
      if (raced) return raced
      log.warn('systemd scope unavailable; session will NOT survive a podium restart', {
        label: opts.label,
        err,
      })
    }
    if (createdInScope) return attachCreated()
  } else if (process.platform === 'linux' && !process.env.PODIUM_NO_SCOPE && !scopeWarned) {
    scopeWarned = true
    log.warn(
      'no systemd user manager reachable (XDG_RUNTIME_DIR/linger missing?); durable sessions ' +
        'will NOT survive a podium restart — run `loginctl enable-linger <user>`',
    )
  }
  try {
    await execCreate(bin, createArgs, execOpts)
  } catch (err) {
    const raced = await adoptRaceWinner()
    if (!raced) throw err
    return raced
  }
  return attachCreated()
}

let scopeWarned = false
