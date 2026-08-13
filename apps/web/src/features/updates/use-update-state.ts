import {
  classifySkew,
  parseBuildStamp,
  parseServerVersion,
  type ServerVersion,
  WIRE_VERSION,
  wireSchemaDigest,
} from '@podium/protocol'
import { useEffect, useMemo, useState } from 'react'
import { usePolledQuery } from '@/lib/use-polled-query'
import { makeTrpc } from '@/app/trpc'
import { pageBuildVersion } from '@/lib/logging/build-version'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { computeTouched } from './touched'
import type { UpdateActions } from './UpdateDialog'
import {
  type DesktopUpdateInfo,
  describeUpdate,
  describeUpdateFailure,
  type UpdateInput,
  type UpdateView,
} from './update-view'

const BUILD_STAMP_FILE = 'podium-build.json'
const FLEET_POLL_MS = 1_000
/** Idle cadence: enough to recover a failed first read, quiet enough to ignore. */
const FLEET_IDLE_POLL_MS = 30_000

export interface UpdateMachineState {
  id: string
  name?: string
  version: string
  state: 'current' | 'granted' | 'downloading' | 'restarting' | 'rejected' | 'stuck'
  online: boolean
  busy: boolean
  detail?: string
}

export interface UpdateFleetState {
  total: number
  behind: number
  converging: number
  failed: number
  targetVersion?: string | null
  machines?: readonly UpdateMachineState[]
  allMachines?: readonly UpdateMachineState[]
}

export interface UseUpdateStateOptions {
  httpOrigin: string
  needRefresh: boolean
  reload?: () => void | Promise<void>
  surface?: UpdateInput['surface']
  serverName?: string
  fleet?: UpdateFleetState
  startUpdate?: UpdateActions['startUpdate']
}

interface LocalBuild {
  appDigest?: string
  wireSchemaDigest?: string
}

type UpdateActionState =
  | { state: 'idle' }
  | {
      state: 'in-progress'
      version: string
      done: number
      total: number
      includesServer: boolean
      includesWeb?: boolean
    }
  | { state: 'failed'; detail: string; machineName?: string }

const EMPTY_FLEET: UpdateFleetState = {
  total: 0,
  behind: 0,
  converging: 0,
  failed: 0,
  machines: [],
}

function defaultServerName(httpOrigin: string): string | undefined {
  try {
    return new URL(httpOrigin).hostname || undefined
  } catch {
    return undefined
  }
}

function surfaceFromDesktopBridge(): UpdateInput['surface'] {
  const bridge = nativeDesktopBridge()
  if (!bridge) return window.location.pathname.startsWith('/mobile') ? 'mobile' : 'web'
  if (bridge.launchMode === 'all-in-one') return 'desktop-all-in-one'
  if (bridge.launchMode === 'client') return 'desktop-remote'
  return 'desktop-all-in-one'
}

async function readJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

async function waitForCompatibleWebBuild(
  httpOrigin: string,
  attempts = 120,
  delayMs = 1_000,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [serverRaw, buildRaw] = await Promise.all([
      readJson(`${httpOrigin}/version`),
      readJson(`${httpOrigin}/${BUILD_STAMP_FILE}`),
    ])
    const serverVersion = parseServerVersion(serverRaw)
    const build = localBuildFrom(buildRaw)
    if (
      serverVersion.wireSchemaDigest !== undefined &&
      build.wireSchemaDigest === serverVersion.wireSchemaDigest
    ) {
      return
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
  }
  throw new Error('Podium rebuilt the server, but the matching app did not become ready.')
}

function localBuildFrom(raw: unknown): LocalBuild {
  const stamp = parseBuildStamp(raw)
  return {
    ...(stamp.sourceSha ? { appDigest: stamp.sourceSha } : {}),
    ...(stamp.wireSchemaDigest ? { wireSchemaDigest: stamp.wireSchemaDigest } : {}),
  }
}

async function waitForWebIdentity(
  httpOrigin: string,
  expectedDigest: string,
  attempts = 120,
  delayMs = 1_000,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const build = localBuildFrom(await readJson(`${httpOrigin}/${BUILD_STAMP_FILE}`))
    if (build.appDigest === expectedDigest) return
    await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
  }
  throw new Error('Podium rebuilt the server, but the matching app did not become ready.')
}

function updateErrorDetail(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; data?: { message?: unknown } }
    if (typeof value.data?.message === 'string') return value.data.message
    if (typeof value.message === 'string' && value.message.length > 0) return value.message
  }
  return 'The server could not start this update.'
}

async function readDesktopUpdate(
  queryChannel: () => Promise<unknown>,
): Promise<DesktopUpdateInfo | undefined> {
  const check = nativeDesktopBridge()?.checkUpdate
  if (!check) return undefined
  const selected = await queryChannel()
    .then((c) => (typeof c === 'string' ? c : (c as { channel?: string }).channel))
    .catch(() => 'stable' as const)
  const channel = selected === 'dev' || selected === 'edge' ? 'edge' : 'stable'
  const next = await check(channel)
  return next ? { version: next.version, critical: next.critical, notes: next.notes } : undefined
}

export interface UpdateStateResult {
  view: UpdateView
  actions: UpdateActions
  server: ServerVersion
  fleet: UpdateFleetState
  checkNow: () => Promise<void>
  dismissManualCheck: () => void
}

/** Gather the four facts that make the update story: this build, the server
 * descriptor, fleet convergence, and the surface currently showing the dialog. */
export function useUpdateState(options: UseUpdateStateOptions): UpdateStateResult {
  const [server, setServer] = useState<ServerVersion>({})
  const [localBuild, setLocalBuild] = useState<LocalBuild>({})
  const [fleetState, setFleetState] = useState<UpdateFleetState>(options.fleet ?? EMPTY_FLEET)
  const [updateAction, setUpdateAction] = useState<UpdateActionState>({ state: 'idle' })
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateInfo | undefined>()
  type ManualCheck =
    | { state: 'idle' }
    | { state: 'checking' }
    | { state: 'current' }
    | { state: 'failed'; detail: string }
  const [manualCheck, setManualCheck] = useState<ManualCheck>({ state: 'idle' })
  const trpc = useMemo(() => makeTrpc(options.httpOrigin), [options.httpOrigin])
  const queryChannel = (): Promise<unknown> => trpc.setup.channel.query()

  useEffect(() => {
    const claim = nativeDesktopBridge()?.claimUpdateOwnership
    if (claim) void claim().catch(() => {})

    let cancelled = false
    void readDesktopUpdate(queryChannel)
      .then((next) => {
        if (!cancelled) setDesktopUpdate(next)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [trpc])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const [serverRaw, localRaw] = await Promise.all([
        readJson(`${options.httpOrigin}/version`),
        readJson(`${options.httpOrigin}/${BUILD_STAMP_FILE}`),
      ])
      if (cancelled) return
      setServer(parseServerVersion(serverRaw))
      setLocalBuild(localBuildFrom(localRaw))
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [options.httpOrigin])

  // Fleet convergence is host telemetry, not a row: "which machines are on which
  // build, right now" is measured across daemons at the moment of asking and is
  // meaningless offline. So it still polls — but through the ONE polling utility
  // (POD-1772), which owns the timer, the in-flight guard and the tab-visibility
  // gate this effect used to spell for itself.
  //
  // TWO SPEEDS, ONE UTILITY. `active` is "an update is actually converging", and
  // only then is a 1 s sweep worth a machine's time; otherwise the dialog wants
  // ONE reading and no timer at all. That is an interval (0 = read once), not a
  // second code path.
  const active = updateAction.state === 'in-progress' || fleetState.converging > 0
  const fleetQuery = usePolledQuery<{ fleet: UpdateFleetState | null; serverRaw: unknown }>({
    key: `updates.fleet:${options.httpOrigin}`,
    // Idle still refreshes, slowly. A single read at mount was the whole fleet
    // story, so one failed call — the session not established yet, a transient
    // disconnect — left the snapshot empty for the life of the page and the
    // dialog could only ever name "this app".
    intervalMs: active ? FLEET_POLL_MS : FLEET_IDLE_POLL_MS,
    enabled: options.fleet === undefined,
    // HALF AN ANSWER IS STILL AN ANSWER. An unreachable fleet must not cost the
    // dialog the server version it could read, so the fleet arm resolves to null
    // rather than rejecting the pair.
    read: async () => {
      const [fleet, serverRaw] = await Promise.all([
        trpc.updates.fleet.query().then(
          (value) => value,
          () => null,
        ),
        readJson(options.httpOrigin + '/version'),
      ])
      return { fleet, serverRaw }
    },
    // Folded in the read's OWN turn, exactly as the timer it replaced did — a
    // reading routed through `data` and a follow-up effect lands one flush late,
    // and the update button is supposed to appear when the answer does.
    onData: ({ fleet: next, serverRaw }) => {
      // HALF AN ANSWER FIRST. The server version is applied even when the fleet
      // arm came back null, so an unreachable fleet does not also cost the
      // dialog the version it could read.
      const nextServer = parseServerVersion(serverRaw)
      if (serverRaw !== undefined) setServer(nextServer)
      if (next === null) return
      setFleetState(next)
      setUpdateAction((current) => {
        if (current.state !== 'in-progress') return current
        if (next.failed > 0) {
          const failure = next.machines?.find(
            (machine) => machine.state === 'rejected' || machine.state === 'stuck',
          )
          return {
            state: 'failed',
            ...(failure?.name ? { machineName: failure.name } : {}),
            detail:
              failure?.detail ??
              (next.failed === 1 ? 'A machine' : String(next.failed) + ' machines') +
                ' could not finish this update.',
          }
        }
        const serverDone =
          next.targetVersion !== null && nextServer.appVersion === next.targetVersion
        const serverRemaining = current.includesServer && !serverDone ? 1 : 0
        const remaining = serverRemaining + next.behind
        if (next.converging === 0 && remaining === 0 && !current.includesWeb) {
          return { state: 'idle' }
        }
        const done = Math.max(0, Math.min(current.total, current.total - remaining))
        return {
          state: 'in-progress',
          version: next.targetVersion ?? current.version,
          done,
          total: current.total,
          includesServer: current.includesServer,
          ...(current.includesWeb ? { includesWeb: true } : {}),
        }
      })
    },
  })

  // A CHANGE IS ITS OWN TRIGGER. During a convergence the interval is the floor,
  // not the cadence: every answer that moves the count is a reason to ask again
  // at once, so the progress bar tracks the fleet instead of sampling it once a
  // second. This is what the effect's `converging` dependency used to do.
  const converging = fleetState.converging
  const refreshFleet = fleetQuery.refresh
  useEffect(() => {
    if (active) refreshFleet()
  }, [converging, active, refreshFleet])

  const fleet = options.fleet ?? fleetState
  const localVersion = pageBuildVersion()
  const surface = options.surface ?? surfaceFromDesktopBridge()
  const target = server.target
  const desktopTargeted = surface !== 'web' && target?.artifacts.desktop !== undefined
  const serverBehind = Boolean(
    target?.version !== undefined &&
      server.appVersion !== undefined &&
      server.appVersion !== target.version,
  )
  const machinesBehind = fleet.behind
  const touched = target
    ? computeTouched({
        localDigests: { ...(localBuild.appDigest ? { app: localBuild.appDigest } : {}) },
        target,
        fleetBehind: machinesBehind,
        serverBehind,
        sourceAppFollowsServer:
          (surface === 'web' || surface === 'mobile') && target.version.startsWith('dev+'),
      })
    : { app: false, server: serverBehind, machines: machinesBehind > 0 }
  if (options.needRefresh || desktopUpdate !== undefined || desktopTargeted) touched.app = true

  const skew = classifySkew(server, { wire: WIRE_VERSION, digest: wireSchemaDigest() })
  const repairableMismatch =
    skew !== 'ok' && target?.version.startsWith('dev+') === true && options.reload !== undefined
  if (repairableMismatch) {
    touched.app = true
    touched.server = true
  }
  const input: UpdateInput = {
    localVersion,
    server,
    surface,
    serverName: options.serverName ?? defaultServerName(options.httpOrigin),
    fleet,
    touched,
    skew,
    desktopUpdate,
  }
  const baseView = describeUpdate(input)

  useEffect(() => {
    setUpdateAction({ state: 'idle' })
  }, [target?.version])

  const retryableUpdateFailure = updateAction.state === 'failed'
  const webBehind = Boolean(
    target?.artifacts.web?.digest && localBuild.appDigest !== target.artifacts.web.digest,
  )
  const startUpdate = useMemo<UpdateActions['startUpdate']>(() => {
    if (
      !options.startUpdate &&
      !retryableUpdateFailure &&
      (!target || (!serverBehind && fleet.behind === 0 && !webBehind))
    )
      return undefined
    const version = target?.version ?? localVersion
    const includesServer = serverBehind
    const includesWeb = webBehind
    const total = Math.max(1, (includesServer ? 1 : 0) + (includesWeb ? 1 : 0) + fleet.behind)
    const expectedWeb = target?.artifacts.web?.digest
    return async () => {
      setUpdateAction({
        state: 'in-progress',
        version,
        done: 0,
        total,
        includesServer,
        ...(includesWeb ? { includesWeb: true } : {}),
      })
      try {
        if (options.startUpdate) {
          await options.startUpdate()
          return
        }
        const result = await trpc.updates.converge.mutate()
        setFleetState(result.fleet)
        setUpdateAction({
          state: 'in-progress',
          version: result.version,
          done: result.done,
          total: result.total,
          includesServer,
          ...(includesWeb ? { includesWeb: true } : {}),
        })
        if (includesWeb && expectedWeb) {
          await waitForWebIdentity(options.httpOrigin, expectedWeb)
          await options.reload?.()
        }
      } catch (error) {
        setUpdateAction({ state: 'failed', detail: updateErrorDetail(error) })
      }
    }
  }, [
    fleet.behind,
    localVersion,
    options.httpOrigin,
    options.reload,
    options.startUpdate,
    retryableUpdateFailure,
    serverBehind,
    target,
    trpc,
    webBehind,
  ])

  const repairCompatibility = useMemo<UpdateActions['repairCompatibility']>(() => {
    if (!repairableMismatch || !options.reload) return undefined
    const version = target?.version ?? server.appVersion ?? localVersion
    return async () => {
      setUpdateAction({ state: 'in-progress', version, done: 0, total: 1, includesServer: true })
      try {
        await trpc.updates.repairCompatibility.mutate()
        await waitForCompatibleWebBuild(options.httpOrigin)
        await options.reload?.()
      } catch (error) {
        setUpdateAction({ state: 'failed', detail: updateErrorDetail(error) })
      }
    }
  }, [
    localVersion,
    options.httpOrigin,
    options.reload,
    repairableMismatch,
    server.appVersion,
    target?.version,
    trpc,
  ])

  const actions = useMemo<UpdateActions>(() => {
    const install = nativeDesktopBridge()?.installUpdate
    const canInstallDesktop = desktopUpdate !== undefined || desktopTargeted
    const installApp =
      typeof install === 'function' && canInstallDesktop ? () => install() : undefined
    return {
      ...(options.reload && touched.app && !repairableMismatch ? { reload: options.reload } : {}),
      ...(installApp ? { installApp } : {}),
      ...(repairCompatibility ? { repairCompatibility } : {}),
      ...(startUpdate ? { startUpdate } : {}),
    }
  }, [
    desktopTargeted,
    desktopUpdate,
    options.reload,
    repairCompatibility,
    touched.app,
    startUpdate,
  ])

  const checkNow = async (): Promise<void> => {
    setManualCheck({ state: 'checking' })
    try {
      const next = await readDesktopUpdate(queryChannel)
      setDesktopUpdate(next)
      refreshFleet()
      const [serverRaw, localRaw] = await Promise.all([
        readJson(`${options.httpOrigin}/version`),
        readJson(`${options.httpOrigin}/${BUILD_STAMP_FILE}`),
      ])
      setServer(parseServerVersion(serverRaw))
      setLocalBuild(localBuildFrom(localRaw))
      setManualCheck({ state: 'current' })
    } catch (error) {
      setManualCheck({ state: 'failed', detail: updateErrorDetail(error) })
    }
  }

  const dismissManualCheck = (): void => {
    setManualCheck({ state: 'idle' })
  }

  const view: UpdateView =
    updateAction.state === 'in-progress'
      ? {
          state: 'in-progress',
          version: updateAction.version,
          done: updateAction.done,
          total: updateAction.total,
        }
      : updateAction.state === 'failed'
        ? describeUpdateFailure(updateAction.detail, updateAction.machineName)
        : manualCheck.state === 'checking'
          ? { state: 'checking' }
          : manualCheck.state === 'failed'
            ? describeUpdateFailure(manualCheck.detail)
            : manualCheck.state === 'current' && baseView.state === 'none'
              ? { state: 'current', version: localVersion }
              : baseView

  return { view, actions, server, fleet, checkNow, dismissManualCheck }
}
