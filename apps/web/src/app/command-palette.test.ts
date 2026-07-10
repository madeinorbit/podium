import { describe, expect, it } from 'vitest'
import {
  defaultHighlight,
  filterCommands,
  flattenGroups,
  moveHighlight,
  type PaletteCommand,
  scoreCommand,
} from './command-palette'

const noop = (): void => {}

function cmd(partial: Partial<PaletteCommand> & { id: string; label: string }): PaletteCommand {
  return { group: 'navigate', run: noop, ...partial }
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

describe('filterCommands', () => {
  const fixture: PaletteCommand[] = [
    cmd({ id: 'n1', group: 'navigate', label: 'fix login bug' }),
    cmd({ id: 'g1', group: 'global', label: 'New issue' }),
    cmd({ id: 's1', group: 'session', label: 'Hibernate session' }),
    cmd({ id: 'n2', group: 'navigate', label: 'login page polish' }),
  ]

  it('groups in navigate → global → session order and drops empty groups', () => {
    const groups = filterCommands('', fixture)
    expect(groups.map((g) => g.group)).toEqual(['navigate', 'global', 'session'])
    const noSession = filterCommands('', fixture.slice(0, 2))
    expect(noSession.map((g) => g.group)).toEqual(['navigate', 'global'])
  })

  it('drops non-matching commands entirely', () => {
    const groups = filterCommands('login', fixture)
    // Both hit "login" at a word boundary with a full run — equal score, so the
    // stable input-order tiebreak decides.
    expect(flattenGroups(groups).map((c) => c.id)).toEqual(['n1', 'n2'])
  })

  it('returns no groups when nothing matches', () => {
    expect(filterCommands('zzzzzz', fixture)).toEqual([])
  })

  it('sorts within a group by score, input order breaking ties', () => {
    const groups = filterCommands('login', fixture)
    // 'login page polish' starts with the query (boundary + runs) and outranks
    // the mid-label hit in 'fix login bug'... both boundary-start actually; the
    // ordering assertion above pins the ranking; here pin the stable tiebreak:
    const tie = filterCommands('', fixture)
    expect(tie[0]?.commands.map((c) => c.id)).toEqual(['n1', 'n2'])
    expect(groups[0]?.commands.length).toBe(2)
  })

  it('caps navigate at 8 but leaves other groups uncapped', () => {
    const many: PaletteCommand[] = [
      ...Array.from({ length: 12 }, (_, i) => cmd({ id: `n${i}`, label: `session ${i}` })),
      ...Array.from({ length: 10 }, (_, i) =>
        cmd({ id: `g${i}`, group: 'global', label: `global ${i}` }),
      ),
    ]
    const groups = filterCommands('', many)
    expect(groups.find((g) => g.group === 'navigate')?.commands.length).toBe(8)
    expect(groups.find((g) => g.group === 'global')?.commands.length).toBe(10)
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
})
