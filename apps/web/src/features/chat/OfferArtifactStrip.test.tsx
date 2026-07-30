import type { IssuePanelArtifact, IssueWire, SessionMeta, SessionOffer } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfferArtifactStrip } from './OfferArtifactStrip'

// Offer evidence thumbnails [POD-120]: ≤3 thumbs + "+N", media click opens the
// lightbox (session untouched), file click opens the artifact tab, and clicks
// never bubble to a surrounding card.

const openArtifact = vi.fn()
const openFileInWorktree = vi.fn()
let issues: IssueWire[] = []

vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) =>
    sel({ issues, httpOrigin: 'http://h', openArtifact, openFileInWorktree }),
}))

const art = (path: string, addedAt: string, artifactId?: string): IssuePanelArtifact => ({
  path,
  addedAt,
  ...(artifactId ? { artifactId } : {}),
})

const makeIssue = (artifacts: IssuePanelArtifact[]): IssueWire =>
  ({
    id: 'iss_1',
    worktreePath: '/wt',
    repoPath: '/repo',
    panel: { todos: [], artifacts, deferred: [] },
    sessions: [],
  }) as unknown as IssueWire

const session = { sessionId: 'sess_1', issueId: 'iss_1' } as unknown as SessionMeta

const offerWith = (artifacts: string[]): SessionOffer => ({
  message: 'm',
  actions: [],
  artifacts,
  createdAt: '2026-07-21T10:00:00.000Z',
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  openArtifact.mockClear()
  openFileInWorktree.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('OfferArtifactStrip [POD-120]', () => {
  it('shows at most 3 thumbnails plus a +N chip', () => {
    issues = [
      makeIssue(
        ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'].map((p) =>
          art(p, '2026-07-21T09:00:00.000Z'),
        ),
      ),
    ]
    act(() =>
      root.render(
        <OfferArtifactStrip
          offer={offerWith(['a.png', 'b.png', 'c.png', 'd.png', 'e.png'])}
          session={session}
        />,
      ),
    )
    expect(container.querySelectorAll('[data-testid="offer-artifact-thumb"]').length).toBe(3)
    expect(container.querySelector('[data-testid="offer-artifact-extra"]')?.textContent).toBe('+2')
  })

  it('renders nothing (no strip) when no path resolves', () => {
    issues = [makeIssue([art('real.png', '2026-07-21T09:00:00.000Z')])]
    act(() => root.render(<OfferArtifactStrip offer={offerWith(['gone.png'])} session={session} />))
    expect(container.querySelector('[data-testid="offer-artifacts"]')).toBeNull()
  })

  it('opens the lightbox on an image click without bubbling to the card', () => {
    issues = [makeIssue([art('shot.png', '2026-07-21T09:00:00.000Z', 'art_1')])]
    const cardClick = vi.fn()
    act(() =>
      root.render(
        // biome-ignore lint/a11y/noStaticElementInteractions: stand-in for the tray card wrapper
        // biome-ignore lint/a11y/useKeyWithClickEvents: test scaffold
        <div onClick={cardClick}>
          <OfferArtifactStrip offer={offerWith(['shot.png'])} session={session} />
        </div>,
      ),
    )
    const thumb = container.querySelector<HTMLButtonElement>('[data-testid="offer-artifact-thumb"]')
    expect(thumb?.querySelector('img')).not.toBeNull()
    act(() => thumb?.click())
    // Lightbox portals to <body>; the surrounding card click never fired.
    expect(document.body.querySelector('img[alt="shot.png"]')).not.toBeNull()
    expect(cardClick).not.toHaveBeenCalled()
    expect(openArtifact).not.toHaveBeenCalled()
  })

  it('opens a non-media artifact as an artifact file tab', () => {
    issues = [makeIssue([art('notes/plan.md', '2026-07-21T09:00:00.000Z', 'art_2')])]
    act(() =>
      root.render(<OfferArtifactStrip offer={offerWith(['notes/plan.md'])} session={session} />),
    )
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="offer-artifact-thumb"]')?.click(),
    )
    expect(openArtifact).toHaveBeenCalledWith({
      issueId: 'iss_1',
      artifactId: 'art_2',
      path: 'plan.md',
      worktreePath: '/wt',
    })
  })
})
