/**
 * POD-7602 — the lean gate's screen budget: the flight deck and the issue
 * page of a small workspace open with a fixed number of fetches and wire
 * instances. A screen that reads a relation per row costs a wire instance
 * per row at any size, so a small workspace catches it; the full set, on a
 * 1,000-issue workspace, is in `screen-loads.test.ts`.
 */
import { afterEach, describe, it } from 'vitest'
import { type Device, openDevice } from './test-support/device.test.fixture'
import { BUDGETS, expectWithinBudget } from './test-support/screen-budgets.test.fixture'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})

/** Thirty rows, each reading two relations: far more than any budget below, so a per-row read fails. */
const WORKSPACE = { issues: 30, open: 4 } as const

describe('the deck and the issue page open with a fixed number of fetches (POD-7602)', () => {
  for (const screen of BUDGETS.filter(
    (entry) => entry.name === 'deck' || entry.name === 'issuePage',
  ))
    it(`${screen.name}: at most ${screen.fetches} fetches and ${screen.wire} wire instances`, async () => {
      await expectWithinBudget(screen, WORKSPACE, async (world) => {
        const opened: Device = await openDevice({ world })
        disposers.push(() => opened.dispose())
        return opened
      })
    })
})
