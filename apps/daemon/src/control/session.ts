import { seedRuntimeHistory } from '../runtime/history-seed'
import { randomUUID } from 'node:crypto'
import { dispatchInputBytes } from './legacy-terminal-input'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AcceptedDriverId, RefusalReason, SessionSpec } from '@podium/harness/driver/host'
import {
  attachKindsForDriver,
  configureFieldsForDriver,
  EngineBindUnrecoverable,
} from '@podium/harness/driver/host'
import {
  agentStateProviderFor,
  bindHarnessLaunch,
  canonicalDriverId,
  type DriverId,
  type HarnessVersionDiagnostic,
  harnessCapabilitiesFor,
  harnessTranscriptStorage,
  type LaunchFile,
  parseHarnessVersion,
  serverDriverExecutable,
} from '@podium/harness'
import { managementLoginCommandFor } from '../harness-management.js'
import { createLogger } from '@podium/logger'
import {
  type AgentKind,
  type AgentRuntimeState,
  asMachineId,
  type Geometry,
  type SessionId,
} from '@podium/model'
import {
  type DurableAttachment,
  type DurableProcess,
  type DurableReattach,
  durableProcessFor,
  WriterLeaseRefusedError,
} from '@podium/process/durable'
import type { AgentPicture } from '@podium/process/screen'
import { Terminal } from '../terminal/terminal.js'
import { adaptTerminal } from '../runtime/terminal-transport.js'
import type { ControlMessage } from '@podium/protocol/daemon'
import { measureTask } from '@podium/runtime/task-attribution'
import type { SessionBindingTransitionOutcome } from '../binding-store'
import { noDurableBackendRefusal } from '../durable-backend'
import { countFrame } from '../loop-attribution'
import type { Tier } from '../output-scheduler'
import { codexAppServerVersionProbe } from '../runtime/version-probe'
import { driverTiming } from '../runtime/driver-timing'
import { grokAcpVersionProbe } from '../runtime/version-probe'
import { handleFor, runtimeDriverIdFor } from '../runtime/handlers'
import { reapInstanceSessionProcesses } from '../runtime/instance-process-reaper'
import {
  opencode2VersionProbe,
  opencode2VersionProbeForExecutable,
  opencodeVersionProbe,
  opencodeVersionProbeForExecutable,
} from '../runtime/version-probe'
import {
  availableDriverIds,
  droppedDriverPreference,
  isServerDriver,
  isServerDriverId,
  runtimeDriverIntentForSpawn,
  selectionAuthForLogin,
  spawnNamedServerDriver,
  terminalProfileFor,
  unhonouredSpawnDriver,
} from '../runtime/registry'
import { TerminalRecoveryRefusal } from '@podium/harness/driver/host'
import { beginServerDriverReap } from '../runtime/server-reap'
import type { TerminalLaunch, TerminalLaunched } from '@podium/harness/driver/host'
import type { ReattachControl, SpawnControl } from '../session-observers'
import type { DaemonSession } from '../session/daemon-session.js'
import { removeSessionUploads } from '../session-uploads'
import { type BindFacts, bindFrame, reportSize } from './applied-geometry'
import type { ControlHandlers, DaemonContext } from './context'
import { harnessChildStripEnv, harnessCompatEnv, harnessInstanceEnv, spawnEnv } from './session-env'

export { harnessCompatEnv } from './session-env'

import { decideReopenScreen } from '../reopen-policy'
import {
  forgetSessionScreen,
  sessionScreenFor,
  terminalScreenFor,
  trackSessionOutput,
  trackSessionSize,
} from '../session-screens'

const log = createLogger('daemon:session')

const nativeClientHolder = (sessionId: SessionId): string => `podium-native:${sessionId}`

/**
 * THE REFUSALS THAT CLEAR ON THEIR OWN (POD-2489).
 *
 * A take-over attach is a single-writer handoff, and codex refuses it outright
 * while a turn is open or an ask is unanswered: `busy` and `needs_user` are the
 * driver saying NOT RIGHT NOW, not NOT EVER. The reconcile below used to treat
 * every refusal alike and return, and nothing rescheduled it — so a user who
 * opened Native mid-turn had the request dropped on the floor, and only toggling
 * to Chat and back made the view ask again.
 *
 * EVERY OTHER REFUSAL STAYS TERMINAL, and the distinction is not a severity
 * ranking. `unsupported` and `not_running` are standing facts about this machine
 * and this session; `session_ended` is final; `lease_held` names SOMEBODY ELSE as
 * the one human-controller, and retrying against it is precisely the interleaving
 * the lease exists to prevent. Only a refusal the session itself will stop
 * issuing is worth re-arming.
 */
const TRANSIENT_ATTACH_REFUSALS: ReadonlySet<RefusalReason> = new Set(['busy', 'needs_user'])

/**
 * How many transient refusals one Native request may spend.
 *
 * The retry is armed by a STATE CHANGE, not a timer, so this bound is not about
 * pacing — it is what stops a session flapping between idle and working from
 * re-attempting the handoff forever. Leaving Native clears the count (see the
 * release arm below), so the user's own toggle is always a fresh start.
 *
 * THE CAP IS SCOPED TO THE HAZARD IT NAMES, and getting that wrong is the one
 * regression this fix shipped and had to take back. Answered asks were charged
 * against the same three, and codex's own driver says answering an approval is
 * the moment a turn RESUMES — so every answered-triggered attach is refused
 * `busy` and cost an attempt. A three-approval turn is ordinary, and it emptied
 * the budget BEFORE the idle frame that would have succeeded: the user was left
 * exactly where this issue started, on a path the pre-fix daemon handled. So an
 * answered ask ATTEMPTS WITHOUT SPENDING (`spendBudget: false`), and only state
 * frames are rationed. Answered events cannot flap — each one is a real human,
 * policy or superagent action, bounded by the asks in the turn.
 */
const NATIVE_ATTACH_RETRY_LIMIT = 3

/**
 * A REFUSED NATIVE REQUEST, RE-ARMED BY THE SESSION'S OWN STATE (POD-2489).
 *
 * Called for every `agentState` frame this daemon emits, from the outbound sink
 * in `frame-sink.ts` — the same tap the terminal driver reads, and for the same
 * reason: the frame is already computed and already carries the fact, so a second
 * observer channel would only be a second thing to keep in sync. A session with
 * no refused request costs one map lookup here.
 *
 * THE TRIGGER SURFACE IS `idle`, AND SAYING SO PRECISELY MATTERS, because the two
 * transient refusals do not reach it by the same route.
 *
 *   `busy` — the ordinary case. The turn ends, codex emits its state change, the
 *   phase is `idle`, and the retry fires. This is the path the bug report
 *   describes and the one the tests drive.
 *
 *   `needs_user` — reaches `idle` LATE, and in one case not at all. A session
 *   with an open ask reports the phase `needs_user`, which is the refusal
 *   restated and is dropped here, so nothing fires at the moment the ask is
 *   answered: codex's `closeAsk()` folds the phase without emitting a state
 *   event. What does arrive is the turn's own end — answering an approval
 *   resumes the turn, and `closeTurn()` emits `idle` — so the take-over lands at
 *   turn end rather than at the answer. The case with NO frame at all is
 *   narrower: a turn that ENDS with an ask still open (`closeTurn` sets `idle`
 *   unconditionally), after which answering emits nothing (POD-2494).
 *   {@link nativeClientInteractionAnswered} covers both — it makes the common
 *   case prompt instead of late, and the narrow one possible at all.
 *
 * `working` and `compacting` are likewise the refusal restated: spending one of a
 * small budget on either would burn it before the session reached the phase that
 * clears it. `ended` cannot be honoured at all, so the request is dropped rather
 * than spending an attempt proving it.
 *
 * `errored` IS DELIBERATELY NOT HERE. It looks like it belongs — a failed turn is
 * a turn that is over — but only codex's `attach()` can refuse transiently, so
 * only a codex session can ever be in this map, and the codex driver never
 * assigns that phase (opencode is the only driver that does, and its attach
 * refuses only `lease_held`/`unsupported`). An arm no reachable session can take
 * is not caution, it is a comment that lies.
 *
 * THE RETRY GOES THROUGH THE RECONCILE, never around it — so it re-reads the
 * request set (the user may have left Native since), takes the lease through the
 * same `attach` call, and serializes against any in-flight transition.
 */
export function nativeClientStateObserved(
  ctx: DaemonContext,
  sessionId: SessionId,
  state: AgentRuntimeState,
): void {
  const entry = ctx.sessions.get(sessionId)
  if (entry?.nativeRetryCount === undefined) return
  if (state.phase === 'ended') {
    entry.nativeRetryCount = undefined
    return
  }
  if (state.phase !== 'idle') return
  reconcileNativeClientTerminal(ctx, sessionId)
}

/**
 * THE OTHER HALF OF THE TRIGGER SURFACE (POD-2489): an ask that just got answered.
 *
 * Opening Native to answer a prompt is the most natural thing a person does with
 * the native TUI, and it is exactly the request codex refuses — `needs_user`,
 * because an unanswered ask blocks the single-writer handoff. State frames alone
 * get there LATE rather than never: the phase while the ask is open IS
 * `needs_user`, which the observer drops, and `closeAsk()` folds the phase
 * without emitting a state event — so the attach used to wait for the turn that
 * the answer restarted to finish. In the narrow POD-2494 case, a turn that ENDS
 * with an ask still open, it never got there at all.
 *
 * THE CAUSAL STREAM CARRIES WHAT THE STATE STREAM DROPPED. `closeAsk()` does emit
 * `{t:'interaction', ev:'answered'}`, and that event crosses the same outbound
 * sink as the state frames — so the fact was always there, just not in the frame
 * the other tap reads. Hanging the re-arm off the event rather than off the
 * daemon's own `answer` verb also covers the answers the daemon never issued: a
 * policy or the superagent resolving an ask clears the block just as well.
 *
 * IT DOES NOT SPEND THE RETRY BUDGET, and that is not a detail — see
 * {@link NATIVE_ATTACH_RETRY_LIMIT}. Answering an approval RESUMES the turn, so
 * this attach is usually refused `busy`; and `closeAsk()` emits `answered`
 * before its own "another ask is still open" return, so answering one of two
 * fires here while the session is still blocked on the other. Charged, an
 * ordinary three-approval turn emptied the budget before the idle frame that
 * would have worked.
 *
 * THE GUARD IS LOAD-BEARING, not a fast path: without an owed retry this
 * session never asked for Native, and the reconcile would take its RELEASE arm —
 * closing a client terminal and dropping a lease for every answered ask on every
 * server session.
 */
export function nativeClientInteractionAnswered(ctx: DaemonContext, sessionId: SessionId): void {
  if (ctx.sessions.get(sessionId)?.nativeRetryCount === undefined) return
  reconcileNativeClientTerminal(ctx, sessionId, { spendBudget: false })
}

/**
 * Reconcile one server-family session's on-demand original harness TUI.
 *
 * `spendBudget` IS WHAT KEEPS TWO DIFFERENT HAZARDS FROM SHARING ONE COUNTER.
 * See {@link NATIVE_ATTACH_RETRY_LIMIT}: state frames can flap and must be
 * capped; an answered ask cannot, and charging it the same way spent the whole
 * budget before the frame that would have worked ever arrived.
 */
export function reconcileNativeClientTerminal(
  ctx: DaemonContext,
  sessionId: SessionId,
  { spendBudget = true }: { spendBudget?: boolean } = {},
): void {
  const entry = ctx.sessions.get(sessionId)
  if (!entry || entry.nativeTransition) return
  let applied: boolean | undefined
  /**
   * A REFUSAL RETURNS WITHOUT SETTING `applied`, so the `.finally` re-run guard
   * below declines and a request the user cancelled DURING a refusing attach
   * leaves its retry count behind. It self-heals: the count is only ever read by
   * the two re-arm functions above, both of which route into this reconcile,
   * which re-reads the entry flag and takes the release arm. The same window
   * used to leave the lease unreleased with nothing to notice.
   */
  const transition = (async () => {
    for (;;) {
      const wanted = ctx.sessions.get(sessionId)?.nativeRequested === true
      const handle = handleFor(ctx, sessionId)
      if (!handle || handle.binding.family !== 'server') return
      if (wanted) {
        driverTiming.attachRequested(handle.binding)
        const result = await handle.attach({
          mode: 'takeover',
          holder: nativeClientHolder(sessionId),
        })
        driverTiming.attachResult(handle.binding, result)
        if ('reason' in result) {
          const owned = ctx.sessions.get(sessionId)
          const held = owned?.nativeRetryCount ?? 0
          const transient = TRANSIENT_ATTACH_REFUSALS.has(result.reason)
          // A free attempt still leaves the request armed at the count it had:
          // an answered ask neither proves the session unreachable nor costs one
          // of the three tries the flapping cap is there to ration.
          const spent = spendBudget ? held + 1 : held
          const rearmed = transient && spent <= NATIVE_ATTACH_RETRY_LIMIT
          if (owned) owned.nativeRetryCount = rearmed ? spent : undefined
          log.warn('could not attach the native client terminal', {
            sessionId,
            reason: result.reason,
            detail: result.detail,
            // The request is still live: the session's next attachable state
            // change re-runs this reconcile. `false` is the old behaviour and
            // now means what it says — nobody is coming back for this one.
            rearmed,
            ...(rearmed ? { attempt: spent, charged: spendBudget } : {}),
          })
          return
        }
        // Attached: the request is honoured, so nothing is owed a retry.
        const owned = ctx.sessions.get(sessionId)
        if (owned) owned.nativeRetryCount = undefined
        // No held resize to dispatch (POD-4723): the client terminal was born at
        // the session's last-known size and states the host's size through the
        // size event; an ask that arrived before it existed was dropped, and the
        // server re-drives it.
      } else {
        // LEAVING NATIVE RETIRES A PENDING RETRY. The bounded re-arm above exists
        // to honour a request the user still has open; firing it after they went
        // back to Chat would take the lease behind their back.
        const leaving = ctx.sessions.get(sessionId)
        if (leaving) leaving.nativeRetryCount = undefined
        /**
         * REVOKING THE WRITER IS THE OBLIGATION; KILLING THE CLIENT WAS ONE WAY
         * OF MEETING IT (POD-2823, POD-3045).
         *
         * The obligation is codex's. Its stock TUI owns a direct WebSocket to
         * the Codex Unix listener, so releasing the lease must revoke that
         * writer before another client can take control — and for a writer the
         * daemon does not hold, ending the process is the only revocation there
         * is. That is why this arm used to close every client terminal outright.
         *
         * WHAT WAS WRONG WAS READING THAT AS A RULE ABOUT VIEW SWITCHES. It is
         * a fact about one harness's client, and applied to opencode it cost
         * the CLI its keyboard: every switch back into Native cold-started
         * `opencode attach`, whose startup discards stdin part-way through, so
         * a viewer who switched and typed got no echo from a terminal that was
         * visibly painting (POD-3045). The client's only writer there is the
         * daemon's own handle.
         *
         * So `release()` asks the harness — `clientTerminal.parkOnRelease` —
         * and closes exactly where the answer is no. It is still not asked
         * WHICH harness this is: the attachment remembers its own kind, so this
         * arm cannot get it wrong for a driver that does not exist yet, and a
         * fourth harness has to answer the question rather than inherit an
         * answer nobody chose.
         */
        await ctx.clientTerminals?.release(sessionId)
        await handle.lease.release(nativeClientHolder(sessionId))
      }
      applied = wanted
      if (wanted === (ctx.sessions.get(sessionId)?.nativeRequested === true)) return
    }
  })()
    .catch((err) => log.warn('native client terminal transition failed', { err, sessionId }))
    .finally(() => {
      entry.nativeTransition = undefined
      // A request can change after the final equality check but before cleanup.
      // Re-run once the slot is free; attach and release are both idempotent.
      if (applied !== undefined && (ctx.sessions.get(sessionId)?.nativeRequested === true) !== applied)
        reconcileNativeClientTerminal(ctx, sessionId)
    })
  entry.nativeTransition = transition
}

/**
 * Per-harness env every session of that kind needs to be driven through Podium's
 * terminal path — a compatibility floor, not a feature.
 *
 * codex: on startup codex pushes the kitty keyboard protocol (`CSI > u`) at the
 * terminal. Our browser terminal (xterm.js) does not implement it and never
 * answers, so codex runs its modified-key handling against a protocol nobody on
 * this side speaks — the arrangement openai/codex#8324 reports Enter/Backspace
 * doubling under. Draft Sync turned it off for exactly this reason and gated
 * that on its own flag (POD-859), which left two otherwise identical codex
 * sessions on different keyboard paths depending on an experiment. The mismatch
 * was never about the engine, so every codex spawn gets it now (POD-628).
 * Spawn-time only — a session already running with enhancement on keeps it until
 * it is relaunched.
 */
/**
 * Env vars bound into EVERY spawned session so its `podium` CLI can reach the
 * daemon's loopback relay for this exact session. PODIUM_SESSION_ID is bound at
 * spawn (never a CLI arg the agent could spoof); the relay URL has the session id
 * baked into its path (agentRelay.endpointFor(sessionId)).
 * Only the new names are written — never the legacy PODIUM_ISSUE_RELAY (read-side
 * tolerance for in-flight sessions lives in resolveAgentRelay, not here). [spec:SP-b85a]
 * Pure so it's unit-testable without standing up the daemon.
 *
 * TWO variables, one URL, two different questions [POD-1375]:
 *   PODIUM_SESSION_RELAY — TRANSPORT: "there is a Podium session here, and this is
 *     how you talk to it about ITSELF". Bound for every kind, shells included, and
 *     read by session-scoped, authority-free consumers: the browser-command shim
 *     and `podium worktree`.
 *   PODIUM_AGENT_RELAY — IDENTITY: "this process IS a constrained delegate agent;
 *     route its commands through the relay so the server applies agent scope".
 *     Bound for harness kinds ONLY.
 * A shell is the human at their own terminal: there is no delegate to bound, no
 * subtree to scope to, and nothing is contained by pretending otherwise — binding
 * the identity var there only stripped the operator of their own authority (the
 * `podium issue promote` → "outside your subtree" refusal this split fixes).
 * See docs/adr/0007-plane-inventory.md §"Session relay vs agent relay".
 */
export function sessionRelayEnv(
  sessionId: SessionId,
  endpoint: string,
  instanceId: string,
  agentKind: AgentKind,
  instanceUuid?: string,
): Record<string, string> {
  // PODIUM_SESSION_ID is an explicit process-ownership stamp. The daemon's
  // process census consumes it; the podium CLI still reads its session id
  // from the relay URL's path.
  return {
    PODIUM_INSTANCE: instanceId,
    ...(instanceUuid ? { PODIUM_INSTANCE_UUID: instanceUuid } : {}),
    PODIUM_SESSION_INSTANCE: instanceId,
    PODIUM_SESSION_ID: sessionId,
    PODIUM_SESSION_RELAY: endpoint,
    ...(agentKind === 'shell' ? {} : { PODIUM_AGENT_RELAY: endpoint }),
  }
}

/**
 * THE PODIUM HALF OF EVERY SESSION PROCESS'S ENV, whatever drives it: the relay
 * pair its `podium` CLI speaks as this session through, and the browser-open
 * shim. The terminal launch, every engine family's child and every headless
 * turn compose this one function; no driver composes it itself.
 */
export function sessionProcessEnv(
  ctx: Pick<DaemonContext, 'agentRelayEndpointFor' | 'instanceId' | 'instanceUuid' | 'settingsDir'>,
  sessionId: SessionId,
  agentKind: AgentKind,
): Record<string, string> {
  return {
    ...sessionRelayEnv(
      sessionId,
      ctx.agentRelayEndpointFor(sessionId),
      ctx.instanceId,
      agentKind,
      ctx.instanceUuid,
    ),
    ...browserOpenEnv(ctx.settingsDir),
  }
}

export function materializeLaunchFiles(files: LaunchFile[] | undefined): void {
  for (const file of files ?? []) {
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.contents, { mode: 0o600 })
  }
}

/**
 * Merge daemon-owned instrumentation into a harness launch without putting CLI
 * options after the harness's end-of-options marker. Argv-capable harnesses use
 * `-- <prompt>` to protect option-like prompts, so that boundary and everything
 * after it must remain the final positional tail.
 */
export function instrumentedLaunchArgs(
  launchArgs: readonly string[],
  instrumentationArgs: readonly string[],
): string[] {
  const optionBoundary = launchArgs.indexOf('--')
  if (optionBoundary === -1) return [...launchArgs, ...instrumentationArgs]
  return [
    ...launchArgs.slice(0, optionBoundary),
    ...instrumentationArgs,
    ...launchArgs.slice(optionBoundary),
  ]
}

function instructionRuntimeDir(ctx: DaemonContext, sessionId: SessionId): string {
  return join(ctx.settingsDir, 'session-instructions', sessionId)
}

function removeSessionInstructions(ctx: DaemonContext, sessionId: SessionId): void {
  rmSync(instructionRuntimeDir(ctx, sessionId), {
    recursive: true,
    force: true,
  })
}

/** The user's redraw button: the one repaint that reaches the program. */
const CTRL_L = Uint8Array.of(0x0c)

/** Old-server compatibility: its redraw can still ask for the host ring. */
const HOST_REPLAY_TAIL_BYTES = 256 * 1024

/**
 * What a bind states as the session's size: the host connection's, read at
 * the bind (`Terminal.size()`), or nothing when there is no terminal or its
 * backend cannot read its size back. EXPORTED for `host-runtime.ts`'s bind.
 */
export function sessionSize(ctx: DaemonContext, sessionId: SessionId): Geometry | undefined {
  return ctx.sessions.get(sessionId)?.terminal?.size()
}

/** The live server link accepted terminal.picture.v1 (POD-4912). */
function picturesAccepted(ctx: DaemonContext): boolean {
  return ctx.picturesAccepted?.() === true
}

/**
 * PICTURES ARE ON FOR THIS SESSION (POD-4912): its Terminal's host keeps the
 * screen, and the server accepted terminal.picture.v1. Then the server serves
 * viewers from the host's pictures, and this daemon replays nothing: a redraw
 * is a picture request. Otherwise the older server's redraw branches stand
 * (N8). EXPORTED for the client-terminal host's ports.
 */
export function picturesActive(ctx: DaemonContext, sessionId: SessionId): boolean {
  return picturesAccepted(ctx) && ctx.sessions.get(sessionId)?.terminal?.keepsScreen === true
}

/**
 * SEND A BIND, THEN ASK FOR A PICTURE (POD-4912). Every bind the daemon sends
 * goes through here: it carries the connection's size and, when pictures are
 * on, `pictures: true`; then the session's host is asked for a picture, whose
 * `reset` reaches the server after the bind on the same ordered link and
 * catches up every viewer. EXPORTED for `host-runtime.ts`'s bind port.
 */
export function sendBind(ctx: DaemonContext, facts: BindFacts): void {
  const pictures = picturesActive(ctx, facts.sessionId)
  ctx.send(
    bindFrame(sessionSize(ctx, facts.sessionId), pictures ? { ...facts, pictures: true } : facts),
  )
  if (pictures) ctx.sessions.get(facts.sessionId)?.terminal?.requestPicture()
}

/**
 * A PICTURE FROM THE HOST (POD-4912): forwarded in stream order, with none of
 * a frame's side effects (N5) — no frame count, no first-output marker, no
 * observers, no activity. The one exception is the seed: the first `reset`
 * after attaching at the tail rebuilds the session screen and the composer,
 * as a reset, and the bytes after it keep them current as today. EXPORTED for
 * the client-terminal host, whose Terminal forwards its pictures the same way.
 */
export function forwardPicture(
  ctx: DaemonContext,
  sessionId: SessionId,
  picture: AgentPicture,
  seed: boolean,
): void {
  ctx.outputScheduler.enqueuePicture(sessionId, picture)
  if (!seed) return
  trackSessionOutput(ctx, sessionId, picture.bytes)
  if (ctx.composerEngine.has(sessionId)) ctx.composerEngine.onData(sessionId, picture.bytes)
}

/**
 * THE SIZE EVENT (POD-4723, design rev 3 rule 1): the ONE callback that runs
 * when the host states a session's size — its WELCOME, or a RESIZED. In
 * order: flush held output and report the size (`reportSize`), then move the
 * headless model, the observers and the composer to it. The ask itself moves
 * none of these, so a refused or lost ask leaves every one of them at the size
 * the program really has.
 *
 * EXPORTED for the client-terminal host (`runtime/opencode-attach.ts`), whose
 * Terminal states its size the same way, through a port.
 */
export function onSessionSize(
  ctx: DaemonContext,
  sessionId: SessionId,
  size: Geometry,
  birth = false,
  keepsScreen = false,
): void {
  // A birth states, like a bind, whether this terminal's output carries
  // pictures (POD-4912, H3): the server owes its viewers only if it does.
  reportSize(ctx, sessionId, size, birth, birth && keepsScreen && picturesAccepted(ctx))
  trackSessionSize(ctx, sessionId, size.cols, size.rows)
  ctx.observers.onResize?.(sessionId, size.cols, size.rows)
  ctx.composerEngine.onResize(sessionId, size.cols, size.rows)
}

/**
 * Attach a freshly spawned or reattached PTY to the daemon's plumbing. It
 * applies nothing and records nothing: the Terminal it builds states the
 * host's size through {@link onSessionSize} (once now, then on every RESIZED),
 * and a bind reads `terminal.size()`.
 */
export function wireBridge(
  ctx: DaemonContext,
  sessionId: SessionId,
  session: DurableAttachment,
  agentKind: AgentKind,
  durableLabel: string,
): Terminal {
  // THE ONE headed construction site (POD-4434): spawn and reattach both build
  // their surface here. The Session owns the label and screen; the
  // Terminal is the surface over the attachment just opened.
  const owned = ctx.sessions.ensure(sessionId)
  owned.label = durableLabel
  // The screen is held (not fed) here — see the Terminal contract. Feeding
  // stays in the fan-out below, unchanged.
  const terminal = Terminal.attach(session, owned, {
      onSize: (size, birth) =>
        onSessionSize(ctx, sessionId, size, birth, session.keepsScreen?.() === true),
      onPicture: (picture, seed) => forwardPicture(ctx, sessionId, picture, seed),
      onFrame: (data) => {
        driverTiming.headedCliStage(sessionId, agentKind, 'native_cli_first_output', {
          bytes: data.byteLength,
        })
        countFrame(data.byteLength)
        // THE `frames` COST BUCKET (§6.1). This is the synchronous PTY-output
        // handler, not the socket read: it runs once per frame the driver hands up,
        // and on a busy session that is the daemon's hottest loop path. `countFrame`
        // above has always counted the frames and their bytes — what nothing could
        // say is how much LOOP TIME they cost, which is the number a stall needs.
        measureTask('frames', () => {
          ctx.observers.onFrame?.(sessionId, data)
          ctx.outputScheduler.enqueue(sessionId, data)
          // P1b (POD-3918): the headless model and the 1049 mode see every live
          // byte, so a reopen reconstitutes from what the program drew.
          trackSessionOutput(ctx, sessionId, data)
          // Draft Sync v2 (POD-859): feed the composer engine the raw PTY bytes when it's
          // running for this (flagged) session.
          if (ctx.composerEngine.has(sessionId)) {
            ctx.composerEngine.onData(sessionId, data)
          }
        })
      },
      // Codex sets its OSC title to the cwd basename (+ a spinner glyph that churns at
      // frame-rate), which would clobber the real title the codex observer derives
      // (capabilities.oscTitle: false). Every other harness sets a meaningful OSC
      // title, so forward it for them.
      ...(harnessCapabilitiesFor(agentKind)?.oscTitle ?? true
        ? {
            onTitle: (title: string) =>
              ctx.send({ type: 'title', sessionId, title, source: 'osc' }),
          }
        : {}),
      onExit: (code) => {
        // Drop the surface through the entry, which parks it and clears the
        // slot only if it is still this one: a Terminal that lost the slot
        // must not clear its successor (the epoch on the session says the same).
        owned.dropTerminal(terminal)
        forgetSessionScreen(ctx, sessionId)
        ctx.composerEngine.detach(sessionId)
        ctx.outputScheduler.remove(sessionId)
        ctx.sessionCwdTracker.clear(sessionId)
        // The agent's gone (as far as this bridge knows) — stop its observers and
        // its (now frozen) transcript tail.
        ctx.observers.clearSession(sessionId)
        // The attach CLIENT exiting is NOT the AGENT exiting. disposeAll() on a
        // daemon shutdown/redeploy SIGKILLs the client; a user detach or a client
        // crash do the same. For a durable backend the master + agent live on in
        // their own systemd scope (the whole point of a durable host) — so
        // reporting agentExit here would persist a live session as 'exited', and
        // boot never reattaches an 'exited' row, orphaning a still-running agent.
        // Only a vanished master is a real exit.
        const label = durableLabel
        void (async () => {
          if (await durableProcessFor(ctx)?.has(label)) return
          // The agent has truly exited (master is gone). Uploads are one-shot prompt
          // inputs that were already consumed before the agent finished processing
          // them, so it's safe to remove the per-session upload dir on any real exit
          // (natural finish, hibernate, or kill). kill also calls removeSessionUploads
          // directly, so the two are harmlessly idempotent (rmSync force:true is a no-op
          // on a missing dir). The hourly TTL sweep remains a backstop for edge cases.
          removeSessionUploads(sessionId, ctx.portableStateFence)
          removeSessionInstructions(ctx, sessionId)
          ctx.send({ type: 'agentExit', sessionId, code })
        })()
      },
    },
    { kind: 'headed' },
  )
  owned.replaceTerminal(terminal)
  return terminal
}

/** The size a session the contract created directly is born at: no spawn
 *  frame named one, and the first viewer's resize corrects it. */
const NOMINAL_TERMINAL_GEOMETRY = { cols: 120, rows: 40 } as const

/**
 * THE TERMINAL HOST'S LAUNCH (POD-5814): start one session's harness in a
 * durable PTY FROM THE CONTRACT'S OWN SPEC.
 *
 * The terminal family calls this through its `launch` port for every session
 * it creates — a server spawn and a direct `driver.create()` alike — and shells
 * and login panes reach it through {@link launchPlainTerminal}. The harness
 * argv comes from the adapter, fed the spec's instructions, model, first
 * prompt and env; the process env is the one {@link sessionProcessEnv}.
 *
 * What is the host's, not the driver's, is read off the session's spawn order
 * (see `DaemonSession.spawnOrder`): the birth size, the observation lease the
 * server issued, draft sync. They come back to the driver as `TerminalLaunched`
 * — the lease it must envelope its events with and the live terminal — with
 * the announcement (the bind) left for the driver to make once it holds its
 * handle.
 */
export async function launchTerminalProcess(
  ctx: DaemonContext,
  input: TerminalLaunch & { loginHarness?: SpawnControl['loginHarness'] },
): Promise<TerminalLaunched> {
  const { sessionId, spec, instrumentation, resume, loginHarness } = input
  const agentKind = spec.harness as AgentKind
  const order = ctx.sessions.get(sessionId)?.spawnOrder
  const ordered: SpawnControl = order?.frame ?? {
    type: 'spawn',
    sessionId,
    agentKind,
    cwd: spec.workdir,
    geometry: { ...NOMINAL_TERMINAL_GEOMETRY },
  }
  const { resume: _orderResume, ...orderFrame } = ordered
  // The observers read the server's lease off the spawn frame; what this launch
  // runs (the conversation, the directory) is the spec's, and wins.
  const observedSpawn: SpawnControl = {
    ...orderFrame,
    sessionId,
    agentKind,
    cwd: spec.workdir,
    ...(resume ? { resume } : {}),
  }
  const label = spec.durableLabel ?? ctx.durableLabelFor(sessionId)
  try {
    // NO SPAWN WITHOUT A DURABLE HOST (POD-4617). First, before the cwd pin,
    // the launch files or the instrumentation: a daemon with no podium-host
    // (backend `none`) starts nothing at all — agent, shell and login alike —
    // and says why. There is no raw-pty fallback to reach.
    const durable = durableProcessFor(ctx)
    if (!durable) throw new Error(noDurableBackendRefusal())
    // Born pinned (POD-665): the server picked this cwd, so the session's workspace
    // is known before the agent has run a single hook. Every spawn funnels through
    // here, so this one call covers issue start, add-session, `agent spawn`, the UI
    // button and automations alike. Not awaited — the pin only has to beat the
    // agent's FIRST hook (a git rev-parse against an agent boot), and delaying the
    // PTY for it would be the wrong trade.
    void ctx.sessionCwdTracker.setLaunchCwd(sessionId, spec.workdir)
    const spawnStartedAt = Date.now()
    const runtimeDir = instructionRuntimeDir(ctx, sessionId)
    // Harnesses that let the caller name a NEW conversation get their native id
    // minted here rather than discovered from disk afterwards. Grok creates no
    // session directory at all until its first turn, so an unused session would
    // otherwise never bind and its chat would stay empty. Minted per spawn (never
    // derived from the session id): the CLI rejects an id that already exists, so
    // a re-spawn of the same row must not reuse one. [POD-386]
    const newSessionId =
      !resume && harnessCapabilitiesFor(agentKind)?.newSessionIdFlag ? randomUUID() : undefined
    // MANAGEMENT OWNERSHIP (POD-4305 F12): the native login argv resolves before
    // any agent handle can exist — static manifest declaration only, bound to the
    // generation's verified executable below. Never a shell manifest/driver
    // (POD-4278 owns that exemption); unknown/unsupported harnesses throw here.
    const loginCommand = loginHarness ? managementLoginCommandFor(loginHarness) : undefined
    if (loginHarness && !loginCommand) {
      throw new Error(`${loginHarness} does not declare a native login command`)
    }
    const instructions = spec.instructions.supported
      ? spec.instructions.value.instructions
      : undefined
    const subagentModel = spec.model.subagentModel?.supported
      ? spec.model.subagentModel.value
      : undefined
    const launchOptions = {
      cwd: spec.workdir,
      ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
      podiumSessionId: sessionId,
      ...(resume ? { resume } : {}),
      ...(newSessionId ? { newSessionId } : {}),
      ...(spec.model.model ? { model: spec.model.model } : {}),
      ...(spec.model.effort ? { effort: spec.model.effort } : {}),
      ...(spec.initialPrompt ? { initialPrompt: spec.initialPrompt } : {}),
      ...(instructions?.length ? { instructions: [...instructions] } : {}),
      runtimeDir,
      ...(spec.env ? { env: spec.env } : {}),
    }
    // loginCommand is intentionally a static argv declaration: the production
    // branch below binds it to the current generation's verified executable and
    // command environment. Resolving here would duplicate that snapshot and let
    // login drift from the executable the rest of the launch uses. The injected
    // ctx.launch branch is a legacy/test seam; production host runtime always
    // supplies the binder for this path.
    const cmd = loginCommand
      ? ctx.harnessRuntime
        ? bindHarnessLaunch(await ctx.harnessRuntime.current(), loginHarness!, {
            args: [...loginCommand.args],
            cwd: spec.workdir,
          })
        : { cmd: loginCommand.cmd, args: [...loginCommand.args], cwd: spec.workdir }
      : ctx.harnessRuntime
        ? await ctx.harnessRuntime.launch(agentKind, launchOptions)
        : ctx.launch(agentKind, launchOptions)
    materializeLaunchFiles(cmd.files)
    // SQLite-backed harnesses create their store parent lazily. Create the
    // Podium-owned directory before the PTY starts so two fresh sessions
    // cannot race on a missing per-session store directory. Keyed on the
    // manifest's transcript storage (POD-4737) — never a harness name — so a
    // second sqlite harness inherits the guard. The env key itself is the
    // sqlite harness's launch contract (its adapter sets it); only sqlite
    // harnesses set one.
    if (!loginHarness && harnessTranscriptStorage(agentKind) === 'sqlite' && cmd.env?.OPENCODE_DB) {
      mkdirSync(dirname(cmd.env.OPENCODE_DB), { recursive: true })
    }
    const session = await durable.spawn({
      // DEMAND THE WRITER LEASE (POD-4434). A spawn that adopts a live master
      // while another writer holds it is the update-overlap symptom: two
      // daemons, one host, and a session that looks live and swallows input.
      requireLease: true,
      label,
      cmd: cmd.cmd,
      args: instrumentedLaunchArgs(cmd.args, instrumentation.args),
      cwd: cmd.cwd,
      cols: orderFrame.geometry.cols,
      rows: orderFrame.geometry.rows,
      env: spawnEnv({
        // Server-resolved managed credential / environment (SP-6454, #216).
        sessionEnv: spec.env,
        harnessEnv: cmd.env,
        podiumEnv: {
          // The relay pair and browser shim every session process gets. The
          // agent-IDENTITY half rides along only for harness kinds — a shell is
          // the operator [POD-1375].
          ...sessionProcessEnv(ctx, sessionId, agentKind),
          ...(ctx.homeDir ? { HOME: ctx.homeDir } : {}),
          ...harnessInstanceEnv(loginHarness ?? agentKind, ctx.homeDir),
          // Subagent model rides as env — Claude Code reads it; harmless elsewhere.
          ...(subagentModel ? { CLAUDE_CODE_SUBAGENT_MODEL: subagentModel } : {}),
          // Globally-installed hooks are env-gated per session by their adapter.
          // Commands exit immediately when absent, so non-Podium runs are untouched.
          ...instrumentation.env,
          // Terminal-protocol compatibility for this harness (see above).
          ...harnessCompatEnv(agentKind),
        },
      }),
      // The session's account is the one its HOME is logged into — which is only
      // true if this harness's own credential vars cannot reach it by inheritance
      // from the daemon (POD-2296). `env` above cannot express that: unsetting a
      // credential is a delete, not an empty string.
      //
      // `loginHarness` FIRST, and it is not a nicety: a native login pane is filed
      // as agentKind 'shell' (it runs `<cli> login`, not the agent), and 'shell' is
      // exactly the kind this rule exempts. Read the other way round, the one pane
      // whose whole purpose is to establish an account would be the one pane that
      // let an inherited key outrank it — `claude login` under a stray
      // ANTHROPIC_API_KEY greets you with "Detected a custom API key in your
      // environment" instead.
      stripEnv: harnessChildStripEnv(loginHarness ?? agentKind, spec.env),
    })
    driverTiming.headedCliStage(sessionId, agentKind, 'native_cli_process_started', {
      adopted: session.adopted,
    })
    const terminal = wireBridge(ctx, sessionId, session, agentKind, label)
    // The size the program is at: the host's WELCOME (the Terminal already
    // stated it through the size event), or — on a backend that cannot read
    // its size back — the size it was born at.
    const geometry = terminal.size() ?? orderFrame.geometry
    // Stand up the agent-state tracker, harness observer, resume transcript tail
    // and seeded phase. The frame tap buffers the bounded gap between bridge
    // wiring and this setup so screen-derived state still sees the first screen.
    ctx.observers.initSessionObservers(observedSpawn, session, agentStateProviderFor(agentKind), {
      seedOnFrame: true,
      startedAtMs: spawnStartedAt,
      ...(newSessionId ? { newSessionId } : {}),
    })
    // The size event above ran before these observers existed: tell them now.
    ctx.observers.onResize?.(sessionId, geometry.cols, geometry.rows)
    // Draft Sync v2 (POD-859): begin composer sync for a flagged, composer-capable
    // session. attach() is a no-op for harnesses without a driver. Reads the
    // session's one TerminalScreen model (P2c) instead of a second emulator.
    if (orderFrame.draftSync) {
      ctx.composerEngine.attach(
        sessionId,
        agentKind,
        geometry.cols,
        geometry.rows,
        terminalScreenFor(ctx, sessionId).model,
      )
    }
    // An adopted spawn started nothing: the durable master for this label was still
    // running and we reattached to it (POD-1945 — a Resume used to die on
    // "address already in use" instead). Report it as the attach it is, so the row
    // does not claim a fresh launch that never happened.
    if (session.adopted) {
      log.info('spawn adopted the live durable session for this label', { sessionId, label })
    }
    const boundCmd = session.adopted ? durable.primary.attachCommand(label) : cmd.cmd
    return {
      terminal: adaptTerminal(terminal),
      ...(orderFrame.observationGeneration !== undefined
        ? { observerGeneration: orderFrame.observationGeneration }
        : {}),
      ...(orderFrame.observationBindingVersion !== undefined
        ? { bindingVersion: orderFrame.observationBindingVersion }
        : {}),
      announce: () => {
        // NEVER ACKNOWLEDGE A DRIVERLESS AGENT: an agent's bind goes out only
        // when the terminal handle it names is registered. A shell or login
        // pane has none to name.
        if (!loginHarness && agentKind !== 'shell') {
          const handle = handleFor(ctx, sessionId)
          const expected = spec.selection.preference
          if (
            !handle ||
            handle.binding.sessionId !== sessionId ||
            handle.binding.harness !== agentKind ||
            handle.binding.family !== 'terminal' ||
            handle.binding.driver !== expected
          ) {
            throw new Error(
              `terminal driver '${expected ?? 'none'}' did not establish a handle; retry this session`,
            )
          }
        }
        const driverId = runtimeDriverIdFor(ctx, sessionId)
        // THE ONE BUILDER (POD-3290). It reads this daemon's applied-size record and
        // is the only thing in the tree that may write `geometry` into a bind, so
        // the grid a spawn announces is the grid `wireBridge` recorded a moment ago
        // — the pty's birth size, or the held resize it dispatched instead.
        sendBind(ctx, {
          sessionId,
          cmd: boundCmd,
          cwd: cmd.cwd,
          agentKind,
          ...(ctx.composerEngine.has(sessionId) ? { draftSyncEngine: true } : {}),
          // The driver handle actually exists for this session (POD-1761 W4,
          // unconditional since POD-4426). The server records `driverId` on the
          // row and keys its senders on its presence — see BindMessage.
          ...(driverId
            ? {
                driverId,
                configureFields: [...configureFieldsForDriver(driverId)],
                attachKinds: [...attachKindsForDriver(driverId)],
              }
            : {}),
          ...(order?.requestedDriverId ? { requestedDriverId: order.requestedDriverId } : {}),
        })
        const handle = handleFor(ctx, sessionId)
        if (handle) driverTiming.sessionReady(handle.binding)
      },
    }
  } catch (err) {
    reapFailedLaunch(ctx, sessionId, label, err)
    throw err
  }
}

/**
 * A launch that failed may already have a process: reap it through the shared
 * reaper and drop its launch files. A refused writer lease belongs to
 * another/newer owner: nothing was acquired, so there is nothing to reap — and
 * the log names the session, because a silent spawnError is the old symptom
 * wearing a new frame. Idempotent: the launch and its caller may both call it.
 */
function reapFailedLaunch(
  ctx: DaemonContext,
  sessionId: SessionId,
  durableLabel: string,
  err: unknown,
): void {
  if (err instanceof WriterLeaseRefusedError) {
    log.warn('spawn refused: another writer holds the host lease', {
      sessionId,
      label: err.label,
      writers: err.writers,
      readers: err.readers,
    })
  } else if (ctx.sessions.get(sessionId)?.attached) {
    void stopSessionProcess(ctx, { sessionId, durableLabel })
  }
  removeSessionInstructions(ctx, sessionId)
}

/** Report a spawn that did not come up, on the frame the UI already renders. */
function reportSpawnFailure(ctx: DaemonContext, sessionId: SessionId, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  ctx.send({ type: 'spawnError', sessionId, message })
  driverTiming.sessionFailed(sessionId, message)
}

/**
 * A SHELL OR A LOGIN PANE: the permanent plain-terminal exemption, by structure
 * not by switch (POD-4426, POD-4278). There is no agent here for a driver to be
 * honest about — no turns, no harness session — so nothing creates a driver
 * session; the pane shares the same launch, durable host, bridge, observers,
 * screen and reaper as every terminal session, and announces itself.
 */
async function launchPlainTerminal(ctx: DaemonContext, msg: SpawnControl): Promise<void> {
  const spec: SessionSpec = {
    ...sessionSpecForSpawn(msg, { auth: 'unknown', role: 'interactive' }),
    ...(msg.durableLabel ? { durableLabel: msg.durableLabel } : {}),
  }
  try {
    const launched = await launchTerminalProcess(ctx, {
      sessionId: msg.sessionId,
      spec,
      // Neither a shell nor a login pane carries per-session hook wiring.
      instrumentation: { args: [] },
      ...(msg.resume ? { resume: msg.resume } : {}),
      ...(msg.loginHarness ? { loginHarness: msg.loginHarness } : {}),
    })
    launched.announce()
  } catch (err) {
    reportSpawnFailure(ctx, msg.sessionId, err)
  }
}

/**
 * AN AGENT ON ITS TERMINAL DRIVER, through the contract like every other
 * session (POD-5814): the spawn frame becomes a SessionSpec, and the machine
 * runtime creates — or resumes — the session on the harness's terminal driver
 * under the server's id. The driver installs its hook wiring, has the host
 * launch from the spec, registers, and the host announces it.
 */
async function launchAgentTerminal(ctx: DaemonContext, msg: SpawnControl): Promise<void> {
  try {
    // SHELL RULE, STATED POSITIVELY (POD-4426): a NON-shell kind with no
    // manifest is not a shell: it is a harness this build does not know, and
    // opening a session nothing can drive would be a silent failure, so it
    // refuses loudly with the kind named.
    const profile = terminalProfileFor(msg.agentKind)
    if (!profile) {
      throw new Error(
        `no manifest for harness '${msg.agentKind}': this build declares no runtime for it`,
      )
    }
    // An explicit driver id must name this terminal driver, rather than be
    // silently ignored.
    if (
      typeof msg.requestedDriverId === 'string' &&
      canonicalDriverId(msg.requestedDriverId) !== profile.driverId
    ) {
      throw new Error(
        `runtime driver '${msg.requestedDriverId}' cannot bind as '${profile.driverId}'; retry with an available driver`,
      )
    }
    const runtime = ctx.agentRuntime
    if (!runtime) throw new Error('agent runtime is unavailable; retry after the daemon recovers')
    const base = sessionSpecForSpawn(msg, {
      driverId: profile.driverId,
      auth: 'unknown',
      role: 'interactive',
    })
    const spec: SessionSpec = {
      ...base,
      model: {
        ...base.model,
        ...(msg.subagentModel ? { subagentModel: { supported: true, value: msg.subagentModel } } : {}),
      },
      ...(msg.durableLabel ? { durableLabel: msg.durableLabel } : {}),
      ...(profile.instrumentationRequired
        ? {
            instrumentation: {
              endpointUrl: ctx.hookEndpointFor(msg.sessionId),
              seedTheme: msg.seedCliTheme ?? true,
              ...(ctx.hookSocketPath ? { socketPath: ctx.hookSocketPath } : {}),
            },
          }
        : {}),
    }
    if (msg.resume) await runtime.resume(msg.resume, spec, msg.sessionId)
    else await runtime.create(spec, msg.sessionId)
    requireTerminalHandle(ctx, msg, profile)
  } catch (err) {
    // A process may already exist when handle construction fails. Use the shared
    // reaper before reporting failure; never acknowledge a driverless agent.
    reapFailedLaunch(ctx, msg.sessionId, msg.durableLabel ?? ctx.durableLabelFor(msg.sessionId), err)
    reportSpawnFailure(ctx, msg.sessionId, err)
  }
}
export const MISSING_SESSION_BINDING_MESSAGE =
  'server-minted SessionBinding instruction is required'

/** A selection is intent; only a registered, matching handle admits an agent. */
function requireTerminalHandle(
  ctx: DaemonContext,
  msg: SpawnControl | ReattachControl,
  profile: NonNullable<ReturnType<typeof terminalProfileFor>>,
): void {
  const handle = handleFor(ctx, msg.sessionId)
  if (
    !handle ||
    handle.binding.sessionId !== msg.sessionId ||
    handle.binding.harness !== msg.agentKind ||
    handle.binding.family !== 'terminal' ||
    handle.binding.driver !== profile.driverId
  ) {
    throw new Error(`terminal driver '${profile.driverId}' did not establish a handle; retry this session`)
  }
  // REFRESH THE HANDED TERMINAL (POD-4785): the entry's surface may have been
  // replaced (reattach, steal) without a new bind carrying it, so push the
  // current one.
  ctx.agentRuntime?.setTerminal?.(msg.sessionId, adaptTerminal(ctx.sessions.get(msg.sessionId)?.terminal))
}

async function handleSpawn(ctx: DaemonContext, msg: SpawnControl): Promise<void> {
  if ((!msg.binding && !msg.adoptedBinding) || (msg.binding && msg.adoptedBinding)) {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: MISSING_SESSION_BINDING_MESSAGE,
    })
    return
  }
  const requestedDriverId = spawnNamedServerDriver(msg.requestedDriverId)
  driverTiming.sessionRequested({
    sessionId: msg.sessionId,
    harness: msg.agentKind,
    ...(requestedDriverId ? { requestedDriverId } : {}),
    ...(msg.initialPrompt ? { initialPrompt: true } : {}),
  })
  const label = msg.durableLabel ?? ctx.durableLabelFor(msg.sessionId)
  if (msg.adoptedBinding) {
    const outcome = await ctx.sessionBinding.transition({
      event: 'adopt',
      transitionId: msg.adoptedBinding.transitionId,
      sessionId: msg.sessionId,
      machineAccess: msg.adoptedBinding.machineAccess,
      transferId: msg.adoptedBinding.transferId,
      role: msg.adoptedBinding.role,
      phase: 'launch',
      fromMachineId: asMachineId(msg.adoptedBinding.fromMachineId),
      toMachineId: asMachineId(msg.adoptedBinding.toMachineId),
      at: new Date().toISOString(),
      attemptId: label,
    })
    const failure = bindingFailureMessage(outcome)
    if (failure) {
      ctx.send({
        type: 'spawnError',
        sessionId: msg.sessionId,
        message: failure,
      })
      return
    }
  } else if (msg.binding) {
    const outcome = await ctx.sessionBinding.transition({
      event: 'spawn',
      transitionId: msg.binding.transitionId,
      sessionId: msg.sessionId,
      agentKind: msg.agentKind,
      claimantMachineId: asMachineId(ctx.machineId),
      machineAccess: msg.binding.machineAccess,
      principal: msg.binding.principal,
      delegation: msg.binding.delegation,
      ...(msg.binding.issueId ? { issueId: msg.binding.issueId } : {}),
      ...(msg.binding.requestedScope ? { requestedScope: msg.binding.requestedScope } : {}),
      ...(msg.binding.scopeOverrideConfirmed ? { scopeOverrideConfirmed: true } : {}),
      ...(msg.binding.relaunch ? { relaunch: true } : {}),
      attemptId: label,
      observationGeneration: msg.observationGeneration,
    })
    const failure = bindingFailureMessage(outcome)
    if (failure) {
      ctx.send({
        type: 'spawnError',
        sessionId: msg.sessionId,
        message: failure,
      })
      return
    }
  }
  /**
   * THE FORK BETWEEN A PTY SESSION AND A SERVER SESSION (POD-1761 W5).
   *
   * It is HERE and not inside the terminal launch, and the placement is the point: a
   * server-family session has no PTY to launch, no durable master to reclaim and
   * no bridge to wire, so routing it through the PTY spawn path and then undoing
   * the parts that do not apply would be worse than a branch. The binding
   * transition ABOVE still ran, because who owns a session is not a question
   * about how it is driven.
   *
   * Every spawn is offered to the harness policy. Server-capable harnesses take
   * their own server driver when its three-valued probe admits this machine; an
   * absent, unsupported or unprobeable driver falls through to the PTY path.
   * Claude's stream engine is selected only by an explicit per-spawn request;
   * ordinary Claude spawns stay on the terminal path.
   */
  await launchSpawn(ctx, msg)
}

/**
 * CARRY OUT AN AUTHORIZED SPAWN (the binding transition already ran): a shell
 * or login pane launches as a plain terminal; an agent goes to the driver the
 * harness policy selects — an engine family, or its terminal driver — through
 * the machine runtime's `create`/`resume`, from the SessionSpec the frame
 * becomes.
 */
export async function launchSpawn(ctx: DaemonContext, msg: SpawnControl): Promise<void> {
  if (msg.agentKind === 'shell' || msg.loginHarness) {
    await withSpawnOrder(ctx, { frame: msg }, () => launchPlainTerminal(ctx, msg))
    return
  }
  const runtimeLaunch = await launchServerDriverSession(ctx, msg)
  if (runtimeLaunch.handled) return
  await launchTerminalSpawn(ctx, msg, runtimeLaunch.requestedDriverId)
}

/** An agent spawn the harness policy left on its terminal driver, under its
 *  order. `requestedDriverId` names a server driver the spawn asked for and
 *  did not get, for the bind to report. */
export async function launchTerminalSpawn(
  ctx: DaemonContext,
  msg: SpawnControl,
  requestedDriverId?: string,
): Promise<void> {
  await withSpawnOrder(
    ctx,
    { frame: msg, ...(requestedDriverId ? { requestedDriverId } : {}) },
    () => launchAgentTerminal(ctx, msg),
  )
}

/**
 * Carry out a terminal spawn under its order: the host keeps the frame for its
 * own facts (see `DaemonSession.spawnOrder`) while the driver launches from the
 * spec the frame became, and the order ends with the spawn. An entry the spawn
 * never put a process or driver on goes with it.
 */
async function withSpawnOrder(
  ctx: DaemonContext,
  order: NonNullable<DaemonSession['spawnOrder']>,
  spawn: () => Promise<void>,
): Promise<void> {
  const sessionId = order.frame.sessionId
  const fresh = !ctx.sessions.has(sessionId)
  const entry = ctx.sessions.ensure(sessionId)
  entry.spawnOrder = order
  try {
    await spawn()
  } finally {
    if (entry.spawnOrder === order) entry.spawnOrder = undefined
    if (fresh && !entry.terminal && !entry.driver && ctx.sessions.get(sessionId) === entry) {
      ctx.sessions.delete(sessionId)
    }
  }
}

/**
 * THE ONE SESSION SPEC A SPAWN FRAME BECOMES. Every field the server put on the
 * frame for the session reaches the driver here, whole; the driver maps each to
 * its harness's native channel. Nothing downstream rebuilds a spec from a
 * narrower launch shape.
 *
 * `auto` is the harness's own default, which is what an absent model means:
 * dropping it here keeps every family from re-deciding it.
 *
 * NO MCP CONFIG IS FORWARDED, a declared gap rather than an oversight
 * (POD-1761 W6): the spawn frame has never carried one, because interactive
 * sessions mount MCP through the CLI's own config file, and passing an empty
 * one would make a driver report a tool mount it did not make.
 */
export function sessionSpecForSpawn(
  msg: SpawnControl,
  selection: {
    /** Absent for a plain terminal, which no driver runs. */
    driverId?: AcceptedDriverId
    auth: SessionSpec['selection']['auth']
    role: 'executor' | 'interactive'
  },
): SessionSpec {
  const executor = selection.role === 'executor'
  return {
    harness: msg.agentKind,
    selection: {
      auth: selection.auth,
      platform: process.platform,
      available: selection.driverId ? [selection.driverId] : [],
      ...(selection.driverId ? { preference: selection.driverId } : {}),
      role: selection.role,
    },
    workdir: msg.cwd,
    model: {
      ...(msg.model && msg.model !== 'auto' ? { model: msg.model } : {}),
      ...(msg.effort && msg.effort !== 'auto' ? { effort: msg.effort } : {}),
    },
    instructions: msg.instructions?.length
      ? { supported: true, value: { instructions: msg.instructions, reprimeOnCompaction: false } }
      : { supported: false, reason: 'the server prepared no instructions for this session' },
    mcpServers: {
      supported: false,
      reason: 'interactive sessions mount MCP through the harness native config file',
    },
    ...(msg.env ? { env: msg.env } : {}),
    // An executor takes its first prompt as a turn, not at creation — the
    // headless driver refuses `initialPrompt`.
    ...(!executor && msg.initialPrompt ? { initialPrompt: msg.initialPrompt } : {}),
  }
}

/**
 * Start this session on a server-family driver, or answer `false` for "not
 * mine".
 *
 * A REQUEST THAT CANNOT BE HONOURED EITHER REFUSES OR DEGRADES, and each case
 * below says which and why. This comment has been wrong in both directions: it
 * once claimed every outcome was a refusal, which was the opposite of what the
 * code did on the case it named (POD-2023 review, 7.1; a third case arrived with
 * POD-2056's measurement), and the code then degraded on a case that should
 * always have refused (POD-2113). The rule the cases share is that a fact about
 * the MACHINE may be papered over, and an instruction from THIS SPAWN may not:
 *
 *   - AN UNKNOWN DRIVER ID REFUSES, loudly, with the id in the message. This
 *     build ships no such driver, so it is a typo or a spawn from a newer
 *     server, and an operator who asked for `opencode-sever` and got a working
 *     terminal session would read it as proof the override works.
 *   - A MANIFEST-DEFAULT SERVER PREFERENCE THIS BOX CANNOT RUN DEGRADES to
 *     whatever the manifest ranks next, which today is terminal. The machine's
 *     opencode answered and the gate refused its version; `select()` already
 *     drops a preference the machine cannot run, and honouring it anyway would
 *     turn one stale binary into a machine where NO session can start. Pinned
 *     by `opencode-server.test.ts`'s "DEGRADES an opt-in the machine cannot
 *     run".
 *   - THE SAME REQUEST MADE PER-SPAWN REFUSES (POD-2113). An id on the spawn
 *     frame is not a setting anyone forgot; it is this session's reason for
 *     existing, and every operator who sends one is testing whether the driver
 *     works. Silently answering with a terminal session gave them the one
 *     outcome that looks exactly like the answer they wanted. Degrading is right
 *     for a policy default and wrong for a value typed for a session, so the
 *     split is on WHERE the id came from — policy or frame — not on what it
 *     says.
 *   - A DRIVER WE COULD NOT PROBE REFUSES, when the spawn named it explicitly.
 *     Added after POD-2056 measured `opencode --version` at 11–15s on the build
 *     host against a 15s budget: losing that race made an explicit
 *     `requestedDriverId: 'opencode-server'` become a PTY session, and it did so
 *     invisibly — the session went live, the bind carried the TERMINAL driver
 *     id with nothing saying a server was asked for, and the first send came
 *     back `unverified`, which reads as a model problem four steps from the
 *     cause. "This machine's opencode is too old" is a fact about the machine
 *     and degrading on it is honest; "I could not find out" is a fact about
 *     load, and an operator who NAMED the driver would rather be told.
 *
 * The difference is whether the REQUEST is meaningless, genuinely unsatisfiable
 * here, or merely unanswered — and only the middle one is safe to paper over.
 */
/**
 * Re-bind a surviving server-family session after a daemon restart, or answer
 * `false` for "not mine".
 *
 * SILENT WHEN THERE IS NO JOURNAL ENTRY, which is the common case: every
 * terminal session reaches this function and none of them has one. The entry is
 * written by the server driver's own launch, so its presence IS the statement
 * that this session was server-driven.
 */

async function adoptServerDriverSession(
  ctx: DaemonContext,
  msg: ReattachControl,
): Promise<boolean> {
  /**
   * EVERY SERVER-FAMILY REGISTRY IS ASKED, not just the first one (POD-2024).
   *
   * This consulted `ctx.opencodeRuntime` alone, so a codex session — which has
   * no entry in the OPENCODE journal — answered "not mine" and fell through to
   * the PTY path below, where the code's own words are that it "assumes a PTY:
   * it asks whether a durable host socket still holds the durable
   * label". The session came back `reattachFailed: session not found`, which is
   * verbatim the failure this function exists to prevent.
   *
   * A session appears in exactly ONE journal by construction — the spawn path
   * chose a driver once and that driver's launch wrote the entry — so this is a
   * lookup rather than a precedence, and the first entry found is the answer.
   */
  const runtime = ctx.agentRuntime
  if (!runtime) return false
  /**
   * THE LINK BLIP, NOT A RESTART (POD-4807): this daemon never lost the
   * session — only the transport to the server dropped for a second, and the
   * server's reattach probe is how the row comes back to `live`.
   *
   * Re-adopting through the binding journal here would open a SECOND writer
   * attachment to the engine's host while the first (this daemon's own, still
   * held in the family's live handle) keeps the one writer lease — so the
   * engine host refuses loudly ("writer lease is held elsewhere") and the
   * failed-adoption reap below kills the survivor the blip never touched.
   *
   * The PTY path already short-circuits this (`recoverTerminalHost` reuses the
   * already-held bridge and re-emits `bind`); the server arm never did. A live
   * server handle IS the session, so re-bind it in place: no new host attach,
   * no journal read, nothing killed, nothing read-only.
   *
   * Optional-chained: partial test doubles omit `serverHandleFor`, and absent
   * means "no live handle known" — the adopt below answers that case.
   */
  const live = runtime.serverHandleFor?.(msg.sessionId)
  if (live) {
    try {
      sendBind(ctx, {
        sessionId: msg.sessionId,
        cmd: `${live.binding.driver} (${live.binding.driver})`,
        cwd: live.binding.workdir ?? msg.cwd,
        agentKind: msg.agentKind,
        driverId: live.binding.driver,
        configureFields: [...configureFieldsForDriver(live.binding.driver)],
        attachKinds: [...attachKindsForDriver(live.binding.driver)],
      })
      ctx.send({ type: 'agentState', sessionId: msg.sessionId, state: await live.state() })
      log.info('reattached a live server-family session without a second adopt', {
        sessionId: msg.sessionId,
        driver: live.binding.driver,
      })
      reconcileNativeClientTerminal(ctx, msg.sessionId)
      return true
    } catch (err) {
      ctx.send({
        type: 'reattachFailed',
        sessionId: msg.sessionId,
        reason: err instanceof Error ? err.message : String(err),
      })
      return true
    }
  }
  const reapFailedAdoption = (): void => {
    // Adoption failure is terminal for this startup probe: the server will
    // record the reattach failure, so retaining the journal would leave a
    // credentialed child with no owner. Reap from the journal identity rather
    // than calling adopt again — Codex/Grok adoption starts a replacement.
    void beginServerDriverReap(ctx, msg.sessionId, { retire: true }, ctx.serverReapIo).catch(
      (err) => {
        log.warn('could not start reaping a failed server reattach', {
          err,
          sessionId: msg.sessionId,
        })
      },
    )
  }
  let adoption: Awaited<ReturnType<typeof runtime.adoptJournalled>>
  try {
    adoption = await runtime.adoptJournalled(
      msg.sessionId,
      msg.resume ? { resume: msg.resume } : undefined,
    )
  } catch (err) {
    reapFailedAdoption()
    ctx.send({
      type: 'reattachFailed',
      sessionId: msg.sessionId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return true
  }
  if (!adoption.found) return false
  /**
   * THE ROW NAMES A DIFFERENT CONVERSATION THAN THE JOURNAL (POD-4612, the
   * check the bespoke Claude arm carried). Refused before anything was
   * adopted, and NOT reaped: the engine is exactly what its journal says, and
   * it is this request that does not match it.
   */
  if (adoption.conversationMismatch) {
    ctx.send({
      type: 'reattachFailed',
      sessionId: msg.sessionId,
      reason: adoption.conversationMismatch,
    })
    return true
  }
  /**
   * THE §4.8 KEPT ENGINE (POD-4490): the adopt reached a live engine whose
   * protocol would not bind. The family kept the process and left the journal
   * untouched, so this is NOT a failed adoption to reap — reaping here would
   * kill the survivor the spec keeps for an operator decision (and the
   * journal still names the older incarnation, so a reap would not even hit
   * the survivor). DaemonSession invalidates pending turns, records the kept
   * engine from the error identity, and surfaces the reattach failure.
   */
  if (adoption.bindFailure) {
    ctx.sessions
      .ensure(msg.sessionId)
      // No `abandoned` entries: a prior driver's queue is the driver's to
      // report (its teardown/displacement reports through the same port), and
      // a restart has no queue at all. This daemon never took custody, so it
      // reports none — manufacturing ids would correct rows the server still
      // legitimately owns.
      .bindFailed(adoption.bindFailure, { family: msg.agentKind }, { send: ctx.send })
    return true
  }
  const { handle, what, workdir } = adoption
  if (!handle) {
    /**
     * THE JOURNAL SAID SERVER, AND NOTHING ANSWERED. Reported as a reattach
     * FAILURE rather than fallen through to the PTY path: falling through
     * would spawn nothing, find no durable host and report the same failure
     * one layer down with a reason that names the PTY host — which would send the
     * next reader looking for a master that was never supposed to exist.
     */
    reapFailedAdoption()
    ctx.send({
      type: 'reattachFailed',
      sessionId: msg.sessionId,
      reason: `the ${what} session recorded in the binding journal could not be rebound`,
    })
    return true
  }
  try {
    sendBind(ctx, {
      sessionId: msg.sessionId,
      cmd: `${what} (${handle.binding.driver})`,
      cwd: workdir,
      agentKind: msg.agentKind,
      // THE CONNECTION'S SIZE, WHICH HERE IS USUALLY NONE (POD-4723). This is
      // an ADOPT: the journalled server child was rebound with no terminal of
      // its own, so `sessionSize` finds no host connection to read and the
      // bind is bare. What stood here once was the reattach frame's own
      // geometry with a hardcoded 120-column default behind it: the server's
      // last-known handed back, which is no report at all.
      // The same fact the launch path states, and for the same reason: the
      // server keys its senders on `driverId`'s presence, and a rebound
      // session that omitted it would be routed to a PTY it does not have.
      driverId: handle.binding.driver,
      // POD-3087. Reported wherever `driverId` is, because the two answer the
      // same question — which live driver holds this session — and a bind that
      // named the driver but not what it can change leaves a client guessing at
      // exactly the thing this field exists to stop it guessing.
      configureFields: [...configureFieldsForDriver(handle.binding.driver)],
      attachKinds: [...attachKindsForDriver(handle.binding.driver)],
    })
    ctx.send({ type: 'agentState', sessionId: msg.sessionId, state: await handle.state() })
    log.info('adopted a surviving server-family session', {
      sessionId: msg.sessionId,
      driver: handle.binding.driver,
    })
    reconcileNativeClientTerminal(ctx, msg.sessionId)
    return true
  } catch (err) {
    ctx.send({
      type: 'reattachFailed',
      sessionId: msg.sessionId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return true
  }
}

/**
 * Rebind a headless contract session after a daemon restart.
 *
 * Headless sessions hold no server journal and no PTY: between turns there is
 * no process at all, only the harness conversation on disk and the durable
 * turn journal. `adoptServerDriverSession` above therefore never finds them,
 * and the PTY path below must never claim them. This is the headless twin of
 * the server families' journal adopt: an existing handle re-adopts (bumping
 * the binding behind it), a requested `headless` reattach with no handle
 * re-indexes via `runtime.adopt` on the exact durable label, falling back to
 * `runtime.resume` when the resume ref is known. Anything else is not ours.
 */
async function adoptHeadlessSession(
  ctx: DaemonContext,
  msg: ReattachControl,
): Promise<boolean> {
  const runtime = ctx.agentRuntime
  if (!runtime) return false
  const existing = runtime.handleFor(msg.sessionId)
  const existingHeadless =
    existing && existing.binding.driver === 'headless' ? existing : undefined
  const requested =
    typeof msg.requestedDriverId === 'string' &&
    canonicalDriverId(msg.requestedDriverId) === 'headless'
  if (!requested && !existingHeadless) return false
  const fail = (reason: string): true => {
    ctx.send({ type: 'reattachFailed', sessionId: msg.sessionId, reason })
    return true
  }
  if (requested && existing && !existingHeadless) {
    return fail(`session '${msg.sessionId}' is already bound to '${existing.binding.driver}'`)
  }
  const binding = existingHeadless?.binding ?? {
    sessionId: msg.sessionId,
    driver: 'headless' as const,
    family: 'server' as const,
    harness: msg.agentKind,
    workdir: msg.cwd,
    resume: msg.resume ?? null,
    process: { key: ctx.durableLabelFor(msg.sessionId) },
    bindingVersion: 1,
  }
  try {
    const handle = await runtime.adopt(binding)
    sendBind(ctx, {
      sessionId: msg.sessionId,
      cmd: `headless (${handle.binding.driver})`,
      cwd: msg.cwd,
      agentKind: msg.agentKind,
      driverId: handle.binding.driver,
      configureFields: [...configureFieldsForDriver(handle.binding.driver)],
      attachKinds: [...attachKindsForDriver(handle.binding.driver)],
    })
    ctx.send({ type: 'agentState', sessionId: msg.sessionId, state: await handle.state() })
    log.info('adopted surviving headless session', {
      sessionId: msg.sessionId,
      driver: handle.binding.driver,
    })
    return true
  } catch (adoptionError) {
    if (!requested) {
      return fail(adoptionError instanceof Error ? adoptionError.message : String(adoptionError))
    }
    if (!msg.resume) {
      return fail(
        adoptionError instanceof Error ? adoptionError.message : String(adoptionError),
      )
    }
    try {
      const spec: SessionSpec = {
        harness: msg.agentKind,
        selection: {
          auth: 'unknown',
          platform: process.platform,
          available: ['headless'],
          preference: 'headless',
          role: 'executor',
        },
        workdir: msg.cwd,
        model: {},
        instructions: {
          supported: false,
          reason: 'headless reattach carries no sticky instructions',
        },
        mcpServers: {
          supported: false,
          reason: 'headless reattach carries no MCP mount',
        },
      }
      const handle = await runtime.resume(msg.resume, spec, msg.sessionId)
      sendBind(ctx, {
        sessionId: msg.sessionId,
        cmd: `headless (${handle.binding.driver})`,
        cwd: msg.cwd,
        agentKind: msg.agentKind,
        driverId: handle.binding.driver,
        configureFields: [...configureFieldsForDriver(handle.binding.driver)],
        attachKinds: [...attachKindsForDriver(handle.binding.driver)],
      })
      ctx.send({ type: 'agentState', sessionId: msg.sessionId, state: await handle.state() })
      return true
    } catch (resumeError) {
      return fail(resumeError instanceof Error ? resumeError.message : String(resumeError))
    }
  }
}

/**
 * A SPAWN FOR A SESSION THE SERVER FAMILY ALREADY JOURNALS IS A RESUME (POD-2775).
 *
 * `sessions.resume` reaches this machine as a `spawn` frame — the very frame a
 * brand-new session arrives on, distinguished only by carrying the row's resume
 * ref. `launchServerDriverSession` turned every one of them into
 * `runtime.create()`, and `createWithId` REFUSES a session that already holds a
 * binding-journal entry. That refusal is correct on its own terms: two live
 * children under one session id is the POD-2249 double-spawn.
 *
 * But a PARKED server session holds exactly such an entry, deliberately — the
 * park arm of `beginServerDriverReap` keeps it, because the entry is the address
 * the conversation lives at. So resuming a hibernated codex session put the row
 * on `exited` with `already has a persisted server journal` against it, and it
 * stayed there: every retry is the same frame and fails identically. Measured on
 * a live instance, on a park whose process teardown was completely clean — this
 * is not the reap above it, and fixing the reap does not touch it.
 *
 * ADOPT IS THE PATH THAT ALREADY EXISTS AND ALREADY MEANS THIS. For the server
 * family `adopt()` is defined as resume-not-rebind: codex starts a fresh
 * app-server and `thread/resume`s the journalled thread, keeping the session id,
 * the transcript, the resume ref and the turn epoch, and announcing the new
 * process by bumping the binding version. It is what the REATTACH path has
 * always used ({@link adoptServerDriverSession}); the resume path simply never
 * asked for it.
 *
 * ONLY WHEN NO HANDLE IS LIVE. A journal entry beside a live handle is a session
 * this daemon is already running, and a redelivered frame for one must not start
 * a second child. That case keeps its existing behaviour exactly — it falls
 * through to the create, which refuses it.
 *
 * A FAILED ADOPTION IS A SPAWN ERROR, not a fall-through to the PTY path. The
 * journal says this conversation belongs to a server driver; launching a
 * terminal against it would answer a resume with a different session wearing the
 * same id.
 */
async function resumeJournalledServerSession(
  ctx: DaemonContext,
  msg: SpawnControl,
): Promise<boolean> {
  const runtime = ctx.agentRuntime
  if (!runtime) return false
  if (runtime.serverHandleFor(msg.sessionId)) return false
  let adoption: Awaited<ReturnType<typeof runtime.adoptJournalled>>
  try {
    adoption = await runtime.adoptJournalled(msg.sessionId)
  } catch (err) {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: err instanceof Error ? err.message : String(err),
    })
    return true
  }
  if (!adoption.found) return false
  /**
   * THE §4.8 KEPT ENGINE ON THE RESUME PATH (POD-4490): same survivor as the
   * reattach arm above — kept process, untouched journal — reached through a
   * `spawn` frame carrying the row's resume ref. DaemonSession owns the same
   * three duties; the surfaced frame is the spawn one because this path
   * answers a spawn. Never a fall-through to the PTY path (see the note on
   * the failed adoption below).
   */
  if (adoption.bindFailure) {
    ctx.sessions
      .ensure(msg.sessionId)
      // No `abandoned` entries, for the same custody reason as the reattach
      // arm above: whatever queue existed belongs to a driver, not to this
      // daemon, and only the driver may report it.
      .bindFailed(adoption.bindFailure, { family: msg.agentKind }, { send: ctx.send })
    return true
  }
  const { handle, what, workdir, reason } = adoption
  if (!handle) {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      // THE DRIVER'S OWN WORDS WHERE THERE ARE ANY. Each refusal in this path
      // names a different repair — a journal naming another incarnation, a
      // conversation the harness no longer has — and the generic sentence sent
      // the operator to the daemon log for all of them.
      message: reason
        ? `the ${what} session recorded in the binding journal could not be resumed: ${reason}`
        : `the ${what} session recorded in the binding journal could not be resumed`,
    })
    return true
  }
  try {
    sendBind(ctx, {
      sessionId: msg.sessionId,
      cmd: `${what} (${handle.binding.driver})`,
      // THE JOURNAL'S WORKDIR, like the reattach path uses. The frame's `cwd` is
      // where the server thinks the session lives; the journal is where the
      // conversation was actually opened, and codex resumes a thread relative to
      // that. They agree unless a worktree moved under a parked session, and if
      // they disagree the adopted child is the one that has to be described.
      cwd: workdir,
      agentKind: msg.agentKind,
      // NO GEOMETRY, BECAUSE NOTHING WAS APPLIED (MODEL rule 1, POD-3279). The
      // frame is a `spawn`, but this function is the RESUME arm — it reaches
      // here only by finding a journalled server child and adopting it, which
      // starts no terminal and puts nothing at a size, so the applied-size
      // record stays empty and `bindFrame` states nothing. The spawn's
      // requested geometry would be an intent, not a report; the hardcoded
      // default it fell back to was not even an intent.
      // The same fact the launch and reattach paths state, and for the same
      // reason: the server keys its senders on `driverId`'s presence, and a
      // resumed session that omitted it would be routed to a PTY it does not
      // have.
      driverId: handle.binding.driver,
      // POD-3087. Reported wherever `driverId` is, because the two answer the
      // same question — which live driver holds this session — and a bind that
      // named the driver but not what it can change leaves a client guessing at
      // exactly the thing this field exists to stop it guessing.
      configureFields: [...configureFieldsForDriver(handle.binding.driver)],
      attachKinds: [...attachKindsForDriver(handle.binding.driver)],
    })
    ctx.send({ type: 'agentState', sessionId: msg.sessionId, state: await handle.state() })
    log.info('resumed a parked server-family session from its binding journal', {
      sessionId: msg.sessionId,
      driver: handle.binding.driver,
    })
    reconcileNativeClientTerminal(ctx, msg.sessionId)
    return true
  } catch (err) {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: err instanceof Error ? err.message : String(err),
    })
    return true
  }
}

type ServerDriverLaunchResult = { handled: true } | { handled: false; requestedDriverId?: string }

/** The only server binary admission may probe after applying the login gate.
 * `headless` needs no binary probe: the process-per-turn driver has no version
 * gate, admission is the harness's headless axis declaration checked at
 * resolution and at create time. */
export function admissionProbeDriver(
  preferred: string | undefined,
  selectionAuth: ReturnType<typeof selectionAuthForLogin>,
): string | undefined {
  if (selectionAuth === 'logged-out') return undefined
  if (!preferred || !isServerDriverId(preferred)) return undefined
  if (preferred === 'headless') return undefined
  return preferred
}

export function resolvedAdmissionExecutable(
  preferred: string | undefined,
  executables: ReadonlyMap<string, { readonly path: string }> | undefined,
): string | undefined {
  // The manifest-declared probe binary for this server driver, if any
  // (POD-4737 D1). Drivers without one (today: everything but the opencode
  // pair) resolve through family defaults, exactly as before — notably a
  // second binary with no map entry still answers undefined.
  if (preferred === undefined) return undefined
  const executable = serverDriverExecutable(preferred)
  if (executable === undefined) return undefined
  return executables?.get(executable)?.path
}

/**
 * Emit the operator-facing record for a permitted runtime-driver degradation
 * (a manifest-default server preference this box cannot run) and return the
 * preferred id for the bind projection.
 * Keeping both consequences behind one guard prevents the log and read surface
 * from disagreeing about whether a degradation happened.
 */
export function reportDriverPreferenceDegrade(input: {
  sessionId: SessionId
  agentKind: AgentKind
  preference: string | undefined
  resolved: DriverId
  reason: string
}): string | undefined {
  const dropped = droppedDriverPreference(input)
  if (dropped === undefined) return undefined
  log.warn('the preferred runtime driver was not available; using fallback', {
    sessionId: input.sessionId,
    preferred: dropped,
    resolved: input.resolved,
    agentKind: input.agentKind,
    reason: input.reason,
  })
  return dropped
}

/**
 * TELL THE SERVER WHICH DRIVER THIS SESSION IS GETTING, BEFORE STARTING IT
 * (POD-2290).
 *
 * `bind` carries the same fact and carries it too late: it is the frame that
 * marks the session live, so on the drive instance an `opencode` session went
 * twelve seconds with no driver fact at all while `opencode serve` booted. The
 * web panel has to choose a view during those twelve seconds, and with nothing
 * to go on it chose the terminal — which for this family is a pane that can
 * never attach.
 *
 * Called at each point where the DECISION exists and before the thing decided
 * upon is started. Never called on a refusal path: a spawn that is about to
 * error has no driver, and announcing one would leave the row describing a
 * session that never ran.
 */
function announceDriverSelection(
  ctx: DaemonContext,
  sessionId: SpawnControl['sessionId'],
  driverId: string,
): void {
  driverTiming.driverSelected(sessionId, driverId)
  ctx.send({ type: 'driverSelected', sessionId, driverId })
}

const reportedHarnessVersions = new Set<string>()

/** One notice per machine, harness and version, across sessions and probe retries. */
export function reportHarnessVersionDiagnostic(
  ctx: Pick<DaemonContext, 'machineId' | 'send'>,
  harness: string,
  diagnostic: HarnessVersionDiagnostic,
): void {
  // Informational observations stay out of the issue/notification attention path.
  if (diagnostic.code.endsWith('-unverified') || diagnostic.code.endsWith('-unparseable')) {
    log.debug('harness version observation', {
      harness,
      code: diagnostic.code,
      observedVersion: diagnostic.observedVersion,
    })
    return
  }
  const version = parseHarnessVersion(diagnostic.observedVersion)
  // Probe errors and changed banners may contain different text on every spawn.
  const observed = version
    ? (version.raw.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/u)?.[0] ?? 'unparseable')
    : 'unparseable'
  const key = JSON.stringify([ctx.machineId, harness, observed])
  if (reportedHarnessVersions.has(key)) return
  ctx.send({ type: 'machineDiagnostic', ...diagnostic })
  reportedHarnessVersions.add(key)
}

type ServerDriverProbeVerdict =
  | { drivable: true; diagnostic?: HarnessVersionDiagnostic }
  | {
      drivable: false
      reason: 'unsupported' | 'unprobeable'
      diagnostic: { title: string; body: string }
    }

export type ServerDriverAdmissionProbe = (
  driverId: string,
  policy?: { retryInconclusive?: boolean },
  executablePath?: string,
) => Promise<ServerDriverProbeVerdict>

const defaultServerDriverAdmissionProbe: ServerDriverAdmissionProbe = (
  driverId,
  policy,
  executablePath,
) =>
  driverId === 'codex-app-server'
    ? codexAppServerVersionProbe(undefined, policy)
    : driverId === 'opencode2-server'
      ? executablePath
        ? opencode2VersionProbeForExecutable(executablePath, policy)
        : opencode2VersionProbe(undefined, policy)
      : driverId === 'grok-acp'
        ? grokAcpVersionProbe(undefined, policy)
        : executablePath
          ? opencodeVersionProbeForExecutable(executablePath, policy)
          : opencodeVersionProbe(undefined, policy)

export async function launchServerDriverSession(
  ctx: DaemonContext,
  msg: SpawnControl,
  probeDriver: ServerDriverAdmissionProbe = defaultServerDriverAdmissionProbe,
): Promise<ServerDriverLaunchResult> {
  if (msg.agentKind === 'shell' || msg.loginHarness || !terminalProfileFor(msg.agentKind)) {
    return { handled: false }
  }
  const { preferred } = runtimeDriverIntentForSpawn({
    agentKind: msg.agentKind,
    perSpawn: msg.requestedDriverId,
  })
  if (!preferred) {
    // No server driver is in play: ordinary Claude, cursor, or a shell.
    // The answer is the terminal one and it is known without probing
    // anything, so say so now rather than leaving the clients to infer it from
    // a `bind` that is still seconds away. `terminalProfileFor` is undefined
    // only for a kind with no manifest — a shell — which has no driver to name.
    const terminal = terminalProfileFor(msg.agentKind)
    if (terminal) announceDriverSelection(ctx, msg.sessionId, terminal.driverId)
    return { handled: false }
  }
  /**
   * WHAT *THIS SPAWN* SAID. Every refusal below keys on the per-spawn field —
   * the single preference left now that the machine-wide default is gone — and
   * the reason is the rule this function's docstring states: a fact about the
   * MACHINE may be papered over, an instruction from THIS SPAWN may not.
   */
  const namedHere = spawnNamedServerDriver(msg.requestedDriverId)
  // Login is cheaper and more authoritative than availability for a headless
  // default: a known logout always selects the PTY login path, so probing a
  // server binary first can only delay the same answer.
  const loginState = ctx.harnessLoginState(msg.agentKind)
  const selectionAuth = selectionAuthForLogin(msg.agentKind, loginState, msg.env)
  const terminalLoginReason =
    selectionAuth === 'logged-out'
      ? loginState === 'out'
        ? `harness '${msg.agentKind}' is logged out; its terminal path provides interactive login`
        : `harness '${msg.agentKind}' login is not confirmed yet; its terminal path provides interactive login`
      : undefined
  /**
   * Probe the one preferred server driver, whether the preference came from the
   * harness policy, the machine default, or this spawn. Each driver has its own
   * binary and version range, so one harness's healthy probe must never vouch for
   * another. The REFUSAL below still keys on `namedHere`: an unprobeable
   * manifest or machine default degrades, while a per-spawn server id refuses.
   */
  const admissionInventory =
    preferred === 'opencode-server' || preferred === 'opencode2-server'
      ? await ctx.harnessRuntime?.current()
      : undefined
  const resolvedOpencodeExecutable = resolvedAdmissionExecutable(
    preferred,
    admissionInventory?.executables,
  )
  const probeFor = (driverId: string) =>
    probeDriver(
      driverId,
      namedHere === driverId ? { retryInconclusive: true } : undefined,
      driverId === 'opencode-server' || driverId === 'opencode2-server'
        ? resolvedOpencodeExecutable
        : undefined,
    )
  const preferredServer = admissionProbeDriver(preferred, selectionAuth)
  const preferredProbe = preferredServer === undefined ? undefined : await probeFor(preferredServer)
  if (preferredProbe?.drivable && preferredProbe.diagnostic) {
    reportHarnessVersionDiagnostic(ctx, msg.agentKind, preferredProbe.diagnostic)
  }
  if (
    preferredProbe &&
    !preferredProbe.drivable &&
    preferredProbe.reason === 'unsupported' &&
    preferredServer !== 'opencode2-server'
  ) {
    const message = `${preferredProbe.diagnostic.title}: ${preferredProbe.diagnostic.body}`
    ctx.send({ type: 'spawnError', sessionId: msg.sessionId, message })
    driverTiming.sessionFailed(msg.sessionId, message)
    return { handled: true }
  }
  const namedProbe = namedHere ? preferredProbe : undefined
  /**
   * REFUSED ONLY WHEN *THIS SPAWN* NAMED THE DRIVER — the fix to a defect this
   * very check used to have (POD-2113, found by review).
   *
   * It used to read the env-folded value, so a stale machine-wide default on a
   * daemon whose PATH lacks the binary — installed under `~/.opencode/bin`
   * while the daemon starts from a systemd unit, which is the normal case —
   * refused every spawn of every harness: `ok` is false on ENOENT as well as on
   * a timeout and an `unprobeable` verdict is only briefly memoized. The env
   * source is gone (POD-4426); the per-spawn field is the only preference left,
   * and both refusals ask it.
   *
   * `namedHere` is this driver's own id, so `namedProbe` is this driver's own
   * probe.
   */
  if (namedProbe !== undefined && !namedProbe.drivable && namedProbe.reason === 'unprobeable') {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: `${namedProbe.diagnostic.title}: ${namedProbe.diagnostic.body}`,
    })
    driverTiming.sessionFailed(
      msg.sessionId,
      `${namedProbe.diagnostic.title}: ${namedProbe.diagnostic.body}`,
    )
    return { handled: true }
  }
  const runtime = ctx.agentRuntime
  if (!runtime) {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: 'machine runtime is not composed',
    })
    driverTiming.sessionFailed(msg.sessionId, 'machine runtime is not composed')
    return { handled: true }
  }
  const resolution = runtime.resolveDriver({
    agentKind: msg.agentKind,
    requested: msg.requestedDriverId,
    // Only the preferred server is probed and admitted. An explicit terminal
    // request therefore avoids every server probe.
    available: availableDriverIds({
      grokDrivable: preferredServer === 'grok-acp' && preferredProbe?.drivable === true,
      opencodeDrivable: preferredServer === 'opencode-server' && preferredProbe?.drivable === true,
      opencode2Drivable:
        preferredServer === 'opencode2-server' && preferredProbe?.drivable === true,
      codexDrivable: preferredServer === 'codex-app-server' && preferredProbe?.drivable === true,
    }),
    platform: process.platform,
    auth: selectionAuth,
  })
  if (!resolution.ok) {
    ctx.send({ type: 'spawnError', sessionId: msg.sessionId, message: resolution.reason })
    driverTiming.sessionFailed(msg.sessionId, resolution.reason)
    return { handled: true }
  }
  if (
    isServerDriver(msg.agentKind, resolution.driverId) &&
    resolution.capabilities.placement !== 'dedicated'
  ) {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: `runtime driver '${resolution.driverId}' does not provide dedicated server placement`,
    })
    driverTiming.sessionFailed(
      msg.sessionId,
      `runtime driver '${resolution.driverId}' does not provide dedicated server placement`,
    )
    return { handled: true }
  }

  /**
   * THIS SPAWN NAMED A SERVER DRIVER AND DID NOT GET IT — REFUSED (POD-2113).
   *
   * Without this the request dies right here, in silence: `resolution.driverId`
   * is a terminal driver, `isServerDriver` is false, the function answers "not
   * mine", and the spawn falls through to the PTY launch. The operator gets a
   * healthy session that obeyed nothing — and no signal afterwards either, since
   * the bind would carry the TERMINAL driver id with nothing saying a server
   * was asked for.
   *
   * The refuse/degrade split itself lives in {@link unhonouredSpawnDriver},
   * where it can be tested without a daemon.
   */
  const unhonoured = unhonouredSpawnDriver({
    perSpawn: msg.requestedDriverId,
    resolved: resolution.driverId,
  })
  if (unhonoured !== undefined) {
    // WHY, not just WHAT. The two reasons want different fixes — upgrade this
    // machine's binary, or stop asking a harness for a driver it does not
    // declare — and "could not honour it" alone sends an operator to neither.
    //
    // THE PROBE OF THE DRIVER THAT WAS REFUSED, not opencode's. This line read
    // `probe` unconditionally until W6 landed a second server family, at which
    // point a refused `codex-app-server` explained itself with opencode's
    // version diagnostic — an answer about the wrong binary, which is worse than
    // no answer because it sends the operator to upgrade something that was
    // never asked about.
    let why: string
    if (terminalLoginReason !== undefined) {
      why = terminalLoginReason
    } else {
      const unhonouredProbe = await probeFor(unhonoured)
      why = unhonouredProbe.drivable
        ? `harness '${msg.agentKind}' does not declare it (this spawn resolved to '${resolution.driverId}')`
        : `${unhonouredProbe.diagnostic.title}: ${unhonouredProbe.diagnostic.body}`
    }
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: `this spawn asked for runtime driver '${unhonoured}' and it cannot be honoured here — ${why}`,
    })
    driverTiming.sessionFailed(
      msg.sessionId,
      `this spawn asked for runtime driver '${unhonoured}' and it cannot be honoured here — ${why}`,
    )
    return { handled: true }
  }
  /**
   * THE DECISION, ANNOUNCED ONLY AFTER EVERY REFUSAL (POD-2290). Starting the
   * process is the slow part clients cannot guess through, so the decision must
   * still precede either the server launch or the terminal fallback. A refused
   * spawn launches neither, and therefore must not persist a phantom driver as
   * though it did.
   */
  announceDriverSelection(ctx, msg.sessionId, resolution.driverId)
  if (!isServerDriver(msg.agentKind, resolution.driverId)) {
    /**
     * THE DEGRADE THAT SURVIVES, SAID OUT LOUD.
     *
     * A manifest-default server preference this box cannot run degrades
     * deliberately, so an unsupported binary or transient probe miss cannot
     * kill the spawn. The warning is the machine-level operational trace;
     * the same guard supplies preferred-versus-actual to bind.
     *
     * Explicit per-spawn server ids never reach here: the refusal above keeps
     * their refuse-not-degrade contract. Explicit terminal ids produce no
     * dropped server preference and therefore no warning.
     */
    const dropped = droppedDriverPreference({
      preference: preferred,
      resolved: resolution.driverId,
    })
    let requestedDriverId: string | undefined
    if (dropped !== undefined) {
      let reason: string
      if (terminalLoginReason !== undefined) {
        reason =
          loginState === 'out'
            ? 'harness is logged out; terminal provides interactive login'
            : 'harness login is not confirmed yet; terminal provides interactive login'
      } else {
        const droppedProbe = await probeFor(dropped)
        reason = droppedProbe.drivable
          ? 'the harness does not declare it'
          : droppedProbe.diagnostic.title
      }
      requestedDriverId = reportDriverPreferenceDegrade({
        sessionId: msg.sessionId,
        agentKind: msg.agentKind,
        preference: dropped,
        resolved: resolution.driverId,
        reason,
      })
    }
    return {
      handled: false,
      ...(requestedDriverId ? { requestedDriverId } : {}),
    }
  }
  /**
   * WHICH REGISTRY, chosen by the DRIVER the resolution picked rather than by
   * the harness name (POD-1761 W6). The two are not the same question: a
   * harness can declare a server driver this build does not wire, and picking
   * by harness would hand the session to whichever registry happened to be
   * first.
   */
  /**
   * RESUME BEFORE CREATE (POD-2775). A session the server family already
   * journals is being brought back, not brought into existence — see
   * {@link resumeJournalledServerSession} for why the create below cannot serve
   * it and what the journal entry is for. Headless sessions hold no server
   * journal (their durability is the harness conversation plus the durable
   * turn journal), so they skip this and go straight to the contract create
   * below.
   */
  if (isServerDriver(msg.agentKind, resolution.driverId) && resolution.driverId !== 'headless') {
    if (await resumeJournalledServerSession(ctx, msg)) return { handled: true }
  }
  try {
    const isHeadless = resolution.driverId === 'headless'
    const spec = sessionSpecForSpawn(msg, {
      driverId: resolution.driverId,
      auth: selectionAuth,
      // Headless sessions are executor-owned, never interactive: their first
      // prompt arrives as a turn, not at creation.
      role: isHeadless ? 'executor' : 'interactive',
    })
    // A resume ref goes to the driver only where its source can continue a
    // conversation from the ref alone (headless, the Claude stream engine);
    // the vendor servers resume from their journal above.
    if (msg.resume && runtime.resumesAtLaunch(msg.agentKind, resolution.driverId)) {
      await runtime.resume(msg.resume, spec, msg.sessionId)
    } else {
      await runtime.create(spec, msg.sessionId)
    }
    // Headless sessions have no terminal to attach: their capabilities refuse
    // `attach` as unsupported, so there is no native client to reconcile.
    if (!isHeadless) reconcileNativeClientTerminal(ctx, msg.sessionId)
  } catch (err) {
    // A server that would not start is a SPAWN ERROR, reported on the frame the
    // UI already renders. The alternative — falling back to a PTY — would hide
    // exactly the failure the operator is trying to see.
    //
    // A §4.8 bind failure (engine up, protocol dead) is NOT an unstarted
    // server: the family kept the process, so DaemonSession owns the failure —
    // pending turns invalidated, kept engine recorded, spawnError surfaced
    // (POD-4490) — rather than this generic arm.
    if (err instanceof EngineBindUnrecoverable) {
      ctx.sessions.ensure(msg.sessionId)
        // COLD LAUNCH: no driver ever existed in this daemon's life, so no
        // queue exists to drain. An unbound send is refused, never queued, so
        // this daemon took custody of nothing and reports no abandonment —
        // spawnError alone. Saying so here so the next reader does not "fix"
        // the missing frame by manufacturing turn ids.
        .bindFailed(err, { family: msg.agentKind }, { send: ctx.send })
      driverTiming.sessionFailed(msg.sessionId, err.message)
    } else {
      ctx.send({
        type: 'spawnError',
        sessionId: msg.sessionId,
        message: err instanceof Error ? err.message : String(err),
      })
      driverTiming.sessionFailed(msg.sessionId, err instanceof Error ? err.message : String(err))
    }
  }
  return { handled: true }
}

// Reattach is the hot path on (re)connect: a burst of ~30 arrives at once. Each is
// independent, so handle them off the synchronous message dispatch — async existence
// checks (never a blocking fork+exec on the loop), idempotent (a reconnect re-sends
// reattach for sessions we already hold — re-confirm the bind instead of spawning a
// duplicate client), and gated so the spawn fan-out can't fork everything in one tick.
async function handleReattach(ctx: DaemonContext, msg: ReattachControl): Promise<void> {
  if (!msg.binding) {
    ctx.send({
      type: 'reattachFailed',
      sessionId: msg.sessionId,
      reason: MISSING_SESSION_BINDING_MESSAGE,
    })
    return
  }
  if (msg.binding) {
    const outcome = await ctx.sessionBinding.transition({
      event: 'reattach',
      transitionId: msg.binding.transitionId,
      sessionId: msg.sessionId,
      claimantMachineId: asMachineId(ctx.machineId),
      machineAccess: msg.binding.machineAccess,
      sessionAccess: msg.binding.sessionAccess,
      principal: msg.binding.principal,
      delegation: msg.binding.delegation,
      requestedGeneration: msg.observationGeneration ?? 1,
      attemptId: msg.durableLabel,
      agentKind: msg.agentKind,
      ...(msg.binding.adopt ? { adopt: msg.binding.adopt } : {}),
    })
    // A refused probe is how a live session goes invisible, so say so. Silence
    // here is what let 70 running agents sit unreachable behind a Resume button
    // that could not work (POD-1647).
    if (outcome.status === 'denied' || outcome.status === 'rejected') {
      log.warn('reattach binding refused', {
        sessionId: msg.sessionId,
        status: outcome.status,
        reason: outcome.reason,
      })
    } else if (outcome.status === 'applied' && outcome.binding.transitionHistory.length === 1) {
      log.info('adopted a pre-existing session into a binding', { sessionId: msg.sessionId })
    }
    const failure = bindingFailureMessage(outcome)
    if (failure) {
      // A daemon restart can leave a server-family child behind after its parent
      // dies uncleanly. When the server's reattach verdict says the session row
      // is gone, the durable binding journal is now a ghost: reap by its recorded
      // identity before reporting the failure, so a credentialed child cannot
      // survive until reboot. Other binding failures are not proof that the row
      // is gone and must not kill a still-owned session.
      if (outcome.status === 'denied' && outcome.reason === 'not-found') {
        void beginServerDriverReap(ctx, msg.sessionId, { retire: true }, ctx.serverReapIo).catch(
          (err) => {
            log.warn('could not reap a missing server session during reattach', {
              err,
              sessionId: msg.sessionId,
            })
          },
        )
      }
      ctx.send({
        type: 'reattachFailed',
        sessionId: msg.sessionId,
        reason: failure,
      })
      return
    }
  }
  /**
   * A SERVER-FAMILY SESSION IS REBOUND HERE, BEFORE THE DURABLE-HOST LOOKUP.
   *
   * This is the boot-time caller `adopt()` never had (found by POD-2056's lane,
   * which could not reach its own subject without it). Everything below this
   * point assumes a PTY: it asks whether a durable host socket still holds
   * the durable label. A server-family session has none — its
   * process is an `opencode serve` on a loopback port — so a restarted daemon
   * looked for a master that never existed, answered `reattachFailed: session
   * not found`, and left a perfectly healthy server running ORPHANED with the
   * row reporting it dead.
   *
   * The journal is what makes this exact rather than hopeful: it holds the
   * process key, the port and the secret, and `host.adopt` matches the key and
   * then health-probes with that secret before claiming anything. A recycled
   * port answers nothing on this credential, which is precisely the
   * discrimination "adopting the wrong process is worse than not adopting"
   * demands.
   */
  if (await adoptServerDriverSession(ctx, msg)) return
  if (await adoptHeadlessSession(ctx, msg)) return
  // An explicit nonterminal request cannot be satisfied by a surviving PTY.
  // Old rows with omitted intent still recover through their headed profile.
  if (
    typeof msg.requestedDriverId === 'string' &&
    (isServerDriverId(msg.requestedDriverId) ||
      isServerDriver(msg.agentKind, msg.requestedDriverId as DriverId))
  ) {
    ctx.send({
      type: 'reattachFailed',
      sessionId: msg.sessionId,
      reason: `runtime driver '${msg.requestedDriverId}' has no recoverable binding; retry this session`,
    })
    return
  }

  const profile = terminalProfileFor(msg.agentKind)
  // SHELL RULE, POSITIVE (POD-4426, matching the spawn path): shells keep the
  // host recovery route. A non-shell kind with no manifest is an unknown
  // harness, and a reattach that recovered it as a plain terminal would open a
  // session nothing can drive — so it fails loudly with the kind named.
  if (!profile && msg.agentKind !== 'shell') {
    ctx.send({
      type: 'reattachFailed',
      sessionId: msg.sessionId,
      reason: `no manifest for harness '${msg.agentKind}': this build declares no runtime for it`,
    })
    return
  }
  // Plain terminals retain their host recovery route. Old harness rows need a
  // driver too: absence of a persisted request is not a plain-terminal marker.
  if (profile) {
    if (!ctx.agentRuntime) throw new Error('terminal recovery runtime unavailable')
    await ctx.agentRuntime.recoverTerminal(msg, profile)
    return
  }
  await recoverTerminalHost(ctx, msg)
}

/** Shared host machinery. Agent recovery enters through TerminalRuntime; plain
 * terminals call it directly. ready installs the handle after composition and
 * before publishing bind, so failed attachment never creates a phantom handle. */
export async function recoverTerminalHost(
  ctx: DaemonContext,
  msg: ReattachControl,
  ready?: () => void,
): Promise<void> {
  const heldLabel = ctx.sessions.get(msg.sessionId)?.label
  if (heldLabel !== undefined && heldLabel !== msg.durableLabel) {
    throw new TerminalRecoveryRefusal('terminal recovery process identity mismatch')
  }
  const existing = ctx.sessions.get(msg.sessionId)?.terminal
  if (existing) {
    // Capture legacy state before observer replacement. A freshly fenced
    // reattach lease is authoritative even when this daemon still holds the PTY:
    // rebuild the observer registry so every subsequent observation uses the new
    // generation/binding/cursor fence. Causal adapters re-bootstrap a snapshot;
    // they must not also publish this legacy agentState as a live effect.
    const state = ctx.observers.trackedState(msg.sessionId)
    const hasAuthoritativeObservationLease =
      msg.observationGeneration !== undefined && msg.observationBindingVersion !== undefined
    if (hasAuthoritativeObservationLease) {
      ctx.observers.initSessionObservers(msg, existing.attachment, agentStateProviderFor(msg.agentKind), {
        seedOnFrame: false,
      })
    }
    const cmd = durableProcessFor(ctx)?.primary.attachCommand(msg.durableLabel) ?? msg.durableLabel
    // Draft Sync v2 (POD-859): ensure the engine is running if flagged (idempotent —
    // covers a runtime flag flip since the original spawn).
    if (msg.draftSync) {
      // The session's one TerminalScreen model (P2c) is shared here instead
      // of building a second emulator; the cols/rows hint only sizes a
      // fallback owned screen, and the next size event moves it.
      const hint = sessionSize(ctx, msg.sessionId) ?? msg.lastKnownGeometry
      ctx.composerEngine.attach(
        msg.sessionId,
        msg.agentKind,
        hint.cols,
        hint.rows,
        terminalScreenFor(ctx, msg.sessionId).model,
      )
    }
    ready?.()
    const recoveryProfile = terminalProfileFor(msg.agentKind)
    if (recoveryProfile) requireTerminalHandle(ctx, msg, recoveryProfile)
    const driverId = runtimeDriverIdFor(ctx, msg.sessionId)
    sendBind(ctx, {
      sessionId: msg.sessionId,
      cmd,
      cwd: msg.cwd,
      agentKind: msg.agentKind,
      // THE CONNECTION'S SIZE (POD-4723): the bridge was never lost, so the
      // host's last statement is still the truth, and this bind is the full
      // statement the server re-drives a lost ask from. Never
      // `msg.lastKnownGeometry`: that is the server's own belief handed back.
      ...(ctx.composerEngine.has(msg.sessionId) ? { draftSyncEngine: true } : {}),
      // The driver handle actually exists for this session (POD-1761 W4,
      // unconditional since POD-4426). The server records `driverId` on the
      // row and keys its senders on its presence — see BindMessage.
      ...(driverId
        ? {
            driverId,
            configureFields: [...configureFieldsForDriver(driverId)],
            attachKinds: [...attachKindsForDriver(driverId)],
          }
        : {}),
      ...(msg.requestedDriverId ? { requestedDriverId: msg.requestedDriverId } : {}),
    })
    // NO REDRAW (POD-4723, design rev 3). This used to nudge the program on every
    // link-B reattach — two RESIZEs and a full repaint per session, fanned out to
    // every viewer — and the nudge is what put ptys back at a stale size. The
    // bind above requests the host picture for the server cache. Older servers
    // keep their redraw path, which repaints from the snapshot or ring.
    // Re-push agent state for the same reason we re-seed the transcript below: a
    // freshly restarted SERVER (the daemon survived) starts with NO agentState for
    // this session, and an idle survivor fires no hook to re-establish it — so it
    // would fall through the home board's `live → working` fallback and read as
    // WORKING. We still hold the live tracker, so resend its current phase. Skip
    // 'unknown' (nothing to assert) — a cold tracker is re-seeded by the fresh-bridge
    // branch below, not here.
    if (!hasAuthoritativeObservationLease && state && state.phase !== 'unknown') {
      ctx.send({ type: 'agentState', sessionId: msg.sessionId, state })
    }
    // Re-seed the transcript even though we already hold the bridge: a freshly
    // restarted SERVER (the daemon survived) has an empty per-session buffer, and
    // this already-held branch otherwise does no transcript work, so chat would
    // stay blank. The live tail (if any) only re-emits on its NEXT file change, so
    // read the newest window now and push it as a reset delta. Best-effort; a read
    // failure just leaves the buffer to refill from live deltas.
    void ctx.tailSeedGate(async () => {
      try {
        // [spec:SP-c29e] A server reconnect can resend 100+ reattaches at once.
        // Keep bind/state above immediate, but pace the allocation-heavy
        // transcript read/parse/reset-send through the existing seed gate.
        await seedRuntimeHistory(ctx, msg.sessionId)
      } catch (err) {
        log.warn('reattach re-seed failed', { err, sessionId: msg.sessionId })
      }
    }, ctx.outputScheduler.priorityOf(msg.sessionId))
    return
  }
  await ctx.reattachGate(async () => {
    // Raced with another reattach for this id: skip a second host attach and
    // bind. Not the one-Terminal rule — the entry's slot keeps that, parking a
    // predecessor, for a spawn that lands while this reattach awaits the host.
    if (ctx.sessions.get(msg.sessionId)?.attached) return
    // Re-pin a survivor (POD-665). Pins live in daemon memory, so a daemon restart
    // would otherwise leave every reattached session unpinned and free to be dragged
    // out of its worktree by the next `cd`. `msg.cwd` is the row's persisted cwd —
    // the server's own record of where this session lives. Only this branch needs it:
    // reaching the one above means the daemon never died, so the pin is still held.
    // Inside the gate on purpose — a restart reattaches every session at once, and
    // this forks git.
    void ctx.sessionCwdTracker.setLaunchCwd(msg.sessionId, msg.cwd)
    let found: DurableReattach | undefined
    const durable = durableProcessFor(ctx)
    if (durable) {
      const env = ctx.homeDir ? { ...process.env, HOME: ctx.homeDir } : process.env
      // HOST FIRST, THEN ABDUCO. Any live podium-host, Rust or a C host an
      // older daemon started (both speak the one protocol), then an abduco
      // master an older Podium started — adopted, never created (POD-4986).
      const located = await durable.locate(msg.durableLabel, env, { waitMs: 1500 })
      if (located) {
        try {
          found = await located.adapter.attach({
            label: msg.durableLabel,
            socketPath: located.socketPath,
            // DEMAND THE WRITER LEASE (POD-4434): a reattach that lands while
            // a stale daemon still holds the host's one writer must refuse
            // with reattachFailed, never read along silently.
            requireLease: true,
            lastKnownGeometry: msg.lastKnownGeometry,
          })
        } catch (err) {
          // A refused lease is not a lookup failure: it must reach the
          // handler as itself, so the frame names the session and the holder
          // instead of reporting a generic 'session not found'.
          if (err instanceof WriterLeaseRefusedError) throw err
          log.warn('durable reattach failed', {
            err,
            sessionId: msg.sessionId,
            label: msg.durableLabel,
          })
        }
      }
    }
    if (!found) {
      throw new Error(durable ? 'session not found' : 'durable backend unavailable')
    }
    // THE ATTACH RESIZES NOTHING (POD-4723). The Terminal states the host's
    // WELCOME size through the size event — which reports it and sizes the
    // model before the ring replay below — and the bind carries the same size.
    const terminal = wireBridge(ctx, msg.sessionId, found.attachment, msg.agentKind, msg.durableLabel)
    // The settings file from the original spawn still points at our fixed port,
    // so a reattached agent keeps reporting. A fresh daemon (post-redeploy) lost
    // all in-memory per-session state — rebuild it via the same path spawn uses.
    // A survivor is already at its prompt and fires no hook until the user acts,
    // so seed immediately (an idle session would otherwise read 'unknown' →
    // 'working') and re-tail its transcript (else chat stays empty while the
    // native view still has scrollback).
    ctx.observers.initSessionObservers(msg, found.attachment, agentStateProviderFor(msg.agentKind), {
      seedOnFrame: false,
    })
    // THE HEADLESS SCREENS, AT THE BEST HINT THERE IS. The observers did not
    // exist when the size event ran, so they take the host's size now, or the
    // server's last-known where the backend cannot say. Neither number reaches
    // the pty; the next size event moves them.
    const screens = terminal.size() ?? msg.lastKnownGeometry
    ctx.observers.onResize?.(msg.sessionId, screens.cols, screens.rows)
    if (msg.draftSync) {
      // The session's one TerminalScreen model (P2c), not a second emulator.
      ctx.composerEngine.attach(
        msg.sessionId,
        msg.agentKind,
        screens.cols,
        screens.rows,
        terminalScreenFor(ctx, msg.sessionId).model,
      )
    }
    // Only an old server needs a ring repaint. A picture-capable link gets
    // the reset requested after bind; a C host on that link gets live bytes
    // only (SPEC v4 H6).
    if (ready && !picturesAccepted(ctx)) await terminal.replay(HOST_REPLAY_TAIL_BYTES)
    ready?.()
    const recoveryProfile = terminalProfileFor(msg.agentKind)
    if (recoveryProfile) requireTerminalHandle(ctx, msg, recoveryProfile)
    const driverId = runtimeDriverIdFor(ctx, msg.sessionId)
    sendBind(ctx, {
      sessionId: msg.sessionId,
      cmd: found.cmd,
      cwd: msg.cwd,
      agentKind: msg.agentKind,
      // THE CONNECTION'S SIZE (POD-4723): the host's WELCOME, so a daemon
      // restart binds the size the program really has.
      ...(ctx.composerEngine.has(msg.sessionId) ? { draftSyncEngine: true } : {}),
      // The driver handle actually exists for this session (POD-1761 W4,
      // unconditional since POD-4426). The server records `driverId` on the
      // row and keys its senders on its presence — see BindMessage.
      ...(driverId
        ? {
            driverId,
            configureFields: [...configureFieldsForDriver(driverId)],
            attachKinds: [...attachKindsForDriver(driverId)],
          }
        : {}),
      ...(msg.requestedDriverId ? { requestedDriverId: msg.requestedDriverId } : {}),
    })
  })
}

/**
 * Deliberate writer-lease takeover (POD-4434): the explicit operator verb that
 * pairs with the lease refusal above. Refusal says "another writer holds it, I
 * will not read silently"; steal says "take it anyway, on purpose".
 *
 * Locate the master, take the lease over a fresh attachment (the revoked
 * holder hears LEASE_LOST on its own connection), and wire the stolen surface
 * through the same ONE construction site as spawn and reattach. The session
 * never changes owner; only the attachment is replaced. A missing master
 * answers 'session not found'.
 * Success reports a bind (the attach applied nothing, so it carries no
 * geometry); failure answers reattachFailed with the reason named.
 */
export async function stealTerminalWriter(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'stealWriter' }>,
): Promise<void> {
  const owned = ctx.sessions.ensure(msg.sessionId)
  const label = msg.durableLabel ?? owned.label ?? ctx.durableLabelFor(msg.sessionId)
  owned.label = label
  // Park first: the losing attachment detaches while the master and screen
  // stay owned. The stolen attachment
  // replaces the surface below; nothing is reaped. The slot would park it on
  // replace too — first is about ORDER: the old connection lets go before the
  // lease is taken over.
  owned.park()
  const durable = durableProcessFor(ctx)
  if (!durable) throw new Error('durable backend unavailable')
  const env = ctx.homeDir ? { ...process.env, HOME: ctx.homeDir } : process.env
  const located = await durable.locate(label, env, { waitMs: 1500 })
  if (!located) throw new Error('session not found')
  const modelSize = owned.peekScreen()?.modelSize
  const found = await located.adapter.steal({
    label,
    socketPath: located.socketPath,
    lastKnownGeometry: msg.lastKnownGeometry ?? modelSize ?? { cols: 80, rows: 24 },
  })
  log.warn('writer lease stolen on operator action', { sessionId: msg.sessionId, label })
  // The stolen connection's WELCOME states the size through the size event.
  const terminal = wireBridge(ctx, msg.sessionId, found.attachment, msg.agentKind, label)
  // The observers were subscribed to the parked attachment: re-subscribe them
  // to the stolen one through the same path spawn and reattach use. The
  // synthetic reattach carries only daemon-held or operator-authored facts —
  // no binding or resume fencing, which the live row never lost.
  const observerMsg = {
    type: 'reattach',
    sessionId: msg.sessionId,
    durableLabel: label,
    agentKind: msg.agentKind,
    cwd: msg.cwd,
    lastKnownGeometry: msg.lastKnownGeometry ?? modelSize ?? { cols: 80, rows: 24 },
  } as const
  ctx.observers.initSessionObservers(
    observerMsg,
    found.attachment,
    agentStateProviderFor(msg.agentKind),
    { seedOnFrame: false },
  )
  const screens = terminal.size() ?? observerMsg.lastKnownGeometry
  ctx.observers.onResize?.(msg.sessionId, screens.cols, screens.rows)
  const recoveryProfile = terminalProfileFor(msg.agentKind)
  if (recoveryProfile) requireTerminalHandle(ctx, observerMsg, recoveryProfile)
  const driverId = runtimeDriverIdFor(ctx, msg.sessionId)
  sendBind(ctx, {
    sessionId: msg.sessionId,
    cmd: found.cmd,
    cwd: msg.cwd,
    agentKind: msg.agentKind,
    ...(driverId
      ? {
          driverId,
          configureFields: [...configureFieldsForDriver(driverId)],
          attachKinds: [...attachKindsForDriver(driverId)],
        }
      : {}),
  })
}

/**
 * The daemon half of the survival table: drop the bridge, stop the observers,
 * reap the durable host, and clean the session's per-session dirs.
 *
 * EXPORTED for the runtime contract's `stop`/`hibernate`/`kill` (POD-1761 W3) —
 * all three reap the same way on this side, and the DIFFERENCE between them is
 * the server's row transition, which is where it has always been. A driver that
 * reimplemented any part of this would be the second place a session's teardown
 * lived.
 */
const pendingSessionStops = new WeakMap<DaemonContext, Map<SessionId, Promise<boolean>>>()

export function stopSessionProcess(
  ctx: DaemonContext,
  msg: { sessionId: SessionId; durableLabel?: string },
  opts: { retire?: boolean } = {},
): Promise<boolean> {
  let pending = pendingSessionStops.get(ctx)
  if (!pending) pendingSessionStops.set(ctx, pending = new Map())
  const previous = pending.get(msg.sessionId)
  // A timeout retry must observe the same retirement, not the now-empty
  // registry. Binding retirement may strengthen a park after it completes.
  if (previous && !opts.retire) return previous
  const work = (previous ? previous.catch(() => false) : Promise.resolve()).then(
    () => stopSessionProcessOnce(ctx, msg, opts),
  ).catch((error) => {
    log.warn('session retirement failed', { error, sessionId: msg.sessionId })
    return false
  })
  pending.set(msg.sessionId, work)
  void work.finally(() => {
    if (pending.get(msg.sessionId) === work) pending.delete(msg.sessionId)
  })
  return work
}

async function stopSessionProcessOnce(
  ctx: DaemonContext,
  msg: { sessionId: SessionId; durableLabel?: string },
  opts: { retire?: boolean } = {},
): Promise<boolean> {
  const reaps: Promise<boolean>[] = []
  let measured = false
  const owned = ctx.sessions.get(msg.sessionId)
  ctx.observers.clearSession(msg.sessionId)
  ctx.agentRuntime?.clearTerminal(msg.sessionId)
  if (owned) {
    owned.nativeRequested = false
    // The request is gone, so the retry it was owed is too — there is no session
    // left to become idle, and a stale count would outlive the id.
    owned.nativeRetryCount = undefined
  }
  void ctx.clientTerminals?.close(msg.sessionId)
  if (owned?.terminal) {
    // CLOSE is park plus forgetting: the attachment detaches here and the
    // durable master is reaped below. The session entry itself survives until
    // the labels are retired at the end of this function.
    owned.park()
    ctx.outputScheduler.remove(msg.sessionId)
  }
  // A server-family session has no bridge and no durable host — its process is
  // behind a runtime handle (or, post-restart, a binding-journal entry), and
  // before POD-2249 this function reaped neither: stop parked the row while
  // `opencode serve` ran on, kill deleted the row and left a credentialed
  // child. The reap runs IN ADDITION to the durable reap below, never instead
  // of it: a session with both a stale server journal and a genuine durable
  // host (a driver switch across a resume) has both incarnations reaped. Two
  // receipts for one session are harmless — the server acts only on
  // `killed:false`, and a receipt for an identity that was never there is a
  // truthful "nothing to kill".
  reaps.push((async () => {
    let retired = false
    const owned = await beginServerDriverReap(ctx, msg.sessionId, {
      retire: opts.retire === true,
      completed: (value) => { retired = value; measured = true },
    }, ctx.serverReapIo)
    return !owned || retired
  })())
  // Reap the durable host unconditionally — NOT only when a bridge exists.
  // Generic kill is process policy (hibernate, stop, handoff); retirement is a
  // separate server-authored binding transition.
  if (ctx.backend !== 'none') {
    const durableLabel =
      msg.durableLabel ?? owned?.label ?? ctx.durableLabelFor(msg.sessionId)
    reaps.push(reapDurableHost(ctx, msg.sessionId, durableLabel).then((retired) => {
      measured = true
      return retired
    }))
  }
  if (owned) {
    owned.clear()
    ctx.sessions.delete(msg.sessionId)
  }
  removeSessionUploads(msg.sessionId, ctx.portableStateFence)
  removeSessionInstructions(ctx, msg.sessionId)
  const results = await Promise.allSettled(reaps)
  // Give cooperative teardown its flush window before escalating descendants.
  const descendants = await reapInstanceSessionProcesses({ instanceUuid: ctx.instanceUuid, sessionId: msg.sessionId })
  measured ||= descendants.examined > 0
  if (descendants.remaining > 0) ctx.send({
    type: 'sessionKillResult', sessionId: msg.sessionId,
    durableLabel: msg.durableLabel ?? ctx.durableLabelFor(msg.sessionId),
    killed: false, reason: 'instance-owned descendants survived process retirement',
  })
  const retired = measured && descendants.remaining === 0 &&
    results.every((result) => result.status === 'fulfilled' && result.value)
  if (!retired) log.warn('session process retirement was not confirmed', { sessionId: msg.sessionId })
  return retired
}

/**
 * Reap the durable host for a label, then SAY WHETHER IT WORKED (POD-1953).
 *
 * The server flips the row to 'hibernated'/'exited' the moment it asks for a
 * kill, so an unreported failure here is not a slow park — it is a permanent
 * lie: the agent runs on in its own scope while every surface says it is parked,
 * and the next Resume creates a second process under a label this one still
 * owns. One retry (the first attempt already freed whatever was squatting the
 * scope) and then the measured answer, never an assumed one.
 */
async function reapDurableHost(
  ctx: DaemonContext,
  sessionId: SessionId,
  durableLabel: string,
): Promise<boolean> {
  const durable = durableProcessFor(ctx)
  const stillRunning = async (): Promise<boolean> => (await durable?.has(durableLabel)) ?? false
  try {
    await durable?.kill(durableLabel)
    let alive = await stillRunning()
    if (alive) {
      log.warn('the durable host survived a kill — retrying', { sessionId, durableLabel })
      await durable?.kill(durableLabel)
      alive = await stillRunning()
    }
    if (alive) {
      log.warn('the durable host is STILL running after a kill', { sessionId, durableLabel })
    }
    ctx.send({
      type: 'sessionKillResult',
      sessionId,
      durableLabel,
      killed: !alive,
      ...(alive ? { reason: 'the durable host is still running' } : {}),
    })
    return !alive
  } catch (err) {
    // A reap that THREW proves nothing about the process, so report what is
    // there rather than a guess — an unreported throw is the silent no-op again.
    log.warn('could not reap the durable host', { err, sessionId, durableLabel })
    const alive = await stillRunning().catch(() => undefined)
    ctx.send({
      type: 'sessionKillResult', sessionId, durableLabel,
      killed: alive === false,
      reason: err instanceof Error ? err.message : String(err),
    })
    return alive === false
  }
}
export const sessionHandlers: Pick<
  ControlHandlers,
  | 'spawn'
  | 'reattach'
  | 'stealWriter'
  | 'kill'
  | 'sessionBindingRetire'
  | 'sessionResumeRefConflict'
  | 'input'
  | 'resize'
  | 'redraw'
  | 'draftTarget'
  | 'agentObservationAck'
  | 'agentObservationRebindAck'
  | 'sessionResumeRefAck'
  | 'sessionPriority'
  | 'reclaimAttachments'
  | 'closeClientTerminal'
  | 'sessionOpenUrlCallback'
  | 'sessionOpenUrlDismiss'
> = {
  spawn: (ctx, msg) => {
    void handleSpawn(ctx, msg).catch((err) => {
      ctx.send({
        type: 'spawnError',
        sessionId: msg.sessionId,
        message: err instanceof Error ? err.message : String(err),
      })
    })
  },
  stealWriter: (ctx, msg) => {
    void stealTerminalWriter(ctx, msg).catch((error) => {
      ctx.send({
        type: 'reattachFailed',
        sessionId: msg.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      })
    })
  },
  reattach: (ctx, msg) => {
    void handleReattach(ctx, msg).catch((error) => {
      // A refused writer lease belongs to another/newer owner: nothing was
      // acquired, so nothing is reaped — and the log names the session, so a
      // live-looking silent reader can never come back. The reattachFailed
      // frame below carries the label and the holder census; the server shows
      // the row refused instead of live.
      if (error instanceof WriterLeaseRefusedError) {
        log.warn('reattach refused: another writer holds the host lease', {
          sessionId: msg.sessionId,
          label: error.label,
          writers: error.writers,
          readers: error.readers,
        })
        // A refused lease belongs to another/newer owner. Only a composition
        // failure may reap an acquired bridge, as required by agent admission.
      } else if (!(error instanceof TerminalRecoveryRefusal) && ctx.sessions.get(msg.sessionId)?.attached) {
        stopSessionProcess(ctx, msg)
      }
      ctx.send({
        type: 'reattachFailed',
        sessionId: msg.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      })
    })
  },

  kill: (ctx, msg) => {
    stopSessionProcess(ctx, msg)
  },
  sessionBindingRetire: (ctx, msg) => {
    void ctx.sessionBinding
      .transition({
        event: 'retire',
        transitionId: msg.transitionId,
        sessionId: msg.sessionId,
        retiredAt: msg.retiredAt,
      })
      .then((outcome) => {
        const failure = bindingFailureMessage(outcome)
        if (failure) {
          log.warn('could not retire the binding', { sessionId: msg.sessionId, reason: failure })
        }
        stopSessionProcess(ctx, msg, { retire: true })
      })
      .catch((err) => {
        log.warn('could not retire the binding', { err, sessionId: msg.sessionId })
        stopSessionProcess(ctx, msg, { retire: true })
      })
  },
  sessionResumeRefConflict: (ctx, msg) => {
    void ctx.sessionBinding
      .recordReceiptConflict({
        sessionId: msg.sessionId,
        conflictId: msg.conflictId,
        resume: msg.resume,
        conflictingSessionIds: msg.conflictingSessionIds,
        observedAt: msg.observedAt,
      })
      .catch((err) => log.warn('could not record the native identity conflict', { err }))
  },
  input: (ctx, msg) =>
    dispatchInputBytes(
      ctx,
      { sessionId: msg.sessionId, inputOrigin: msg.inputOrigin ?? 'unknown' },
      Buffer.from(msg.data, 'base64'),
    ),
  resize: (ctx, msg) => {
    // THE ASK (POD-4723, design rev 3). It moves nothing here: no report, no
    // model, no observers, no composer. The host answers with RESIZED, and the
    // size event (`onSessionSize`) moves all of them to what the kernel took —
    // so a refused or lost ask can never be reported as applied. One path for
    // a headed pty and a native client TUI alike: both are the session's one
    // Terminal.
    const terminal = ctx.sessions.get(msg.sessionId)?.terminal
    if (!terminal?.live) {
      // No terminal to ask: the spawn is still in flight, or the client TUI is
      // not open. Dropped, not held — the bind that follows states the size,
      // and the server re-drives the viewer's box from it.
      log.info('resize for a session with no terminal; dropped', {
        sessionId: msg.sessionId,
        cols: msg.cols,
        rows: msg.rows,
      })
      return
    }
    void Promise.resolve(terminal.resize(msg.cols, msg.rows)).catch((err: unknown) =>
      log.warn('the host refused a resize', {
        sessionId: msg.sessionId,
        cols: msg.cols,
        rows: msg.rows,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  },
  draftTarget: (ctx, msg) => {
    // A chat-originated draft to mirror into the native composer (POD-859 phase 4).
    ctx.composerEngine.setTarget(msg.sessionId, msg.text)
  },
  redraw: (ctx, msg) => {
    // POSIX hard redraw reaches the program as Ctrl-L. ConPTY would clear its
    // retained console (and recovered scrollback); repaint from the host's
    // exact picture instead, without touching or restoring an old geometry.
    const owned = ctx.sessions.get(msg.sessionId)
    const terminal = owned?.terminal?.live ? owned.terminal : undefined
    if (msg.hard && terminal) {
      if (process.platform === 'win32') terminal.requestPicture()
      else terminal.write(CTRL_L)
    }
    // PICTURES ON (POD-4912): the server holds the latest picture and serves
    // the viewers itself; what it asks for is a fresh one (a viewer stayed owed
    // with nothing to serve — H2). No snapshot and no ring replay: the host's
    // `reset` is exact where they were approximate.
    if (picturesAccepted(ctx)) {
      if (msg.replayRequired) terminal?.requestPicture()
      return
    }
    // Old-server compatibility only: snapshots and ring replay answer that
    // server's attach-time repaint. A C host on a new server never gets here.
    // A page with no server replay, for a native client TUI that is not open
    // yet: owe it the host ring, which the client's start path replays once it
    // is subscribed (`opencode-attach.ts`). Still the ring, never the program.
    if (msg.replayRequired && !terminal && owned?.client) owned.client.replayRequired = true
    const screen = sessionScreenFor(ctx, msg.sessionId)?.screen
    const decision = decideReopenScreen({
      mode: screen?.mode ?? 'normal',
      modelAlive: screen?.alive ?? false,
      ringReplayable: terminal?.replayable ?? false,
      replayRequired: msg.replayRequired === true,
    })
    switch (decision.kind) {
      case 'snapshot': {
        // The screen owns the serialisation: one model, one snapshot.
        const snapshot = screen?.alive ? screen.snapshotFirstFrame() : undefined
        if (snapshot) ctx.outputScheduler.enqueue(msg.sessionId, snapshot)
        return
      }
      case 'ring-replay':
        // THE JOINT-RESTART HOLE (SPEC-6 REPLAY). The server sends
        // `replayRequired` when a client attaches against an EMPTY log. The host
        // keeps the output, so it replays its tail: the viewer gets the last
        // screen, and the program is not touched at all. Approximate until
        // POD-3925: the ring carries no size history.
        void terminal?.replay(HOST_REPLAY_TAIL_BYTES).catch((err) => {
          log.warn('host replay failed', { err, sessionId: msg.sessionId })
        })
        return
      case 'none':
        return
    }
  },
  agentObservationAck: (ctx, msg) => {
    ctx.observers.onObservationAck(msg)
  },
  agentObservationRebindAck: (ctx, msg) => {
    ctx.observers.onProviderRebindAck(msg)
  },
  sessionResumeRefAck: (ctx, msg) => {
    void ctx.sessionBinding
      .acknowledgeReceipt(msg.ownerId, msg.sessionId, msg.resume, msg.receipt)
      .catch((err) => log.warn('could not acknowledge the Codex identity receipt', { err }))
  },
  sessionPriority: (ctx, msg) => {
    ctx.outputScheduler.setPriority(msg.sessionId, msg.priority as Tier)
    /**
     * THE SAME FRAME IS THE VIEWER SIGNAL A CLIENT TERMINAL'S IDLE CLOCK NEEDS
     * (POD-2059). It is computed from the live client set and sent on every
     * change, so tier 3 — `unwatched` — is precisely "the last viewer left this
     * session", and anything below it is "somebody has it open". An attachment
     * belongs to a session, so that is the association: hold the warm window off
     * while the session is watched, start it when it is not.
     *
     * `nativeView` is also the exact subscription signal for the attachment:
     * switching to Chat parks it and starts the warm TTL even though the session
     * remains visible.
     */
    const nativeView = msg.nativeView === true
    ctx.clientTerminals?.viewers(msg.sessionId, nativeView)
    if (nativeView) ctx.sessions.ensure(msg.sessionId).nativeRequested = true
    else {
      const existing = ctx.sessions.get(msg.sessionId)
      if (existing) existing.nativeRequested = false
    }
    reconcileNativeClientTerminal(ctx, msg.sessionId)
  },
  reclaimAttachments: (ctx) => {
    // Host pressure, decided by the server that owns the threshold. Attachments
    // go BEFORE any session is parked (spec §5) — see the frame's own comment.
    void ctx.clientTerminals?.reclaimUnwatched()
  },
  closeClientTerminal: (ctx, msg) => {
    // THE SERVER-OWNED WARM-PARK VERDICT (POD-4524): the shell lifetime
    // table's attach-TUI row fired for this session, so its client terminal's
    // warm window is closed. The same close the daemon's own timer used to
    // call — the viewer process goes, the agent engine is untouched — now
    // ordered per session by the server that owns the clock. Idempotent: a
    // session with no client terminal answers with nothing to do.
    void ctx.clientTerminals?.close(msg.sessionId)
  },
  sessionOpenUrlCallback: (ctx, msg) => {
    void ctx.browserOpen.callback(msg)
  },
  sessionOpenUrlDismiss: (ctx, msg) => {
    ctx.browserOpen.dismiss(msg)
  },
}
/**
 * Install the browser-command shims once and return the env that makes every
 * spawned session use them. The script reads the already capability-scoped
 * session relay at invocation time, so one shim directory serves every
 * session without embedding session ids. [spec:SP-a43e]
 *
 * Opening a URL is session TRANSPORT, not delegate authority, so the shim reads
 * PODIUM_SESSION_RELAY — which shells get too. PODIUM_AGENT_RELAY stays as the
 * fallback for sessions spawned before the split, whose env carries only the old
 * name; without it their `open`/`xdg-open` would start exiting 2 [POD-1375].
 */
export function browserOpenEnv(
  settingsDir: string,
  inheritedPath: string = process.env.PATH ?? '',
): Record<string, string> {
  const shimDir = join(settingsDir, 'browser-shims')
  mkdirSync(shimDir, { recursive: true })
  // The shim dir literal inside the script's single-quoted case pattern.
  const shimDirSh = shimDir.replace(/'/g, "'\\''")
  const script = [
    '#!/bin/sh',
    'url=',
    'for arg do',
    '  case "$arg" in',
    '    http://*|https://*) url=$arg ;;',
    '  esac',
    'done',
    // Non-URL invocations (macOS `open <file/-a App>`, `xdg-open <doc>`) are not
    // ours to intercept: fall through to the real binary — the shim SHADOWS the
    // command for URLs, it must not replace it for everything else.
    'if [ -z "$url" ]; then',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: evaluated by the generated shell script.
    '  name="${0##*/}"',
    '  IFS=:',
    '  for dir in $PATH; do',
    `    case "$dir" in ''|'${shimDirSh}') continue ;; esac`,
    '    [ -x "$dir/$name" ] && exec "$dir/$name" "$@"',
    '  done',
    '  echo "podium browser shim: no URL argument and no real $name on PATH" >&2',
    '  exit 2',
    'fi',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: evaluated by the generated shell script.
    'relay="${PODIUM_SESSION_RELAY:-$PODIUM_AGENT_RELAY}"',
    '[ -n "$relay" ] || { echo "podium browser shim: missing relay" >&2; exit 2; }',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: evaluated by the generated shell script.
    'endpoint="${relay%/}/open"',
    'if command -v curl >/dev/null 2>&1; then',
    '  exec curl --silent --show-error --fail --request POST --header "content-type: text/plain" --data-binary "$url" "$endpoint" >/dev/null',
    'fi',
    'if command -v wget >/dev/null 2>&1; then',
    '  exec wget -qO /dev/null --header="content-type: text/plain" --post-data="$url" "$endpoint"',
    'fi',
    'echo "podium browser shim: curl or wget is required" >&2',
    'exit 127',
    '',
  ].join('\n')
  for (const name of ['podium-browser-open', 'xdg-open', 'open', 'sensible-browser']) {
    const path = join(shimDir, name)
    writeFileSync(path, script, { mode: 0o700 })
    chmodSync(path, 0o700)
  }
  return {
    BROWSER: join(shimDir, 'podium-browser-open'),
    PATH: inheritedPath ? `${shimDir}:${inheritedPath}` : shimDir,
  }
}
function bindingFailureMessage(outcome: SessionBindingTransitionOutcome): string | undefined {
  switch (outcome.status) {
    case 'applied':
    case 'unchanged':
    case 'redundant':
      return undefined
    case 'denied':
      switch (outcome.reason) {
        case 'machine-use-denied':
          return 'you do not have access to this machine'
        case 'not-found':
          return 'session not found'
        case 'not-claimant':
          return 'session reattach claimed by another principal'
      }
    case 'unreachable':
      return 'target machine is unreachable'
    case 'rejected':
      return `binding transition rejected: ${outcome.reason}`
  }
}
