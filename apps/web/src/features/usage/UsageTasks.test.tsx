import { taskCostRows } from '@podium/client-core/viewmodels'
import type { CostModelTotalWire, TaskCostRowWire } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { taskCostStats, UsageTasks } from './UsageTasks'
import type { TaskCostsFeed } from './useTaskCosts'

/**
 * What the by-task section PROMISES, as distinct from what it draws: the sheet's
 * one right edge and its divided-cell grammar are CSS, but the claims a figure
 * makes are here. A cold section holds its shape, a task with nothing counted is
 * never a confident zero, a lower bound says so, and the rate the sheet prints
 * is the rate every other cost surface prints.
 */

const model = (over: Partial<CostModelTotalWire> = {}): CostModelTotalWire => ({
  model: 'claude-opus-5',
  inputTokens: 1_000_000,
  outputTokens: 200_000,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  messages: 100,
  ...over,
})

const row = (over: Partial<TaskCostRowWire> = {}): TaskCostRowWire => {
  const models = over.models ?? [model()]
  const messages = over.messages ?? 100
  return {
    // The one cast, and only over the brand: a whole-object `as` here let this
    // fixture go on compiling while the wire grew `rollupModels`, and the tests
    // only found out at runtime.
    issueId: `iss_${over.seq ?? 1}` as TaskCostRowWire['issueId'],
    seq: 1,
    title: 'A task',
    stage: 'in_progress',
    models,
    messages,
    windowModels: [model()],
    windowMessages: 100,
    // Every fixture here is a LEAF unless it says otherwise, so its rollup is
    // its own. The sheet ranks on own cost and reads the rollup only for the
    // Rate column, which is exactly the pairing that has to stay honest.
    rollupModels: models,
    rollupMessages: messages,
    sessionCount: 2,
    floor: 'none',
    harnesses: ['claude-code'],
    ...over,
  }
}

const feedOf = (wire: TaskCostRowWire[]): TaskCostsFeed => {
  const priced = taskCostRows(wire)
  return {
    rows: priced.rows,
    cohort: priced.cohort,
    waiting: false,
    failed: false,
    retry: () => {},
  }
}

const COLD: TaskCostsFeed = {
  rows: null,
  cohort: null,
  waiting: false,
  failed: false,
  retry: () => {},
}

const section = (): HTMLElement => document.querySelector('.usage-tasks') as HTMLElement

afterEach(cleanup)

describe('UsageTasks', () => {
  it('draws its readings and its ranking as unfilled slots while cold', () => {
    render(<UsageTasks feed={COLD} cold />)

    // The region is the height it will land at: five readings and three rows,
    // all of them drawn and none of them claiming a number.
    expect(
      section().querySelectorAll('.usage-task-readings .usage-reading-value .usage-unfilled'),
    ).toHaveLength(5)
    expect(section().querySelectorAll('tbody tr')).toHaveLength(3)
    // A `0` or an `—` here would be a claim about a figure nobody has read.
    expect(section().textContent).not.toMatch(/\$0/)
  })

  it('leads with the window share and sizes it with four all-time readings', () => {
    render(
      <UsageTasks
        feed={feedOf([
          row({ seq: 1, title: 'Dear task', models: [model({ inputTokens: 10_000_000 })] }),
          row({ seq: 2, title: 'Cheap task' }),
        ])}
        cold={false}
      />,
    )

    expect(screen.getByText('Attributed to a task')).toBeTruthy()
    expect(screen.getByText('Tasks that cost').nextSibling?.textContent).toBe('2')
    // Two tasks is the whole corpus, so the top ten hold all of it.
    expect(screen.getByText('Top 10 tasks').nextSibling?.textContent).toBe('100.0%')
    // The dearest reading is stated to the cent so it matches the row it names.
    const dearest = screen.getByText('Dearest').nextSibling?.textContent ?? ''
    expect(dearest).toMatch(/^\$[\d,]+\.\d\d$/)
    expect(section().querySelector('tbody tr')?.textContent).toContain(dearest)
  })

  it('ranks by cost, then re-ranks by cost per reply on the toggle', () => {
    // The dear task is dearer in total and cheaper per reply — the exact case
    // the toggle exists for, and the reading no total can give.
    const feed = feedOf([
      row({
        seq: 1,
        title: 'Dear task',
        models: [model({ inputTokens: 10_000_000, messages: 4_000 })],
        messages: 4_000,
      }),
      row({
        seq: 2,
        title: 'Costly per reply',
        models: [model({ inputTokens: 2_000_000, messages: 50 })],
        messages: 50,
      }),
    ])
    render(<UsageTasks feed={feed} cold={false} />)

    const first = (): string => section().querySelector('tbody tr')?.textContent ?? ''
    expect(first()).toContain('Dear task')
    expect(screen.getByText('by task · ranked by cost')).toBeTruthy()

    const dearestBefore = screen.getByText('Dearest').nextSibling?.textContent
    const shareBefore = screen.getByText('Top 10 tasks').nextSibling?.textContent

    fireEvent.click(screen.getByRole('button', { name: 'Rate' }))
    expect(screen.getByRole('button', { name: 'Rate' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('by task · ranked by rate')).toBeTruthy()
    expect(first()).toContain('Costly per reply')

    // The readings describe the CORPUS, not the current sort. "Dearest" must not
    // quietly become "the dearest of the fastest-burning" when the toggle moves.
    expect(screen.getByText('Dearest').nextSibling?.textContent).toBe(dearestBefore)
    expect(screen.getByText('Top 10 tasks').nextSibling?.textContent).toBe(shareBefore)
  })

  it('marks a lower bound and names the harnesses behind it', () => {
    render(
      <UsageTasks
        feed={feedOf([row({ seq: 1, floor: 'partial', harnesses: ['codex', 'grok'] })])}
        cold={false}
      />,
    )

    const cost = section().querySelector('.usage-td-cost span') as HTMLElement
    expect(cost.textContent).toContain('≥')
    // Both harnesses, never "all Codex" over a task that also ran Grok.
    expect(cost.getAttribute('title')).toContain('Codex and Grok')
    expect(screen.getByText(/marks a lower bound/)).toBeTruthy()
  })

  it('never ranks a task with nothing counted, rather than printing it as zero', () => {
    render(
      <UsageTasks
        feed={feedOf([
          row({ seq: 1 }),
          row({
            seq: 2,
            title: 'Nothing counted',
            models: [model({ inputTokens: 0, outputTokens: 0, messages: 3 })],
            messages: 3,
            windowModels: [],
            windowMessages: 0,
          }),
        ])}
        cold={false}
      />,
    )

    expect(screen.queryByText(/Nothing counted/)).toBeNull()
    expect(section().querySelectorAll('tbody tr')).toHaveLength(1)
    expect(section().textContent).not.toContain('$0.00')
  })

  it('withholds a rate from a task too small to have a meaningful one', () => {
    render(
      <UsageTasks
        feed={feedOf([row({ seq: 1, models: [model({ messages: 4 })], messages: 4 })])}
        cold={false}
      />,
    )

    // Four replies is noise, not a rate: one expensive turn would move it by a
    // factor a reader would take for a finding.
    expect(section().querySelector('.usage-td-rate')?.textContent).toBe('—')
  })

  it('says so plainly when no task has a figure yet', () => {
    render(<UsageTasks feed={feedOf([])} cold={false} />)
    expect(screen.getByText(/No task has a cost on record yet/)).toBeTruthy()
  })
})

describe('taskCostStats', () => {
  it('reads the concentration and the worst case off the ranking itself', () => {
    const { rows } = taskCostRows([
      row({ seq: 1, models: [model({ inputTokens: 30_000_000 })] }),
      row({ seq: 2, models: [model({ inputTokens: 10_000_000 })] }),
      row({ seq: 3, models: [model({ inputTokens: 1_000_000 })] }),
    ])
    const stats = taskCostStats(rows)

    expect(stats.taskCount).toBe(3)
    expect(stats.dearestUsd).toBeCloseTo(rows[0]?.estCostUsd ?? 0, 6)
    // Three tasks all fit inside the top ten, so the share is the whole of it.
    expect(stats.topTenShare).toBeCloseTo(1, 6)
    expect(stats.medianUsd).toBeCloseTo(rows[1]?.estCostUsd ?? 0, 6)
  })

  it('holds no figure at all over an empty corpus, rather than a zero', () => {
    const stats = taskCostStats([])
    expect(stats.medianUsd).toBeNull()
    expect(stats.dearestUsd).toBeNull()
    expect(stats.topTenShare).toBeNull()
  })
})
