import { asIssueId, ISSUE_COLOR_SLOTS } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { issueMenuEligibility } from './issue-context-menu'
import {
  createIssueMenuData,
  ISSUE_MENU_COLOR_NONE,
  issueMenuCommandKeys,
  issueMenuEntries,
} from './issue-menu-config'
import { issueMenuPaletteCommands } from './issue-menu-palette-commands'

const deps = {
  trpc: {} as never,
  markIssueRead: vi.fn(async () => {}),
  markIssueUnread: vi.fn(async () => {}),
  setOpenIssueId: vi.fn(),
  setView: vi.fn(),
}

describe('declarative issue menu projections', () => {
  it('uses identical action and option keys for the menu and palette', () => {
    const issue = makeIssue({ labels: ['bug'] })
    const sibling = makeIssue({ id: asIssueId('sibling'), title: 'Sibling' })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue, sibling],
      eligibility: issueMenuEligibility([issue]),
      renameEnabled: false,
    })
    expect(data).not.toBeNull()
    if (!data) return

    const menuKeys = issueMenuCommandKeys(data).sort()
    const paletteKeys = issueMenuPaletteCommands(data, deps)
      .map((command) => command.id.replace(`issue-menu:${issue.id}:`, ''))
      .sort()

    expect(paletteKeys).toEqual(menuKeys)
    expect(issueMenuEntries(data).map((entry) => entry.id)).toContain('stage')
    expect(issueMenuEntries(data).map((entry) => entry.id)).toContain('duplicate')
  })

  it('keeps board-only duplicate options out of the sidebar projection', () => {
    const issue = makeIssue()
    const sibling = makeIssue({ id: asIssueId('sibling') })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue, sibling],
      eligibility: issueMenuEligibility([issue], 'sidebar'),
      surface: 'sidebar',
    })
    expect(data).not.toBeNull()
    if (!data) return
    expect(issueMenuEntries(data).some((entry) => entry.id === 'duplicate')).toBe(false)
  })

  it('retains the single-machine default agent and every configured submenu value', () => {
    const issue = makeIssue({ worktreePath: null })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue],
      eligibility: issueMenuEligibility([issue]),
    })
    expect(data).not.toBeNull()
    if (!data) return
    const agent = issueMenuEntries(data).find((entry) => entry.id === 'agent')
    const defer = issueMenuEntries(data).find((entry) => entry.id === 'defer')
    expect(agent && agent.kind === 'submenu' ? agent.options(data)[0] : null).toMatchObject({
      value: '',
      label: expect.stringContaining('(default)'),
    })
    expect(
      defer && defer.kind === 'submenu' ? defer.options(data).map((o) => o.value) : [],
    ).toEqual(['hour', 'tomorrow', 'week', 'next-message'])
  })

  // POD-380: colour was only reachable by clicking the IdSquare. The menu now
  // offers every slot plus the clear option, and marks the current one.
  it('offers every colour slot plus "no colour", checking the issue’s current one', () => {
    const issue = makeIssue({ color: 'violet' })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue],
      eligibility: issueMenuEligibility([issue], 'sidebar'),
      surface: 'sidebar',
    })
    expect(data).not.toBeNull()
    if (!data) return
    const color = issueMenuEntries(data).find((entry) => entry.id === 'color')
    expect(color?.kind).toBe('submenu')
    if (!color || color.kind !== 'submenu') return
    const options = color.options(data)
    expect(options.map((o) => o.value)).toEqual([...ISSUE_COLOR_SLOTS, ISSUE_MENU_COLOR_NONE])
    expect(options.filter((o) => o.checked).map((o) => o.value)).toEqual(['violet'])
    // The palette projects the same tree, so every slot is a command there too.
    expect(issueMenuCommandKeys(data)).toContain('color:violet')
    expect(issueMenuCommandKeys(data)).toContain(`color:${ISSUE_MENU_COLOR_NONE}`)
  })

  it('checks "no colour" for an uncoloured issue', () => {
    const issue = makeIssue()
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue],
      eligibility: issueMenuEligibility([issue]),
    })
    if (!data) return
    const color = issueMenuEntries(data).find((entry) => entry.id === 'color')
    if (!color || color.kind !== 'submenu') throw new Error('no colour entry')
    expect(
      color
        .options(data)
        .filter((o) => o.checked)
        .map((o) => o.value),
    ).toEqual([ISSUE_MENU_COLOR_NONE])
  })
})
