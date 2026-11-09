import '@/test-support/mock-pool-fixture'
import '@/test-support/mock-core-store-handle'
// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

const stylesPath = ['src/styles.css', 'apps/web/src/styles.css']
  .map((path) => resolve(process.cwd(), path))
  .find(existsSync)
const styles = readFileSync(stylesPath ?? 'src/styles.css', 'utf8')

function cssBlock(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start, `${selector} not found in styles.css`).toBeGreaterThan(-1)
  const end = styles.indexOf('\n}', start)
  return styles.slice(start, end)
}

// A single idle session so its issue renders as a plain WORK row (not lifted to
// WORKING, whose suppress-unread logic would muddy the weight assertions).
function idleSess(id: string, issueId: string) {
  return {
    sessionId: id,
    agentKind: 'claude-code',
    cwd: '/repo',
    title: id,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-06T12:00:00.000Z',
    lastActiveAt: '2026-07-06T12:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    issueId,
    busy: false,
    readAt: '2026-07-06T12:00:00.000Z',
    unread: false,
    agentState: { phase: 'idle', idle: { kind: 'done' } },
  }
}

function issue(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    repoPath: '/repo',
    seq: 1,
    title,
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedByNotes: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    needsHuman: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    priority: 2,
    type: 'task',
    pinned: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    readAt: '2026-07-06T12:00:00.000Z',
    unread: false,
    ...over,
  }
}

// Issue 'a' is SELECTED (active) + read; issue 'b' is unread + unselected.
vi.mock('@/app/store', () => {
  const useStore = () => ({
    repos: [{ path: '/repo', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [idleSess('s-a', 'a'), idleSess('s-b', 'b')],
    machines: [],
    pins: { panels: [], worktrees: [], repos: [] },
    setPinned: vi.fn(),
    issues: [
      issue('a', 'Read selected issue'),
      issue('b', 'Unread issue', {
        readAt: null,
        unread: true,
        // Spin-off provenance (POD-85): b came out of a.
        deps: [{ id: 'a', type: 'discovered-from' }],
        displayRef: 'POD-2',
      }),
    ],
    trpc: {
      settings: {
        get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
      },
      issues: { defer: { mutate: vi.fn(async () => ({})) } },
    },
    selectedWorktree: null,
    setSelectedWorktree: vi.fn(),
    selectedIssueId: 'a',
    setSelectedIssueId: vi.fn(),
    navigateWorkspace: vi.fn(() => true),
    setOpenIssueId: vi.fn(),
    paneA: null,
    setPane: vi.fn(),
    fileTabs: [],
    view: 'workspace',
    setView: vi.fn(),
    sidebarSettings: { groupByRepo: false },
    setSidebarSettings: vi.fn(),
    uiState: { get: () => null, set: () => {}, subscribe: () => () => {} },
    spawnDraftAgent: vi.fn(),
    markIssueRead: vi.fn(),
    markSessionRead: vi.fn(),
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    readFixture: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

// The clickable row button that carries the label text.
function rowButton(label: string): HTMLElement {
  const span = screen.getByText(label)
  const btn = span.closest('button')
  if (!btn) throw new Error(`no button for ${label}`)
  return btn
}

afterEach(cleanup)

describe('SidebarUnified selection weight (#41 redesign)', () => {
  it('the selected row is the one raised white row, and draws no bridge notch', () => {
    render(<SidebarUnified />)
    const active = rowButton('Read selected issue')
    const row = active.closest('[class*="group/row"]') as HTMLElement
    expect(row.getAttribute('data-selected')).toBe('true')
    // THE CALM DESIGN (POD-2074): selection is the row lifted onto `--chip`
    // with a hairline rim and a soft shadow — drawn by `.shell-work-row
    // [data-selected="true"]` in CSS, so no inline spine and no tint.
    expect(cssBlock('.shell-work-row[data-selected="true"]')).toContain('background: var(--chip)')
    expect(cssBlock('.shell-work-row[data-selected="true"]')).toContain('box-shadow')
    expect(row.style.boxShadow).toBe('')
    expect(row.querySelector('[data-testid="bridge-notch"]')).toBeNull()
    const other = rowButton('Unread issue').closest('[class*="group/row"]') as HTMLElement
    expect(other.getAttribute('data-selected')).toBe('false')
  })

  it('sets the selected title semibold, as unread is', () => {
    render(<SidebarUnified />)
    expect(screen.getByText('Read selected issue').className).toContain('font-semibold')
    expect(screen.getByText('Unread issue').className).toContain('font-semibold')
  })

  it('selection never changes density-owned row geometry (POD-81)', () => {
    render(<SidebarUnified />)
    const active = rowButton('Read selected issue').closest('[class*="group/row"]') as HTMLElement
    const plain = rowButton('Unread issue').closest('[class*="group/row"]') as HTMLElement
    // Both selection states delegate geometry to the same density-aware CSS
    // class, so a click cannot introduce a state-specific shift on either axis.
    expect(active.className).toContain('shell-work-row')
    expect(plain.className).toContain('shell-work-row')
    const paddingClasses = (row: HTMLElement) =>
      row.className.split(/\s+/).filter((token) => /^p(?:[xytrlb])?-/.test(token))
    expect(paddingClasses(active)).toEqual(paddingClasses(plain))

    // Balanced and compact density own their distinct padding in CSS: the
    // design's `padding: 8px 12px 8px 22px` on a radius-8 row.
    expect(cssBlock('.shell-work-row')).toContain('--work-row-pad: 8px')
    expect(cssBlock('.shell-work-row')).toContain(
      'padding: var(--work-row-pad) 12px var(--work-row-pad) 22px',
    )
    expect(cssBlock('html[data-density="compact"] .shell-work-row')).toContain(
      '--work-row-pad: 6px',
    )
    expect(active.className).not.toMatch(/\bmin-h-\[/)
    // The selection rim is a box-shadow, never a border that changes the box.
    expect(active.className.split(/\s+/)).not.toContain('border')
  })

  it('keeps spin-off origins out of the status line', () => {
    render(<SidebarUnified />)
    const spin = rowButton('Unread issue').closest('[class*="group/row"]') as HTMLElement
    expect(spin.querySelector('[data-testid="spinoff-origin-tick"]')).toBeNull()
    expect(spin.textContent).not.toContain('⤷')
    const plain = rowButton('Read selected issue').closest('[class*="group/row"]') as HTMLElement
    expect(plain.querySelector('[data-testid="spinoff-origin-tick"]')).toBeNull()
    // The origin row is findable for the lineage flash.
    expect(plain.getAttribute('data-issue-row')).toBe('a')
  })

  it('marks unread with a quiet info dot next to the title, never on the fleet (POD-912)', () => {
    render(<SidebarUnified />)
    const unreadRow = rowButton('Unread issue').closest('[class*="group/row"]') as HTMLElement
    expect(unreadRow.querySelector('[data-testid="row-unread-chip"]')).toBeNull()
    const dot = unreadRow.querySelector('[data-testid="row-unread-dot"]') as HTMLElement
    expect(dot).toBeTruthy()
    // Fleet tiles stack and show ×N — they cannot carry per-session unread.
    expect(dot.closest('[data-testid="issue-fleet-summary"]')).toBeNull()
    const activeRow = rowButton('Read selected issue').closest(
      '[class*="group/row"]',
    ) as HTMLElement
    expect(activeRow.querySelector('[data-testid="row-unread-dot"]')).toBeNull()
  })
})
