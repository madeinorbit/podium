import { observer } from '@podium/client-graph/react'
import { action, observableRef } from 'mobx'
import { type JSX, useContext, useEffect } from 'react'
import { usePageIssue } from '@/features/files/artifacts-tab'
import { useTipMoment } from '@/features/tips'
import { TipContext } from '@/features/tips/tip-context'
import { useDockIssue } from './dock-issue'

/**
 * First Flights moment 7 (first-artifact): the first time an agent's issue
 * artifact is on screen, point at it, then at the "+" that opens the
 * Artifacts tab. The tip never opens the panel, a tab or a file.
 *
 * Card 1's anchor is whichever artifact surface is mounted: the offer's
 * thumbnail strip when the artifact came inside an offer (after first-offer
 * has had its turn), otherwise the task panel's first thumbnail. Mounting is
 * what activates the moment, so the anchor is in the DOM before the engine
 * looks for it. With the task panel closed, a brass dot on the rail's Task
 * cell says there is something to see.
 */

export const FIRST_ARTIFACT_THUMB_ANCHOR = 'first-artifact-thumb'
export const FIRST_ARTIFACT_NEW_PANEL_ANCHOR = 'first-artifact-new-panel'
const offerAnchor = (issueId: string): string => `first-artifact-offer:${issueId}`

type Surface = 'panel' | 'offer'

/** Which issues have a card-1 anchor mounted, per surface, with mount counts. */
class ArtifactAnchors {
  @observableRef accessor panel: ReadonlyMap<string, number> = new Map()
  @observableRef accessor offer: ReadonlyMap<string, number> = new Map()
  @action mount(surface: Surface, issueId: string): () => void {
    this.bump(surface, issueId, 1)
    return action(() => this.bump(surface, issueId, -1))
  }
  private bump(surface: Surface, issueId: string, by: number): void {
    const next = new Map(this[surface])
    const count = (next.get(issueId) ?? 0) + by
    if (count > 0) next.set(issueId, count)
    else next.delete(issueId)
    this[surface] = next
  }
}
export const firstArtifactAnchors = new ArtifactAnchors()

/**
 * Report a mounted card-1 surface for `issueId` (undefined: nothing to point
 * at) and return the `data-tip-anchor` value its element carries.
 */
export function useFirstArtifactAnchor(surface: Surface, issueId: string | undefined): string {
  useEffect(
    () => (issueId ? firstArtifactAnchors.mount(surface, issueId) : undefined),
    [surface, issueId],
  )
  return surface === 'panel' || !issueId ? FIRST_ARTIFACT_THUMB_ANCHOR : offerAnchor(issueId)
}

/** The moment's one registration. Mounted with the right rail. */
export const FirstArtifactMoment = observer(function FirstArtifactMoment(): null {
  const log = useContext(TipContext)?.log
  const offerIssue = firstArtifactAnchors.offer.keys().next().value
  // An artifact that arrived inside an offer lets first-offer explain the
  // offer card first; this tip then points at the offer's thumbnails.
  const offerWaits = offerIssue !== undefined && !log?.isSeen('first-offer')
  const active = offerIssue !== undefined ? !offerWaits : firstArtifactAnchors.panel.size > 0
  useTipMoment('first-artifact', {
    active,
    cards: [
      {
        anchor: offerIssue !== undefined ? offerAnchor(offerIssue) : FIRST_ARTIFACT_THUMB_ANCHOR,
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

function IssueArtifactsDot({ issueId }: { issueId: string }): JSX.Element | null {
  const artifacts = usePageIssue(issueId)?.panel?.artifacts ?? []
  if (!artifacts.some((a) => a.chatUploadId === undefined)) return null
  return (
    <span
      data-testid="first-artifact-dot"
      className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
      aria-hidden="true"
    />
  )
}
