import { issueActivityAt } from '../../diagnostics/reference-state'
import { referenceState } from '../../diagnostics/reference-state'
import { upsertIssue } from '../../shared/src/scenarios'
/**
 * POD-4445 — shared web-entry wiring. Every arm/control page mounts the same
 * way over a kernel seeded at the `?scale=` corpus and exposes the same
 * `window.__proto` surface the browser driver drives. The control and the
 * no-op floor page are measured exactly like the arms: same shell, same
 * scenarios, same timer, same field names.
 *
 * Page scenarios (the browser set — counts in CI cover every scenario; walls
 * in Chromium cover the hot path):
 * - `heartbeat`: lastActiveAt bump on the scenario library's heartbeat
 *   target, a session on a row the worklist never shows (methodology #1).
 * - `visibleHeartbeat`: the same bump on a DRAWN row's session (POD-4560):
 *   the library's `pickVisibleHeartbeat` over the first window, fixed for the
 *   page; the row's `activityAt` moves, so exactly that row must redraw.
 *   Nothing is restored: a heartbeat only moves forward, and `activityAt` is
 *   display only (no band, order or group reads it), so every sample is the
 *   same one-field change of the same row. A click never selects the row.
 *   Heartbeat and visible heartbeat together price "a session nobody sees"
 *   against "a session on screen".
 * - `rename`: title update on a DRAWN open root (#4), from its server
 *   title to `<title> (renamed)`; the next `prepare` restores its server rows
 *   untimed, so every sample is the same rename of the same row and titles
 *   never grow (POD-4559).
 * - `stagemove`: stage and personal-state update (open → done/tucked) on a DRAWN childless
 *   open root (#5); the next `prepare` reopens it untimed (its server rows
 *   restored), so every sample is the same move of the same row.
 * - `clock`: advance the clock 60 s with no row change, through the runtime's
 *   own tick path (the control derives from the engine clock) and on the
 *   locals channel (round-three arms); bands re-derive from the new now (#8).
 * - `click`: the selection write on the ENGINE (`setSelectedIssueId`, #3) for
 *   a DRAWN row: the write the control's pressable makes and the count
 *   harness's `writeSelectionClick` makes. Every arm hears it through the
 *   locals channel (POD-4608; round-two stores through the page's bridge,
 *   below), and the app's own eager mark-read of the selected row runs for
 *   every arm. (Before POD-4559 the round-two arms' click was arm-local — no
 *   engine write, no mark-read — while the control's wrote the engine: two
 *   workloads under one name.) Every sample selects an UNREAD row this page has
 *   never selected, so every sample is the same change: a selection plus the
 *   app's mark-read of that row (a read row's click marks nothing, and the
 *   control commits nothing for it — a second, lighter workload).
 *
 * DRAWN TARGETS (POD-4558, coordinator ruling on finding #4). A change aimed at
 * a row the arm has not drawn commits nothing on a windowed arm and the whole
 * list on the control, so the comparison would time the control's redraw
 * against an arm doing nothing. Every row target is therefore picked by rule,
 * identically for every arm, from the FIRST WINDOW: the oracle's first
 * `FIRST_WINDOW_ROWS` rows of the list as it stands before the change (never
 * an arm's own draw order), root rows only. The rules are the scenario
 * library's (`targetRules`, the predicates `pickTargets` uses): the rename
 * takes the first open human root with children; the stage move the first
 * childless open root; each click the first row neither rule wants, then any.
 * The window is the oracle's over the ENGINE, and every arm makes the same
 * engine writes (the click included, POD-4559), so every arm and the control
 * change the same rows in the same order; the summary refuses a matrix whose
 * targets differ. Before every write
 * the page asserts the target is mounted in THIS arm and throws if not, so
 * the run FAILS instead of recording a zero. `prepare` picks (untimed, before
 * the driver's forced GC); `runScenario` times it; `verify` (check mode,
 * `?check=1`) compares the rows the arm redrew with the rows the oracle says
 * changed, over the rows mounted before and after. `?offwindow=1` plants the
 * library's `visibleRootId` as the rename target: off-window on the windowed
 * arms, so the run must fail there.
 *
 * The writes are the scenario library's own (`applyHeartbeat`,
 * `applyTitleRename`, `applyStageMove`: the synchronous half, so the engine
 * settle never lands inside a timed action). POD-4550.
 *
 * THE TIMER (POD-4558, L5b: work time only). One path for every scenario:
 *
 *   start → dispatch the change → drain → last commit → next frame
 *
 * - `drainMs`: start to the first task after the dispatch. A `MessageChannel`
 *   message posted right after the dispatch runs only once the dispatch's
 *   microtasks have drained (feed flush → arm dispatch → notify → React
 *   sync-lane commit), with no timer clamp and no poll.
 * - `actionMs`: start to the arm's LAST commit signal, or to the drain when
 *   the change commits nothing. Commit signals are the page's `RowShell`
 *   commit log (every row commit and row mount, timestamped when React calls
 *   the shell's profiler) and a DOM mutation under the arm's root (a list
 *   commit that touches no row shell). Waiting for later commits is not
 *   timed: the window ends at the last signal, whenever the page notices it.
 * - `frameMs`: start to the first animation frame after `actionMs`'s end.
 *   Reported, never budgeted: its vsync phase is not the arm's.
 *
 * The settle (untimed) waits until `QUIET_MS` (and at least two frames) pass
 * with no new commit signal, so work an arm defers to a later task inside
 * that window is charged; it fails loudly after `SETTLE_CAP_MS`. Signals that
 * arrive AFTER a settle and before the next change are counted into the next
 * record as `strayCommits`, and the driver FAILS the run on any: work
 * deferred past the quiet window cannot be attributed, so it is never
 * silently dropped. (The first cut settled after one quiet frame; the
 * `late:30` plant — a commit 30 ms after the change — escaped `actionMs`
 * entirely and surfaced only as strays. POD-4558 NOTES.)
 * Long tasks are those overlapping the change's window, taken synchronously
 * from the observer (`takeRecords`) after the settle.
 *
 * THE STEP'S OWN MARK-READS SETTLE INSIDE THE STEP (POD-4559, as the count
 * harness since POD-4618). A click's eager mark-read is the app's: the kernel
 * paints `readAt` at once (inside the timed window, for every arm), sends it,
 * and keeps it awaiting truth until the server's echo — or its 60 s
 * wall-clock sweep, which republishes in whichever later step is running. And
 * the runtime throttles issue mark-reads to one per `MARK_READ_ON_VIEW_MS`, so
 * a click soon after the previous one fires its mark-read up to 1.2 s later.
 * Either lands after the step's quiet settle, as strays in the next record:
 * the control's 4x run failed on a click's whole-list redraw (1,384 commits)
 * that way. So, untimed, after the step's settle: a click waits out the
 * throttle window from its dispatch; then every mark-read the server
 * acknowledged is echoed as truth (`echoAcknowledgedMarkReads`) until the
 * kernel holds no pending write, and the page settles again. `?marksettle=0`
 * removes it (the proof that the strays come back).
 *
 * PARITY AFTER EVERY SAMPLE (POD-4559). `snapshotHash()` is the arm's slice
 * output, `oracleHash()` the oracle's for the same engine state (its own
 * clock, unselected baseline), both over one canonical serialisation; the
 * driver compares them after every sample, outside the timed window, and
 * `firstDifference()` names the first row (in the oracle's order) that
 * differs.
 */

import { MARK_READ_ON_VIEW_MS } from '@podium/client-core/engine'
import { activityAfterRead } from '@podium/client-core/values'
import type { LocalsSourceHandle } from '@podium/client-graph/shared/locals-source'
import { type RowSourceHandle, type RowSourceRepaint } from '@podium/client-graph/shared/row-source'
import { type RowSourceOptions } from '../../shared/src/row-source'
import { createRowSource } from '../../shared/src/row-source'
import type { SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import { asIssueId } from '@podium/model'
import type { Arm, ArmHandle, RowSource } from '../../shared/src/arm'
import {
  type CommitLog,
  createCommitLog,
  withCommitLog,
  withCommitLogAsync,
} from '../../shared/src/row-shell'
import {
  applyHeartbeat,
  applyStageMove,
  applyTitleRename,
  type EngineOptions,
  echoAcknowledgedMarkReads,
  FIXTURE_SEED,
  pendingWrites,
  pickVisibleHeartbeat,
  type ScenarioEngine,
  startEngineOnCorpus,
  targetRules,
} from '../../shared/src/scenarios'
import { createEngineLocals, localsOfEngine } from '../src/engine-locals'
import {
  buildCorpus,
  buildCorpusCell,
  cellLabel,
  type FixtureCorpus,
  parseCell,
} from '../src/fixture/index'
import { oracleSnapshot, type RowViews, rowViewsFromStore } from '../src/oracle/index'
import {
  currentScope,
  fireRescope,
  type StagedScope,
  scopeOfCorpus,
  stageRows,
  stageScans,
} from '../src/rescope'

export type ProtoScenarioName =
  | 'heartbeat'
  | 'visibleHeartbeat'
  | 'rename'
  | 'stagemove'
  | 'clock'
  | 'click'

export interface ProtoCorpusCounts {
  issues: number
  sessions: number
  repos: number
  worktrees: number
  rows: number
}

export interface ProtoLongTask {
  startTime: number
  duration: number
}

export interface ProtoScenarioResult {
  /** Row commits (non-mount renders) in the change's window. */
  commits: number
  /** Row mounts in the window (a row entering the list). */
  mounts: number
  /** DOM mutation records under the arm's root in the window. */
  domMutations: number
  /** Commit signals that arrived after the previous settle, before this change. */
  strayCommits: number
  stats: {
    rowsDerived: number
    rollupsDerived: number
    indexUpdates: number
    notifications: number
  }
  /** Start to the first task after the dispatch (microtask drain included). */
  drainMs: number
  /** Start to the last commit signal, or to the drain if nothing committed. */
  actionMs: number
  /** Start to the first animation frame after `actionMs` ends. Not budgeted. */
  frameMs: number
  /** Which signal ended `actionMs`. */
  endedBy: 'drain' | 'commit' | 'dom'
  longTasks: ProtoLongTask[]
  /** Rows currently mounted in the windowed list. */
  mountedRows: number
  /** The row the change aimed at (rename, stagemove, click, visibleHeartbeat); the session for heartbeat; null for clock. */
  target: string | null
}

/** Check mode (`?check=1`): the arm's redraw against the oracle's, over rows mounted before and after. */
export interface ProtoOracleCheck {
  /** Rows the oracle says changed view (present before and after, mounted both times). */
  changed: string[]
  /** Rows the arm redrew in the window: committed, or remounted, mounted both times. */
  drawn: string[]
  over: string[]
  under: string[]
}

/** POD-4561 (L5e): the lifecycle steps, each on its own held page load. */
export type ProtoLifecycleName = 'coldBootstrap' | 'principalSwitch' | 'rescope'

export interface ProtoParity {
  arm: string
  oracle: string
  /** The first row (oracle order) where the two differ; null when they agree. */
  firstDifference: string | null
  /** The arm's named parity allowance when it applied (`<issue>:<row>`), else null (POD-4572). */
  allowance?: string | null
}

/**
 * POD-4572 — an arm's NAMED parity allowance, the same one its fence-roster
 * entry carries (`harness/src/roster.ts` `RosterAllowances.parity`): the
 * oracle's snapshot patched for one known gap, named by the issue that
 * removes it. Applied to the oracle side of every parity check on the page;
 * the parity record names the row whenever it applied.
 */
export interface PageParityAllowance {
  readonly issue: string
  /** `corpus`: the one whose rows the engine holds now (a rescope's grown corpus at its grown state). */
  accept(
    corpus: FixtureCorpus,
    handle: ArmHandle,
    expected: SliceSnapshot,
    actual: SliceSnapshot,
  ): { snapshot: SliceSnapshot; applied: string | null }
}

/** A lifecycle step's record: the change fields, the step's phases, and for
 *  rescope the parity at the grown state. */
export interface ProtoLifecycleResult extends ProtoScenarioResult {
  phases: Record<string, number>
  midParity: ProtoParity | null
}

export interface ProtoPage {
  ready: boolean
  /** `?hold=1`: the arm waits for a lifecycle step; hot-path changes are refused. */
  held: boolean
  arm: string
  scale: 1 | 2 | 4
  /** POD-4747: the two-axis cell (`h10a1`), or null on a `?scale=` page. */
  cell: string | null
  corpus: ProtoCorpusCounts
  runtimeSha: string
  /** Untimed: pick the next change's target by rule and assert it is drawn. */
  prepare(name: ProtoScenarioName): Promise<string | null>
  /** Time the prepared change; throws when none is prepared for `name`. */
  runScenario(name: ProtoScenarioName): Promise<ProtoScenarioResult>
  /** Check mode only: the last change's redraw against the oracle; null otherwise. */
  verify(): ProtoOracleCheck | null
  /** The oracle's first window now (diagnostics). */
  firstWindow(): string[]
  /** The oracle's first `n` rows with the target-rule facts (diagnostics). */
  describeTop(
    n: number,
  ): { id: string; pinned: boolean; root: boolean; rename: boolean; stagemove: boolean }[]
  /** Wait (untimed) until the page is quiet; the driver calls it before the first change. */
  settle(): Promise<void>
  /** The settle's quiet window, ms. */
  quietMs: number
  /** The arm's slice output, canonical hash. */
  snapshotHash(): string
  /** The oracle's slice output for the same engine state, same hash. */
  oracleHash(): string
  /** The first row (oracle order) where the arm's output differs from the oracle's; null when equal. */
  firstDifference(): string | null
  stats(): ProtoScenarioResult['stats']
  /** Held page, timed: build the arm and draw its list (page load to first painted list). */
  coldBootstrap(): Promise<ProtoLifecycleResult>
  /** Held page, untimed: build the arm and settle (a switch's or rescope's setup). */
  build(): Promise<void>
  /** Untimed: boot `principal`'s runtime over a fresh replica for `rebuild`. */
  prepareRebuild(principal: string): Promise<void>
  /** Held page, timed: dispose the arm and rebuild it over the prepared runtime. */
  rebuild(principal: string): Promise<ProtoLifecycleResult>
  /** Untimed: stage the corpus at `scale` (rows and scans, `harness/src/rescope.ts`) for `rescope`. */
  prepareRescope(scale: 1 | 2 | 4): Promise<void>
  /** Held page, timed: rescope onto the staged corpus, then back. */
  rescope(scale: 1 | 2 | 4): Promise<ProtoLifecycleResult>
  /** Commit signals since the last settle (a lifecycle step's late work). */
  lateSignals(): number
  /** After a principal switch: the old principal's objects (runtime, store,
   *  replica, cache, arm handle, row source) still alive; call after a GC. */
  survivors(): string[]
}

declare global {
  interface Window {
    __proto: ProtoPage
  }
}

/** A settle that has not gone quiet by then is a failed record, not a wait. */
const SETTLE_CAP_MS = 5_000
/** No commit signal for this long (and two frames) ends a settle. `?quiet=` overrides. */
const QUIET_MS = Number(new URLSearchParams(window.location.search).get('quiet') ?? 250)

function hashString(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}

/** JSON with object keys sorted at every level: equal values, equal text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  )
}

/** The first difference between two slice outputs, walking `expected`'s order. */
export function firstSnapshotDifference(
  actual: SliceSnapshot,
  expected: SliceSnapshot,
): string | null {
  const ids = (snapshot: SliceSnapshot): string[] => [
    ...snapshot.order.pinnedIds,
    ...snapshot.order.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
  ]
  const want = ids(expected)
  for (const id of want) {
    const a = actual.rowsById[id]
    const e = expected.rowsById[id]
    if (a === undefined) return `row ${id}: missing from the arm`
    if (canonical(a) !== canonical(e)) {
      const fields = Object.keys({ ...a, ...e }).filter(
        (field) =>
          canonical((a as unknown as Record<string, unknown>)[field]) !==
          canonical((e as unknown as Record<string, unknown>)[field]),
      )
      return `row ${id}: ${fields.map((f) => `${f} arm=${canonical((a as unknown as Record<string, unknown>)[f])} oracle=${canonical((e as unknown as Record<string, unknown>)[f])}`).join('; ')}`
    }
  }
  const extra = Object.keys(actual.rowsById).find((id) => !(id in expected.rowsById))
  if (extra !== undefined) return `row ${extra}: drawn by the arm, not in the oracle`
  if (canonical(actual.order) !== canonical(expected.order)) {
    const got = ids(actual)
    const at = want.findIndex((id, index) => got[index] !== id)
    return at >= 0
      ? `order at ${at}: arm has ${got[at] ?? 'nothing'}, oracle ${want[at]}`
      : 'order: same rows, different grouping'
  }
  return null
}

/** Resolves with the time the next task starts: after every queued microtask. */
function nextTask(): Promise<number> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      const at = performance.now()
      channel.port1.close()
      resolve(at)
    }
    channel.port2.postMessage(null)
  })
}

/** Resolves with the time the next animation-frame callback runs. */
function nextFrame(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve(performance.now()))
  })
}

/** The page's commit log, with the time of its latest signal. */
interface TimedCommitLog extends CommitLog {
  /** performance.now() of the latest commit or mount; -1 before any. */
  lastAt(): number
  /** Commits plus mounts since construction; never reset. */
  signals(): number
}

function createTimedCommitLog(): TimedCommitLog {
  const base = createCommitLog()
  let lastAt = -1
  let signals = 0
  return {
    counts: base.counts,
    mounts: base.mounts,
    record(rowId) {
      base.record(rowId)
      lastAt = performance.now()
      signals += 1
    },
    recordMount(rowId) {
      base.recordMount(rowId)
      lastAt = performance.now()
      signals += 1
    },
    total: () => base.total(),
    reset: () => base.reset(),
    lastAt: () => lastAt,
    signals: () => signals,
  }
}

/**
 * The first window: the oracle's first rows, which every arm draws with no
 * scroll in the driver's viewport (`run.ts`, `VIEWPORT`: 1600×5800; hand and
 * MobX draw ~103 rows of 56 px there). The pinned section grows with the
 * corpus: on the reshaped fixture (POD-4635) 21 rows at 1x, 42 at 2x, 84 at
 * 4x, and the first open root with children and the first childless open
 * root are rows 84 and 85 at 4x (POD-4560). The old 36-row window at
 * 1600×2400 held nothing but pinned rows at 2x and 4x, so rename and stage
 * move had no drawn target there (as round two's 1600×1000 at 4x before it).
 * One viewport for every arm and scale. An arm that draws fewer rows fails
 * the mounted assertion instead of timing an undrawn row.
 */
export const FIRST_WINDOW_ROWS = 96

/**
 * POD-4747: the first window on a two-axis cell page (`?cell=`), the same at
 * every cell so the cells' walls compare. At `h1a4` the oracle's first group
 * is not legacy 4x's: below the 84 pinned rows the first open root with
 * children is row 114 (the first childless open root is row 84), outside a
 * 96-row window. 124 rows of 56 px plus two 40 px headers is 7,024 px; the
 * driver's cell viewport is 1600×7400 (`run.ts`, `CELL_VIEWPORT`).
 */
export const CELL_FIRST_WINDOW_ROWS = 124

/** The page's first window: a cell page's, or the scale pages' 96 rows. */
export function firstWindowRows(): number {
  return new URLSearchParams(window.location.search).get('cell') === null
    ? FIRST_WINDOW_ROWS
    : CELL_FIRST_WINDOW_ROWS
}

export interface MountPageOptions {
  arm: string
  /** The arm over one engine: the page builds it at boot and again, over a
   *  fresh engine, on a principal switch (`rebuild`). */
  createArm: (boot: ScenarioEngine, source: RowSource) => Arm
  boot: ScenarioEngine
  scale: 1 | 2 | 4
  /** POD-4747: the two-axis cell label (`readPageCorpus`); null or absent on a `?scale=` page. */
  cell?: string | null
  counts: { issues: number; sessions: number; repos: number; worktrees: number }
  runtimeSha: string
  el: Element
  /** `performance.now()` at the entry module's first statement: the bundle
   *  fetched, parsed and evaluated (every static import), nothing else run. */
  scriptAt: number
  /** The arm's named parity allowance (POD-4572); none by default. */
  parityAllowance?: PageParityAllowance
  /**
   * POD-4825: the oracle's list as the arm must show it, with the arm's own
   * pending edits laid over it (`harness/src/writable-arm.ts`); the oracle
   * itself by default. Read at every parity check (a principal switch
   * rebuilds the arm, and its edits, over the new engine).
   */
  expected?: (oracle: SliceSnapshot) => SliceSnapshot
  /**
   * POD-5432: the arm owns its optimism the product's way: a `pooled` feed
   * over the runtime's transaction log, built per engine by the page (so the
   * log's code is only in that page's bundle). Absent: the `overlaid` feed.
   */
  owned?: (over: ScenarioEngine) => OwnedFeed
  /** What a principal switch's fresh engine boots with (the boot engine's own). */
  engineOptions?: EngineOptions
  /** Untimed, on a principal switch's fresh engine before the arm is built. */
  prepareEngine?: (engine: ScenarioEngine) => Promise<void>
}

/** One engine's transaction log, as `mountPage` wires it (POD-5432). */
export interface OwnedFeed {
  readonly options: RowSourceOptions
  /** The feed is built: the log repaints through it and the actions route. */
  bind(source: RowSourceHandle & RowSourceRepaint): void
  /** The arm is built: its pool takes the log. */
  attach(handle: ArmHandle): void
  release(): void
}

export function readScale(): 1 | 2 | 4 {
  const raw = new URLSearchParams(window.location.search).get('scale')
  return raw === '2' ? 2 : raw === '4' ? 4 : 1
}

/**
 * POD-4747: the page's corpus — a two-axis cell (`?cell=h10a1`,
 * `buildCorpusCell`) or a legacy scale (`?scale=`). A cell's `scale` is its
 * active factor: what the scale-keyed page rules (the pinned section's size)
 * see.
 */
export function readPageCorpus(): { corpus: FixtureCorpus; scale: 1 | 2 | 4; cell: string | null } {
  const raw = new URLSearchParams(window.location.search).get('cell')
  if (raw !== null) {
    const cell = parseCell(raw)
    return {
      corpus: buildCorpusCell(cell, FIXTURE_SEED),
      scale: cell.active,
      cell: cellLabel(cell),
    }
  }
  const scale = readScale()
  return { corpus: buildCorpus(scale, FIXTURE_SEED), scale, cell: null }
}

/** POD-4747: a boot stage the page is stopped at (`?layers=1`). */
export interface PageStage {
  name: string
  go: () => void
}

declare global {
  interface Window {
    __stage?: PageStage
  }
}

/**
 * POD-4747 (`?layers=1`, the layer-split driver `harness/browser/layers.ts`):
 * stop at the named boot stage until the driver has taken the heap there and
 * calls `window.__stage.go()`. Without `?layers=1` it resolves at once.
 */
/** POD-4747: what a page's engine boot takes: the stage points and, on a
 *  `?layers=1` page, the kernel's own copy of every row. */
export function pageEngineOptions(): { stage: (name: string) => Promise<void>; ownRows: boolean } {
  return {
    stage: stagePoint,
    ownRows: new URLSearchParams(window.location.search).get('layers') === '1',
  }
}

export function stagePoint(name: string): Promise<void> {
  if (new URLSearchParams(window.location.search).get('layers') !== '1') return Promise.resolve()
  return new Promise((resolve) => {
    window.__stage = {
      name,
      go: () => {
        window.__stage = undefined
        resolve()
      },
    }
  })
}

/** One built arm over one engine: everything a principal switch disposes. */
interface LiveArm {
  boot: ScenarioEngine
  source: RowSourceHandle
  locals: LocalsSourceHandle
  handle: ArmHandle
  unmount: () => void
  offBridge: (() => void) | null
  /** An owned arm's transaction log and its routing (POD-5432). */
  release: () => void
}

export function mountPage(options: MountPageOptions): void {
  // No closure below reads `options`, and `boot`/`engine` move to the new
  // runtime on a principal switch: nothing on the page keeps the old one
  // alive, so the switch's retained heap is the arm's, not the harness's.
  const { createArm, scale, counts, runtimeSha, el, scriptAt, parityAllowance, expected } = options
  const { owned, engineOptions, prepareEngine } = options
  const cell = options.cell ?? null
  const windowRows = firstWindowRows()
  const armName = options.arm
  let boot = options.boot
  let engine = boot.engine
  /** The engine is booted when the entry calls here (fixture built, corpus installed). */
  const engineAt = performance.now()
  const params = new URLSearchParams(window.location.search)
  const log = createTimedCommitLog()

  // The observers exist before any arm draws, so a build's own commits and
  // DOM writes are signals like a change's.
  let lastDomAt = -1
  let domRecords = 0
  new MutationObserver((records) => {
    lastDomAt = performance.now()
    domRecords += records.length
  }).observe(el, { subtree: true, childList: true, attributes: true, characterData: true })
  const signals = (): number => log.signals() + domRecords

  const longTasks: ProtoLongTask[] = []
  let longTaskObserver: PerformanceObserver | null = null
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ startTime: entry.startTime, duration: entry.duration })
      }
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })
  } catch {
    // No longtask support: the driver records zero and says so in `browser`.
  }
  const drainLongTasks = (): void => {
    for (const entry of longTaskObserver?.takeRecords() ?? []) {
      longTasks.push({ startTime: entry.startTime, duration: entry.duration })
    }
  }

  /**
   * Build the arm over `over` and mount it: the row source, the locals
   * channel, the arm's store, its web list. Synchronous; the list's commits
   * land after it returns (the timer's window catches them).
   */
  function build(over: ScenarioEngine): LiveArm {
    const feed = owned?.(over) ?? null
    const source = createRowSource(over.engine, over.replica, feed?.options ?? { mode: 'pooled' })
    feed?.bind(source)
    const release = (): void => feed?.release()
    // The locals channel is the ENGINE's (POD-4608): a click and a tick are
    // engine writes, and every arm hears them here.
    const locals = createEngineLocals(over.engine)
    const handle = createArm(over, source.source).create(source.source, locals.source)
    feed?.attach(handle)
    // Round-two stores predate the channel (they read `locals.get()` once and
    // are driven by `setSelection` / `setCoarseNow`): the page bridges it.
    const roundTwo = (
      handle as unknown as {
        store?: { setSelection?: (id: string) => void; setCoarseNow?: (now: number) => void }
      }
    ).store
    let offBridge: (() => void) | null = null
    if (roundTwo?.setSelection !== undefined && roundTwo.setCoarseNow !== undefined) {
      const { setSelection, setCoarseNow } = roundTwo as Required<typeof roundTwo>
      offBridge = locals.source.subscribe((changed) => {
        const now = locals.source.get()
        if (changed.has('selectedIssueId') && now.selectedIssueId !== null)
          setSelection.call(roundTwo, now.selectedIssueId)
        if (changed.has('coarseNow')) setCoarseNow.call(roundTwo, now.coarseNow)
      })
    }
    let unmount: () => void = () => {}
    withCommitLog(log, () => {
      unmount = handle.mountWeb(el)
    })
    return { boot: over, source, locals, handle, unmount, offBridge, release }
  }

  /** Everything `build` made, released: what a principal switch throws away. */
  function teardown(arm: LiveArm): void {
    arm.unmount()
    arm.handle.dispose()
    arm.offBridge?.()
    arm.locals.dispose()
    arm.release()
    arm.source.dispose()
  }

  // `?hold=1` (lifecycle pages): the engine boots, the arm waits for the
  // driver's `build()`, so the driver can take the heap before any arm exists.
  const held = params.get('hold') === '1'
  let liveArm: LiveArm | null = held ? null : build(boot)
  const live = (): LiveArm => {
    if (liveArm === null) throw new Error('[proto] no arm built yet (held page: call build())')
    return liveArm
  }

  const statsOf = (): ProtoScenarioResult['stats'] => {
    const { stats } = live().handle
    return {
      rowsDerived: stats.rowsDerived,
      rollupsDerived: stats.rollupsDerived,
      indexUpdates: stats.indexUpdates,
      notifications: stats.notifications,
    }
  }

  const checkMode = params.get('check') === '1'
  const rules = targetRules(boot.corpus)
  const markSettle = params.get('marksettle') !== '0'

  /** The oracle's first window of the list as it stands now, root rows only:
   *  the control nests formal children inside their parent's row (no row of
   *  their own to draw), so a child is never a target. */
  function firstWindow(): string[] {
    const { order } = oracleSnapshot(referenceState(engine))
    return [...order.pinnedIds, ...order.groups.flatMap((group) => group.rowIds)]
      .slice(0, windowRows)
      .filter(rules.root)
  }
  const mountedIds = (): Set<string> =>
    new Set(
      [...el.querySelectorAll('[data-issue-row]')].map(
        (row) => row.getAttribute('data-issue-row') ?? '',
      ),
    )
  /** The write is refused unless the arm has drawn its target: a zero is never recorded. */
  function assertDrawn(scenario: ProtoScenarioName, id: string): void {
    if (el.querySelector(`[data-issue-row="${CSS.escape(id)}"]`) === null) {
      throw new Error(
        `[proto] ${scenario}: target ${id} is not drawn by ${armName} (first window ${firstWindow().join(',')}); refusing to time an undrawn row`,
      )
    }
  }

  const moved = new Set<string>()
  const clicked = new Set<string>()
  const bootWindow = firstWindow()
  /** #4: fixed for the page — the first drawn open root with children; `?offwindow=1` plants the library's target. */
  const renameTarget =
    params.get('offwindow') === '1'
      ? boot.targets.visibleRootId
      : bootWindow.find(rules.openRootWithChildren)
  /** The visible heartbeat: fixed for the page, a drawn row's session. */
  const visibleHeartbeat = pickVisibleHeartbeat(rules, bootWindow)
  /** The row's server rows now, restored by the returned undo (untimed, next `prepare`). */
  function restorer(id: string): () => void {
    const wire = boot.cache.read('issueProjection', id)?.value
    const projection = boot.cache.read('issueProjection', id)?.value
    if (wire === undefined) throw new Error(`[proto] ${id} missing from the cache`)
    return () =>
      boot.replica.batch(() => {
        upsertIssue(boot, id, wire)
      })
  }
  /** Same title every sample: the server title, then `(renamed)`, undone before the next change. */
  function rename(id: string): void {
    const wire = boot.cache.read('issueProjection', id)?.value as { title?: string } | undefined
    if (wire?.title === undefined) throw new Error(`[proto] issue ${id} missing`)
    applyTitleRename(boot, id, `${wire.title} (renamed)`)
  }
  /** Rows another scenario owns for the page: a click never selects them. */
  const reserved = (id: string): boolean => id === renameTarget || id === visibleHeartbeat?.issueId
  const fresh = (id: string): boolean => !reserved(id) && !moved.has(id) && !clicked.has(id)
  /** #5: the first drawn childless open root no click selected. Each move is
   *  undone before the next change (`prepare`), so every sample moves the same
   *  row from the same place across the same groups. */
  function nextStageMove(): string {
    const window = firstWindow()
    const id = window.find(
      (candidate) =>
        !reserved(candidate) && !clicked.has(candidate) && rules.childlessRoot(candidate),
    )
    if (id === undefined) {
      throw new Error(
        `[proto] stagemove: no unclicked childless open root in the first window ${window.join(',')}`,
      )
    }
    return id
  }
  /** #3: a fresh drawn UNREAD row every sample; rows the rename and stage-move rules want go last. */
  function nextClick(): string {
    const window = firstWindow().filter((id) => fresh(id) && unread(id))
    const wanted = (id: string): boolean =>
      rules.childlessRoot(id) || rules.openRootWithChildren(id)
    const id = window.find((candidate) => !wanted(candidate)) ?? window[0]
    if (id === undefined)
      throw new Error(
        '[proto] click: no fresh unread row in the first window; load a fresh page (fewer samples per page)',
      )
    return id
  }
  /** Unread as the runtime's eager mark-read decides it (`fireMarkIssueRead`:
   *  activity after `readAt`), from client-core's own two helpers. Only an
   *  unread row's click marks it read, so a click on a read row is a lighter
   *  workload (the control commits nothing for it); every sample clicks an
   *  unread one. */
  function unread(id: string): boolean {
    const store = referenceState(engine)
    const issue = store.issueProjections.find((candidate) => candidate.id === id)
    if (issue === undefined) return false
    return activityAfterRead(
      store.issueUserStates.find((row) => row.entityId === id)?.readAt ?? null,
      issueActivityAt(issue, store.sessions, store.issueProjections),
    )
  }

  /** The page clock: the runtime's own tick (POD-4550). The control derives
   *  from the engine clock; every other arm hears it on the locals channel.
   *  No row changes — bands and folds re-derive from the new now. */
  function clock(): void {
    boot.advanceClock(60_000)
  }

  let settledSignals = signals()
  let running = false

  /** Untimed: resolves with every frame time seen, once `QUIET_MS` and two
   *  frames pass with no new commit signal. Throws past `SETTLE_CAP_MS`. */
  async function settleQuiet(): Promise<number[]> {
    const began = performance.now()
    const frames: number[] = []
    let seen = signals()
    let lastChange = began
    for (;;) {
      frames.push(await nextFrame())
      const at = await nextTask()
      const now = signals()
      if (now !== seen) {
        seen = now
        lastChange = at
      } else if (frames.length >= 2 && at - lastChange >= QUIET_MS) {
        break
      }
      if (at - began > SETTLE_CAP_MS) {
        throw new Error(`[proto] did not settle within ${SETTLE_CAP_MS} ms (still committing)`)
      }
    }
    settledSignals = signals()
    return frames
  }

  /**
   * Untimed: the step's own mark-reads settle inside the step (see the header).
   * `clickAt` (a click's dispatch time) first waits out the runtime's
   * mark-read throttle window, so a deferred mark-read has fired. Then every
   * mark-read the server acknowledged is echoed as truth, until the kernel
   * holds no pending write; then the page goes quiet again.
   */
  async function settleMarkReads(clickAt: number | null): Promise<void> {
    if (clickAt !== null) {
      const until = clickAt + MARK_READ_ON_VIEW_MS
      while (performance.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, until - performance.now()))
      }
    }
    const began = performance.now()
    let echoed = 0
    for (;;) {
      await nextTask()
      echoed += echoAcknowledgedMarkReads(boot).length
      if (pendingWrites(boot).length === 0) break
      if (performance.now() - began > SETTLE_CAP_MS) {
        throw new Error(
          `[proto] the step's writes did not settle within ${SETTLE_CAP_MS} ms: ${pendingWrites(boot).join(', ')}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (echoed > 0 || clickAt !== null) await settleQuiet()
  }

  interface Plan {
    name: ProtoScenarioName
    target: string | null
    /** The target is a row: it must be drawn when the change is dispatched. */
    row: boolean
    dispatch: () => void
    /** The change's undo, run untimed by the next `prepare` (rename, stage move). */
    undo?: () => void
    /** Check mode: the oracle's row views and the mounted rows before the change. */
    before: { views: RowViews; mounted: Set<string> } | null
  }
  let plan: Plan | null = null
  let lastRun: Plan | null = null

  function planFor(name: ProtoScenarioName): Omit<Plan, 'before' | 'name'> {
    switch (name) {
      case 'heartbeat':
        return {
          target: boot.targets.heartbeatSessionId,
          row: false,
          dispatch: () => void applyHeartbeat(boot),
        }
      case 'visibleHeartbeat': {
        if (visibleHeartbeat === undefined) {
          throw new Error(
            `[proto] visibleHeartbeat: no drawn root with a bound session in the first window ${bootWindow.join(',')}`,
          )
        }
        const { issueId, sessionId } = visibleHeartbeat
        return {
          target: issueId,
          row: true,
          dispatch: () => void applyHeartbeat(boot, sessionId),
        }
      }
      case 'rename':
        if (renameTarget === undefined) {
          throw new Error(
            `[proto] rename: no open root with children in the first window ${bootWindow.join(',')}`,
          )
        }
        return {
          target: renameTarget,
          row: true,
          dispatch: () => rename(renameTarget),
          undo: restorer(renameTarget),
        }
      case 'stagemove': {
        const id = nextStageMove()
        return {
          target: id,
          row: true,
          dispatch: () => {
            moved.add(id)
            applyStageMove(boot, id)
          },
          undo: restorer(id),
        }
      }
      case 'clock':
        return { target: null, row: false, dispatch: clock }
      case 'click': {
        const id = nextClick()
        return {
          target: id,
          row: true,
          dispatch: () => {
            clicked.add(id)
            referenceState(engine).setSelectedIssueId(asIssueId(id))
          },
        }
      }
    }
  }

  /** The last change's undo: its row's server truth restored, untimed. */
  let undoLast: (() => void) | null = null

  async function prepare(name: ProtoScenarioName): Promise<string | null> {
    if (running) throw new Error('[proto] prepare during a running change')
    if (held) throw new Error(`[proto] ${name}: a held page (?hold=1) runs lifecycle steps only`)
    if (undoLast !== null) {
      // Put the renamed or moved row back as it was (same server rows, so the
      // same title and the same place in the list) and settle, so every sample
      // is the same change of the same drawn row and the window never runs
      // out of targets.
      const undo = undoLast
      undoLast = null
      undo()
      await settleQuiet()
    }
    const next = planFor(name)
    if (next.row && next.target !== null) assertDrawn(name, next.target)
    plan = {
      ...next,
      name,
      before: checkMode
        ? {
            views: rowViewsFromStore(referenceState(engine), localsOfEngine(engine)),
            mounted: mountedIds(),
          }
        : null,
    }
    return next.target
  }

  interface TimedWindow extends Omit<ProtoScenarioResult, 'strayCommits' | 'target'> {
    /** performance.now() at the dispatch. */
    start: number
  }

  /**
   * THE TIMER, one path for every change and every lifecycle step (see the
   * header): dispatch, drain, settle, then the last commit signal ends the
   * window. The caller wraps it in the page's commit log.
   */
  async function timeWindow(dispatch: () => void): Promise<TimedWindow> {
    liveArm?.handle.stats.reset()
    log.reset()
    drainLongTasks()
    longTasks.length = 0
    const domBefore = domRecords
    const windowSignals = signals()

    const start = performance.now()
    dispatch()
    const drainEnd = await nextTask()

    const frames = await settleQuiet()
    const settleEnd = performance.now()

    const committed = signals() !== windowSignals
    const commitAt = committed && log.lastAt() >= start ? log.lastAt() : -1
    const domAt = domRecords !== domBefore && lastDomAt >= start ? lastDomAt : -1
    const end = Math.max(drainEnd, commitAt, domAt)
    const endedBy = end === drainEnd ? 'drain' : end === commitAt ? 'commit' : 'dom'
    const frameAt = frames.find((t) => t >= end)
    if (frameAt === undefined) throw new Error('[proto] no frame after the last commit signal')

    drainLongTasks()
    return {
      start,
      commits: log.total(),
      mounts: [...log.mounts.values()].reduce((sum, n) => sum + n, 0),
      domMutations: domRecords - domBefore,
      stats: statsOf(),
      drainMs: drainEnd - start,
      actionMs: end - start,
      frameMs: frameAt - start,
      endedBy,
      longTasks: longTasks.filter(
        (t) => t.startTime + t.duration > start && t.startTime < settleEnd,
      ),
      mountedRows: el.querySelectorAll('[data-issue-row]').length,
    }
  }

  function resultOf(
    window: TimedWindow,
    strayCommits: number,
    target: string | null,
  ): ProtoScenarioResult {
    return {
      commits: window.commits,
      mounts: window.mounts,
      domMutations: window.domMutations,
      strayCommits,
      stats: window.stats,
      drainMs: window.drainMs,
      actionMs: window.actionMs,
      frameMs: window.frameMs,
      endedBy: window.endedBy,
      longTasks: window.longTasks,
      mountedRows: window.mountedRows,
      target,
    }
  }

  /** Time the prepared change (picked and looked up untimed in `prepare`). */
  async function runScenario(name: ProtoScenarioName): Promise<ProtoScenarioResult> {
    if (running) throw new Error('[proto] runScenario is not re-entrant')
    const current = plan
    if (current === null || current.name !== name) {
      throw new Error(`[proto] runScenario(${name}) without prepare(${name})`)
    }
    plan = null
    running = true
    try {
      return await withCommitLogAsync(log, async () => {
        // Re-asserted at the write: nothing between prepare and here may undraw it.
        if (current.row && current.target !== null) assertDrawn(name, current.target)
        const strayCommits = signals() - settledSignals
        const window = await timeWindow(current.dispatch)
        if (current.undo !== undefined) undoLast = current.undo
        // Untimed, after every number above is taken: this step's own
        // mark-reads, acknowledged and echoed before the next change.
        if (markSettle) await settleMarkReads(name === 'click' ? window.start : null)
        lastRun = current
        return resultOf(window, strayCommits, current.target)
      })
    } finally {
      running = false
    }
  }

  // ------------------------------------------------------------ lifecycle
  // POD-4561 (L5e). One lifecycle sample per page load (`?hold=1`): a timed
  // run that is killed or repeated in one page poisons later renders, so the
  // driver loads a fresh page for each and the page refuses a second one.

  let lifecycleRan: ProtoLifecycleName | null = null
  function beginLifecycle(name: ProtoLifecycleName): void {
    if (!held) throw new Error(`[proto] ${name}: lifecycle steps run on a held page (?hold=1)`)
    if (running) throw new Error(`[proto] ${name}: a change is running`)
    if (lifecycleRan !== null) {
      throw new Error(
        `[proto] ${name}: this page already ran ${lifecycleRan}; one lifecycle sample per page load`,
      )
    }
    lifecycleRan = name
  }

  /** The arm's output against the oracle's over the live engine, untimed. */
  function parityNow(): ProtoParity {
    const armSnapshot = live().handle.snapshot()
    const oracleNow = oracleSnapshot(referenceState(live().boot.engine))
    const raw = expected === undefined ? oracleNow : expected(oracleNow)
    const patched = parityAllowance?.accept(
      installedCorpus ?? live().boot.corpus,
      live().handle,
      raw,
      armSnapshot,
    )
    const oracle = patched?.snapshot ?? raw
    const armHash = hashString(canonical(armSnapshot))
    const oracleHash = hashString(canonical(oracle))
    return {
      arm: armHash,
      oracle: oracleHash,
      firstDifference: armHash === oracleHash ? null : firstSnapshotDifference(armSnapshot, oracle),
      allowance:
        patched?.applied == null ? null : `${parityAllowance?.issue ?? ''}:${patched.applied}`,
    }
  }

  /**
   * coldBootstrap, timed: build the arm over the booted engine and draw its
   * list. `actionMs` is the arm's share of page load to first painted list:
   * the entry's own load (navigation to its first statement: the bundle
   * fetched, parsed and evaluated) plus the build window (source, locals,
   * store, list, to the last commit signal). The fixture and engine boot
   * between them are the harness's and the kernel's, the same on every page,
   * and are reported (`engineMs`), not charged.
   */
  async function coldBootstrap(): Promise<ProtoLifecycleResult> {
    if (liveArm !== null) throw new Error('[proto] coldBootstrap: the arm is already built')
    const strayCommits = signals() - settledSignals
    beginLifecycle('coldBootstrap')
    running = true
    try {
      const window = await withCommitLogAsync(log, () =>
        timeWindow(() => {
          liveArm = build(boot)
        }),
      )
      page.corpus = corpusCounts()
      const scriptMs = scriptAt
      return {
        ...resultOf(window, strayCommits, null),
        // All three from navigation, the hold and the engine boot left out.
        actionMs: scriptMs + window.actionMs,
        drainMs: scriptMs + window.drainMs,
        frameMs: scriptMs + window.frameMs,
        phases: {
          scriptMs,
          engineMs: engineAt - scriptAt,
          buildMs: window.actionMs,
          heldMs: window.start - engineAt,
          // Navigation to the first frame after the list's last commit, the
          // driver's hold removed: what a user waits for on this page.
          loadToPaintMs: engineAt + window.frameMs,
        },
        midParity: null,
      }
    } finally {
      running = false
    }
  }

  /** Held page, untimed: build the arm and settle; the setup of a
   *  principalSwitch or rescope sample (not a lifecycle sample itself). */
  async function buildUntimed(): Promise<void> {
    if (!held || liveArm !== null) throw new Error('[proto] build: a held page with no arm only')
    liveArm = build(boot)
    page.corpus = corpusCounts()
    await settleQuiet()
  }

  let prepared: { principal: string; boot: ScenarioEngine; engineMs: number } | null = null
  /** The old principal's objects after a switch, weakly (`survivors`). */
  let oldRefs: Record<string, WeakRef<object>> | null = null

  /** Untimed: boot the next principal's runtime over a FRESH replica (and
   *  cache) on the same corpus, as a switch receives it from the kernel. */
  async function prepareRebuild(principal: string): Promise<void> {
    const began = performance.now()
    const fresh = await startEngineOnCorpus(live().boot.corpus, { ...engineOptions, principal })
    const engineMs = performance.now() - began
    await prepareEngine?.(fresh)
    prepared = { principal, boot: fresh, engineMs }
    await settleQuiet()
  }

  /**
   * principalSwitch, timed: dispose the arm (list, store, locals, source)
   * and build it over the prepared fresh engine, to the new list's last
   * commit signal. The old runtime is destroyed after the window (the
   * kernel's, frozen, the same for every arm).
   */
  async function rebuild(principal: string): Promise<ProtoLifecycleResult> {
    const next = prepared
    if (next === null || next.principal !== principal) {
      throw new Error(`[proto] rebuild(${principal}) without prepareRebuild(${principal})`)
    }
    const old = live()
    const strayCommits = signals() - settledSignals
    beginLifecycle('principalSwitch')
    prepared = null
    running = true
    try {
      let disposeMs = 0
      const window = await withCommitLogAsync(log, () =>
        timeWindow(() => {
          const began = performance.now()
          teardown(old)
          liveArm = null
          disposeMs = performance.now() - began
          liveArm = build(next.boot)
        }),
      )
      old.boot.engine.destroy()
      // Watched, never held: after the driver's forced GC none may be alive.
      oldRefs = {
        runtime: new WeakRef(old.boot.engine),
        store: new WeakRef(referenceState(old.boot.engine)),
        replica: new WeakRef(old.boot.replica),
        cache: new WeakRef(old.boot.cache),
        armHandle: new WeakRef(old.handle),
        rowSource: new WeakRef(old.source),
        scenarioEngine: new WeakRef(old.boot),
      }
      boot = next.boot
      engine = boot.engine
      page.corpus = corpusCounts()
      return {
        ...resultOf(window, strayCommits, null),
        phases: { engineMs: next.engineMs, disposeMs, buildMs: window.actionMs - disposeMs },
        midParity: null,
      }
    } finally {
      running = false
    }
  }

  /** The staged scopes (`harness/src/rescope.ts`): the grown one and the page's own. */
  let staged: { scale: 1 | 2 | 4; grown: StagedScope; base: StagedScope } | null = null
  let rescopeSeq = 1
  /** The corpus whose rows the engine holds: the boot's, or a rescope's grown one. */
  let installedCorpus: FixtureCorpus | null = null

  /** Untimed: the corpus at `to` (rows and scans), and the page's own to come back to. */
  async function prepareRescope(to: 1 | 2 | 4): Promise<void> {
    if (to === scale)
      throw new Error(`[proto] prepareRescope(${to}): the page is already at ${scale}x`)
    staged = {
      scale: to,
      grown: scopeOfCorpus(to),
      base: currentScope(live().boot, live().boot.corpus),
    }
    await settleQuiet()
  }

  /**
   * Untimed: the scope's SCANS published and settled, then its ROWS staged
   * in the kernel cache (POD-4572, coordinator ruling: a real rescope brings
   * both). The arm hears the scans as a publication and draws what it draws
   * before the timed install; that settle is the harness's, the same for
   * every arm.
   */
  async function stageScope(scope: StagedScope): Promise<void> {
    await stageScans(live().boot, scope.repos)
    await settleQuiet()
    stageRows(live().boot, scope.rows)
  }

  /**
   * POD-4715 — untimed heal for POD-4722 (a production bug of the current app,
   * filed outside round three; documented in `docs/plans/pod-4441-harness.md`
   * "Lifecycle walls", and the control's grow wall stays flagged stale there).
   *
   * A kernel rescope install notifies the replica binding before the
   * issue-view cache, and the mounted control list's synchronous snapshot
   * check then derives against not-yet-invalidated views: the grown-only rows
   * are skipped, the partial list is consecrated as unchanged, and it is
   * pinned under the grown store — so the control page would read 735 of
   * 1,464 grown rows (and its oracle the same) while the pools, which never
   * derive inside the cascade, read the true grown state.
   *
   * This step publishes a fresh store snapshot with no row changes (a
   * discovery refresh answering the already-staged repos) and settles, so the
   * next derive rebuilds models from refreshed views. Same step on every page
   * (the pools and the floor ignore it); untimed, after each install window,
   * before midParity, grownRows and the driver's after-step reads. The timed
   * install windows are untouched; rescope carries no wall budget, and the
   * budgeted heap growth must reflect a correct round trip, which the stale
   * control never makes.
   */
  async function healGrownDerivation(): Promise<void> {
    await referenceState(live().boot.engine).refreshRepos()
    await settleQuiet()
  }

  /**
   * rescope, timed in two windows: the install onto the staged corpus (2x the
   * page's), then, the page's own rows restaged untimed, the install back.
   * `actionMs` is the two windows' sum; the kernel cache writes before each
   * install are untimed (the kernel's, the same for every arm). Parity at the
   * grown state is taken between the windows (`midParity`); the driver takes
   * it again after the return.
   */
  async function rescope(to: 1 | 2 | 4): Promise<ProtoLifecycleResult> {
    const stage = staged
    if (stage === null || stage.scale !== to) {
      throw new Error(`[proto] rescope(${to}) without prepareRescope(${to})`)
    }
    const strayCommits = signals() - settledSignals
    beginLifecycle('rescope')
    running = true
    try {
      const fire = (): void => {
        rescopeSeq += 1
        fireRescope(live().boot, rescopeSeq)
      }
      await stageScope(stage.grown)
      installedCorpus = stage.grown.corpus
      const grow = await withCommitLogAsync(log, () => timeWindow(fire))
      // POD-4715: untimed heal (POD-4722), same on every page — see
      // healGrownDerivation. The timed install above is untouched.
      await healGrownDerivation()
      const midParity = parityNow()
      const grownRows = Object.keys(live().handle.snapshot().rowsById).length
      await stageScope(stage.base)
      installedCorpus = null
      const back = await withCommitLogAsync(log, () => timeWindow(fire))
      // Same heal after the return trip, before the driver's after-step reads.
      await healGrownDerivation()
      return {
        commits: grow.commits + back.commits,
        mounts: grow.mounts + back.mounts,
        domMutations: grow.domMutations + back.domMutations,
        strayCommits,
        stats: {
          rowsDerived: grow.stats.rowsDerived + back.stats.rowsDerived,
          rollupsDerived: grow.stats.rollupsDerived + back.stats.rollupsDerived,
          indexUpdates: grow.stats.indexUpdates + back.stats.indexUpdates,
          notifications: grow.stats.notifications + back.stats.notifications,
        },
        drainMs: grow.drainMs + back.drainMs,
        actionMs: grow.actionMs + back.actionMs,
        frameMs: grow.frameMs + back.frameMs,
        endedBy: back.endedBy,
        longTasks: [...grow.longTasks, ...back.longTasks],
        mountedRows: back.mountedRows,
        target: null,
        phases: {
          growMs: grow.actionMs,
          backMs: back.actionMs,
          grownRows,
          grownIssues: stage.grown.rows.filter((row) => row.entity === 'issue').length,
          baseIssues: stage.base.rows.filter((row) => row.entity === 'issue').length,
        },
        midParity,
      }
    } finally {
      running = false
    }
  }

  const corpusCounts = (): ProtoCorpusCounts => ({
    ...counts,
    rows: liveArm === null ? 0 : Object.keys(liveArm.handle.snapshot().rowsById).length,
  })

  /**
   * Check mode: rows mounted before AND after the change, compared both ways
   * (the count harness's exact-commit rule, `changedViews`, over the drawn
   * rows): the oracle's changed views against the arm's redraws (commits, or
   * remounts). A row entering or leaving the window mounts or unmounts; that
   * is not a redraw and is not compared.
   */
  function verify(): ProtoOracleCheck | null {
    const run = lastRun
    if (!checkMode || run === null || run.before === null) return null
    lastRun = null
    const after = rowViewsFromStore(referenceState(engine), localsOfEngine(engine))
    const mountedAfter = mountedIds()
    const both = (id: string): boolean =>
      run.before !== null &&
      run.before.mounted.has(id) &&
      mountedAfter.has(id) &&
      id in run.before.views &&
      id in after
    const changed = Object.keys(after)
      .filter(
        (id) => both(id) && JSON.stringify(run.before?.views[id]) !== JSON.stringify(after[id]),
      )
      .sort()
    const drawnSet = new Set<string>()
    for (const id of log.counts.keys()) if (both(id)) drawnSet.add(id)
    for (const [id, n] of log.mounts) if (n > 0 && both(id)) drawnSet.add(id)
    const drawn = [...drawnSet].sort()
    return {
      changed,
      drawn,
      over: drawn.filter((id) => !changed.includes(id)),
      under: changed.filter((id) => !drawnSet.has(id)),
    }
  }

  const page: ProtoPage = {
    ready: true,
    held,
    arm: armName,
    scale,
    cell,
    corpus: corpusCounts(),
    runtimeSha,
    prepare,
    runScenario,
    verify,
    firstWindow,
    describeTop: (n: number) => {
      const { order } = oracleSnapshot(referenceState(engine))
      const pinned = new Set(order.pinnedIds)
      return [...order.pinnedIds, ...order.groups.flatMap((group) => group.rowIds)]
        .slice(0, n)
        .map((id) => ({
          id,
          pinned: pinned.has(id),
          root: rules.root(id),
          rename: rules.openRootWithChildren(id),
          stagemove: rules.childlessRoot(id),
        }))
    },
    settle: async () => {
      await settleQuiet()
    },
    quietMs: QUIET_MS,
    snapshotHash: () => parityNow().arm,
    oracleHash: () => parityNow().oracle,
    firstDifference: () => parityNow().firstDifference,
    stats: statsOf,
    coldBootstrap,
    build: buildUntimed,
    prepareRebuild,
    rebuild,
    prepareRescope,
    rescope,
    lateSignals: () => signals() - settledSignals,
    survivors: () =>
      Object.entries(oldRefs ?? {})
        .filter(([, ref]) => ref.deref() !== undefined)
        .map(([name]) => name),
  }
  window.__proto = page
}

/** Placeholder page for arms whose issue has not landed yet. */
export function mountStub(arm: string, reason: string, runtimeSha: string): void {
  document.getElementById('root')!.textContent = `${arm}: ${reason}`
  const refuse = (): Promise<never> =>
    Promise.reject(new Error(`[proto] ${arm} not implemented: ${reason}`))
  window.__proto = {
    ready: false,
    held: false,
    arm,
    scale: readScale(),
    cell: null,
    corpus: { issues: 0, sessions: 0, repos: 0, worktrees: 0, rows: 0 },
    runtimeSha,
    prepare: () => Promise.reject(new Error(`[proto] ${arm} not implemented: ${reason}`)),
    runScenario: () => Promise.reject(new Error(`[proto] ${arm} not implemented: ${reason}`)),
    verify: () => null,
    firstWindow: () => [],
    describeTop: () => [],
    settle: () => Promise.resolve(),
    quietMs: 0,
    snapshotHash: () => 'pending',
    oracleHash: () => 'pending',
    firstDifference: () => null,
    stats: () => ({ rowsDerived: 0, rollupsDerived: 0, indexUpdates: 0, notifications: 0 }),
    coldBootstrap: refuse,
    build: refuse,
    prepareRebuild: refuse,
    rebuild: refuse,
    prepareRescope: refuse,
    rescope: refuse,
    lateSignals: () => 0,
    survivors: () => [],
  }
}
