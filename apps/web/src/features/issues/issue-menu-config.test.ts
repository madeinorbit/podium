import { asIssueId, ISSUE_COLOR_SLOTS } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { type IssueMenuSurface, issueMenuEligibility } from './issue-context-menu'
import {
  createIssueMenuData,
  ISSUE_MENU_COLOR_NONE,
  issueMenuCommandKeys,
  issueMenuEntries,
  issueMenuEntryLabel,
} from './issue-menu-config'
import { issueMenuPaletteCommands } from './issue-menu-palette-commands'

const deps = {
  trpc: {} as never,
  markIssueRead: vi.fn(async () => {}),
  markIssueUnread: vi.fn(async () => {}),
  updateIssue: vi.fn(async () => {}),
  deleteIssue: vi.fn(async () => {}),
  closeIssue: vi.fn(async () => {}),
  deferIssue: vi.fn(async () => {}),
  undeferIssue: vi.fn(async () => {}),
  setIssueLabels: vi.fn(async () => {}),
  restoreIssue: vi.fn(async () => {}),
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
      eligibility: issueMenuEligibility([issue], 'palette'),
      surface: 'palette',
      renameEnabled: false,
    })
    expect(data).not.toBeNull()
    if (!data) return

    const menuKeys = issueMenuCommandKeys(data).sort()
    const paletteKeys = issueMenuPaletteCommands(data, deps)
      .map((command) => command.id.replace(`issue-menu:${issue.id}:`, ''))
      .sort()

    expect(paletteKeys).toEqual(menuKeys)
    expect(issueMenuEntries(data).map((entry) => entry.id)).toContain('status')
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

  // POD-1470. The three removals and the one rename, projected through the tree
  // the way every host renders it.
  describe('the trimmed list menu (POD-1470)', () => {
    const LISTS = ['sidebar', 'dock', 'board', 'deck'] as const

    const menuData = (issue: ReturnType<typeof makeIssue>, surface: IssueMenuSurface) =>
      createIssueMenuData({
        issues: [issue],
        allIssues: [issue],
        eligibility: issueMenuEligibility([issue], surface),
        surface,
      })

    const entryIds = (issue: ReturnType<typeof makeIssue>, surface: IssueMenuSurface) => {
      const data = menuData(issue, surface)
      if (!data) throw new Error('no menu data')
      return issueMenuEntries(data).map((entry) => entry.id)
    }

    const labelOf = (
      issue: ReturnType<typeof makeIssue>,
      surface: IssueMenuSurface,
      id: string,
    ) => {
      const data = menuData(issue, surface)
      if (!data) throw new Error('no menu data')
      const entry = issueMenuEntries(data).find((candidate) => candidate.id === id)
      return entry ? issueMenuEntryLabel(entry, data) : null
    }

    it('drops priority and labels from every list, but keeps status and colour', () => {
      for (const surface of LISTS) {
        const ids = entryIds(makeIssue({ labels: ['bug'] }), surface)
        expect(ids).not.toContain('priority')
        expect(ids).not.toContain('labels')
        expect(ids).toContain('status')
        expect(ids).toContain('color')
      }
    })

    it('keeps priority, labels and the agent entry in the palette, which is not a list', () => {
      const ids = entryIds(makeIssue({ labels: ['bug'] }), 'palette')
      expect(ids).toContain('priority')
      expect(ids).toContain('labels')
      expect(ids).toContain('agent')
    })

    // Both faces of one entry, gone: "Run now" on an unstarted task and
    // "Assign agent" on a running one. A row names neither the harness it would
    // launch nor the agent already on the task.
    it('drops the agent entry from every list, started or not', () => {
      for (const surface of LISTS) {
        expect(entryIds(makeIssue(), surface)).not.toContain('agent')
        expect(entryIds(makeIssue({ worktreePath: null }), surface)).not.toContain('agent')
      }
      expect(labelOf(makeIssue({ worktreePath: null }), 'palette', 'agent')).toBe('Run now')
      expect(labelOf(makeIssue(), 'palette', 'agent')).toBe('Assign agent')
    })

    // NOT the same entry. A host opts into `start` explicitly — the deck, for a
    // proposal — and it says so in its own words, next to a placement fork that
    // shows where the work will land.
    it('leaves the host-opted "Start issue" action alone', () => {
      const proposal = makeIssue({ worktreePath: null })
      const data = createIssueMenuData({
        issues: [proposal],
        allIssues: [proposal],
        eligibility: issueMenuEligibility([proposal], 'deck'),
        surface: 'deck',
        primaryStart: true,
      })
      if (!data) throw new Error('no menu data')
      const entries = issueMenuEntries(data)
      expect(entries.map((entry) => entry.id)).toContain('start')
      expect(entries.map((entry) => entry.id)).not.toContain('agent')
    })

    it('names Open for where it lands, and only where it travels', () => {
      for (const surface of ['sidebar', 'palette'] as const) {
        expect(labelOf(makeIssue(), surface, 'open')).toBe('Open in tasks')
      }
      for (const surface of ['board', 'deck'] as const) {
        expect(labelOf(makeIssue(), surface, 'open')).toBe('Open')
      }
    })
  })

  // On the PALETTE, the only surface that still carries the agent entry after
  // POD-1470 took it off the lists.
  it('retains the single-machine default agent and every configured submenu value', () => {
    const issue = makeIssue({ worktreePath: null })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue],
      eligibility: issueMenuEligibility([issue], 'palette'),
      surface: 'palette',
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
