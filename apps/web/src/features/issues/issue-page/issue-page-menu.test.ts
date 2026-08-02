/**
 * THE OVERFLOW MENU AS DATA, AND THE PROOF THAT ITS GATING IS SHARED (POD-646).
 *
 * The point of the config is not that it is tidy — it is that ONE predicate
 * decides what a menu and a palette offer, so the palette cannot become the
 * bypass (POD-331 contract §1). Two things therefore have to be true, and both
 * are asserted here rather than described:
 *
 *  1. PARITY WITH WHAT SHIPPED. The pre-config menu's nine inline conditions are
 *     reproduced entry by entry, so the port cannot have quietly added or
 *     dropped an action. This is the single-user regression guard.
 *  2. THE GATE IS THE SHARED PREDICATE. `issueMenuEligibility` is the module the
 *     board and sidebar context menus already evaluate, and the cases below are
 *     chosen so that a config which re-implemented the rules locally would
 *     disagree with it — a deleted issue, an archived one, and one with no
 *     targets.
 */
import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { issueMenuEligibility } from '../issue-context-menu'
import { ISSUE_PAGE_MENU, issuePageMenuEntries, startsGroup } from './issue-page-menu'

const ids = (over: Parameters<typeof makeIssue>[0] = {}, targetCount = 0): string[] =>
  issuePageMenuEntries({ issue: makeIssue(over), targetCount }).map((e) => e.id)

describe('the issue page menu config', () => {
  it('offers the live set for an ordinary issue with siblings', () => {
    expect(ids({ branch: 'issue/4-x', linearUrl: 'https://linear.app/x' }, 2)).toEqual([
      'copy-branch',
      'open-linear',
      'toggle-pin',
      'toggle-archive',
      'flag-human',
      'supersede',
      'duplicate',
      'delete',
    ])
  })

  it('drops the link entries when the data is not there', () => {
    // Data presence, not a right — an issue with no branch has no branch name.
    const shown = ids({ branch: null, linearUrl: undefined }, 0)
    expect(shown).not.toContain('copy-branch')
    expect(shown).not.toContain('open-linear')
  })

  it('hides the relation submenus when there is nowhere to point', () => {
    const shown = ids({}, 0)
    expect(shown).not.toContain('supersede')
    expect(shown).not.toContain('duplicate')
  })

  it('offers RESTORE and never DELETE on a deleted issue, and nothing else mutating', () => {
    const shown = ids({ deletedAt: '2026-01-01T00:00:00Z' }, 3)
    expect(shown).toContain('restore')
    expect(shown).not.toContain('delete')
    expect(shown).not.toContain('toggle-pin')
    expect(shown).not.toContain('toggle-archive')
    expect(shown).not.toContain('flag-human')
    expect(shown).not.toContain('supersede')
  })

  it('flips archive to unarchive on an archived issue — one entry, not two', () => {
    const archived = makeIssue({ archived: true })
    const entry = ISSUE_PAGE_MENU.find((e) => e.id === 'toggle-archive')
    expect(entry?.label(archived)).toBe('Unarchive issue')
    expect(ids({ archived: true })).toContain('toggle-archive')
    expect(ISSUE_PAGE_MENU.filter((e) => e.id === 'toggle-archive')).toHaveLength(1)
  })

  it('flips pin to unpin, and the pinned issue still offers the entry', () => {
    const pinned = makeIssue({ pinned: true })
    expect(ISSUE_PAGE_MENU.find((e) => e.id === 'toggle-pin')?.label(pinned)).toBe('Unpin')
    expect(ids({ pinned: true })).toContain('toggle-pin')
  })
})

describe('the gate is the SHARED eligibility predicate', () => {
  // If these ever disagree, the page has grown its own copy of the rules — which
  // is the exact drift the shared config exists to prevent. Stated as an
  // equivalence over the cases where the two could differ.
  const cases: Parameters<typeof makeIssue>[0][] = [
    {},
    { archived: true },
    { pinned: true },
    { deletedAt: '2026-01-01T00:00:00Z' },
    // ARCHIVED **AND** DELETED, and this row earns its place: it is the only
    // combination on which a locally re-implemented archive gate diverges from
    // the shared predicate. A mutant that replaced the delegation with
    // `!issue.deletedAt || issue.archived` was SILENT across the four cases
    // above — each of them happens to agree — so without this row the test
    // claimed to prove the gate is shared while proving only that it matches on
    // four points. The shared predicate refuses archive on a deleted row
    // whatever its archived flag; a local one has to remember to.
    { archived: true, deletedAt: '2026-01-01T00:00:00Z' },
  ]

  it.each(cases)('agrees with issueMenuEligibility for %j', (over) => {
    const issue = makeIssue(over)
    const rights = issueMenuEligibility([issue])
    const shown = new Set(issuePageMenuEntries({ issue, targetCount: 1 }).map((e) => e.id))
    expect(shown.has('toggle-pin')).toBe(rights.canPin)
    expect(shown.has('delete')).toBe(rights.canDelete)
    expect(shown.has('restore')).toBe(rights.canRestore)
    expect(shown.has('toggle-archive')).toBe(
      issue.archived ? rights.canUnarchive : rights.canArchive,
    )
  })
})

describe('grouping is data too', () => {
  it('marks a separator only where the group changes', () => {
    const visible = issuePageMenuEntries({
      issue: makeIssue({ branch: 'b', linearUrl: 'u' }),
      targetCount: 1,
    })
    expect(startsGroup(visible, 0)).toBe(false)
    const boundaries = visible.map((_, i) => startsGroup(visible, i))
    // links, links, state, state, state, relations, relations, lifecycle
    expect(boundaries).toEqual([false, false, true, false, false, true, false, true])
  })
})
