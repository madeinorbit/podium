import { spawnSync } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { agentLaunchCommand, declaredValue } from '@podium/harness'
import { FIRST_ADMIN_USER_ID, type SessionId } from '@podium/model'
import type { ControlMessage, DaemonMessage } from '@podium/protocol'
import type { AgentSession } from '@podium/pty'
import { killAbducoSession, killTmuxServer } from '@podium/pty'
import {
  loadConfig,
  resolveAgentHomeDir,
  resolveAgentRelayPort,
  resolveHookPort,
  stateDir,
} from '@podium/runtime/config'
import { durableSessionLabel } from '@podium/runtime/instance'
import { startLoopMetrics } from '@podium/runtime/loop-metrics'
import { PODIUM_UPDATE_PUBKEY, fetchArtifact } from '@podium/runtime/update-delivery'
import type { RawData } from 'ws'
import { createAgentRelayHub, startAgentRelayServer } from './agent-relay'
import { BindingStore } from './binding-store'
import { createBrowserOpenManager } from './browser-open'
import { ensurePodiumCodexHooks } from './codex-hooks'
import { ComposerSyncEngine } from './composer-sync'
import type { DaemonContext, DurableBackend } from './control/context'
import { reportInventory, startInventoryRefresh } from './control/inventory'
import type { DaemonOptions } from './daemon-options'
import { buildReport, deliveryCaps } from './build-report'
import { createDiscoveryLoop, DEFAULT_DISCOVERY_SCAN_INTERVAL_MS } from './discovery-loop'
import { applyGrant } from './grant-apply'
import { selectDurableBackend } from './durable-backend'
import { createFrameGuard, type FrameGuard } from './frame-guards'
import { ensurePodiumGrokHooks } from './grok-hooks'
import { sweepHandoffStage } from './handoff-package'
import type { HeadlessTurnHandle } from './headless-drivers.js'
import { startHookIngest } from './hook-ingest'
import { sampleHostMemory } from './host-metrics'
import { loadIdentity } from './identity'
import type { DaemonInstanceBootstrap } from './instance-bootstrap'
import { reportLongTick, startLoopAttribution } from './loop-attribution'
import { composeResponders, createAckReminderInjector, createMailInjector } from './mail-injector'
import { OutputScheduler } from './output-scheduler'
import { writePendingGrant } from './pending-grant'
import { swapHeadlessBundle } from './update-install'
import { createPrimeInjector } from './prime-injector'
import { makeQuotaFetcher } from './quota-fetch'
import { createReattachGates } from './reattach-gates'
import { SessionBinding } from './session-binding'
import { createSessionObservers } from './session-observers'
import { sweepUploads, UPLOADS_GC_INTERVAL_MS } from './session-uploads'
import { DiscoveryWorkerClient } from './worker-client'
import { createCwdResolver, createSessionCwdTracker } from './worktree-resolve'

const DEFAULT_HOST_METRICS_INTERVAL_MS = 5_000

export interface DaemonHostRuntime {
  readonly machineId: string
  readonly identity: { token?: string }
  readonly backend: DurableBackend
  readonly frameGuard: FrameGuard
  readonly hookPort: number
  readonly hookSocketPath?: string
  readonly agentRelayPort: number
  connected(): void
  receive(raw: RawData): void
  close(opts?: { reapSessions?: boolean }): Promise<void>
}

/**
 * Construct the host-control runtime independently of the server connection.
 * Every handler consumes the explicit DaemonContext (including SessionBinding);
 * reconnecting swaps only the `send` port and never reconstructs host services.
 */
export async function createDaemonHostRuntime(args: {
  options: DaemonOptions
  instance: DaemonInstanceBootstrap
  send: (message: DaemonMessage) => void
}): Promise<DaemonHostRuntime> {
  const { options: opts, instance, send } = args
  const config = loadConfig()
  const launch = opts.launch ?? agentLaunchCommand
  const backend = selectDurableBackend(opts)
  const identityStateDir = opts.identityDir ?? stateDir()
  const identity = loadIdentity({ dir: identityStateDir })
  const machineId = opts.machineId ?? identity.machineId
  await mkdir(instance.runtimeDir, { recursive: true })
  const bindingStore = await BindingStore.open({
    dir: join(instance.runtimeDir, 'session-bindings'),
    legacyStateDir: identityStateDir,
    codexReceiptDir: instance.codexReceiptDir,
    singleOperatorUserId: FIRST_ADMIN_USER_ID,
  })
  const sessionBinding = new SessionBinding(bindingStore)
  const homeDir = opts.discovery?.homeDir ?? resolveAgentHomeDir(config)
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
      onDemote: (sessionId) =>
        console.warn(`[podium] draft-sync self-demoted to read-only for ${sessionId}`),
    },
  )

  const workerClient = opts.workerClient ?? new DiscoveryWorkerClient()
  if (process.env.PODIUM_LOOP_PROFILE) {
    // POD-600's loop-stall classifier stays in loop-attribution.ts; boot merely
    // turns it on. Moving connection code must never absorb this instrumentation.
    startLoopAttribution()
    startLoopMetrics({ label: 'daemon', onLongTick: reportLongTick })
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
    agentRelayHub.relay({ sessionId, router: 'issues', proc: 'prime', input: {} }),
  )
  const mailInjector = createMailInjector((sessionId) =>
    agentRelayHub.relay({ sessionId, router: 'issues', proc: 'mailPending', input: {} }),
  )
  const ackReminder = createAckReminderInjector((sessionId) =>
    agentRelayHub.relay({ sessionId, router: 'messages', proc: 'pendingReminders', input: {} }),
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
    onPayload: (sessionId, payload) => observers.onHookPayload(sessionId, payload),
  })

  if (opts.installCodexHooks) {
    void ensurePodiumCodexHooks({
      ...(homeDir ? { homeDir } : {}),
      onDegraded: (diagnostic) => send({ type: 'machineDiagnostic', ...diagnostic }),
    })
      .then((result) => {
        if (result.changed) console.log('[podium] codex hooks installed/refreshed')
      })
      .catch((error) => console.warn('[podium] codex hooks install failed:', error))
  }
  if (opts.installGrokHooks) {
    void ensurePodiumGrokHooks({ ...(homeDir ? { homeDir } : {}) })
      .then((result) => {
        if (result.changed) console.log('[podium] grok hooks installed/refreshed')
      })
      .catch((error) => console.warn('[podium] grok hooks install failed:', error))
  }

  const agentRelay = await startAgentRelayServer({
    port: opts.agentRelay?.port ?? resolveAgentRelayPort(config),
    openUrl: (sessionId, url) => browserOpen.capture(sessionId, url),
    relay: async (request) => {
      if (request.router === 'session' && request.proc === 'setWorktree') {
        const path = (request.input as { path?: unknown } | null | undefined)?.path
        if (typeof path !== 'string' || !path.startsWith('/')) {
          return { ok: false, error: 'path must be an absolute directory path' }
        }
        const found = await stat(path).catch(() => null)
        if (!found?.isDirectory()) return { ok: false, error: `no such directory: ${path}` }
        const worktree = await sessionCwdTracker.setExplicit(request.sessionId, path)
        return { ok: true, result: { worktree } }
      }
      return agentRelayHub.relay(request)
    },
  })
  const outputScheduler = new OutputScheduler({
    flush: (sessionId, frames) => send({ type: 'agentFrameBatch', sessionId, frames }),
  })

  const installDir =
    process.env.PODIUM_HOME ??
    (process.execPath.endsWith('/podium') ? dirname(process.execPath) : undefined)
  const build = buildReport(process.env, installDir)
  const runGit = (command: string, args: string[]): { status: number | null; stdout: string } => {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
    }
  }
  const applyUpdateGrant = (grant: Extract<ControlMessage, { type: 'updateGrant' }>) =>
    applyGrant(grant, {
      currentVersion: () => build.appVersion ?? 'dev',
      caps: deliveryCaps(build.installKind),
      fetchArtifact: (asset, delivery) =>
        fetchArtifact(asset, delivery, {
          fetch: globalThis.fetch,
          pubkey: PODIUM_UPDATE_PUBKEY,
          git: { run: runGit },
        }),
      swap: (bytes) => {
        if (!installDir) throw new Error('binary delivery requires an installed daemon')
        swapHeadlessBundle(bytes, installDir)
      },
      writePending: (pending) => writePendingGrant(instance.runtimeDir, pending),
      restart: opts.restartAfterUpdate ?? (() => process.exit(0)),
      report: (status) => send(status),
      now: Date.now,
    })

  const ctx: DaemonContext = {
    send,
    machineId,
    instanceId: instance.instanceId,
    durableLabels: new Map<SessionId, string>(),
    durableLabelFor: (sessionId) => durableSessionLabel(sessionId, instance.instanceId),
    backend,
    launch,
    settingsDir: instance.settingsDir,
    homeDir,
    bridges,
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
    applyUpdateGrant,
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
    send({
      type: 'hostMetrics',
      hostname: hostname(),
      sampledAt: new Date().toISOString(),
      memory: sampleHostMemory(),
    })
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
      uploadsGcTimer = setInterval(sweepUploads, UPLOADS_GC_INTERVAL_MS)
      uploadsGcTimer.unref?.()
      stopInventoryRefresh = startInventoryRefresh(ctx)
      void sweepHandoffStage({ ...(homeDir ? { homeDir } : {}) }).catch(() => undefined)
    }
    void reportInventory(ctx)
    void replayPendingBindingReceipts().catch((error) =>
      console.warn('[podium] Codex identity receipt replay failed:', error),
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
    connected,
    receive: (raw) => frameGuard.receive(raw),
    close,
  }
}
