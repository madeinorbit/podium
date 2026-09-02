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
  buildsDiffer,
  classifyAssets,
  classifySkew,
  isDevChannelVersion,
  type Operation,
  parseBuildStamp,
  parseServerVersion,
  type ReleaseProposal,
  ReleaseProposal as ReleaseProposalSchema,
  type ServerVersion,
  WIRE_VERSION,
  wireSchemaDigest,
} from '@podium/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isServerUnavailable, makeTrpc } from '@/app/trpc'
import { noteActiveUpdate } from '@/lib/active-update'
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
  errorDetail,
  errorMessage,
  isMissingProcedure,
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

/**
 * The surface this page is. Moved to `lib/page-surface.ts` (POD-3224) so the
 * boot record can state it before this chunk is even fetched; re-exported under
 * its original name because that is what the panel and its tests call it.
 */
export function surfaceFromDesktopBridge(): UpdateSurface {
  return pageSurface()
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
 * ONE ARM'S FAILURE IS NOT THE READ'S FAILURE. Each fact the panel polls for is
 * separately unavailable — an unreachable fleet must not cost the panel the
 * operation it could read — and `Promise.all` would otherwise reject the batch
 * on the first one that broke. Catches a synchronous throw too, because a
 * transport that is not there yet throws rather than rejecting.
 */
async function safely<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/**
 * Old servers genuinely have no operations endpoint; that is a confirmed
 * "none". Every other failure leaves the fact unknown so a restart-cut request
 * cannot manufacture an offer.
 */
async function safelyReadOperation(
  read: () => Promise<Operation | null>,
): Promise<Operation | null | undefined> {
  try {
    return await read()
  } catch (error) {
    return isMissingProcedure(error) ? null : undefined
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
  const [server, setServer] = useState<ServerVersion>({})
  const [localBuild, setLocalBuild] = useState<LocalBuild>({})
  const [fleetState, setFleetState] = useState<UpdateFleetState | undefined>(options.fleet)
  const [live, setOperation] = useState<Operation | null | undefined>()
  const [latest, setLatest] = useState<Operation | null | undefined>()
  /**
   * Operations THIS tab watched run. A completion is only news to those — and
   * the seed is what carries that across a shell restart (see `watchedHandoff`).
   */
  const watched = useRef<Set<string>>(new Set(watchedHandoff((options.now ?? Date.now)())))
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateInfo | undefined>()
  const [desktopChannel, setDesktopChannel] = useState<NativeDesktopUpdateChannel | undefined>()
  const [desktopProgress, setDesktopProgress] = useState<NativeDesktopUpdateProgress | undefined>()
  const [actionError, setActionError] = useState<ActionError | undefined>()
  const [note, setNote] = useState<string | undefined>()
  const [pending, setPending] = useState<PanelActionKind | null>(null)
  const [proposal, setProposal] = useState<ReleaseProposal | null | undefined>()
  const [proposalPending, setProposalPending] = useState(false)
  const [proposalError, setProposalError] = useState<string | undefined>()
  const [acknowledged, setAcknowledged] = useState<string | undefined>(() => readAcknowledged())
  const [checkedAt, setCheckedAt] = useState<number | undefined>()

  const clock = options.now ?? Date.now
  const [now, setNow] = useState<number>(() => clock())
  /** Change gates. Refs, so they survive a re-render and belong to this hook. */
  const reportInputs = useRef(changeReporter())
  const reportServer = useRef(changeReporter())
  const reportOperation = useRef(changeReporter())
  const trpc = useMemo(() => makeTrpc(options.httpOrigin), [options.httpOrigin])
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

  /** The served-identity half of the poll's report: only when it moves. */
  const noteServerChange = (next: ServerVersion): void => {
    reportServer.current(
      [
        next.appVersion ?? '',
        next.sourceDigest ?? '',
        next.web?.bundle ?? '',
        next.web?.digest ?? '',
        next.installKind ?? '',
        next.target?.version ?? '',
      ].join('|'),
      () =>
        updatesLog.info('the server this page reads from changed identity', {
          appVersion: next.appVersion,
          ...(next.sourceDigest ? { sourceDigest: next.sourceDigest } : {}),
          ...(next.installKind ? { installKind: next.installKind } : {}),
          ...(next.web?.bundle ? { servedBundle: next.web.bundle } : {}),
          ...(next.web?.digest ? { servedDigest: next.web.digest } : {}),
          ...(next.target?.version ? { targetVersion: next.target.version } : {}),
          pageBundle: pageBundleVersion() ?? 'unhashed',
          pageVersion: pageBuildVersion(),
        }),
    )
  }

  const active = isOperationActive(live) || proposal?.state === 'building'

  const query = usePolledQuery<{
    operation: Operation | null | undefined
    latest: Operation | null | undefined
    fleet: UpdateFleetState | undefined
    serverRaw: unknown
    buildRaw: unknown
    proposal: ReleaseProposal | null | undefined
  }>({
    key: `updates.operation:${options.httpOrigin}`,
    intervalMs: active ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    // HALF AN ANSWER IS STILL AN ANSWER: each arm resolves to its own "unknown"
    // rather than rejecting the batch, so an unreachable fleet never costs the
    // panel the operation it could read.
    read: async () => {
      const live = await safelyReadOperation(() => readActiveOperation(trpc))
      const [latest, fleet, serverRaw, buildRaw, proposal] = await Promise.all([
        // The OUTCOME, which `active` cannot carry: it filters terminal states
        // out by design, so "done" and "failed" would blink out of existence at
        // the moment they became true. Only asked when nothing is running.
        live === null
          ? safelyReadOperation(() => readLatestOperation(trpc))
          : Promise.resolve(undefined),
        // The fleet snapshot only feeds the OFFER's place rows. While an
        // operation exists the operation's own steps say where it is, so this
        // stops asking rather than becoming a second opinion (P2). A caller
        // that supplied its own fleet is not asked either.
        live === null && options.fleet === undefined
          ? safely(() => trpc.updates.fleet.query())
          : Promise.resolve(undefined),
        readJson(`${options.httpOrigin}/version`),
        readJson(`${options.httpOrigin}/${BUILD_STAMP_FILE}`),
        safely(async () => {
          const raw = await trpc.updates.proposal.query()
          return raw === null ? null : ReleaseProposalSchema.parse(raw)
        }),
      ])
      return { operation: live, latest, fleet, serverRaw, buildRaw, proposal }
    },
    // Folded in the read's OWN turn: a reading routed through `data` and a
    // follow-up effect lands one flush late, and the panel is supposed to move
    // when the answer does.
    onData: ({ operation: live, latest, fleet, serverRaw, buildRaw, proposal }) => {
      const at = clock()
      /**
       * WHICH ARMS ANSWERED (POD-3224).
       *
       * `undefined` from an arm means the read FAILED, and the difference
       * between "the server says there is no operation" and "we could not ask"
       * is the difference between an offer and a blank panel. Every branch below
       * turns on it, and none of it was visible: a panel stuck on stale facts
       * during a restart looked identical to a panel with nothing to show.
       *
       * `debug`, because this fires on every poll and the poll runs at 1 s while
       * anything is moving. What is worth forwarding is the CHANGE, logged
       * below.
       */
      updatesLog.debug('update poll landed', {
        cadence: active ? ACTIVE_POLL_MS : IDLE_POLL_MS,
        live: live === undefined ? 'unread' : live === null ? 'none' : live.state,
        ...(live ? { operationId: live.id } : {}),
        latest: latest === undefined ? 'unread' : latest === null ? 'none' : latest.state,
        fleet: fleet === undefined ? 'unread' : 'read',
        server: serverRaw === undefined ? 'unread' : 'read',
        build: buildRaw === undefined ? 'unread' : 'read',
        proposal: proposal === undefined ? 'unread' : (proposal?.state ?? 'none'),
      })
      if (live) {
        watched.current.add(live.id)
        rememberWatched(live.id, at)
      }
      /**
       * THE ONE FACT A PAGE CANNOT ASK FOR ONCE IT NEEDS IT (POD-2762).
       *
       * When the server stops answering, the chunk-recovery path has to decide
       * how patient to be, and the only thing that could tell it — "is this a
       * handover or is something wrong?" — is the server that has just gone
       * quiet. This poll is where that was last knowable, so it leaves the
       * answer somewhere a code path with no store, no context and no socket
       * can still read it.
       *
       * Only on an arm that actually ANSWERED: `undefined` means the read
       * failed, and a failed read is not evidence that nothing is running. It
       * would be exactly the wrong moment to conclude that, because a read
       * failing is the first sign of the outage this fact exists to explain.
       */
      if (live !== undefined) noteActiveUpdate(isOperationActive(live), at)
      // A failed arm is not a negative answer. Keep the last fact — including
      // the initial unknown — until that arm itself succeeds.
      if (live !== undefined) setOperation(live)
      if (latest !== undefined) setLatest(latest)
      if (serverRaw !== undefined) {
        const next = parseServerVersion(serverRaw)
        // WHAT THE SERVER IS SERVING, when it moves. This is the fact behind
        // `assets === 'replaced'` and behind every "the page is stale" verdict,
        // and it changes once per release rather than once per second — which is
        // what makes it worth forwarding.
        noteServerChange(next)
        setServer(next)
      }
      if (buildRaw !== undefined) setLocalBuild(localBuildFrom(buildRaw))
      if (fleet !== undefined) setFleetState(fleet)
      if (proposal !== undefined) setProposal(proposal)
      setNow(at)
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
    live === undefined
      ? undefined
      : (live ??
        (latest === undefined
          ? undefined
          : terminalToShow(latest, {
              watched: watched.current,
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

  const fleetFact = options.fleet ?? fleetState
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
  const skew = classifySkew(server, { wire: WIRE_VERSION, digest: wireSchemaDigest() })
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
   * operation. A service worker holding a newer build is the same fact arriving
   * by another route.
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
    options.needRefresh ||
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
    local: { behind, canReload: options.reload !== undefined, canInstallDesktop },
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
   * Six independent facts decide what the panel says and what its button does,
   * and until now an operator looking at a stuck panel could observe none of
   * them. `needRefresh` in particular is a LATCH — the library sets it and only
   * `hide()` clears it — so "the panel says Reload and the page is current" is a
   * statement about which of these six disagreed, and it was unanswerable.
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
    String(options.needRefresh),
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
    needRefresh: options.needRefresh,
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
          watched: watched.current.has(operation.id),
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
      const startedAt = clock()
      updatesLog.info('update action started', {
        action: kind,
        surface,
        ...(operationId ? { operationId } : {}),
      })
      setPending(kind)
      setNote(undefined)
      setActionError(undefined)
      try {
        switch (kind) {
          case 'start':
            await startUpdate(trpc, surface)
            break
          case 'retry':
            await retryUpdate(trpc, operationId)
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
          elapsedMs: clock() - startedAt,
        })
        refresh()
      } catch (error) {
        // EVERY rejection lands here. This is the catch the old `runAction`
        // never had: a refused `installUpdate` used to stop a spinner and say
        // nothing at all.
        if ((kind === 'start' || kind === 'retry') && isServerUnavailable(error)) {
          // THE EXPECTED HANDOFF, named as such. This branch is the reason a
          // cut `start` does not paint a failure, and reading it as an error is
          // the mistake every reviewer of this file has had to be talked out of.
          updatesLog.info('update action lost its answer to the restart it asked for', {
            action: kind,
            elapsedMs: clock() - startedAt,
          })
          /**
           * Starting an update can cut its own mutation response: the durable
           * operation has already requested the server restart. Never replay
           * the write and never paint that expected handoff as a second,
           * contradictory failure; poll the operation that owns the progress.
           */
          refresh()
        } else {
          const actionError = toActionError(error)
          updatesLog.warn('update action failed', {
            action: kind,
            elapsedMs: clock() - startedAt,
            ...(actionError.code ? { code: actionError.code } : {}),
            ...(actionError.message ? { detail: actionError.message } : {}),
            err: error,
          })
          setActionError(actionError)
        }
      } finally {
        setPending(null)
        setDesktopProgress(undefined)
      }
    },
    [
      clock,
      desktopChannel,
      expectedDesktopVersion,
      operationId,
      options.reload,
      refresh,
      surface,
      trpc,
    ],
  )

  const checkNow = useCallback(async (): Promise<void> => {
    updatesLog.info('update action started', { action: 'check', surface })
    setPending('check')
    setActionError(undefined)
    setDesktopChannel(undefined)
    try {
      await trpc.updates.checkNow.mutate().catch(() => {})
      const selection = await readDesktopChannel(queryChannel)
      setDesktopChannel(selection.channel)
      const info = await readDesktopUpdate(selection)
      setDesktopUpdate(info)
      setCheckedAt(clock())
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
      setPending(null)
    }
  }, [clock, queryChannel, refresh, surface, trpc])

  const approveProposal = useCallback(async (): Promise<void> => {
    setProposalPending(true)
    setProposalError(undefined)
    try {
      if (!proposal) throw new Error('There is no development release proposal to approve.')
      const raw = await trpc.updates.approveProposal.mutate({
        headSha: proposal.headSha,
        version: proposal.version,
      })
      setProposal(raw === null ? null : ReleaseProposalSchema.parse(raw))
      refresh()
    } catch (error) {
      setProposalError(errorMessage(error) ?? 'The development release was not approved.')
      refresh()
    } finally {
      setProposalPending(false)
    }
  }, [proposal, refresh, trpc])

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
    acknowledge,
  }
}
