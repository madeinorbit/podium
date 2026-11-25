/**
 * POD-7580 — THE FLIGHT DECK READS EVERY RELATION THROUGH ITS TREE OR A
 * HOLDING READ, ON AN EMPTY DEVICE.
 *
 * The deck holds its root's tree (`MissionDeckModel.treeHeld`), which brings
 * every issue under the root and the sessions a roster draws. Before this
 * change its readers read relation ids raw (`pool.graph`): a closed sub-issue
 * long out of every policy collection was missing until something else loaded
 * it, an absent spin-off origin read as "no origin", and the task menu
 * counted only the sessions that happened to be in memory. Each case opens
 * the reader on a device that holds only the real start's policy collections.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { type CollectionServer, session } from '../../sync/src/conformance/collection-server'
import { LOADING } from './loading'
import { MissionScreen } from './mission-screen'
import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import { MissionViewReader, settled } from './mission-view'
import { closedValue, ISSUE, issueValue } from './test-support/device.test.fixture'
import {
  type EmptyDevice,
  openEmptyDevice,
  refuseCollections,
  requestKey,
} from './test-support/empty-device.test.fixture'

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
})

const RECENT = '2026-11-17T12:00:00.000Z'
const OLD = '2020-01-01T00:00:00.000Z'
const TREE = { collection: 'issueProjection.tree', args: { root: 'top' }, part: 'main' } as const

type Server = CollectionServer

/** An open issue the first download holds (the sidebar). */
const openIssue = (server: Server, id: string, fields: Record<string, unknown> = {}) =>
  server.put(ISSUE, id, issueValue(id, { updatedAt: RECENT, deps: [], ...fields }))
/** A closed issue changed long ago: no policy collection holds it. */
const oldIssue = (server: Server, id: string, seq: number, fields: Record<string, unknown> = {}) =>
  server.put(ISSUE, id, closedValue(id, { seq, updatedAt: OLD, deps: [], ...fields }))
/** A dependency edge, its own record (`deps` is composed from it). */
const putDep = (server: Server, fromId: string, toId: string, type: string) =>
  server.put('issueDep', `${fromId}-${type}-${toId}`, {
    id: `${fromId}-${type}-${toId}`,
    fromId,
    toId,
    type,
  })

/** An open epic `top` with an open sub-issue `mid`, under which a closed old one sits. */
function epic(server: Server): void {
  openIssue(server, 'top')
  openIssue(server, 'mid', { parentId: 'top' })
  oldIssue(server, 'old', 90, { parentId: 'mid' })
}

async function open(world: (server: Server) => void) {
  const device = await openEmptyDevice({ world })
  devices.push(device)
  attachMissionTestPreferences(device.pool)
  return device
}

/** Open the deck of `rootId` as the flight deck does and read `read` on each run. */
function openDeck(
  device: EmptyDevice,
  rootId: string,
  read: (screen: MissionScreen) => unknown,
): { answers: unknown[]; screen: MissionScreen; close(): void } {
  const answers: unknown[] = []
  const opened = device.observe(
    () => new MissionScreen(device.pool, rootId, { sessionName: (s) => s.name ?? '' }),
    (screen) => {
      // As the deck draws: nothing below the screen is read before it is
      // ready, which it is once it holds its root's tree.
      const answer = settled(() => (screen.ready ? read(screen) : LOADING))
      answers.push(answer === LOADING ? 'LOADING' : answer)
    },
  )
  return { answers, screen: opened.model, close: opened.close }
}

/**
 * Pins, not regressions: the deck holds its root's tree, which brings every
 * sub-issue, so the old raw child read saw them too (these pass without the
 * change). They hold the getter to the same answer, and to one tree for every
 * row: no sub-issue asks for a subtree of its own.
 */
describe('the deck reads the children of its rows from its tree', () => {
  it('draws a closed sub-issue the policy never brought, from the root tree alone', async () => {
    const device = await open(epic)
    expect(device.pool.tables.issue.has('old'), 'the old sub-issue is not on the device').toBe(
      false,
    )
    const deck = openDeck(device, 'top', (screen) =>
      screen.ready ? screen.rows.map((row) => row.id) : LOADING,
    )
    await device.untilIdle()
    expect(deck.answers[0]).toBe('LOADING')
    expect(deck.answers.at(-1)).toEqual(['top', 'mid', 'old'])
    // One tree for every row: no sub-issue asks for a subtree of its own.
    expect(device.requestedKeys().filter((key) => key.startsWith('issueProjection.tree'))).toEqual([
      'issueProjection.tree{"root":"top"}',
    ])
    deck.close()
    await device.untilIdle()
    expect(device.liveHolds(TREE)).toBe(0)
  })

  it('counts the closed sub-issue in its progress', async () => {
    const device = await open(epic)
    const deck = openDeck(device, 'top', (screen) => screen.deck.progress)
    await device.untilIdle()
    expect(deck.answers[0]).toBe('LOADING')
    expect(deck.answers.at(-1)).toMatchObject({ total: 1, done: 1 })
    deck.close()
  })

  it('orders a row by its earliest child from the tree, the old one included', async () => {
    const device = await open(epic)
    const deck = openDeck(device, 'top', (screen) =>
      screen.ready ? screen.reader.node('mid').earliestChild : LOADING,
    )
    await device.untilIdle()
    expect(deck.answers.at(-1)).toBe('old')
    deck.close()
  })

  it("names every sub-issue in a row's issue, the old one included", async () => {
    const device = await open(epic)
    const deck = openDeck(device, 'top', (screen) => {
      const issue = screen.reader.issue('mid')
      return issue === LOADING || !issue ? LOADING : issue.childIds
    })
    await device.untilIdle()
    expect(deck.answers[0]).toBe('LOADING')
    expect(deck.answers.at(-1)).toEqual(['old'])
    deck.close()
  })

  it("counts a hidden root's accepted children from its tree on the phone", async () => {
    // An archived root is hidden; the phone opens it by id and counts its children.
    const device = await open((server) => {
      openIssue(server, 'top', { archived: true })
      oldIssue(server, 'old', 90, { parentId: 'top', stage: 'backlog', closedReason: null })
    })
    const deck = openDeck(device, 'top', (screen) => (screen.ready ? screen.progress : LOADING))
    await device.untilIdle()
    expect(deck.answers.at(-1)).not.toBe('LOADING')
    expect(device.requestedKeys()).toContain('issueProjection.tree{"root":"top"}')
    deck.close()
  })
})

describe("the deck reads a spin-off's origin through its lookup", () => {
  it('answers LOADING while an absent origin loads, then its id', async () => {
    const device = await open((server) => {
      oldIssue(server, 'origin', 91)
      openIssue(server, 'spin')
      putDep(server, 'spin', 'origin', 'discovered-from')
    })
    expect(device.pool.tables.issue.has('origin')).toBe(false)
    const reader = new MissionViewReader(device.pool)
    const answers: unknown[] = []
    device.observe(
      () => reader,
      (view) => answers.push(view.originOf('spin')),
    )
    await device.untilIdle()
    expect(answers[0]).toBe(LOADING)
    expect(answers.at(-1)).toBe('origin')
  })

  it("lists the root's spin-off proposals from the edges into it", async () => {
    const device = await open((server) => {
      openIssue(server, 'top')
      // A proposal filed long ago: proposed issues are in no policy collection.
      oldIssue(server, 'prop', 92, { stage: 'proposed', closedReason: null })
      putDep(server, 'prop', 'top', 'discovered-from')
    })
    expect(device.pool.tables.issue.has('prop')).toBe(false)
    const deck = openDeck(device, 'top', (screen) => screen.spinOffProposalIds)
    await device.untilIdle()
    expect(deck.answers[0]).toBe('LOADING')
    expect(deck.answers.at(-1)).toEqual(['prop'])
    // The tree brings the edges into the root and the issues they come from.
    expect(device.requestedKeys()).toContain('issueProjection.tree{"root":"top"}')
    expect(device.requestedKeys()).not.toContain('issueDep.toIssue{"issueId":"top"}')
    deck.close()
  })
})

describe('the deck reads the issues that depend on a row from its tree', () => {
  /**
   * An open root with a finished spin-off and an issue blocked by it, both
   * changed long ago. The spin-off has a spin-off of its own, outside the
   * tree too.
   */
  const world = (server: Server) => {
    openIssue(server, 'top')
    oldIssue(server, 'spin', 92)
    putDep(server, 'spin', 'top', 'discovered-from')
    oldIssue(server, 'blocked', 93)
    putDep(server, 'blocked', 'top', 'blocked-by')
    oldIssue(server, 'spin2', 94)
    putDep(server, 'spin2', 'spin', 'discovered-from')
  }
  const EDGES = 'issueDep.toIssue{"issueId":"top"}'

  it('outside a tree, the reader holds nothing; the issue its screen shows holds its edges', async () => {
    const device = await open(world)
    const reader = new MissionViewReader(device.pool)
    const answers: unknown[] = []
    const opened = device.observe(
      () => reader,
      (view) => answers.push(view.incoming('top', 'pageDependents')),
    )
    await device.untilIdle()
    // What the device holds: nothing asked, nothing per issue.
    expect(answers.at(-1)).toEqual([])
    expect(device.requestedKeys()).toEqual([])
    // The screen that shows the issue holds them (IssuePageRow.spinOffsHeld).
    const page = device.observe(
      () => device.pool.issueObject('top'),
      (issue) => void issue.pageDependents.members,
    )
    await device.untilIdle()
    expect(device.requestedKeys()).toEqual([EDGES])
    expect(answers.at(-1)).toEqual(['blocked', 'spin'])
    page.close()
    opened.close()
  })

  async function read(answer: (screen: MissionScreen) => unknown) {
    const device = await open(world)
    expect(device.pool.tables.issue.has('spin')).toBe(false)
    expect(device.pool.tables.issue.has('blocked')).toBe(false)
    const deck = openDeck(device, 'top', answer)
    await device.untilIdle()
    // The root's tree brings the edges into its issues and their sources:
    // no row holds an instance of its own, and no spin-off outside the tree
    // asks for its edges or its subtree (POD-7580, review B1).
    expect(device.requestedKeys().filter((key) => !key.includes('"top"'))).toEqual([])
    expect(device.requestedKeys()).toContain('issueProjection.tree{"root":"top"}')
    expect(device.requestedKeys()).not.toContain(EDGES)
    deck.close()
    return deck.answers
  }

  it('lists the spin-off among its departures', async () => {
    const answers = await read((screen) =>
      screen.deck.departures.map((departure) => departure.issue.id),
    )
    expect(answers[0]).toBe('LOADING')
    expect(answers.at(-1)).toEqual(['spin'])
  })

  it("names every dependent in the row's issue", async () => {
    const answers = await read((screen) => {
      const issue = screen.reader.issue('top')
      return issue === LOADING || !issue ? LOADING : issue.dependents
    })
    expect(answers[0]).toBe('LOADING')
    expect(answers.at(-1)).toEqual([
      { id: 'blocked', type: 'blocked-by' },
      { id: 'spin', type: 'discovered-from' },
    ])
  })

  it("names every dependent in the row's rules", async () => {
    const answers = await read((screen) => screen.reader.rulesIssue('top')?.dependents)
    expect(answers[0]).toBe('LOADING')
    expect(answers.at(-1)).toEqual([
      { id: 'blocked', type: 'blocked-by' },
      { id: 'spin', type: 'discovered-from' },
    ])
  })

  it('sees that a spin-off waits on the row', async () => {
    const answers = await read((screen) => screen.reader.hasSpinOffDependent('top'))
    expect(answers[0]).toBe('LOADING')
    expect(answers.at(-1)).toBe(true)
  })

  it("finds the row's spin-off tip", async () => {
    const answers = await read((screen) => screen.reader.tipIds('top', true))
    expect(answers[0]).toBe('LOADING')
    expect(answers.at(-1)).toEqual(['spin'])
  })
})

describe("an open task menu reads the issue's sessions through their holding read", () => {
  /** A closed issue with an archived handoff-capable agent and a live one that is not. */
  const world = (server: Server) => {
    oldIssue(server, 'old', 90)
    server.put(
      'session',
      'past',
      session('past', {
        issueId: 'old',
        status: 'exited',
        archived: true,
        harnessHandoff: true,
        lastActiveAt: OLD,
      }) as Record<string, unknown>,
    )
    server.put(
      'session',
      'now',
      session('now', { issueId: 'old', status: 'live', lastActiveAt: RECENT }) as Record<
        string,
        unknown
      >,
    )
  }
  const SESSIONS = 'session.ofIssue{"issueId":"old"}'

  it('finds the sole handoff subject, an archived session the device did not hold', async () => {
    const device = await open(world)
    expect(device.pool.tables.session.has('past')).toBe(false)
    const reader = new MissionViewReader(device.pool)
    const answers: unknown[] = []
    device.observe(
      () => reader,
      (view) => {
        const handoff = view.menuHandoff('old')
        answers.push(
          handoff === LOADING
            ? 'LOADING'
            : 'session' in handoff
              ? handoff.session.sessionId
              : handoff.blocker,
        )
      },
    )
    await device.untilIdle()
    expect(answers[0]).toBe('LOADING')
    expect(answers.at(-1)).toBe('past')
    expect(device.requestedKeys()).toContain(SESSIONS)
  })

  it("counts every session of the issue in the menu's summary", async () => {
    const device = await open(world)
    const reader = new MissionViewReader(device.pool)
    const answers: unknown[] = []
    device.observe(
      () => reader,
      (view) => {
        const issue = view.menuIssue('old')
        answers.push(issue === LOADING || !issue ? 'LOADING' : issue.sessionSummary?.total)
      },
    )
    await device.untilIdle()
    expect(answers[0]).toBe('LOADING')
    expect(answers.at(-1)).toBe(2)
    expect(device.requestedKeys()).toContain(SESSIONS)
  })
})

describe('the archive holds the history of its tree, one instance, only while it is open', () => {
  /** An open root with a closed old sub-issue; each has an archived agent the policy never brought. */
  const world = (server: Server) => {
    openIssue(server, 'top')
    oldIssue(server, 'old', 90, { parentId: 'top' })
    for (const [id, issueId] of [
      ['past-top', 'top'],
      ['past-old', 'old'],
    ] as const)
      server.put(
        'session',
        id,
        session(id, {
          issueId,
          status: 'exited',
          archived: true,
          lastActiveAt: OLD,
        }) as Record<string, unknown>,
      )
  }
  const ARCHIVE = {
    collection: 'issueProjection.treeArchive',
    args: { root: 'top' },
    part: 'main',
  } as const
  const histories = (device: EmptyDevice) =>
    device.requestedKeys().filter((key) => key.startsWith('session.ofIssue'))

  it('a closed deck is ready without asking for any history, and shows no count', async () => {
    const device = await open(world)
    const deck = openDeck(device, 'top', (screen) => [
      screen.rows.map((row) => row.id),
      screen.archivedCount ?? null,
    ])
    await device.untilIdle()
    expect(deck.answers.at(-1)).toEqual([['top', 'old'], null])
    expect(histories(device)).toEqual([])
    expect(device.requestedKeys()).not.toContain('issueProjection.treeArchive{"root":"top"}')
    deck.close()
  })

  it('opened, it asks for one instance for the whole tree, counts and lists it; closed, it lets go', async () => {
    const device = await open(world)
    const deck = openDeck(device, 'top', (screen) => {
      // The list is drawn only while the archive is open, as the deck draws it.
      if (!screen.archivedOpen) return 'closed'
      const archive = screen.reader.archive(screen.rootId, screen.mode)
      return [
        screen.archivedCount ?? null,
        archive === LOADING ? 'LOADING' : archive.map((each) => each.sessionId).sort(),
      ]
    })
    await device.untilIdle()
    const before = device.requestedKeys().length
    deck.screen.setArchivedOpen(true)
    await device.untilIdle()
    expect(deck.answers.at(-1)).toEqual([2, ['past-old', 'past-top']])
    // One instance, whatever the number of rows: no row asks for its own history.
    expect(device.requestedKeys().slice(before)).toEqual([
      'issueProjection.treeArchive{"root":"top"}',
    ])
    expect(histories(device)).toEqual([])
    expect(device.liveHolds(ARCHIVE)).toBe(1)
    deck.screen.setArchivedOpen(false)
    await device.untilIdle()
    expect(device.liveHolds(ARCHIVE)).toBe(0)
    deck.close()
  })
})

describe('a hold the server refuses reads as not available on the deck (POD-7595)', () => {
  const ARCHIVE = {
    collection: 'issueProjection.treeArchive',
    args: { root: 'top' },
    part: 'main',
  } as const
  const asked = (device: EmptyDevice, instance: typeof TREE | typeof ARCHIVE) =>
    device.requestedKeys().filter((key) => key === requestKey(instance)).length

  it('a refused tree says the deck is not available, asks once, and loads on retry', async () => {
    let refusal = { on: true }
    const device = await open((server) => {
      epic(server)
      refusal = refuseCollections(server, (each) => each.collection === 'issueProjection.tree')
    })
    const deck = openDeck(device, 'top', (screen) => screen.rows.map((row) => row.id))
    await device.untilIdle()
    expect(deck.screen.ready).toBe(false)
    expect(deck.screen.unavailable).toBe(true)
    expect(asked(device, TREE)).toBe(1)
    refusal.on = false
    deck.screen.retry()
    await device.untilIdle()
    expect(deck.screen.unavailable).toBe(false)
    expect(deck.answers.at(-1)).toEqual(['top', 'mid', 'old'])
    deck.close()
  })

  it('a refused description lets the deck draw and says the description is not available', async () => {
    const device = await open((server) => {
      epic(server)
      refuseCollections(
        server,
        (each) =>
          each.collection === 'issueDescription.ofIssue' && each.args?.['issueId'] === 'top',
      )
    })
    const deck = openDeck(device, 'top', (screen) => [
      screen.root.description === LOADING ? 'LOADING' : screen.root.description,
      screen.root.descriptionUnavailable,
    ])
    await device.untilIdle()
    expect(deck.screen.unavailable).toBe(false)
    expect(deck.answers.at(-1)).toEqual(['LOADING', true])
    deck.close()
  })

  it('a refused archive says it is not available while open, with no list, asked once', async () => {
    const device = await open((server) => {
      epic(server)
      refuseCollections(server, (each) => each.collection === 'issueProjection.treeArchive')
    })
    const deck = openDeck(device, 'top', (screen) => {
      if (!screen.archivedOpen) return 'closed'
      const archive = screen.reader.archive(screen.rootId, screen.mode)
      return [screen.archiveUnavailable, archive === LOADING ? 'LOADING' : archive.length]
    })
    await device.untilIdle()
    expect(deck.screen.archiveUnavailable).toBe(false)
    deck.screen.setArchivedOpen(true)
    await device.untilIdle()
    expect(deck.answers.at(-1)).toEqual([true, 'LOADING'])
    expect(asked(device, ARCHIVE)).toBe(1)
    deck.close()
  })
})
