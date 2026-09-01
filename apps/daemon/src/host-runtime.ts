import { mkdir, stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createOpencode2Client } from '@podium/agent-runtime'
import {
  agentLaunchCommand,
  buildMachineInventory,
  declaredValue,
  type HarnessEnvironment,
  harnessDetectLogin,
  harnessLoginReadEnv,
  resolvedHarnessPath,
} from '@podium/harness'
import { createLogger, resolveLevel } from '@podium/logger'
import { asSessionId, FIRST_ADMIN_USER_ID, type MachineId, type SessionId } from '@podium/model'
import type { DaemonPtyInputMetadata, DaemonPtyOutputBatch, PeerBuild } from '@podium/protocol'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import type { AgentSession } from '@podium/pty'
import {
  killAbducoSession,
  killTmuxServer,
  listLiveAbducoLabels,
  reapStaleAbducoBindTemps,
} from '@podium/pty'
import {
  loadConfig,
  resolveAgentHomeDir,
  resolveAgentRelayPort,
  resolveHookPort,
  stateDir,
} from '@podium/runtime/config'
import { durableSessionLabel } from '@podium/runtime/instance'
import { installDaemonLogForwarding } from '@podium/runtime/log-forward'
import { startLoopMetrics } from '@podium/runtime/loop-metrics'
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
import { ensurePodiumCodexHooks } from './codex-hooks'
import { ComposerSyncEngine } from './composer-sync'
import type { DaemonContext, DurableBackend } from './control/context'
import { reportInventory, startInventoryRefresh } from './control/inventory'
import {
  createSchemaGate,
  MAX_CONVERGENCE_ATTEMPTS,
  refuseConvergence,
  releaseCarriesNewMigrations,
  resolveOnBoot,
  restartAfterGrant,
  shouldClearPendingGrantOnBoot,
} from './convergence'
import type { DaemonOptions } from './daemon-options'
import { createDiscoveryLoop, DEFAULT_DISCOVERY_SCAN_INTERVAL_MS } from './discovery-loop'
import { selectDurableBackend } from './durable-backend'
import { createFrameGuard, type FrameGuard } from './frame-guards'
import { createFrameSink } from './frame-sink'
import { createGrantRunner } from './grant-apply'
import { ensurePodiumGrokHooks } from './grok-hooks'
import { sweepHandoffStage } from './handoff-package'
import { DaemonHarnessRuntime } from './harness-runtime'
import type { HeadlessTurnHandle } from './headless-drivers.js'
import { startHookIngest } from './hook-ingest'
import { sampleHostLoad, sampleHostMemory } from './host-metrics'
import { loadIdentity } from './identity'
import type { DaemonInstanceBootstrap } from './instance-bootstrap'
import { reportLongTick, startLoopAttribution } from './loop-attribution'
import { AGENT_RELAY_ENDPOINT, describePortConflict, HOOK_INGEST_ENDPOINT } from './loopback-listen'
import { composeResponders, createAckReminderInjector, createMailInjector } from './mail-injector'
import { attributeMemory, snapshotProcesses } from './memory-breakdown'
import { OutputScheduler } from './output-scheduler'
import { clearPendingGrant, readPendingGrant, writePendingGrant } from './pending-grant'
import { type PortableStateControl, PortableStateFence } from './portable-state-fence'
import { createPrimeInjector } from './prime-injector'
import { makeQuotaFetcher } from './quota-fetch'
import { createReattachGates } from './reattach-gates'
import { stageRuntimeAttachment } from './runtime/attachment-staging'
import {
  createDaemonClaudeSdkRuntime,
  type DaemonClaudeSdkRuntime,
} from './runtime/claude-sdk-driver'
import { createCodexHost } from './runtime/codex-app-server'
import { createDaemonCodexRuntime, type DaemonCodexRuntime } from './runtime/codex-driver'
import { runtimeContractEnabledByEnv } from './runtime/flag'
import { createGrokAcpHost } from './runtime/grok-acp-server'
import { createDaemonGrokRuntime, type DaemonGrokRuntime } from './runtime/grok-driver'
import { daemonRuntimeHost } from './runtime/host'
import { createDaemonMachineRuntime, type DaemonMachineRuntime } from './runtime/machine-runtime'
import { createOpencodeClientTerminals } from './runtime/opencode-attach'
import { createDaemonOpencodeRuntime, type DaemonOpencodeRuntime } from './runtime/opencode-driver'
import { createOpencodeHost, opencode2VersionDiagnostic } from './runtime/opencode-server'
import { createScopeMonitor } from './runtime/scope-monitor'
import { beginServerDriverReap, type ServerReapIo } from './runtime/server-reap'
import { createTerminalRuntime, type TerminalRuntime } from './runtime/terminal-driver'
import { SessionBinding } from './session-binding'
import { createSessionObservers } from './session-observers'
import { sweepUploads, UPLOADS_GC_INTERVAL_MS } from './session-uploads'
import { ShippingExecutionPlane } from './shipping/executor'
import { restartAsServer, retireTargetDaemonAfterAcknowledgement } from './transfer-lifecycle'
import { swapHeadlessBundle } from './update-install'
import { DiscoveryWorkerClient } from './worker-client'
import { createCwdResolver, createSessionCwdTracker } from './worktree-resolve'

const log = createLogger('daemon:host')

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
  connected(): { convergedVersion?: string }
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
}): Promise<DaemonHostRuntime> {
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
  const runtimeContractEnabled = runtimeContractEnabledByEnv(process.env)
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
  const send = createFrameSink({
    upstream: sendUpstream,
    runtime: () => agentRuntime,
    context: () => context,
  })
  const config = loadConfig()
  const launch = opts.launch ?? agentLaunchCommand
  const backend = selectDurableBackend(opts)
  const identityStateDir = opts.identityDir ?? stateDir()
  const identity = loadIdentity({ dir: identityStateDir })
  const machineId = opts.machineId ?? identity.machineId
  const portableStateFence = new PortableStateFence()
  const shipping = new ShippingExecutionPlane(join(instance.runtimeDir, 'shipping'), machineId)
  opts.localLink?.attachPortableState?.(portableStateFence)
  await mkdir(instance.runtimeDir, { recursive: true })
  const bindingStore = await BindingStore.open({
    dir: join(instance.runtimeDir, 'session-bindings'),
    legacyStateDir: identityStateDir,
    codexReceiptDir: instance.codexReceiptDir,
    singleOperatorUserId: FIRST_ADMIN_USER_ID,
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

  const bridges = new Map<SessionId, AgentSession>()
  const composerEngine = new ComposerSyncEngine(
    (sessionId, text) => send({ type: 'nativeDraft', sessionId, text }),
    {
      writePty: (sessionId, bytes) =>
        bridges.get(sessionId)?.write(Buffer.from(bytes, 'utf8').toString('base64')),
      onDemote: (sessionId) => log.warn('draft-sync self-demoted to read-only', { sessionId }),
    },
  )

  const workerClient = opts.workerClient ?? new DiscoveryWorkerClient()
  if (process.env.PODIUM_LOOP_PROFILE) {
    // POD-600's loop-stall classifier stays in loop-attribution.ts; boot merely
    // turns it on. Moving connection code must never absorb this instrumentation.
    startLoopAttribution()
    startLoopMetrics({ onLongTick: reportLongTick })
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
  const observers = createSessionObservers({
    sessionBinding,
    send,
    homeDir,
    transcriptRoot: join(identityStateDir, 'transcripts'),
    onTranscriptDirty: (path) => discoveryLoop.markConversationDirty(path),
    cwdTracker: sessionCwdTracker,
    onIdleState: (sessionId, idle) => composerEngine.setIdle(sessionId, idle),
    onAuthSignal: (sessionId) => requestAuthRefresh(sessionId),
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
        send({
          type: 'sessionResumeRef',
          sessionId,
          resume: { kind: 'codex-thread', value: nativeId },
          confidence: 'exact',
          ackRequested: true,
        })
        return
      }
      await replayPendingBindingReceipts()
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
  const primeInjector = createPrimeInjector((sessionId) =>
    agentRelayHub.relay({
      sessionId,
      router: 'issues',
      proc: 'prime',
      input: {},
    }),
  )
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
  const respondTo = composeResponders(
    (sessionId, payload) => primeInjector.respondTo(sessionId, payload),
    (sessionId, payload) => mailInjector.respondTo(sessionId, payload),
    (sessionId, payload) => ackReminder.respondTo(sessionId, payload),
  )
  const ingest = await startHookIngest({
    port: opts.hooks?.port ?? resolveHookPort(config),
    ...(instance.hookSocketPath ? { socketPath: instance.hookSocketPath } : {}),
    respondTo,
    beforeAck: async (sessionId, payload) => {
      if (!(await bindingStore.acceptsNativeKind(sessionId, 'codex-thread'))) return
      const nativeId =
        payload && typeof payload === 'object'
          ? (payload as Record<string, unknown>).session_id
          : undefined
      if (typeof nativeId !== 'string' || nativeId.length === 0) return
      if (!(await bindingStore.recordPendingCodexReceipt(sessionId, nativeId, 'native-hook'))) {
        throw new Error(`Codex receipt ${sessionId} has no owned binding`)
      }
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

  if (opts.installCodexHooks) {
    void ensurePodiumCodexHooks({
      ...(homeDir ? { homeDir } : {}),
      onDegraded: (diagnostic) => send({ type: 'machineDiagnostic', ...diagnostic }),
    })
      .then((result) => {
        if (result.changed) log.info('codex hooks installed or refreshed')
      })
      .catch((error) => log.warn('codex hooks install failed', { err: error }))
  }
  if (opts.installGrokHooks) {
    void ensurePodiumGrokHooks({ ...(homeDir ? { homeDir } : {}) })
      .then((result) => {
        if (result.changed) log.info('grok hooks installed or refreshed')
      })
      .catch((error) => log.warn('grok hooks install failed', { err: error }))
  }

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

  const reconcilePendingUpdate = (): string | undefined => {
    if (parentHasServer) return
    const pending = readPendingGrant(instance.runtimeDir)
    if (!pending) return

    const runningVersion = build.appVersion ?? 'dev'
    const verdict = resolveOnBoot({ pending, runningVersion })
    if (!verdict) return

    let state: 'current' | 'rejected' | 'stuck'
    let detail: string | undefined
    if (verdict.action === 'confirm') {
      state = 'current'
    } else if (verdict.action === 'rollback') {
      state = verdict.state
      detail = verdict.detail
    } else {
      // A RETRY verdict is not "manual convergence is required" — this boot
      // used one of the permitted attempts and another is still allowed. Report
      // it as a failure the operator can retry, and KEEP the marker with the
      // attempt spent, so the next grant is the last one the bound permits
      // instead of restarting the count at zero.
      state = 'rejected'
      detail =
        'attempt ' +
        verdict.attempts +
        ' of ' +
        MAX_CONVERGENCE_ATTEMPTS +
        ' did not reach ' +
        pending.targetVersion +
        ' (running ' +
        runningVersion +
        '); applying again will retry it'
    }

    send({
      type: 'updateStatus',
      grantId: pending.grantId,
      targetVersion: pending.targetVersion,
      state,
      version: runningVersion,
      ...(detail ? { detail } : {}),
    })
    if (verdict.action === 'retry') {
      writePendingGrant(instance.runtimeDir, { ...pending, attempts: verdict.attempts })
      return
    }
    if (shouldClearPendingGrantOnBoot({ verdict, parentHasServer })) {
      clearPendingGrant(instance.runtimeDir)
    }
    return verdict.action === 'confirm' ? pending.targetVersion : undefined
  }

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
    refuse: (target) => convergenceRefusal ?? schemaGate(target),
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
    restart: (expectedVersion, handover) =>
      restartAfterGrant(expectedVersion, handover, {
        ...(opts.restartAfterUpdate ? { provided: opts.restartAfterUpdate } : {}),
        parentManaged: process.env.PODIUM_UNDER_PARENT === '1',
        requestHandover: (request) => requestParentHandover(request),
        exit: process.exit,
      }),
    report: (status) => send(status),
    // THE FLIGHT RECORDER FOR AN UPDATE (POD-3170). `send` drops when the link
    // is down, and a coordinator applying its own grant takes the link down —
    // so the phases of a lost delivery are only ever knowable from here.
    log: (event, fields) => log.info(event, fields),
    now: Date.now,
  })
  const applyUpdateGrant = (grant: Extract<ControlMessage, { type: 'updateGrant' }>) => {
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
   * problem there is. Nothing leaves the host until a raise arrives; see
   * `@podium/runtime/log-forward`.
   *
   * `boot` is READ, not assumed: it is whatever this process's own logging
   * composition root settled on (env, defaults, supervision mode), so a reset
   * puts the daemon back where it started rather than at a level written down
   * here that could disagree with it.
   */
  const logForwarding = installDaemonLogForwarding({
    boot: resolveLevel('daemon'),
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
    durableLabels: new Map<SessionId, string>(),
    durableLabelFor: (sessionId) => durableSessionLabel(sessionId, instance.instanceId),
    backend,
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
    bridges,
    pendingResizes: new Map<SessionId, { cols: number; rows: number }>(),
    nativeClientRequests: new Set<SessionId>(),
    nativeClientTransitions: new Map<SessionId, Promise<void>>(),
    nativeClientRetries: new Map<SessionId, number>(),
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
    restartAfterTransfer:
      opts.restartAfterTransfer ??
      (async (expected) => {
        await restartAsServer({ transferId: expected.transferId })
        return expected
      }),
    retireAfterTransfer: opts.retireAfterTransfer ?? retireTargetDaemonAfterAcknowledgement,
    applyUpdateGrant,
    runtimeContractEnabled,
  }
  /**
   * Client terminals (POD-2059), built here and put on the CONTEXT as well as
   * into the opencode host: `sessionPriority` (the viewer signal its idle clock
   * runs on) and `reclaimAttachments` (the server's pressure order) are control
   * frames about the machine, not about a driver, and their handlers reach it
   * through `ctx`.
   *
   * NOT GATED ON abduco BEING PRESENT, deliberately. Probing for it here would
   * make every daemon boot pay for resolving (and on a cold machine, BUILDING)
   * the vendored binary, for a client most sessions never open. A machine that
   * cannot start one says so at the attach that asks for it — the spawn fails,
   * the port answers `undefined`, and the driver refuses with the per-machine
   * wording.
   */
  const clientTerminals = createOpencodeClientTerminals({
    // One session-addressed relay for engine terminals and on-demand harness
    // client terminals. The latter intentionally returns the parent session id.
    frames: (streamId, frame) => ctx.outputScheduler.enqueue(asSessionId(streamId), frame),
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
  })
  ctx.clientTerminals = clientTerminals

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
  const contractHost = daemonRuntimeHost(ctx, send, stageAttachment)
  terminalRuntime = createTerminalRuntime(contractHost)
  const generationInventory = harnessRuntime ? await harnessRuntime.current() : undefined
  const opencode2Executable = generationInventory?.commandEnvironment.resolve('opencode2')
  claudeRuntime = createDaemonClaudeSdkRuntime({
    send,
    host: contractHost,
    // The instance agent home the transcript reader already resolves against
    // (control/transcripts.ts sourceForRead), so the SDK child writes its JSONL
    // where sessions.read looks for it (POD-3057).
    ...(homeDir ? { homeDir } : {}),
    ...(generationInventory?.executables.has('claude-code')
      ? { executablePath: resolvedHarnessPath(generationInventory, 'claude-code') }
      : {}),
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
  opencodeRuntime = createDaemonOpencodeRuntime({
    send,
    host: createOpencodeHost({
      resources: (subject) => scopeMonitor.resources(subject),
      stageAttachment,
      /**
       * `attach()`'s client terminal (POD-2059), on the frames path this daemon
       * already runs. The stream id is the key, exactly as the engine variant's
       * endpoint uses the session id — one relay, two kinds of terminal.
       *
       * NOT GATED ON abduco BEING PRESENT, deliberately. Probing for it here
       * would make every daemon boot pay for resolving (and on a cold machine,
       * BUILDING) the vendored binary, for a client most sessions never open. A
       * machine that cannot start one says so at the attach that asks for it —
       * the spawn fails, the port answers `undefined`, and the driver refuses
       * with the per-machine wording.
       */
      clientTerminals,
      ...(generationInventory?.executables.has('opencode')
        ? { executablePath: resolvedHarnessPath(generationInventory, 'opencode') }
        : {}),
      // The instance agent home: a server-driver child's HOME must be the
      // instance's, exactly as the PTY path's children get it (POD-2247).
      ...(homeDir ? { homeDir } : {}),
      instanceUuid: instance.instanceUuid,
    }),
  })
  opencode2Runtime = createDaemonOpencodeRuntime({
    send,
    host: {
      ...createOpencodeHost({
        resources: (subject) => scopeMonitor.resources(subject),
        clientTerminals,
        stageAttachment,
        ...(opencode2Executable ? { executablePath: opencode2Executable } : {}),
        ...(homeDir ? { homeDir } : {}),
        instanceUuid: instance.instanceUuid,
        variant: {
          driverId: 'opencode2-server',
          executable: 'opencode2',
          username: 'opencode',
          healthPath: '/api/health',
          scopeToken: 'oc2',
          journalNamespace: 'opencode2-servers',
          // V2 currently migrates the stable CLI's default database to an incompatible schema.
          // Isolate only the database so v1 and v2 can coexist while both still read the
          // instance's shared OpenCode credentials and configuration.
          env: { OPENCODE_DB: join(stateDir(), 'opencode2.db') },
          versionDiagnostic: opencode2VersionDiagnostic,
        },
      }),
      makeClient: createOpencode2Client,
    },
  })
  /**
   * THE SECOND SERVER-FAMILY RUNTIME (POD-1761 W6), constructed on the same
   * terms and for the same reason as the first: it allocates two maps, and no
   * `codex app-server` child starts until a spawn explicitly asks for
   * `codex-app-server`.
   */
  codexRuntime = createDaemonCodexRuntime({
    send,
    host: createCodexHost({
      resources: (subject) => scopeMonitor.resources(subject),
      stageAttachment,
      attachClient: async ({ sessionId, threadId, clientAddress, workdir }) => {
        try {
          return await clientTerminals.attach({
            sessionId,
            // The 0600 Unix listener the stock TUI dials directly; filesystem
            // permission is the authentication, so there is no secret with it.
            target: {
              kind: 'codex',
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
      detachClient: ({ sessionId }) => clientTerminals.close(sessionId, 'codex'),
      // Same instance-home rule as the opencode host above (POD-2247).
      ...(homeDir ? { homeDir } : {}),
      instanceUuid: instance.instanceUuid,
    }),
  })
  grokRuntime = createDaemonGrokRuntime({
    send,
    host: createGrokAcpHost({
      resources: (subject) => scopeMonitor.resources(subject),
      attachClient: async ({ sessionId, grokSessionId, workdir }) => {
        try {
          return await clientTerminals.attach({
            sessionId,
            // A stdio engine has nothing to address: the client comes back
            // through grok's own native store, so the endpoint is empty.
            target: { kind: 'grok', conversation: grokSessionId, endpoint: {}, workdir },
          })
        } catch (err) {
          log.warn('could not host a Grok client terminal', { err, sessionId })
          return undefined
        }
      },
      // Same instance-home rule as the opencode host above (POD-2247).
      ...(homeDir ? { homeDir } : {}),
      instanceUuid: instance.instanceUuid,
    }),
  })
  agentRuntime = createDaemonMachineRuntime({
    terminal: terminalRuntime,
    claude: claudeRuntime,
    opencode: opencodeRuntime,
    opencode2: opencode2Runtime,
    codex: codexRuntime,
    grok: grokRuntime,
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
    const sessionsMemory = scopeMonitor.sessionsMemory()
    send({
      type: 'hostMetrics',
      hostname: hostname(),
      sampledAt: new Date().toISOString(),
      memory: sampleHostMemory(),
      load: sampleHostLoad(),
      // What this machine can give back WITHOUT parking a session (spec §5).
      // Always sent, including as 0 — which the server treats exactly as an
      // absent field, since both mean "nothing here to reclaim first".
      reclaimableAttachments: clientTerminals.reclaimable(),
      // Whose pressure it is (POD-2413). Absent on a host with no cgroups, or
      // before any session has been scoped here — the server then reads only
      // the host-wide number, exactly as it did before this existed.
      ...(sessionsMemory ? { sessionsMemory } : {}),
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
      try {
        send({ type: 'durableSessionCensus', labels: listLiveAbducoLabels() })
      } catch (err) {
        log.warn('could not census the durable sessions', { err })
      }
    }, 0)
    timer.unref?.()
  }

  const connected = (): { convergedVersion?: string } => {
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
      reapStaleAbducoBindTemps()
    }
    for (const diagnostic of portConflicts) send({ type: 'machineDiagnostic', ...diagnostic })
    const convergedVersion = reconcilePendingUpdate()
    pushDurableSessionCensus()
    void reportInventory(ctx)
    void replayPendingBindingReceipts().catch((error) =>
      log.warn('Codex identity receipt replay failed', { err: error }),
    )
    browserOpen.replay()
    // A raise survives a reconnect (the TTL is the daemon's, not the link's),
    // so whatever the sink held while the socket was down goes out now.
    logForwarding.flush()
    return convergedVersion ? { convergedVersion } : {}
  }

  const close = async (closeOpts?: { reapSessions?: boolean }): Promise<void> => {
    if (disposed) return
    disposed = true
    observers.stopAllTails()
    logForwarding.dispose()
    await ingest.close()
    await agentRelay.close()
    discoveryLoop.stop()
    scopeMonitor.dispose()
    if (metricsTimer) clearInterval(metricsTimer)
    if (uploadsGcTimer) clearInterval(uploadsGcTimer)
    stopInventoryRefresh?.()
    workerClient.stop()
    outputScheduler.stop()
    const durableReaps: Promise<unknown>[] = []
    const reapSessions = closeOpts?.reapSessions ?? false
    for (const [sessionId, session] of ctx.bridges) {
      session.dispose()
      if (reapSessions && backend !== 'none') {
        const label = ctx.durableLabels.get(sessionId) ?? ctx.durableLabelFor(sessionId)
        durableReaps.push(Promise.all([killAbducoSession(label), killTmuxServer(label)]))
      }
    }
    ctx.bridges.clear()
    ctx.durableLabels.clear()
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
    receive: (raw) => frameGuard.receive(raw),
    receiveBinaryInput: (metadata, payload) => frameGuard.receiveBinaryInput(metadata, payload),
    close,
  }
}
