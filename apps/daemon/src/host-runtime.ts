import { mkdir, stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { agentLaunchCommand, declaredValue, harnessDetectLogin } from '@podium/harness'
import { createLogger } from '@podium/logger'
import { asSessionId, FIRST_ADMIN_USER_ID, type MachineId, type SessionId } from '@podium/model'
import type { PeerBuild } from '@podium/protocol'
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
import { readAppliedMigrations } from '@podium/runtime/migration-ledger'
import { startLoopMetrics } from '@podium/runtime/loop-metrics'
import { fetchArtifact, PODIUM_UPDATE_PUBKEY } from '@podium/runtime/update-delivery'
import { withGitBudget } from '@podium/runtime/update-delivery-git'
import type { RawData } from 'ws'
import { createAgentRelayHub, startAgentRelayServer } from './agent-relay'
import { provisionedAccountHome, type ProvisionedAccountHomeSource } from './account-home'
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
  resolveOnBoot,
} from './convergence'
import type { DaemonOptions } from './daemon-options'
import { createDiscoveryLoop, DEFAULT_DISCOVERY_SCAN_INTERVAL_MS } from './discovery-loop'
import { selectDurableBackend } from './durable-backend'
import { createFrameGuard, type FrameGuard } from './frame-guards'
import { createGitRunner } from './git-runner'
import { createGrantRunner } from './grant-apply'
import { ensurePodiumGrokHooks } from './grok-hooks'
import { sweepHandoffStage } from './handoff-package'
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
import { DaemonHarnessRuntime } from './harness-runtime'
import { createReattachGates } from './reattach-gates'
import { createCodexHost } from './runtime/codex-app-server'
import { createDaemonCodexRuntime, type DaemonCodexRuntime } from './runtime/codex-driver'
import { runtimeContractEnabledByEnv } from './runtime/flag'
import { createGrokAcpHost } from './runtime/grok-acp-server'
import { createDaemonGrokRuntime, type DaemonGrokRuntime } from './runtime/grok-driver'
import { daemonRuntimeHost } from './runtime/host'
import { createOpencodeClientTerminals } from './runtime/opencode-attach'
import { createDaemonOpencodeRuntime, type DaemonOpencodeRuntime } from './runtime/opencode-driver'
import { createOpencodeHost } from './runtime/opencode-server'
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
  connected(): void
  receive(raw: RawData): void
  close(opts?: { reapSessions?: boolean }): Promise<void>
}

/** Keep the synchronous spawn gate on the exact home inventory uses. */
function daemonHarnessLoginContext(
  homeDir: string | undefined,
): Pick<DaemonContext, 'homeDir' | 'harnessLoginState'> {
  return {
    homeDir,
    harnessLoginState: (agentKind) =>
      agentKind === 'shell'
        ? undefined
        : harnessDetectLogin(agentKind, homeDir ?? homedir())?.state,
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
  acknowledgeQueueDrainReport: (reportId: string) => void
}): Promise<DaemonHostRuntime> {
  const { options: opts, instance, build, installDir, send: sendUpstream } = args
  /**
   * THE AGENT RUNTIME CONTRACT'S TERMINAL DRIVER (POD-1761 W3), when the flag is
   * on for this daemon or for an individual session.
   *
   * Declared here, built after the context it needs, and TAPPED on the outbound
   * frame sink below — see `terminal-driver.ts`'s header for why that sink is the
   * driver's event source rather than a set of new observer callbacks.
   */
  let terminalRuntime: TerminalRuntime | undefined
  let opencodeRuntime: DaemonOpencodeRuntime | undefined
  let codexRuntime: DaemonCodexRuntime | undefined
  let grokRuntime: DaemonGrokRuntime | undefined
  const runtimeContractEnabled = runtimeContractEnabledByEnv(process.env)
  /**
   * Every outbound daemon frame, past the driver's observation tap.
   *
   * TWO PROPERTIES THIS WRAPPER HAS TO KEEP. It must not recurse — the driver
   * emits `runtimeEvent` frames THROUGH here, so those are the one type the tap
   * skips. And it must cost nothing when the flag is off: with no registry the
   * optional call is a null check, and with a registry but no flagged session the
   * tap returns on a map lookup.
   */
  const send = (message: DaemonMessage): void => {
    if (message.type !== 'runtimeEvent') terminalRuntime?.observe(message)
    sendUpstream(message)
  }
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
  const harnessRuntime = opts.launch
    ? undefined
    : new DaemonHarnessRuntime({
        machineHome,
        credentialHome: accountHome?.path ?? homeDir ?? machineHome,
      })
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
  const observers = createSessionObservers({
    sessionBinding,
    send,
    homeDir,
    onTranscriptDirty: (path) => discoveryLoop.markConversationDirty(path),
    cwdTracker: sessionCwdTracker,
    onIdleState: (sessionId, idle) => composerEngine.setIdle(sessionId, idle),
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
      terminalRuntime?.onHookPayload(sessionId, payload)
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

  const outputScheduler = new OutputScheduler({
    flush: (sessionId, frames) => send({ type: 'agentFrameBatch', sessionId, frames }),
  })

  const reconcilePendingUpdate = (): void => {
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
      state,
      version: runningVersion,
      ...(detail ? { detail } : {}),
    })
    if (verdict.action === 'retry') {
      writePendingGrant(instance.runtimeDir, { ...pending, attempts: verdict.attempts })
      return
    }
    clearPendingGrant(instance.runtimeDir)
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
    fetchArtifact: (asset, delivery, signal, onProgress) =>
      fetchArtifact(asset, delivery, {
        fetch: globalThis.fetch,
        pubkey: PODIUM_UPDATE_PUBKEY,
        pinnedPubkey: identity.updatePubkey,
        // Delivery decides WHEN there is news; `applyGrant` turns each one into
        // an `updateStatus` frame (POD-2101).
        ...(onProgress ? { onProgress } : {}),
        // One budget per convergence, established at the moment delivery
        // starts rather than once for the life of the daemon — and bound to
        // THIS grant's abort, so a superseding grant cancels the git steps
        // instead of waiting out their timeout.
        git: { run: withGitBudget(createGitRunner(signal)) },
        ...(signal ? { signal } : {}),
      }),
    swap: (bytes) => {
      if (!installDir) throw new Error('binary delivery requires an installed daemon')
      return swapHeadlessBundle(bytes, installDir)
    },
    refuse: (target) => convergenceRefusal ?? schemaGate(target),
    writePending: (pending) => writePendingGrant(instance.runtimeDir, pending),
    restart: opts.restartAfterUpdate ?? (() => process.exit(0)),
    report: (status) => send(status),
    now: Date.now,
  })
  const applyUpdateGrant = (grant: Extract<ControlMessage, { type: 'updateGrant' }>) =>
    grantRunner.apply(grant)

  const ctx: DaemonContext = {
    send,
    acknowledgeQueueDrainReport: args.acknowledgeQueueDrainReport,
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
    ...daemonHarnessLoginContext(homeDir),
    bridges,
    pendingResizes: new Map<SessionId, { cols: number; rows: number }>(),
    nativeClientRequests: new Set<SessionId>(),
    nativeClientTransitions: new Map<SessionId, Promise<void>>(),
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
    ...(homeDir ? { homeDir } : {}),
  })
  ctx.clientTerminals = clientTerminals

  // Built AFTER the context, because the driver's host port is that context. The
  // assignment closes the only cycle in this wiring: handlers reach the registry
  // through `ctx.runtime`, and the registry reaches the daemon through `ctx`.
  terminalRuntime = createTerminalRuntime(daemonRuntimeHost(ctx, send))
  ctx.runtime = terminalRuntime
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
      memoryBytes: ({ sessionId, label, pid }) =>
        attributeMemory(
          snapshotProcesses(),
          [{ sessionId, label, ...(pid !== undefined ? { pid } : {}) }],
          [],
          { selfPid: process.pid },
        ).agents.find((agent) => agent.sessionId === sessionId)?.bytes,
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
      // The instance agent home: a server-driver child's HOME must be the
      // instance's, exactly as the PTY path's children get it (POD-2247).
      ...(homeDir ? { homeDir } : {}),
    }),
  })
  ctx.opencodeRuntime = opencodeRuntime
  /**
   * THE SECOND SERVER-FAMILY RUNTIME (POD-1761 W6), constructed on the same
   * terms and for the same reason as the first: it allocates two maps, and no
   * `codex app-server` child starts until a spawn explicitly asks for
   * `codex-app-server`.
   */
  codexRuntime = createDaemonCodexRuntime({
    send,
    host: createCodexHost({
      memoryBytes: ({ sessionId, label, pid }) =>
        attributeMemory(
          snapshotProcesses(),
          [{ sessionId, label, ...(pid !== undefined ? { pid } : {}) }],
          [],
          { selfPid: process.pid },
        ).agents.find((agent) => agent.sessionId === sessionId)?.bytes,
      attachClient: async ({ sessionId, threadId, workdir }) => {
        try {
          return await clientTerminals.attach({
            sessionId,
            target: { kind: 'codex', threadId, workdir },
          })
        } catch (err) {
          log.warn('could not host a Codex client terminal', { err, sessionId })
          return undefined
        }
      },
      detachClient: ({ sessionId }) => clientTerminals.close(sessionId, 'codex'),
      // Same instance-home rule as the opencode host above (POD-2247).
      ...(homeDir ? { homeDir } : {}),
    }),
  })
  ctx.codexRuntime = codexRuntime
  grokRuntime = createDaemonGrokRuntime({
    send,
    host: createGrokAcpHost({
      memoryBytes: ({ sessionId, label, pid }) =>
        attributeMemory(
          snapshotProcesses(),
          [{ sessionId, label, ...(pid !== undefined ? { pid } : {}) }],
          [],
          { selfPid: process.pid },
        ).agents.find((agent) => agent.sessionId === sessionId)?.bytes,
      attachClient: async ({ sessionId, grokSessionId, workdir }) => {
        try {
          return await clientTerminals.attach({
            sessionId,
            target: { kind: 'grok', grokSessionId, workdir },
          })
        } catch (err) {
          log.warn('could not host a Grok client terminal', { err, sessionId })
          return undefined
        }
      },
      // Same instance-home rule as the opencode host above (POD-2247).
      ...(homeDir ? { homeDir } : {}),
    }),
  })
  ctx.grokRuntime = grokRuntime

  const frameGuard = createFrameGuard(ctx)

  const metricsBackground = opts.metrics?.background ?? true
  const metricsIntervalMs = opts.metrics?.intervalMs ?? DEFAULT_HOST_METRICS_INTERVAL_MS
  let metricsTimer: ReturnType<typeof setInterval> | undefined
  let uploadsGcTimer: ReturnType<typeof setInterval> | undefined
  let stopInventoryRefresh: (() => void) | undefined
  let kickedOff = false
  let disposed = false
  const pushHostMetrics = (): void => {
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

  const connected = (): void => {
    if (!kickedOff) {
      kickedOff = true
      discoveryLoop.start()
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
    reconcilePendingUpdate()
    pushDurableSessionCensus()
    void reportInventory(ctx)
    void replayPendingBindingReceipts().catch((error) =>
      log.warn('Codex identity receipt replay failed', { err: error }),
    )
    browserOpen.replay()
  }

  const close = async (closeOpts?: { reapSessions?: boolean }): Promise<void> => {
    if (disposed) return
    disposed = true
    observers.stopAllTails()
    await ingest.close()
    await agentRelay.close()
    discoveryLoop.stop()
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
    terminalRuntime?.dispose()
    opencodeRuntime?.dispose()
    codexRuntime?.dispose()
    observers.disposeObservers()
    grokRuntime?.dispose()
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
    close,
  }
}
