import type { IssuePanelArtifact, IssueWire, SessionOffer } from '@podium/protocol'

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
 * the turn that produced the offer). A fresh interactive HTML artifact leads
 * the review set, followed by the newest remaining artifacts, capped at 3.
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
  const fresh = published
    .filter((a) => a.addedAt > since)
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  const interactiveIndex = fresh.findIndex(isInteractiveReviewArtifact)
  if (interactiveIndex > 0) {
    const [interactive] = fresh.splice(interactiveIndex, 1)
    if (interactive) fresh.unshift(interactive)
  }
  return fresh.slice(0, 3)
}

/** HTML concepts can carry the whole interaction while screenshots are only
 * frames from it. Prefer one in the automatic fallback; explicit offer paths
 * above remain authoritative and retain their authored order. */
function isInteractiveReviewArtifact(artifact: IssuePanelArtifact): boolean {
  const path = artifact.entry ?? artifact.path
  return /\.html?$/i.test(path)
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
