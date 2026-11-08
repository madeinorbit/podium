/**
 * THE PANEL'S INPUTS (POD-2102, spec §6).
 *
 * What is left of this hook after the operation took over: it READS the one
 * update-status reader (`lib/update-status.ts`, POD-6683), it holds this
 * surface's local facts, and it DISPATCHES actions. It polls nothing itself, and
 * its caller must be an `observer` so the reader's state redraws it. It no longer decides
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
 *    lands cannot report the case it exists for. It is the shared clock, read
 *    only while something is moving.
 */
import {
  buildsDiffer,
  CLIENT_WIRE_VERSION,
  classifyAssets,
  classifySkew,
  isDevChannelVersion,
  type Operation,
  type ReleaseProposal,
  ReleaseProposal as ReleaseProposalSchema,
  type ServerVersion,
  wireSchemaDigest,
} from '@podium/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isServerUnavailable } from '@/app/trpc'
import { useClock, useDeadlineNow } from '@/lib/clock-hooks'
import { pageBuildDigest, pageBuildVersion, pageBundleVersion } from '@/lib/logging/build-version'
import { updatesLog } from '@/lib/logging/update-logs'
import {
  isNativeDesktopUpdateError,
  type NativeDesktopUpdateChannel,
  type NativeDesktopUpdateProgress,
  nativeDesktopBridge,
  onNativeDesktopUpdateProgress,
  persistNativeDesktopUpdateChannel,
} from '@/lib/nativeDesktop'
import { pageSurface } from '@/lib/page-surface'
import { RELOAD_BUDGET_SENTENCE, reloadBudgetSpent } from '@/lib/reload-budget'
import { servedWebsiteForPage } from '@/lib/served-website'
import { type AwaitedOperation, updateStatus } from '@/lib/update-status'
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
  errorDetail,
  errorMessage,
  isUpdateRequestTimeout,
  retryUpdate,
  type StartUpdateOutcome,
  startUpdate,
} from './operations-client'
import { computeTouched } from './touched'
import {
  type DesktopUpdateInfo,
  describeUpdate,
  type UpdateInput,
  type UpdateView,
} from './update-view'

/** The render clock's precision, read only while something is actually running. */
const CLOCK_MS = 1_000
/** How long an action waits to see the operation it started. */
const OBSERVATION_WAIT_MS = 90_000

export interface UpdateMachineState {
  id: string
  name?: string
  version: string
  installKind?: string
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
  blocked?: number
  blockers?: readonly {
    id: string
    name?: string
    reason: 'legacy-instance-trust'
  }[]
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
  reload?: () => void | Promise<void>
  surface?: UpdateSurface
  serverName?: string
  fleet?: UpdateFleetState
  /** Injected clock, so liveness is testable without waiting for real seconds. */
  now?: () => number
}

export interface UpdateStateResult {
  view: UpdatePanelView
  /** `undefined` until the first successful operation read. */
  operation: Operation | null | undefined
  server: ServerVersion
  fleet: UpdateFleetState
  pending: PanelActionKind | null
  proposal: ReleaseProposal | null | undefined
  proposalPending: boolean
  proposalError?: string
  approveProposal: () => Promise<void>
  /** Every action goes through here, and every rejection comes back as view state. */
  run: (kind: PanelActionKind) => Promise<void>
  /** Refresh polled facts without a manual update check or desktop feed check. */
  refreshState: () => void
  checkNow: () => Promise<void>
  /** The user has seen a terminal outcome: stop showing it (see `acknowledge`). */
  acknowledge: () => void
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

/**
 * The surface this page is. Moved to `lib/page-surface.ts` (POD-3224) so the
 * boot record can state it before this chunk is even fetched; re-exported under
 * its original name because that is what the panel and its tests call it.
 */
export function surfaceFromDesktopBridge(): UpdateSurface {
  return pageSurface()
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
export function desktopChannelOf(channel: unknown): NativeDesktopUpdateChannel | undefined {
  const selected =
    typeof channel === 'string' ? channel : (channel as { channel?: string } | undefined)?.channel
  if (selected === 'dev' || selected === 'edge' || selected === 'stable') return selected
  return undefined
}

const UNKNOWN_DESKTOP_CHANNEL = 'The desktop update channel could not be determined.'

/**
 * Leave restart recovery to the query transport: it waits for readiness and
 * replays this idempotent read. A failure or an unfamiliar payload stays
 * unread; neither is permission to choose a feed.
 */
async function readDesktopChannel(queryChannel: () => Promise<unknown>): Promise<{
  channel: NativeDesktopUpdateChannel
  endpoint: string | undefined
}> {
  const raw = await queryChannel()
  const channel = desktopChannelOf(raw)
  if (channel === undefined) throw new Error(UNKNOWN_DESKTOP_CHANNEL)
  const endpoint =
    raw &&
    typeof raw === 'object' &&
    typeof (raw as { desktopUpdateEndpoint?: unknown }).desktopUpdateEndpoint === 'string'
      ? (raw as { desktopUpdateEndpoint: string }).desktopUpdateEndpoint
      : undefined
  return { channel, endpoint }
}

async function readDesktopUpdate(selection: {
  channel: NativeDesktopUpdateChannel
  endpoint: string | undefined
}): Promise<DesktopUpdateInfo | undefined> {
  await persistNativeDesktopUpdateChannel(selection.channel, selection.endpoint)
  const check = nativeDesktopBridge()?.checkUpdate
  if (!check) return undefined
  const next = await check(selection.channel)
  return next ? { version: next.version, critical: next.critical, notes: next.notes } : undefined
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
  context: { watched: (id: string) => boolean; acknowledged?: string; now: number },
): Operation | null {
  if (!latest || !isOperationTerminal(latest)) return null
  if (latest.id === context.acknowledged) return null
  if (latest.state === 'failed') {
    const finishedAt = latest.finishedAt ?? latest.updatedAt
    const recent = finishedAt === undefined || context.now - finishedAt <= FAILURE_VISIBLE_MS
    return recent ? latest : null
  }
  if (latest.state === 'done') return context.watched(latest.id) ? latest : null
  return null
}

/**
 * WATCHING IT RUN HAS TO SURVIVE THE PROCESS DYING (§3.4, POD-2104).
 *
 * `watched` is what makes a finished operation news to the tab that saw it and
 * silence to a stranger, and an in-memory Set says that correctly for every
 * surface except the one whose update is a RESTART. In the all-in-one flow the
 * user presses Restart Podium, the shell installs and execs, and the page that
 * watched the operation is gone — along with `watched`, and with sessionStorage
 * too, which the new webview process does not inherit. The successor server
 * adopts the operation and reports `done`; the reloaded page has never heard of
 * it and renders nothing. One click, one restart, and no confirmation that any
 * of it worked — the acceptance line this exists to satisfy.
 *
 * So the id is handed across the restart in localStorage, and BOUNDED: this is
 * a handoff between two lives of the same app, not a memory of what this
 * machine has ever seen. A window wide enough for an install and relaunch keeps
 * "a fresh tab an hour later has nothing to celebrate" true (§6.2).
 *
 * ─── THIS IS A DECLARED EXCEPTION TO ui-storage-ownership (POD-2219) ─────────
 *
 * The two accessors below are the ONLY raw storage access this epic added, and
 * `lint:architecture` names this file for them. POD-329 reserves localStorage
 * methods for `packages/client-core/src/ui-state.ts` and the replica adapter
 * family, and it is right to: a feature reading a key ad hoc is how a
 * persistence model stops being one. It is recorded HERE rather than in
 * `scripts/boundary-allowlist.ts` because that file is asserted EMPTY by
 * `scripts/architecture-manifest.test.ts`, and because a `ui-storage-ownership`
 * entry could not excuse the manifest lane anyway — `partitionAllowlist` routes
 * this rule's entries to the legacy family while `checkManifestFile` emits its
 * violations into the manifest one. Both are noted in POD-2225.
 *
 * WHY IT IS NOT SIMPLY MOVED, stated so the next reader does not have to
 * rediscover it. Every home ui-state offers is closed to this key by a guard
 * that exists for a reason:
 *
 *  - A second raw accessor INSIDE `ui-state.ts` fails its own audit — that
 *    module is allowed exactly one unnamespaced writer, the pre-auth theme.
 *  - Joining the PRE-AUTH family fails the converse check, which pins that
 *    family to the theme keys precisely because a read before a principal
 *    exists is the one thing the fail-closed provider cannot police.
 *  - A DEVICE-LOCAL UiState key is principal-bound (`principal-storage.ts`
 *    prefixes the replica's keys), and a value that resolves late or not at all
 *    degrades to `null` — which is silence, the exact failure this code exists
 *    to prevent.
 *
 * The real resolution is POD-2225, and its first obligation is the measurement
 * none of the above settles: whether the store is reliably present, with the
 * right principal, wherever this panel mounts after a restart. Until that is
 * ANSWERED rather than assumed, moving the key would trade a lint line for a
 * broken acceptance line.
 *
 * THE COUNT IS ONE, and this note licenses no second. Another key that wants
 * this treatment is POD-2225's problem, not this comment's precedent.
 */
const WATCHED_KEY = 'podium.update.watched-operation'
const WATCHED_HANDOFF_MS = 5 * 60_000

function rememberWatched(id: string, now: number): void {
  try {
    globalThis.localStorage?.setItem(WATCHED_KEY, JSON.stringify({ id, at: now }))
  } catch {
    // Private mode or a storage-less embedder: the handoff degrades to nothing,
    // which is exactly the behaviour that shipped before it existed.
  }
}

function watchedHandoff(now: number): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(WATCHED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { id?: unknown; at?: unknown }
    if (typeof parsed.id !== 'string' || typeof parsed.at !== 'number') return []
    return now - parsed.at <= WATCHED_HANDOFF_MS ? [parsed.id] : []
  } catch {
    return []
  }
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
  const detail = errorDetail(error)
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(detail ? { detail } : {}),
  }
}

/**
 * ONE LINE WHEN A VERDICT MOVES, AND NONE WHILE IT HOLDS (POD-3224).
 *
 * The panel recomputes its inputs on every poll — once a second while an update
 * is running — so logging them on each pass would put a record a second on the
 * forwarded stream for the whole of the thing being diagnosed. Logging only the
 * TRANSITIONS keeps the volume at the number of times the answer actually
 * changed, which for a whole update is a handful, and that is the property that
 * makes an `info` floor on `web:updates` affordable.
 *
 * Deliberately keyed on the VERDICTS and not on the operation's progress: a step
 * going from 2/5 to 3/5 is the operation's own record on the server, and
 * repeating it here would reintroduce the per-second stream by another route.
 */
function changeReporter(): (signature: string, emit: () => void) => void {
  let last: string | undefined
  return (signature, emit) => {
    if (signature === last) return
    last = signature
    emit()
  }
}

export function useUpdateState(options: UseUpdateStateOptions): UpdateStateResult {
  /**
   * THE ONE READER (POD-6683). Its readings are this panel's server facts: the
   * operation, the outcome, the fleet, `/version`, this page's build stamp and
   * the release proposal. It polls only while something moves or an update
   * screen is open, on plain HTTP, whatever the socket and the replica are doing.
   */
  const status = useMemo(() => updateStatus(options.httpOrigin), [options.httpOrigin])
  useEffect(() => status.start(), [status])
  const trpc = status.trpc
  const live = status.operation
  const latest = status.latest
  const server = status.server
  const localBuild = status.build
  const proposal = status.proposal
  /**
   * Operations THIS tab watched run. A completion is only news to those. The
   * reader remembers what this tab saw; the seed is what carries that across a
   * shell restart (see `watchedHandoff`).
   */
  const handoff = useRef<ReadonlySet<string>>(new Set(watchedHandoff(Date.now())))
  const wasWatched = (id: string): boolean => handoff.current.has(id) || status.watched.has(id)
  const lastWatched = status.lastWatched
  useEffect(() => {
    if (lastWatched) rememberWatched(lastWatched.id, lastWatched.at)
  }, [lastWatched])
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateInfo | undefined>()
  const [desktopChannel, setDesktopChannel] = useState<NativeDesktopUpdateChannel | undefined>()
  const [desktopProgress, setDesktopProgress] = useState<NativeDesktopUpdateProgress | undefined>()
  const [actionError, setActionError] = useState<ActionError | undefined>()
  const [note, setNote] = useState<string | undefined>()
  const [pressed, setPressed] = useState<PanelActionKind | null>(null)
  /** A start or retry stays pending until the reader sees its operation. */
  const pending: PanelActionKind | null = pressed ?? status.awaiting?.kind ?? null
  const [proposalPending, setProposalPending] = useState(false)
  const [proposalError, setProposalError] = useState<string | undefined>()
  const [acknowledged, setAcknowledged] = useState<string | undefined>(() => readAcknowledged())
  const [checkedAt, setCheckedAt] = useState<number | undefined>()

  /** Change gates. Refs, so they survive a re-render and belong to this hook. */
  const reportInputs = useRef(changeReporter())
  const reportOperation = useRef(changeReporter())
  const queryChannel = useCallback((): Promise<unknown> => trpc.setup.channel.query(), [trpc])

  useEffect(() => {
    const claim = nativeDesktopBridge()?.claimUpdateOwnership
    if (claim) void claim().catch(() => {})

    let cancelled = false
    void readDesktopChannel(queryChannel)
      .then(async (selection) => {
        if (cancelled) return
        setDesktopChannel(selection.channel)
        const info = await readDesktopUpdate(selection)
        if (!cancelled) setDesktopUpdate(info)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [queryChannel])

  // The shell's own installer, which used to report nothing at all (spec §5).
  useEffect(() => onNativeDesktopUpdateProgress(setDesktopProgress), [])

  const waiting = status.awaiting !== null
  useEffect(() => {
    if (!waiting) return
    const timer = window.setTimeout(() => {
      status.stopAwaiting()
      setActionError({ message: 'The update could not be confirmed. Try again.' })
    }, OBSERVATION_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [status, waiting])

  const active = isOperationActive(live) || proposal?.state === 'building' || waiting

  const refresh = useCallback((): void => {
    void status.refresh()
  }, [status])

  const acceptStartOutcome = useCallback(
    (
      kind: AwaitedOperation['kind'],
      baseline: AwaitedOperation['baseline'],
      outcome?: StartUpdateOutcome,
    ): void => {
      if (outcome?.operation) {
        status.noteOperation(outcome.operation, Date.now())
        if (outcome.operationId) status.markWatched(outcome.operationId, Date.now())
      } else {
        status.expectOperation({
          kind,
          recoveryWithoutId: !outcome?.operationId,
          baseline,
          ...(outcome?.operationId ? { operationId: outcome.operationId } : {}),
        })
      }
    },
    [status],
  )

  // THE RENDER CLOCK: the shared one, ticking only while something is moving.
  // A panel showing an offer has nothing that ages; a recent failure retires at
  // its exact deadline instead of on a timer.
  const tickingNow = useClock(CLOCK_MS, active || pending !== null)
  const failureFinishedAt =
    latest?.state === 'failed' ? (latest.finishedAt ?? latest.updatedAt) : undefined
  const failureDeadline =
    failureFinishedAt !== undefined && latest?.id !== acknowledged
      ? failureFinishedAt + FAILURE_VISIBLE_MS + 1
      : undefined
  const deadlineNow = useDeadlineNow(failureDeadline)
  const now = options.now?.() ?? Math.max(tickingNow, deadlineNow)

  // What the panel is about right now: the running operation if there is one,
  // otherwise the outcome of the last one while it is still the user's business.
  const operation =
    live === undefined
      ? undefined
      : (live ??
        (latest === undefined
          ? undefined
          : terminalToShow(latest, {
              watched: wasWatched,
              ...(acknowledged ? { acknowledged } : {}),
              now,
            })))

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

  const fleetFact: UpdateFleetState | undefined = options.fleet ?? status.fleet
  // The concrete fallback keeps the public result and pure offer computation
  // ergonomic; `fleetFact` below decides whether those values are established
  // facts and therefore renderable.
  const fleet = fleetFact ?? EMPTY_FLEET
  const surface = options.surface ?? surfaceFromDesktopBridge()
  const localVersion = pageBuildVersion()
  const target = server.target
  const desktopTargeted = surface !== 'web' && target?.artifacts.desktop !== undefined
  const targetWebDigest = target?.artifacts.web?.digest
  const serverDiffers = target
    ? buildsDiffer(
        { version: server.appVersion, digest: server.sourceDigest },
        { version: target.version, digest: targetWebDigest },
      )
    : false
  const sourceCannotTakeTarget = server.installKind === 'source' && serverDiffers
  const serverBehind = server.installKind !== 'source' && serverDiffers
  const phoneStale = targetWebDigest !== undefined && phoneBehind(server, targetWebDigest)
  const skew = classifySkew(server, { wire: CLIENT_WIRE_VERSION, digest: wireSchemaDigest() })
  /**
   * Is the website this page was loaded from still the one being served?
   * (POD-2721 — see `behind` below for why this is a fact of its own.)
   *
   * `servedWebsiteForPage` is what keeps this from becoming an offer nobody can
   * clear: it answers only for a page this origin actually served, and only with
   * the dist that page belongs to. A baked desktop shell and an iteration-mode
   * page get `undefined`, because their assets are somewhere a reload cannot
   * reach.
   */
  const assets = classifyAssets(servedWebsiteForPage(server, options.httpOrigin), {
    bundle: pageBundleVersion(),
  })

  const touched = target
    ? computeTouched({
        localDigests: { ...(localBuild.appDigest ? { app: localBuild.appDigest } : {}) },
        target,
        fleetBehind: fleet.behind,
        serverBehind,
        sourceAppFollowsServer:
          (surface === 'web' || surface === 'mobile') && isDevChannelVersion(target.version),
        phoneBehind: phoneStale,
      })
    : { app: false, server: serverBehind, machines: fleet.behind > 0, phone: false }
  if (sourceCannotTakeTarget) {
    // A source checkout cannot turn target package bytes into a new checkout.
    // Keep packaged fleet consumers in the offer, but promise no local move.
    touched.app = false
    touched.phone = false
  }
  if (desktopUpdate !== undefined || desktopTargeted) touched.app = true

  const offerInput: UpdateInput = {
    localVersion,
    server,
    surface,
    serverName: options.serverName ?? defaultServerName(options.httpOrigin),
    fleet,
    touched,
    skew,
    ...(desktopUpdate ? { desktopUpdate } : {}),
    ...(assets === 'replaced' ? { assetsReplaced: true } : {}),
  }
  /**
   * A manual check is the one time the panel says "nothing to do". It is asked
   * for explicitly (the macOS menu, `__PODIUM_CHECK_UPDATES__`), so silence
   * would read as a broken menu item — but it is never volunteered, which is
   * why it is not part of `describeUpdate`.
   */
  const described = describeUpdate(offerInput)
  const offer: UpdateView | null =
    pending === 'check'
      ? { state: 'checking' }
      : described.state === 'local-stale'
        ? described
        : operation === undefined || (operation === null && fleetFact === undefined)
          ? null
          : checkedAt !== undefined && described.state === 'none'
            ? { state: 'current', version: localVersion }
            : described
  /**
   * THE ONE LOCAL FACT (§3.5). Deliberately about the build running THIS PAGE —
   * `pageBuildVersion()` reads the page's own meta tag — and not about the
   * served dist, which is the server's business and is already a step of the
   * operation. Service-worker notifications only nudge a fresh poll; they do
   * not establish that this page is stale.
   *
   * -------------------------------------------------------------------------
   * WHY THE SERVED BUNDLE IS ONE OF THE REASONS (POD-2721)
   * -------------------------------------------------------------------------
   *
   * The operation comparison below is the RIGHT question asked with a currency
   * that cannot always answer it. `buildsDiffer` reads source digests first, so
   * two builds of ONE commit are equal to it — and the first successful
   * end-to-end update was exactly that: a packaged `0.1.1-edge.2` replaced by a
   * dev release `0.1.1-dev.1+a55ec3d`, both from `a55ec3d`. It said "not behind"
   * about a page whose every unloaded chunk had just been deleted, and the panel
   * offered nothing until the interface crashed. That digest short-circuit is
   * POD-2608's fix for the opposite failure and it stays; what it needed was a
   * fact of its own currency.
   *
   * Two other things the served bundle fixes, both structural:
   *
   *  - IT DOES NOT NEED AN OPERATION. Every route to a reload used to run
   *    through `operation.details.target`, so a tab that was not watching the
   *    update — a second window, a phone, a tab opened afterwards — could not be
   *    told at all. What the server is serving is a fact about the server, and
   *    every tab reads the same one.
   *  - IT IS SYMMETRIC. `replaced` is an inequality, not an ordering, so a page
   *    stranded by a ROLLBACK is offered the same reload as one stranded by an
   *    update. POD-2721 produced one crash of each kind, ninety seconds apart.
   */
  const operationTarget = (
    operation?.details as
      | { target?: { version?: string; artifacts?: { web?: { digest?: string } } } }
      | undefined
  )?.target
  const operationTargetVersion = operationTarget?.version
  const behind =
    skew !== 'ok' ||
    assets === 'replaced' ||
    (operationTargetVersion !== undefined &&
      buildsDiffer(
        { version: localVersion, digest: pageBuildDigest() },
        { version: operationTargetVersion, digest: operationTarget?.artifacts?.web?.digest },
      ))

  const installUpdate = nativeDesktopBridge()?.installUpdate
  /**
   * THE OPERATION'S ASK OUTRANKS THE OFFER-TIME CHECK (§3.5, §5).
   *
   * The other two facts here are both answers to "did anything tell us, before
   * this started, that a desktop artifact exists?" — the release feed
   * (`desktopUpdate`) and the server's target (`desktopTargeted`). In the
   * all-in-one flow NEITHER is true: the plan is empty, the target's artifact is
   * `headless`, and the dev feed publishes no desktop build. So the shell that
   * the operation is explicitly WAITING for would compute "I can't install
   * anything", fall through to Reload, and offer a button that changes nothing
   * while the required ask it was meant to answer sits there forever.
   *
   * A required ask addressed to THIS surface is the server saying "you are the
   * one who has to act". Read off `surface` rather than the ask's id, because
   * ids are the kind's vocabulary and this bundle is swapped during the very
   * operation it is drawing (P8).
   */
  const desktopAsked =
    surface.startsWith('desktop') &&
    (operation?.awaiting ?? []).some((ask) => ask.surface === surface)
  const canInstallDesktop =
    typeof installUpdate === 'function' &&
    desktopChannel !== undefined &&
    (desktopUpdate !== undefined || desktopTargeted || desktopAsked)
  /**
   * THE APP ITSELF IS BEHIND, NOT THIS PAGE (POD-5931). A desktop whose shell found a
   * newer build has something to install even when the page is current and the
   * operation is over — a 0.1.0 app joined to a server is the plain case: its daemon
   * lives inside the app, so only installing the app moves that machine, and the
   * page has claimed the update from the shell's own native prompt.
   */
  const appBehind =
    surface.startsWith('desktop') && canInstallDesktop && desktopUpdate !== undefined
  const minimumDesktopBridge = target?.minRequired?.desktopBridge
  const shellBridgeVersion = nativeDesktopBridge()?.bridgeVersion ?? 0
  const bridgeIncompatibility =
    surface.startsWith('desktop') &&
    typeof minimumDesktopBridge === 'number' &&
    shellBridgeVersion < minimumDesktopBridge
      ? {
          code: 'desktop-bridge-incompatible',
          message:
            'This server needs desktop bridge ' +
            minimumDesktopBridge +
            ', but this shell provides ' +
            shellBridgeVersion +
            '.',
        }
      : undefined
  const expectedDesktopVersion = desktopUpdate?.version

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
    local: {
      behind: behind || appBehind,
      canReload: options.reload !== undefined,
      canInstallDesktop,
    },
    surface,
    now,
    ...(desktopProgress && pending === 'install-desktop' ? { desktopProgress } : {}),
    ...((bridgeIncompatibility ?? actionError)
      ? { actionError: bridgeIncompatibility ?? actionError }
      : {}),
    ...((note ?? budgetNote) ? { note: note ?? budgetNote } : {}),
  })

  /**
   * THE PANEL'S INPUTS, WHENEVER THEY CHANGE (POD-3224, question 5).
   *
   * Polled verdicts decide what the panel says and what its button does.
   * The service-worker notification is only a poll nudge, never a verdict.
   *
   * TWO THINGS KEEP THIS OFF THE PER-SECOND WIRE, and both are deliberate:
   *
   *  - the signature carries VERDICTS ONLY. Not the operation's step progress,
   *    and not `view.indicator`: the indicator is recomputed against `now` every
   *    second and flips on a liveness threshold, so including it would forward a
   *    record a second by construction. It is still LOGGED, as context read at
   *    the moment a verdict moved — just never the reason a record exists.
   *  - the emit is in an EFFECT, not in render. The gate is a ref, and a
   *    concurrent render that React discards would otherwise advance it, losing
   *    the very transition the line exists for.
   */
  const inputsSignature = [
    skew,
    assets,
    String(behind),
    surface,
    view.state,
    operationTargetVersion ?? '',
    String(canInstallDesktop),
    pending ?? '',
  ].join('|')
  const inputsFieldsRef = useRef<Record<string, unknown>>({})
  inputsFieldsRef.current = {
    surface,
    skew,
    assets,
    behind,
    state: view.state,
    indicator: view.indicator,
    ...(view.operationId ? { operationId: view.operationId } : {}),
    ...(operationTargetVersion ? { operationTargetVersion } : {}),
    ...(operationTarget?.artifacts?.web?.digest
      ? { operationTargetWebDigest: operationTarget.artifacts.web.digest }
      : {}),
    pageVersion: localVersion,
    ...(pageBuildDigest() ? { pageDigest: pageBuildDigest() } : {}),
    pageBundle: pageBundleVersion() ?? 'unhashed',
    canInstallDesktop,
    canReload: options.reload !== undefined,
    ...(pending ? { pending } : {}),
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature is the subject; the fields are read through a ref at the moment it moves
  useEffect(() => {
    reportInputs.current(inputsSignature, () =>
      updatesLog.info('update panel inputs changed', inputsFieldsRef.current),
    )
  }, [inputsSignature])

  /**
   * THE OPERATION THIS PAGE IS LOOKING AT, whenever it becomes a different one
   * or reaches a different state. The server has the authoritative lifecycle
   * (question 8); this is the CLIENT's view of it, which is the half that
   * explains what the user was shown and when.
   */
  const operationSignature = [operation?.id ?? 'none', operation?.state ?? '-'].join('|')
  const operationFieldsRef = useRef<Record<string, unknown>>({})
  operationFieldsRef.current = {
    ...(operation
      ? {
          operationId: operation.id,
          state: operation.state,
          watched: wasWatched(operation.id),
          ...(operation.error?.code ? { errorCode: operation.error.code } : {}),
        }
      : { operationId: 'none' }),
    live: live === undefined ? 'unread' : live === null ? 'none' : live.state,
    latest: latest === undefined ? 'unread' : latest === null ? 'none' : latest.state,
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: as above — the signature is the subject
  useEffect(() => {
    reportOperation.current(operationSignature, () =>
      updatesLog.info('the operation this page is watching changed', operationFieldsRef.current),
    )
  }, [operationSignature])

  const run = useCallback(
    async (kind: PanelActionKind): Promise<void> => {
      /**
       * EVERY ACTION, START TO FINISH (POD-3224, question 6).
       *
       * A press used to leave two traces and both were indirect: `pending` in
       * the DOM for as long as the await lasted, and — if it threw — a sentence
       * in the panel. What it ASKED FOR, what came back, and how long it took
       * were nowhere, which is why "I pressed Update and nothing happened" could
       * not be told apart from "I pressed Update and the answer was cut by the
       * restart the update itself requested".
       */
      const startedAt = Date.now()
      const baseline = { latestId: latest === null ? null : latest?.id, startedAt }
      updatesLog.info('update action started', {
        action: kind,
        surface,
        ...(operationId ? { operationId } : {}),
      })
      setPressed(kind)
      setNote(undefined)
      setActionError(undefined)
      try {
        switch (kind) {
          case 'start':
            acceptStartOutcome('start', baseline, await startUpdate(trpc, surface))
            break
          case 'retry':
            acceptStartOutcome('retry', baseline, await retryUpdate(trpc, operationId))
            break
          case 'cancel': {
            if (!operationId) break
            const outcome = await cancelOperation(trpc, operationId)
            if (!outcome.canceled) {
              updatesLog.warn('the server refused to cancel this operation', {
                operationId,
                refused: outcome.refused ?? 'irreversible',
                ...(outcome.step ? { step: outcome.step } : {}),
              })
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
            if (!install) break
            if (desktopChannel === undefined) throw new Error(UNKNOWN_DESKTOP_CHANNEL)
            await install(desktopChannel, expectedDesktopVersion)
            /**
             * REACHING THIS LINE IS ITSELF THE FAILURE (POD-2152).
             *
             * `install_update` ends in `app.restart()`, which diverges — the
             * process is replaced and this promise is dropped unresolved along
             * with everything else. So a SETTLED install means the shell
             * installed the update and then did not restart, and the page is
             * the only thing left alive to say so. That is what gives
             * `restart-failed` a producer: it had exactly one construction site
             * in the whole repo and that site was inside its own Rust test, so
             * the panel's handler for it was a sentence nobody could ever read.
             */
            setActionError({
              code: 'restart-failed',
              message: 'The desktop update installed, but Podium did not restart.',
            })
            return
          }
          case 'check':
            await trpc.updates.checkNow.mutate()
            break
        }
        updatesLog.info('update action finished', {
          action: kind,
          elapsedMs: Date.now() - startedAt,
        })
        if (kind !== 'start' && kind !== 'retry') refresh()
      } catch (error) {
        // EVERY rejection lands here. This is the catch the old `runAction`
        // never had: a refused `installUpdate` used to stop a spinner and say
        // nothing at all.
        if (
          (kind === 'start' || kind === 'retry') &&
          (isServerUnavailable(error) || isUpdateRequestTimeout(error))
        ) {
          // THE EXPECTED HANDOFF, named as such. This branch is the reason a
          // cut `start` does not paint a failure, and reading it as an error is
          // the mistake every reviewer of this file has had to be talked out of.
          //
          // A request that got NO answer within its deadline (POD-6240) takes
          // the same path: the server may have created the operation before the
          // answer was lost, so the panel looks for it rather than replaying
          // the write, and the observation wait below names the failure if
          // nothing appears.
          if (isUpdateRequestTimeout(error)) {
            updatesLog.warn('update action got no answer in time; looking for its operation', {
              action: kind,
              elapsedMs: Date.now() - startedAt,
            })
          } else {
            updatesLog.info('update action lost its answer to the restart it asked for', {
              action: kind,
              elapsedMs: Date.now() - startedAt,
            })
          }
          /**
           * Starting an update can cut its own mutation response: the durable
           * operation has already requested the server restart. Never replay
           * the write and never paint that expected handoff as a second,
           * contradictory failure; poll the operation that owns the progress.
           */
          acceptStartOutcome(kind, baseline)
        } else {
          const actionError = toActionError(error)
          updatesLog.warn('update action failed', {
            action: kind,
            elapsedMs: Date.now() - startedAt,
            ...(actionError.code ? { code: actionError.code } : {}),
            ...(actionError.message ? { detail: actionError.message } : {}),
            err: error,
          })
          setActionError(actionError)
        }
      } finally {
        setPressed(null)
        setDesktopProgress(undefined)
      }
    },
    [
      acceptStartOutcome,
      desktopChannel,
      expectedDesktopVersion,
      latest,
      operationId,
      options.reload,
      refresh,
      surface,
      trpc,
    ],
  )

  const checkNow = useCallback(async (): Promise<void> => {
    updatesLog.info('update action started', { action: 'check', surface })
    setPressed('check')
    setActionError(undefined)
    setDesktopChannel(undefined)
    try {
      await trpc.updates.checkNow.mutate().catch(() => {})
      const selection = await readDesktopChannel(queryChannel)
      setDesktopChannel(selection.channel)
      const info = await readDesktopUpdate(selection)
      setDesktopUpdate(info)
      setCheckedAt(Date.now())
      updatesLog.info('update action finished', {
        action: 'check',
        channel: selection.channel,
        desktopUpdate: info?.version ?? 'none',
      })
      refresh()
    } catch (error) {
      const actionError = toActionError(error)
      updatesLog.warn('update action failed', {
        action: 'check',
        ...(actionError.code ? { code: actionError.code } : {}),
        ...(actionError.message ? { detail: actionError.message } : {}),
        err: error,
      })
      setActionError(actionError)
    } finally {
      setPressed(null)
    }
  }, [queryChannel, refresh, surface, trpc])

  const approveProposal = useCallback(async (): Promise<void> => {
    setProposalPending(true)
    setProposalError(undefined)
    try {
      if (!proposal) throw new Error('There is no development release proposal to approve.')
      const raw = await trpc.updates.approveProposal.mutate({
        headSha: proposal.headSha,
        version: proposal.version,
      })
      status.noteProposal(raw === null ? null : ReleaseProposalSchema.parse(raw))
      refresh()
    } catch (error) {
      setProposalError(errorMessage(error) ?? 'The development release was not approved.')
      refresh()
    } finally {
      setProposalPending(false)
    }
  }, [proposal, refresh, status, trpc])

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
    proposal,
    proposalPending,
    ...(proposalError ? { proposalError } : {}),
    approveProposal,
    run,
    checkNow,
    refreshState: refresh,
    acknowledge,
  }
}
