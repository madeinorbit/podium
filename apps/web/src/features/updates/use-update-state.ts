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
import { describeUpdate, type UpdateInput, type UpdateView } from './update-view'

const BUILD_STAMP_FILE = 'podium-build.json'

export interface UpdateMachineState {
  id: string
  version: string
  state: 'current' | 'granted' | 'downloading' | 'restarting' | 'rejected' | 'stuck'
  online: boolean
  busy: boolean
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
  updateServer?: UpdateActions['updateServer']
}

interface LocalBuild {
  appVersion: string
  appDigest?: string
}

type ServerActionState =
  | { state: 'idle' }
  | { state: 'in-progress'; version: string; done: number; total: number }
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
    ...(typeof value.wireSchemaDigest === 'string'
      ? { appDigest: value.wireSchemaDigest }
      : {}),
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
  const [fleetState, setFleetState] = useState<UpdateFleetState>(
    options.fleet ?? EMPTY_FLEET,
  )
  const [serverAction, setServerAction] = useState<ServerActionState>({ state: 'idle' })
  const trpc = useMemo(() => makeTrpc(options.httpOrigin), [options.httpOrigin])

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

    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await trpc.updates.fleet.query()
        if (!cancelled) setFleetState(next)
      } catch {
        // The version dialog still has useful app/server information when the
        // fleet read is unavailable, so leave its last known snapshot intact.
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [options.fleet, trpc])

  const fleet = options.fleet ?? fleetState
  const localVersion = localBuild.appVersion
  const surface = options.surface ?? surfaceFromDesktopBridge()
  const target = server.target
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
  if (options.needRefresh) touched.app = true

  const skew = classifySkew(server, { wire: WIRE_VERSION, digest: wireSchemaDigest() })
  const input: UpdateInput = {
    localVersion,
    server,
    surface,
    serverName: options.serverName ?? defaultServerName(options.httpOrigin),
    fleet,
    touched,
    skew,
  }
  const baseView = describeUpdate(input)

  useEffect(() => {
    setServerAction({ state: 'idle' })
  }, [target?.version])

  const updateServer = useMemo<UpdateActions['updateServer']>(() => {
    if (!options.updateServer && (!target || !serverBehind)) return undefined
    const version = target?.version ?? localVersion
    const total = Math.max(1, 1 + fleet.behind)
    return async () => {
      setServerAction({ state: 'in-progress', version, done: 0, total })
      try {
        if (options.updateServer) {
          await options.updateServer()
          return
        }
        const result = await trpc.updates.converge.mutate()
        setFleetState(result.fleet)
        setServerAction({
          state: 'in-progress',
          version: result.version,
          done: result.done,
          total: result.total,
        })
      } catch (error) {
        setServerAction({ state: 'failed', detail: updateErrorDetail(error) })
      }
    }
  }, [fleet.behind, localVersion, options.updateServer, serverBehind, target, trpc])

  const actions = useMemo<UpdateActions>(() => {
    const bridge = nativeDesktopBridge() as
      | (ReturnType<typeof nativeDesktopBridge> & { installUpdate?: () => MaybePromise })
      | undefined
    const installApp =
      bridge && typeof bridge.installUpdate === 'function'
        ? () => bridge.installUpdate?.()
        : undefined
    return {
      ...(options.reload ? { reload: options.reload } : {}),
      ...(installApp ? { installApp } : {}),
      ...(updateServer ? { updateServer } : {}),
    }
  }, [options.reload, updateServer])

  const view: UpdateView =
    serverAction.state === 'in-progress'
      ? {
          state: 'in-progress',
          version: serverAction.version,
          done: serverAction.done,
          total: serverAction.total,
        }
      : serverAction.state === 'failed'
        ? { state: 'failed', detail: serverAction.detail }
        : baseView

  return { view, actions, server, fleet }
}

type MaybePromise = void | Promise<void>
