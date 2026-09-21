import { legacyRollbackRefusal } from '@podium/runtime/legacy-daemon-update'
import { createRecoveryReadiness } from './recovery-readiness'
import type { BindingConfirmations } from '@podium/protocol'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createOpencode2Client, DriverRefusalError } from '@podium/harness/driver/host'
import {
  type ClaudeEngineJournalEntry,
  type CodexJournalEntry,
  claudeEngineFacts,
  codexEngineFacts,
  codexHarnessKind,
  createClaudeEngineHost,
  createCodexEngineHost,
  createCodexSessionRuntime,
  createGrokEngineHost,
  createGrokSessionRuntime,
  createOpencodeEngineHost,
  createOpencodeSessionRuntime,
  createClaudeSdkSessionRuntime,
  claudeSdkHarnessKind,
  type ServerSessionFramePorts,
  type GrokAcpJournalEntry,
  grokEngineFacts,
  grokHarnessKind,
  type OpencodeJournalEntry,
  opencode2Flavor,
  opencodeFlavor,
  opencodeHarnessKind,
} from '@podium/harness/driver/host'
import {
  agentLaunchCommand,
  type AgentManifest,
  buildMachineInventory,
  buildResolvedInventory,
  declaredValue,
  type HarnessEnvironment,
  harnessDetectLogin,
  harnessLoginReadEnv,
  manifestFor,
  resolvedHarnessPath,
} from '@podium/harness'
import { createLogger, resolveLevel, setNamespaceFloor } from '@podium/logger'
import { asMachineId, asSessionId, asUserId, type AgentKind, type MachineId, type SessionId } from '@podium/model'
import { createDurableProcess, durableProcessFor, sweepStaleDurableBindTemps } from '@podium/process/durable'
import { SessionRegistry } from './session/registry.js'
import { createSessionEngineScope } from './session/engines.js'
import type { DaemonPtyInputMetadata, DaemonPtyOutputBatch, PeerBuild } from '@podium/protocol'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import {
  loadConfig,
  resolveAgentHomeDir,
  resolveAgentRelayPort,
  resolveHookPort,
  resolveProfileOnStall,
  resolveProfileStallMs,
  stateDir,
} from '@podium/runtime/config'
import { durableSessionLabel } from '@podium/runtime/instance'
import { installDaemonLogForwarding } from '@podium/runtime/log-forward'
import {
  addLoopAccounting,
  type LoopAccountingHandle,
  startLoopAccounting,
} from '@podium/runtime/loop-accounting'
import { createLoopMinuteSink, type LoopMinuteFileSink } from '@podium/runtime/loop-minute-sink'
import { atLeast, loopProfileLevel, reportLoopProfileWarning } from '@podium/runtime/loop-profile'
import {
  createProfileCapture,
  type LoopProfileCapture,
  takeProfileRequest,
} from '@podium/runtime/loop-profile-capture'
import {
  SUPERVISOR_MACHINE_ID_ENV,
  SUPERVISOR_MACHINE_TOKEN_ENV,
  SUPERVISOR_UPDATE_PUBKEY_ENV,
} from '@podium/runtime/machine-supervisor'
import { reconcilePendingUpdate } from './reconcile-pending-update'
import { requestMachineUpdate } from '@podium/runtime/machine-update-control'
import { readAppliedMigrations } from '@podium/runtime/migration-ledger'
import { requestParentHandover, requestParentSwap } from '@podium/runtime/parent-control'
import { PARENT_HAS_SERVER_ENV } from '@podium/runtime/parent-process'
import { fetchArtifact, PODIUM_UPDATE_PUBKEY } from '@podium/runtime/update-delivery'
import type { RawData } from 'ws'
import { type ProvisionedAccountHomeSource, provisionedAccountHome } from './account-home'
import { createAgentRelayHub, startAgentRelayServer } from './agent-relay'
import { BindingStore } from './binding-store'
import { createBrowserOpenManager } from './browser-open'
import { deliveryCaps } from './build-report'
import { ComposerSyncEngine } from './composer-sync'
import { appliedGeometryFor, bindFrame } from './control/applied-geometry'
import type { DaemonContext, DurableBackend } from './control/context'
import { assertNativeHeadlessAccount } from './control/headless'
import { reportInventory, startInventoryRefresh } from './control/inventory'
import { launchSpawn, recoverTerminalHost, rememberDurableSeq, sessionRelayEnv, stopSessionProcess } from './control/session'
import { spawnEnv } from './control/session-env'
import { sourceForRead } from './control/transcripts'
import {
  createSchemaGate,
  refuseConvergence,
  releaseCarriesNewMigrations,
  restartAfterGrant,
} from './convergence'
import type { DaemonOptions } from './daemon-options'
import { createDiscoveryLoop, DEFAULT_DISCOVERY_SCAN_INTERVAL_MS } from './discovery-loop'
import { selectDurableBackend } from './durable-backend'
import { createFrameGuard, type FrameGuard } from './frame-guards'
import { createFrameSink } from './frame-sink'
import { createGrantRunner } from './grant-apply'
import { sweepHandoffStage, transcriptForExport } from './handoff-package'
import { DaemonHarnessRuntime } from './harness-runtime'
import { withHarnessVersionReporting } from './harness-version-reporting'
import type { HeadlessTurnHandle } from './headless-drivers.js'
import { startHookIngest } from './hook-ingest'
import { sampleHostLoad, sampleHostMemory } from './host-metrics'
import { loadIdentity } from './identity'
import type { DaemonInstanceBootstrap } from './instance-bootstrap'
import { dumpLoopTotals, reportLongTick, startLoopAttribution } from './loop-attribution'
import { AGENT_RELAY_ENDPOINT, describePortConflict, HOOK_INGEST_ENDPOINT } from './loopback-listen'
import { composeMailContext, composeResponders, createAckReminderInjector, createMailInjector } from './mail-injector'
import { attributeMemory, snapshotProcesses } from './memory-breakdown'
import { OutputScheduler } from './output-scheduler'
import { readPendingGrant, writePendingGrant } from './pending-grant'
import { type PortableStateControl, PortableStateFence } from './portable-state-fence'
import { createPrimeInjector, primeHookResponse } from './prime-injector'
import { makeQuotaFetcher } from '@podium/harness/inventory'
import { createReattachGates } from './reattach-gates'
import { stageRuntimeAttachment } from './runtime/attachment-staging'
import { driverTiming } from './runtime/driver-timing'
import { createMailContinuation } from './runtime/mail-boundary'
import type { DaemonClaudeSdkRuntime } from '@podium/harness/driver/host'
import type { DaemonCodexRuntime } from '@podium/harness/driver/host'
import type { DaemonGrokRuntime } from '@podium/harness/driver/host'
import {
  composeEngineEnv,
  createEngineJournal,
  daemonRuntimeHost,
  dialEngineSocket,
  engineClientTerminals,
  engineSocketRoot,
  supervisionFor,
} from './runtime/host'
import type { ClientTerminalKind } from './runtime/opencode-attach'
import { SERVER_GRACEFUL_EXIT_MS } from './runtime/server-teardown-budget'
import {
  codexAppServerVersionProbe,
  grokAcpVersionProbe,
  opencode2VersionProbeForExecutable,
  opencodeVersionProbeForExecutable,
} from './runtime/version-probe'
import { createHeadlessRuntime, type HeadlessRuntime } from './runtime/headless-driver'
import { createDaemonMachineRuntime, type DaemonMachineRuntime } from './runtime/machine-runtime'
import { createClientTerminalsFor } from './runtime/opencode-attach'
import type { DaemonOpencodeRuntime } from '@podium/harness/driver/host'
import { createScopeMonitor } from './runtime/scope-monitor'
import { beginServerDriverReap, type ServerReapIo } from './runtime/server-reap'
import { createTerminalRuntime, type TerminalRuntime } from './runtime/terminal-driver'
import { SessionBinding } from './session-binding'
import { createSessionObservers } from './session-observers'
import { terminalScreenFor, trackSessionOutput } from './session-screens'
import { sweepUploads, UPLOADS_GC_INTERVAL_MS } from './session-uploads'
import { ShippingExecutionPlane } from './shipping/executor'
import { restartAsServer, retireTargetDaemonAfterAcknowledgement } from './transfer-lifecycle'
import { swapHeadlessBundle } from './update-install'
import { DiscoveryWorkerClient } from './worker-client'
import { createCwdResolver, createSessionCwdTracker } from './worktree-resolve'

const log = createLogger('daemon:host')
/**
 * THE UPDATE PATH'S OWN NAMESPACE (POD-3224).
 *
 * `daemon:host` is the busiest namespace this process has, and the update lines
 * are the ones an operator wants forwarded to the coordinator without asking.
 * Splitting them out is what lets `daemon:update` carry an `info` floor —
 * so the phases of a delivery reach the coordinator even when the socket that
 * would have reported them is the thing the update took away — while the rest of
 * the daemon keeps the `warn`+ steady stream it has always had.
 */
const updateLog = createLogger('daemon:update')

const DEFAULT_HOST_METRICS_INTERVAL_MS = 5_000

export interface DaemonHostRuntime {
  readonly machineId: MachineId
  readonly identity: { token?: string; updatePubkey?: string }
  readonly backend: DurableBackend
  readonly frameGuard: FrameGuard
  readonly hookPort: number
  readonly hookSocketPath?: string
  readonly agentRelayPort: number
  /** Source-transfer seam: pause/drain daemon portable writers, or resume after safe abort. */
  readonly portableState: PortableStateControl
  bindingSessionIds(): Promise<readonly string[]>
  connected(
    legacyBindingOwners?: Readonly<Record<string, string>>,
    bindingConfirmations?: BindingConfirmations,
  ): { convergedVersion?: string }
  receive(raw: RawData): void
  receiveBinaryInput(metadata: DaemonPtyInputMetadata, payload: Uint8Array): void
  close(opts?: { reapSessions?: boolean }): Promise<void>
}

type CloseAgentRuntime = Pick<
  DaemonMachineRuntime,
  'registeredBindings' | 'serverHandleFor' | 'journalledServerProcess' | 'dispose'
>

/**
 * Full harness shutdown is the one daemon close mode that owns server-family
 * children too. Snapshot the bindings while the handles still exist, then let
 * the common measured reaper terminate each server family before the runtime
 * maps are disposed. Retirement is intentional: a throwaway harness session
 * must not leave its credentialed journal address behind.
 *
 * The optional I/O seam keeps the call site regression deterministic without
 * changing the production reaper, whose default measures real pids and scopes.
 */
export async function reapServerSessionsOnClose(
  ctx: DaemonContext,
  agentRuntime: Pick<DaemonMachineRuntime, 'registeredBindings'> | undefined,
  io?: ServerReapIo,
): Promise<void> {
  await Promise.all(
    (agentRuntime?.registeredBindings() ?? [])
      .filter((binding) => binding.family === 'server')
      .map((binding) => beginServerDriverReap(ctx, binding.sessionId, { retire: true }, io)),
  )
}

export async function reapServerSessionsBeforeDispose(
  ctx: DaemonContext,
  agentRuntime: Pick<DaemonMachineRuntime, 'registeredBindings'> | undefined,
  reapSessions: boolean,
  dispose: () => void,
  io?: ServerReapIo,
): Promise<void> {
  try {
    if (reapSessions) await reapServerSessionsOnClose(ctx, agentRuntime, io)
  } finally {
    // Disposal is not optional when a binding snapshot or one child reap
    // rejects. The host close path must still release the runtime maps before
    // it moves on to observers, composer state, and durable PTY reaps.
    dispose()
  }
}
/**
 * Keep the synchronous spawn gate on the exact home inventory uses.
 *
 * `credentialHome`, NOT the ambient one (POD-2692). This gate used to read the
 * right home and then let the daemon's own environment move it: `harnessDetectLogin`
 * falls back to `process.env` for a harness whose state root is selected by
 * `CODEX_HOME`/`GROK_HOME`, so an ambient selector pointed the gate at the
 * operator's harness state while the session it was gating ran under the
 * instance's. `harnessLoginReadEnv` composes the environment the CHILD gets, so
 * the gate now answers about the account that child will actually run as.
 */
function daemonHarnessLoginContext(
  homeDir: string | undefined,
  credentialHome: string,
): Pick<DaemonContext, 'homeDir' | 'harnessLoginState'> {
  return {
    homeDir,
    harnessLoginState: (agentKind) =>
      agentKind === 'shell'
        ? undefined
        : harnessDetectLogin(
            agentKind,
            credentialHome,
            harnessLoginReadEnv(agentKind, credentialHome, process.env),
          )?.state,
  }
}

/**
 * Construct the host-control runtime independently of the server connection.
 * Every handler consumes the explicit DaemonContext (including SessionBinding);
 * reconnecting swaps only the `send` port and never reconstructs host services.
 */
export async function createDaemonHostRuntime(args: {
  options: DaemonOptions
  instance: DaemonInstanceBootstrap
  build: PeerBuild
  installDir: string | undefined
  send: (message: DaemonMessage) => void
  endpointHandoff: Pick<
    DaemonContext,
    | 'probeServerTransferCandidate'
    | 'quiesceServerEndpoint'
    | 'resumeServerEndpoint'
    | 'prepareServerEndpointCommit'
    | 'activateServerEndpoint'
  >
  sendOutput: (batch: DaemonPtyOutputBatch) => void
  acknowledgeQueueDrainReport: (reportId: string) => void
  acknowledgeRuntimeEvent: (deliveryId: string) => void
  /** Test-only runtime seam for exercising the returned host close contract. */
  testAgentRuntime?: CloseAgentRuntime
  /** Test-only server-child process effects; production uses real process probes. */
  testServerReapIo?: ServerReapIo
  /**
   * Whether the server link is up RIGHT NOW (POD-3156).
   *
   * `send` above cannot answer this: it drops silently when the socket is down
   * (`connection-state.ts`), so a caller that needs to know whether a frame went
   * out has to ask separately. The log forwarder is the one caller that does —
   * it keeps the batch when the answer is no, rather than losing the window an
   * operator raised the daemon to see.
   */
  isConnected: () => boolean
  retryHandshake?: () => void
}): Promise<DaemonHostRuntime> {
  if (process.env.PODIUM_REHEARSAL === '1') throw new Error('Daemon execution disabled during upgrade rehearsal')
  const { options: opts, instance, build, installDir, send: sendUpstream, sendOutput } = args
  /**
   * THE AGENT RUNTIME CONTRACT'S TERMINAL DRIVER (POD-1761 W3), when the flag is
   * on for this daemon or for an individual session.
   *
   * Declared here, built after the context it needs, and TAPPED on the outbound
   * frame sink below — see `terminal-driver.ts`'s header for why that sink is the
   * driver's event source rather than a set of new observer callbacks.
   */
  let terminalRuntime: TerminalRuntime | undefined
  let claudeRuntime: DaemonClaudeSdkRuntime | undefined
  let opencodeRuntime: DaemonOpencodeRuntime | undefined
  let opencode2Runtime: DaemonOpencodeRuntime | undefined
  let codexRuntime: DaemonCodexRuntime | undefined
  let grokRuntime: DaemonGrokRuntime | undefined
  let headlessRuntime: HeadlessRuntime | undefined
  let agentRuntime: DaemonMachineRuntime | undefined
  /**
   * The context, once it exists, for the frame sink below. Declared here for the
   * same reason the four runtimes above are: `send` is built before the context
   * its own consumers need, and the assignment that closes the cycle is at the
   * bottom of the wiring, beside `ctx.agentRuntime`.
   *
   * THE SINK FAILS OPEN ACROSS THAT WINDOW — a frame sent before this is assigned
   * goes upstream untapped rather than throwing. That is safe today because the
   * only `await` in between is `buildMachineInventory` and no session is bound
   * yet, but it is safe by ARRANGEMENT, not by construction: anything that binds
   * or adopts a session above the assignment would silently lose the native-attach
   * re-arm for it. Keep the assignment as early as the wiring allows.
   */
   let context: DaemonContext | undefined
  /**
   * Every outbound daemon frame, past both observation taps.
   *
   * THE SINK ITSELF LIVES IN `frame-sink.ts`, with its own test, because the taps
   * it applies are load-bearing and an anonymous closure here was reachable only
   * by booting the daemon — see that file's header. The properties it keeps are
   * stated there: it must not recurse on the driver's own `runtimeEvent` output,
   * and it must cost nothing when nothing is listening.
   *
   * The ports are read PER FRAME rather than captured, because the runtime and
   * the context are both built below this line.
   */
  let inventoryReported = () => {}
  const send = createFrameSink({
    upstream: (frame) => {
      sendUpstream(frame)
      if (frame.type === 'inventoryReport') inventoryReported()
    },
    runtime: () => agentRuntime,
    context: () => context,
  })
  const config = loadConfig()
  const launch = opts.launch ?? agentLaunchCommand
  const { backend, available: durableAvailable } = selectDurableBackend(opts)
  const durable = backend === 'none' ? undefined : createDurableProcess(backend, durableAvailable)
  /**
   * THE SERVER-FAMILY ENGINE DURABLE (POD-4433; added additively for the 2.1
   * lifecycle lane inheriting this file). Engines are never terminal sessions,
   * so they never follow the terminal `--backend`: this object always carries
   * the host adapter, which is what pty-less `spawnHeadless` needs. It reuses
   * the boot probe (`durableAvailable.host`) rather than probing again, and it
   * exists even on `backend=none` so server drivers keep working wherever
   * podium-host builds; where no host can be built their launch refuses loudly
   * instead of forking a child no restart could re-adopt.
   */
  const engineDurable = createDurableProcess('host', {
    host: durableAvailable.host,
    abduco: false,
  })
  const identityStateDir = opts.identityDir ?? stateDir()
  const handedMachineId = process.env[SUPERVISOR_MACHINE_ID_ENV]
  const identity = handedMachineId
    ? {
        machineId: asMachineId(handedMachineId),
        ...(process.env[SUPERVISOR_MACHINE_TOKEN_ENV]
          ? { token: process.env[SUPERVISOR_MACHINE_TOKEN_ENV] }
          : {}),
        ...(process.env[SUPERVISOR_UPDATE_PUBKEY_ENV]
          ? { updatePubkey: process.env[SUPERVISOR_UPDATE_PUBKEY_ENV] }
          : {}),
      }
    : loadIdentity({ dir: identityStateDir })
  const machineId = opts.machineId ?? identity.machineId
  const portableStateFence = new PortableStateFence()
  const shipping = new ShippingExecutionPlane(join(instance.runtimeDir, 'shipping'), machineId)
  opts.localLink?.attachPortableState?.(portableStateFence)
  await mkdir(instance.runtimeDir, { recursive: true })
  const bindingStore = await BindingStore.open({
    dir: join(instance.runtimeDir, 'session-bindings'),
  })
  const sessionBinding = new SessionBinding(bindingStore)
  const homeDir = opts.discovery?.homeDir ?? resolveAgentHomeDir(config)
  const configuredAccountHome = process.env.PODIUM_AGENT_HOME || config.agentHome
  const namedInstanceAccountHome =
    instance.instanceId !== 'default' ? resolveAgentHomeDir(config) : undefined
  const accountHomePath =
    configuredAccountHome ?? namedInstanceAccountHome ?? opts.discovery?.homeDir
  const accountHomeSource: ProvisionedAccountHomeSource | undefined = configuredAccountHome
    ? 'configured'
    : namedInstanceAccountHome
      ? 'named-instance'
      : opts.discovery?.homeDir
        ? 'test-override'
        : undefined
  if (accountHomePath) await mkdir(accountHomePath, { recursive: true, mode: 0o700 })
  const accountHome =
    accountHomePath && accountHomeSource
      ? provisionedAccountHome({
          path: accountHomePath,
          source: accountHomeSource,
          ambientHome: process.env.HOME || homedir(),
        })
      : undefined
  const machineHome = opts.discovery?.homeDir ?? process.env.HOME ?? homedir()
  /**
   * ONE HOME FOR EVERY LOGIN ANSWER (POD-2692). Named once here and handed to
   * both the inventory probe and the synchronous spawn gate below, so the two
   * cannot drift apart the way they did when each derived its own.
   */
  const credentialHome = accountHome?.path ?? homeDir ?? machineHome
  const harnessRuntime = opts.launch
    ? undefined
    : new DaemonHarnessRuntime({ machineHome, credentialHome })
  const replayPendingBindingReceipts = async (): Promise<number> => {
    let replayed = 0
    for (const owner of await bindingStore.ownersWithPendingReceipts()) {
      replayed += await bindingStore.replayPendingReceiptsForOwner(owner, send)
    }
    return replayed
  }

  // Entries start unlabelled; spawn/reattach/steal label them from the
  // authoritative frame. Nothing here mints a default (POD-4434).
  const sessions = new SessionRegistry()
  const composerEngine = new ComposerSyncEngine(
    (sessionId, text) => {
      if (terminalRuntime?.has(sessionId)) terminalRuntime.observeDraft(sessionId, text)
      else send({ type: 'nativeDraft', sessionId, text })
    },
    {
      writePty: (sessionId, bytes) => {
        const terminal = sessions.get(sessionId)?.terminal
        if (terminal?.kind === 'headed') terminal.writeBase64(Buffer.from(bytes, 'utf8').toString('base64'))
      },
      onDemote: (sessionId) => log.warn('draft-sync self-demoted to read-only', { sessionId }),
    },
  )

  const workerClient = opts.workerClient ?? new DiscoveryWorkerClient()
  // What this process measures about its own loop, at the level the parent
  // stated (loop profile levels design §3). The warning goes out at ANY level:
  // it says the environment asked for something this build does not accept.
  reportLoopProfileWarning(log)
  let loopAccounting: LoopAccountingHandle | undefined
  let stopLoopAttribution: (() => void) | undefined
  let dropLoopAccounting: (() => void) | undefined
  let loopMinuteSink: LoopMinuteFileSink | undefined
  let loopProfileCapture: LoopProfileCapture | undefined
  /** THE daemon's SIGUSR2 listener, held so `close` can remove it. */
  let onDumpSignal: (() => void) | undefined
  const perfDir = join(identityStateDir, 'perf')
  if (atLeast('accounting')) {
    loopMinuteSink = createLoopMinuteSink({
      dir: perfDir,
      component: 'daemon',
    })
    // CPU profiles are an `attribution` artifact (spec §8): below it nothing is
    // constructed, the sampler is never armed and its keep-clear timer never
    // exists. The daemon runs the SAME capture module as the server — a stall
    // here blocks session I/O for every agent on the machine, so it needs the
    // instrument at least as much.
    const capture = atLeast('attribution')
      ? createProfileCapture({
          component: 'daemon',
          level: loopProfileLevel,
          dir: perfDir,
          onKeepClearCost: (ms) => loopAccounting?.noteProfilerCost(ms),
        })
      : undefined
    loopProfileCapture = capture
    const profileStallMs = resolveProfileStallMs()
    // POD-3834: off unless this install asked for it — see the server's copy.
    const profileOnStall = resolveProfileOnStall(config)
    /** Arm a capture, and record it in the minute when the limiter refuses. */
    const requestProfile = (
      trigger: 'stall' | 'signal',
      seconds: number,
      context?: { stallMs?: number },
    ): void => {
      if (!capture) return
      void capture
        .request(trigger, seconds, {
          ...(context?.stallMs === undefined ? {} : { stallMs: context.stallMs }),
          ...(loopAccounting?.latestMinute() ? { minute: loopAccounting.latestMinute() } : {}),
        })
        .then((result) => {
          if (result.suppressed) {
            // `level` cannot happen here and `unavailable` is a property of the
            // runtime, not of this minute — only contention is worth counting.
            if (result.reason === 'running' || result.reason === 'rate-limited') {
              loopAccounting?.noteProfileSuppressed()
            }
            return
          }
          log.warn('loop profile captured', {
            path: result.path,
            trigger,
            seconds,
            traceCount: result.traceCount,
            bytes: result.bytes,
          })
        })
        .catch((err: unknown) => {
          log.warn('loop profile capture failed', {
            trigger,
            reason: err instanceof Error ? err.message : String(err),
          })
        })
    }
    loopAccounting = startLoopAccounting({
      component: 'daemon',
      level: loopProfileLevel,
      sink: loopMinuteSink,
      // The per-stall record is an ATTRIBUTION-level artifact: at `accounting`
      // the minute record already carries the stall counts and percentiles, and
      // the activity mix this reporter names is not being collected anyway.
      ...(atLeast('attribution')
        ? {
            onLongTick: (stall) => {
              reportLongTick(stall.durationMs, stall.classification, stall.utilizationPct)
              // Armed AFTER the stall, on the premise that stalls recur in
              // bursts, so the next one lands inside the window (spec §8).
              if (profileOnStall && stall.durationMs >= profileStallMs) {
                requestProfile('stall', 10, { stallMs: stall.durationMs })
              }
            },
          }
        : {}),
    })
    // THE daemon's SIGUSR2 — one listener for the whole process, held in a
    // local so `close` can take it off again.
    //
    // Both halves of the dump hang off this one registration: the profile
    // capture here, and the attribution totals POD-3817 adds beside it. A
    // second `process.on('SIGUSR2')` would not replace this one, it would run
    // alongside it, and the reader would have no way to tell which dump they
    // were looking at — so anything new goes INSIDE this callback.
    //
    // Removing it on close matters because a daemon can be started and stopped
    // repeatedly in one process (every integration test does): listeners would
    // otherwise accumulate past Node's warning threshold, and a signal after
    // close would call `requestProfile` on a capture that has already been
    // stopped. `podium perf profile daemon` leaves the duration in the request
    // file; a signal sent by hand gets 10 s.
    if (atLeast('attribution')) {
      onDumpSignal = () => {
        // The attribution totals go FIRST because they are synchronous: they are
        // in the journal the moment the signal lands, where the profile file
        // arrives a whole window later. A reader correlating the two should pair
        // them by the profile envelope's `startedAt`, not by adjacency.
        dumpLoopTotals()
        return requestProfile('signal', takeProfileRequest(perfDir))
      }
      process.on('SIGUSR2', onDumpSignal)
    }
    // POD-600's loop-stall classifier stays in loop-attribution.ts; boot merely
    // turns it on. Moving connection code must never absorb this instrumentation.
    if (atLeast('attribution')) {
      // The seams reach the accounting through a module-level registry, so
      // register here, BEFORE `startLoopAttribution` patches the schedulers and
      // before any subsystem schedules work — otherwise the daemon's first costs
      // are recorded under a name and billed to no bucket. REGISTERED, not
      // assigned: `all-in-one` hosts the server in this same PID and registers
      // its own handle, and both describe the one loop they share.
      dropLoopAccounting = addLoopAccounting(loopAccounting)
      stopLoopAttribution = startLoopAttribution()
    }
  }
  const discoveryLoop = createDiscoveryLoop({
    workerClient,
    send,
    homeDir,
    cachePath: opts.discovery?.cachePath,
    background: opts.discovery?.background ?? true,
    intervalMs: opts.discovery?.scanIntervalMs ?? DEFAULT_DISCOVERY_SCAN_INTERVAL_MS,
  })
  const sessionCwdTracker = createSessionCwdTracker({
    resolver: createCwdResolver(),
    send: ({ sessionId, cwd, kind, branch, repoRoot, explicit }) =>
      send({
        type: 'sessionCwd',
        sessionId,
        cwd,
        kind,
        ...(branch ? { branch } : {}),
        ...(repoRoot ? { repoRoot } : {}),
        ...(explicit ? { explicit: true } : {}),
      }),
  })
  const gates = createReattachGates()
  // A native Claude login emits a terminal success line before its credential
  // store is necessarily observable by any portable file detector. Keep the
  // observer callback cheap and install the inventory reprobe once `ctx` exists.
  let requestAuthRefresh: (sessionId: SessionId) => void = () => {}
  // Late-bound: `ctx` is assembled below, but observer setup (spawn/reattach)
  // always runs after it. The session's one TerminalScreen model is created on
  // first use here, so production observers never construct a second emulator.
  let daemonCtx: DaemonContext | undefined
  const observers = createSessionObservers({
    sessionBinding,
    send,
    homeDir,
    transcriptRoot: join(identityStateDir, 'transcripts'),
    onTranscriptDirty: (path) => discoveryLoop.markConversationDirty(path),
    cwdTracker: sessionCwdTracker,
    onIdleState: (sessionId, idle) => composerEngine.setIdle(sessionId, idle),
    onState: (observation) => terminalRuntime?.observeState(observation),
    onAuthSignal: (sessionId) => requestAuthRefresh(sessionId),
    sharedScreenFor: (sessionId) =>
      daemonCtx ? terminalScreenFor(daemonCtx, sessionId).model : undefined,
    onExactCodexBinding: async (sessionId, nativeId) => {
      await sessionBinding.transition({
        event: 'hook-repin',
        transitionId: `repin:process:codex-thread:${nativeId}`,
        sessionId,
        evidenceSource: 'process-ownership-receipt',
        value: nativeId,
        nativeKind: 'codex-thread',
        observedAt: new Date().toISOString(),
        pendingServerAck: { nativeKind: 'codex-thread', value: nativeId },
      })
      if (!(await bindingStore.recordPendingCodexReceipt(sessionId, nativeId, 'process'))) {
        throw new Error(`Codex receipt ${sessionId} has no owned binding`)
      }
      await bindingStore.replayPendingReceiptForSession(sessionId, send)
    },
    tailSeedGate: gates.tailSeedGate,
  })

  const agentRelayHub = createAgentRelayHub(send)
  const browserOpen = createBrowserOpenManager(send, {
    classify: (sessionId, url) => {
      const manifest = observers.adapterFor(sessionId)
      const classify = manifest && declaredValue(manifest.classifyBrowserOpen)
      return classify?.(url)
    },
  })
  const primeSource = (sessionId: SessionId) =>
    agentRelayHub.relay({
      sessionId,
      router: 'issues',
      proc: 'prime',
      input: {},
    })
  const primeInjector = createPrimeInjector(primeSource)
  const mailInjector = createMailInjector((sessionId) =>
    agentRelayHub.relay({
      sessionId,
      router: 'issues',
      proc: 'mailPending',
      input: {},
    }),
  )
  const ackReminder = createAckReminderInjector((sessionId) =>
    agentRelayHub.relay({
      sessionId,
      router: 'messages',
      proc: 'pendingReminders',
      input: {},
    }),
  )
  const mailContext = composeMailContext(mailInjector, ackReminder)
  const respondTo = composeResponders(
    (sessionId, payload, signal) => terminalRuntime?.boundaryContextFor(sessionId)
      ? Promise.resolve(null)
      : primeInjector.respondTo(sessionId, payload, signal),
    async (sessionId, payload, signal) => terminalRuntime?.respondToHook(sessionId, payload, signal) ?? null,
  )
  const ingest = await startHookIngest({
    port: opts.hooks?.port ?? resolveHookPort(config),
    ...(instance.hookSocketPath ? { socketPath: instance.hookSocketPath } : {}),
    // Driver context is a transport boundary, independent of optional legacy responders.
    boundaryContext: async (sessionId, payload, signal) => {
      const operation = terminalRuntime?.boundaryContextFor(sessionId)
      return operation ? primeHookResponse(operation, payload, signal) : null
    },
    respondTo,
    beforeAck: async (sessionId, payload) => {
      const fields = payload && typeof payload === 'object'
        ? payload as Record<string, unknown> : undefined
      const nativeId = fields?.session_id ?? fields?.sessionId
      if (typeof nativeId !== 'string' || nativeId.length === 0) return
      const binding = await bindingStore.read(sessionId)
      if (!binding) throw new Error(`Native receipt ${sessionId} has no owned binding`)
      const nativeKind = manifestFor(binding.agentKind)?.resumeKind
      if (!nativeKind) return
      if (!(await bindingStore.recordPendingNativeReceipt(
        sessionId, { kind: nativeKind, value: nativeId }, 'native-hook',
      ))) throw new Error(`Native receipt ${sessionId} has no owned binding`)
      await bindingStore.replayPendingReceiptForSession(sessionId, send)
    },
    onPayload: (sessionId, payload) => {
      // THE DRIVER SEES THE RAW HOOK FIRST. A `UserPromptSubmit` is the causal
      // accept a terminal receipt anchors to, and waiting for it to become a
      // delivered, acked, fenced observation would report `unverified` for sends
      // the harness had already taken (POD-1761 W3). No-op when unflagged.
      agentRuntime?.onHookPayload(sessionId, payload)
      observers.onHookPayload(sessionId, payload)
    },
  })

  const agentRelay = await startAgentRelayServer({
    port: opts.agentRelay?.port ?? resolveAgentRelayPort(config),
    openUrl: (sessionId, url) => browserOpen.capture(sessionId, url),
    relay: async (request) => {
      if (request.router === 'session' && request.proc === 'setWorktree') {
        const path = (request.input as { path?: unknown } | null | undefined)?.path
        if (typeof path !== 'string' || !path.startsWith('/')) {
          return {
            ok: false,
            error: 'path must be an absolute directory path',
          }
        }
        const found = await stat(path).catch(() => null)
        if (!found?.isDirectory()) return { ok: false, error: `no such directory: ${path}` }
        const worktree = await sessionCwdTracker.setExplicit(request.sessionId, path)
        return { ok: true, result: { worktree } }
      }
      return agentRelayHub.relay(request)
    },
  })
  /**
   * A stable agent-facing port was taken, so the endpoint moved (POD-1229).
   *
   * Collected rather than sent, because nothing is connected yet at this point
   * in boot and `send` would drop it on the floor — which is the whole failure
   * being fixed here. `connected()` replays them, so a reconnect re-asserts a
   * condition that is still true, and the server's per-code dedup makes that
   * idempotent.
   */
  const portConflicts = [
    ...(ingest.portConflict
      ? [describePortConflict(HOOK_INGEST_ENDPOINT, ingest.portConflict, instance.instanceId)]
      : []),
    ...(agentRelay.portConflict
      ? [describePortConflict(AGENT_RELAY_ENDPOINT, agentRelay.portConflict, instance.instanceId)]
      : []),
  ]
  for (const diagnostic of portConflicts) {
    // Two audiences, deliberately. This line is for whoever is watching the
    // daemon's journal; the diagnostic below is for the person who only ever
    // sees the app and would otherwise be told their machine is offline.
    log.error(diagnostic.title, { code: diagnostic.code, detail: diagnostic.body })
  }

  const outputScheduler = new OutputScheduler({ flush: sendOutput })

  const parentHasServer =
    process.env.PODIUM_UNDER_PARENT === '1' && process.env[PARENT_HAS_SERVER_ENV] === '1'



  /**
   * Read ONCE, at boot, because it is a fact about how this process was started
   * and cannot change while it runs — and because the operator deserves to see
   * it in the log of the terminal they are watching, not only in the browser.
   */
  const convergenceRefusal = refuseConvergence({
    exitStopsServer: opts.exitStopsServer ?? false,
    env: process.env,
  })
  if (convergenceRefusal) {
    log.warn(
      'this daemon shares its process with the podium server and nothing would restart it — ' +
        'updates will be refused here; stop podium and start it again to pick one up, or run ' +
        '`podium setup` to install it as a service that can update itself',
    )
  }

  /**
   * The OTHER refusal, and the one that has to be asked per target (POD-2213):
   * would the build we are about to swap in be able to open this machine's
   * database? Read fresh at every grant — this daemon outlives its own server's
   * migrations — and never at boot, where the answer would already be stale.
   */
  const schemaGate = createSchemaGate({
    readApplied: () => readAppliedMigrations(),
    currentVersion: build.appVersion ?? 'dev',
  })

  // One runner per daemon: overlapping grants are serialized here rather than
  // racing to swap the same binary.
  const grantRunner = createGrantRunner({
    currentVersion: () => build.appVersion ?? 'dev',
    caps: deliveryCaps(build),
    ...(process.env.PODIUM_UNDER_PARENT === '1'
      ? {
          installTarget: (
            target: import('@podium/protocol').UpdateTarget,
            publisherPubkey?: string,
          ) =>
            requestParentSwap({
              expectedVersion: target.version,
              target: target as unknown as Record<string, unknown>,
              ...(identity.updatePubkey ? { pinnedPubkey: identity.updatePubkey } : {}),
              ...(publisherPubkey ? { publisherPubkey } : {}),
            }),
        }
      : {}),
    fetchArtifact: (asset, trust, signal, onProgress, publisherPubkey) =>
      fetchArtifact(asset, {
        fetch: globalThis.fetch,
        // BOTH ROOTS ARE OFFERED; the TARGET picks. `pubkey` is the baked
        // release key, `pinnedPubkey` the one this daemon pinned when it paired
        // — and `trust`, stamped by the server's resolver from the channel, is
        // what decides between them. This daemon never infers it (spec §1).
        pubkey: PODIUM_UPDATE_PUBKEY,
        ...(identity.updatePubkey ? { pinnedPubkey: identity.updatePubkey } : {}),
        ...(publisherPubkey ? { publisherPubkey } : {}),
        ...(trust ? { trust } : {}),
        // Delivery decides WHEN there is news; `applyGrant` turns each one into
        // an `updateStatus` frame (POD-2101).
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
      }),
    swap: (bytes) => {
      if (!installDir) throw new Error('binary delivery requires an installed daemon')
      return swapHeadlessBundle(bytes, installDir)
    },
    legacyHealthGate: process.env.PODIUM_UNDER_PARENT !== '1',
    refuse: (target, grant) =>
      convergenceRefusal ??
      (process.env.PODIUM_UNDER_PARENT !== '1'
        ? legacyRollbackRefusal(
            readPendingGrant(instance.runtimeDir),
            target.version,
            grant.retryRollback,
            grant.grantId,
          )
        : undefined) ??
      schemaGate(target),
    releaseHadMigrations: (target) => {
      try {
        return releaseCarriesNewMigrations(target, readAppliedMigrations())
      } catch {
        // The gate immediately above already refuses an unreadable ledger.
        // Preserve unknown if the second read races with a filesystem failure.
        return undefined
      }
    },
    writePending: (pending) => writePendingGrant(instance.runtimeDir, pending),
    restart: async (expectedVersion, handover) =>
      await restartAfterGrant(expectedVersion, handover, {
        ...(opts.restartAfterUpdate ? { provided: opts.restartAfterUpdate } : {}),
        parentManaged: process.env.PODIUM_UNDER_PARENT === '1',
        requestHandover: (request) => requestParentHandover(request),
        exit: process.exit,
      }),
    /**
     * EVERY REPORT THIS MACHINE SENDS, AND WHETHER IT WENT (POD-3224, q13).
     *
     * `send` drops silently when the link is down, which is precisely what
     * happens while the coordinator is applying its own grant — so a wave that
     * "stopped hearing from a machine" and a machine that stopped reporting were
     * the same observation from the coordinator's side, and this side said
     * nothing at all. `debug`, because a download reports per progress frame;
     * the PHASE transitions are the `info` lines above.
     */
    report: (status) => {
      updateLog.debug('update status reported', {
        grantId: status.grantId,
        state: status.state,
        version: status.version,
        ...(status.percent !== undefined ? { percent: status.percent } : {}),
        ...(status.phaseDetail ? { phaseDetail: status.phaseDetail } : {}),
        ...(status.detail ? { detail: status.detail } : {}),
      })
      send(status)
    },
    // THE FLIGHT RECORDER FOR AN UPDATE (POD-3170). `send` drops when the link
    // is down, and a coordinator applying its own grant takes the link down —
    // so the phases of a lost delivery are only ever knowable from here.
    //
    // On its OWN namespace since POD-3224, so these reach the coordinator's
    // `logs/fleet/<machine>.ndjson` under the steady stream rather than only
    // under an operator's raise — which is the raise nobody thinks to make until
    // after the update they wanted to understand.
    log: (event, fields) => updateLog.info(event, fields),
    now: Date.now,
  })
  const applyUpdateGrant = (grant: Extract<ControlMessage, { type: 'updateGrant' }>) => {
    if (process.env.PODIUM_MACHINE_UPDATE_OWNER === 'supervisor')
      return requestMachineUpdate(instance.runtimeDir, '/grant', grant).then(() => undefined)
    if (!parentHasServer) return grantRunner.apply(grant)
    send({
      type: 'updateStatus',
      grantId: grant.grantId,
      targetVersion: grant.target.version,
      state: 'rejected',
      version: build.appVersion ?? 'dev',
      detail:
        'duplicate update route: this all-in-one daemon is session-only; ' +
        'the parent-backed local participant owns this machine',
    })
    return Promise.resolve()
  }

  /**
   * THE FLIGHT RECORDER STARTS BEFORE THE SERVER LINK DOES (POD-3156).
   *
   * Installed here rather than in `connected()` because its entire value is
   * having been running when the thing an operator later asks about happened —
   * a recorder armed at first connect is a recorder that missed every boot
   * problem there is. `warn`+ leaves the host continuously from this point on,
   * and an `error` takes the recorder's unsent tail with it; see
   * `@podium/runtime/log-forward` (POD-3184).
   *
   * `boot` is READ, not assumed: it is whatever this process's own logging
   * composition root settled on (env, defaults, supervision mode), so a reset
   * puts the daemon back where it started rather than at a level written down
   * here that could disagree with it.
   */
  /**
   * THE UPDATE PATH IS WORTH MORE THAN THIS DAEMON'S DEFAULT (POD-3224).
   *
   * A floor rather than a level: an operator raising this daemon to `debug`
   * still gets `debug` here, which a most-specific-wins override would have
   * capped at `info` at the exact moment they were asking.
   *
   * It lifts BOTH what the journal keeps and what the steady stream forwards
   * (`log-forward.ts` reads the same floor), so a delivery's phases —
   * accepted, download deciles, verified, swapped, restarting, and what the next
   * boot concluded — reach the coordinator's `logs/fleet/<machine>.ndjson`
   * without anybody having raised this machine first. That raise is the one
   * nobody thinks to make until after the update they wanted to understand.
   *
   * Bounded by the call sites: per-frame status reports and per-chunk download
   * progress are `debug` and stay local.
   */
  setNamespaceFloor('daemon:update', 'info')
  const logForwarding = installDaemonLogForwarding({
    boot: resolveLevel('daemon'),
    /**
     * A LOCAL LINK MEANS THIS DAEMON IS THE SERVER'S OWN PROCESS (POD-3184).
     *
     * It is the same fact the boot record reports as `topology: 'local-link'`,
     * read from the same option. There the steady stream would file a second
     * copy of records this process's own file sink has already written to this
     * machine's disk, so it is off — and a raise still forwards, which is what
     * makes an all-in-one install answer a raise with its whole process.
     */
    coResident: opts.localLink !== undefined,
    // The socket DROPS rather than queues when the link is down
    // (`connection-state.ts`), so this reports whether the frame went out and
    // the sink keeps the batch when it did not.
    send: (batch) => {
      if (!args.isConnected()) return false
      send({
        type: 'daemonLogBatch',
        records: batch.records,
        ...(batch.dropped !== undefined ? { dropped: batch.dropped } : {}),
        // The BUILD that wrote these records, on the batch: a daemon can
        // self-update under a live socket, and the records either side of that
        // came out of two different programs.
        ...(build.appVersion ? { v: build.appVersion } : {}),
      })
      return true
    },
  })

  const ctx: DaemonContext = {
    send,
    acknowledgeQueueDrainReport: args.acknowledgeQueueDrainReport,
    acknowledgeRuntimeEvent: args.acknowledgeRuntimeEvent,
    logForwarding,
    machineId,
    instanceId: instance.instanceId,
    durableLabelFor: (sessionId) => durableSessionLabel(sessionId, instance.instanceId),
    sessions,
    backend,
    ...(durable ? { durable } : {}),
    launch,
    ...(harnessRuntime ? { harnessRuntime } : {}),
    settingsDir: instance.settingsDir,
    ...(accountHome ? { accountHome } : {}),
    // Inventory publishes this detector's result; selection reads the same fact
    // synchronously so a spawn racing the asynchronous inventory report cannot
    // start a headless server before a logout or Codex grace state reaches the
    // server cache.
    ...daemonHarnessLoginContext(homeDir, credentialHome),
    instanceUuid: instance.instanceUuid,
    composerEngine,
    outputScheduler,
    observers,
    sessionCwdTracker,
    primeInjector,
    reattachGate: gates.reattachGate,
    tailSeedGate: gates.tailSeedGate,
    runningHeadlessTurns: new Map<string, HeadlessTurnHandle>(),
    hookSocketPath: instance.hookSocketPath,
    bindingStore,
    sessionBinding,
    hookEndpointFor: (sessionId) => ingest.endpointFor(sessionId),
    agentRelayEndpointFor: (sessionId) => agentRelay.endpointFor(sessionId),
    agentRelayHub,
    browserOpen,
    workerClient,
    refreshAndPublishConversations: (full) => discoveryLoop.refreshAndPublishConversations(full),
    quotaFetcher: makeQuotaFetcher({ ...(homeDir ? { homeDir } : {}) }),
    usageMemo: {},
    portableStateFence,
    shipping,
    promoteMachineAssignment: opts.promoteMachineAssignment,
    restartAfterTransfer:
      opts.restartAfterTransfer ??
      (async (expected) => {
        await restartAsServer({ transferId: expected.transferId })
        return expected
      }),
    retireAfterTransfer: opts.retireAfterTransfer ?? retireTargetDaemonAfterAcknowledgement,
    ...args.endpointHandoff,
    applyUpdateGrant,
  }
  // Close the late-bound observer loop: observer setup from here on reads the
  // session's one TerminalScreen model.
  daemonCtx = ctx
  /**
   * Client terminals (POD-2059), built here and put on the CONTEXT as well as
   * into the opencode host: `sessionPriority` (the viewer signal its idle clock
   * runs on) and `reclaimAttachments` (the server's pressure order) are control
   * frames about the machine, not about a driver, and their handlers reach it
   * through `ctx`.
   *
   * ABSENT WHEN THE DAEMON HAS NO DURABLE HOST, deliberately (POD-3917). A
   * `backend=none` daemon builds no terminal host at all rather than silently
   * substituting abduco — see `createClientTerminalsFor` for the reason. The
   * drivers refuse a Native attach with their per-machine wording, and the
   * metrics below report zero reclaimable attachments.
   */
  const clientTerminals = createClientTerminalsFor(ctx.durable, {
    sessions,
    // The one applied-size record this daemon owns (POD-3290). Opening a client
    // terminal is a real apply, and this is the only wiring that lets that fact
    // reach the frames which report a grid.
    appliedGeometry: appliedGeometryFor(ctx),
    // A client terminal never becomes a bridge, so the bridge path's resume
    // point never sees it (POD-3919 audit item 7). The same function, on the
    // same map, for the same kind of session — a host connection with a ring.
    rememberDurableSeq: (sessionId, session) => rememberDurableSeq(ctx, sessionId, session),
    /**
     * WHAT SIZE TO OPEN IT AT (POD-3809). The viewer's first ask reaches a
     * server-family session before it has any terminal, so the resize handler
     * parks it in `pendingResizes`; that held request is the best answer there
     * is and it is what the client is born at. Failing that, the grid this
     * daemon last applied to the session — its own last-known W. Failing both,
     * the port answers nothing and the client host uses its default.
     *
     * PEEKED, NOT CONSUMED. The request stays held until the attach that used it
     * comes back through the native reconcile, which sees the record already at
     * that grid and retires it without a second SIGWINCH. A start that FAILS
     * therefore still leaves the request for the next attempt.
     */
    birthGeometry: (sessionId) =>
      ctx.sessions.get(sessionId)?.pendingResize ?? appliedGeometryFor(ctx).applied(sessionId),
    // One session-addressed relay for engine terminals and on-demand harness
    // client terminals. The latter intentionally returns the parent session id.
    frames: (streamId, frame) => {
      // P1b (POD-3918): headed output feeds the same headless model and 1049
      // mode as bridge output, so the reopen policy sees both paths alike.
      trackSessionOutput(ctx, asSessionId(streamId), frame)
      ctx.outputScheduler.enqueue(asSessionId(streamId), frame)
    },
    releaseStream: (streamId) => ctx.outputScheduler.remove(asSessionId(streamId)),
    // Executable discovery belongs to the machine command environment, while
    // `homeDir` below is the isolated credential home passed to the child. Keep
    // those identities separate: the resolver must find the installed CLI before
    // the child’s HOME is replaced for account isolation.
    commandEnvironment: (): Promise<HarnessEnvironment> =>
      harnessRuntime
        ? harnessRuntime.current().then((snapshot) => snapshot.commandEnvironment.env)
        : Promise.resolve(process.env),
    ...(homeDir ? { homeDir } : {}),
    instanceUuid: instance.instanceUuid,
    // The client terminal is a durable session like any other: it lives under
    // whichever host this daemon selected (SPEC-6) — the whole `ctx.durable`,
    // handed to `createClientTerminalsFor` as one object, never rebuilt here
    // per backend.
  })
  // Set only when the daemon has a durable host to build one on (POD-3917).
  if (clientTerminals) ctx.clientTerminals = clientTerminals

  /**
   * THE ONE CGROUP OBSERVER (POD-2413).
   *
   * Built before the runtimes and reading them lazily, because it is on both
   * sides of the same wiring cycle the terminal runtime documents below: every
   * driver host asks it for resource truth, and it asks the machine runtime
   * which sessions exist. Family-blind by construction — a binding carries a
   * scope unit whatever produced it, so one poller covers abduco masters,
   * app-servers and ACP children alike.
   */
  const scopeMonitor = createScopeMonitor({
    subjects: () =>
      (agentRuntime?.registeredBindings() ?? []).map((binding) => ({
        sessionId: binding.sessionId,
        ...(binding.process.scopeUnit ? { scopeUnit: binding.process.scopeUnit } : {}),
        label: binding.process.key,
        ...(binding.process.pid !== undefined ? { pid: binding.process.pid } : {}),
      })),
    // The pre-cgroup answer, kept for every session that has no scope to read:
    // macOS, an unscoped fallback spawn, or a scope systemd already collected.
    fallbackMemoryBytes: ({ sessionId, label, pid }) =>
      attributeMemory(
        snapshotProcesses(),
        [{ sessionId, label, ...(pid !== undefined ? { pid } : {}) }],
        [],
        { selfPid: process.pid },
      ).agents.find((agent) => agent.sessionId === sessionId)?.bytes,
    onOomKill: ({ sessionId, scopeUnit }) => agentRuntime?.reportOomKill(sessionId, scopeUnit),
  })
  ctx.scopeMonitor = scopeMonitor

  const stageAttachment = (input: Parameters<typeof stageRuntimeAttachment>[0]) =>
    ctx.portableStateFence.run(() => stageRuntimeAttachment(input))

  // Built AFTER the context because the driver hosts need that context. The
  // single assignment at the end closes the wiring cycle: handlers reach every
  // family through `ctx.agentRuntime`, which reaches the daemon through `ctx`.
  const contractHost = { ...daemonRuntimeHost(ctx, send, stageAttachment), boundaryContext: mailContext.pendingContext }
  terminalRuntime = createTerminalRuntime(contractHost, primeSource, ctx.sessions)
  const generationInventory = harnessRuntime ? await harnessRuntime.current() : undefined
  // Engine-family facts (POD-4494, spec §4.1/§5): this composition root reads
  // the registry ONCE per harness and hands each family exactly the sections
  // it owns — the families never fetch an adapter by name. The kinds arrive
  // as the families' own values (never literals: the vendor lint counts
  // quoted harness names outside adapters/families). Every harness-shaped
  // value below (argv stems, scope tokens, strip lists, journal namespaces)
  // is read off the adapters through these, never restated here — this file
  // stays wiring-only (1.5).
  const engineSections = (
    kind: AgentKind,
  ): Pick<AgentManifest, 'kind' | 'runtime' | 'inventory'> => {
    const manifest = manifestFor(kind)
    if (!manifest) throw new Error(`no harness adapter for '${kind}'`)
    return { kind: manifest.kind, runtime: manifest.runtime, inventory: manifest.inventory }
  }
  const codexFacts = codexEngineFacts(engineSections(codexHarnessKind))
  const grokFacts = grokEngineFacts(engineSections(grokHarnessKind))
  const claudeFacts = claudeEngineFacts(engineSections(claudeSdkHarnessKind))
  const ocFacts = opencodeFlavor(engineSections(opencodeHarnessKind))
  const oc2Facts = opencode2Flavor(engineSections(opencodeHarnessKind))
  // The engine's durable owner (POD-4433): podium-host under the hood. The
  // claude family still drives the legacy supervision port; the codex,
  // opencode and grok families drive the session layer's engine hold.
  const engineSupervision = supervisionFor(engineDurable)
  /**
   * THE SESSION LAYER'S ENGINE HOLD (this issue, spec §4.8 steps 2–6): the
   * `EngineProcessOwner` the migrated families consume, plus the journal
   * store. Bound onto the session registry so every `DaemonSession` delegate
   * routes through it. (For POD-4506: this edit touches nothing near the
   * native-client maps at ~1003-1005; their construction is unchanged.)
   */
  const sessionEngines = createSessionEngineScope(engineDurable)
  sessions.bindEngines(sessionEngines)
  const opencode2Executable = generationInventory?.commandEnvironment.resolve(oc2Facts.executableName)
  // Session-frame ports shared by the four headless families: the frame sink,
  // the one bind builder, timing stages and the mail continuation. The
  // supervisor owns the wire; the families own the translation.
  const emitBind: ServerSessionFramePorts['emitBind'] = (input) =>
    send(bindFrame(appliedGeometryFor(ctx), input))
  const sessionReady: ServerSessionFramePorts['sessionReady'] = (binding) =>
    driverTiming.sessionReady(binding)
  const traceRuntimeEvent: ServerSessionFramePorts['traceRuntimeEvent'] = (binding, event) =>
    driverTiming.runtimeEvent(binding, event)
  const startMailContinuation: ServerSessionFramePorts['startMailContinuation'] = (
    handle,
    isCurrent,
  ) =>
    createMailContinuation(
      handle,
      mailContext.pendingContext,
      isCurrent,
      (error) =>
        log.warn('issue mail boundary delivery failed', {
          sessionId: handle.binding.sessionId,
          error,
        }),
    )
  const sessionFrames = { emitBind, sessionReady, traceRuntimeEvent, startMailContinuation }
  /**
   * THE CLAUDE STREAM ENGINE (POD-4499), composed like every other engine:
   * one long-lived `claude` stream-json child per session under podium-host,
   * owned by the same supervision. The session adapter translates the
   * contract onto it; `machine-runtime` still routes claude sessions through
   * the embedded source until POD-4497 moves the routing — the family already
   * speaks the server-family shape (journal, adopt, describe) so that move
   * is mechanical.
   */
  const claudeEngine = createClaudeEngineHost({
    facts: claudeFacts,
    supervision: engineSupervision,
    journal: createEngineJournal<ClaudeEngineJournalEntry>({ namespace: claudeFacts.journalNamespace }),
    buildEnv: composeEngineEnv,
    gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
    // The instance agent home the transcript reader already resolves against
    // (control/transcripts.ts sourceForRead), so the engine child writes its
    // JSONL where sessions.read looks for it (POD-3057).
    ...(homeDir ? { homeDir } : {}),
    ...(generationInventory?.executables.has(claudeSdkHarnessKind)
      ? { executablePath: resolvedHarnessPath(generationInventory, claudeSdkHarnessKind) }
      : {}),
    instanceUuid: instance.instanceUuid,
  })
  claudeRuntime = createClaudeSdkSessionRuntime({
    send,
    ...sessionFrames,
    facts: claudeFacts,
    engine: claudeEngine,
    transcript: {
      readHistory: contractHost.readHistory,
      archiveTranscript: contractHost.archiveTranscript,
      readFileBytes: contractHost.readFileBytes,
    },
  })
  /**
   * THE SERVER-FAMILY RUNTIME (POD-1761 W5), built the same way and for the same
   * reason: its host port is this context.
   *
   * UNCONDITIONAL, and it costs nothing. Constructing it allocates two maps; a
   * session only reaches it if its spawn explicitly asked for `opencode-server`,
   * and no `opencode serve` is started until then. Gating the CONSTRUCTION on a
   * flag would mean the flag had to be read before the context existed, which is
   * how the terminal path's own wiring cycle got its comment above.
   */
  const opencodeEngine = createOpencodeEngineHost({
    flavor: ocFacts,
    engines: sessionEngines,
    supervision: sessionEngines,
    journal: sessionEngines.journalFor<OpencodeJournalEntry>(ocFacts.journalNamespace),
    resources: (subject) => scopeMonitor.resources(subject),
    stageAttachment,
    buildEnv: composeEngineEnv,
    gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
    checkVersion: ({ executable }) =>
      opencodeVersionProbeForExecutable(executable).then((verdict) =>
        verdict.drivable ? null : verdict.diagnostic,
      ),
    /**
     * `attach()`'s client terminal (POD-2059), on the frames path this daemon
     * already runs. The stream id is the key, exactly as the engine variant's
     * endpoint uses the session id — one relay, two kinds of terminal.
     *
     * ABSENT ON A backend=none DAEMON (POD-3917): there is no terminal host
     * to hand over, and the opencode host answers a Native attach with its
     * per-machine refusal instead.
     */
    ...(clientTerminals ? { clientTerminals: engineClientTerminals(clientTerminals) } : {}),
    ...(generationInventory?.executables.has(ocFacts.harnessKind)
      ? { executablePath: resolvedHarnessPath(generationInventory, ocFacts.harnessKind) }
      : {}),
    // The instance agent home: a server-driver child's HOME must be the
    // instance's, exactly as the PTY path's children get it (POD-2247).
    ...(homeDir ? { homeDir } : {}),
    instanceUuid: instance.instanceUuid,
  })
  opencodeRuntime = createOpencodeSessionRuntime({
    flavor: ocFacts,
    engine: opencodeEngine,
    send,
    ...sessionFrames,
  })
  const opencodeEngine2 = createOpencodeEngineHost({
    flavor: oc2Facts,
    engines: sessionEngines,
    supervision: sessionEngines,
    journal: sessionEngines.journalFor<OpencodeJournalEntry>(oc2Facts.journalNamespace),
    resources: (subject) => scopeMonitor.resources(subject),
    // Absent on a backend=none daemon (POD-3917): no terminal host, so the
    // opencode host refuses a Native attach with its per-machine wording.
    ...(clientTerminals ? { clientTerminals: engineClientTerminals(clientTerminals) } : {}),
    stageAttachment,
    buildEnv: composeEngineEnv,
    gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
    checkVersion: ({ executable }) =>
      opencode2VersionProbeForExecutable(executable).then((verdict) =>
        verdict.drivable ? null : verdict.diagnostic,
      ),
    ...(opencode2Executable ? { executablePath: opencode2Executable } : {}),
    ...(homeDir ? { homeDir } : {}),
    instanceUuid: instance.instanceUuid,
    // V2 migrates the stable CLI's default database to an incompatible
    // schema: isolate only the database (supervisor layout) so both still
    // read the instance's shared credentials and configuration.
    flavorEnv: { OPENCODE_DB: join(stateDir(), 'opencode2.db') },
    makeClient: createOpencode2Client,
  })
  opencode2Runtime = createOpencodeSessionRuntime({
    flavor: oc2Facts,
    engine: opencodeEngine2,
    send,
    ...sessionFrames,
  })
  /**
   * THE SECOND SERVER-FAMILY RUNTIME (POD-1761 W6), constructed on the same
   * terms and for the same reason as the first: it allocates two maps, and no
   * `codex app-server` child starts until a spawn explicitly asks for
   * `codex-app-server`.
   */
  const codexEngine = createCodexEngineHost({
    facts: codexFacts,
    engines: sessionEngines,
    supervision: sessionEngines,
    journal: sessionEngines.journalFor<CodexJournalEntry>(codexFacts.journalNamespace),
    resources: (subject) => scopeMonitor.resources(subject),
    stageAttachment,
    buildEnv: composeEngineEnv,
    gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
    checkVersion: () => codexAppServerVersionProbe(),
    socketRoot: engineSocketRoot(),
    dialSocket: dialEngineSocket,
    // Omitted outright on a backend=none daemon (POD-3917): without a
    // terminal host the codex host reports it cannot host one, rather than
    // reaching a backend this daemon never selected.
    ...(clientTerminals
      ? {
          attachClient: async ({ sessionId, threadId, clientAddress, workdir }) => {
            try {
              return await clientTerminals.attach({
                sessionId,
                // The 0600 Unix listener the stock TUI dials directly; filesystem
                // permission is the authentication, so there is no secret with it.
                // The attach kind is the family's own token, read as a value.
                target: {
                  kind: codexFacts.attachKind as ClientTerminalKind,
                  conversation: threadId,
                  endpoint: { address: clientAddress },
                  workdir,
                },
              })
            } catch (err) {
              log.warn('could not host a Codex client terminal', { err, sessionId })
              return undefined
            }
          },
          detachClient: ({ sessionId }) =>
            clientTerminals.close(sessionId, codexFacts.attachKind as ClientTerminalKind),
        }
      : {}),
    // Same instance-home rule as the opencode host above (POD-2247).
    ...(homeDir ? { homeDir } : {}),
    instanceUuid: instance.instanceUuid,
  })
  codexRuntime = createCodexSessionRuntime({
    facts: codexFacts,
    engine: codexEngine,
    send,
    ...sessionFrames,
  })
  const grokEngine = createGrokEngineHost({
    facts: grokFacts,
    engines: sessionEngines,
    supervision: sessionEngines,
    journal: sessionEngines.journalFor<GrokAcpJournalEntry>(grokFacts.journalNamespace),
    resources: (subject) => scopeMonitor.resources(subject),
    buildEnv: composeEngineEnv,
    gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
    checkVersion: () => grokAcpVersionProbe(),
    // Omitted outright on a backend=none daemon (POD-3917): same rule as the
    // codex host above — no terminal host, no attach arm.
    ...(clientTerminals
      ? {
          attachClient: async ({ sessionId, grokSessionId, workdir }) => {
            try {
              return await clientTerminals.attach({
                sessionId,
                // A stdio engine has nothing to address: the client comes back
                // through grok's own native store, so the endpoint is empty.
                // The attach kind is the family's own token, read as a value.
                target: {
                  kind: grokFacts.attachKind as ClientTerminalKind,
                  conversation: grokSessionId,
                  endpoint: {},
                  workdir,
                },
              })
            } catch (err) {
              log.warn('could not host a Grok client terminal', { err, sessionId })
              return undefined
            }
          },
        }
      : {}),
    // Same instance-home rule as the opencode host above (POD-2247).
    ...(homeDir ? { homeDir } : {}),
    instanceUuid: instance.instanceUuid,
  })
  grokRuntime = createGrokSessionRuntime({
    facts: grokFacts,
    engine: grokEngine,
    send,
    ...sessionFrames,
  })
  /**
   * THE HEADLESS RUNTIME (POD-4392): process-per-turn harness sessions behind
   * the contract. Constructed unconditionally like the server-family runtimes —
   * it allocates maps, and no harness child starts until a headless turn
   * dispatches through it. `control/headless.ts` keeps serving the legacy port
   * until the caller migration lands; this runtime is the destination it moves to.
   */
  headlessRuntime = createHeadlessRuntime({
    send,
    snapshot: () =>
      harnessRuntime
        ? harnessRuntime.current()
        : buildResolvedInventory({
            ...(ctx.homeDir ? { machineHome: ctx.homeDir } : {}),
            ...(ctx.accountHome ? { credentialHome: ctx.accountHome.path } : {}),
          }),
    durable: () => durableProcessFor(ctx),
    assertNativeAccount: (agent, accountId, inventory) =>
      assertNativeHeadlessAccount({
        agent,
        accountId,
        accountHome: ctx.accountHome,
        inventory,
      }),
    sessionEnv: ({ sessionId, agent, toolPolicyNone, snapshot }) =>
      spawnEnv({
        sessionEnv: snapshot.commandEnvironment.env,
        podiumEnv: {
          ...sessionRelayEnv(
            sessionId,
            ctx.agentRelayEndpointFor(sessionId),
            ctx.instanceId,
            agent,
            ctx.instanceUuid,
          ),
          ...(ctx.homeDir ? { HOME: ctx.homeDir } : {}),
          ...(toolPolicyNone && ctx.accountHome
            ? {
                HOME: ctx.accountHome.path,
                CLAUDE_CONFIG_DIR: join(ctx.accountHome.path, '.claude'),
              }
            : {}),
        },
      }),
    durableLabel: (sessionId) => ctx.durableLabelFor(sessionId),
    bindHeadlessSession: (sessionId, agentKind, cwd, resumeValue) =>
      ctx.observers.bindHeadlessSession(sessionId, agentKind, cwd, resumeValue),
    readHistory: async (session, range) => {
      const segmentId = `history:${session.sessionId}:${session.resume?.value ?? ''}`
      if (range.from && (range.from.segmentId !== segmentId || !range.from.pathHint)) {
        throw new DriverRefusalError(
          { reason: 'invalid_value', detail: 'foreign history cursor' },
          'transcript.history',
        )
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
    now: () => Date.now(),
  })
  agentRuntime = createDaemonMachineRuntime({
    terminal: terminalRuntime,
    claude: claudeRuntime,
    // One uniform shape per server family (1.5): the machine runtime never
    // branches on which family a session belongs to.
    servers: [opencodeRuntime, opencode2Runtime, codexRuntime, grokRuntime],
    headless: headlessRuntime,
    inventory: async () =>
      harnessRuntime
        ? (await harnessRuntime.current()).inventory
        : (await buildMachineInventory({ machineId, ...(homeDir ? { homeDir } : {}) })).inventory,
  })
  const closeAgentRuntime = args.testAgentRuntime ?? agentRuntime
  ctx.agentRuntime = closeAgentRuntime as DaemonMachineRuntime
  // Closes the cycle the `let context` declaration above describes. Nothing that
  // binds a session may move above this line — see that comment.
  context = ctx

  let pendingAuthReprobe: Promise<void> | undefined
  requestAuthRefresh = (_sessionId) => {
    if (pendingAuthReprobe) return
    pendingAuthReprobe = reportInventory(ctx, { reprobe: true }).finally(() => {
      pendingAuthReprobe = undefined
    })
  }
  const frameGuard = createFrameGuard(ctx)

  const metricsBackground = opts.metrics?.background ?? true
  const metricsIntervalMs = opts.metrics?.intervalMs ?? DEFAULT_HOST_METRICS_INTERVAL_MS
  let metricsTimer: ReturnType<typeof setInterval> | undefined
  let uploadsGcTimer: ReturnType<typeof setInterval> | undefined
  let stopInventoryRefresh: (() => void) | undefined
  let kickedOff = false
  let disposed = false
  const pushHostMetrics = (): void => {
    void reapBindings().catch((err) => log.warn('quarantined binding cleanup failed', { err }))
    const sessionsMemory = scopeMonitor.sessionsMemory()
    // This daemon's last COMPLETE minute of event-loop accounting (loop-profile
    // design §7.1). Absent at level `off` (the handle is inert), and absent for
    // the first minute after boot — the record describes a closed minute, and
    // there is no honest partial one to send. This push is every 15 s, so the
    // same minute goes out up to four times; that is the intended shape, and the
    // server dedupes by `at`. See the field's comment on `HostMetricsWire`.
    const loop = loopAccounting?.latestMinute()
    send({
      type: 'hostMetrics',
      daemonReadiness: readiness.snapshot(),
      quarantinedBindings: bindingStore.quarantinedCount,
      hostname: hostname(),
      sampledAt: new Date().toISOString(),
      memory: sampleHostMemory(),
      load: sampleHostLoad(),
      // What this machine can give back WITHOUT parking a session (spec §5).
      // Always sent, including as 0 — which the server treats exactly as an
      // absent field, since both mean "nothing here to reclaim first". A
      // backend=none daemon holds no terminal host, so it always reports 0.
      reclaimableAttachments: clientTerminals?.reclaimable() ?? 0,
      // Whose pressure it is (POD-2413). Absent on a host with no cgroups, or
      // before any session has been scoped here — the server then reads only
      // the host-wide number, exactly as it did before this existed.
      ...(sessionsMemory ? { sessionsMemory } : {}),
      ...(loop ? { loop } : {}),
    })
  }

  /**
   * Tell the server which durable labels this machine is actually running
   * (POD-1953).
   *
   * A park kill is fire-and-forget across a link that drops, and the server that
   * sent it may since have restarted, so a row can sit 'hibernated' over a live
   * agent indefinitely — nothing else in the system ever re-asks. This is the
   * re-ask, sent on every connect: one socket-index read, no `abduco` fork, so a
   * wedged master cannot turn it into a hang.
   */
  const pushDurableSessionCensus = (): void => {
    if (backend === 'none') return
    // OFF the connect path, deliberately. The scan is bounded and quick, but it
    // is still synchronous filesystem work on a directory whose size the daemon
    // does not control (7032 sockets on the box this was written on), and the
    // handshake must not be able to wait on a slow disk. Nothing downstream
    // needs it before the connect handler returns — the server repairs whatever
    // the census names, whenever it lands.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // Both hosts: a session created under abduco before the switch is
          // still a live session this machine holds.
          send({ type: 'durableSessionCensus', labels: (await durable?.list()) ?? [] })
        } catch (err) {
          log.warn('could not census the durable sessions', { err })
        }
      })()
    }, 0)
    timer.unref?.()
  }

  const readiness = createRecoveryReadiness(() => pushHostMetrics())
  inventoryReported = () => readiness.inventoryReported()
  let recoveryRetry: ReturnType<typeof setTimeout> | undefined
  const retryRecovery = (epoch: number): void => {
    if (epoch !== recoveryGeneration || disposed) return
    readiness.failed(epoch)
    if (recoveryRetry) clearTimeout(recoveryRetry)
    recoveryRetry = setTimeout(() => {
      recoveryRetry = undefined
      if (!disposed && epoch === recoveryGeneration) args.retryHandshake?.()
    }, 5_000)
    recoveryRetry.unref?.()
  }
  let recoveryGeneration = 0
  let bindingRecovery: Promise<void> | undefined
  let currentBindingFacts: BindingConfirmations | undefined
  let reapingBindings = false
  const reapBindings = async (): Promise<void> => {
    if (reapingBindings || disposed) return
    reapingBindings = true
    try {
      await bindingStore.reapQuarantined(async (id) => {
        if (
          sessions.get(id)?.terminal?.kind === 'headed' ||
          [...ctx.runningHeadlessTurns.values()].some(
            (turn) => !turn.identity || turn.identity.sessionId === id,
          )
        )
          return true
        const handle = ctx.agentRuntime?.handleFor(id)
        if (handle && (await handle.health()).alive) return true
        const journal = ctx.agentRuntime?.journalledServerProcess(id)
        if (journal) {
          if (journal.identity.pid === undefined) return true
          try {
            process.kill(journal.identity.pid, 0)
            return true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true
          }
        }
        return (await durable?.has(sessions.get(id)?.label ?? ctx.durableLabelFor(id))) ?? false
      }, instance.codexReceiptDir)
    } finally {
      reapingBindings = false
      readiness.quarantined(bindingStore.quarantinedCount)
    }
  }
  const connected = (
    _owners?: Readonly<Record<string, string>>,
    facts?: BindingConfirmations,
  ): { convergedVersion?: string } => {
    currentBindingFacts = facts
    bindingStore.confirmInventory(machineId, facts)
    if (recoveryRetry) clearTimeout(recoveryRetry)
    recoveryRetry = undefined
    const recoveryEpoch = readiness.begin(bindingStore.quarantinedCount)
    recoveryGeneration = recoveryEpoch
    if (facts !== undefined) {
      bindingRecovery = (bindingRecovery ?? Promise.resolve())
        .then(() =>
          bindingStore.recoverLegacyState({
            dir: bindingStore.dir,
            legacyStateDir: identityStateDir,
            codexReceiptDir: instance.codexReceiptDir,
            legacyDelegationForSession: (id) =>
              !bindingStore.isQuarantined(id) ? currentBindingFacts?.[id]?.delegation : undefined,
          }),
        )
        .then(async () => {
          await reapBindings()
          pushHostMetrics()
          await replayPendingBindingReceipts()
          readiness.recovered(recoveryEpoch, bindingStore.quarantinedCount)
        })
        .catch((err) => {
          retryRecovery(recoveryEpoch)
          log.error('binding recovery failed', { err })
        })
    }
    if (facts === undefined) retryRecovery(recoveryEpoch)
    startConnectedServices()
    pushHostMetrics()
    const convergedVersion = reconcilePendingUpdate({
      runtimeDir: instance.runtimeDir, appVersion: build.appVersion, env: process.env,
      parentHasServer, send, log: (message, fields) => updateLog.info(message, fields),
    })
    return convergedVersion ? { convergedVersion } : {}
  }

  const startConnectedServices = (): void => {
    if (!kickedOff) {
      kickedOff = true
      discoveryLoop.start()
      scopeMonitor.start()
      if (metricsBackground) {
        pushHostMetrics()
        metricsTimer = setInterval(pushHostMetrics, metricsIntervalMs)
        metricsTimer.unref?.()
      }
      uploadsGcTimer = setInterval(
        () => void sweepUploads(portableStateFence),
        UPLOADS_GC_INTERVAL_MS,
      )
      uploadsGcTimer.unref?.()
      stopInventoryRefresh = startInventoryRefresh(ctx)
      void sweepHandoffStage({ ...(homeDir ? { homeDir } : {}) }).catch(() => undefined)
      // Leftover `.abduco-<pid>` bind probes (killed spawn / crashed runner)
      // inflate every later socket readdir. Sweep before the reattach storm.
      sweepStaleDurableBindTemps()
    }
    for (const diagnostic of portConflicts) send({ type: 'machineDiagnostic', ...diagnostic })
    pushDurableSessionCensus()
    void reportInventory(ctx)
    void replayPendingBindingReceipts().catch((error) =>
      log.warn('Codex identity receipt replay failed', { err: error }),
    )
    browserOpen.replay()
    // A raise survives a reconnect (the TTL is the daemon's, not the link's),
    // so whatever the sink held while the socket was down goes out now.
    logForwarding.flush()
  }

  const close = async (closeOpts?: { reapSessions?: boolean }): Promise<void> => {
    await bindingRecovery?.catch(() => {})
    if (disposed) return
    disposed = true
    if (recoveryRetry) clearTimeout(recoveryRetry)
    observers.stopAllTails()
    logForwarding.dispose()
    await ingest.close()
    await agentRelay.close()
    discoveryLoop.stop()
    scopeMonitor.dispose()
    if (metricsTimer) clearInterval(metricsTimer)
    if (uploadsGcTimer) clearInterval(uploadsGcTimer)
    // Stop the probe and sample timers and release the minute file's fd. The
    // records are already on disk (the sink writes synchronously), so this
    // closes a descriptor rather than draining anything.
    loopAccounting?.stop()
    loopProfileCapture?.stop()
    if (onDumpSignal) {
      process.removeListener('SIGUSR2', onDumpSignal)
      onDumpSignal = undefined
    }
    // Unpatch the schedulers — a daemon that has closed must not leave a wrapper
    // on global setTimeout for the next one in this process to inherit.
    stopLoopAttribution?.()
    stopLoopAttribution = undefined
    // And unregister OUR accounting handle, so a stopped one cannot keep taking
    // costs into a ring nothing will flush. A co-hosted server's is not ours.
    dropLoopAccounting?.()
    dropLoopAccounting = undefined
    loopMinuteSink?.close()
    stopInventoryRefresh?.()
    workerClient.stop()
    outputScheduler.stop()
    const durableReaps: Promise<unknown>[] = []
    const reapSessions = closeOpts?.reapSessions ?? false
    for (const [sessionId, owned] of ctx.sessions.entries()) {
      const label = owned.label ?? ctx.durableLabelFor(sessionId)
      owned.clear()
      if (reapSessions && durable) {
        durableReaps.push(durable.kill(label))
      }
    }
    ctx.sessions.clear()
    for (const turn of ctx.runningHeadlessTurns.values()) {
      if (reapSessions) turn.interrupt()
      else turn.dispose?.()
    }
    ctx.runningHeadlessTurns.clear()
    try {
      await reapServerSessionsBeforeDispose(
        ctx,
        closeAgentRuntime,
        reapSessions,
        () => {
          closeAgentRuntime?.dispose()
          if (closeAgentRuntime !== agentRuntime) agentRuntime?.dispose()
        },
        args.testServerReapIo,
      )
    } catch (err) {
      // A failed binding snapshot or child reap must not abort the rest of
      // host teardown. The helper finally disposed runtimes; continue through
      // observer/composer disposal and awaited PTY reaps.
      log.warn('could not reap server sessions before host disposal', { err })
    }
    observers.disposeObservers()
    composerEngine.disposeAll()
    await Promise.all(durableReaps)
  }

  return {
    machineId,
    identity,
    backend,
    frameGuard,
    hookPort: ingest.port,
    ...(ingest.socketPath ? { hookSocketPath: ingest.socketPath } : {}),
    agentRelayPort: agentRelay.port,
    portableState: portableStateFence,
    connected,
    bindingSessionIds: () => bindingStore.inventory(instance.codexReceiptDir),
    receive: (raw) => withHarnessVersionReporting(send, () => frameGuard.receive(raw)),
    receiveBinaryInput: (metadata, payload) => frameGuard.receiveBinaryInput(metadata, payload),
    close,
  }
}
