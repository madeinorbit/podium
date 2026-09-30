import { StringDecoder } from 'node:string_decoder'
import type { Geometry } from '@podium/model'
import { defaultPtyBackend } from './backends/index.js'
import type { PtyBackend, PtyProcess } from './backends/types.js'
import { createTitleScanner } from './osc-title.js'

export interface SpawnOptions {
  cmd: string
  args?: string[]
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  /** Variables to REMOVE from what the child inherits. `env` cannot express this:
   *  an empty `ANTHROPIC_API_KEY` is still a set one to a CLI that tests presence.
   *  Same contract as the durable spawn's option of the same name
   *  (`DurableSpawnOptions.stripEnv`) — every backend must honour it or the
   *  guarantee depends on which one a machine happens to run. */
  stripEnv?: readonly string[]
}

export interface AgentFrame {
  seq: number
  /** Raw PTY output bytes, copied from the backend-owned read buffer. */
  data: Uint8Array
}

/**
 * A PICTURE of the screen, in its place in the output stream (POD-4912): the
 * whole terminal state at that point, as bytes that rebuild it on a fresh
 * terminal of `cols` x `rows` (they start with RIS). The DATA after it goes on
 * from there. `reset` answers a request or follows a resize; `cut` bounds the
 * tail. Only a host that keeps the screen sends one, and only once asked.
 */
export interface AgentPicture {
  reason: 'reset' | 'cut'
  cols: number
  rows: number
  bytes: Uint8Array
}

/**
 * THE ATTACHMENT HANDLE (POD-4434): one live connection to a durable process.
 *
 * Renamed in POD-4434 because it never was a session — it is the one live
 * connection a {@link Terminal} owns over the process its Session owns.
 * The host adapter implements it (via {@link wrapPty}); the
 * daemon's Terminal is the only thing that holds one.
 */
export interface DurableAttachment {
  readonly pid: number
  onFrame(cb: (frame: AgentFrame) => void): () => void
  /** Live terminal title (OSC 0/1/2) the agent set, emitted on each change. */
  onTitle(cb: (title: string) => void): () => void
  onExit(cb: (code: number) => void): () => void
  /** Legacy base64 adapter for input bytes; new callers should use writeBytes. */
  write(dataBase64: string): void
  /** Canonical PTY input boundary: write the exact bytes without text conversion. */
  writeBytes(data: Uint8Array): void
  /**
   * THE ASK (POD-4723, design rev 3): put the program at this size. It moves
   * nothing on the caller's side — the kernel's answer arrives through
   * {@link onSize}. A host answers with a promise that REJECTS when it refuses
   * (not the writer, no pty, exited) or the connection is gone, so the caller
   * can log the refusal; a backend with no acknowledgement returns nothing.
   */
  resize(cols: number, rows: number): Promise<void> | void
  /**
   * The kernel's size as the host last stated it (WELCOME or RESIZED), or
   * `undefined` before the first statement. A method, never a copied field:
   * a spread of the attachment must not freeze it. Absent on backends that
   * cannot read the size back (a direct pty) — those report nothing.
   */
  size?(): Geometry | undefined
  /**
   * THE SIZE EVENT: fired with the kernel's size on every WELCOME and RESIZED.
   * The only thing a daemon moves its report, model, observers and composer
   * on. Absent where {@link size} is.
   */
  onSize?(cb: (size: Geometry) => void): () => void
  /**
   * THE WRITER LEASE (POD-4888): whether this attachment is, right now, the
   * ONLY thing that can write into the terminal. A host answers from its lease
   * (granted in WELCOME or taken by a steal, gone on LEASE_LOST or a dropped
   * connection). Absent where there is no lease to hold (a direct pty), so
   * nothing can be the only writer.
   */
  holdsWriterLease?(): boolean
  /**
   * Fired when this attachment stops being the only writer: the host revoked
   * its lease (a steal) or the connection that held it dropped. Absent where
   * {@link holdsWriterLease} is.
   */
  onLeaseLost?(cb: () => void): () => void
  /**
   * PICTURES, IN STREAM ORDER WITH {@link onFrame} (POD-4912): both are called
   * synchronously from the one ordered read, so a subscriber to both sees
   * exactly the host's order. Absent on backends that keep no screen.
   */
  onPicture?(cb: (picture: AgentPicture) => void): () => void
  /** The host keeps the screen and answers a picture request (its WELCOME said so). */
  keepsScreen?(): boolean
  /**
   * Ask for a `reset` picture, which arrives through {@link onPicture} in its
   * place in the stream. False when the backend keeps no screen.
   */
  requestPicture?(): boolean
  /**
   * This attachment started at the output TAIL: it has seen none of what the
   * program drew before it, so only a picture can rebuild that.
   */
  readonly attachedAtTail?: boolean

  dispose(): void
  /**
   * Set when a spawn ADOPTED a durable master that already owned the label instead
   * of creating one (see `spawnHostAgent`). The caller started nothing: it
   * is attached to the agent that was already running, and should say so rather
   * than report a fresh launch.
   */
  readonly adopted?: boolean
}

export function spawnAgent(
  opts: SpawnOptions,
  backend: PtyBackend = defaultPtyBackend(),
): DurableAttachment {
  const childEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...opts.env,
  } as Record<string, string>
  // After the merge, so a caller cannot strip a variable it also set — the same
  // ordering rule (and reason) as the host path.
  for (const key of opts.stripEnv ?? []) delete childEnv[key]
  const proc = backend.spawn({
    file: opts.cmd,
    args: opts.args ?? [],
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd ?? process.cwd(),
    // The frontend is xterm.js, which renders 24-bit color. TERM=xterm-256color is set
    // explicitly so every launch advertises the same terminal capabilities.
    // COLORTERM is the companion signal supports-color/chalk read to unlock truecolor;
    // without it agents like Claude Code degrade to a 256-color approximation. We assert
    // both after process.env (the frontend's capability doesn't depend on how the daemon
    // was launched) but before opts.env so callers/tests can still override.
    env: childEnv,
  })
  return wrapPty(proc)
}

export function wrapPty(proc: PtyProcess): DurableAttachment {
  let seq = 0
  let disposed = false
  const frameCbs = new Set<(f: AgentFrame) => void>()
  const exitCbs = new Set<(code: number) => void>()
  const titleCbs = new Set<(t: string) => void>()
  const titleScanner = createTitleScanner()
  // The backend delivers raw bytes; a streaming decoder reassembles multi-byte chars
  // (and escape sequences) split across reads so the title scanner sees whole strings.
  const decoder = new StringDecoder('utf8')
  let lastTitle: string | undefined

  proc.onData((bytes: Uint8Array) => {
    const buf = Buffer.from(bytes)
    const frame: AgentFrame = { seq, data: buf }
    seq += 1
    for (const cb of [...frameCbs]) cb(frame)
    for (const raw of titleScanner.push(decoder.write(buf))) {
      // Strip stray control chars; keep the spinner/brand glyphs. Skip empty
      // titles and unchanged repeats so we don't churn the relay.
      const title = raw.replace(/\p{Cc}/gu, '').trim()
      if (!title || title === lastTitle) continue
      lastTitle = title
      for (const cb of [...titleCbs]) cb(title)
    }
  })

  proc.onExit(({ exitCode }) => {
    for (const cb of [...exitCbs]) cb(exitCode)
  })

  return {
    get pid() {
      return proc.pid
    },
    onFrame(cb) {
      frameCbs.add(cb)
      return () => frameCbs.delete(cb)
    },
    onTitle(cb) {
      titleCbs.add(cb)
      return () => titleCbs.delete(cb)
    },
    onExit(cb) {
      exitCbs.add(cb)
      return () => exitCbs.delete(cb)
    },
    writeBytes(data) {
      if (disposed) return
      proc.write(data)
    },
    write(dataBase64) {
      if (disposed) return
      proc.write(Buffer.from(dataBase64, 'base64'))
    },
    resize(c, r) {
      if (disposed) return
      proc.resize(c, r)
    },
    dispose() {
      if (disposed) return
      disposed = true
      frameCbs.clear()
      titleCbs.clear()
      exitCbs.clear()
      try {
        proc.kill()
      } catch {
        // process already exited
      }
    },
  }
}
