/**
 * POD-4445 — shared web-entry wiring. Every arm/control page mounts the same
 * way over a kernel seeded at the `?scale=` corpus and exposes the same
 * `window.__proto` surface the browser driver drives. The control is measured
 * exactly like the arms: same shell, same scenarios, same field names.
 *
 * Page scenarios (the G4 browser set — counts in CI cover all thirteen G3
 * scenarios; walls in Chromium cover the hot path):
 * - `heartbeat`: lastActiveAt bump on the first session (methodology #1).
 * - `rename`: title dual-write on the first visible row (#4).
 * - `stagemove`: stage dual-write (open → done/tucked) on the first
 *   non-closed visible row, a fresh row per sample (#5).
 * - `clock`: advance the slice clock 60 s with no row change; arms re-derive
 *   bands from the new now, the control follows its locals (#8).
 * - `click`: select the first visible row via `clickRow` (#3, input-to-paint).
 */

import { asIssueId } from '@podium/model'
import type { Arm, ArmHandle, RowSource } from '../../shared/src/arm'
import {
  createCommitLog,
  withCommitLog,
  withCommitLogAsync,
  type CommitLog,
} from '../../shared/src/row-shell'
import type { SliceLocals } from '../../shared/src/slice-types'
import type { EngineBootstrap } from '../src/engine-bootstrap'

export interface ProtoCorpusCounts {
  issues: number
  sessions: number
  repos: number
  worktrees: number
  rows: number
}

export interface ProtoScenarioResult {
  commits: number
  stats: { rowsDerived: number; rollupsDerived: number; indexUpdates: number; notifications: number }
  /** Wall time of the scenario action including settle, ms (NOT input-to-paint). */
  taskMs: number
  longTasks: { startTime: number; duration: number }[]
  /** Rows currently mounted in the windowed list (commits only observe these). */
  mountedRows: number
}

export interface ProtoPage {
  ready: boolean
  arm: string
  scale: 1 | 2 | 4
  corpus: ProtoCorpusCounts
  runtimeSha: string
  runScenario(
    name: 'heartbeat' | 'rename' | 'stagemove' | 'clock' | 'click',
  ): Promise<ProtoScenarioResult>
  clickRow(id?: string): Promise<{
    inputMs: number
    paintMs: number
    longTasks: { startTime: number; duration: number }[]
    commits: number
    mountedRows: number
  }>
  snapshotHash(): string
  stats(): ProtoScenarioResult['stats']
}

declare global {
  interface Window {
    __proto: ProtoPage
  }
}

function hashString(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}

const doubleRaf = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })

async function waitForNotifications(
  handle: ArmHandle,
  before: number,
  timeoutMs: number,
): Promise<void> {
  const start = performance.now()
  while (handle.stats.notifications <= before) {
    if (performance.now() - start > timeoutMs) return
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

export interface MountPageOptions {
  arm: string
  createArm: () => Arm
  source: RowSource
  boot: EngineBootstrap
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
  const { createArm, source, boot, scale, counts, runtimeSha } = options
  const { engine, replica, cache } = boot
  const locals: SliceLocals = {
    selectedIssueId: null,
    coarseNow: engine.getSnapshot().coarseNow,
  }
  const arm = createArm()
  const handle = arm.create(source, locals)
  const log = createCommitLog()
  withCommitLog(log, () => {
    const unmount = handle.mountWeb(options.el)
    void unmount
  })

  const longTasks: { startTime: number; duration: number }[] = []
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ startTime: entry.startTime, duration: entry.duration })
      }
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    // Older Chromium: taskMs and input-to-paint remain useful.
  }

  const statsOf = (): ProtoScenarioResult['stats'] => ({
    rowsDerived: handle.stats.rowsDerived,
    rollupsDerived: handle.stats.rollupsDerived,
    indexUpdates: handle.stats.indexUpdates,
    notifications: handle.stats.notifications,
  })

  const firstSessionId = (): string => {
    const sessions = engine.getSnapshot().sessions
    if (sessions.length === 0) throw new Error('[proto] no sessions in corpus')
    return sessions[0]!.sessionId
  }

  const firstVisibleId = (): string => {
    const ids = Object.keys(handle.snapshot().rowsById)
    if (ids.length === 0) throw new Error('[proto] no visible rows')
    return ids[0]!
  }

  async function heartbeat(): Promise<void> {
    const id = firstSessionId()
    const current = engine
      .getSnapshot()
      .sessions.find((session) => session.sessionId === id)
    if (!current) throw new Error(`[proto] session ${id} missing`)
    const next = { ...current, lastActiveAt: new Date().toISOString() }
    cache.put('session', id, next)
    replica.onKernelEvent({
      type: 'upserted',
      record: { entity: 'session', entityId: id, value: next, provenance: { seq: 2 } },
      readmitted: false,
    } as never)
  }

  async function rename(): Promise<void> {
    const id = firstVisibleId()
    const snap = engine.getSnapshot()
    const wire = snap.issues.find((issue) => issue.id === id)
    if (!wire) throw new Error(`[proto] issue ${id} missing`)
    const title = `${wire.title} (proto)`
    const nextWire = { ...wire, title }
    const projection = cache.read('issueProjection', id)
    const nextProjection = { ...((projection as { value?: object } | undefined)?.value ?? {}), title }
    replica.batch(() => {
      cache.put('issue', id, nextWire)
      replica.onKernelEvent({
        type: 'upserted',
        record: { entity: 'issue', entityId: id, value: nextWire, provenance: { seq: 2 } },
        readmitted: false,
      } as never)
      cache.put('issueProjection', id, nextProjection)
      replica.onKernelEvent({
        type: 'upserted',
        record: { entity: 'issueProjection', entityId: id, value: nextProjection, provenance: { seq: 2 } },
        readmitted: false,
      } as never)
    })
  }

  /** First visible row that is not in the closed fold: every sample moves a
   *  fresh row, so every sample measures a real group move (reusing a row
   *  would measure a redundant done-write instead). */
  function firstOpenId(): string {
    const rows = handle.snapshot().rowsById
    for (const id of Object.keys(rows)) {
      if (rows[id]?.closed === false) return id
    }
    throw new Error('[proto] no open row for stagemove')
  }

  async function stagemove(): Promise<void> {
    const id = firstOpenId()
    const snap = engine.getSnapshot()
    const wire = snap.issues.find((issue) => issue.id === id)
    if (!wire) throw new Error(`[proto] issue ${id} missing`)
    const now = new Date().toISOString()
    const nextWire = { ...wire, stage: 'done', closedAt: now, closedReason: 'shipped', tuckedAt: now }
    const projection = cache.read('issueProjection', id)
    const nextProjection = { ...((projection as { value?: object } | undefined)?.value ?? {}), stage: 'done' }
    replica.batch(() => {
      cache.put('issue', id, nextWire)
      replica.onKernelEvent({
        type: 'upserted',
        record: { entity: 'issue', entityId: id, value: nextWire, provenance: { seq: 2 } },
        readmitted: false,
      } as never)
      cache.put('issueProjection', id, nextProjection)
      replica.onKernelEvent({
        type: 'upserted',
        record: { entity: 'issueProjection', entityId: id, value: nextProjection, provenance: { seq: 2 } },
        readmitted: false,
      } as never)
    })
  }

  /** The page clock: arms tick through their store hook, the control follows
   *  the locals object its snapshot reads. No row changes — bands and folds
   *  re-derive from the new now. */
  let pageNow = locals.coarseNow
  async function clock(): Promise<void> {
    pageNow += 60_000
    locals.coarseNow = pageNow
    const store = (handle as unknown as { store?: { setCoarseNow?: (now: number) => void } }).store
    if (store?.setCoarseNow !== undefined) store.setCoarseNow(pageNow)
  }

  function clickRowInPage(
    id?: string,
  ): Promise<{
    inputMs: number
    paintMs: number
    longTasks: { startTime: number; duration: number }[]
    commits: number
    mountedRows: number
  }> {
    const rowId = id ?? firstVisibleId()
    const button = document.querySelector(
      `[data-issue-row="${CSS.escape(rowId)}"] [data-pressable]`,
    )
    if (!button) throw new Error(`[proto] no pressable for row ${rowId}`)
    longTasks.length = 0
    return withCommitLogAsync(log, async () => {
      log.reset()
      const inputMs = performance.now()
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      ;(button as HTMLElement).click()
      await doubleRaf()
      return {
        inputMs,
        paintMs: performance.now(),
        longTasks: [...longTasks],
        commits: log.total(),
        mountedRows: document.querySelectorAll('[data-issue-row]').length,
      }
    })
  }

  async function runScenario(
    name: 'heartbeat' | 'rename' | 'stagemove' | 'clock' | 'click',
  ): Promise<ProtoScenarioResult> {
    handle.stats.reset()
    log.reset()
    longTasks.length = 0
    const notificationsBefore = handle.stats.notifications
    const start = performance.now()
    await withCommitLogAsync(log, async () => {
      if (name === 'heartbeat') await heartbeat()
      else if (name === 'rename') await rename()
      else if (name === 'stagemove') await stagemove()
      else if (name === 'clock') await clock()
      else {
        const rowId = firstVisibleId()
        engine.getSnapshot().setSelectedIssueId(asIssueId(rowId))
      }
      // The clock tick is locals-only by design (no row event, and the
      // control emits no publication for it either): nothing to wait for —
      // the arm pipeline runs synchronously inside setCoarseNow and the
      // paint settles below.
      if (name !== 'clock') await waitForNotifications(handle, notificationsBefore, 3000)
      await doubleRaf()
    })
    const commitsEarly = log.total()
    // TEMP DIAGNOSTIC (POD-4450): is the commit log late or dead?
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    const commitsLate = log.total()
    // eslint-disable-next-line no-console
    console.info(`[proto-debug] ${name}: early=${commitsEarly} late=${commitsLate}`)
    return {
      commits: commitsLate,
      stats: statsOf(),
      taskMs: performance.now() - start,
      longTasks: [...longTasks],
      mountedRows: document.querySelectorAll('[data-issue-row]').length,
    }
  }

  window.__proto = {
    ready: true,
    arm: options.arm,
    scale,
    corpus: { ...counts, rows: Object.keys(handle.snapshot().rowsById).length },
    runtimeSha,
    runScenario,
    clickRow: clickRowInPage,
    snapshotHash: () => hashString(JSON.stringify(handle.snapshot())),
    stats: statsOf,
  }
  return { handle, log }
}

/** Placeholder page for arms whose H issue has not landed yet. */
export function mountStub(arm: string, reason: string, runtimeSha: string): void {
  document.getElementById('root')!.textContent = `${arm}: ${reason}`
  window.__proto = {
    ready: false,
    arm,
    scale: readScale(),
    corpus: { issues: 0, sessions: 0, repos: 0, worktrees: 0, rows: 0 },
    runtimeSha,
    runScenario: () => Promise.reject(new Error(`[proto] ${arm} not implemented: ${reason}`)),
    clickRow: () => Promise.reject(new Error(`[proto] ${arm} not implemented: ${reason}`)),
    snapshotHash: () => 'pending',
    stats: () => ({ rowsDerived: 0, rollupsDerived: 0, indexUpdates: 0, notifications: 0 }),
  }
}
