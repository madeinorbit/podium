/**
 * POD-7608 — THE DECK'S WORK GROWS WITH ITS ROWS, NOT WITH THEIR SQUARE.
 *
 * The empty-device flight deck of one mission (`deckReaders`: its rows and
 * each task's word) opens in one fetch at any size, so what grows is client
 * work after the answer. At 1,000 and 2,000 issues the opening is counted:
 * the computed values MobX derived (`spy` reports each that changed or was
 * first computed) and the nodes the development diagnostics walked above a
 * read (`observerWalkVisits`). Each may at most double, with slack, when the
 * deck does. The reactions it ran are shown, not bounded: the warm-up slices
 * its rows by a real-time budget (`SlicedWarmup`), so their number follows
 * the machine's speed.
 *
 * The diagnostics were the square: for every raw relation read, a walk over
 * the whole observer graph above the reader (every row's place in the tree
 * hangs off the deck's topology). 1.2 s of a 4.3 s opening at 1,000 issues,
 * 4.9 s of 10.4 s at 2,000.
 */
import { observerWalkVisits } from '@podium/mobx-helpers'
import { spy } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import type { CollectionServer } from '../../sync/src/conformance/collection-server'
import { session } from '../../sync/src/conformance/collection-server'
import { closedValue, ISSUE, issueValue, openDevice } from './test-support/device.test.fixture'
import { deckReaders, openScreen } from './test-support/screens.test.fixture'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})

/** A mission `R` over `issues` closed issues: ten epics, the rest under them, each with an ended session. */
function mission(server: CollectionServer, issues: number): void {
  server.put(ISSUE, 'R', issueValue('R', { stage: 'in_progress', title: 'Mission R' }))
  for (let n = 0; n < issues; n += 1) {
    const id = `T${n}`
    server.put(ISSUE, id, closedValue(id, { parentId: n < 10 ? 'R' : `T${n % 10}` }))
    server.put(
      'session',
      `S-${id}`,
      session(`S-${id}`, { issueId: id, status: 'ended', cwd: '/synthetic' }),
    )
  }
}

interface DeckWork {
  readonly derived: number
  readonly reactions: number
  readonly walked: number
}

async function openDeck(issues: number): Promise<DeckWork> {
  const device = await openDevice({ world: (server) => mission(server, issues) })
  disposers.push(() => device.dispose())
  let derived = 0
  let reactions = 0
  const stop = spy((event) => {
    if (event.type === 'reaction') reactions += 1
    else if (
      event.type === 'update' &&
      'observableKind' in event &&
      event.observableKind === 'computed'
    )
      derived += 1
  })
  const walkedBefore = observerWalkVisits()
  try {
    const opened = await openScreen(device, 'deck', () => deckReaders(device, 'R'))
    expect(opened.ready).toBe(true)
    expect(opened.requests).toBe(1)
    opened.close()
  } finally {
    stop()
  }
  return { derived, reactions, walked: observerWalkVisits() - walkedBefore }
}

/** Twice the rows may cost at most this much more of each kind of work. */
const DOUBLING = 2.25

describe('the flight deck of a large mission (POD-7608)', () => {
  it('derives and walks linearly from 1,000 to 2,000 issues', async () => {
    const small = await openDeck(1_000)
    const large = await openDeck(2_000)
    const shown = `1,000 issues: ${JSON.stringify(small)}; 2,000 issues: ${JSON.stringify(large)}`
    // About 87 derivations a row.
    expect(small.derived, shown).toBeLessThan(1_000 * 120)
    expect(large.derived, shown).toBeLessThanOrEqual(small.derived * DOUBLING)
    // The deck's raw readers are known ones: no diagnostic walks the graph
    // above them (a walk per read visited the whole deck: millions of nodes).
    expect(small.walked, shown).toBeLessThan(1_000)
    expect(large.walked, shown).toBeLessThan(1_000)
  }, 180_000)
})
