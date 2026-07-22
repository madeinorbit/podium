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
