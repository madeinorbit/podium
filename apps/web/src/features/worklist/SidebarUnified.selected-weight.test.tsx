// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarUnified } from './SidebarUnified'

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
    blockedBy: [],
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
    readAt: '2026-06-20T00:00:00.000Z',
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
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

vi.mock('@/features/machines/HostIndicators', () => ({ HostIndicators: () => null }))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
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
  it('a selected row wears the colour-mixed background, semibold title and the bridge notch', () => {
    render(<SidebarUnified />)
    const active = rowButton('Read selected issue')
    // Selection reads as the slate colour-mixed background + border on the row
    // wrapper (handoff §2.5) — inline style, colour-flowed from the issue colour
    // (slate for uncoloured issues).
    const row = active.closest('[class*="group/row"]') as HTMLElement
    expect(row.getAttribute('data-selected')).toBe('true')
    // (The colour-mixed background itself is inline style — happy-dom drops
    // color-mix() values, so the paint is asserted in the Chromium probe.)
    // The selected title lifts to semibold (handoff), distinct from UNREAD's medium.
    const label = screen.getByText('Read selected issue')
    expect(label.className).toContain('font-semibold')
    expect(label.className).not.toContain('font-medium')
    // The bridge notch grows out of the selected row toward the engraved column.
    expect(row.querySelector('[data-testid="bridge-notch"]')).toBeTruthy()
    // Unselected rows carry neither the notch nor the selected background.
    const other = rowButton('Unread issue').closest('[class*="group/row"]') as HTMLElement
    expect(other.getAttribute('data-selected')).toBe('false')
    expect(other.querySelector('[data-testid="bridge-notch"]')).toBeNull()
  })

  it('unread remains the sole weight signal', () => {
    render(<SidebarUnified />)
    const unreadLabel = screen.getByText('Unread issue')
    expect(unreadLabel.className).toContain('font-medium')
  })

  it('selection never changes row geometry: same padding, no border class (POD-81)', () => {
    render(<SidebarUnified />)
    const active = rowButton('Read selected issue').closest('[class*="group/row"]') as HTMLElement
    const plain = rowButton('Unread issue').closest('[class*="group/row"]') as HTMLElement
    // The selection ring is an inset box-shadow (inline style), never a border
    // or padding change — a click must not shift the list by a pixel.
    expect(active.className).toContain('py-[5px]')
    expect(plain.className).toContain('py-[5px]')
    expect(active.className.split(/\s+/)).not.toContain('border')
    expect(active.style.boxShadow).toContain('inset')
  })

  it('a spin-off row carries the quiet ⤷ origin tick; a plain row does not (POD-85)', () => {
    render(<SidebarUnified />)
    const spin = rowButton('Unread issue').closest('[class*="group/row"]') as HTMLElement
    const tick = spin.querySelector('[data-testid="spinoff-origin-tick"]')
    expect(tick).toBeTruthy()
    expect(tick?.textContent).toContain('⤷ 1')
    expect(tick?.getAttribute('title')).toContain('Spun off from')
    expect(tick?.getAttribute('title')).toContain('Read selected issue')
    const plain = rowButton('Read selected issue').closest('[class*="group/row"]') as HTMLElement
    expect(plain.querySelector('[data-testid="spinoff-origin-tick"]')).toBeNull()
    // The origin row is findable for the lineage flash.
    expect(plain.getAttribute('data-issue-row')).toBe('a')
  })

  it('an unread, unselected row carries the unread beacon dot; the selected row never does (POD-81)', () => {
    render(<SidebarUnified />)
    const unreadRow = rowButton('Unread issue').closest('[class*="group/row"]') as HTMLElement
    const dot = unreadRow.querySelector('[data-testid="row-unread-dot"]') as HTMLElement
    expect(dot).toBeTruthy()
    // R5 (POD-166): the beacon is a PLAIN still dot — the halo ring is gone.
    expect(dot.className).not.toContain('ring')
    const activeRow = rowButton('Read selected issue').closest(
      '[class*="group/row"]',
    ) as HTMLElement
    expect(activeRow.querySelector('[data-testid="row-unread-dot"]')).toBeNull()
  })
})
