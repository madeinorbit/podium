/**
 * POD-7163 — THE MAIN SCREENS on the device fixture: the deck, the board, the
 * issue page, search, the sidebar and the phone mission, each opened through
 * the view models their screens read, with what "LOADING" means for each.
 *
 * `openScreen` opens one, runs the device until nothing is due, and answers
 * what the opening asked the server for (requests, hops) and how long its
 * readers showed LOADING, on the simulated clock (`load-recorder.ts`).
 * `close()` leaves it: its reads stop, so what it held is released.
 *
 * The declared maxima (design POD-7157, "Testing rules"): the deck 2 hops (its
 * tree, then what the tree comes with), the board 1, the issue page 2 (the
 * record, then what it comes with), search 1 (its hits' records).
 */
import { autorun } from 'mobx'
import type { InstanceSpec } from '../../../sync/src/replica/types'
import { createBoardLayout } from '../issue-board-layout'
import type { BoardColumnOptions } from '../issue-board-schema'
import { issuePages } from '../issue-page'
import { ISSUE_SEARCH_DEBOUNCE_MS, issueSearch } from '../issue-search'
import { LOADING } from '../loading'
import { MissionScreen, missionOpeningResolved, missionRootId } from '../mission-screen'
import { attachMissionTestPreferences } from '../mission-screen.test.fixture'
import { sidebarView } from '../worklist/sidebar'
import type { Device } from './device.test.fixture'

export const DECLARED_HOPS = {
  deck: 2,
  board: 1,
  issuePage: 2,
  search: 1,
  sidebar: 0,
  phoneMission: 2,
} as const

export type ScreenName = keyof typeof DECLARED_HOPS

/** The longest an opening runs, in simulated ms: about 35 hops. */
export const OPENING_LIMIT_MS = 5_000

/** A screen's readers: LOADING or not, read inside a reaction. */
export interface ScreenReaders {
  loading(): boolean
  close?(): void
  /**
   * Real time the screen waits before it asks the server (search's debounce,
   * a real timer): the opening waits it out, and it passes on the simulated
   * clock too, so it counts in the LOADING time.
   */
  readonly waitMs?: number
}

export interface OpenedScreen {
  readonly name: string
  /** The device went idle: no load still due. False for a chain that never ends. */
  readonly idle: boolean
  readonly requests: number
  readonly hops: number
  readonly loadingMs: number
  readonly relapses: number
  /** Instances the opening asked for more than once: data it had and lost. */
  readonly refetched: readonly string[]
  /** Whether the readers show an answer now. */
  readonly ready: boolean
  /** Leave the screen: its reads stop. */
  close(): void
}

/** Open a screen on the device and run it until nothing is due. */
export async function openScreen(
  device: Device,
  name: string,
  make: () => ScreenReaders,
): Promise<OpenedScreen> {
  const { recorder } = device
  const window = recorder.open(name)
  const screen = make()
  let loading = true
  const stop = autorun(() => {
    loading = screen.loading()
    recorder.loading(name, loading)
  })
  if (screen.waitMs !== undefined) {
    await device.settle()
    device.clock.spend(screen.waitMs)
    await new Promise((resolve) => setTimeout(resolve, screen.waitMs! + 25))
  }
  // An opening that never goes idle (a chain of loads) stops here, and its hops tell.
  const idle = await device.settle(200, recorder.clock.now() + OPENING_LIMIT_MS)
  let closed = false
  return {
    name,
    idle,
    requests: recorder.requestsSince(window),
    hops: recorder.hopsSince(window),
    loadingMs: recorder.loadingMs(name),
    relapses: recorder.relapses(name),
    refetched: recorder.refetchesSince(window),
    ready: !loading,
    close() {
      if (closed) return
      closed = true
      stop()
      screen.close?.()
    },
  }
}

const sessionName = (session: { name?: string | null }) => session.name ?? ''

/** The flight deck of a mission: its rows and each task's word, as the Full view draws them. */
export function deckReaders(device: Device, rootId: string): ScreenReaders {
  attachMissionTestPreferences(device.pool)
  const screen = new MissionScreen(device.pool, rootId, { sessionName })
  return {
    loading() {
      if (!screen.ready || !screen.full.ready) return true
      for (const id of screen.full.rowIds) void screen.full.task(id).word
      return false
    },
    close: () => screen.close(),
  }
}

/** The phone's mission: its opening (useMissionOpening) and its deck. */
export function phoneMissionReaders(device: Device, selectedId: string): ScreenReaders {
  attachMissionTestPreferences(device.pool)
  let screen: MissionScreen | null = null
  return {
    loading() {
      const rootId = missionRootId(device.pool, selectedId, true)
      if (rootId === LOADING || rootId === undefined) return true
      if (screen === null) screen = new MissionScreen(device.pool, rootId, { sessionName })
      if (!missionOpeningResolved(screen, rootId, false)) return true
      return screen.reader.issue(rootId) === LOADING
    },
    close: () => screen?.close(),
  }
}

/** The page of a stage column. */
export const stagePage = (stage: string): InstanceSpec => ({
  collection: 'issueProjection.byStage',
  args: { stage },
  part: 'main',
})

/** One board column: its ids and its count. */
export function boardReaders(
  device: Device,
  stage: BoardColumnOptions['stage'] = 'done',
): ScreenReaders {
  const board = createBoardLayout(device.pool)
  const column: BoardColumnOptions = {
    filter: {},
    ordering: 'priority',
    showAgentTasks: false,
    stage,
  }
  return {
    loading() {
      void board.columnHeld(column)
      const ids = board.columnIds(column)
      return ids === LOADING || device.pool.collections.pageTotal(stagePage(stage)) === LOADING
    },
    close: () => board.dispose(),
  }
}

/** The issue page of one issue: the record, its children and its sessions. */
export function issuePageReaders(device: Device, id: string): ScreenReaders {
  const views = issuePages(device.pool)
  return {
    loading() {
      const issue = views.issue(id)
      if (issue === LOADING) return true
      if (issue === undefined) return false
      const row = views.row(id)
      return (row.children as unknown) === LOADING || (row.memberSessions as unknown) === LOADING
    },
    close: () => views.dispose(),
  }
}

/**
 * Search: the server's hits for `text` and their records, as the result list
 * and its rows read them. `hits` answers the server query; it goes through the
 * recorder, so it counts as a request (and is refused offline).
 */
export function searchReaders(
  device: Device,
  text: string,
  hits: readonly string[],
): ScreenReaders {
  const search = issueSearch(device.pool)
  search.bind(device.recorder.query(async () => ({ hits: hits.map((id) => ({ id })), next: null })))
  return {
    waitMs: ISSUE_SEARCH_DEBOUNCE_MS,
    loading() {
      const result = search.read(text, [])
      if (result.pending || !result.complete) return true
      return result.serverIds.some((id) => device.pool.row('issue', id) === LOADING)
    },
  }
}

/** The sidebar: its sections and every row in them. */
export function sidebarReaders(device: Device): ScreenReaders {
  const sidebar = sidebarView(device.pool)
  return {
    loading() {
      if (sidebar.loading) return true
      const sections = sidebar.sections()
      const ids = [...sections.pinnedIds, ...sections.bands.flatMap((band) => band.rowIds)]
      return ids.some((id) => sidebar.row(id) === LOADING)
    },
  }
}
