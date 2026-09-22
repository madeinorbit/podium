import { DriverRefusalError } from '@podium/harness/driver/host'
/**
 * THE DAEMON, AS THE TERMINAL DRIVER'S HOST (POD-1761 W3).
 *
 * `TerminalRuntimeHost` names the fifteen things a driver needs; this file is
 * where each one is satisfied by the daemon facility that already does it. It is
 * deliberately nothing but wiring — every line below should read as "the driver
 * asks for X, and X is over there". If a body here grows logic, that logic
 * belongs in the facility it is standing in front of.
 *
 * Reading it top to bottom is the fastest way to see that the driver adds no
 * mechanism: bridges, observers, binding labels, the transcript source layer,
 * the handoff transcript locator, the memory breakdown, the survival table's
 * teardown and the spawn path. All of it predates this epic.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  AttachmentStager,
  CodexRawSocket,
  OpencodeEngineClientTerminals,
} from '@podium/harness/driver/host'
import {
  durableProcessFor,
  scopeUnitName,
} from '@podium/process/durable'
import { instanceRuntimeSocketRoot } from '@podium/runtime/abduco-socket'
import { resolveInstanceId } from '@podium/runtime/instance'
import WebSocket from 'ws'
import type { AgentKind, SessionId } from '@podium/model'
import { serverChildEnv } from '../control/session-env'
import type { ClientTerminalKind, OpencodeClientTerminals } from './opencode-attach'
import type { AcceptedDriverId } from '@podium/harness'
import type { DaemonContext } from '../control/context'
import { launchSpawn, recoverTerminalHost, stopSessionProcess } from '../control/session'
import { sourceForRead } from '../control/transcripts'
import { transcriptForExport } from '../handoff-package'
import { stageRuntimeAttachment } from './attachment-staging'
import { reportHarnessProbe } from '../harness-version-reporting'
import type { TerminalRuntimeHost } from './terminal-driver'
import { installTerminalInstrumentation } from '@podium/harness/driver/host'
import { terminalInstrumentationSectionsFor } from './registry'

/**
 * Adapt one daemon context into the driver's host port.
 *
 * `send` is passed in rather than taken from the context on purpose: the
 * composition root wraps the outbound sink so the driver's own `runtimeEvent`
 * frames do not re-enter its observation tap, and doing that wrapping HERE would
 * put the loop-breaking in the same file as the loop.
 */
export function daemonRuntimeHost(
  ctx: DaemonContext,
  send: TerminalRuntimeHost['send'],
  stageAttachment: AttachmentStager = stageRuntimeAttachment,
): TerminalRuntimeHost {
  return {
    send,
    stageAttachment,
    bridge: (sessionId) => ctx.sessions.get(sessionId)?.terminal,
    trackedState: (sessionId) => ctx.observers.trackedState(sessionId),
    draftSyncing: (sessionId) => ctx.composerEngine.has(sessionId),
    setDraftTarget: (sessionId, text) => ctx.composerEngine.setTarget(sessionId, text),
    durableLabel: (sessionId) => ctx.sessions.get(sessionId)?.label ?? ctx.durableLabelFor(sessionId),
    // Absent on macOS, and honestly so: there is no transient scope there, and a
    // fabricated unit name would make `health()` report a cgroup nothing owns.
    scopeUnit: (label) => (process.platform === 'linux' ? scopeUnitName(label) : undefined),
    durableHostAlive: async (label) => (await durableProcessFor(ctx)?.has(label)) ?? false,
    recover: (msg, ready) => recoverTerminalHost(ctx, msg, ready),
    stopSession: (input) => stopSessionProcess(ctx, input),
    installInstrumentation: (sessionId, spec) =>
      installTerminalInstrumentation({
        sessionId,
        harness: spec.harness,
        spec,
        sections: terminalInstrumentationSectionsFor(spec.harness),
        settingsDir: ctx.settingsDir,
        ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
        reportVersionProbe: (harness, output) => reportHarnessProbe(harness, output),
      }),
    launch: (msg, instrumentation) => launchSpawn(ctx, msg, {}, instrumentation, true),
    readHistory: async (session, range) => {
      const segmentId = `history:${session.sessionId}:${session.resume?.value ?? ''}`
      if (range.from && (range.from.segmentId !== segmentId || !range.from.pathHint)) {
        throw new DriverRefusalError({ reason: 'invalid_value', detail: 'foreign history cursor' }, 'transcript.history')
      }
      const source = await sourceForRead(ctx, session)
      const slice = await source.readSlice({
        ...(range.from ? { anchor: range.from.pathHint } : {}),
        direction: range.direction ?? 'before',
        limit: range.limit,
      })
      const cursor = (anchor: string) => ({ segmentId, pathHint: anchor, components: {} })
      return {
        items: slice.items,
        ...(slice.head ? { head: cursor(slice.head) } : {}),
        ...(slice.tail ? { tail: cursor(slice.tail) } : {}),
        hasMore: slice.hasMore,
      }
    },
    archiveTranscript: (input) =>
      transcriptForExport({
        agentKind: input.agentKind,
        cwd: input.cwd,
        resumeValue: input.resumeValue,
        home: ctx.homeDir ?? process.env.HOME ?? '',
      }),
    readFileBytes: async (path) => new Uint8Array(await readFile(path)),
    resources: (subject) =>
      // THE MACHINE'S ONE CGROUP OBSERVER (POD-2413), which already falls back
      // to the `/proc` attribution the `memoryBreakdownRequest` frame answers
      // with when a session has no scope to read. A daemon composed without one
      // reports nothing rather than a zero: "we never looked" and "this session
      // uses no memory and was never OOM-killed" are different statements.
      ctx.scopeMonitor?.resources(subject),
    now: () => Date.now(),
    setTimer: (fn, delayMs) => {
      const handle = setTimeout(fn, delayMs)
      // Unref'd: a pending verification tick must never hold the daemon up on
      // shutdown, exactly as every timer in the ported mechanics is.
      handle.unref?.()
      return handle
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onDrainAbandoned: ({ sessionId, turns, reason }) =>
      send({
        type: 'runtimeQueueDrainAbandoned',
        reportId: randomUUID(),
        sessionId,
        turnIds: turns.map((turn) => turn.id),
        reason,
      }),
  }
}

// ---------------------------------------------------------------------------
// Engine binding journals (1.5, spec §4.8).
//
// The driver families never spawn, journal or kill their engines: process
// acts go through the session layer's `EngineProcessOwner`, and the binding
// journals are created and held there too (`apps/daemon/src/session/`
// `engines.ts`, store in `session/journal.ts`). This re-export keeps the
// existing `./host` import path working for callers outside `session/`.
// ---------------------------------------------------------------------------

export { createEngineJournal } from '../session/journal.js'

/** The supervisor's instance-private socket root (0700): families shape
 *  basenames under it, never locations. */
export function engineSocketRoot(): string {
  return instanceRuntimeSocketRoot(resolveInstanceId())
}

/**
 * Open one WebSocket-over-Unix client to an engine's listener. The supervisor
 * owns the socket library (no compression — Codex's tungstenite acceptor
 * offers plain text frames only — and a large payload ceiling); the retry
 * loop and the transport adapter are the codex family's protocol edge.
 */
export function dialEngineSocket(path: string): Promise<CodexRawSocket> {
  const socket = new WebSocket(`ws+unix://${path}:/rpc`, {
    maxPayload: 128 << 20,
    perMessageDeflate: false,
  })
  // Listener startup is polled by opening real connections. `ws` can emit
  // another error after the first failed attempt is terminated; keep one
  // durable listener so that expected retry cleanup cannot become an
  // unhandled EventEmitter `error` under Bun.
  socket.on('error', () => undefined)
  // The port's surface is narrower than `ws`'s overloads; one honest cast at
  // the boundary rather than a parallel socket type. `unknown[]` rest params
  // accept every listener shape in both directions, which `never[]` does not.
  const narrow = socket as unknown as {
    send(payload: string, cb?: (err?: Error) => void): void
    on(event: string, cb: (...args: unknown[]) => void): void
    once(event: string, cb: (...args: unknown[]) => void): void
    off(event: string, cb: (...args: unknown[]) => void): void
    terminate(): void
  }
  return Promise.resolve({
    send: (payload, cb) => narrow.send(payload, cb),
    on: (event, cb) => narrow.on(event, cb as (...args: unknown[]) => void),
    once: (event, cb) => narrow.once(event, cb as (...args: unknown[]) => void),
    off: (event, cb) => narrow.off(event, cb as (...args: unknown[]) => void),
    terminate: () => {
      try {
        narrow.terminate()
      } catch {
        // Already closed; that is the state we wanted.
      }
    },
  })
}

/**
 * Compose an engine child's environment. The same stored-login precedence
 * merge every other child gets (instance overlay, managed credentials,
 * inherited overrides stripped) — owned here so no family re-derives it.
 * The harness identity arrives as a value the families read off their own
 * adapter sections; no literal here.
 */
export function composeEngineEnv(input: {
  sessionId: SessionId
  agentKind: AgentKind
  homeDir?: string
  sessionEnv?: Readonly<Record<string, string>>
  harnessEnv?: Readonly<Record<string, string>>
  instanceUuid?: string
}): Record<string, string> {
  const env = serverChildEnv({
    ...(input.instanceUuid ? { instanceUuid: input.instanceUuid } : {}),
    sessionId: input.sessionId,
    agentKind: input.agentKind,
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
    ...(input.sessionEnv ? { sessionEnv: input.sessionEnv } : {}),
    ...(input.harnessEnv ? { harnessEnv: input.harnessEnv } : {}),
  })
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}

/**
 * Adapt the daemon's client-terminal host to the engine family's narrow port.
 *
 * The attach kind arrives as the family's own token value; the closed union
 * it is asserted into lives here, beside the type that declares it — the
 * family stays generic over the mechanism, and the one place that knows the
 * closed set keeps knowing it.
 */
export function engineClientTerminals(
  terminals: OpencodeClientTerminals,
): OpencodeEngineClientTerminals {
  return {
    attach: (input) =>
      terminals.attach({
        sessionId: input.sessionId,
        target: {
          ...input.target,
          kind: input.target.kind as ClientTerminalKind,
          driverId: input.target.driverId as AcceptedDriverId,
        },
      }),
    adopt: (sessionId, kind) =>
      terminals.adopt(sessionId, kind as ClientTerminalKind | undefined),
    close: (sessionId, kind) =>
      terminals.close(sessionId, kind as ClientTerminalKind | undefined),
    relaunch: (sessionId, kind) =>
      terminals.relaunch(sessionId, kind as ClientTerminalKind),
  }
}
