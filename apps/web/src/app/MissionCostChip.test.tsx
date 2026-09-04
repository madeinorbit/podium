// @vitest-environment happy-dom
/**
 * THE DECK'S ONE PRICE, AND THE FOUR SILENCES (POD-1862).
 *
 * The rule this file exists to pin is the negative one: three of the four cost
 * states, and the moment before the read answers, render NO CHIP AT ALL. A
 * regression there is invisible in the good case and produces a permanent empty
 * slot — or, far worse, a confident `$0` — on half the missions on this
 * machine, because half of all tasks are `pending` today.
 */
import type { TaskCostRowWire, TaskCostState, TaskCostWire } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetPolledQueryCache } from '@/lib/use-polled-query'
import { MissionCostChip } from './MissionCostChip'

/** $5 per million input tokens, the price table's own rate for this model. */
const tokens = (usd: number): number => (usd / 5) * 1_000_000

const total = (usd: number, messages: number) => ({
  model: 'claude-opus-5',
  inputTokens: tokens(usd),
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  messages,
})

const wire = (over: Partial<TaskCostWire> = {}): TaskCostWire =>
  ({
    issueId: 'iss_root',
    state: 'costed',
    own: { models: [total(150, 300)], messages: 300, sessionCount: 4 },
    rollup: { models: [total(225, 900)], messages: 900, sessionCount: 10 },
    descendantCount: 32,
    provisional: false,
    floor: 'none',
    harnesses: ['claude-code'],
    sessions: [],
    ...over,
  }) as TaskCostWire

/** One qualifying cohort row: $5 over 25 replies — a median of $0.20/reply. */
const cohortRows = [
  {
    issueId: 'iss_other',
    seq: 1,
    title: 'another',
    stage: 'closed',
    models: [total(5, 25)],
    messages: 25,
    windowModels: [],
    windowMessages: 0,
    sessionCount: 1,
    floor: 'none',
    harnesses: ['claude-code'],
  },
] as unknown as TaskCostRowWire[]

let answer: TaskCostWire = wire()

vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (state: unknown) => unknown) =>
    select({
      trpc: {
        cost: {
          task: { query: () => Promise.resolve(answer) },
          tasks: { query: () => Promise.resolve(cohortRows) },
        },
      },
    }),
}))

afterEach(() => {
  cleanup()
  resetPolledQueryCache()
  answer = wire()
})

/**
 * Mount, then flush until the cost read has landed AND been rendered.
 *
 * THE NEGATIVE TESTS BELOW ARE WORTHLESS WITHOUT THIS. Asserting "no chip"
 * straight after `render` passes for every state, including `costed`, because
 * at that instant the read is still in flight — and a `waitFor` wrapped around
 * an absence assertion returns on its first successful tick, which is that same
 * instant. The bug it is supposed to catch sails through.
 *
 * So absence is only ever asserted after this helper, and this helper's
 * sufficiency is pinned by the `the chip` block: those tests use it and then
 * look the chip up SYNCHRONOUSLY. If the flush were ever too short, they fail
 * first and loudly.
 */
const mountAndSettle = async (onOpen = vi.fn()): Promise<ReturnType<typeof vi.fn>> => {
  render(<MissionCostChip issueId="iss_root" onOpenInExplorer={onOpen} />)
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
  })
  return onOpen
}

const chip = (): HTMLElement => screen.getByTestId('mission-cost-chip')

describe('the chip', () => {
  it('reads COST and the ROLLED-UP figure, rounded and prefixed', async () => {
    await mountAndSettle()
    // The rollup ($225), never the task's own $150: "what did this cost" is
    // answered by the whole mission, and the split is the popover's job.
    expect(chip().textContent).toBe('COST≈$225')
  })

  it('marks a partly-attributed figure as a lower bound', async () => {
    answer = wire({ floor: 'partial', harnesses: ['codex'] })
    await mountAndSettle()
    expect(chip().textContent).toBe('COST≥$225')
  })

  it('carries the exact figure to assistive tech, not just the rounded one', async () => {
    await mountAndSettle()
    expect(chip().getAttribute('aria-label')).toContain('$225.00')
  })
})

describe('a mission with nothing to report', () => {
  it('renders no chip before the read has answered', () => {
    render(<MissionCostChip issueId="iss_root" onOpenInExplorer={vi.fn()} />)
    // Deliberately NOT settled: while the query is in flight nothing is known,
    // so nothing is drawn — not a slot, not a dash.
    expect(screen.queryByTestId('mission-cost-chip')).toBeNull()
  })

  for (const state of ['no-sessions', 'not-recorded', 'pending'] as TaskCostState[]) {
    it(`renders no chip at all for '${state}'`, async () => {
      answer = wire({ state })
      await mountAndSettle()
      // `pending` is HALF of all tasks today and can persist for the life of
      // this surface, so it is not a loading state and gets no motion — it
      // simply makes no claim about the money. The figures are on the wire and
      // deliberately ignored: only `costed` licenses a number.
      expect(screen.queryByTestId('mission-cost-chip')).toBeNull()
      expect(screen.queryByText('—')).toBeNull()
    })
  }
})

describe('the popover', () => {
  const open = async (): Promise<HTMLElement> => {
    fireEvent.click(chip())
    return await screen.findByTestId('mission-cost-breakdown')
  }

  it('answers in place: cents, the hedge verbatim, and the readings', async () => {
    await mountAndSettle()
    const panel = await open()
    expect(screen.getByTestId('mission-cost-total').textContent).toBe('$225.00')
    expect(
      screen.getByText('at list price for the same tokens — not what you were billed'),
    ).toBeTruthy()
    expect(panel.textContent).toContain('10 sessions · 900 replies')
    expect(panel.textContent).toContain('45.0M tok')
  })

  it('draws the rollup split with BOTH sides labelled by figure', async () => {
    await mountAndSettle()
    const panel = await open()
    expect(screen.getByTestId('mission-cost-split')).toBeTruthy()
    expect(screen.getByText('This task')).toBeTruthy()
    expect(screen.getByText('$150.00')).toBeTruthy()
    expect(screen.getByText('32 sub-tasks')).toBeTruthy()
    // The descendants' side is the rollup less its own — never sent, never
    // derivable the other way round.
    expect(screen.getByText('$75.00')).toBeTruthy()
    expect(panel.textContent).not.toContain('No sub-tasks')
  })

  it('draws NO bar for a task with no children', async () => {
    answer = wire({
      descendantCount: 0,
      own: { models: [total(225, 900)], messages: 900, sessionCount: 10 },
    } as Partial<TaskCostWire>)
    await mountAndSettle()
    await open()
    // A two-segment bar with one empty segment is a question the reader has to
    // answer before they can read the number.
    expect(screen.queryByTestId('mission-cost-split')).toBeNull()
    expect(screen.getByText('No sub-tasks')).toBeTruthy()
  })

  it('splits on the descendant COUNT, not on own != rollup', async () => {
    // POD-1402, POD-1403, POD-1484 and POD-1574 all read own == rollup today
    // while carrying descendants: their children's work is outside the
    // seven-day window. Keying the split on the figures would tell all four
    // they have no sub-tasks, and POD-1867's backfill would then grow a bar
    // onto a panel that had been denying one.
    answer = wire({
      descendantCount: 32,
      own: { models: [total(225, 900)], messages: 900, sessionCount: 10 },
      rollup: { models: [total(225, 900)], messages: 900, sessionCount: 10 },
    } as Partial<TaskCostWire>)
    await mountAndSettle()
    const panel = await open()
    expect(screen.getByText('32 sub-tasks')).toBeTruthy()
    expect(panel.textContent).not.toContain('No sub-tasks')
    // The bar is still drawn; the descendants' segment is simply zero-wide,
    // and their side reads $0 — the honest reading, not a broken one.
    expect(screen.getByTestId('mission-cost-split')).toBeTruthy()
    expect(screen.getByText('$0')).toBeTruthy()
  })

  it('never says "0 sessions" under a real figure', async () => {
    // POD-1839's shape: own 0, a real rollup, and the whole figure is its one
    // descendant's. `sessions[]` is OWN-only by contract, so an empty own side
    // is intended here and must not render as an empty state.
    answer = wire({
      descendantCount: 1,
      own: { models: [], messages: 0, sessionCount: 0 },
      rollup: { models: [total(225, 900)], messages: 900, sessionCount: 0 },
      sessions: [],
    } as Partial<TaskCostWire>)
    await mountAndSettle()
    const panel = await open()
    expect(chip().textContent).toBe('COST≈$225')
    expect(panel.textContent).not.toContain('0 sessions')
    expect(panel.textContent).toContain('900 replies')
  })

  it('still rates a rollup-only mission, which cost.tasks never emits', async () => {
    // POD-1869's finding: `tasks()` keys off transcript costs carrying an
    // issueId, so a parent with no cost rows OF ITS OWN is absent from the
    // cohort dataset entirely. That is not a gap in the rate — the two halves
    // come from different reads. The NUMERATOR is this mission's own wire
    // (rollup cost over rollup replies, from cost.task); only the DENOMINATOR
    // comes from cost.tasks, and a median over other tasks does not need this
    // one in it.
    //
    // Its absence is in fact required: the cohort is OWN cost per task, one row
    // per task, so an epic cannot count the same work once per ancestor. A
    // rollup-only parent has no own work, and admitting it would put its
    // children's money into the denominator a second time.
    answer = wire({
      descendantCount: 1,
      own: { models: [], messages: 0, sessionCount: 0 },
      rollup: { models: [total(225, 900)], messages: 900, sessionCount: 0 },
      sessions: [],
    } as Partial<TaskCostWire>)
    await mountAndSettle()
    const panel = await open()
    // $225 over 900 replies is $0.25/reply; the cohort's only row is $5 over
    // 25, i.e. $0.20. The multiple is real, and it is measured against a set
    // this mission is correctly not a member of.
    expect(panel.textContent).toContain('Rate')
    expect(panel.textContent).toContain('1.3x median')
  })

  it('labels the multiple, so a bare 1.3x never asks "x what?"', async () => {
    await mountAndSettle()
    const panel = await open()
    // $225 over 900 replies is $0.25; the cohort median is $0.20.
    expect(panel.textContent).toContain('Rate')
    expect(panel.textContent).toContain('1.3x median')
  })

  it('says what a lower-bound mark rests on, without inventing a harness', async () => {
    answer = wire({ floor: 'partial', harnesses: ['codex', 'grok'] })
    await mountAndSettle()
    const panel = await open()
    expect(panel.textContent).toContain('≥ floor · Codex + Grok')
  })

  it('states no attribution line when the figure is fully counted', async () => {
    await mountAndSettle()
    const panel = await open()
    expect(panel.textContent).not.toContain('Attribution')
  })

  it('offers the explorer as its LAST line, not as the chip itself', async () => {
    const onOpen = await mountAndSettle()
    await open()
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('mission-cost-open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
