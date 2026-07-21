import type { IssuePanelArtifact, IssueWire, SessionMeta, SessionOffer } from '@podium/protocol'
import { FileText, Play } from 'lucide-react'
import { type JSX, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { MediaLightbox } from '@/components/MediaLightbox'
import { artifactKind, artifactUrl, basename } from '@/lib/dock-panel'
import { resolveOfferArtifacts } from './offer-artifacts'

/** How many thumbnails an offer shows before collapsing into a "+N" chip. */
const MAX_THUMBS = 3

/**
 * Offer evidence thumbnails [POD-120]: a modest row of the issue artifacts an
 * offer names (or, when it names none, those published since the user's last
 * input). Rendered inside the chat/native offer bars and the tray card.
 * Clicking an image/video opens the shared media lightbox WITHOUT entering the
 * session; other kinds open the artifact file tab. Clicks never bubble — on
 * the tray card the surrounding card click navigates, and a thumbnail tap must
 * only preview.
 */
export function OfferArtifactStrip({
  offer,
  session,
  className,
}: {
  offer: SessionOffer
  session: SessionMeta
  /** Extra classes on the strip root (spacing differs per host surface). Only
   *  applied when the strip renders — an empty strip must not leave margins. */
  className?: string
}): JSX.Element | null {
  const { issues, httpOrigin, openArtifact, openFileInWorktree } = useStoreSelector((s) => ({
    issues: s.issues,
    httpOrigin: s.httpOrigin,
    openArtifact: s.openArtifact,
    openFileInWorktree: s.openFileInWorktree,
  }))
  const [lightbox, setLightbox] = useState<{
    kind: 'image' | 'video'
    src: string
    label: string
  } | null>(null)

  // The session's issue: direct issueId link first, then membership (sessions
  // grouped onto an issue by cwd carry no issueId of their own).
  const issue: IssueWire | undefined =
    issues.find((i) => i.id === session.issueId) ??
    issues.find((i) => (i.sessions ?? []).some((s) => s.sessionId === session.sessionId))

  const resolved = resolveOfferArtifacts({
    offer,
    issue,
    ...(session.lastInputAt ? { lastInputAt: session.lastInputAt } : {}),
  })
  if (!issue || resolved.length === 0) return null

  const root = issue.worktreePath ?? issue.repoPath
  const machineId = issue.machineId
  const shown = resolved.slice(0, MAX_THUMBS)
  const extra = resolved.length - shown.length

  const open = (a: IssuePanelArtifact): void => {
    const kind = artifactKind(a.entry ?? a.path)
    const label = a.title ?? basename(a.path)
    const src = artifactUrl({
      httpOrigin,
      issueId: issue.id,
      artifact: a,
      ...(root ? { root } : {}),
      ...(machineId ? { machineId } : {}),
    })
    if (src && (kind === 'image' || kind === 'video')) {
      setLightbox({ kind, src, label })
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
        path: a.path.startsWith('/') ? a.path : `${root}/${a.path}`,
      })
    }
  }

  return (
    <div
      data-testid="offer-artifacts"
      className={`flex min-w-0 flex-wrap items-center gap-1.5${className ? ` ${className}` : ''}`}
    >
      {shown.map((a) => {
        const kind = artifactKind(a.entry ?? a.path)
        const label = a.title ?? basename(a.path)
        const src = artifactUrl({
          httpOrigin,
          issueId: issue.id,
          artifact: a,
          ...(root ? { root } : {}),
          ...(machineId ? { machineId } : {}),
        })
        const media = src !== null && (kind === 'image' || kind === 'video')
        return (
          <button
            key={`${a.path}@${a.addedAt}`}
            type="button"
            title={label}
            data-testid="offer-artifact-thumb"
            className={
              media
                ? 'relative flex-none cursor-zoom-in overflow-hidden rounded-md border border-border/70 transition-colors hover:border-primary/60'
                : 'flex max-w-40 flex-none cursor-pointer items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground'
            }
            onClick={(e) => {
              e.stopPropagation()
              open(a)
            }}
          >
            {media && kind === 'image' ? (
              <img
                src={src as string}
                alt={label}
                className="block h-12 w-auto max-w-24 object-cover"
              />
            ) : media ? (
              <>
                <video
                  src={src as string}
                  preload="metadata"
                  muted
                  className="pointer-events-none block h-12 w-auto max-w-24 object-cover"
                />
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex size-5 items-center justify-center rounded-full bg-black/55 text-white">
                    <Play size={10} aria-hidden="true" className="translate-x-px" />
                  </span>
                </span>
              </>
            ) : (
              <>
                <FileText size={12} aria-hidden="true" className="flex-none" />
                <span className="min-w-0 truncate">{label}</span>
              </>
            )}
          </button>
        )
      })}
      {extra > 0 && (
        <span
          data-testid="offer-artifact-extra"
          className="flex-none text-[10px] text-muted-foreground"
        >
          +{extra}
        </span>
      )}
      {lightbox && <MediaLightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
