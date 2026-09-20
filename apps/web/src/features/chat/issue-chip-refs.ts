import type { IssueReferenceSource } from '@podium/client-core/viewmodels'
import {
  type IssueReferenceLookup,
  issueReferenceLookup,
  issueReferenceSignature,
} from '@/lib/issue-chip-liveness'

/**
 * The exact issue fields {@link issueReferenceSignature} can see, read raw.
 *
 * `issueKey` is a pure function of `prefix`/`seq`/`displayRef` (with a prefix
 * it keys `prefix-seq`, without one it keys the parsed `displayRef ?? #seq`),
 * and the signature additionally reads `displayRef`, `stage`, `archived`,
 * `deletedAt` and `title`. For a replaced array, comparing these seven fields
 * is exactly as sensitive as recomputing the signature string — any change
 * the string could see flips a field first — without joining ~4,900 rows
 * into a string or projecting every row through `issueReferenceModel` on
 * every render. A same-identity array reuses the cache unscanned, on the
 * replica's immutable-snapshot contract (the same assumption the
 * host-session-aggregates and repository-usage selectors make).
 */
interface IssueChipMaterial {
  readonly prefix: string | undefined
  readonly seq: number
  readonly displayRef: string | undefined
  readonly stage: IssueChipMaterialStage
  readonly archived: boolean | undefined
  readonly deletedAt: string | undefined
  readonly title: string
}

type IssueChipMaterialStage = IssueReferenceSource['stage']

export interface IssueChipRefsSelection {
  readonly signature: string
  readonly refs: IssueReferenceLookup
}

export interface IssueChipRefsStats {
  signatureBuilds: number
  lookupBuilds: number
  materialScans: number
}

/**
 * One mounted consumer's latest issue snapshot, never a shared or bounded
 * cache. Same-array renders return the cached selection without scanning.
 * A replaced array compares only the fields the chips read; an immaterial
 * publication (session traffic rebuilds the replica array every few seconds)
 * reuses the cached signature and lookup with no string or model work.
 *
 * Deliberately NOT a bounded per-key cache: a previous fix on this epic
 * cached 128 entries against a ~4,900-row corpus, so a full pass evicted its
 * own entries and the second pass was slower than the first. A single
 * snapshot has nothing to evict, so a second identical pass provably does no
 * signature or lookup work (see the corpus-scale test beside this file).
 *
 * Deliberately the whole array, not the per-transcript subset of refs in the
 * DOM: membership would need a DOM scan on every render (reintroducing the
 * per-render cost this removes), a second invalidation dimension when the
 * transcript edits, and a stale-unavailable window for a newly inserted
 * anchor naming an issue outside the subset. Rebuilds now happen only on a
 * material issue change, so the full build is rare.
 */
export function createIssueChipRefsSelector(): {
  select: (issues: readonly IssueReferenceSource[]) => IssueChipRefsSelection
  stats: IssueChipRefsStats
} {
  let source: readonly IssueReferenceSource[] | undefined
  let material: IssueChipMaterial[] = []
  let cached: IssueChipRefsSelection | undefined
  const stats: IssueChipRefsStats = { signatureBuilds: 0, lookupBuilds: 0, materialScans: 0 }

  const select = (issues: readonly IssueReferenceSource[]): IssueChipRefsSelection => {
    if (issues === source && cached !== undefined) return cached
    stats.materialScans += 1
    const next: IssueChipMaterial[] = []
    let changed = source === undefined || issues.length !== material.length
    for (const issue of issues) {
      const previous = material[next.length]
      if (
        previous !== undefined &&
        previous.prefix === issue.prefix &&
        previous.seq === issue.seq &&
        previous.displayRef === issue.displayRef &&
        previous.stage === issue.stage &&
        previous.archived === issue.archived &&
        previous.deletedAt === issue.deletedAt &&
        previous.title === issue.title
      ) {
        next.push(previous)
      } else {
        changed = true
        next.push({
          prefix: issue.prefix,
          seq: issue.seq,
          displayRef: issue.displayRef,
          stage: issue.stage,
          archived: issue.archived,
          deletedAt: issue.deletedAt,
          title: issue.title,
        })
      }
    }
    source = issues
    if (!changed && cached !== undefined) return cached
    material = next
    stats.signatureBuilds += 1
    const signature = issueReferenceSignature(issues)
    stats.lookupBuilds += 1
    const refs = issueReferenceLookup(issues)
    cached = { signature, refs }
    return cached
  }

  return { select, stats }
}
