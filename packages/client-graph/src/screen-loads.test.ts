/**
 * POD-7163 — every main screen, opened on the real device stack with tiny
 * budgets, against the design's testing rules (POD-7157):
 *
 * 1. Chains of loads (Solid's ASYNC_WATERFALL): opening a screen takes no more
 *    load hops than declared (deck 2, board 1, issue page 2, search 1). The
 *    deck bug (POD-7155) was an unbounded chain: the trim took the tree back
 *    while the deck read it, and the deck asked for it again.
 * 2. LOADING shown too long (Solid's LONG_HOLD): each screen's readers answer
 *    within its budget of simulated time: per hop, the loader's window, the
 *    fake fetch time and one frame (`serverLoadingBudget`). An answer
 *    installed in many bursts (POD-7165) costs a frame each, and fails.
 * 3. Open, leave, reopen offline: once its data is on the device, a screen
 *    reopens complete with zero server requests, also after memory let it go
 *    (POD-7159's unload) and after the warm set's budget made it go
 *    (POD-7161, an idle tick over budget).
 * 4. Back and forth (POD-7161): a screen left less than the warm set's grace
 *    ago comes back from memory: no disk load, no server request.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { CollectionServer } from '../../sync/src/conformance/collection-server'
import { session } from '../../sync/src/conformance/collection-server'
import {
  DISK_LOADING_BUDGET_MS,
  FETCH_MS,
  serverLoadingBudget,
} from '../../sync/src/conformance/load-recorder'
import { ISSUE_SEARCH_DEBOUNCE_MS } from './issue-search'
import {
  closedValue,
  type Device,
  type DeviceOptions,
  ISSUE,
  issueValue,
  openDevice,
} from './test-support/device.test.fixture'
import {
  boardReaders,
  DECLARED_HOPS,
  deckReaders,
  issuePageReaders,
  type OpenedScreen,
  openScreen,
  phoneMissionReaders,
  type ScreenName,
  type ScreenReaders,
  searchReaders,
  sidebarReaders,
} from './test-support/screens.test.fixture'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})

async function device(options: DeviceOptions): Promise<Device> {
  const opened = await openDevice(options)
  disposers.push(() => opened.dispose())
  return opened
}

/**
 * A mission: an open root `R` (on the sidebar) over `members` closed tasks
 * three levels deep (10 under the root, 10 under each of those, the rest
 * below), each with `sessions` ended sessions. More records than the budget:
 * as cache it never fits.
 */
function mission(server: CollectionServer, members = 40, sessions = 1): void {
  server.put(ISSUE, 'R', issueValue('R', { stage: 'in_progress', title: 'Mission R' }))
  const ids: string[] = []
  for (let n = 0; n < members; n += 1) {
    const id = `M${n + 1}`
    const parentId = n < 10 ? 'R' : n < 110 ? ids[(n - 10) % 10]! : ids[10 + ((n - 110) % 100)]!
    ids.push(id)
    server.put(ISSUE, id, closedValue(id, { parentId }))
    for (let s = 0; s < sessions; s += 1)
      server.put(
        'session',
        `S-${id}-${s}`,
        session(`S-${id}-${s}`, { issueId: id, status: 'ended', cwd: '/synthetic' }),
      )
  }
}

/** Lookups nobody keeps reading: more than the budget, so memory has to choose. */
const crowded = (server: CollectionServer) => {
  for (let i = 1; i <= 30; i += 1) server.put(ISSUE, `C${i}`, closedValue(`C${i}`))
}

interface ScreenCase {
  readonly name: ScreenName
  readonly options: DeviceOptions
  readonly readers: (device: Device) => ScreenReaders
  /** The longest LOADING its opening from the server may show, in simulated ms. */
  readonly budgetMs: number
  /** Reads only the policy's collections: always resident, memory never lets it go. */
  readonly alwaysResident?: true
}

const SEARCH_HITS = Array.from({ length: 12 }, (_, i) => `H${i + 1}`)

const SCREENS: readonly ScreenCase[] = [
  {
    // Its tree, with what the tree comes with in the same answer, as the real route does.
    name: 'deck',
    options: {
      world: (server) => {
        mission(server)
        crowded(server)
      },
    },
    readers: (device) => deckReaders(device, 'R'),
    budgetMs: serverLoadingBudget(DECLARED_HOPS.deck),
  },
  {
    name: 'board',
    options: {
      world: (server) => {
        // The column's page, as the route pages it.
        server.pageRows = 10
        for (let i = 1; i <= 30; i += 1) server.put(ISSUE, `D${i}`, closedValue(`D${i}`))
        crowded(server)
      },
    },
    readers: (device) => boardReaders(device, 'done'),
    budgetMs: serverLoadingBudget(DECLARED_HOPS.board),
  },
  {
    // A closed issue the device holds as a stub only: its record, then its sessions.
    name: 'issuePage',
    options: {
      world: (server) => {
        server.put(ISSUE, 'OLD', closedValue('OLD', { title: 'An old issue' }))
        for (let s = 1; s <= 3; s += 1)
          server.put(
            'session',
            `S-OLD-${s}`,
            session(`S-OLD-${s}`, { issueId: 'OLD', status: 'ended', cwd: '/synthetic' }),
          )
        crowded(server)
      },
    },
    readers: (device) => issuePageReaders(device, 'OLD'),
    budgetMs: serverLoadingBudget(DECLARED_HOPS.issuePage),
  },
  {
    // The query (after its debounce), then its hits' records: one hop.
    name: 'search',
    options: {
      world: (server) => {
        for (const id of SEARCH_HITS) server.put(ISSUE, id, closedValue(id))
        crowded(server)
      },
    },
    readers: (device) => searchReaders(device, 'needle', SEARCH_HITS),
    budgetMs: ISSUE_SEARCH_DEBOUNCE_MS + FETCH_MS + serverLoadingBudget(DECLARED_HOPS.search),
  },
  {
    // A policy collection: always resident, nothing to load.
    name: 'sidebar',
    options: {
      world: (server) => {
        for (let i = 1; i <= 12; i += 1)
          server.put(ISSUE, `W${i}`, issueValue(`W${i}`, { stage: 'in_progress' }))
        crowded(server)
      },
    },
    readers: (device) => sidebarReaders(device),
    budgetMs: serverLoadingBudget(DECLARED_HOPS.sidebar),
    alwaysResident: true,
  },
  {
    // The phone opens a task of the mission: its root by the stubs, then the deck.
    name: 'phoneMission',
    options: {
      world: (server) => {
        mission(server)
        crowded(server)
      },
    },
    readers: (device) => phoneMissionReaders(device, 'M5'),
    budgetMs: serverLoadingBudget(DECLARED_HOPS.phoneMission),
  },
]

const evidence = (opened: OpenedScreen, device: Device) =>
  `${opened.name}: idle=${opened.idle} ready=${opened.ready} hops=${opened.hops} requests=${opened.requests} loading=${opened.loadingMs} ms\n${device.recorder.describe({ id: 0, from: 0, at: 0 })}`

/**
 * Chains the product still takes, reported to the POD-5910 coordinator
 * (POD-7163, 2026-11-19). `it.fails` keeps the check running: once the chain
 * is gone the test fails here, and the entry is removed.
 * - board: gone with POD-7174. The column read as each record of its page
 *   entered the table and looked the later ones up one by one; since POD-7159
 *   the device answers those lookups itself, so only the loader's requests
 *   still show them (the case after this block).
 */
const KNOWN_CHAINS: ReadonlySet<ScreenName> = new Set<ScreenName>()

describe('opening a main screen chains no more loads than declared (ASYNC_WATERFALL)', () => {
  for (const screen of SCREENS) {
    const check = KNOWN_CHAINS.has(screen.name) ? it.fails : it
    check(`${screen.name}: at most ${DECLARED_HOPS[screen.name]} load hops`, async () => {
      const d = await device(screen.options)
      const opened = await d.recorder.expectHops(
        () => openScreen(d, screen.name, () => screen.readers(d)),
        DECLARED_HOPS[screen.name],
        `opening the ${screen.name}`,
      )
      try {
        expect(opened.idle, evidence(opened, d)).toBe(true)
        expect(opened.ready, evidence(opened, d)).toBe(true)
        // Nothing it had was lost and asked for again.
        expect(opened.refetched, evidence(opened, d)).toEqual([])
      } finally {
        opened.close()
      }
    })
  }
})

/**
 * POD-7174: the board's page brings its records. A pool publication puts its
 * records in the tables one by one while the device index already lists all
 * of them; the column read as each entered and found the next ones absent,
 * a lookup (`issueProjection.one`) per record of the page. The device answers
 * those from the record it holds (POD-7159), so the hop count above no longer
 * sees them: the loader's requests do.
 */
it('board: the page brings its records, the column looks none of them up one by one', async () => {
  const board = SCREENS.find((screen) => screen.name === 'board')
  if (board === undefined) throw new Error('no board case')
  const d = await device(board.options)
  const lookups: string[] = []
  const request = d.loader.request.bind(d.loader)
  d.loader.request = (specs, priority) => {
    for (const spec of specs)
      if (spec.collection === 'issueProjection.one') lookups.push(JSON.stringify(spec.args))
    request(specs, priority)
  }
  const opened = await openScreen(d, 'board', () => board.readers(d))
  try {
    expect(opened.ready, evidence(opened, d)).toBe(true)
    expect(lookups).toEqual([])
  } finally {
    opened.close()
  }
})

describe('a main screen shows LOADING no longer than its budget (LONG_HOLD)', () => {
  for (const screen of SCREENS) {
    it(`${screen.name}: LOADING within ${screen.budgetMs} ms of simulated time`, async () => {
      const d = await device(screen.options)
      const opened = await openScreen(d, screen.name, () => screen.readers(d))
      try {
        expect(opened.ready, evidence(opened, d)).toBe(true)
        d.recorder.expectLoadingWithin(screen.name, screen.budgetMs)
        expect(opened.relapses, evidence(opened, d)).toBe(0)
      } finally {
        opened.close()
      }
    })
  }

  /**
   * POD-7165: a large answer arrives in many chunks. Installed one chunk at a
   * time, each a burst of its own, the deck stays LOADING a frame per chunk
   * (on the operator's deck, a two-minute freeze). The chunks that have
   * arrived install together: a burst per answer.
   */
  it('a deck whose answers come in many chunks installs each in one burst, within budget', async () => {
    const d = await device({
      // 81 tree rows in 4-row chunks: 21 bursts, one each, are 21 frames.
      world: (server) => mission(server, 80, 2),
      chunkRows: 4,
      serverComesWith: false,
    })
    const opened = await openScreen(d, 'deck', () => deckReaders(d, 'R'))
    try {
      expect(opened.ready, evidence(opened, d)).toBe(true)
      d.recorder.expectLoadingWithin('deck', serverLoadingBudget(DECLARED_HOPS.deck))
    } finally {
      opened.close()
    }
  })
})

/**
 * Search is the one main screen that is not a reopen of instances on disk:
 * its hit list is a server query's answer, and offline it says so
 * (`IssueSearchResult.complete` is false: "offline results cover this device
 * only", issue-search.ts). So it is not complete offline by design.
 */
const NOT_ON_DISK: ReadonlySet<ScreenName> = new Set(['search'])

describe('open, leave, unload and reopen offline: complete with zero server requests', () => {
  for (const screen of SCREENS.filter((entry) => !NOT_ON_DISK.has(entry.name))) {
    it(`${screen.name}: reopened offline from the device, no request, LOADING under ${DISK_LOADING_BUDGET_MS} ms`, async () => {
      const d = await device(screen.options)
      const first = await openScreen(d, screen.name, () => screen.readers(d))
      expect(first.ready, evidence(first, d)).toBe(true)
      first.close()
      // Other reads crowd memory; then memory lets go of what no view reads.
      for (let i = 1; i <= 30; i += 1) d.pool.row('issue', `C${i}`)
      await d.settle()
      await d.unload()
      d.offline()
      const again = await openScreen(d, `${screen.name} (offline)`, () => screen.readers(d))
      try {
        expect(again.ready, evidence(again, d)).toBe(true)
        expect(again.requests, evidence(again, d)).toBe(0)
        d.recorder.expectLoadingWithin(`${screen.name} (offline)`, DISK_LOADING_BUDGET_MS)
      } finally {
        again.close()
      }
    })
  }
})

describe('open, leave, the warm budget unloads it, reopen offline: complete with zero server requests (POD-7161)', () => {
  for (const screen of SCREENS.filter((entry) => !NOT_ON_DISK.has(entry.name))) {
    it(`${screen.name}: an idle tick over budget unloads what it left; it reopens offline from the device`, async () => {
      const d = await device(screen.options)
      const before = d.memoryInstances()
      const first = await openScreen(d, screen.name, () => screen.readers(d))
      expect(first.ready, evidence(first, d)).toBe(true)
      first.close()
      // What the screen brought into memory, now warm.
      const left = [...d.memoryInstances()].filter((key) => !before.has(key))
      if (screen.alwaysResident) expect(left, 'it reads only the policy').toEqual([])
      else expect(left.length, 'it brought instances into memory').toBeGreaterThan(0)
      // Other reads crowd memory: more warm instances than the budget (2).
      for (let i = 1; i <= 30; i += 1) d.pool.row('issue', `C${i}`)
      await d.settle()
      // Without an idle tick, nothing has left memory, over budget as it is.
      expect(d.replica.stats().shrinks).toBe(0)
      d.passGrace()
      await d.idle()
      // The budget made memory let go, and what the screen left went first
      // (released longest ago); the policy's collections stay.
      expect(d.replica.stats().shrinks).toBeGreaterThan(0)
      const inMemory = d.memoryInstances()
      expect(
        left.filter((key) => inMemory.has(key)),
        `the screen left memory (held now: ${JSON.stringify(d.replica.heldForTest())}; ${JSON.stringify(d.replica.stats())})`,
      ).toEqual([])
      expect(
        [...before].filter((key) => !inMemory.has(key)),
        'always resident',
      ).toEqual([])
      d.offline()
      const again = await openScreen(d, `${screen.name} (offline)`, () => screen.readers(d))
      try {
        expect(again.ready, evidence(again, d)).toBe(true)
        expect(again.requests, evidence(again, d)).toBe(0)
        d.recorder.expectLoadingWithin(`${screen.name} (offline)`, DISK_LOADING_BUDGET_MS)
      } finally {
        again.close()
      }
    })
  }
})

describe('back and forth within the grace (POD-7161)', () => {
  it('deck A, deck B, back to A within 60 s: A comes from memory, no disk load, no server request', async () => {
    const tree = (root: string) => ({
      collection: 'issueProjection.tree',
      args: { root },
      part: 'main' as const,
    })
    const d = await device({
      world: (server) => {
        for (const root of ['A', 'B']) {
          server.put(
            ISSUE,
            root,
            issueValue(root, { stage: 'in_progress', title: `Mission ${root}` }),
          )
          for (let n = 1; n <= 8; n += 1)
            server.put(ISSUE, `${root}${n}`, closedValue(`${root}${n}`, { parentId: root }))
        }
        crowded(server)
      },
    })
    const a = await openScreen(d, 'deck A', () => deckReaders(d, 'A'))
    expect(a.ready, evidence(a, d)).toBe(true)
    a.close()
    const b = await openScreen(d, 'deck B', () => deckReaders(d, 'B'))
    expect(b.ready, evidence(b, d)).toBe(true)
    b.close()
    // An idle tick while both are warm and over budget: the grace keeps them.
    await d.idle()
    // Still in memory, so its reopening needs no disk load.
    expect(d.replica.isComplete(tree('A')), 'deck A is still in memory').toBeDefined()
    const leftMemory = Array.from({ length: 8 }, (_, n) => `A${n + 1}`).filter((id) =>
      d.replica.isUnloaded(ISSUE, id),
    )
    expect(leftMemory, 'no row of deck A left memory').toEqual([])
    const back = await openScreen(d, 'deck A again', () => deckReaders(d, 'A'))
    try {
      expect(back.ready, evidence(back, d)).toBe(true)
      expect(back.requests, evidence(back, d)).toBe(0)
      expect(back.loadingMs, evidence(back, d)).toBe(0)
    } finally {
      back.close()
    }
  })
})
