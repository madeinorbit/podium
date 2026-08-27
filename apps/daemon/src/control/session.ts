import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RefusalReason, SessionSpec } from '@podium/agent-runtime'
import {
  bindHarnessLaunch,
  agentStateProviderFor,
  type DriverId,
  declaredValue,
  harnessCapabilitiesFor,
  type LaunchFile,
  manifestFor,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import {
  type AgentKind,
  type AgentRuntimeState,
  asMachineId,
  type Geometry,
  type SessionId,
} from '@podium/model'
import {
  type AgentSession,
  abducoHasSession,
  abducoSocketPath,
  attachAbducoAgent,
  attachTmuxAgent,
  killAbducoSession,
  killTmuxServer,
  reapStaleAbducoBindTemps,
  spawnAbducoAgent,
  spawnAgent,
  spawnTmuxAgent,
  tmuxHasSession,
  waitForAbducoSocket,
} from '@podium/pty'
import type { SessionBindingTransitionOutcome } from '../binding-store'
import { countFrame } from '../loop-attribution'
import type { Tier } from '../output-scheduler'
import { codexAppServerVersionProbe } from '../runtime/codex-app-server'
import { runtimeContractEnabledFor, runtimeDriverByEnv } from '../runtime/flag'
import { grokAcpVersionProbe } from '../runtime/grok-acp-server'
import { handleFor, runtimeDriverIdFor, sessionIsBehindContract } from '../runtime/handlers'
import { opencodeVersionProbe } from '../runtime/opencode-server'
import { reapInstanceSessionProcesses } from '../runtime/instance-process-reaper'
import {
  availableDriverIds,
  claudeSdkTosAcceptedByEnv,
  droppedDriverPreference,
  isEmbeddedDriver,
  isServerDriver,
  isServerDriverId,
  runtimeDriverIntentForSpawn,
  selectionAuthForLogin,
  spawnNamedServerDriver,
  terminalProfileFor,
  unhonouredSpawnDriver,
} from '../runtime/registry'
import { beginServerDriverReap } from '../runtime/server-reap'
import type { ReattachControl, SpawnControl } from '../session-observers'
import { removeSessionUploads } from '../session-uploads'
import type { ControlHandlers, DaemonContext } from './context'
import { harnessChildStripEnv, harnessCompatEnv, harnessInstanceEnv, spawnEnv } from './session-env'
export { harnessCompatEnv } from './session-env'
import { sourceForRead } from './transcripts'

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
  const retries = ctx.nativeClientRetries
  if (!retries?.has(sessionId)) return
  if (state.phase === 'ended') {
    retries.delete(sessionId)
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
  if (!ctx.nativeClientRetries?.has(sessionId)) return
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
  const requests = (ctx.nativeClientRequests ??= new Set<SessionId>())
  const transitions = (ctx.nativeClientTransitions ??= new Map<SessionId, Promise<void>>())
  if (transitions.has(sessionId)) return
  let applied: boolean | undefined
  /**
   * A REFUSAL RETURNS WITHOUT SETTING `applied`, so the `.finally` re-run guard
   * below declines and a request the user cancelled DURING a refusing attach
   * leaves its map entry behind. It self-heals: the entry is only ever read by
   * the two re-arm functions above, both of which route into this reconcile,
   * which re-reads the request set and takes the release arm. The same window
   * used to leave the lease unreleased with nothing to notice.
   */
  const transition = (async () => {
    for (;;) {
      const wanted = requests.has(sessionId)
      const handle = handleFor(ctx, sessionId)
      if (!handle || handle.binding.family !== 'server') return
      if (wanted) {
        const result = await handle.attach({
          mode: 'takeover',
          holder: nativeClientHolder(sessionId),
        })
        if ('reason' in result) {
          const retries = (ctx.nativeClientRetries ??= new Map<SessionId, number>())
          const held = retries.get(sessionId) ?? 0
          const transient = TRANSIENT_ATTACH_REFUSALS.has(result.reason)
          // A free attempt still leaves the request armed at the count it had:
          // an answered ask neither proves the session unreachable nor costs one
          // of the three tries the flapping cap is there to ration.
          const spent = spendBudget ? held + 1 : held
          const rearmed = transient && spent <= NATIVE_ATTACH_RETRY_LIMIT
          if (rearmed) retries.set(sessionId, spent)
          else retries.delete(sessionId)
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
        ctx.nativeClientRetries?.delete(sessionId)
        const pending = ctx.pendingResizes.get(sessionId)
        if (pending && ctx.clientTerminals?.resize(sessionId, pending.cols, pending.rows)) {
          ctx.pendingResizes.delete(sessionId)
        }
      } else {
        // LEAVING NATIVE RETIRES A PENDING RETRY. The bounded re-arm above exists
        // to honour a request the user still has open; firing it after they went
        // back to Chat would take the lease behind their back.
        ctx.nativeClientRetries?.delete(sessionId)
        /**
         * TEARDOWN IS UNCONDITIONAL, AND CODEX IS WHY (POD-2823).
         *
         * The stock TUI owns a direct WebSocket to the Codex Unix listener.
         * Releasing the lease must revoke that writer before another client can
         * take control; leaving it warm would let queued keystrokes bypass the
         * daemon's lease gate. The next Native view starts a fresh client.
         *
         * This used to pass `'codex'` when the binding's driver was the codex
         * one, which read as "codex is torn down differently". It never was.
         * `close()` reclaims the record's own label whatever kind it is given,
         * and on a release straight after an attach there is ALWAYS a record —
         * so the argument only ever narrowed the no-record probe, and narrowing
         * it is not something the obligation above wants. Without a kind the
         * probe asks every harness that declares a client terminal, which is
         * both the safer answer and one this arm cannot get wrong for a driver
         * that does not exist yet. The capability stays real by being applied to
         * everyone, rather than declared as a flag no code reads.
         */
        await ctx.clientTerminals?.close(sessionId)
        await handle.lease.release(nativeClientHolder(sessionId))
      }
      applied = wanted
      if (wanted === requests.has(sessionId)) return
    }
  })()
    .catch((err) => log.warn('native client terminal transition failed', { err, sessionId }))
    .finally(() => {
      transitions.delete(sessionId)
      // A request can change after the final equality check but before cleanup.
      // Re-run once the slot is free; attach and release are both idempotent.
      if (applied !== undefined && requests.has(sessionId) !== applied)
        reconcileNativeClientTerminal(ctx, sessionId)
    })
  transitions.set(sessionId, transition)
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

/**
 * Attach a freshly spawned/reattached PTY to the daemon's plumbing. `geometry` is
 * the size the PTY was created at; the RETURN value is the size it is actually
 * running at once any resize that arrived before this bridge existed has been
 * applied — that is what `bind` must report, so the server is not told the PTY is
 * 80x24 when we just sized it to the client's fitted grid (POD-628).
 */
export function wireBridge(
  ctx: DaemonContext,
  sessionId: SessionId,
  session: AgentSession,
  agentKind: AgentKind,
  durableLabel: string,
  geometry: Geometry,
): Geometry {
  ctx.bridges.set(sessionId, session)
  ctx.durableLabels.set(sessionId, durableLabel)
  const pending = ctx.pendingResizes.get(sessionId)
  ctx.pendingResizes.delete(sessionId)
  if (pending) {
    session.resize(pending.cols, pending.rows)
    ctx.observers.onResize?.(sessionId, pending.cols, pending.rows)
  }
  session.onFrame((frame) => {
    countFrame(frame.data.length)
    ctx.observers.onFrame?.(sessionId, frame.data)
    ctx.outputScheduler.enqueue(sessionId, frame.data)
    // Draft Sync v2 (POD-859): feed the composer engine the raw PTY bytes when it's
    // running for this (flagged) session. Guarded so unflagged sessions skip the
    // base64 decode entirely.
    if (ctx.composerEngine.has(sessionId)) {
      ctx.composerEngine.onData(sessionId, Buffer.from(frame.data, 'base64'))
    }
  })
  // Codex sets its OSC title to the cwd basename (+ a spinner glyph that churns at
  // frame-rate), which would clobber the real title the codex observer derives
  // (capabilities.oscTitle: false). Every other harness sets a meaningful OSC
  // title, so forward it for them.
  if (harnessCapabilitiesFor(agentKind)?.oscTitle ?? true) {
    session.onTitle((title) => ctx.send({ type: 'title', sessionId, title }))
  }
  session.onExit((code) => {
    ctx.bridges.delete(sessionId)
    ctx.pendingResizes.delete(sessionId)
    ctx.composerEngine.detach(sessionId)
    ctx.durableLabels.delete(sessionId)
    ctx.outputScheduler.remove(sessionId)
    ctx.sessionCwdTracker.clear(sessionId)
    ctx.primeInjector.reset(sessionId)
    // The agent's gone (as far as this bridge knows) — stop its observers and
    // its (now frozen) transcript tail.
    ctx.observers.clearSession(sessionId)
    // The attach CLIENT exiting is NOT the AGENT exiting. disposeAll() on a
    // daemon shutdown/redeploy SIGKILLs the client; a user detach or a client
    // crash do the same. For a durable backend the master + agent live on in
    // their own systemd scope (the whole point of abduco) — so reporting
    // agentExit here would persist a live session as 'exited', and boot never
    // reattaches an 'exited' row, orphaning a still-running agent. Only a
    // vanished master is a real exit. (`abducoHasSession` runs `abduco`, which
    // reaps the socket as it lists, so a just-exited master reads as gone.)
    const label = durableLabel
    void (async () => {
      if (ctx.backend === 'abduco' && (await abducoHasSession(label))) return
      if (ctx.backend === 'tmux' && (await tmuxHasSession(label))) return
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
  })
  return pending ? { cols: pending.cols, rows: pending.rows } : geometry
}

/**
 * Start the process for a spawn instruction.
 *
 * EXPORTED for the Agent Runtime contract's `create()`/`resume()` (POD-1761 W3),
 * which must go THROUGH this path rather than around it — the launch-file
 * materialization, the instrumentation env and the observer wiring below are
 * exactly what makes a contract-driven session byte-identical to a
 * server-spawned one. `handleSpawn` stays private because its binding transition
 * is server-authored: a driver on the machine has no principal to author one
 * with, so it takes the launch and leaves the binding to the frame that carries
 * an authenticated one.
 */
export async function launchSpawn(
  ctx: DaemonContext,
  msg: SpawnControl,
  runtimeSelection: { requestedDriverId?: string } = {},
): Promise<void> {
  try {
    // Born pinned (POD-665): the server picked this cwd, so the session's workspace
    // is known before the agent has run a single hook. Every server-side spawn funnels
    // through here, so this one call covers issue start, add-session, `agent spawn`,
    // the UI button and automations alike. Not awaited — the pin only has to beat the
    // agent's FIRST hook (a git rev-parse against an agent boot), and delaying the PTY
    // for it would be the wrong trade.
    void ctx.sessionCwdTracker.setLaunchCwd(msg.sessionId, msg.cwd)
    const spawnStartedAt = Date.now()
    const runtimeDir = instructionRuntimeDir(ctx, msg.sessionId)
    // Harnesses that let the caller name a NEW conversation get their native id
    // minted here rather than discovered from disk afterwards. Grok creates no
    // session directory at all until its first turn, so an unused session would
    // otherwise never bind and its chat would stay empty. Minted per spawn (never
    // derived from the session id): the CLI rejects an id that already exists, so
    // a re-spawn of the same row must not reuse one. [POD-386]
    const newSessionId =
      !msg.resume && harnessCapabilitiesFor(msg.agentKind)?.newSessionIdFlag
        ? randomUUID()
        : undefined
    const loginCommand = msg.loginHarness
      ? declaredValue(
          manifestFor(msg.loginHarness)?.inventory.loginCommand ?? {
            supported: false,
            reason: 'unknown harness',
          },
        )
      : undefined
    if (msg.loginHarness && !loginCommand) {
      throw new Error(`${msg.loginHarness} does not declare a native login command`)
    }
    const launchOptions = {
      cwd: msg.cwd,
      ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
      podiumSessionId: msg.sessionId,
      ...(msg.resume ? { resume: msg.resume } : {}),
      ...(newSessionId ? { newSessionId } : {}),
      ...(msg.model ? { model: msg.model } : {}),
      ...(msg.effort ? { effort: msg.effort } : {}),
      ...(msg.initialPrompt ? { initialPrompt: msg.initialPrompt } : {}),
      ...(msg.instructions ? { instructions: msg.instructions } : {}),
      runtimeDir,
      ...(msg.env ? { env: msg.env } : {}),
    }
    // loginCommand is intentionally a static argv declaration: the production
    // branch below binds it to the current generation's verified executable and
    // command environment. Resolving here would duplicate that snapshot and let
    // login drift from the executable the rest of the launch uses. The injected
    // ctx.launch branch is a legacy/test seam; production host runtime always
    // supplies the binder for this path.
    const cmd = loginCommand
      ? ctx.harnessRuntime
        ? bindHarnessLaunch(await ctx.harnessRuntime.current(), msg.loginHarness!, {
            args: [...loginCommand.args],
            cwd: msg.cwd,
          })
        : { cmd: loginCommand.cmd, args: [...loginCommand.args], cwd: msg.cwd }
      : ctx.harnessRuntime
        ? await ctx.harnessRuntime.launch(msg.agentKind, launchOptions)
        : ctx.launch(msg.agentKind, launchOptions)
    materializeLaunchFiles(cmd.files)
    // OpenCode creates its SQLite parent lazily. Create the Podium-owned
    // directory before the PTY starts so two fresh sessions cannot race on a
    // missing per-session store directory.
    if (msg.agentKind === 'opencode' && !msg.loginHarness && cmd.env?.OPENCODE_DB) {
      mkdirSync(dirname(cmd.env.OPENCODE_DB), { recursive: true })
    }
    const label = msg.durableLabel ?? ctx.durableLabelFor(msg.sessionId)
    const provider = agentStateProviderFor(msg.agentKind)
    let extraArgs: string[] = []
    let instrumentationEnv: Record<string, string> = {}
    if (provider) {
      mkdirSync(ctx.settingsDir, { recursive: true })
      const instr = provider.instrumentation({
        endpointUrl: ctx.hookEndpointFor(msg.sessionId),
        settingsPath: join(ctx.settingsDir, `${msg.sessionId}.json`),
        // Absent = the setting default (on); older servers still get [spec:SP-a04d].
        seedTheme: msg.seedCliTheme ?? true,
        ...(ctx.hookSocketPath ? { socketPath: ctx.hookSocketPath } : {}),
      })
      if (instr.file) writeFileSync(instr.file.path, instr.file.contents)
      extraArgs = instr.args
      instrumentationEnv = instr.env ?? {}
    }
    const spawnOpts = {
      label,
      cmd: cmd.cmd,
      args: instrumentedLaunchArgs(cmd.args, extraArgs),
      cwd: cmd.cwd,
      cols: msg.geometry.cols,
      rows: msg.geometry.rows,
      env: spawnEnv({
        // Server-resolved managed credential / environment (SP-6454, #216).
        sessionEnv: msg.env,
        harnessEnv: cmd.env,
        podiumEnv: {
          // Bind the loopback session relay + session id into every session's env so its
          // `podium` CLI can reach the daemon for this exact session. The agent-IDENTITY
          // half rides along only for harness kinds — a shell is the operator [POD-1375].
          ...sessionRelayEnv(
            msg.sessionId,
            ctx.agentRelayEndpointFor(msg.sessionId),
            ctx.instanceId,
            msg.agentKind,
            ctx.instanceUuid,
          ),
          ...browserOpenEnv(ctx.settingsDir),
          ...(ctx.homeDir ? { HOME: ctx.homeDir } : {}),
          ...harnessInstanceEnv(msg.loginHarness ?? msg.agentKind, ctx.homeDir),
          // Subagent model rides as env — Claude Code reads it; harmless elsewhere.
          ...(msg.subagentModel ? { CLAUDE_CODE_SUBAGENT_MODEL: msg.subagentModel } : {}),
          // Globally-installed hooks are env-gated per session by their adapter.
          // Commands exit immediately when absent, so non-Podium runs are untouched.
          ...instrumentationEnv,
          // Terminal-protocol compatibility for this harness (see above).
          ...harnessCompatEnv(msg.agentKind),
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
      stripEnv: harnessChildStripEnv(msg.loginHarness ?? msg.agentKind, msg.env),
    }
    const session =
      ctx.backend === 'abduco'
        ? await spawnAbducoAgent(spawnOpts)
        : ctx.backend === 'tmux'
          ? await spawnTmuxAgent(spawnOpts)
          : spawnAgent(spawnOpts)
    const geometry = wireBridge(ctx, msg.sessionId, session, msg.agentKind, label, msg.geometry)
    // Stand up the agent-state tracker, harness observer, resume transcript tail
    // and seeded phase. The frame tap buffers the bounded gap between bridge
    // wiring and this setup so screen-derived state still sees the first screen.
    ctx.observers.initSessionObservers(msg, session, provider, {
      seedOnFrame: true,
      startedAtMs: spawnStartedAt,
      ...(newSessionId ? { newSessionId } : {}),
    })
    ctx.observers.onResize?.(msg.sessionId, geometry.cols, geometry.rows)
    await bindRuntimeContract(ctx, msg, false)
    const driverId = runtimeDriverIdFor(ctx, msg.sessionId)
    // Draft Sync v2 (POD-859): begin composer sync for a flagged, composer-capable
    // session. attach() is a no-op for harnesses without a driver.
    if (msg.draftSync) {
      ctx.composerEngine.attach(msg.sessionId, msg.agentKind, geometry.cols, geometry.rows)
    }
    // An adopted spawn started nothing: the durable master for this label was still
    // running and we reattached to it (POD-1945 — a Resume used to die on abduco's
    // "address already in use" instead). Report it as the attach it is, so the row
    // does not claim a fresh launch that never happened.
    if (session.adopted) {
      log.info('spawn adopted the live durable session for this label', {
        sessionId: msg.sessionId,
        label,
      })
    }
    ctx.send({
      type: 'bind',
      sessionId: msg.sessionId,
      cmd: session.adopted ? `abduco -a ${label}` : cmd.cmd,
      cwd: cmd.cwd,
      agentKind: msg.agentKind,
      geometry,
      ...(ctx.composerEngine.has(msg.sessionId) ? { draftSyncEngine: true } : {}),
      // The driver handle actually exists for this session (POD-1761 W4). The
      // server records it and W4's senders branch on it — see BindMessage.
      // ASKS EVERY REGISTRY (POD-2023): a predicate that knew only the terminal
      // one would report `false` for a server-family session and route its
      // sends down the legacy PTY path, for a session that has no PTY.
      ...(sessionIsBehindContract(ctx, msg.sessionId) ? { runtimeContract: true } : {}),
      ...(driverId ? { driverId } : {}),
      ...(runtimeSelection.requestedDriverId
        ? { requestedDriverId: runtimeSelection.requestedDriverId }
        : {}),
    })
  } catch (err) {
    removeSessionInstructions(ctx, msg.sessionId)
    // Nothing ever bound, so a resize held for this spawn has no PTY to reach and
    // must not be applied to whatever is spawned for this id next.
    ctx.pendingResizes.delete(msg.sessionId)
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
export const MISSING_SESSION_BINDING_MESSAGE =
  'server-minted SessionBinding instruction is required'

/**
 * Put this session behind the Agent Runtime contract, when the flag says so
 * (POD-1761 W3).
 *
 * CALLED FROM BOTH THE SPAWN AND THE REATTACH PATHS, immediately after the
 * observers are wired, because those are the two moments a session acquires a
 * live bridge — and a driver handle without a bridge would answer `not_running`
 * to everything, which is true but useless.
 *
 * FLAG OFF RETURNS ON THE FIRST LINE. That is the whole of the "zero diff"
 * claim on this path: no handle, no queue, no observation tap entry, and the
 * legacy machinery above ran exactly as it always has.
 */
async function bindRuntimeContract(
  ctx: DaemonContext,
  msg: SpawnControl | ReattachControl,
  rebind: boolean,
): Promise<void> {
  if (!ctx.agentRuntime) return
  if (!runtimeContractEnabledFor(ctx.runtimeContractEnabled, msg.runtimeContract)) return
  const profile = terminalProfileFor(msg.agentKind)
  // A shell has no turns, no transcript and no state channel — there is nothing
  // for a driver to be honest about, so the flag simply does not reach it.
  if (!profile) return
  try {
    await ctx.agentRuntime.bindTerminal(
      {
        sessionId: msg.sessionId,
        agentKind: msg.agentKind,
        cwd: msg.cwd,
        resume: msg.resume ?? null,
        ...(msg.observationGeneration !== undefined
          ? { observerGeneration: msg.observationGeneration }
          : {}),
        ...(msg.observationBindingVersion !== undefined
          ? { bindingVersion: msg.observationBindingVersion }
          : {}),
        rebind,
      },
      profile,
    )
  } catch (err) {
    // A DRIVER THAT CANNOT BE BUILT MUST NOT TAKE THE SESSION DOWN WITH IT. The
    // legacy path is already wired and working at this point; the flagged path is
    // additive, so its failure is a diagnostic, not a spawn error.
    log.warn('could not put the session behind the runtime contract', {
      err,
      sessionId: msg.sessionId,
    })
  }
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
   * It is HERE and not inside `launchSpawn`, and the placement is the point: a
   * server-family session has no PTY to launch, no durable master to reclaim and
   * no bridge to wire, so routing it through the PTY spawn path and then undoing
   * the parts that do not apply would be worse than a branch. The binding
   * transition ABOVE still ran, because who owns a session is not a question
   * about how it is driven.
   *
   * Every spawn is offered to the harness policy. Server-capable harnesses take
   * their own server driver when its three-valued probe admits this machine; an
   * absent, unsupported or unprobeable driver falls through to the PTY path.
   * Harnesses without a server declaration (including Claude Code) never probe
   * and stay on that path.
   */
  const runtimeLaunch = await launchServerDriverSession(ctx, msg)
  if (runtimeLaunch.handled) return
  await launchSpawn(ctx, msg, runtimeLaunch)
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
 *   - AN UNSUPPORTED DRIVER FROM THE MACHINE-WIDE DEFAULT DEGRADES to whatever
 *     the manifest ranks next, which today is terminal. The machine's opencode
 *     answered and the gate refused its version; `selectRuntimeDriver` already
 *     drops a preference the machine cannot run, and honouring it anyway would
 *     turn a stale `PODIUM_RUNTIME_DRIVER` into a machine where NO session can
 *     start. Pinned by `opencode-server.test.ts`'s "DEGRADES an opt-in the
 *     machine cannot run".
 *   - THE SAME REQUEST MADE PER-SPAWN REFUSES (POD-2113). An id on the spawn
 *     frame is not a setting anyone forgot; it is this session's reason for
 *     existing, and every operator who sends one is testing whether the driver
 *     works. Silently answering with a terminal session gave them the one
 *     outcome that looks exactly like the answer they wanted. Degrading is right
 *     for a value inherited from a machine and wrong for a value typed for a
 *     session, so the split is on WHERE the id came from, not on what it says.
 *   - A DRIVER WE COULD NOT PROBE REFUSES, when the spawn named it explicitly.
 *     Added after POD-2056 measured `opencode --version` at 11–15s on the build
 *     host against a 15s budget: losing that race made an explicit
 *     `runtimeContract: 'opencode-server'` become a PTY session, and it did so
 *     invisibly — the session went live, the row still said `runtimeContract:
 *     true` (the TERMINAL driver had registered), and the first send came back
 *     `unverified`, which reads as a model problem four steps from the cause.
 *     "This machine's opencode is too old" is a fact about the machine and
 *     degrading on it is honest; "I could not find out" is a fact about load,
 *     and an operator who NAMED the driver would rather be told.
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
   * it asks whether an abduco socket or a tmux session still holds the durable
   * label". The session came back `reattachFailed: session not found`, which is
   * verbatim the failure this function exists to prevent.
   *
   * A session appears in exactly ONE journal by construction — the spawn path
   * chose a driver once and that driver's launch wrote the entry — so this is a
   * lookup rather than a precedence, and the first entry found is the answer.
   */
  const runtime = ctx.agentRuntime
  if (!runtime) return false
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
    adoption = await runtime.adoptJournalled(msg.sessionId)
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
  const { handle, what, workdir } = adoption
  if (!handle) {
    /**
     * THE JOURNAL SAID SERVER, AND NOTHING ANSWERED. Reported as a reattach
     * FAILURE rather than fallen through to the PTY path: falling through
     * would spawn nothing, find no durable host and report the same failure
     * one layer down with a reason that names abduco — which would send the
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
    ctx.send({
      type: 'bind',
      sessionId: msg.sessionId,
      cmd: `${what} (${handle.binding.driver})`,
      cwd: workdir,
      agentKind: msg.agentKind,
      geometry: msg.geometry ?? { cols: 120, rows: 40 },
      // The same fact the launch path states, and for the same reason: W4's
      // senders branch on it, and a rebound session that reported `false` would
      // be routed to a PTY it does not have.
      runtimeContract: true,
      driverId: handle.binding.driver,
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
    ctx.send({
      type: 'bind',
      sessionId: msg.sessionId,
      cmd: `${what} (${handle.binding.driver})`,
      // THE JOURNAL'S WORKDIR, like the reattach path uses. The frame's `cwd` is
      // where the server thinks the session lives; the journal is where the
      // conversation was actually opened, and codex resumes a thread relative to
      // that. They agree unless a worktree moved under a parked session, and if
      // they disagree the adopted child is the one that has to be described.
      cwd: workdir,
      agentKind: msg.agentKind,
      geometry: msg.geometry ?? { cols: 120, rows: 40 },
      // The same fact the launch and reattach paths state, and for the same
      // reason: W4's senders branch on it, and a resumed session that reported
      // `false` would be routed to a PTY it does not have.
      runtimeContract: true,
      driverId: handle.binding.driver,
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

/** The only server binary admission may probe after applying the login gate. */
export function admissionProbeDriver(
  preferred: string | undefined,
  selectionAuth: ReturnType<typeof selectionAuthForLogin>,
): string | undefined {
  if (selectionAuth === 'logged-out') return undefined
  return preferred && isServerDriverId(preferred) ? preferred : undefined
}

/**
 * Emit the operator-facing record for a permitted runtime-driver degradation
 * (machine-wide or manifest-default) and return the preferred id for the bind
 * projection.
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
  ctx.send({ type: 'driverSelected', sessionId, driverId })
}

type ServerDriverProbeVerdict =
  | { drivable: true }
  | {
      drivable: false
      reason: 'unsupported' | 'unprobeable'
      diagnostic: { title: string; body: string }
    }

export type ServerDriverAdmissionProbe = (
  driverId: string,
  policy?: { retryInconclusive?: boolean },
) => Promise<ServerDriverProbeVerdict>

const defaultServerDriverAdmissionProbe: ServerDriverAdmissionProbe = (driverId, policy) =>
  driverId === 'codex-app-server'
    ? codexAppServerVersionProbe(undefined, policy)
    : driverId === 'grok-acp'
      ? grokAcpVersionProbe(undefined, policy)
      : opencodeVersionProbe(undefined, policy)

export async function launchServerDriverSession(
  ctx: DaemonContext,
  msg: SpawnControl,
  probeDriver: ServerDriverAdmissionProbe = defaultServerDriverAdmissionProbe,
): Promise<ServerDriverLaunchResult> {
  const { preferred } = runtimeDriverIntentForSpawn({
    agentKind: msg.agentKind,
    perSpawn: msg.runtimeContract,
    machineDefault: runtimeDriverByEnv(),
  })
  if (!preferred) {
    // No server driver is even in play for this harness (Claude Code, cursor, a
    // shell): the answer is the terminal one and it is known without probing
    // anything, so say so now rather than leaving the clients to infer it from
    // a `bind` that is still seconds away. `terminalProfileFor` is undefined
    // only for a kind with no manifest — a shell — which has no driver to name.
    const terminal = terminalProfileFor(msg.agentKind)
    if (terminal) announceDriverSelection(ctx, msg.sessionId, terminal.driverId)
    return { handled: false }
  }
  /**
   * WHAT *THIS SPAWN* SAID, as opposed to what the machine was configured to
   * prefer. `requested` has the env default folded in and cannot tell them
   * apart; every refusal below keys on this instead, and the reason is the rule
   * this function's docstring states — a fact about the MACHINE may be papered
   * over, an instruction from THIS SPAWN may not.
   */
  const namedHere = spawnNamedServerDriver(msg.runtimeContract)
  // Login is cheaper and more authoritative than availability for a headless
  // default: a known logout always selects the PTY login path, so probing a
  // server binary first can only delay the same answer.
  const loginState = ctx.harnessLoginState(msg.agentKind)
  const selectionAuth = selectionAuthForLogin(msg.agentKind, loginState)
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
  const probeFor = (driverId: string) =>
    probeDriver(driverId, namedHere === driverId ? { retryInconclusive: true } : undefined)
  const preferredServer = admissionProbeDriver(preferred, selectionAuth)
  const preferredProbe = preferredServer === undefined ? undefined : await probeFor(preferredServer)
  const namedProbe = namedHere ? preferredProbe : undefined
  /**
   * REFUSED ONLY WHEN *THIS SPAWN* NAMED THE DRIVER — the fix to a defect this
   * very check used to have (POD-2113, found by review).
   *
   * It read `isServerDriverId(requested)`, so a machine-wide
   * `PODIUM_RUNTIME_DRIVER` triggered it too. `ok` is false on ENOENT as well as
   * on a timeout and an `unprobeable` verdict is only briefly memoized, so
   * on a daemon whose PATH lacks the binary — installed under `~/.opencode/bin`
   * while the daemon starts from a systemd unit, which is the normal case — one
   * env var refused every spawn of every harness. That is precisely "a stale
   * env var kills every spawn on the box", the outcome this whole function
   * argues must never happen, and it was the docstring three lines up that was
   * telling the truth while the code was not. W6's second driver doubled the
   * ways in without changing the shape.
   *
   * `namedHere === requested` whenever this fires (the per-spawn field wins in
   * `runtimeDriverFor`), so `namedProbe` is this driver's own probe.
   */
  if (namedProbe !== undefined && !namedProbe.drivable && namedProbe.reason === 'unprobeable') {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: `${namedProbe.diagnostic.title}: ${namedProbe.diagnostic.body}`,
    })
    return { handled: true }
  }
  const runtime = ctx.agentRuntime
  if (!runtime) {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: 'machine runtime is not composed',
    })
    return { handled: true }
  }
  const resolution = runtime.resolveDriver({
    agentKind: msg.agentKind,
    requested: msg.runtimeContract,
    machineDefault: runtimeDriverByEnv(),
    // Only the preferred server is probed and admitted. An explicit terminal
    // request therefore avoids every server probe.
    available: availableDriverIds({
      claudeSdkTosAccepted: claudeSdkTosAcceptedByEnv(),
      grokDrivable: preferredServer === 'grok-acp' && preferredProbe?.drivable === true,
      opencodeDrivable: preferredServer === 'opencode-server' && preferredProbe?.drivable === true,
      codexDrivable: preferredServer === 'codex-app-server' && preferredProbe?.drivable === true,
    }),
    platform: process.platform,
    auth: selectionAuth,
  })
  if (!resolution.ok) {
    ctx.send({ type: 'spawnError', sessionId: msg.sessionId, message: resolution.reason })
    return { handled: true }
  }
  if (
    (isServerDriver(msg.agentKind, resolution.driverId) ||
      isEmbeddedDriver(msg.agentKind, resolution.driverId)) &&
    resolution.capabilities.placement !== 'dedicated'
  ) {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: `runtime driver '${resolution.driverId}' does not provide dedicated server placement`,
    })
    return { handled: true }
  }

  /**
   * THIS SPAWN NAMED A SERVER DRIVER AND DID NOT GET IT — REFUSED (POD-2113).
   *
   * Without this the request dies right here, in silence: `resolution.driverId`
   * is a terminal driver, `isServerDriver` is false, the function answers "not
   * mine", and the spawn falls through to the PTY launch. The operator gets a
   * healthy session that obeyed nothing — and no signal afterwards either, since
   * the row records `runtimeContract: true` (the TERMINAL driver registered) and
   * no read surface carries a driver id at all.
   *
   * The refuse/degrade split itself lives in {@link unhonouredSpawnDriver},
   * where it can be tested without a daemon.
   */
  const unhonoured = unhonouredSpawnDriver({
    perSpawn: msg.runtimeContract,
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
  if (
    !isServerDriver(msg.agentKind, resolution.driverId) &&
    !isEmbeddedDriver(msg.agentKind, resolution.driverId)
  ) {
    /**
     * THE DEGRADE THAT SURVIVES, SAID OUT LOUD.
     *
     * A manifest-default or machine-wide server preference this box cannot run
     * degrades deliberately, so an unsupported binary or transient probe miss
     * cannot kill the spawn. The warning is the machine-level operational trace;
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
   * it and what the journal entry is for.
   */
  if (isServerDriver(msg.agentKind, resolution.driverId)) {
    if (await resumeJournalledServerSession(ctx, msg)) return { handled: true }
  }
  try {
    const spec: SessionSpec = {
      harness: msg.agentKind,
      selection: {
        auth: selectionAuth,
        platform: process.platform,
        available: [resolution.driverId],
        preference: resolution.driverId,
        role: 'interactive',
      },
      workdir: msg.cwd,
      model: {
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.effort ? { effort: msg.effort } : {}),
      },
      instructions: {
        supported: false,
        reason: 'interactive server instructions are not carried by the spawn frame adapter',
      },
      /**
       * NO MCP CONFIG IS FORWARDED, AND THAT IS A DECLARED GAP RATHER THAN AN
       * OVERSIGHT (POD-1761 W6).
       *
       * The codex driver and its host implement the mount end to end —
       * `codexAppServerConfigArgs` builds the `-c mcp_servers.…` overrides
       * through the manifest's own verified `codexMcpArgs`, and
       * `SessionSpec.mcpServers` carries the declaration to it. What does not
       * exist is a SOURCE: `mcpConfig` is a headless/harness-exec field, and the
       * interactive `spawn` frame has never carried one, because interactive
       * sessions mount MCP through the CLI's own config file. Inventing a field
       * here would be a wire change beyond this item; passing an empty one would
       * make the driver report a tool mount it did not make. So an app-server
       * session mounts whatever `~/.codex/config.toml` already declares, and the
       * spawn-frame field is POD-1761's to schedule.
       */
      mcpServers: {
        supported: false,
        reason: 'interactive sessions mount MCP through the harness native config file',
      },
      ...(msg.env ? { env: msg.env } : {}),
      ...(msg.initialPrompt ? { initialPrompt: msg.initialPrompt } : {}),
    }
    await runtime.create(spec, msg.sessionId)
    reconcileNativeClientTerminal(ctx, msg.sessionId)
  } catch (err) {
    // A server that would not start is a SPAWN ERROR, reported on the frame the
    // UI already renders. The alternative — falling back to a PTY — would hide
    // exactly the failure the operator is trying to see.
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: err instanceof Error ? err.message : String(err),
    })
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
   * point assumes a PTY: it asks whether an abduco socket or a tmux session
   * still holds the durable label. A server-family session has neither — its
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

  const existing = ctx.bridges.get(msg.sessionId)
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
      ctx.observers.initSessionObservers(msg, existing, agentStateProviderFor(msg.agentKind), {
        seedOnFrame: false,
      })
    }
    await bindRuntimeContract(ctx, msg, true)
    const driverId = runtimeDriverIdFor(ctx, msg.sessionId)
    const cmd =
      ctx.backend === 'tmux'
        ? `tmux -L ${msg.durableLabel} attach`
        : `abduco -a ${msg.durableLabel}`
    // Draft Sync v2 (POD-859): ensure the engine is running if flagged (idempotent —
    // covers a runtime flag flip since the original spawn).
    if (msg.draftSync) {
      ctx.composerEngine.attach(msg.sessionId, msg.agentKind, msg.geometry.cols, msg.geometry.rows)
    }
    ctx.send({
      type: 'bind',
      sessionId: msg.sessionId,
      cmd,
      cwd: msg.cwd,
      agentKind: msg.agentKind,
      geometry: msg.geometry,
      ...(ctx.composerEngine.has(msg.sessionId) ? { draftSyncEngine: true } : {}),
      // The driver handle actually exists for this session (POD-1761 W4). The
      // server records it and W4's senders branch on it — see BindMessage.
      // ASKS EVERY REGISTRY (POD-2023): a predicate that knew only the terminal
      // one would report `false` for a server-family session and route its
      // sends down the legacy PTY path, for a session that has no PTY.
      ...(sessionIsBehindContract(ctx, msg.sessionId) ? { runtimeContract: true } : {}),
      ...(driverId ? { driverId } : {}),
      ...(msg.requestedDriverId ? { requestedDriverId: msg.requestedDriverId } : {}),
    })
    existing.redraw()
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
        // Keep bind/state/redraw above immediate, but pace the allocation-heavy
        // transcript read/parse/reset-send through the existing seed gate.
        const source = await sourceForRead(ctx, msg)
        const res = await source.readSlice({
          direction: 'before',
          limit: 2000,
        })
        if (res.items.length > 0) {
          ctx.send({
            type: 'transcriptDelta',
            sessionId: msg.sessionId,
            items: res.items,
            reset: true,
            ...(res.tail ? { tail: res.tail } : {}),
          })
        }
      } catch (err) {
        log.warn('reattach re-seed failed', { err, sessionId: msg.sessionId })
      }
    }, ctx.outputScheduler.priorityOf(msg.sessionId))
    return
  }
  await ctx.reattachGate(async () => {
    if (ctx.bridges.has(msg.sessionId)) return // raced with another reattach for this id
    // Re-pin a survivor (POD-665). Pins live in daemon memory, so a daemon restart
    // would otherwise leave every reattached session unpinned and free to be dragged
    // out of its worktree by the next `cd`. `msg.cwd` is the row's persisted cwd —
    // the server's own record of where this session lives. Only this branch needs it:
    // reaching the one above means the daemon never died, so the pin is still held.
    // Inside the gate on purpose — a restart reattaches every session at once, and
    // this forks git.
    void ctx.sessionCwdTracker.setLaunchCwd(msg.sessionId, msg.cwd)
    // A reattached shell sits idle at its prompt and ignores the SIGWINCH repaint
    // nudge, so without a Ctrl-L it shows blank until the user types. TUIs repaint
    // on resize, so only shells take the hard path.
    const attach = {
      label: msg.durableLabel,
      cols: msg.geometry.cols,
      rows: msg.geometry.rows,
      hardRepaint: msg.agentKind === 'shell',
    }
    let found: { session: AgentSession; cmd: string } | undefined
    // Backend-agnostic: try whichever durable host owns the label, so sessions
    // created under tmux before an abduco upgrade still reattach (no flag day).
    let socketPath: string | undefined
    if (ctx.backend !== 'none') {
      reapStaleAbducoBindTemps()
      const abducoEnv = ctx.homeDir ? { ...process.env, HOME: ctx.homeDir } : process.env
      socketPath = abducoSocketPath(msg.durableLabel, abducoEnv)
      if (socketPath === undefined) {
        try {
          socketPath = await waitForAbducoSocket(msg.durableLabel, abducoEnv, { timeoutMs: 1500 })
        } catch {
          // The durable host may be absent; keep the tmux compatibility fallback below.
        }
      }
    }
    if (socketPath) {
      found = {
        session: attachAbducoAgent({ ...attach, socketPath }),
        cmd: `abduco -a ${socketPath}`,
      }
    } else if (ctx.backend !== 'none' && (await tmuxHasSession(msg.durableLabel))) {
      found = {
        session: attachTmuxAgent(attach),
        cmd: `tmux -L ${msg.durableLabel} attach`,
      }
    }
    if (!found) {
      ctx.send({
        type: 'reattachFailed',
        sessionId: msg.sessionId,
        reason: ctx.backend === 'none' ? 'durable backend unavailable' : 'session not found',
      })
      return
    }
    const geometry = wireBridge(
      ctx,
      msg.sessionId,
      found.session,
      msg.agentKind,
      msg.durableLabel,
      msg.geometry,
    )
    // The settings file from the original spawn still points at our fixed port,
    // so a reattached agent keeps reporting. A fresh daemon (post-redeploy) lost
    // all in-memory per-session state — rebuild it via the same path spawn uses.
    // A survivor is already at its prompt and fires no hook until the user acts,
    // so seed immediately (an idle session would otherwise read 'unknown' →
    // 'working') and re-tail its transcript (else chat stays empty while the
    // native view still has scrollback).
    ctx.observers.initSessionObservers(msg, found.session, agentStateProviderFor(msg.agentKind), {
      seedOnFrame: false,
    })
    ctx.observers.onResize?.(msg.sessionId, geometry.cols, geometry.rows)
    await bindRuntimeContract(ctx, msg, true)
    const driverId = runtimeDriverIdFor(ctx, msg.sessionId)
    if (msg.draftSync) {
      ctx.composerEngine.attach(msg.sessionId, msg.agentKind, geometry.cols, geometry.rows)
    }
    ctx.send({
      type: 'bind',
      sessionId: msg.sessionId,
      cmd: found.cmd,
      cwd: msg.cwd,
      agentKind: msg.agentKind,
      geometry,
      ...(ctx.composerEngine.has(msg.sessionId) ? { draftSyncEngine: true } : {}),
      // The driver handle actually exists for this session (POD-1761 W4). The
      // server records it and W4's senders branch on it — see BindMessage.
      // ASKS EVERY REGISTRY (POD-2023): a predicate that knew only the terminal
      // one would report `false` for a server-family session and route its
      // sends down the legacy PTY path, for a session that has no PTY.
      ...(sessionIsBehindContract(ctx, msg.sessionId) ? { runtimeContract: true } : {}),
      ...(driverId ? { driverId } : {}),
      ...(msg.requestedDriverId ? { requestedDriverId: msg.requestedDriverId } : {}),
    })
    // attachAbducoAgent nudges the PTY before the bridge is wired, so that
    // initial repaint can be lost. Nudge once more after bind to make a fresh
    // daemon reattach paint native view reliably.
    found.session.redraw()
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
export function stopSessionProcess(
  ctx: DaemonContext,
  msg: { sessionId: SessionId; durableLabel?: string },
  opts: { retire?: boolean } = {},
): void {
  const session = ctx.bridges.get(msg.sessionId)
  ctx.observers.clearSession(msg.sessionId)
  ctx.agentRuntime?.clearTerminal(msg.sessionId)
  ctx.pendingResizes.delete(msg.sessionId)
  ctx.nativeClientRequests?.delete(msg.sessionId)
  // The request is gone, so the retry it was owed is too — there is no session
  // left to become idle, and a stale entry would outlive the id.
  ctx.nativeClientRetries?.delete(msg.sessionId)
  void ctx.clientTerminals?.close(msg.sessionId)
  if (session) {
    session.dispose()
    ctx.bridges.delete(msg.sessionId)
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
  void beginServerDriverReap(ctx, msg.sessionId, { retire: opts.retire === true }).catch((err) => {
    log.warn('could not start reaping the server-driver session', {
      err,
      sessionId: msg.sessionId,
    })
  })
  void reapInstanceSessionProcesses({
    instanceUuid: ctx.instanceUuid,
    sessionId: msg.sessionId,
  })
    .then((result) => {
      if (result.examined > 0 && result.remaining > 0)
        log.warn('instance-owned session processes survived escalation', {
          sessionId: msg.sessionId,
          ...result,
        })
    })
    .catch((err) => {
      log.warn('could not reap instance-owned session processes', { err, sessionId: msg.sessionId })
    })
  // Reap the durable host unconditionally — NOT only when a bridge exists.
  // Generic kill is process policy (hibernate, stop, handoff); retirement is a
  // separate server-authored binding transition.
  if (ctx.backend !== 'none') {
    const durableLabel =
      msg.durableLabel ?? ctx.durableLabels.get(msg.sessionId) ?? ctx.durableLabelFor(msg.sessionId)
    void reapDurableHost(ctx, msg.sessionId, durableLabel)
  }
  ctx.durableLabels.delete(msg.sessionId)
  removeSessionUploads(msg.sessionId, ctx.portableStateFence)
  removeSessionInstructions(ctx, msg.sessionId)
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
): Promise<void> {
  const stillRunning = async (): Promise<boolean> =>
    (await abducoHasSession(durableLabel)) || (await tmuxHasSession(durableLabel))
  try {
    await Promise.all([killAbducoSession(durableLabel), killTmuxServer(durableLabel)])
    let alive = await stillRunning()
    if (alive) {
      log.warn('the durable host survived a kill — retrying', { sessionId, durableLabel })
      await Promise.all([killAbducoSession(durableLabel), killTmuxServer(durableLabel)])
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
  } catch (err) {
    // A reap that THREW proves nothing about the process, so report what is
    // there rather than a guess — an unreported throw is the silent no-op again.
    log.warn('could not reap the durable host', { err, sessionId, durableLabel })
    ctx.send({
      type: 'sessionKillResult',
      sessionId,
      durableLabel,
      killed: !(await stillRunning().catch(() => false)),
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}
export const sessionHandlers: Pick<
  ControlHandlers,
  | 'spawn'
  | 'reattach'
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
  | 'sessionOpenUrlCallback'
  | 'sessionOpenUrlDismiss'
> = {
  spawn: (ctx, msg) => {
    void handleSpawn(ctx, msg)
  },
  reattach: (ctx, msg) => {
    void handleReattach(ctx, msg)
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
  input: (ctx, msg) => {
    const input = Buffer.from(msg.data, 'base64').toString('utf8')
    if (input.includes('\r') || input.includes('\n')) {
      ctx.observers.recordInputOrigin(msg.sessionId, msg.inputOrigin)
    }
    const bridge = ctx.bridges.get(msg.sessionId)
    // The client terminal is a leased takeover surface, not a second write
    // path. Once Chat releases the native request, stale frames must not reach
    // the warm abduco master.
    if (
      !bridge &&
      ctx.nativeClientRequests?.has(msg.sessionId) &&
      ctx.clientTerminals?.input(msg.sessionId, msg.data)
    ) {
      ctx.composerEngine.onInputByte(msg.sessionId)
      return
    }
    if (!bridge && sessionIsBehindContract(ctx, msg.sessionId)) {
      // Chat sends for a server-family session use `runtimeSendRequest`; Native
      // bytes reach the client terminal above. Anything arriving here has
      // neither surface and is malformed/stale rather than silently accepted.
      log.warn('discarding input bytes for a bridgeless contract session', {
        sessionId: msg.sessionId,
        bytes: msg.data.length,
      })
    }
    bridge?.write(msg.data)
    // Input-byte tap (POD-859 §3): a client typing into the PTY means the native
    // replica is hot, so the engine defers injection. No-op for unflagged sessions.
    ctx.composerEngine.onInputByte(msg.sessionId)
  },
  resize: (ctx, msg) => {
    const bridge = ctx.bridges.get(msg.sessionId)
    // No bridge yet = the spawn this resize belongs to is still in flight. Hold the
    // request for wireBridge instead of dropping it: the server has already moved
    // its own geometry (and told the browser), so a drop here is what leaves the
    // PTY at 80x24 under a client rendering a fitted grid (POD-628). Last one wins
    // — an in-flight session has no screen to reflow, only a size to be born at.
    if (bridge) bridge.resize(msg.cols, msg.rows)
    else if (!ctx.clientTerminals?.resize(msg.sessionId, msg.cols, msg.rows))
      ctx.pendingResizes.set(msg.sessionId, { cols: msg.cols, rows: msg.rows })
    ctx.observers.onResize?.(msg.sessionId, msg.cols, msg.rows)
    ctx.composerEngine.onResize(msg.sessionId, msg.cols, msg.rows)
  },
  draftTarget: (ctx, msg) => {
    // A chat-originated draft to mirror into the native composer (POD-859 phase 4).
    ctx.composerEngine.setTarget(msg.sessionId, msg.text)
  },
  redraw: (ctx, msg) => {
    if (!ctx.clientTerminals?.redraw(msg.sessionId)) ctx.bridges.get(msg.sessionId)?.redraw()
  },
  agentObservationAck: (ctx, msg) => {
    ctx.observers.onObservationAck(msg)
  },
  agentObservationRebindAck: (ctx, msg) => {
    ctx.observers.onProviderRebindAck(msg)
  },
  sessionResumeRefAck: (ctx, msg) => {
    void ctx.sessionBinding
      .acknowledgeReceipt(msg.ownerId, msg.sessionId, msg.resume)
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
    const requests = (ctx.nativeClientRequests ??= new Set<SessionId>())
    if (nativeView) requests.add(msg.sessionId)
    else requests.delete(msg.sessionId)
    reconcileNativeClientTerminal(ctx, msg.sessionId)
  },
  reclaimAttachments: (ctx) => {
    // Host pressure, decided by the server that owns the threshold. Attachments
    // go BEFORE any session is parked (spec §5) — see the frame's own comment.
    void ctx.clientTerminals?.reclaimUnwatched()
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
