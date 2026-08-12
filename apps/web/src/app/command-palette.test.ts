import { describe, expect, it } from 'vitest'
import {
  defaultHighlight,
  filterCommands,
  flattenGroups,
  GROUP_CAP,
  isResting,
  moveHighlight,
  type PaletteCommand,
  type PaletteGroupId,
  scoreCommand,
} from './command-palette'

const noop = (): void => {}

function cmd(partial: Partial<PaletteCommand> & { id: string; label: string }): PaletteCommand {
  return { group: 'task', run: noop, ...partial }
}

function many(group: PaletteGroupId, count: number, prefix: string = group): PaletteCommand[] {
  return Array.from({ length: count }, (_, i) => cmd({ id: `${prefix}${i}`, group, label: `${prefix} ${i}` }))
}

describe('scoreCommand', () => {
  it('returns 0 when the query is not a subsequence', () => {
    expect(scoreCommand('xyz', cmd({ id: 'a', label: 'Open settings' }))).toBe(0)
    expect(scoreCommand('settingsz', cmd({ id: 'a', label: 'Open settings' }))).toBe(0)
  })

  it('matches everything with an empty/whitespace query', () => {
    expect(scoreCommand('', cmd({ id: 'a', label: 'anything' }))).toBeGreaterThan(0)
    expect(scoreCommand('   ', cmd({ id: 'a', label: 'anything' }))).toBeGreaterThan(0)
  })

  it('is case-insensitive', () => {
    expect(scoreCommand('NEW', cmd({ id: 'a', label: 'new issue' }))).toBeGreaterThan(0)
    expect(scoreCommand('new', cmd({ id: 'a', label: 'New Issue' }))).toBeGreaterThan(0)
  })

  it('prefers continuous runs over scattered subsequences', () => {
    const continuous = scoreCommand('issue', cmd({ id: 'a', label: 'New issue' }))
    const scattered = scoreCommand('issue', cmd({ id: 'b', label: 'inspect sun sundae' }))
    expect(continuous).toBeGreaterThan(scattered)
  })

  it('prefers word-boundary starts over mid-word hits', () => {
    const boundary = scoreCommand('set', cmd({ id: 'a', label: 'Open settings' }))
    const midWord = scoreCommand('set', cmd({ id: 'b', label: 'reset all' }))
    expect(boundary).toBeGreaterThan(midWord)
  })

  it('weights label matches over keyword matches', () => {
    const byLabel = scoreCommand('home', cmd({ id: 'a', label: 'home' }))
    const byKeyword = scoreCommand('home', cmd({ id: 'b', label: 'zzz', keywords: ['home'] }))
    expect(byLabel).toBeGreaterThan(byKeyword)
    expect(byKeyword).toBeGreaterThan(0)
  })

  it('takes the best keyword when several are given', () => {
    const c = cmd({ id: 'a', label: 'zzz', keywords: ['nope', 'issues board'] })
    expect(scoreCommand('board', c)).toBeGreaterThan(0)
  })
})

describe('isResting', () => {
  it('is true only with no meaningful query', () => {
    expect(isResting('')).toBe(true)
    expect(isResting('   ')).toBe(true)
    expect(isResting('a')).toBe(false)
  })
})

describe('filterCommands — the resting state', () => {
  const fixture: PaletteCommand[] = [
    ...many('recent', 3),
    ...many('task', 40),
    ...many('agent', 20),
    ...many('place', 12),
    ...many('on-task', 40),
    ...many('on-agent', 9),
    ...many('action', 30),
  ]

  it('offers only the curated groups — the raw indexes wait for a query', () => {
    const groups = filterCommands('', fixture).map((g) => g.group)
    expect(groups).toEqual(['recent', 'on-task', 'on-agent', 'action'])
    expect(groups).not.toContain('task')
    expect(groups).not.toContain('agent')
    expect(groups).not.toContain('place')
  })

  it('caps every resting group on its own budget', () => {
    const byGroup = new Map(filterCommands('', fixture).map((g) => [g.group, g]))
    expect(byGroup.get('recent')?.commands.length).toBe(3) // fewer than the cap
    expect(byGroup.get('on-task')?.commands.length).toBe(GROUP_CAP['on-task'].rest)
    expect(byGroup.get('on-agent')?.commands.length).toBe(GROUP_CAP['on-agent'].rest)
    expect(byGroup.get('action')?.commands.length).toBe(GROUP_CAP.action.rest)
  })

  it('reports the pre-cap total so a capped group can say so', () => {
    const onTask = filterCommands('', fixture).find((g) => g.group === 'on-task')
    expect(onTask?.total).toBe(40)
    expect(onTask?.commands.length).toBeLessThan(40)
  })

  it('never lets one group take the whole list — the old single-cap failure', () => {
    // 40 task-menu rows and 40 tasks used to share one cap of 8 in insertion
    // order, so whichever kind was pushed first took all eight rows.
    const rows = flattenGroups(filterCommands('', fixture))
    const groups = new Set(rows.map((r) => r.group))
    expect(groups.size).toBeGreaterThan(1)
  })

  it('keeps the declared group order at rest', () => {
    const order = filterCommands('', [
      ...many('action', 2),
      ...many('recent', 2),
      ...many('on-agent', 2),
    ]).map((g) => g.group)
    expect(order).toEqual(['recent', 'on-agent', 'action'])
  })
})

describe('filterCommands — under a query', () => {
  const fixture: PaletteCommand[] = [
    cmd({ id: 'r1', group: 'recent', label: 'fix login bug' }),
    cmd({ id: 't1', group: 'task', label: 'fix login bug' }),
    cmd({ id: 't2', group: 'task', label: 'login page polish' }),
    cmd({ id: 'a1', group: 'agent', label: 'claude on login' }),
    cmd({ id: 'g1', group: 'action', label: 'New task' }),
    cmd({ id: 's1', group: 'on-agent', label: 'Close session' }),
  ]

  it('drops the recent group — the real groups answer the query', () => {
    const groups = filterCommands('login', fixture).map((g) => g.group)
    expect(groups).not.toContain('recent')
    expect(flattenGroups(filterCommands('login', fixture)).map((c) => c.id)).not.toContain('r1')
  })

  it('drops non-matching commands entirely', () => {
    const ids = flattenGroups(filterCommands('login', fixture)).map((c) => c.id)
    // t2 leads: it STARTS with the query, which outranks t1's mid-label hit.
    expect(ids).toEqual(['t2', 't1', 'a1'])
  })

  it('returns no groups when nothing matches', () => {
    expect(filterCommands('zzzzzz', fixture)).toEqual([])
  })

  it('orders groups by their strongest match, not by declaration', () => {
    // "close" is only in the on-agent group, which is declared LAST. A query it
    // owns outright must not sit under four groups of weaker task matches.
    const groups = filterCommands('close', [
      cmd({ id: 't1', group: 'task', label: 'clone the seat' }),
      cmd({ id: 's1', group: 'on-agent', label: 'Close session' }),
    ]).map((g) => g.group)
    expect(groups[0]).toBe('on-agent')
  })

  it('breaks a group-order tie on the declared order', () => {
    const groups = filterCommands('same', [
      cmd({ id: 's1', group: 'on-agent', label: 'same' }),
      cmd({ id: 't1', group: 'task', label: 'same' }),
    ]).map((g) => g.group)
    expect(groups).toEqual(['task', 'on-agent'])
  })

  it('sorts within a group by score, input order breaking ties', () => {
    const ranked = filterCommands('login', fixture)
    expect(ranked.find((g) => g.group === 'task')?.commands.map((c) => c.id)).toEqual(['t2', 't1'])
    // Equal scores fall back to the caller's insertion order.
    const tie = filterCommands('same', [
      cmd({ id: 'x', group: 'task', label: 'same' }),
      cmd({ id: 'y', group: 'task', label: 'same' }),
    ])
    expect(tie[0]?.commands.map((c) => c.id)).toEqual(['x', 'y'])
  })

  it('ranks a literal run over a subsequence scattered across word starts', () => {
    const exact = scoreCommand('close', cmd({ id: 'a', label: 'Close session' }))
    const scattered = scoreCommand('close', cmd({ id: 'b', label: 'clone the seat' }))
    expect(exact).toBeGreaterThan(scattered)
  })

  it('applies the queried caps, which are wider than the resting ones', () => {
    const groups = filterCommands('row', [...many('task', 12, 'row'), ...many('action', 30, 'row')])
    expect(groups.find((g) => g.group === 'task')?.commands.length).toBe(GROUP_CAP.task.query)
    // Actions are uncapped under a query: the command list is what you searched.
    expect(groups.find((g) => g.group === 'action')?.commands.length).toBe(30)
  })
})

describe('highlight model (roving selection + fallback row)', () => {
  it('defaults to the top result when there are matches', () => {
    expect(defaultHighlight(3)).toBe(0)
  })

  it('defaults to the fallback row when nothing matches (it is row 0)', () => {
    // With zero matches the rendered rows are [fallback], so index 0 IS the
    // fallback — plain Enter creates the agent.
    expect(defaultHighlight(0)).toBe(0)
  })

  it('moves and wraps across both ends', () => {
    expect(moveHighlight(0, 1, 3)).toBe(1)
    expect(moveHighlight(2, 1, 3)).toBe(0)
    expect(moveHighlight(0, -1, 3)).toBe(2)
    expect(moveHighlight(0, -1, 1)).toBe(0)
  })

  it('stays at 0 when there is nothing to move through', () => {
    expect(moveHighlight(0, 1, 0)).toBe(0)
  })
})
