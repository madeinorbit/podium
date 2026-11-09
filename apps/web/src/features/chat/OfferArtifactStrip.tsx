import { useUiValue } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { shallowEqual } from '@podium/client-core/shallow-equal'
import { artifactKind, artifactUrl, basename } from '@podium/client-core/values'
import { resolveMachinePath } from '@podium/model'
import type { IssuePanelArtifact, SessionOffer } from '@podium/model/browser'
import { Code, FileText, Play } from 'lucide-react'
import { type JSX, useCallback, useLayoutEffect, useState } from 'react'
import { useRuntimeSelector } from '@/app/store'
import { ArtifactLightbox, artifactLightboxKey } from '@/components/ArtifactLightbox'
import { openArtifactsTab } from '@/features/files/artifacts-tab'
import { useFirstArtifactAnchor } from '@/features/issues/first-artifact-tip'
import { currentWorkspaceSlug } from '@/lib/workspace-request'
import { resolveOfferArtifacts } from './offer-artifacts'
import { useChatArtifactIssue } from './use-chat-context'

/** The most slots the row spends, the "+N" tile included. Past four the row
 *  stops being evidence and becomes a gallery, which is the Artifacts tab. */
const MAX_TILES = 4

/** What a non-media tile wears under its icon: the file's extension, the one
 *  word that says what clicking it will open. */
function kindLabel(file: string): string {
  const name = basename(file)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE'
}

const isHtml = (file: string): boolean => /\.html?$/i.test(file)

/**
 * How many slots fit the row's width, capped at {@link MAX_TILES}.
 *
 * The tile size is CSS's call (a container query shrinks it on a narrow card),
 * so it is read back from the row's own `--offer-tile-w` rather than repeated
 * here. A row that cannot be measured (jsdom, a parked pane) keeps the cap.
 */
function useTileSlots(row: HTMLElement | null): number {
  const [slots, setSlots] = useState(MAX_TILES)
  useLayoutEffect(() => {
    if (!row) return
    const measure = (): void => {
      const width = row.clientWidth
      const style = getComputedStyle(row)
      const tile = Number.parseFloat(style.getPropertyValue('--offer-tile-w'))
      const gap = Number.parseFloat(style.columnGap) || 0
      if (width <= 0 || !(tile > 0)) return
      setSlots(Math.max(1, Math.min(MAX_TILES, Math.floor((width + gap) / (tile + gap)))))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [row])
  return slots
}

/**
 * OFFER EVIDENCE [POD-120, POD-2111]: the issue artifacts an offer names (or,
 * when it names none, those published since the user's last input), drawn as a
 * row of equal tiles between the offer's text and its actions.
 *
 * Always visible, because the evidence is half of the question: an offer that
 * says "the one thing to judge is the error state" cannot be answered until the
 * error state is on screen. Every tile has one footprint, a preview over a
 * one-line caption, so a screenshot and an HTML concept weigh the same; an
 * artifact with no picture shows its kind in the preview's place.
 *
 * The row never scrolls sideways. It shows as many tiles as its width holds (at
 * most four), and when the list is longer the last slot becomes "+N", which
 * opens the issue's Artifacts tab, where the full list already lives.
 *
 * Clicking an image/video opens the shared media lightbox WITHOUT entering the
 * session, with every offered media artifact navigable, hidden ones included;
 * other kinds open the artifact file tab. Clicks never bubble, so a host that
 * makes its whole surface clickable still gets a preview, not a navigation.
 */
export function OfferArtifactStrip({
  offer,
  session,
}: {
  offer: SessionOffer
  session: Pick<SessionView, 'sessionId' | 'issueId' | 'lastInputAt'>
}): JSX.Element | null {
  const { httpOrigin, openArtifact, openFileInWorktree } = {
    httpOrigin: useRuntimeSelector((s) => s.httpOrigin),
    openArtifact: useUiValue('openArtifact'),
    openFileInWorktree: useUiValue('openFileInWorktree'),
  }
  const issue = useChatArtifactIssue(session)
  const [lightbox, setLightbox] = useState<string | null>(null)
  // Callback ref: the row is measured the moment it lands in the DOM.
  const [row, setRow] = useState<HTMLDivElement | null>(null)
  const slots = useTileSlots(row)

  // The session's issue: direct issueId link first, then membership (sessions
  // grouped onto an issue by cwd carry no issueId of their own).
  const resolved = resolveOfferArtifacts({
    offer,
    issue,
    ...(session.lastInputAt ? { lastInputAt: session.lastInputAt } : {}),
  })
  const { ref: tipRef, ...tipAnchor } = useFirstArtifactAnchor(
    'offer',
    issue && resolved.length > 0 ? issue.id : undefined,
  )
  // One element is both the measured row and the tip's anchor.
  const stripRef = useCallback(
    (element: HTMLDivElement | null) => {
      setRow(element)
      tipRef(element)
    },
    [tipRef],
  )
  if (!issue || resolved.length === 0) return null

  const root = issue.worktreePath ?? issue.repoPath
  const machineId = issue.machineId
  const shown = resolved.length <= slots ? resolved : resolved.slice(0, slots - 1)
  const extra = resolved.length - shown.length

  const srcOf = (a: IssuePanelArtifact): string | null =>
    artifactUrl({
      httpOrigin,
      workspace: currentWorkspaceSlug(),
      issueId: issue.id,
      artifact: a,
      ...(root ? { root } : {}),
      ...(machineId ? { machineId } : {}),
    })

  const open = (a: IssuePanelArtifact): void => {
    const kind = artifactKind(a.entry ?? a.path)
    if (srcOf(a) && (kind === 'image' || kind === 'video')) {
      setLightbox(artifactLightboxKey(a))
      return
    }
    // Non-media: same routing as the issue panel's artifact list — snapshotted
    // entries open their stored bytes, legacy path-only entries the live file.
    if (a.artifactId) {
      openArtifact({
        issueId: issue.id,
        artifactId: a.artifactId,
        path: a.entry ?? basename(a.path),
        ...(root ? { worktreePath: root } : {}),
      })
    } else if (root) {
      openFileInWorktree({
        ...(machineId ? { machineId } : {}),
        root,
        path: resolveMachinePath(root, a.path),
        issueId: issue.id,
      })
    }
  }

  return (
    <>
      <div ref={stripRef} data-testid="offer-artifacts" {...tipAnchor} className="offer-evidence">
        {shown.map((a) => {
          const file = a.entry ?? a.path
          const kind = artifactKind(file)
          const label = a.title ?? basename(a.path)
          const src = srcOf(a)
          const media = src !== null && (kind === 'image' || kind === 'video')
          return (
            <button
              data-pressable
              key={`${a.path}@${a.addedAt}`}
              type="button"
              title={label}
              data-testid="offer-artifact-thumb"
              className={
                media ? 'offer-evidence-tile offer-evidence-tile--media' : 'offer-evidence-tile'
              }
              onClick={(e) => {
                e.stopPropagation()
                open(a)
              }}
            >
              <span className="offer-evidence-preview">
                {media && kind === 'image' ? (
                  // alt="": the caption under it already names the button.
                  <img src={src as string} alt="" />
                ) : media ? (
                  <>
                    <video src={src as string} preload="metadata" muted />
                    <span className="offer-evidence-play">
                      <span>
                        <Play size={10} aria-hidden="true" className="translate-x-px" />
                      </span>
                    </span>
                  </>
                ) : (
                  <span data-testid="offer-artifact-kind" className="offer-evidence-kind">
                    {isHtml(file) ? (
                      <Code size={20} strokeWidth={1.6} aria-hidden="true" />
                    ) : (
                      <FileText size={20} strokeWidth={1.6} aria-hidden="true" />
                    )}
                    <span className="offer-evidence-kind-label">{kindLabel(file)}</span>
                  </span>
                )}
              </span>
              <span className="offer-evidence-caption">{label}</span>
            </button>
          )
        })}
        {extra > 0 && (
          <button
            data-pressable
            type="button"
            data-testid="offer-artifact-extra"
            title={`All ${resolved.length} artifacts`}
            className="offer-evidence-tile"
            onClick={(e) => {
              e.stopPropagation()
              openArtifactsTab(openArtifact, { issueId: issue.id, worktreePath: root })
            }}
          >
            <span className="offer-evidence-preview offer-evidence-more">+{extra}</span>
            <span className="offer-evidence-caption">View all</span>
          </button>
        )}
      </div>
      {lightbox && (
        <ArtifactLightbox
          artifacts={resolved}
          selected={lightbox}
          onSelect={setLightbox}
          onClose={() => setLightbox(null)}
          httpOrigin={httpOrigin}
          issueId={issue.id}
          root={root}
          machineId={machineId}
        />
      )}
    </>
  )
}
