import { observer } from '@podium/client-graph/react'
import { action, observableRef } from 'mobx'
import { type JSX, useContext, useEffect, useState } from 'react'
import { usePageIssue } from '@/features/files/artifacts-tab'
import { useTipAnchorVisible, useTipMoment, useTipUnseen } from '@/features/tips'
import { TipContext } from '@/features/tips/tip-context'
import { useDockIssue } from './dock-issue'

/**
 * First Flights moment 7 (first-artifact): the first time an agent's issue
 * artifact is on screen, point at it, then at the "+" that opens the
 * Artifacts tab. The tip never opens the panel, a tab or a file.
 *
 * Card 1's anchor is an artifact surface that is fully on screen: the offer's
 * thumbnail strip when the artifact came inside an offer (after first-offer
 * has had its turn), otherwise the task panel's first thumbnail. A surface
 * counts only while it is visible, so a background task's offer or a hidden
 * chat pane never stands in for the one on screen, and a thumbnail scrolled
 * into view later activates the moment then. With the task panel closed, a
 * brass dot on the rail's Task cell says there is something to see.
 */

export const FIRST_ARTIFACT_THUMB_ANCHOR = 'first-artifact-thumb'
export const FIRST_ARTIFACT_NEW_PANEL_ANCHOR = 'first-artifact-new-panel'
const offerAnchor = (issueId: string): string => `first-artifact-offer:${issueId}`

type Surface = 'panel' | 'offer'
interface VisibleSurface {
  surface: Surface
  issueId: string
}

/** The card-1 surfaces currently fully on screen, in the order they appeared,
 *  plus the offer strips that are merely mounted. Mounted offers cost nothing
 *  to track and let a guide replay name the offer anchor after the moment is
 *  seen, when visibility is no longer watched. */
class ArtifactAnchors {
  @observableRef accessor visible: readonly VisibleSurface[] = []
  @observableRef accessor mountedOffers: readonly string[] = []
  @action show(surface: Surface, issueId: string): () => void {
    const entry: VisibleSurface = { surface, issueId }
    this.visible = [...this.visible, entry]
    return action(() => {
      this.visible = this.visible.filter((v) => v !== entry)
    })
  }
  @action mountOffer(issueId: string): () => void {
    this.mountedOffers = [...this.mountedOffers, issueId]
    return action(() => {
      const at = this.mountedOffers.indexOf(issueId)
      if (at >= 0) this.mountedOffers = this.mountedOffers.filter((_, i) => i !== at)
    })
  }
}
export const firstArtifactAnchors = new ArtifactAnchors()

/** Props for a card-1 surface's element: its anchor name and the ref that
 *  watches whether it is fully on screen. */
export interface FirstArtifactAnchorProps {
  'data-tip-anchor': string
  ref: (element: HTMLElement | null) => void
}

/**
 * Report a card-1 surface for `issueId` (undefined: nothing to point at).
 * Spread the result on the element the tip should point at. The surface
 * counts only while that element is fully visible, and is watched only while
 * the moment is unseen; the anchor name stays for guide replay.
 */
export function useFirstArtifactAnchor(
  surface: Surface,
  issueId: string | undefined,
): FirstArtifactAnchorProps {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const unseen = useTipUnseen('first-artifact')
  const visible = useTipAnchorVisible(unseen && issueId ? element : null)
  useEffect(
    () => (visible && issueId ? firstArtifactAnchors.show(surface, issueId) : undefined),
    [visible, surface, issueId],
  )
  useEffect(
    () => (surface === 'offer' && issueId ? firstArtifactAnchors.mountOffer(issueId) : undefined),
    [surface, issueId],
  )
  return {
    'data-tip-anchor':
      surface === 'panel' || !issueId ? FIRST_ARTIFACT_THUMB_ANCHOR : offerAnchor(issueId),
    ref: setElement,
  }
}

/** The moment's one registration. Mounted with the right rail. */
export const FirstArtifactMoment = observer(function FirstArtifactMoment(): null {
  const log = useContext(TipContext)?.log
  const { issueId: dockIssueId } = useDockIssue()
  const visible = firstArtifactAnchors.visible
  const offers = visible.filter((v) => v.surface === 'offer')
  // Prefer the visible offer of the task the dock is explaining.
  const offer = offers.find((v) => v.issueId === dockIssueId) ?? offers[0]
  // An artifact that arrived inside a visible offer lets first-offer explain
  // the offer card first; this tip then points at the offer's thumbnails.
  const offerWaits = offer !== undefined && !log?.isSeen('first-offer')
  const active = offer !== undefined ? !offerWaits : visible.length > 0
  // Once seen, nothing is watched for visibility; a replay points at the dock
  // task's mounted offer strip when there is one, else the panel thumbnail.
  const mounted = firstArtifactAnchors.mountedOffers
  const replayOffer = log?.isSeen('first-artifact')
    ? (mounted.find((id) => id === dockIssueId) ?? mounted[0])
    : undefined
  const offerId = offer?.issueId ?? replayOffer
  useTipMoment('first-artifact', {
    active,
    cards: [
      {
        anchor: offerId !== undefined ? offerAnchor(offerId) : FIRST_ARTIFACT_THUMB_ANCHOR,
        title: 'Your agent made something.',
        body: 'Mockups, screenshots and docs land here. Click one to open it.',
      },
      {
        anchor: FIRST_ARTIFACT_NEW_PANEL_ANCHOR,
        title: 'All in one tab.',
        body: 'Open Artifacts from + to see everything this task made.',
      },
    ],
  })
  return null
})

/** The brass dot on the rail's Task cell while the panel is closed. Reads the
 *  task's artifacts only while the moment is still unseen. */
export const FirstArtifactDot = observer(function FirstArtifactDot(): JSX.Element | null {
  const log = useContext(TipContext)?.log
  if (!log?.ready || !log.enabled || log.isSeen('first-artifact')) return null
  return <DockArtifactsDot />
})

const DockArtifactsDot = observer(function DockArtifactsDot(): JSX.Element | null {
  const { issueId } = useDockIssue()
  return issueId ? <IssueArtifactsDot issueId={issueId} /> : null
})

// An observer: the pooled issue keeps its identity when an artifact is
// published, so only the observed read of its panel sees the new one.
const IssueArtifactsDot = observer(function IssueArtifactsDot({
  issueId,
}: {
  issueId: string
}): JSX.Element | null {
  const artifacts = usePageIssue(issueId)?.panel?.artifacts ?? []
  if (!artifacts.some((a) => a.chatUploadId === undefined)) return null
  return (
    <span
      data-testid="first-artifact-dot"
      className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
      aria-hidden="true"
    />
  )
})
