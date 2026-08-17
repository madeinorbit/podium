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
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
    // POD-331: the worklist is a PUBLISHED slice now, so the component reads it
    // through `useSlice` instead of deriving it locally. These suites assert
    // BEHAVIOUR, not derivation counts, so this derives on every read rather
    // than memoizing — sharing is measured in src/perf/slice-render-count.test.tsx,
    // and a mock that pretended to memoize here would be a second, untested
    // implementation of the mechanism.
    useSlice: (def: { derive: (s: unknown) => unknown }) =>
      def.derive({ ...(useStore() as object), coarseNow: Date.now() } as never),
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
  it('a selected row is a lifted band with an ink spine, and no bridge notch', () => {
    render(<SidebarUnified />)
    const active = rowButton('Read selected issue')
    const row = active.closest('[class*="group/row"]') as HTMLElement
    expect(row.getAttribute('data-selected')).toBe('true')
    // THE BAND LIFTS to the raised tier and takes a 3px spine. `--chip` rather
    // than `--card` because two presets give card and sidebar the same value
    // (POD-1057); the spine is NEUTRAL ink because the issue's hue is already
    // the row's resting ground, and selection is a different question.
    expect(row.className).toContain('bg-chip')
    expect(row.style.boxShadow).toBe('inset 3px 0 0 var(--text-strong)')
    // NO BRIDGE NOTCH. The 3a design drops the tab that used to grow out of the
    // selected row into the engraved column — with it went the whole horizontal
    // head-room the scroller had to reserve for it (see SidebarUnified).
    expect(row.querySelector('[data-testid="bridge-notch"]')).toBeNull()
    const other = rowButton('Unread issue').closest('[class*="group/row"]') as HTMLElement
    expect(other.getAttribute('data-selected')).toBe('false')
    expect(other.className).not.toContain('bg-chip')
  })

  it('gives selection one weight step, and unread the one above it', () => {
    render(<SidebarUnified />)
    // Medium for the row you are in, semibold for a row with something new —
    // and nothing at all for the other twenty-eight.
    expect(screen.getByText('Read selected issue').className).toContain('font-medium')
    expect(screen.getByText('Unread issue').className).toContain('font-semibold')
  })

  it('selection never changes density-owned row geometry (POD-81)', () => {
    render(<SidebarUnified />)
    const active = rowButton('Read selected issue').closest('[class*="group/row"]') as HTMLElement
    const plain = rowButton('Unread issue').closest('[class*="group/row"]') as HTMLElement
    // Both selection states delegate vertical geometry to the same density-aware
    // CSS class. Any remaining padding utilities must also be identical, so a
    // click cannot introduce a state-specific shift on either axis.
    expect(active.className).toContain('shell-work-row')
    expect(plain.className).toContain('shell-work-row')
    const paddingClasses = (row: HTMLElement) =>
      row.className.split(/\s+/).filter((token) => /^p(?:[xytrlb])?-/.test(token))
    expect(paddingClasses(active)).toEqual(paddingClasses(plain))

    // Balanced and compact density own their distinct vertical padding in CSS,
    // rather than baking one mode's geometry into the component utility list.
    expect(cssBlock('.shell-work-row')).toContain('--work-row-pad: 7px')
    expect(cssBlock('.shell-work-row')).toContain('padding-block: var(--work-row-pad)')
    expect(cssBlock('html[data-density="compact"] .shell-work-row')).toContain(
      '--work-row-pad: 6px',
    )
    // The row rule is CSS too (POD-1078), and at the soft weight: the bands rule
    // at --hairline-bar and have to stay the louder structure. Asserted here
    // beside the padding because the two are one decision — the mock's row is
    // `padding:7px 13px;border-bottom:1px solid`, and a rule between rows needs
    // the air on both sides of it.
    expect(cssBlock('.shell-work-row')).toContain('border-bottom: 1px solid var(--hairline-soft)')

    /**
     * THE ARTBOARD'S TWO ROW BOXES (POD-1253).
     *
     * `ADE Sidebar 3a.dc.html` writes `min-height:36px` on a two-line row and
     * `min-height:46px` on one carrying the meter, on a CONTENT box — so its
     * rows measure 36+14+1 = 51px and 46+14+1 = 61px. This landed as a single
     * `min-h-[46px]` utility on a BORDER-box row, which is 47px: one number
     * where the design has two, and the wrong one, four pixels under the
     * artboard's short row.
     *
     * Asserted against the stylesheet rather than a rendered height because
     * happy-dom lays nothing out — and asserted at all because this row box has
     * now been re-derived three times (POD-1057, POD-1078, here) and each time
     * the thing that drifted was the reading of the mock's `min-height`.
     */
    expect(cssBlock('.shell-work-row')).toContain('--work-row-content: 36px')
    expect(cssBlock('.shell-work-row')).toContain(
      'min-height: calc(var(--work-row-content) + 2 * var(--work-row-pad) + 1px)',
    )
    expect(cssBlock('.shell-work-row:has([data-testid="row-progress"])')).toContain(
      '--work-row-content: 46px',
    )
    // And the row must NOT also carry a utility min-height, which would be a
    // second, density-blind spelling of the same decision silently winning or
    // losing depending on the cascade.
    expect(active.className).not.toMatch(/\bmin-h-\[/)

    // The selection ring is an inset box-shadow, never a border that changes
    // the shared box dimensions.
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
