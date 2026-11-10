import type { IssueViewModel } from '@podium/client-core/replica'
import { resolveOfferArtifacts } from '@podium/client-core/values'
import type { IssuePanelArtifact, SessionOffer } from '@podium/model'
import { machinePathBasename } from '@podium/model'
import {
  type IssueArtifactPreview,
  issueArtifactHref,
  issueArtifactLabel,
  issueArtifactPreview,
} from './issue-artifacts'

export { resolveOfferArtifacts } from '@podium/client-core/values'

/**
 * Maximum tile slots in the offer strip, including the +N tile, matching web.
 */
export const OFFER_STRIP_MAX = 4

/** One tappable thing in the offer strip: what to draw, and what to open. */
export type OfferArtifactRow = {
  /** Stable across re-adds of the same path — `path@addedAt`, as the desktop keys. */
  key: string
  artifact: IssuePanelArtifact
  label: string
  preview: IssueArtifactPreview
  /** The preview's kind label: the file's extension, else its kind. */
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
 * The last slot becomes +N when the resolved list exceeds the available slots.
 */
export function offerArtifactRows(args: {
  offer: SessionOffer
  issue: IssueViewModel | undefined
  /** ISO time of the session's last human input (SessionMeta.lastInputAt). */
  lastInputAt?: string
  httpOrigin: string
  /** Selected hosted workspace id or route slug for browser-visible URLs. */
  workspace?: string
  /** Available tile slots, including the overflow tile. */
  max?: number
}): { rows: OfferArtifactRow[]; extra: number; allRows: OfferArtifactRow[] } {
  const resolved = resolveOfferArtifacts({
    offer: args.offer,
    issue: args.issue,
    ...(args.lastInputAt ? { lastInputAt: args.lastInputAt } : {}),
  })
  const issue = args.issue
  if (!issue || resolved.length === 0) return { rows: [], extra: 0, allRows: [] }

  const max = Math.max(1, Math.min(OFFER_STRIP_MAX, args.max ?? OFFER_STRIP_MAX))
  const allRows = resolved.map((artifact) => {
    const path = artifact.entry ?? artifact.path
    const preview = issueArtifactPreview(path)
    return {
      key: `${artifact.path}@${artifact.addedAt}`,
      artifact,
      label: issueArtifactLabel(artifact),
      preview,
      kind: kindTag(path, preview),
      url: issueArtifactHref(issue, artifact, args.httpOrigin, args.workspace),
    }
  })
  const rows = allRows.length <= max ? allRows : allRows.slice(0, max - 1)
  return { rows, allRows, extra: allRows.length - rows.length }
}

/** `notes/plan.md` → `MD`; an extensionless file falls back to its preview
 *  class, so the tile always says what kind of thing it is opening. */
function kindTag(path: string, preview: IssueArtifactPreview): string {
  const base = machinePathBasename(path)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  return (ext || preview).toUpperCase()
}
