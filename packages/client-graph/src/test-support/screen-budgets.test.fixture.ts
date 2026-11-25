/**
 * POD-7602 — the fetches and wire instances a main screen opens with,
 * whatever its number of rows.
 *
 * A screen that reads one relation per row holds one narrow instance per row
 * (`session.ofIssue` for each issue of a deck). On dev.62 a deck of about 970
 * rows asked about 1,900 of them; the loader sent them 200 to a fetch and the
 * server answered each as its own statement, so one screen saturated the
 * server's sync worker. A keyed collection's instances now go on the wire as
 * one keyed instance (`packInstances`), answered by one statement per chunk
 * of keys. A budget case fails a screen whose opening grows with its rows:
 * each opening is counted in fetches and in wire instances (what the server
 * runs a statement for), with the narrow instances in the evidence.
 *
 * The full set runs in `screen-loads.test.ts` on a 1,000-issue workspace;
 * the lean gate runs the deck and the issue page on a small one
 * (`screen-budgets.lean.test.ts`): a per-row read costs a wire instance per
 * row at any size.
 */
import { expect } from 'vitest'
import type { CollectionServer } from '../../../sync/src/conformance/collection-server'
import { session } from '../../../sync/src/conformance/collection-server'
import type { RecordedLoad } from '../../../sync/src/conformance/load-recorder'
import { LOADING } from '../loading'
import { closedValue, type Device, ISSUE, issueValue } from './device.test.fixture'
import {
  boardReaders,
  deckReaders,
  issuePageReaders,
  openScreen,
  type ScreenReaders,
  sidebarReaders,
} from './screens.test.fixture'

/** A workspace's size: closed issues under the mission, open top-level ones beside it. */
export interface WorkspaceSize {
  readonly issues: number
  readonly open: number
}

const EPICS = 10

/**
 * A workspace: `issues` closed issues under one mission `R` (ten epics, the
 * rest under them), each with an ended session, every tenth depending on the
 * one before it, and every tenth (from the sixth) with a spin-off of its own
 * outside the mission, which has a spin-off of its own (POD-7580: the deck
 * walks them for its tips, asking nothing per spin-off); and `open` open
 * top-level issues for the sidebar. Returns the mission's issues.
 */
export function budgetWorkspace(server: CollectionServer, size: WorkspaceSize): readonly string[] {
  server.pageRows = 50
  server.put(ISSUE, 'R', issueValue('R', { stage: 'in_progress', title: 'Mission R' }))
  for (let n = 0; n < size.open; n += 1)
    server.put(ISSUE, `W${n}`, issueValue(`W${n}`, { stage: 'in_progress' }))
  const ids: string[] = []
  for (let n = 0; n < size.issues; n += 1) {
    const id = `T${n}`
    const parentId = n < EPICS ? 'R' : `T${n % EPICS}`
    const deps = n % 10 === 9 ? [{ id: `T${n - 1}`, type: 'blocked-by' }] : []
    server.put(ISSUE, id, closedValue(id, { parentId, deps }))
    if (deps.length > 0)
      server.put('issueDep', `${id}-blocked-by`, {
        id: `${id}-blocked-by`,
        fromId: id,
        toId: `T${n - 1}`,
        type: 'blocked-by',
      })
    server.put(
      'session',
      `S-${id}`,
      session(`S-${id}`, { issueId: id, status: 'ended', cwd: '/synthetic' }),
    )
    if (n % 10 === 5)
      for (const [spin, from] of [
        [`X${n}`, id],
        [`XX${n}`, `X${n}`],
      ] as const) {
        server.put(
          ISSUE,
          spin,
          closedValue(spin, { deps: [{ id: from, type: 'discovered-from' }] }),
        )
        server.put('issueDep', `${spin}-discovered-from`, {
          id: `${spin}-discovered-from`,
          fromId: spin,
          toId: from,
          type: 'discovered-from',
        })
      }
    ids.push(id)
  }
  return ids
}

/**
 * What a row of a list draws beside its own record: its sessions and the
 * issues that depend on it, each a holding relation of its own instance.
 */
function rowRelations(device: Device, ids: readonly string[]): boolean {
  let loading = false
  for (const id of ids) {
    const issue = device.pool.issueObject(id)
    if (issue.pageSessions.members === LOADING) loading = true
    if (issue.pageDependents.members === LOADING) loading = true
  }
  return loading
}

export interface BudgetCase {
  readonly name: 'deck' | 'board' | 'sidebar' | 'issuePage'
  readonly readers: (device: Device, ids: readonly string[]) => ScreenReaders
  /** At most this many fetches, and wire instances across them, at any size. */
  readonly fetches: number
  readonly wire: number
}

export const BUDGETS: readonly BudgetCase[] = [
  {
    // The flight deck of the mission, each row with its sessions and
    // dependents: the tree, then every row's instances as two keyed ones.
    name: 'deck',
    readers: (d, ids) => {
      const deck = deckReaders(d, 'R')
      return { loading: () => deck.loading() || rowRelations(d, ids), close: deck.close }
    },
    fetches: 2,
    wire: 5,
  },
  {
    // A board column's page, then each card's sessions and dependents as two keyed instances.
    name: 'board',
    readers: (d, ids) => {
      const board = boardReaders(d, 'done')
      return {
        loading: () => board.loading() || rowRelations(d, ids.slice(0, 50)),
        close: board.close,
      }
    },
    fetches: 2,
    wire: 3,
  },
  {
    // The policy's collections: on the device from the first download.
    name: 'sidebar',
    readers: (d) => sidebarReaders(d),
    fetches: 0,
    wire: 0,
  },
  {
    // A closed issue held as a stub: its record and bodies, then its tree and sessions.
    name: 'issuePage',
    readers: (d) => issuePageReaders(d, 'T15'),
    fetches: 2,
    wire: 5,
  },
]

const evidence = (name: string, loads: readonly RecordedLoad[]) =>
  `${name}: ${loads.length} fetches, ${loads.reduce((n, l) => n + l.wire, 0)} wire instances, ${loads.reduce((n, l) => n + l.instances.length, 0)} narrow instances\n${loads
    .map(
      (load) =>
        `  hop ${load.hop}: ${load.wire} wire / ${load.instances.length} narrow: ${[
          ...new Set(load.instances.map((i) => i.collection)),
        ].join(', ')}`,
    )
    .join('\n')}`

/** Open the case's screen on a device of `size` and check its fetches and wire instances. */
export async function expectWithinBudget(
  screen: BudgetCase,
  size: WorkspaceSize,
  open: (world: (server: CollectionServer) => void) => Promise<Device>,
): Promise<void> {
  let ids: readonly string[] = []
  const d = await open((server) => {
    ids = budgetWorkspace(server, size)
  })
  const from = d.recorder.loads.length
  const opened = await openScreen(d, screen.name, () => screen.readers(d, ids))
  try {
    const loads = d.recorder.loads
      .slice(from)
      .filter((load) => load.route === 'collections' && !load.offline)
    const shown = evidence(screen.name, loads)
    expect(opened.ready, shown).toBe(true)
    expect(loads.length, shown).toBeLessThanOrEqual(screen.fetches)
    expect(
      loads.reduce((n, load) => n + load.wire, 0),
      shown,
    ).toBeLessThanOrEqual(screen.wire)
  } finally {
    opened.close()
  }
}
