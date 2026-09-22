// packages/harness/src/driver/families/headless/turn.ts
//
// ONE-SHOT HEADLESS TURNS UNDER PODIUM-HOST (POD-4614).
//
// Superagent and shipwright turns are one harness invocation each. They used
// to run as raw daemon children (apps/daemon/src/headless-drivers.ts) or as an
// abduco-hosted shell that journalled stdout, stderr, identity and result to
// files (apps/daemon/src/durable-headless.ts). Both are gone: a turn is a
// podium-host --no-pty process started through the session layer's
// `EngineProcessOwner` — the same door every engine uses — under the owning
// session's durable label.
//
// WHERE DURABILITY LIVES. In the host. The turn's stdout and stderr land in
// the host's sequence-numbered ring; the host keeps the ring after the child
// exits (`HEADLESS_TURN_RETENTION`), reports the real exit status, and a
// restarted daemon re-attaches from seq 0 and replays everything. The turn's
// identity and original start time ride the ring's first line (./wrapper.ts),
// so a replay adopts only its own turn and keeps the original deadline. Nothing
// is written to disk. The host is released when the server acknowledges the
// result (`acknowledgeHostedTurn`), or replaced by the session's next turn.
//
// WHAT THIS FAMILY NEVER DOES. Spawn, re-attach, probe or reap a process by
// itself: every process act goes through the injected owner (spec §7). It
// composes the invocation and reads the output; the supervisor composes the
// environment.

import type { ResolvedHarnessInventory } from '../../../inventory/build-inventory.js'
import { parseCursorChatId } from '../../../registry.js'
import { createClaudeStreamClient, type ClaudeStreamTransport } from '../claude-sdk/protocol.js'
import type { EngineAttachment, EngineProcessOwner } from '../engine-supervision.js'
import { HeadlessTurnFailure } from '../turn-error.js'
import { createHeadlessProgressReader, foldHeadlessOutcome } from './fold.js'
import {
  allocationInvocation,
  composeHeadlessInvocation,
  type HeadlessInvocation,
  headlessFor,
  needsAllocation,
} from './invocation.js'
import {
  DEFAULT_HEADLESS_TURN_TIMEOUT_MS,
  type HeadlessEmit,
  HeadlessTurnError,
  type HeadlessTurnHandle,
  type HeadlessTurnHooks,
  type HeadlessTurnOutcome,
  type HeadlessTurnSpec,
  type HostedTurnIdentity,
} from './types.js'
import {
  createTurnLineSplitter,
  type TurnMarker,
  type TurnPhase,
  turnIdentityHash,
  wrapTurnInvocation,
} from './wrapper.js'

/**
 * How long a turn's host keeps its ring after the child exits, and how big
 * the ring is. An hour covers a daemon restart and a server reconnect with
 * room to spare; the server's acknowledgement (or the session's next turn)
 * releases the host long before that in the normal case. 32 MiB holds the
 * whole JSON stream of any turn this product runs — the identity marker is the
 * first line and must still be there when a restarted daemon replays.
 */
export const HEADLESS_TURN_RETENTION = { lingerSecs: 3600, ringBytes: 32 << 20 } as const

/** How long a politely-interrupted turn gets before the host kills its group. */
const INTERRUPT_GRACE_MS = 5_000
/** How long a stream-json turn gets to wind down after a polite interrupt. */
const STRUCTURED_INTERRUPT_GRACE_MS = 15_000
/** How long a replay may take to show its first line before it is judged unreadable. */
const MARKER_WAIT_MS = 5_000
/** How long a released label may take to free its socket. */
const LABEL_FREE_WAIT_MS = 5_000

const SIGTERM = 15
const SIGKILL = 9

/** What the supervisor hands this family. */
export interface HostedTurnDeps {
  /** The session layer's process owner (podium-host). */
  owner: EngineProcessOwner
  /**
   * The fully composed child environment for one invocation, with the
   * variables to strip at the process boundary. Stored-login precedence and
   * the instance home are the supervisor's decision; the adapter's per-turn
   * env (`execEnv`) and the family's overlay arrive as inputs.
   */
  childEnv(input: {
    execEnv?: Record<string, string>
    envOverlay?: Record<string, string>
  }): { env: Record<string, string>; stripEnv: readonly string[] }
  now?(): number
  /** Whether the daemon runs as root (claude refuses bypass as root without IS_SANDBOX). */
  isRoot?: boolean
}

export interface HostedTurnInput {
  spec: HeadlessTurnSpec
  identity: HostedTurnIdentity
  snapshot: ResolvedHarnessInventory
  emit: HeadlessEmit
  hooks?: HeadlessTurnHooks
}

// ---------------------------------------------------------------------------
// One observed run: a reader attachment folded into lines, stdout, stderr, exit
// ---------------------------------------------------------------------------

interface ObservedRun {
  /** The first line — the marker when the ring still starts at seq 0. */
  readonly marker: Promise<{ marker: TurnMarker | undefined } | undefined>
  readonly exited: Promise<{ code: number; signal: number }>
  readonly stdout: () => string
  readonly stderrTail: () => string
  onStdoutLine(cb: (line: string) => void): void
  dispose(): void
}

function observeRun(attachment: EngineAttachment): ObservedRun {
  let stdout = ''
  let stderrTail = ''
  const stdoutCbs: ((line: string) => void)[] = []
  let resolveMarker!: (value: { marker: TurnMarker | undefined } | undefined) => void
  const marker = new Promise<{ marker: TurnMarker | undefined } | undefined>((resolve) => {
    resolveMarker = resolve
  })
  let resolveExit!: (value: { code: number; signal: number }) => void
  const exited = new Promise<{ code: number; signal: number }>((resolve) => {
    resolveExit = resolve
  })
  const splitter = createTurnLineSplitter((line) => {
    if (line.kind === 'marker') {
      resolveMarker({ marker: line.marker })
      return
    }
    if (line.kind === 'stderr') {
      stderrTail = `${stderrTail}${line.line}\n`.slice(-8192)
      return
    }
    stdout += `${line.line}\n`
    for (const cb of stdoutCbs) cb(line.line)
  })
  const offData = attachment.connection.onData((seq, data) => splitter.push(seq, data))
  const offExit = attachment.connection.onExit((code, signal) => {
    splitter.flush()
    // A ring that ended before any line: nothing to identify.
    resolveMarker(undefined)
    resolveExit({ code, signal })
  })
  // A ring the daemon could not read (no host after all) resolves nothing on
  // its own; the caller times the marker out.
  void attachment.ready.catch(() => resolveMarker(undefined))
  return {
    marker,
    exited,
    stdout: () => stdout,
    stderrTail: () => stderrTail,
    onStdoutLine(cb) {
      stdoutCbs.push(cb)
    },
    dispose() {
      offData()
      offExit()
      attachment.dispose()
    },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
    void promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

/** Attach to whatever host holds the label, replaying from seq 0; undefined
 *  when no host answers. */
async function replayLabel(
  owner: EngineProcessOwner,
  label: string,
): Promise<{ attachment: EngineAttachment; run: ObservedRun } | undefined> {
  let attachment: EngineAttachment
  try {
    attachment = (await owner.reattachEngine({ label, fromSeq: 0n })).attachment
  } catch {
    return undefined
  }
  // Subscribe BEFORE the socket connects: every replayed byte is seen.
  const run = observeRun(attachment)
  try {
    await attachment.ready
  } catch {
    run.dispose()
    return undefined
  }
  return { attachment, run }
}

/** Release a label and wait for its socket to go: a lingering host answers
 *  attaches (and refuses a create under its name) until it has exited. */
async function releaseLabel(owner: EngineProcessOwner, label: string): Promise<void> {
  await owner.destroyEngine(label)
  const deadline = Date.now() + LABEL_FREE_WAIT_MS
  while (Date.now() < deadline) {
    let attachment: EngineAttachment
    try {
      attachment = (await owner.reattachEngine({ label, fromSeq: 'tail' })).attachment
    } catch {
      return
    }
    const answered = await attachment.ready.then(
      () => true,
      () => false,
    )
    attachment.dispose()
    if (!answered) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`podium-host label '${label}' did not free within ${LABEL_FREE_WAIT_MS}ms`)
}

function exitCodeOf(exit: { code: number; signal: number }): number {
  return exit.signal ? 128 + exit.signal : exit.code
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

/**
 * Run (or adopt, or replay) one headless turn under podium-host.
 *
 * The label is the session's durable label. What the label already holds
 * decides the path: nothing → start the turn; this turn (by identity marker)
 * → adopt it, replaying its whole ring, keeping its original deadline; a
 * DIFFERENT turn still running → refuse (never a rerun, never a second
 * writer); a different turn that already exited → release it and start.
 */
export function runHostedHeadlessTurn(
  deps: HostedTurnDeps,
  input: HostedTurnInput,
): HeadlessTurnHandle {
  const { spec, identity, snapshot, emit } = input
  const label = spec.durableLabel
  if (!label) throw new Error('a hosted headless turn needs the session durable label')
  const headless = headlessFor(spec.agent)
  const now = deps.now ?? Date.now
  const identityHash = turnIdentityHash(identity)
  const timeoutMs = spec.timeoutMs ?? DEFAULT_HEADLESS_TURN_TIMEOUT_MS
  const structured = spec.structuredPermissions === true

  let settled = false
  let disposed = false
  let pinned: string | undefined
  let control: EngineAttachment | undefined
  let current: ObservedRun | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let structuredTurn: { interrupt(): void } | undefined
  let structuredClient: ReturnType<typeof createClaudeStreamClient> | undefined
  let resolveDone!: (value: HeadlessTurnOutcome) => void
  let rejectDone!: (reason: unknown) => void
  const done = new Promise<HeadlessTurnOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  // An owner that only interrupts still needs the silence: the rejection is
  // the turn's own, observed by whoever awaits `done`.
  done.catch(() => {})

  const detach = (): void => {
    if (deadline) clearTimeout(deadline)
    current?.dispose()
    current = undefined
    control?.dispose()
    control = undefined
  }

  const finish = (result: { ok: true; outcome: HeadlessTurnOutcome } | { ok: false; error: unknown }): void => {
    if (settled || disposed) return
    settled = true
    if (deadline) clearTimeout(deadline)
    if (result.ok) {
      resolveDone(result.outcome)
    } else {
      const error = result.error
      if (error instanceof HeadlessTurnFailure) {
        rejectDone(
          error.harnessSessionId || !pinned ? error : new HeadlessTurnError(error.message, pinned),
        )
      } else {
        rejectDone(
          new HeadlessTurnError(error instanceof Error ? error.message : String(error), pinned),
        )
      }
    }
    // The host keeps the ring for a replay; this generation lets go of it.
    // (A killer timer still owns the connection it signals through.)
    if (!killTimer) detach()
  }

  /** SIGTERM the turn's process group (unless `polite`: the caller already
   *  asked the child to stop over its own protocol), SIGKILL after a grace
   *  period. The host keeps the ring either way. */
  const stopChild = (graceMs: number, polite = false): void => {
    const conn = control
    // No lease-holding connection yet: the turn is still probing its label or
    // starting its host. Killing by label here could hit a DIFFERENT turn the
    // probe has not ruled out; `main` stops the child itself once the start
    // returns and finds the turn already settled.
    if (!conn) return
    if (!polite) {
      try {
        conn.connection.signal(SIGTERM)
      } catch {
        // Already gone.
      }
    }
    if (killTimer) return
    killTimer = setTimeout(() => {
      try {
        conn.connection.signal(SIGKILL)
      } catch {
        // Already gone.
      }
      killTimer = undefined
      detach()
    }, graceMs)
    killTimer.unref?.()
    void current?.exited.then(() => {
      if (killTimer) clearTimeout(killTimer)
      killTimer = undefined
      if (settled) detach()
    })
  }

  const armDeadline = (createdAt: number): void => {
    const remaining = Math.max(1, timeoutMs - (now() - createdAt))
    deadline = setTimeout(() => {
      if (settled || disposed) return
      stopChild(INTERRUPT_GRACE_MS)
      finish({ ok: false, error: new HeadlessTurnError('turn timed out', pinned) })
    }, remaining)
    deadline.unref?.()
  }

  /** Start one phase under the label. The lease-holding attachment the start
   *  returns becomes `control`; the ring is read through a second attachment
   *  from seq 0, subscribed before it connects, so no byte is missed. */
  const start = async (
    phase: TurnPhase,
    invocation: HeadlessInvocation,
    createdAt: number,
  ): Promise<ObservedRun> => {
    const wrapped = wrapTurnInvocation({
      marker: {
        phase,
        identityHash,
        createdAt,
        ...(invocation.pinnedSessionId ? { pinnedSessionId: invocation.pinnedSessionId } : {}),
      },
      stdin: invocation.stdin,
      cmd: invocation.cmd,
      args: invocation.args,
    })
    const { env, stripEnv } = deps.childEnv({
      ...(invocation.execEnv ? { execEnv: invocation.execEnv } : {}),
      ...(invocation.envOverlay ? { envOverlay: invocation.envOverlay } : {}),
    })
    const { attachment: writer } = await deps.owner.startEngine({
      label,
      cmd: wrapped.cmd,
      args: wrapped.args,
      cwd: spec.cwd,
      env,
      stripEnv,
      retention: HEADLESS_TURN_RETENTION,
    })
    control = writer
    const replay = await replayLabel(deps.owner, label)
    if (!replay) throw new Error(`podium-host for '${label}' vanished right after it started`)
    current = replay.run
    if (invocation.stdin.kind === 'bytes') {
      const write = writer.connection.write
      if (!write) throw new Error(`podium-host for '${label}' has no write channel for the turn's stdin`)
      await write.call(writer.connection, Buffer.from(invocation.stdin.data, 'utf8'))
    }
    return replay.run
  }

  /** Wait out an allocation run and read the conversation id it printed. */
  const allocate = async (run: ObservedRun): Promise<string> => {
    const exit = await run.exited
    const code = exitCodeOf(exit)
    if (code !== 0) {
      const tail = run.stderrTail().trim()
      throw new Error(
        `conversation allocation exited ${code}${tail ? `: ${tail.slice(-2000)}` : ''}`,
      )
    }
    return parseCursorChatId(run.stdout().trim())
  }

  /** Fold a non-interactive run to its outcome once the host says it exited. */
  const collect = async (run: ObservedRun): Promise<void> => {
    const reader = createHeadlessProgressReader(headless.outputFormat, emit)
    // Lines already folded into `stdout` before this subscription replay first.
    for (const line of run.stdout().split('\n')) if (line) reader.line(line)
    run.onStdoutLine((line) => reader.line(line))
    const exit = await run.exited
    if (settled || disposed) return
    try {
      const outcome = foldHeadlessOutcome({
        outputFormat: headless.outputFormat,
        stdout: run.stdout(),
        stderrTail: run.stderrTail(),
        exitCode: exitCodeOf(exit),
        ...(pinned ? { pinnedSessionId: pinned } : {}),
        agent: spec.agent,
      })
      if (headless.outputFormat === 'text' && outcome.output) {
        emit({ kind: 'partial-text', text: outcome.output })
      }
      finish({ ok: true, outcome })
    } catch (error) {
      finish({ ok: false, error })
    }
  }

  /** The stream-json claude turn: a live conversation over the host's write
   *  channel, with the permission callback wired to the caller's hooks. */
  const converse = (run: ObservedRun): void => {
    const conn = control
    const write = conn?.connection.write
    if (!conn || !write) throw new Error(`podium-host for '${label}' has no write channel`)
    const lineCbs = new Set<(line: string) => void>()
    const exitCbs = new Set<(code: number | null, signal: string | null) => void>()
    run.onStdoutLine((line) => {
      if (!line.trim()) return
      for (const cb of [...lineCbs]) cb(line)
    })
    void run.exited.then((exit) => {
      for (const cb of [...exitCbs]) cb(exit.code, exit.signal ? String(exit.signal) : null)
    })
    const transport: ClaudeStreamTransport = {
      writeLine(line) {
        write.call(conn.connection, Buffer.from(`${line}\n`, 'utf8')).catch(() => {
          // A write to a dead channel is the child being gone; the exit
          // handler reports the death, once, with the real reason.
        })
      },
      onLine(cb) {
        lineCbs.add(cb)
        return () => lineCbs.delete(cb)
      },
      onExit(cb) {
        exitCbs.add(cb)
        return () => exitCbs.delete(cb)
      },
      close() {
        stopChild(0)
      },
    }
    const client = createClaudeStreamClient(transport, {
      ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
      ...(spec.contextPrompt ? { contextPrompt: spec.contextPrompt } : {}),
      timeoutMs,
    })
    structuredClient = client
    const hooks = input.hooks
    const turn = client.turn(spec.prompt, {
      onPartialText: (text, itemHint) =>
        emit({ kind: 'partial-text', text, ...(itemHint ? { itemHint } : {}) }),
      onPermission: (request) => hooks?.onPermission?.(request),
      onToolCall: (call) => hooks?.onToolCall?.(call),
      onToolResult: (result) => hooks?.onToolResult?.(result),
      emit,
    })
    structuredTurn = turn
    // One turn, then the child goes: a stream-json CLI otherwise waits on
    // stdin for the next message forever, and its host with it.
    void turn.done.then(
      () => stopChild(INTERRUPT_GRACE_MS),
      () => stopChild(INTERRUPT_GRACE_MS),
    )
    turn.done.then(
      (outcome) => finish({ ok: true, outcome }),
      (error: unknown) => {
        const tail = run.stderrTail().trim().slice(-2000)
        if (error instanceof HeadlessTurnFailure && tail) {
          finish({
            ok: false,
            error: new HeadlessTurnFailure(`${error.message}: ${tail}`, error.harnessSessionId),
          })
          return
        }
        finish({ ok: false, error })
      },
    )
  }

  const main = async (): Promise<void> => {
    let found = await replayLabel(deps.owner, label)
    let adopted: { run: ObservedRun; marker: TurnMarker } | undefined
    if (found) {
      const first = await withTimeout(found.run.marker, MARKER_WAIT_MS, undefined)
      const marker = first?.marker
      if (marker && marker.identityHash === identityHash) {
        adopted = { run: found.run, marker }
        // No other generation holds the lease after a restart: this
        // attachment is the writer, and what signals the turn.
        control = found.attachment
        current = found.run
      } else {
        found.run.dispose()
        found = undefined
        if (await deps.owner.engineAlive(label)) {
          // Another turn still runs under this session's label. Adopting it
          // would read a stranger's output as this turn's; rerunning would
          // put two writers on one conversation.
          throw new HeadlessTurnError(
            marker
              ? 'durable headless replay identity mismatch: the session label runs a different turn'
              : 'durable headless host under this label cannot be identified as this turn',
          )
        }
        // A previous turn's host lingering with its result: the server has
        // moved on to this turn, so that result is no longer anyone's.
        await releaseLabel(deps.owner, label)
      }
    }
    if (disposed) {
      detach()
      return
    }
    if (settled) {
      // Interrupted while adopting: the adopted child is the one to stop.
      if (control) stopChild(INTERRUPT_GRACE_MS)
      return
    }

    const createdAt = adopted?.marker.createdAt ?? now()
    armDeadline(createdAt)

    if (adopted && structured) {
      // A stream-json conversation is live state: its control-request ids
      // died with the generation that opened them, so it cannot be rejoined.
      stopChild(0)
      throw new HeadlessTurnError(
        'a structured-permission turn cannot be adopted across a daemon restart',
        adopted.marker.pinnedSessionId,
      )
    }

    let run: ObservedRun
    if (adopted?.marker.phase === 'turn') {
      pinned = adopted.marker.pinnedSessionId
      run = adopted.run
      emit({ kind: 'status', status: 'running', ...(pinned ? { harnessSessionId: pinned } : {}) })
    } else {
      emit({ kind: 'status', status: 'starting' })
      let allocated: string | undefined
      if (adopted?.marker.phase === 'alloc' || needsAllocation(spec)) {
        const allocRun = adopted?.run ?? (await start('alloc', allocationInvocation(snapshot), createdAt))
        allocated = await allocate(allocRun)
        detach()
        armDeadline(createdAt)
        await releaseLabel(deps.owner, label)
        if (settled || disposed) return
      }
      const invocation = composeHeadlessInvocation(spec, snapshot, {
        ...(allocated ? { allocated } : {}),
        isRoot: deps.isRoot ?? false,
      })
      pinned = invocation.pinnedSessionId
      run = await start('turn', invocation, createdAt)
      if (settled || disposed) {
        // Interrupted while the host was starting: the child must not outlive
        // a turn nobody waits for.
        if (settled) stopChild(INTERRUPT_GRACE_MS)
        else detach()
        return
      }
      emit({ kind: 'status', status: 'running', ...(pinned ? { harnessSessionId: pinned } : {}) })
      if (structured) {
        converse(run)
        return
      }
    }
    await collect(run)
  }

  void main().catch((error: unknown) => finish({ ok: false, error }))

  return {
    turnId: identity.turnId,
    done,
    interrupt: () => {
      if (settled || disposed) return
      if (structuredTurn) {
        structuredTurn.interrupt()
        stopChild(STRUCTURED_INTERRUPT_GRACE_MS, true)
        return
      }
      stopChild(INTERRUPT_GRACE_MS)
      finish({ ok: false, error: new HeadlessTurnError('turn interrupted', pinned) })
    },
    ...(structured
      ? {
          answerPermission: (interactionId: string, answer: Parameters<NonNullable<HeadlessTurnHandle['answerPermission']>>[1]) =>
            structuredClient?.answerPermission(interactionId, answer),
        }
      : {}),
    dispose: () => {
      if (disposed) return
      disposed = true
      if (killTimer) clearTimeout(killTimer)
      killTimer = undefined
      // A stream-json conversation cannot be adopted by the next generation
      // (see `main`), so a detached one would only wait on stdin forever.
      if (structuredClient) {
        try {
          control?.connection.signal(SIGTERM)
        } catch {
          // Already gone.
        }
      }
      detach()
    },
  }
}

/**
 * The server durably committed a turn's result: release the host that held
 * it. Only a host whose identity marker names THIS turn is released, and only
 * once its child has exited — an acknowledgement is never a way to kill a
 * running turn or a stranger's. No host under the label is a no-op (already
 * released, or replaced by the session's next turn).
 */
export async function acknowledgeHostedTurn(
  owner: EngineProcessOwner,
  label: string,
  identity: HostedTurnIdentity,
): Promise<void> {
  const found = await replayLabel(owner, label)
  if (!found) return
  const first = await withTimeout(found.run.marker, MARKER_WAIT_MS, undefined)
  found.run.dispose()
  const marker = first?.marker
  if (!marker || marker.identityHash !== turnIdentityHash(identity)) {
    throw new Error('refusing mismatched durable headless acknowledgement')
  }
  if (await owner.engineAlive(label)) return
  await owner.destroyEngine(label)
}
