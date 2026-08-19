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
import type { AttachmentStager } from '@podium/agent-runtime'
import { abducoHasSession, scopeUnitName, tmuxHasSession } from '@podium/pty'
import type { DaemonContext } from '../control/context'
import { launchSpawn, stopSessionProcess } from '../control/session'
import { sourceForRead } from '../control/transcripts'
import { transcriptForExport } from '../handoff-package'
import { stageRuntimeAttachment } from './attachment-staging'
import type { TerminalRuntimeHost } from './terminal-driver'

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
    bridge: (sessionId) => ctx.bridges.get(sessionId),
    trackedState: (sessionId) => ctx.observers.trackedState(sessionId),
    draftSyncing: (sessionId) => ctx.composerEngine.has(sessionId),
    durableLabel: (sessionId) => ctx.durableLabels.get(sessionId) ?? ctx.durableLabelFor(sessionId),
    // Absent on macOS, and honestly so: there is no transient scope there, and a
    // fabricated unit name would make `health()` report a cgroup nothing owns.
    scopeUnit: (label) => (process.platform === 'linux' ? scopeUnitName(label) : undefined),
    // BACKEND-AGNOSTIC, like the reattach path: a session created under tmux
    // before an abduco upgrade must still be adoptable, so both hosts are asked.
    durableHostAlive: async (label) =>
      (await abducoHasSession(label)) || (await tmuxHasSession(label)),
    stopSession: (input) => stopSessionProcess(ctx, input),
    launch: (msg) => launchSpawn(ctx, msg),
    readTranscript: async (session, range) => {
      const source = await sourceForRead(ctx, {
        agentKind: session.agentKind,
        cwd: session.cwd,
        ...(session.resume ? { resume: session.resume } : {}),
      })
      const slice = await source.readSlice({
        ...(range.anchor ? { anchor: range.anchor } : {}),
        // `before` is the newest window — the same default the on-switch read
        // uses, and the one a `history({ limit })` with no anchor means.
        direction: 'before',
        limit: range.limit,
      })
      return slice.items
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
