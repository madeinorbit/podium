/**
 * THE PANEL'S INPUTS (POD-2102, spec §6).
 *
 * What is left of this hook after the operation took over: it POLLS, it holds
 * this surface's local facts, and it DISPATCHES actions. It no longer decides
 * anything about the update — no client-side `done`/`total`, no optimistic
 * in-progress state fabricated at button-press time, and no wait loop spinning
 * inside a button for up to five silent minutes. Those three were the update's
 * three competing stories (spec §1.2/§1.3); the operation is the one story now.
 *
 * WHAT REMAINS LOCAL, and why each one has to be:
 *
 *  - the OFFER facts. An offer is not an operation (§3.2): before anyone presses
 *    anything there is nothing on the server to render, so the target from
 *    `/version`, the fleet snapshot and the desktop feed still make the "what
 *    would this update touch" copy. `describeUpdate` already does that well and
 *    is kept whole.
 *  - the LOCAL fact (P5/§3.5): is the build running THIS page behind the
 *    operation's target? Nobody else can answer it, and it is the only reason
 *    two tabs looking at one operation see different buttons.
 *  - the RENDER CLOCK. "No progress for 40 s" has to keep counting while the
 *    server says nothing at all — a liveness line that only moves when a poll
 *    lands cannot report the case it exists for.
 */
import {
  classifySkew,
  type Operation,
  parseBuildStamp,
  parseServerVersion,
  type ServerVersion,
  WIRE_VERSION,
  wireSchemaDigest,
} from '@podium/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { makeTrpc } from '@/app/trpc'
import { pageBuildVersion } from '@/lib/logging/build-version'
import {
  isNativeDesktopUpdateError,
  type NativeDesktopUpdateChannel,
  type NativeDesktopUpdateProgress,
  nativeDesktopBridge,
  onNativeDesktopUpdateProgress,
} from '@/lib/nativeDesktop'
import { RELOAD_BUDGET_SENTENCE, reloadBudgetSpent } from '@/lib/reload-budget'
import { usePolledQuery } from '@/lib/use-polled-query'
import {
  type ActionError,
  cancelRefusalSentence,
  isOperationActive,
  isOperationTerminal,
  operationView,
  type PrimaryActionKind,
  type UpdatePanelView,
  type UpdateSurface,
} from './operation-view'
import {
  cancelOperation,
  errorCode,
  errorMessage,
  readActiveOperation,
  readLatestOperation,
  retryUpdate,
  startUpdate,
} from './operations-client'
import { computeTouched } from './touched'
import {
  type DesktopUpdateInfo,
  describeUpdate,
  type UpdateInput,
  type UpdateView,
} from './update-view'

const BUILD_STAMP_FILE = 'podium-build.json'
/** An operation is moving: one second is worth a machine's time. */
const ACTIVE_POLL_MS = 1_000
/** Idle cadence: enough to recover a failed first read, quiet enough to ignore. */
const IDLE_POLL_MS = 30_000
/** The render clock, only while something is actually running. */
const CLOCK_MS = 1_000

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
  preparation?: {
    webReady: boolean
    bundleReady: boolean
    failureDetail?: string
  }
  targetVersion?: string | null
  machines?: readonly UpdateMachineState[]
  allMachines?: readonly UpdateMachineState[]
}

export type PanelActionKind = PrimaryActionKind | 'cancel'

export interface UseUpdateStateOptions {
  httpOrigin: string
  needRefresh: boolean
  reload?: () => void | Promise<void>
  surface?: UpdateSurface
  serverName?: string
  fleet?: UpdateFleetState
  /** Injected clock, so liveness is testable without waiting for real seconds. */
  now?: () => number
}

export interface UpdateStateResult {
  view: UpdatePanelView
  operation: Operation | null
  server: ServerVersion
  fleet: UpdateFleetState
  pending: PanelActionKind | null
  /** Every action goes through here, and every rejection comes back as view state. */
  run: (kind: PanelActionKind) => Promise<void>
  checkNow: () => Promise<void>
  /** The user has seen a terminal outcome: stop showing it (see `acknowledge`). */
  acknowledge: () => void
}

interface LocalBuild {
  appDigest?: string
  wireSchemaDigest?: string
}

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

function surfaceFromDesktopBridge(): UpdateSurface {
  const bridge = nativeDesktopBridge()
  if (!bridge) return window.location.pathname.startsWith('/mobile') ? 'mobile' : 'web'
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
  const stamp = parseBuildStamp(raw)
  return {
    ...(stamp.sourceSha ? { appDigest: stamp.sourceSha } : {}),
    ...(stamp.wireSchemaDigest ? { wireSchemaDigest: stamp.wireSchemaDigest } : {}),
  }
}

/**
 * Is the server's phone website built from something other than `expectedDigest`?
 *
 * ABSENT IS NOT BEHIND. A server that serves no phone website has nothing to
 * rebuild, and reading its silence as "stale" would leave Update permanently
 * offering work it cannot do.
 */
function phoneBehind(server: ServerVersion, expectedDigest: string): boolean {
  const phone = server.mobileWeb
  return phone?.present === true && phone.digest !== expectedDigest
}

/** The channel the SERVER decides (spec §5: resolved in exactly one place). */
function desktopChannelOf(channel: unknown): NativeDesktopUpdateChannel {
  const selected =
    typeof channel === 'string' ? channel : (channel as { channel?: string } | undefined)?.channel
  return selected === 'dev' || selected === 'edge' ? 'edge' : 'stable'
}

async function readDesktopUpdate(
  queryChannel: () => Promise<unknown>,
): Promise<{ info?: DesktopUpdateInfo; channel: NativeDesktopUpdateChannel }> {
  const channel = desktopChannelOf(await queryChannel().catch(() => 'stable'))
  const check = nativeDesktopBridge()?.checkUpdate
  if (!check) return { channel }
  const next = await check(channel)
  return {
    channel,
    ...(next
      ? { info: { version: next.version, critical: next.critical, notes: next.notes } }
      : {}),
  }
}

/**
 * ONE ARM'S FAILURE IS NOT THE READ'S FAILURE. Each fact the panel polls for is
 * separately unavailable — an unreachable fleet must not cost the panel the
 * operation it could read — and `Promise.all` would otherwise reject the batch
 * on the first one that broke. Catches a synchronous throw too, because a
 * transport that is not there yet throws rather than rejecting.
 */
async function safely<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

/**
 * THE OUTCOME THIS SURFACE STILL OWES THE USER.
 *
 * `operations.active` cannot answer it (terminal states are filtered out there),
 * so the outcome arrives from `history`, and this decides whether it is still
 * worth showing. Two different rules, because the two outcomes are not the same
 * kind of news:
 *
 *  - DONE is news only to a tab that WATCHED it run. A fresh tab opened an hour
 *    later has nothing to celebrate and nothing to do, and an "everything is
 *    fine" dot living in its toolbar is exactly the noise §6.1 removed.
 *  - FAILED is news to ANY tab, for a while. The page reloads during an update —
 *    that is a planned step — and a failure that vanished across that reload
 *    would be the dead end §6.2.5 forbids. It stays until acknowledged, or until
 *    the window passes and Settings → Updates becomes the place to look.
 */
const FAILURE_VISIBLE_MS = 15 * 60_000

function terminalToShow(
  latest: Operation | null,
  context: { watched: ReadonlySet<string>; acknowledged?: string; now: number },
): Operation | null {
  if (!latest || !isOperationTerminal(latest)) return null
  if (latest.id === context.acknowledged) return null
  if (latest.state === 'failed') {
    const finishedAt = latest.finishedAt ?? latest.updatedAt
    const recent = finishedAt === undefined || context.now - finishedAt <= FAILURE_VISIBLE_MS
    return recent ? latest : null
  }
  if (latest.state === 'done') return context.watched.has(latest.id) ? latest : null
  return null
}

/**
 * The acknowledgement survives a reload, deliberately: a failure the user has
 * already read and dismissed must not come back because they refreshed. Per
 * tab, like every other piece of panel UI state.
 */
const ACK_KEY = 'podium.update.acknowledged-operation'

function readAcknowledged(): string | undefined {
  try {
    return globalThis.sessionStorage?.getItem(ACK_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function writeAcknowledged(id: string): void {
  try {
    globalThis.sessionStorage?.setItem(ACK_KEY, id)
  } catch {
    // Private mode: the acknowledgement degrades to this tab's lifetime.
  }
}

/** Any thrown thing becomes the panel's three-layer failure (retired POD-2091). */
function toActionError(error: unknown): ActionError {
  if (isNativeDesktopUpdateError(error)) return { code: error.code, message: error.message }
  const code = errorCode(error)
  const message = errorMessage(error)
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(error instanceof Error && error.stack ? { detail: error.stack.split('\n')[0] } : {}),
  }
}

export function useUpdateState(options: UseUpdateStateOptions): UpdateStateResult {
  const [server, setServer] = useState<ServerVersion>({})
  const [localBuild, setLocalBuild] = useState<LocalBuild>({})
  const [fleetState, setFleetState] = useState<UpdateFleetState>(options.fleet ?? EMPTY_FLEET)
  const [live, setOperation] = useState<Operation | null>(null)
  const [latest, setLatest] = useState<Operation | null>(null)
  /** Operations THIS tab watched run. A completion is only news to those. */
  const watched = useRef<Set<string>>(new Set())
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateInfo | undefined>()
  const [desktopChannel, setDesktopChannel] = useState<NativeDesktopUpdateChannel>('stable')
  const [desktopProgress, setDesktopProgress] = useState<NativeDesktopUpdateProgress | undefined>()
  const [actionError, setActionError] = useState<ActionError | undefined>()
  const [note, setNote] = useState<string | undefined>()
  const [pending, setPending] = useState<PanelActionKind | null>(null)
  const [acknowledged, setAcknowledged] = useState<string | undefined>(() => readAcknowledged())
  const [checkedAt, setCheckedAt] = useState<number | undefined>()

  const clock = options.now ?? Date.now
  const [now, setNow] = useState<number>(() => clock())
  const trpc = useMemo(() => makeTrpc(options.httpOrigin), [options.httpOrigin])
  const queryChannel = useCallback((): Promise<unknown> => trpc.setup.channel.query(), [trpc])

  useEffect(() => {
    const claim = nativeDesktopBridge()?.claimUpdateOwnership
    if (claim) void claim().catch(() => {})

    let cancelled = false
    void readDesktopUpdate(queryChannel)
      .then(({ info, channel }) => {
        if (cancelled) return
        setDesktopUpdate(info)
        setDesktopChannel(channel)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [queryChannel])

  // The shell's own installer, which used to report nothing at all (spec §5).
  useEffect(() => onNativeDesktopUpdateProgress(setDesktopProgress), [])

  const active = isOperationActive(live)

  const query = usePolledQuery<{
    operation: Operation | null
    latest: Operation | null
    fleet: UpdateFleetState | null
    serverRaw: unknown
    buildRaw: unknown
  }>({
    key: `updates.operation:${options.httpOrigin}`,
    intervalMs: active ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    // HALF AN ANSWER IS STILL AN ANSWER: each arm resolves to its own "unknown"
    // rather than rejecting the batch, so an unreachable fleet never costs the
    // panel the operation it could read.
    read: async () => {
      const live = await safely<Operation>(() => readActiveOperation(trpc))
      const [latest, fleet, serverRaw, buildRaw] = await Promise.all([
        // The OUTCOME, which `active` cannot carry: it filters terminal states
        // out by design, so "done" and "failed" would blink out of existence at
        // the moment they became true. Only asked when nothing is running.
        live ? Promise.resolve(null) : safely<Operation>(() => readLatestOperation(trpc)),
        // The fleet snapshot only feeds the OFFER's place rows. While an
        // operation exists the operation's own steps say where it is, so this
        // stops asking rather than becoming a second opinion (P2). A caller
        // that supplied its own fleet is not asked either.
        live || options.fleet !== undefined
          ? Promise.resolve(null)
          : safely<UpdateFleetState>(() => trpc.updates.fleet.query()),
        readJson(`${options.httpOrigin}/version`),
        readJson(`${options.httpOrigin}/${BUILD_STAMP_FILE}`),
      ])
      return { operation: live, latest, fleet, serverRaw, buildRaw }
    },
    // Folded in the read's OWN turn: a reading routed through `data` and a
    // follow-up effect lands one flush late, and the panel is supposed to move
    // when the answer does.
    onData: ({ operation: live, latest, fleet, serverRaw, buildRaw }) => {
      if (live) watched.current.add(live.id)
      setOperation(live)
      setLatest(latest)
      if (serverRaw !== undefined) setServer(parseServerVersion(serverRaw))
      if (buildRaw !== undefined) setLocalBuild(localBuildFrom(buildRaw))
      if (fleet !== null) setFleetState(fleet)
      setNow(clock())
    },
  })

  const refresh = query.refresh

  // THE RENDER CLOCK. Only while something is moving: a panel showing an offer
  // has nothing that ages, and a timer running against a still surface is the
  // thing `usePolledQuery` exists to have removed.
  useEffect(() => {
    if (!active && pending === null) return
    const timer = window.setInterval(() => setNow(clock()), CLOCK_MS)
    return () => window.clearInterval(timer)
  }, [active, pending, clock])

  // What the panel is about right now: the running operation if there is one,
  // otherwise the outcome of the last one while it is still the user's business.
  const operation =
    live ??
    terminalToShow(latest, {
      watched: watched.current,
      ...(acknowledged ? { acknowledged } : {}),
      now,
    })

  // A NEW OPERATION CLEARS THE LAST ONE'S WRECKAGE. Retry creates a new
  // operation (§3.2), so a stale action-error hanging over it would report the
  // previous failure on top of the new attempt.
  const operationId = operation?.id
  const previousOperationId = useRef<string | undefined>(operationId)
  useEffect(() => {
    if (previousOperationId.current === operationId) return
    previousOperationId.current = operationId
    setActionError(undefined)
    setNote(undefined)
  }, [operationId])

  const fleet = options.fleet ?? fleetState
  const surface = options.surface ?? surfaceFromDesktopBridge()
  const localVersion = pageBuildVersion()
  const target = server.target
  const desktopTargeted = surface !== 'web' && target?.artifacts.desktop !== undefined
  const serverBehind = Boolean(
    target?.version !== undefined &&
      server.appVersion !== undefined &&
      server.appVersion !== target.version,
  )
  const targetWebDigest = target?.artifacts.web?.digest
  const phoneStale = targetWebDigest !== undefined && phoneBehind(server, targetWebDigest)
  const skew = classifySkew(server, { wire: WIRE_VERSION, digest: wireSchemaDigest() })

  const touched = target
    ? computeTouched({
        localDigests: { ...(localBuild.appDigest ? { app: localBuild.appDigest } : {}) },
        target,
        fleetBehind: fleet.behind,
        serverBehind,
        sourceAppFollowsServer:
          (surface === 'web' || surface === 'mobile') && target.version.startsWith('dev+'),
        phoneBehind: phoneStale,
      })
    : { app: false, server: serverBehind, machines: fleet.behind > 0, phone: false }
  if (options.needRefresh || desktopUpdate !== undefined || desktopTargeted) touched.app = true

  const offerInput: UpdateInput = {
    localVersion,
    server,
    surface,
    serverName: options.serverName ?? defaultServerName(options.httpOrigin),
    fleet,
    touched,
    skew,
    ...(desktopUpdate ? { desktopUpdate } : {}),
  }
  /**
   * A manual check is the one time the panel says "nothing to do". It is asked
   * for explicitly (the macOS menu, `__PODIUM_CHECK_UPDATES__`), so silence
   * would read as a broken menu item — but it is never volunteered, which is
   * why it is not part of `describeUpdate`.
   */
  const described = describeUpdate(offerInput)
  const offer: UpdateView =
    pending === 'check'
      ? { state: 'checking' }
      : checkedAt !== undefined && described.state === 'none'
        ? { state: 'current', version: localVersion }
        : described

  /**
   * THE ONE LOCAL FACT (§3.5). Deliberately about the build running THIS PAGE —
   * `pageBuildVersion()` reads the page's own meta tag — and not about the
   * served dist, which is the server's business and is already a step of the
   * operation. A service worker holding a newer build is the same fact arriving
   * by another route.
   */
  const operationTarget = ((operation?.details as { target?: { version?: unknown } } | undefined)
    ?.target?.version ?? undefined) as string | undefined
  const behind =
    options.needRefresh ||
    skew !== 'ok' ||
    (operationTarget !== undefined && operationTarget !== localVersion)

  const installUpdate = nativeDesktopBridge()?.installUpdate
  const canInstallDesktop =
    typeof installUpdate === 'function' && (desktopUpdate !== undefined || desktopTargeted)

  /**
   * The silent hard-reload budget, explained after the fact (spec §6.2.3). The
   * guard keeps its two attempts — it is the corruption backstop — but a person
   * whose page reloaded itself twice and still does not match the server is
   * owed a sentence about it, and the panel is where that sentence belongs.
   */
  const budgetNote = useMemo(
    () => (skew !== 'ok' && reloadBudgetSpent() ? RELOAD_BUDGET_SENTENCE : undefined),
    [skew],
  )

  const view = operationView({
    operation,
    offer,
    local: { behind, canReload: options.reload !== undefined, canInstallDesktop },
    surface,
    now,
    ...(desktopProgress && pending === 'install-desktop' ? { desktopProgress } : {}),
    ...(actionError ? { actionError } : {}),
    ...((note ?? budgetNote) ? { note: note ?? budgetNote } : {}),
  })

  const run = useCallback(
    async (kind: PanelActionKind): Promise<void> => {
      setPending(kind)
      setNote(undefined)
      setActionError(undefined)
      try {
        switch (kind) {
          case 'start':
            await startUpdate(trpc)
            break
          case 'retry':
            await retryUpdate(trpc, operationId)
            break
          case 'cancel': {
            if (!operationId) break
            const outcome = await cancelOperation(trpc, operationId)
            if (!outcome.canceled) {
              setNote(cancelRefusalSentence(outcome.refused ?? 'irreversible', outcome.step))
            }
            break
          }
          case 'reload':
            await options.reload?.()
            break
          case 'install-desktop':
          case 'restart-app': {
            const install = nativeDesktopBridge()?.installUpdate
            if (install) await install(desktopChannel)
            break
          }
          case 'check':
            await trpc.updates.checkNow.mutate()
            break
        }
        refresh()
      } catch (error) {
        // EVERY rejection lands here. This is the catch the old `runAction`
        // never had: a refused `installUpdate` used to stop a spinner and say
        // nothing at all.
        setActionError(toActionError(error))
      } finally {
        setPending(null)
        setDesktopProgress(undefined)
      }
    },
    [desktopChannel, operationId, options.reload, refresh, trpc],
  )

  const checkNow = useCallback(async (): Promise<void> => {
    setPending('check')
    setActionError(undefined)
    try {
      await trpc.updates.checkNow.mutate().catch(() => {})
      const { info, channel } = await readDesktopUpdate(queryChannel)
      setDesktopUpdate(info)
      setDesktopChannel(channel)
      setCheckedAt(clock())
      refresh()
    } catch (error) {
      setActionError(toActionError(error))
    } finally {
      setPending(null)
    }
  }, [clock, queryChannel, refresh, trpc])

  /**
   * "I have seen this outcome." Clears a local action error and, for a terminal
   * operation, stops it coming back — which is what makes Hide honest on a
   * failure and what lets a finished update's indicator clear itself.
   */
  const acknowledge = useCallback((): void => {
    setActionError(undefined)
    if (!live && operationId) {
      setAcknowledged(operationId)
      writeAcknowledged(operationId)
    }
  }, [live, operationId])

  return {
    view,
    operation,
    server,
    fleet,
    pending,
    run,
    checkNow,
    acknowledge,
  }
}
