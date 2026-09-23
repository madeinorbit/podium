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
 * - `rename`: title dual-write on the library's visible-root target (#4).
 * - `stagemove`: stage dual-write (open → done/tucked) on a fresh childless
 *   open root per sample, picked from the corpus by rule (#5).
 * - `clock`: advance the clock 60 s with no row change, through the runtime's
 *   own tick path (the control derives from the engine clock) and on the
 *   locals channel (round-three arms); bands re-derive from the new now (#8).
 * - `click`: a pointer event and click on a row's pressable (#3). Every
 *   sample clicks a row this page has never selected, so every sample is a
 *   selection change plus the eager mark-read (POD-4619); a second click on a
 *   read row would time a selection alone and mix two workloads in one cell.
 *   The row is the library's `visibleRootId` or `markReadId` if the list has
 *   them mounted, else the mounted issue row with the lowest id: chosen by id,
 *   never by the arm's draw order, and never a row a stage move has taken.
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
} from '../../shared/src/scenarios'

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
  /** The row the change aimed at (stagemove, click); null otherwise. */
  target: string | null
}

export interface ProtoPage {
  ready: boolean
  arm: string
  scale: 1 | 2 | 4
  corpus: ProtoCorpusCounts
  runtimeSha: string
  runScenario(name: ProtoScenarioName): Promise<ProtoScenarioResult>
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
 * Fresh stage-move targets, one per sample: childless open human roots, in
 * id order, excluding every other scenario target. The rule is the scenario
 * library's `childlessRoot` (`pickTargets`), so the rows are visible and the
 * move crosses into the closed fold on every arm; they are chosen from the
 * corpus, never from an arm's output order.
 */
function stageMoveSequence(boot: ScenarioEngine): string[] {
  type Facts = {
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
  const issues = boot.corpus.issues as unknown as Facts[]
  const parents = new Set<string>()
  for (const issue of issues) if (issue.parentId) parents.add(issue.parentId)
  const t = boot.targets
  const taken = new Set<string>([
    t.visibleRootId,
    t.archiveId,
    t.evictId,
    t.keeperLeafId,
    t.keeperParentId,
    t.reparentId,
    t.reparentToId,
    t.markReadId,
    boot.corpus.unscannedWorktree.issueId,
    ...t.burstIssueIds,
  ])
  const active = new Set(['in_progress', 'planning', 'review'])
  return issues
    .filter(
      (i) =>
        i.audience === 'human' &&
        !i.archived &&
        !i.deletedAt &&
        !i.closedAt &&
        !i.draft &&
        active.has(i.stage) &&
        !i.parentId &&
        !parents.has(i.id) &&
        !i.pinned &&
        !taken.has(i.id),
    )
    .map((i) => i.id)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
}

const byNumericId = (a: string, b: string): number => Number(a.slice(1)) - Number(b.slice(1))

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

  let renames = 0
  function rename(): string {
    const id = boot.targets.visibleRootId
    const wire = engine.getSnapshot().issues.find((issue) => issue.id === id)
    if (!wire) throw new Error(`[proto] issue ${id} missing`)
    renames += 1
    applyTitleRename(boot, id, `${wire.title} (proto ${renames})`)
    return id
  }

  const stageMoves = stageMoveSequence(boot)
  const moved = new Set<string>()
  const clicked = new Set<string>()
  /** A fresh row every sample (never one a click selected), so every sample
   *  measures a real group move of an unselected row. */
  function nextStageMove(): string {
    const id = stageMoves.find((candidate) => !moved.has(candidate) && !clicked.has(candidate))
    if (id === undefined) {
      throw new Error(`[proto] stagemove: ${stageMoves.length} targets used up; load a fresh page`)
    }
    moved.add(id)
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

  /** The first never-clicked, never-moved mounted row, and its pressable. */
  function nextClick(): { id: string; button: HTMLElement } {
    const mounted = [...el.querySelectorAll('[data-issue-row]')]
      .map((row) => row.getAttribute('data-issue-row') ?? '')
      .filter((id) => /^i\d+$/.test(id))
      .sort(byNumericId)
    const candidates = [boot.targets.visibleRootId, boot.targets.markReadId, ...mounted]
    for (const id of candidates) {
      if (clicked.has(id) || moved.has(id)) continue
      const button = el.querySelector(`[data-issue-row="${CSS.escape(id)}"] [data-pressable]`)
      if (!(button instanceof HTMLElement)) continue
      clicked.add(id)
      return { id, button }
    }
    throw new Error(
      `[proto] click: no unclicked candidate is mounted (${clicked.size} used); load a fresh page`,
    )
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

  /** Time one change: `prepare` runs untimed and returns the dispatch. */
  async function measure(
    prepare: () => { target: string | null; dispatch: () => void },
  ): Promise<ProtoScenarioResult> {
    if (running) throw new Error('[proto] runScenario is not re-entrant')
    running = true
    try {
      return await withCommitLogAsync(log, async () => {
        const { target, dispatch } = prepare()
        const strayCommits = signals() - settledSignals
        handle.stats.reset()
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
          target,
        }
      })
    } finally {
      running = false
    }
  }

  function runScenario(name: ProtoScenarioName): Promise<ProtoScenarioResult> {
    return measure(() => {
      switch (name) {
        case 'heartbeat':
          return {
            target: boot.targets.heartbeatSessionId,
            dispatch: () => void applyHeartbeat(boot),
          }
        case 'rename':
          return { target: boot.targets.visibleRootId, dispatch: () => void rename() }
        case 'stagemove': {
          const id = nextStageMove()
          return { target: id, dispatch: () => void applyStageMove(boot, id) }
        }
        case 'clock':
          return { target: null, dispatch: clock }
        case 'click': {
          const { id, button } = nextClick()
          return {
            target: id,
            dispatch: () => {
              button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
              button.click()
            },
          }
        }
      }
    })
  }

  window.__proto = {
    ready: true,
    arm: options.arm,
    scale,
    corpus: { ...counts, rows: Object.keys(handle.snapshot().rowsById).length },
    runtimeSha,
    runScenario,
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
    runScenario: () => Promise.reject(new Error(`[proto] ${arm} not implemented: ${reason}`)),
    settle: () => Promise.resolve(),
    quietMs: 0,
    snapshotHash: () => 'pending',
    stats: () => ({ rowsDerived: 0, rollupsDerived: 0, indexUpdates: 0, notifications: 0 }),
  }
}
