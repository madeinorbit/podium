import type { IssuePanelArtifact, IssueWire, SessionOffer } from '@podium/model'
import {
  type IssueArtifactPreview,
  issueArtifactHref,
  issueArtifactLabel,
  issueArtifactPreview,
} from './issue-artifacts'

/**
 * Offer→artifact resolution [POD-120]: which of the issue's published artifacts
 * an offer should show as evidence thumbnails.
 *
 * Agent-curated first: when the offer names paths (`podium offer --artifact`),
 * each is resolved against the issue panel's artifact list in offer order —
 * where the same path was re-added across iterations, the NEWEST entry (by
 * addedAt, then list position) wins. Unresolved paths are silently dropped.
 *
 * Freshness fallback: an offer that names none shows the issue's artifacts
 * added since the session's last human input (the agent published them during
 * the turn that produced the offer), newest first, capped at 3.
 */
export function resolveOfferArtifacts(args: {
  offer: SessionOffer
  issue: IssueWire | undefined
  /** ISO time of the session's last human input (SessionMeta.lastInputAt). */
  lastInputAt?: string
}): IssuePanelArtifact[] {
  const published = args.issue?.panel?.artifacts ?? []
  if (published.length === 0) return []

  const curated = args.offer.artifacts ?? []
  if (curated.length > 0) {
    const out: IssuePanelArtifact[] = []
    for (const path of curated) {
      const match = newestMatch(published, path)
      // Same artifact named twice (or two paths resolving to one entry) shows once.
      if (match && !out.includes(match)) out.push(match)
    }
    return out
  }

  // Fallback needs a "since" anchor; a session the human never typed into has
  // no baseline to call an artifact "new" against.
  if (!args.lastInputAt) return []
  const since = args.lastInputAt
  return published
    .filter((a) => a.addedAt > since)
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .slice(0, 3)
}

/**
 * How many artifacts the offer strip shows before the rest collapse into a
 * "+N" chip — the desktop's cap [POD-120], and about what a 390pt column holds
 * at one 72pt thumbnail plus a named chip.
 */
export const OFFER_STRIP_MAX = 3

/** One tappable thing in the offer strip: what to draw, and what to open. */
export type OfferArtifactRow = {
  /** Stable across re-adds of the same path — `path@addedAt`, as the desktop keys. */
  key: string
  artifact: IssuePanelArtifact
  label: string
  preview: IssueArtifactPreview
  /** The mono tag a non-image chip wears — the file's extension, else its kind. */
  kind: string
  /** Absent when the artifact lives on a machine this phone cannot reach; such
   *  a row is still counted and drawn, but inert rather than a tap that fails. */
  url: string | null
}

/**
 * The offer strip's rows — {@link resolveOfferArtifacts} plus everything the
 * view needs to draw and open each one, so the mapping is testable without a
 * renderer, a store, or a server profile.
 *
 * Order and dedupe are the resolver's (offer order, newest entry per path);
 * this only caps the list and reports the remainder as `extra`.
 */
export function offerArtifactRows(args: {
  offer: SessionOffer
  issue: IssueWire | undefined
  /** ISO time of the session's last human input (SessionMeta.lastInputAt). */
  lastInputAt?: string
  httpOrigin: string
  max?: number
}): { rows: OfferArtifactRow[]; extra: number } {
  const resolved = resolveOfferArtifacts({
    offer: args.offer,
    issue: args.issue,
    ...(args.lastInputAt ? { lastInputAt: args.lastInputAt } : {}),
  })
  const issue = args.issue
  if (!issue || resolved.length === 0) return { rows: [], extra: 0 }

  const max = args.max ?? OFFER_STRIP_MAX
  const shown = resolved.slice(0, max)
  return {
    rows: shown.map((artifact) => {
      const path = artifact.entry ?? artifact.path
      const preview = issueArtifactPreview(path)
      return {
        key: `${artifact.path}@${artifact.addedAt}`,
        artifact,
        label: issueArtifactLabel(artifact),
        preview,
        kind: kindTag(path, preview),
        url: issueArtifactHref(issue, artifact, args.httpOrigin),
      }
    }),
    extra: resolved.length - shown.length,
  }
}

/** `notes/plan.md` → `MD`; an extensionless file falls back to its preview
 *  class, so the chip always says what kind of thing it is opening. */
function kindTag(path: string, preview: IssueArtifactPreview): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  return (ext || preview).toUpperCase()
}

/** The newest panel entry matching an offered path — exact match, or an
 *  absolute↔worktree-relative pair (one a `/`-boundary suffix of the other). */
function newestMatch(
  published: IssuePanelArtifact[],
  path: string,
): IssuePanelArtifact | undefined {
  let best: IssuePanelArtifact | undefined
  for (const a of published) {
    if (!pathsRefer(a.path, path)) continue
    // Later entries win ties: re-adding an artifact appends, so list position
    // is the secondary recency signal.
    if (!best || a.addedAt >= best.addedAt) best = a
  }
  return best
}

function pathsRefer(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}
