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
 * - `rename`: title dual-write on a DRAWN open root (#4).
 * - `stagemove`: stage dual-write (open → done/tucked) on a DRAWN childless
 *   open root (#5); the next `prepare` reopens it untimed (its server rows
 *   restored), so every sample is the same move of the same row.
 * - `clock`: advance the clock 60 s with no row change, through the runtime's
 *   own tick path (the control derives from the engine clock) and on the
 *   locals channel (round-three arms); bands re-derive from the new now (#8).
 * - `click`: a pointer event and click on a DRAWN row's pressable (#3). Every
 *   sample clicks a row this page has never selected, so every sample is the
 *   same selection change; a second click on a read row would time a
 *   selection alone and mix two workloads in one cell.
 *
 * DRAWN TARGETS (POD-4558, coordinator ruling on finding #4). A change aimed at
 * a row the arm has not drawn commits nothing on a windowed arm and the whole
 * list on the control, so the comparison would time the control's redraw
 * against an arm doing nothing. Every row target is therefore picked by rule,
 * identically for every arm, from the FIRST WINDOW: the oracle's first
 * `FIRST_WINDOW_ROWS` rows of the list as it stands before the change (never
 * an arm's own draw order), pinned rows excluded. The rules are the scenario
 * library's (`pickTargets`): the rename takes the first open human root with
 * children; the stage move the first childless open root (`childlessRoot`);
 * each click the first row neither rule wants, then any. Before every write
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
 */

import type { Arm, ArmHandle, RowSource } from '../../shared/src/arm'
import { settableLocals } from '../../shared/src/locals-source'
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
  type ScenarioEngine,
  upsert,
} from '../../shared/src/scenarios'
import type { SliceLocals } from '../../shared/src/slice-types'
import { oracleSnapshot, type RowViews, rowViewsFromStore } from '../src/oracle/index'

export type ProtoScenarioName = 'heartbeat' | 'rename' | 'stagemove' | 'clock' | 'click'

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
  /** The row the change aimed at (rename, stagemove, click); the session for heartbeat; null for clock. */
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

export interface ProtoPage {
  ready: boolean
  arm: string
  scale: 1 | 2 | 4
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
  /** Wait (untimed) until the page is quiet; the driver calls it before the first change. */
  settle(): Promise<void>
  /** The settle's quiet window, ms. */
  quietMs: number
  snapshotHash(): string
  stats(): ProtoScenarioResult['stats']
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
 * The rows every arm draws with no scroll: hand and MobX mount 14 rows of
 * 56 px above the fold at 1600×1000 (17 with overscan), the control and the
 * no-op page more. Targets come from the oracle's first rows, so an arm that
 * draws fewer fails the mounted assertion instead of timing an undrawn row.
 */
export const FIRST_WINDOW_ROWS = 14

type IssueFacts = {
  id: string
  parentId?: string | null
  stage: string
  archived: boolean
  audience?: string
  closedAt?: string | null
  deletedAt?: string | null
  pinned?: boolean
  draft?: boolean
}

const ACTIVE_STAGES = new Set(['in_progress', 'planning', 'review'])

/** The scenario library's target rules (`pickTargets`), over the corpus facts. */
function targetRules(boot: ScenarioEngine): {
  openRootWithChildren: (id: string) => boolean
  childlessRoot: (id: string) => boolean
} {
  const issues = boot.corpus.issues as unknown as IssueFacts[]
  const byId = new Map(issues.map((i) => [i.id, i]))
  const parents = new Set<string>()
  for (const issue of issues) if (issue.parentId) parents.add(issue.parentId)
  const openRoot = (id: string): boolean => {
    const i = byId.get(id)
    return (
      i !== undefined &&
      i.audience === 'human' &&
      !i.archived &&
      !i.deletedAt &&
      !i.closedAt &&
      !i.draft &&
      ACTIVE_STAGES.has(i.stage) &&
      !i.parentId &&
      !i.pinned
    )
  }
  return {
    openRootWithChildren: (id) => openRoot(id) && parents.has(id),
    childlessRoot: (id) => openRoot(id) && !parents.has(id),
  }
}

export interface MountPageOptions {
  arm: string
  createArm: () => Arm
  source: RowSource
  boot: ScenarioEngine
  scale: 1 | 2 | 4
  counts: { issues: number; sessions: number; repos: number; worktrees: number }
  runtimeSha: string
  el: Element
}

export function readScale(): 1 | 2 | 4 {
  const raw = new URLSearchParams(window.location.search).get('scale')
  return raw === '2' ? 2 : raw === '4' ? 4 : 1
}

export function mountPage(options: MountPageOptions): { handle: ArmHandle; log: CommitLog } {
  const { createArm, source, boot, scale, counts, runtimeSha, el } = options
  const { engine } = boot
  const locals = settableLocals({
    selectedIssueId: null,
    coarseNow: engine.getSnapshot().coarseNow,
  })
  const arm = createArm()
  const handle = arm.create(source, locals.source)
  const log = createTimedCommitLog()
  withCommitLog(log, () => {
    const unmount = handle.mountWeb(el)
    void unmount
  })

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

  const statsOf = (): ProtoScenarioResult['stats'] => ({
    rowsDerived: handle.stats.rowsDerived,
    rollupsDerived: handle.stats.rollupsDerived,
    indexUpdates: handle.stats.indexUpdates,
    notifications: handle.stats.notifications,
  })

  const params = new URLSearchParams(window.location.search)
  const checkMode = params.get('check') === '1'
  const rules = targetRules(boot)

  /** The oracle's first window of the list as it stands now, pinned rows out. */
  function firstWindow(): string[] {
    const { order } = oracleSnapshot(engine.getSnapshot())
    const pinned = new Set(order.pinnedIds)
    return [...order.pinnedIds, ...order.groups.flatMap((group) => group.rowIds)]
      .slice(0, FIRST_WINDOW_ROWS)
      .filter((id) => !pinned.has(id))
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
        `[proto] ${scenario}: target ${id} is not drawn by ${options.arm} (first window ${firstWindow().join(',')}); refusing to time an undrawn row`,
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
  if (renameTarget === undefined) {
    throw new Error(
      `[proto] rename: no open root with children in the first window ${bootWindow.join(',')}`,
    )
  }
  let renames = 0
  function rename(): void {
    const id = renameTarget as string
    const wire = engine.getSnapshot().issues.find((issue) => issue.id === id)
    if (!wire) throw new Error(`[proto] issue ${id} missing`)
    renames += 1
    applyTitleRename(boot, id, `${wire.title} (proto ${renames})`)
  }
  const fresh = (id: string): boolean => id !== renameTarget && !moved.has(id) && !clicked.has(id)
  /** #5: the first drawn childless open root no click selected. Each move is
   *  undone before the next change (`prepare`), so every sample moves the same
   *  row from the same place across the same groups. */
  function nextStageMove(): string {
    const window = firstWindow()
    const id = window.find(
      (candidate) =>
        candidate !== renameTarget && !clicked.has(candidate) && rules.childlessRoot(candidate),
    )
    if (id === undefined) {
      throw new Error(
        `[proto] stagemove: no unclicked childless open root in the first window ${window.join(',')}`,
      )
    }
    return id
  }
  /** #3: a fresh drawn row every sample; rows the rename and stage-move rules want go last. */
  function nextClick(): string {
    const window = firstWindow().filter(fresh)
    const wanted = (id: string): boolean =>
      rules.childlessRoot(id) || rules.openRootWithChildren(id)
    const id = window.find((candidate) => !wanted(candidate)) ?? window[0]
    if (id === undefined)
      throw new Error('[proto] click: no fresh row in the first window; load a fresh page')
    return id
  }

  /** The page clock: the runtime's own tick (the control derives from the
   *  engine clock), the same instant on the locals channel (POD-4608), drained
   *  at once, and round-two arms' store hook. No row changes — bands and
   *  folds re-derive from the new now. */
  let pageNow = locals.source.get().coarseNow
  function clock(): void {
    pageNow += 60_000
    boot.advanceClock(60_000)
    locals.set({ coarseNow: pageNow })
    locals.flush()
    const store = (handle as unknown as { store?: { setCoarseNow?: (now: number) => void } }).store
    if (store?.setCoarseNow !== undefined) store.setCoarseNow(pageNow)
  }

  /** The selection the oracle's row views show (the page's clicks). */
  let selected: string | null = null
  const oracleLocals = (): SliceLocals => ({
    selectedIssueId: selected,
    coarseNow: engine.getSnapshot().coarseNow,
  })

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

  interface Plan {
    name: ProtoScenarioName
    target: string | null
    /** The target is a row: it must be drawn when the change is dispatched. */
    row: boolean
    dispatch: () => void
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
      case 'rename':
        return { target: renameTarget as string, row: true, dispatch: rename }
      case 'stagemove': {
        const id = nextStageMove()
        // Server truth before the move, for the untimed reopen in the next `prepare`.
        const wire = boot.cache.read('issue', id)?.value
        const projection = boot.cache.read('issueProjection', id)?.value
        if (wire === undefined) throw new Error(`[proto] stagemove: ${id} missing from the cache`)
        return {
          target: id,
          row: true,
          dispatch: () => {
            moved.add(id)
            applyStageMove(boot, id)
            reopen = () =>
              boot.replica.batch(() => {
                upsert(boot, 'issue', id, wire)
                if (projection !== undefined) upsert(boot, 'issueProjection', id, projection)
              })
          },
        }
      }
      case 'clock':
        return { target: null, row: false, dispatch: clock }
      case 'click': {
        const id = nextClick()
        const button = el.querySelector(`[data-issue-row="${CSS.escape(id)}"] [data-pressable]`)
        if (!(button instanceof HTMLElement)) {
          throw new Error(`[proto] click: ${id} is not drawn with a pressable by ${options.arm}`)
        }
        return {
          target: id,
          row: true,
          dispatch: () => {
            clicked.add(id)
            selected = id
            if (!button.isConnected)
              throw new Error(`[proto] click: ${id}'s pressable was replaced`)
            button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
            button.click()
          },
        }
      }
    }
  }

  /** The last stage move's undo: its row's server truth restored, untimed. */
  let reopen: (() => void) | null = null

  async function prepare(name: ProtoScenarioName): Promise<string | null> {
    if (running) throw new Error('[proto] prepare during a running change')
    if (reopen !== null) {
      // Put the moved row back where it was (same server rows, so the same
      // place in the list) and settle, so every stage move is the same move of
      // the same drawn row and the window never runs out of targets.
      const undo = reopen
      reopen = null
      undo()
      await settleQuiet()
    }
    const next = planFor(name)
    if (next.row && next.target !== null) assertDrawn(name, next.target)
    plan = {
      ...next,
      name,
      before: checkMode
        ? { views: rowViewsFromStore(engine.getSnapshot(), oracleLocals()), mounted: mountedIds() }
        : null,
    }
    return next.target
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
        handle.stats.reset()
        log.reset()
        drainLongTasks()
        longTasks.length = 0
        const domBefore = domRecords
        const windowSignals = signals()

        const start = performance.now()
        current.dispatch()
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
        lastRun = current
        return {
          commits: log.total(),
          mounts: [...log.mounts.values()].reduce((sum, n) => sum + n, 0),
          domMutations: domRecords - domBefore,
          strayCommits,
          stats: statsOf(),
          drainMs: drainEnd - start,
          actionMs: end - start,
          frameMs: frameAt - start,
          endedBy,
          longTasks: longTasks.filter(
            (t) => t.startTime + t.duration > start && t.startTime < settleEnd,
          ),
          mountedRows: el.querySelectorAll('[data-issue-row]').length,
          target: current.target,
        }
      })
    } finally {
      running = false
    }
  }

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
    const after = rowViewsFromStore(engine.getSnapshot(), oracleLocals())
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

  window.__proto = {
    ready: true,
    arm: options.arm,
    scale,
    corpus: { ...counts, rows: Object.keys(handle.snapshot().rowsById).length },
    runtimeSha,
    prepare,
    runScenario,
    verify,
    firstWindow,
    settle: async () => {
      await settleQuiet()
    },
    quietMs: QUIET_MS,
    snapshotHash: () => hashString(JSON.stringify(handle.snapshot())),
    stats: statsOf,
  }
  return { handle, log }
}

/** Placeholder page for arms whose issue has not landed yet. */
export function mountStub(arm: string, reason: string, runtimeSha: string): void {
  document.getElementById('root')!.textContent = `${arm}: ${reason}`
  window.__proto = {
    ready: false,
    arm,
    scale: readScale(),
    corpus: { issues: 0, sessions: 0, repos: 0, worktrees: 0, rows: 0 },
    runtimeSha,
    prepare: () => Promise.reject(new Error(`[proto] ${arm} not implemented: ${reason}`)),
    runScenario: () => Promise.reject(new Error(`[proto] ${arm} not implemented: ${reason}`)),
    verify: () => null,
    firstWindow: () => [],
    settle: () => Promise.resolve(),
    quietMs: 0,
    snapshotHash: () => 'pending',
    stats: () => ({ rowsDerived: 0, rollupsDerived: 0, indexUpdates: 0, notifications: 0 }),
  }
}
