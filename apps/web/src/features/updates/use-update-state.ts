import { useEffect, useMemo, useState } from 'react'
import {
  classifySkew,
  parseServerVersion,
  type ServerVersion,
  WIRE_VERSION,
  wireSchemaDigest,
} from '@podium/protocol'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { makeTrpc } from '@/app/trpc'
import type { UpdateActions } from './UpdateDialog'
import { computeTouched } from './touched'
import {
  describeUpdate,
  describeUpdateFailure,
  type DesktopUpdateInfo,
  type UpdateInput,
  type UpdateView,
} from './update-view'

const BUILD_STAMP_FILE = 'podium-build.json'
const FLEET_POLL_MS = 1_000

export interface UpdateMachineState {
  id: string
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
  appVersion: string
  appDigest?: string
}

type UpdateActionState =
  | { state: 'idle' }
  | {
      state: 'in-progress'
      version: string
      done: number
      total: number
      includesServer: boolean
    }
  | { state: 'failed'; detail: string }

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

function localBuildFrom(raw: unknown): LocalBuild {
  if (!raw || typeof raw !== 'object') return { appVersion: 'dev' }
  const value = raw as { appVersion?: unknown; wireSchemaDigest?: unknown }
  return {
    appVersion: typeof value.appVersion === 'string' ? value.appVersion : 'dev',
    ...(typeof value.wireSchemaDigest === 'string' ? { appDigest: value.wireSchemaDigest } : {}),
  }
}

function updateErrorDetail(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; data?: { message?: unknown } }
    if (typeof value.data?.message === 'string') return value.data.message
    if (typeof value.message === 'string' && value.message.length > 0) return value.message
  }
  return 'The server could not start this update.'
}

export interface UpdateStateResult {
  view: UpdateView
  actions: UpdateActions
  server: ServerVersion
  fleet: UpdateFleetState
}

/** Gather the four facts that make the update story: this build, the server
 * descriptor, fleet convergence, and the surface currently showing the dialog. */
export function useUpdateState(options: UseUpdateStateOptions): UpdateStateResult {
  const [server, setServer] = useState<ServerVersion>({})
  const [localBuild, setLocalBuild] = useState<LocalBuild>({ appVersion: 'dev' })
  const [fleetState, setFleetState] = useState<UpdateFleetState>(options.fleet ?? EMPTY_FLEET)
  const [updateAction, setUpdateAction] = useState<UpdateActionState>({ state: 'idle' })
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateInfo | undefined>()
  const trpc = useMemo(() => makeTrpc(options.httpOrigin), [options.httpOrigin])
  useEffect(() => {
    const bridge = nativeDesktopBridge()
    const claim = bridge?.claimUpdateOwnership
    if (claim) void claim().catch(() => {})

    const check = bridge?.checkUpdate
    if (!check) return

    let cancelled = false
    const channel = trpc.setup.channel.query().catch(() => 'stable' as const)
    void channel
      .then((selected) => check(selected))
      .then((next) => {
        if (!cancelled) setDesktopUpdate(next ?? undefined)
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

  useEffect(() => {
    if (options.fleet !== undefined) return

    const active = updateAction.state === 'in-progress' || fleetState.converging > 0
    let cancelled = false
    let inFlight = false
    const load = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const [next, serverRaw] = await Promise.all([
          trpc.updates.fleet.query(),
          active ? readJson(options.httpOrigin + '/version') : Promise.resolve(undefined),
        ])
        if (cancelled) return
        setFleetState(next)

        if (active) {
          const nextServer = parseServerVersion(serverRaw)
          if (serverRaw !== undefined) setServer(nextServer)
          setUpdateAction((current) => {
            if (current.state !== 'in-progress') return current
            if (next.failed > 0) {
              const failure = next.machines?.find(
                (machine) => machine.state === 'rejected' || machine.state === 'stuck',
              )
              return {
                state: 'failed',
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
            if (next.converging === 0 && remaining === 0) return { state: 'idle' }
            const done = Math.max(0, Math.min(current.total, current.total - remaining))
            return {
              state: 'in-progress',
              version: next.targetVersion ?? current.version,
              done,
              total: current.total,
              includesServer: current.includesServer,
            }
          })
        }
      } catch {
        // The version dialog still has useful app/server information when the
        // fleet read is unavailable, so leave its last known snapshot intact.
      } finally {
        inFlight = false
      }
    }
    void load()
    if (!active) return
    const interval = window.setInterval(() => void load(), FLEET_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [fleetState.converging, options.fleet, options.httpOrigin, updateAction.state, trpc])

  const fleet = options.fleet ?? fleetState
  const localVersion = localBuild.appVersion
  const surface = options.surface ?? surfaceFromDesktopBridge()
  const target = server.target
  const desktopTargeted = surface !== 'web' && target?.artifacts.desktop !== undefined
  const serverBehind = Boolean(
    target?.version !== undefined &&
      server.appVersion !== undefined &&
      server.appVersion !== target.version,
  )
  const touched = target
    ? computeTouched({
        localDigests: { ...(localBuild.appDigest ? { app: localBuild.appDigest } : {}) },
        target,
        fleetBehind: fleet.behind,
        serverBehind,
      })
    : { app: false, server: serverBehind, machines: fleet.behind > 0 }
  if (options.needRefresh || desktopUpdate !== undefined || desktopTargeted) touched.app = true

  const skew = classifySkew(server, { wire: WIRE_VERSION, digest: wireSchemaDigest() })
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
  const startUpdate = useMemo<UpdateActions['startUpdate']>(() => {
    if (
      !options.startUpdate &&
      !retryableUpdateFailure &&
      (!target || (!serverBehind && fleet.behind === 0))
    )
      return undefined
    const version = target?.version ?? localVersion
    const includesServer = serverBehind
    const total = Math.max(1, (includesServer ? 1 : 0) + fleet.behind)
    return async () => {
      setUpdateAction({ state: 'in-progress', version, done: 0, total, includesServer })
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
        })
      } catch (error) {
        setUpdateAction({ state: 'failed', detail: updateErrorDetail(error) })
      }
    }
  }, [
    fleet.behind,
    localVersion,
    options.startUpdate,
    retryableUpdateFailure,
    serverBehind,
    target,
    trpc,
  ])

  const actions = useMemo<UpdateActions>(() => {
    const install = nativeDesktopBridge()?.installUpdate
    const canInstallDesktop = desktopUpdate !== undefined || desktopTargeted
    const installApp =
      typeof install === 'function' && canInstallDesktop ? () => install() : undefined
    return {
      ...(options.reload && touched.app ? { reload: options.reload } : {}),
      ...(installApp ? { installApp } : {}),
      ...(startUpdate ? { startUpdate } : {}),
    }
  }, [desktopTargeted, desktopUpdate, options.reload, touched.app, startUpdate])

  const view: UpdateView =
    updateAction.state === 'in-progress'
      ? {
          state: 'in-progress',
          version: updateAction.version,
          done: updateAction.done,
          total: updateAction.total,
        }
      : updateAction.state === 'failed'
        ? describeUpdateFailure(updateAction.detail)
        : baseView

  return { view, actions, server, fleet }
}
