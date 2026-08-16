import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import {
  bindHarnessLaunch,
  agentStateProviderFor,
  declaredValue,
  harnessCapabilitiesFor,
  type LaunchFile,
  manifestFor,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import { type AgentKind, asMachineId, type Geometry, type SessionId } from '@podium/model'
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
import { runtimeContractEnabledFor, runtimeDriverByEnv, runtimeDriverFor } from '../runtime/flag'
import { grokAcpVersionProbe } from '../runtime/grok-acp-server'
import { sessionIsBehindContract } from '../runtime/handlers'
import { opencodeVersionProbe } from '../runtime/opencode-server'
import {
  availableDriverIds,
  droppedDriverPreference,
  isServerDriver,
  resolveRuntimeDriver,
  spawnNamedServerDriver,
  terminalProfileFor,
  unhonouredSpawnDriver,
} from '../runtime/registry'
import type { ReattachControl, SpawnControl } from '../session-observers'
import { removeSessionUploads } from '../session-uploads'
import type { ControlHandlers, DaemonContext } from './context'
import { sourceForRead } from './transcripts'

const log = createLogger('daemon:session')

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
const HARNESS_COMPAT_ENV: Partial<Record<AgentKind, Record<string, string>>> = {
  codex: { CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '1' },
}

/** The compatibility env for a harness ({} for kinds that need none). Pure so the
 *  floor is asserted without standing up a spawn. */
export function harnessCompatEnv(agentKind: AgentKind): Record<string, string> {
  return HARNESS_COMPAT_ENV[agentKind] ?? {}
}

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
): Record<string, string> {
  // PODIUM_SESSION_ID is a deliberate informational/identity var: the `podium`
  // CLI reads the session id from the relay URL's path, so this isn't consumed
  // by the relay path today — it's exposed for the session itself and future consumers.
  return {
    PODIUM_INSTANCE: instanceId,
    PODIUM_SESSION_INSTANCE: instanceId,
    PODIUM_SESSION_ID: sessionId,
    PODIUM_SESSION_RELAY: endpoint,
    ...(agentKind === 'shell' ? {} : { PODIUM_AGENT_RELAY: endpoint }),
  }
}

/** Merge the server-resolved session env (managed credentials, #216) under
 *  Podium's own per-session bindings. Podium's win a collision on purpose: an
 *  injected credential must never be able to shadow the agent-relay wiring.
 *  The result is an OVERLAY — the PTY layer layers it over the full process.env. */
export function spawnEnv(
  opts: {
    sessionEnv?: Record<string, string>
    harnessEnv?: Record<string, string>
    podiumEnv: Record<string, string>
  },
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const podiumCliPath = processEnv.PODIUM_CLI_PATH?.trim()
  const merged: Record<string, string> = {
    ...(opts.sessionEnv ?? {}),
    ...(opts.harnessEnv ?? {}),
    ...opts.podiumEnv,
    // The desktop owns this binding. Managed credentials and harness adapters cannot
    // redirect agents to a stale or unrelated Podium CLI. [spec:SP-d6e8]
    ...(podiumCliPath ? { PODIUM_CLI_PATH: podiumCliPath } : {}),
  }
  if (podiumCliPath) {
    // The runtime has already recovered the machine's command environment. Keep the
    // desktop-owned CLI as a distinct overlay above it, never as an input to it. [spec:SP-d6e8]
    const inherited = merged.PATH ?? processEnv.PATH ?? ''
    merged.PATH = [dirname(podiumCliPath), ...inherited.split(delimiter)]
      .filter((entry, index, entries) => entry && entries.indexOf(entry) === index)
      .join(delimiter)
  }
  return merged
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
  if (pending) session.resize(pending.cols, pending.rows)
  session.onFrame((frame) => {
    countFrame(frame.data.length)
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
export async function launchSpawn(ctx: DaemonContext, msg: SpawnControl): Promise<void> {
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
          ),
          ...browserOpenEnv(ctx.settingsDir),
          ...(ctx.homeDir ? { HOME: ctx.homeDir } : {}),
          // Subagent model rides as env — Claude Code reads it; harmless elsewhere.
          ...(msg.subagentModel ? { CLAUDE_CODE_SUBAGENT_MODEL: msg.subagentModel } : {}),
          // Globally-installed hooks are env-gated per session by their adapter.
          // Commands exit immediately when absent, so non-Podium runs are untouched.
          ...instrumentationEnv,
          // Terminal-protocol compatibility for this harness (see above).
          ...harnessCompatEnv(msg.agentKind),
        },
      }),
    }
    const session =
      ctx.backend === 'abduco'
        ? await spawnAbducoAgent(spawnOpts)
        : ctx.backend === 'tmux'
          ? await spawnTmuxAgent(spawnOpts)
          : spawnAgent(spawnOpts)
    const geometry = wireBridge(ctx, msg.sessionId, session, msg.agentKind, label, msg.geometry)
    // Stand up the agent-state tracker, harness observer, resume transcript tail
    // and seeded phase. A fresh spawn's CLI isn't up yet, so seed on the first
    // frame. Same call on reattach keeps the two paths from drifting.
    ctx.observers.initSessionObservers(msg, session, provider, {
      seedOnFrame: true,
      startedAtMs: spawnStartedAt,
      ...(newSessionId ? { newSessionId } : {}),
    })
    bindRuntimeContract(ctx, msg, false)
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
function bindRuntimeContract(
  ctx: DaemonContext,
  msg: SpawnControl | ReattachControl,
  rebind: boolean,
): void {
  if (!ctx.runtime) return
  if (!runtimeContractEnabledFor(ctx.runtimeContractEnabled, msg.runtimeContract)) return
  const profile = terminalProfileFor(msg.agentKind)
  // A shell has no turns, no transcript and no state channel — there is nothing
  // for a driver to be honest about, so the flag simply does not reach it.
  if (!profile) return
  try {
    ctx.runtime.register(
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
   * A spawn that says nothing never reaches this branch — `resolveRuntimeDriver`
   * only ever answers with a server driver when the spawn (or the machine-wide
   * default) explicitly named one AND this machine reports it available. That is
   * the whole of the "default-path sessions are byte-identical" claim on this
   * path.
   */
  if (await launchServerDriverSession(ctx, msg)) return
  await launchSpawn(ctx, msg)
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
export function serverDriverAdoptionCandidates(ctx: DaemonContext) {
  return [
    { runtime: ctx.opencodeRuntime, what: 'opencode serve' },
    { runtime: ctx.codexRuntime, what: 'codex app-server' },
    { runtime: ctx.grokRuntime, what: 'grok agent stdio' },
  ] as const
}

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
  const candidates = serverDriverAdoptionCandidates(ctx)
  const found = candidates.find(
    (candidate) => candidate.runtime?.journal.read(msg.sessionId) !== undefined,
  )
  if (!found?.runtime) return false
  const { runtime, what } = found
  const entry = runtime.journal.read(msg.sessionId)
  if (!entry) return false
  try {
    const handle = await runtime.adoptFromJournal(msg.sessionId)
    if (!handle) {
      /**
       * THE JOURNAL SAID SERVER, AND NOTHING ANSWERED. Reported as a reattach
       * FAILURE rather than fallen through to the PTY path: falling through
       * would spawn nothing, find no durable host and report the same failure
       * one layer down with a reason that names abduco — which would send the
       * next reader looking for a master that was never supposed to exist.
       */
      ctx.send({
        type: 'reattachFailed',
        sessionId: msg.sessionId,
        reason: `the ${what} session recorded in the binding journal could not be rebound`,
      })
      return true
    }
    ctx.send({
      type: 'bind',
      sessionId: msg.sessionId,
      cmd: `${what} (${handle.binding.driver})`,
      cwd: entry.workdir,
      agentKind: msg.agentKind,
      geometry: msg.geometry ?? { cols: 120, rows: 40 },
      // The same fact the launch path states, and for the same reason: W4's
      // senders branch on it, and a rebound session that reported `false` would
      // be routed to a PTY it does not have.
      runtimeContract: true,
    })
    ctx.send({ type: 'agentState', sessionId: msg.sessionId, state: await handle.state() })
    log.info('adopted a surviving server-family session', {
      sessionId: msg.sessionId,
      driver: handle.binding.driver,
    })
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

async function launchServerDriverSession(ctx: DaemonContext, msg: SpawnControl): Promise<boolean> {
  const requested = runtimeDriverFor(runtimeDriverByEnv(), msg.runtimeContract)
  if (!requested) return false
  /**
   * WHAT *THIS SPAWN* SAID, as opposed to what the machine was configured to
   * prefer. `requested` has the env default folded in and cannot tell them
   * apart; every refusal below keys on this instead, and the reason is the rule
   * this function's docstring states — a fact about the MACHINE may be papered
   * over, an instruction from THIS SPAWN may not.
   */
  const namedHere = spawnNamedServerDriver(msg.runtimeContract)
  /**
   * AN EXPLICIT REQUEST FOR A SERVER DRIVER IS NOT SILENTLY DOWNGRADED BECAUSE A
   * PROBE WAS SLOW.
   *
   * Checked BEFORE resolution, because `resolveRuntimeDriver` cannot see the
   * difference: it takes an availability LIST, and an unprobeable driver is
   * absent from that list exactly like an unsupported one. The distinction lives
   * here, where the caller's intent is still in hand.
   */
  const probe = opencodeVersionProbe()
  /**
   * CODEX IS PROBED ONLY WHEN A CODEX DRIVER IS ACTUALLY IN PLAY (POD-2024
   * review, finding 7).
   *
   * This was eager, so an explicit `opencode-server` spawn paid a `codex
   * --version` that had nothing to do with it. A DEFINITIVE verdict memoizes and
   * costs one fork per daemon — but an `unprobeable` one deliberately does NOT
   * (see that constant's own argument), so on a box where codex exists and the
   * probe keeps losing its race, every opencode spawn blocked on a 60s probe for
   * a binary it never asked about. The 26s measurement recorded in this very
   * file is what makes that reachable rather than theoretical.
   *
   * Lazy and memoized locally, because two call sites below want the same
   * answer and neither should pay for it if the other never asks.
   */
  let codexVerdict: ReturnType<typeof codexAppServerVersionProbe> | undefined
  const codexProbe = (): ReturnType<typeof codexAppServerVersionProbe> =>
    (codexVerdict ??= codexAppServerVersionProbe())
  let grokVerdict: ReturnType<typeof grokAcpVersionProbe> | undefined
  const grokProbe = (): ReturnType<typeof grokAcpVersionProbe> =>
    (grokVerdict ??= grokAcpVersionProbe())
  /**
   * THE PROBE THAT MATTERS IS THE ONE FOR THE DRIVER THAT WAS ASKED FOR.
   *
   * W6 added a second server driver with its own binary and its own probe, and
   * consulting only opencode's here would reintroduce the exact failure this
   * check exists to prevent — one driver's healthy probe vouching for another
   * driver's binary. A request for `codex-app-server` on a box whose codex did
   * not answer would sail past this refusal, then vanish from `available` below,
   * and come back as a terminal session: the deliberate request silently
   * converted into a different kind of session because a box was busy.
   *
   * WHICH PROBE and MAY I REFUSE READ DIFFERENT INPUTS, deliberately (POD-2113).
   * The subject above is probe SELECTION, and `requested` is right for it: every
   * caller of `probeFor` wants the probe belonging to the driver id in hand,
   * whatever named it. The REFUSAL below keys on `namedHere`, because a probe
   * that could not answer is a fact about this machine and only a per-spawn
   * instruction outranks it.
   */
  const probeFor = (
    driverId: string,
  ):
    | ReturnType<typeof codexAppServerVersionProbe>
    | ReturnType<typeof grokAcpVersionProbe>
    | typeof probe => {
    return driverId === 'codex-app-server'
      ? codexProbe()
      : driverId === 'grok-acp'
        ? grokProbe()
        : probe
  }
  const requestedProbe = probeFor(requested)
  /**
   * REFUSED ONLY WHEN *THIS SPAWN* NAMED THE DRIVER — the fix to a defect this
   * very check used to have (POD-2113, found by review).
   *
   * It read `isServerDriverId(requested)`, so a machine-wide
   * `PODIUM_RUNTIME_DRIVER` triggered it too. `ok` is false on ENOENT as well as
   * on a timeout and an `unprobeable` verdict is deliberately NOT memoized, so
   * on a daemon whose PATH lacks the binary — installed under `~/.opencode/bin`
   * while the daemon starts from a systemd unit, which is the normal case — one
   * env var refused EVERY spawn of EVERY harness, permanently, at one process
   * fork per spawn. That is precisely "a stale env var kills every spawn on the
   * box", the outcome this whole function argues must never happen, and it was
   * the docstring three lines up that was telling the truth while the code was
   * not. W6's second driver doubled the ways in without changing the shape.
   *
   * `namedHere === requested` whenever this fires (the per-spawn field wins in
   * `runtimeDriverFor`), so `requestedProbe` is this driver's own probe.
   */
  if (
    namedHere !== undefined &&
    !requestedProbe.drivable &&
    requestedProbe.reason === 'unprobeable'
  ) {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: `${requestedProbe.diagnostic.title}: ${requestedProbe.diagnostic.body}`,
    })
    return true
  }
  const resolution = resolveRuntimeDriver({
    agentKind: msg.agentKind,
    requested: msg.runtimeContract,
    machineDefault: runtimeDriverByEnv(),
    // The gate's own verdict, memoized for the daemon's life — a machine whose
    // opencode is missing or out of the pinned range does not list the driver,
    // so an explicit preference for it falls through rather than producing a
    // session that cannot start.
    available: availableDriverIds({
      grokDrivable: isServerDriver(msg.agentKind, 'grok-acp')
        ? grokProbe().drivable
        : false,
      opencodeDrivable: probe.drivable,
      // The SAME three-answer verdict, asked the same way. An UNSUPPORTED codex
      // legitimately drops out of this list and degrades; an UNPROBEABLE one
      // never reaches here, because the check above already refused it.
      // …and asked at all only when this harness DECLARES a server driver. One
      // that declares none can never resolve to `codex-app-server`, so probing
      // for it would be paying for an answer that cannot change the outcome.
      codexDrivable: manifestFor(msg.agentKind)?.runtime.server ? codexProbe().drivable : false,
    }),
    platform: process.platform,
  })
  if (!resolution.ok) {
    ctx.send({ type: 'spawnError', sessionId: msg.sessionId, message: resolution.reason })
    return true
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
    const unhonouredProbe = probeFor(unhonoured)
    const why = unhonouredProbe.drivable
      ? `harness '${msg.agentKind}' does not declare it (this spawn resolved to '${resolution.driverId}')`
      : `${unhonouredProbe.diagnostic.title}: ${unhonouredProbe.diagnostic.body}`
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: `this spawn asked for runtime driver '${unhonoured}' and it cannot be honoured here — ${why}`,
    })
    return true
  }
  if (!isServerDriver(msg.agentKind, resolution.driverId)) {
    /**
     * THE DEGRADE THAT SURVIVES, SAID OUT LOUD.
     *
     * A machine-wide `PODIUM_RUNTIME_DRIVER` naming a server driver this box
     * cannot run still degrades — deliberately, so one stale env var cannot kill
     * every spawn on the machine — and until this line it did so with no trace
     * anywhere. An operator who set the variable, watched every session come up
     * terminal, and went looking had nothing to find: no error, no warning, and
     * no driver id on any read surface.
     *
     * A log line is not a read surface and does not pretend to be one; it is the
     * one place a degrade can be recorded without a protocol change, and it
     * names the machine's own reason so the next step is obvious.
     */
    // Only for a SERVER-family preference that was dropped. A terminal id
    // resolving to its sibling is not a degrade, and `true` names no driver at
    // all — warning on either would train an operator to ignore the line that
    // matters. Per-spawn server ids never reach here; they were refused above,
    // so what remains is the machine-wide default, which is exactly the value
    // that must degrade rather than refuse. The guard is a function so a test
    // can pin it — this line is the degrade's only trace anywhere.
    const dropped = droppedDriverPreference({
      preference: requested,
      resolved: resolution.driverId,
    })
    if (dropped !== undefined) {
      // `probeFor(dropped)` for the same reason the refusal above uses it: the
      // only record this degrade leaves must name the binary it is about.
      const droppedProbe = probeFor(dropped)
      log.warn('a machine-wide runtime driver preference was not honoured', {
        sessionId: msg.sessionId,
        preferred: dropped,
        resolved: resolution.driverId,
        agentKind: msg.agentKind,
        reason: droppedProbe.drivable
          ? 'the harness does not declare it'
          : droppedProbe.diagnostic.title,
      })
    }
    return false
  }
  /**
   * WHICH REGISTRY, chosen by the DRIVER the resolution picked rather than by
   * the harness name (POD-1761 W6). The two are not the same question: a
   * harness can declare a server driver this build does not wire, and picking
   * by harness would hand the session to whichever registry happened to be
   * first.
   */
  const runtime =
    resolution.driverId === 'codex-app-server'
      ? ctx.codexRuntime
      : resolution.driverId === 'grok-acp'
        ? ctx.grokRuntime
        : ctx.opencodeRuntime
  if (!runtime) {
    ctx.send({
      type: 'spawnError',
      sessionId: msg.sessionId,
      message: `driver '${resolution.driverId}' is not wired on this daemon`,
    })
    return true
  }
  try {
    await runtime.launch({
      sessionId: msg.sessionId,
      cwd: msg.cwd,
      ...(msg.model ? { model: msg.model } : {}),
      ...(msg.effort ? { effort: msg.effort } : {}),
      ...(msg.env ? { env: msg.env } : {}),
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
    })
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
  return true
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
    bindRuntimeContract(ctx, msg, true)
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
      socketPath = abducoSocketPath(msg.durableLabel)
      if (socketPath === undefined) {
        try {
          socketPath = await waitForAbducoSocket(msg.durableLabel, process.env, { timeoutMs: 1500 })
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
    bindRuntimeContract(ctx, msg, true)
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
): void {
  const session = ctx.bridges.get(msg.sessionId)
  ctx.observers.clearSession(msg.sessionId)
  ctx.runtime?.clear(msg.sessionId)
  ctx.pendingResizes.delete(msg.sessionId)
  if (session) {
    session.dispose()
    ctx.bridges.delete(msg.sessionId)
    ctx.outputScheduler.remove(msg.sessionId)
  }
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
        stopSessionProcess(ctx, msg)
      })
      .catch((err) => {
        log.warn('could not retire the binding', { err, sessionId: msg.sessionId })
        stopSessionProcess(ctx, msg)
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
    ctx.bridges.get(msg.sessionId)?.write(msg.data)
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
    else ctx.pendingResizes.set(msg.sessionId, { cols: msg.cols, rows: msg.rows })
    ctx.composerEngine.onResize(msg.sessionId, msg.cols, msg.rows)
  },
  draftTarget: (ctx, msg) => {
    // A chat-originated draft to mirror into the native composer (POD-859 phase 4).
    ctx.composerEngine.setTarget(msg.sessionId, msg.text)
  },
  redraw: (ctx, msg) => {
    ctx.bridges.get(msg.sessionId)?.redraw()
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
     * Not a subscription to the attachment's own stream, which does not exist
     * yet (POD-2108) — but the session is what a user opens and closes, and it
     * is the signal that keeps a 30-minute idle TTL from behaving as a lifetime.
     */
    ctx.clientTerminals?.viewers(msg.sessionId, msg.priority < 3)
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
