import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import {
  type ArtifactId,
  asArtifactId,
  asSessionId,
  type IssuePanelArtifact,
  type SessionOffer,
} from '@podium/model'
import { act, within } from '@testing-library/react'
import { Profiler, useRef, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/test-support/mock-screen-pool'
import { ARTIFACTS_TAB_ARTIFACT_ID } from '@/features/files/artifacts-tab-id'
import { OfferArtifactStrip } from './OfferArtifactStrip'
import { OfferBar } from './OfferBar'

// Offer evidence row [POD-120, POD-2111]: always shown in the card, at most four
// slots with the last one turned into "+N" (which opens the Artifacts tab), as
// many as the row's width holds; media click opens the lightbox (session
// untouched), file click opens the artifact tab, and clicks never bubble to a
// surrounding card.

const openArtifact = vi.fn()
const openFileInWorktree = vi.fn()
let issues: IssueViewModel[] = []
let publication = 0
const storeListeners = new Set<() => void>()
let storeSnapshot = {
  get issues() {
    return issues
  },
  httpOrigin: 'http://h',
  openArtifact,
  openFileInWorktree,
  publication,
}

function useTestStoreSelector<T>(
  selector: (store: typeof storeSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const equalityRef = useRef(isEqual)
  equalityRef.current = isEqual
  const cache = useRef<{ snapshot: typeof storeSnapshot; selected: T } | null>(null)

  return useSyncExternalStore(
    (listener) => {
      storeListeners.add(listener)
      return () => storeListeners.delete(listener)
    },
    () => {
      if (cache.current?.snapshot === storeSnapshot) return cache.current.selected
      const next = selectorRef.current(storeSnapshot)
      const selected =
        cache.current && equalityRef.current(cache.current.selected, next)
          ? cache.current.selected
          : next
      cache.current = { snapshot: storeSnapshot, selected }
      return selected
    },
  )
}

function publishUnchangedSelection(): void {
  publication++
  storeSnapshot = { ...storeSnapshot, publication }
  for (const listener of storeListeners) listener()
}

vi.mock('@/app/store', () => ({
  useRuntimeSelector: useTestStoreSelector,
}))

const art = (path: string, addedAt: string, artifactId?: ArtifactId): IssuePanelArtifact => ({
  path,
  addedAt,
  ...(artifactId ? { artifactId } : {}),
})

const makeIssue = (artifacts: IssuePanelArtifact[]): IssueViewModel =>
  ({
    id: 'iss_1',
    worktreePath: '/wt',
    repoPath: '/repo',
    panel: { todos: [], artifacts, deferred: [] },
    sessions: [],
  }) as unknown as IssueViewModel

const session = { sessionId: asSessionId('sess_1'), issueId: 'iss_1' } as unknown as SessionView

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
  publication = 0
  storeSnapshot = {
    get issues() {
      return issues
    },
    httpOrigin: 'http://h',
    openArtifact,
    openFileInWorktree,
    publication,
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const thumbs = () => container.querySelectorAll('[data-testid="offer-artifact-thumb"]')
const extraTile = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="offer-artifact-extra"]')
const pngs = (n: number) => Array.from({ length: n }, (_, i) => `shot-${i}.png`)

describe('OfferArtifactStrip [POD-120, POD-2111]', () => {
  it('does not rerender when a store publication leaves its selected fields unchanged', () => {
    issues = [makeIssue([art('shot.png', '2026-07-21T09:00:00.000Z')])]
    let updates = 0
    act(() =>
      root.render(
        <Profiler
          id="offer-artifacts"
          onRender={(_id, phase) => {
            if (phase === 'update') updates++
          }}
        >
          <OfferArtifactStrip offer={offerWith(['shot.png'])} session={session} />
        </Profiler>,
      ),
    )
    const updatesBeforePublication = updates

    act(() => publishUnchangedSelection())

    expect(updates).toBe(updatesBeforePublication)
    expect(container.querySelector('[data-testid="offer-artifacts"]')).not.toBeNull()
  })

  it('shows the evidence in the offer card without any interaction', () => {
    issues = [makeIssue(['a.png', 'b.html'].map((p) => art(p, '2026-07-21T09:00:00.000Z')))]
    const offer = { ...offerWith(['a.png', 'b.html']), message: 'Ready\nThe one thing to judge.' }
    act(() =>
      root.render(
        <OfferBar offer={offer} disabled={false} onAction={() => {}} session={session} />,
      ),
    )
    const row = container.querySelector('[data-testid="offer-artifacts"]')
    expect(thumbs().length).toBe(2)
    // In the card's own flow, not in the fold that opens for feedback.
    expect(row?.closest('[data-testid="offer-detail"]')).toBeNull()

    // The chevron folds the card to its headline; the evidence goes with the body.
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="offer-disclosure"]')?.click(),
    )
    expect(container.querySelector('[data-testid="offer-artifacts"]')).toBeNull()
  })

  it('fills all four slots when the list fits exactly', () => {
    issues = [makeIssue(pngs(4).map((p) => art(p, '2026-07-21T09:00:00.000Z')))]
    act(() => root.render(<OfferArtifactStrip offer={offerWith(pngs(4))} session={session} />))
    expect(thumbs().length).toBe(4)
    expect(extraTile()).toBeNull()
  })

  it('turns the last slot into +N, which opens the issue Artifacts tab without bubbling', () => {
    issues = [makeIssue(pngs(6).map((p) => art(p, '2026-07-21T09:00:00.000Z')))]
    const cardClick = vi.fn()
    act(() =>
      root.render(
        // biome-ignore lint/a11y/noStaticElementInteractions: stand-in for a clickable host surface
        // biome-ignore lint/a11y/useKeyWithClickEvents: test scaffold
        <div onClick={cardClick}>
          <OfferArtifactStrip offer={offerWith(pngs(6))} session={session} />
        </div>,
      ),
    )
    expect(thumbs().length).toBe(3)
    expect(extraTile()?.querySelector('.offer-evidence-more')?.textContent).toBe('+3')
    act(() => extraTile()?.click())
    expect(openArtifact).toHaveBeenCalledWith({
      issueId: 'iss_1',
      artifactId: ARTIFACTS_TAB_ARTIFACT_ID,
      path: 'Artifacts',
      worktreePath: '/wt',
    })
    expect(cardClick).not.toHaveBeenCalled()
  })

  it('shows only as many tiles as the row is wide, never scrolling', () => {
    // A 250px row of 112px tiles with 10px gaps holds two slots: one tile + "+N".
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(250)
    const computed = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      const style = computed(el)
      if (!(el as HTMLElement).classList.contains('offer-evidence')) return style
      return {
        ...style,
        columnGap: '10px',
        getPropertyValue: (name: string) => (name === '--offer-tile-w' ? '112px' : ''),
      } as CSSStyleDeclaration
    })
    issues = [makeIssue(pngs(3).map((p) => art(p, '2026-07-21T09:00:00.000Z')))]
    act(() => root.render(<OfferArtifactStrip offer={offerWith(pngs(3))} session={session} />))
    expect(thumbs().length).toBe(1)
    expect(extraTile()?.querySelector('.offer-evidence-more')?.textContent).toBe('+2')
  })

  it('gives a non-media artifact the same tile, wearing its kind', () => {
    issues = [
      makeIssue([
        art('concept.html', '2026-07-21T09:00:00.000Z'),
        art('notes/plan.md', '2026-07-21T09:00:00.000Z'),
      ]),
    ]
    act(() =>
      root.render(
        <OfferArtifactStrip
          offer={offerWith(['concept.html', 'notes/plan.md'])}
          session={session}
        />,
      ),
    )
    const [html, md] = Array.from(thumbs())
    expect(html?.querySelector('img')).toBeNull()
    expect(html?.querySelector('[data-testid="offer-artifact-kind"]')?.textContent).toBe('HTML')
    expect(html?.querySelector('.offer-evidence-caption')?.textContent).toBe('concept.html')
    expect(md?.querySelector('[data-testid="offer-artifact-kind"]')?.textContent).toBe('MD')
    expect(md?.querySelector('.offer-evidence-caption')?.textContent).toBe('plan.md')
  })

  it('renders nothing (no strip) when no path resolves', () => {
    issues = [makeIssue([art('real.png', '2026-07-21T09:00:00.000Z')])]
    act(() => root.render(<OfferArtifactStrip offer={offerWith(['gone.png'])} session={session} />))
    expect(container.querySelector('[data-testid="offer-artifacts"]')).toBeNull()
  })

  it('opens the lightbox on an image click without bubbling to the card', () => {
    issues = [makeIssue([art('shot.png', '2026-07-21T09:00:00.000Z', asArtifactId('art_1'))])]
    const cardClick = vi.fn()
    act(() =>
      root.render(
        // biome-ignore lint/a11y/noStaticElementInteractions: stand-in for a clickable host surface
        // biome-ignore lint/a11y/useKeyWithClickEvents: test scaffold
        <div onClick={cardClick}>
          <OfferArtifactStrip offer={offerWith(['shot.png'])} session={session} />
        </div>,
      ),
    )
    const thumb = container.querySelector<HTMLButtonElement>('[data-testid="offer-artifact-thumb"]')
    expect(thumb?.querySelector('img')).not.toBeNull()
    // The caption names the tile once; the picture above it is decorative.
    expect(within(container).getByRole('button', { name: 'shot.png' })).toBe(thumb)
    act(() => thumb?.click())
    // Lightbox portals to <body>; the surrounding card click never fired.
    expect(document.body.querySelector('[role="dialog"] img[alt="shot.png"]')).not.toBeNull()
    expect(cardClick).not.toHaveBeenCalled()
    expect(openArtifact).not.toHaveBeenCalled()
  })

  it('opens a non-media artifact as an artifact file tab', () => {
    issues = [makeIssue([art('notes/plan.md', '2026-07-21T09:00:00.000Z', asArtifactId('art_2'))])]
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

  it('navigates all offered media in curated order, including those hidden behind +N', () => {
    const paths = ['first.png', 'notes.md', 'second.png', 'third.png', 'fourth.png']
    issues = [makeIssue(paths.map((path, i) => art(path, '2026-07-21', asArtifactId(`art_${i}`))))]
    act(() => root.render(<OfferArtifactStrip offer={offerWith(paths)} session={session} />))
    expect(extraTile()?.querySelector('.offer-evidence-more')?.textContent).toBe('+2')
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="offer-artifact-thumb"]')?.click(),
    )

    const preview = () => document.body.querySelector('[role="dialog"]')
    expect(preview()?.querySelector('img')?.alt).toBe('first.png')
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    expect(preview()?.querySelector('img')?.alt).toBe('second.png')
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    expect(preview()?.querySelector('img')?.alt).toBe('third.png')
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    expect(preview()?.querySelector('img')?.alt).toBe('fourth.png')
    expect(openArtifact).not.toHaveBeenCalled()
    expect(openFileInWorktree).not.toHaveBeenCalled()
  })
})
