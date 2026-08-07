// @vitest-environment happy-dom
//
// The dock's scroll contract (POD-516 r2 #6/#7).
//
// The panel is TWO boxes: a `flex-none` fixed region (identity, title,
// description, three controls, a one-line decision band) and ONE `flex-1
// min-h-0 overflow-y-auto` scroll below it. The scroll only ever gets what the
// fixed region leaves, and `min-h-0` correctly lets it go to zero — so the
// fixed region must be bounded by construction.
//
// It was not. It carried one full `OfferBar` card per session with a live
// offer, and measured in Chromium against the shipped stylesheet that region
// took 1126px of a 1088px-tall dock: the scroll box was left 36px of padding
// and 0px of content height, with 1836px of unreachable content inside it.
// A single offer did the same at a 720px viewport.
//
// These tests pin the two halves of that: the flex chain that makes the scroll
// scrollable, and the rule that nothing above it may grow with the data.
import type { SessionMeta } from '@podium/model'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePanelView } from './IssuePanelView'

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))

const ROOT = makeIssue({
  id: 'root',
  repoPath: '/r',
  seq: 1,
  title: 'Operator workspace',
  description: 'Rework the dock into one scroll.',
  worktreePath: '/r',
  // Pinned so the decision band's line does not vary with the roster.
  humanQuestion: 'Ship the preview or hold it?',
})

type SessionOverride = Partial<Omit<SessionMeta, 'sessionId' | 'issueId'>> & {
  sessionId?: string
  issueId?: string
}

const session = (over: SessionOverride = {}): SessionMeta =>
  ({
    sessionId: 's1',
    issueId: 'root',
    agentKind: 'claude-code',
    name: 'Workspace coordinator',
    archived: false,
    status: 'live',
    lastActiveAt: '2026-08-07T00:00:00.000Z',
    ...over,
  }) as unknown as SessionMeta

const offering = (id: string, name: string): SessionMeta =>
  session({
    sessionId: id,
    name,
    offer: {
      message: `${name} asks: land this?\nSupporting detail that would have been a card.`,
      actions: [
        { label: 'Land it', prompt: 'Land it' },
        { label: 'Send back', prompt: 'Send back', input: true },
      ],
      createdAt: '2026-08-07T00:00:00.000Z',
    },
  } as SessionOverride)

let mockIssues = [ROOT]
let mockSessions: SessionMeta[] = []
const sendText = vi.fn(async () => ({}))
const navigateToSession = vi.fn()

vi.mock('@/app/store', () => {
  const state = () => ({
    trpc: {
      issues: {
        comments: { query: vi.fn(async () => []) },
        events: { query: vi.fn(async () => []) },
        start: { mutate: vi.fn(async () => ({})) },
        close: { mutate: vi.fn(async () => ({})) },
        update: { mutate: vi.fn(async () => ({})) },
        clearNeedsHuman: { mutate: vi.fn(async () => ({})) },
        panelApply: { mutate: vi.fn(async () => ({})) },
      },
      sessions: { sendText: { mutate: sendText } },
    },
    httpOrigin: '',
    openFileInWorktree: vi.fn(),
    openArtifact: vi.fn(),
    uiState: { get: () => null, set: vi.fn() },
    issues: mockIssues,
    sessions: mockSessions,
    repos: [],
    machines: [],
    setPane: vi.fn(),
    setView: vi.fn(),
    setOpenIssueId: vi.fn(),
    navigateToSession,
    renameSession: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    markIssueRead: vi.fn(),
    markIssueUnread: vi.fn(),
    markSessionRead: vi.fn(),
  })
  return {
    useStore: () => state(),
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state()),
    useReplicaIssues: () => (state() as unknown as { issues: never[] }).issues,
  }
})

beforeEach(() => {
  mockIssues = [ROOT]
  mockSessions = []
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** The panel's outermost element, whichever wrapper RTL mounted it in. */
const panelRoot = (container: HTMLElement): HTMLElement =>
  container.firstElementChild as HTMLElement

describe('the task dock scrolls', () => {
  it('has exactly one scroll region, and it is the flexible one', () => {
    const { container } = render(<IssuePanelView cwd="/r" />)

    const scrolls = container.querySelectorAll('[data-dock-scroll]')
    expect(scrolls).toHaveLength(1)
    const scroll = scrolls[0] as HTMLElement
    // overflow alone is not enough — a flex child that cannot shrink below its
    // content has nothing to scroll IN.
    expect(scroll.className).toContain('overflow-y-auto')
    expect(scroll.className).toContain('flex-1')
    expect(scroll.className).toContain('min-h-0')
  })

  it('keeps every flexible ancestor shrinkable — a wrapper without min-h-0 is the bug', () => {
    const { container } = render(<IssuePanelView cwd="/r" />)

    const root = panelRoot(container)
    let node = container.querySelector('[data-dock-scroll]') as HTMLElement | null
    const offenders: string[] = []
    while (node && node !== container) {
      // `flex-1` without `min-h-0` is exactly the shape that pins a column open
      // at its content height and makes the scroll below it unreachable.
      if (node.className.includes('flex-1') && !node.className.includes('min-h-0'))
        offenders.push(node.className)
      node = node.parentElement
    }
    expect(offenders).toEqual([])
    expect(root.className).toContain('min-h-0')
  })

  it('never lets the region above the scroll grow with the data', () => {
    // React mints a fresh id per mount for the menu trigger; it says nothing
    // about the box's size.
    const shape = (el: HTMLElement): string => el.innerHTML.replace(/base-ui-[\w-]+/g, 'id')

    mockSessions = [offering('s1', 'Coordinator')]
    const one = render(<IssuePanelView cwd="/r" />)
    const fixedWithOne = shape(within(one.container).getByTestId('dock-fixed'))
    cleanup()

    mockSessions = [
      offering('s1', 'Coordinator'),
      offering('s2', 'Deck builder'),
      offering('s3', 'Dock designer'),
      offering('s4', 'Sidebar designer'),
    ]
    const four = render(<IssuePanelView cwd="/r" />)

    // Four agents are waiting instead of one, and the fixed region is byte-for-
    // byte the same box. Everything that varies moved into the scroll.
    expect(shape(within(four.container).getByTestId('dock-fixed'))).toBe(fixedWithOne)
    expect(within(four.container).getAllByTestId('dock-session-row')).toHaveLength(4)
  })

  it('keeps the offer cards out of the dock entirely', () => {
    mockSessions = [offering('s1', 'Coordinator'), offering('s2', 'Deck builder')]
    render(<IssuePanelView cwd="/r" />)

    expect(screen.queryAllByTestId('offer-bar')).toHaveLength(0)
    // The band stays one line: the headline, and no answers of its own.
    const band = screen.getByTestId('dock-decision-band')
    expect(band.textContent).toContain('Needs you')
    expect(within(band).queryByText('Land it')).toBeNull()
  })
})

describe('needs-you lives on the session that asked', () => {
  it('marks the waiting session and folds its answers underneath it', () => {
    mockSessions = [session({ sessionId: 'quiet', name: 'Quiet agent' }), offering('ask', 'Asker')]
    render(<IssuePanelView cwd="/r" />)

    const rows = screen.getAllByTestId('dock-session-row')
    // The one that stopped and asked sorts first — the roster folds at five and
    // a waiting agent must never be the one behind the fold.
    expect(rows[0]?.dataset.needsYou).toBe('true')
    expect(within(rows[0] as HTMLElement).getByText('Asker')).toBeTruthy()
    expect(rows[1]?.dataset.needsYou).toBeUndefined()

    const answer = within(rows[0] as HTMLElement).getByTestId('dock-session-answer')
    expect(answer.textContent).toContain('Asker asks: land this?')
    expect(within(answer).getByText('Land it')).toBeTruthy()
  })

  it('sends a one-click answer to that session', () => {
    mockSessions = [offering('ask', 'Asker')]
    render(<IssuePanelView cwd="/r" />)

    fireEvent.click(screen.getByText('Land it'))
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ask', text: 'Land it' }),
    )
  })

  it('hands an answer that needs prose to the conversation instead of growing a field', () => {
    mockSessions = [offering('ask', 'Asker')]
    render(<IssuePanelView cwd="/r" />)

    fireEvent.click(screen.getByText('Send back'))
    expect(sendText).not.toHaveBeenCalled()
    expect(navigateToSession).toHaveBeenCalledWith('ask')
  })

  it('leaves a working session unmarked', () => {
    mockSessions = [session()]
    render(<IssuePanelView cwd="/r" />)

    const row = screen.getByTestId('dock-session-row')
    expect(row.dataset.needsYou).toBeUndefined()
    expect(within(row).queryByTestId('dock-session-answer')).toBeNull()
  })
})
