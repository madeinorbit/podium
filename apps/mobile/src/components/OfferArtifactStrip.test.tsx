import type { IssueViewModel } from '@podium/client-core/replica'
import type { IssuePanelArtifact, SessionOffer } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Pressable } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Offer evidence in the offer [POD-120]: the strip draws the artifacts the
// agent named. A tile opens the artifact viewer; +N opens the full list.

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))
// Ships untranspiled Flow, which this environment cannot parse — the same stub
// the neighbouring card tests use. Rows are found by label, not by glyph.
vi.mock('lucide-react-native', () => ({
  FileText: () => null,
  Globe: () => null,
  Image: () => null,
  Play: () => null,
}))
vi.mock('../client/hooks', () => ({ useHttpOrigin: () => 'https://podium.local' }))
vi.mock('../client/server-profile-context', () => ({ useServerProfile: () => ({ bearer: 'tok' }) }))
// The viewer is the other agent's surface and pulls the WebView/markdown graph;
// what this file asserts is WHICH artifact the strip hands it.
vi.mock('./ArtifactViewer', async () => {
  const { Text } = await import('react-native')
  return {
    ArtifactViewer: ({
      artifact,
      url,
    }: {
      artifact: IssuePanelArtifact | null
      url: string | null
    }) => <Text testID="viewer">{`${artifact?.path ?? 'none'} ${url ?? 'no-url'}`}</Text>,
  }
})

const { OfferArtifactStrip } = await import('./OfferArtifactStrip')

const art = (path: string, addedAt = '2026-08-20T00:00:00.000Z'): IssuePanelArtifact => ({
  path,
  addedAt,
})

const issue = (artifacts: IssuePanelArtifact[]): IssueViewModel =>
  ({
    id: 'iss_offer',
    repoPath: '/repo',
    worktreePath: '/repo/.worktrees/POD-1',
    panel: { todos: [], artifacts, deferred: [] },
  }) as unknown as IssueViewModel

const offer = (artifacts: string[]): SessionOffer => ({
  message: 'Ready to merge',
  actions: [],
  artifacts,
  createdAt: '2026-08-27T12:00:00.000Z',
})

describe('OfferArtifactStrip', () => {
  it('opens the named artifact in the in-app viewer, not the task peek', () => {
    const onShowAll = vi.fn()
    render(
      <OfferArtifactStrip
        offer={offer(['shot.png', 'notes.md'])}
        issue={issue([art('shot.png'), art('notes.md')])}
        onShowAll={onShowAll}
      />,
    )

    // Images and files both have a caption on the strip itself.
    expect(screen.getAllByTestId('offer-artifact').length).toBe(2)
    expect(screen.getAllByTestId('offer-artifact-caption').map((el) => el.textContent)).toEqual([
      'shot.png',
      'notes.md',
    ])
    expect(screen.getByTestId('offer-artifacts').textContent).toContain('notes.md')
    // A file preview says what kind of file a tap will open.
    expect(screen.getByTestId('offer-artifacts').textContent).toContain('MD')

    fireEvent.click(screen.getByLabelText('Open notes.md'))
    expect(screen.getByTestId('viewer').textContent).toContain('notes.md')
    expect(screen.getByTestId('viewer').textContent).toContain('/files/asset?')
    expect(onShowAll).not.toHaveBeenCalled()
  })

  it('sends the overflow to the full artifact list', () => {
    const onShowAll = vi.fn()
    const onCardPress = vi.fn()
    const paths = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png']
    render(
      <Pressable onPress={onCardPress}>
        <OfferArtifactStrip
          offer={offer(paths)}
          issue={issue(paths.map((p) => art(p)))}
          onShowAll={onShowAll}
        />
      </Pressable>,
    )

    expect(screen.getAllByTestId('offer-artifact').length).toBe(3)
    expect(screen.getByTestId('offer-artifact-extra').textContent).toBe('+3View all')
    fireEvent.click(screen.getByTestId('offer-artifact-extra'))
    expect(onShowAll).toHaveBeenCalledOnce()
    expect(onCardPress).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('Open a.png'))
    expect(screen.getByTestId('viewer').textContent).toContain('a.png')
    expect(onCardPress).not.toHaveBeenCalled()
  })

  it('uses all four slots when the offered list fits exactly', () => {
    const paths = ['a.png', 'b.html', 'c.md', 'd.mp4']
    render(<OfferArtifactStrip offer={offer(paths)} issue={issue(paths.map((p) => art(p)))} />)

    expect(screen.getAllByTestId('offer-artifact').length).toBe(4)
    expect(screen.queryByTestId('offer-artifact-extra')).toBeNull()
    expect(screen.getAllByTestId('offer-artifact-caption').map((el) => el.textContent)).toEqual(
      paths,
    )
  })

  it('keeps the evidence visible while the offer collects feedback', async () => {
    const { SessionActionCard } = await import('./SessionActionCard')
    render(
      <SessionActionCard
        offer={{
          ...offer(['shot.png', 'concept.html']),
          actions: [{ label: 'Send back', prompt: 'Address this feedback', input: true }],
        }}
        issue={issue([art('shot.png'), art('concept.html')])}
        onAction={async () => {}}
      />,
    )

    expect(screen.getAllByTestId('offer-artifact').length).toBe(2)
    fireEvent.click(screen.getByLabelText('Send back'))
    expect(screen.getAllByTestId('offer-artifact').length).toBe(2)
  })

  it('keeps overflow as an inert tile when no full-list navigation is available', () => {
    const paths = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']
    render(<OfferArtifactStrip offer={offer(paths)} issue={issue(paths.map((p) => art(p)))} />)

    const extra = screen.getByTestId('offer-artifact-extra')
    expect(extra.textContent).toBe('+2More artifacts')
    fireEvent.click(extra)
    expect(screen.queryByTestId('viewer')).toBeNull()
  })

  it('renders nothing at all when no offered path resolves', () => {
    const { container } = render(
      <OfferArtifactStrip offer={offer(['gone.png'])} issue={issue([art('real.png')])} />,
    )
    // Not an empty strip — an empty view would leave a margin under the offer.
    expect(screen.queryByTestId('offer-artifacts')).toBeNull()
    expect(container.firstChild).toBeNull()
  })
})
