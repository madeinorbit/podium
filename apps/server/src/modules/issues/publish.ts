import type { IssueProjection, IssueWire } from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { IssuePublishSpecs } from './service/types'

/** One publishable issue state change: the wire rows the ledger reconciles
 *  (the durable change append) plus the legacy snapshot message that carries
 *  the same truth. Lived in modules/funnel while the broadcast-seam oplog
 *  consumed it; P2f (#258) moved it here — the issue publisher is its only
 *  producer and the ledger-reconcile tail its only consumer. */
/**
 * What an issue publish IS, since the serving-path cutover (POD-1203): the rows.
 *
 * `snapshot: ServerMessage` was the second half — an `issuesChanged` /
 * `issueUpdated` message built beside the rows and fanned out on its own path.
 * Nothing consumes it now, so it is gone rather than left as a field a future
 * caller could revive: the rows go to the Authority, and a legacy client's
 * `issuesChanged` is folded out of them at the connection boundary.
 *
 * Deliberately UNCHANGED by POD-796, and carries no projection rows. The spec is
 * built by {@link IssuePublisher.issuesChanged}, which IssueService also consumes
 * as its `publishSpecs` factory — and IssueService reconciles the normalized kind
 * from its OWN `allProjections()` in the same tail. Putting the projections in
 * here too would build them twice per publish and give the two call sites two
 * chances to disagree.
 */
export interface PublishSpec {
  rows: { id: string; value: unknown }[]
}

export interface IssuePublisherDeps {
  /** The LOCAL issue list builder (IssueService.allWire) — may be undefined while
   *  the registry constructor hasn't assigned the service yet (broadcasts can run
   *  via loadFromStore before that). */
  allWire(): IssueWire[] | undefined
  /** The LOCAL normalized projection truth (IssueService.allProjections) —
   *  Undefined only when a row cannot be projected or the service is not yet
   *  constructed; normalized emission itself is unconditional.
   *
   *  LOCAL only. POD-309 retired the hub mirror on this branch, so the union
   *  main guarded against here has no second half left to union with. */
  allProjections(): { id: string; value: IssueProjection }[] | undefined
  /** Full-list publish tail ([spec:SP-3fe2] #255): ledger reconcile of the
   *  spec's rows — the durable change append, including removes, which IS the
   *  fan-out since POD-1203. Wired in relay.ts.
   *
   *  `projectionRows` is the POD-796 normalized truth for the same pass.
   *  Undefined leaves the kind alone — only for an unprojectable row or while the
   *  service is not constructed. Passed alongside the spec rather than inside it
   *  — see {@link PublishSpec}. */
  publishIssueList(
    spec: PublishSpec,
    projectionRows?: { id: string; value: IssueProjection }[],
  ): void
}

/** Issue wire publishing: builds the two issue {@link PublishSpec} shapes
 *  (IssueService's mutations run them through the ledger + funnel — issue
 *  #190, #255) and serves the write-less rebroadcast paths (hub-mirror and staleness changes), so every issuesChanged/issueUpdated fan-out records to
 *  the durable change log before clients see anything (oplog-read-path §2.5). */
export class IssuePublisher implements IssuePublishSpecs {
  constructor(private readonly deps: IssuePublisherDeps) {}
  private currentLocalIssues?: IssueWire[]

  /**
   * Build the issue-list payload, degrading to an empty list if the DERIVED build
   * throws (for example, a poison issue row).
   * An issues-layer throw must never abort an attach, a broadcast, or the daemon
   * handler that triggered it. The `?? []` also guards construction-time calls
   * (broadcasts can run before the IssueService is set).
   */
  safeIssuesList(): IssueWire[] {
    try {
      const issues = this.deps.allWire() ?? []
      this.currentLocalIssues = issues
      return issues
    } catch (err) {
      console.warn('[podium] issues payload build failed — broadcasting empty issues list', err)
      return []
    }
  }

  /**
   * {@link safeIssuesList}'s normalized counterpart [POD-796] — `undefined` on
   * ANY failure, which the reconcile tail reads as "don't touch the normalized
   * baseline this pass".
   *
   * Note the degradation differs from safeIssuesList's `?? []` ON PURPOSE, and
   * the difference is not cosmetic: an empty ARRAY handed to `reconcile` is a
   * claim that NO issues exist, which the full-truth diff turns into a remove
   * for every issue in the baseline. `undefined` is the only spelling of "I
   * don't know" that reconcile cannot mistake for "nothing". (The legacy path's
   * `?? []` has exactly that shape and is left alone here — changing it is a
   * behavior change to the registered transitional residue and remains out of scope.)
   */
  safeProjectionRows(): { id: string; value: IssueProjection }[] | undefined {
    try {
      return this.deps.allProjections()
    } catch (err) {
      console.warn('[podium] issue projection build failed — skipping the normalized feed', err)
      return undefined
    }
  }

  /** Last successfully built local wire projection for connection bootstrap. */
  currentIssuesList(): IssueWire[] {
    return this.currentLocalIssues ?? this.safeIssuesList()
  }

  /** Spec for a full issue list (every issuesChanged path). POD-309 removed the
   *  local ∪ hub-mirror union that used to happen here: with federation retired the
   *  local list IS the list, and `currentLocalIssues` is no longer a half of anything. */
  issuesChanged(localIssues: IssueWire[]): PublishSpec {
    const issues = localIssues
    this.currentLocalIssues = localIssues
    return {
      rows: issues.map((i) => ({ id: i.id, value: i })),
    }
  }

  /** Spec for a single-issue delta (issue #22): the ledger commit already
   *  appended the change at the write seam and every client is served from it.
   *  What survives here is the CURRENT-LIST bookkeeping, which the bootstrap read
   *  and the next full-list reconcile both depend on. */
  issueUpdated(issue: IssueWire): PublishSpec {
    if (this.currentLocalIssues) {
      const index = this.currentLocalIssues.findIndex((candidate) => candidate.id === issue.id)
      this.currentLocalIssues =
        index === -1
          ? [...this.currentLocalIssues, issue]
          : this.currentLocalIssues.map((candidate) =>
              candidate.id === issue.id ? issue : candidate,
            )
    }
    return { rows: [{ id: issue.id, value: issue }] }
  }

  /** Reconcile-and-fan-out of a full issue list — for pipelines with no issue
   *  write of their own (session churn re-derives member data, staleness flips).
   *
   *  Under POD-796 the session-churn caller is gone on the new path: a session
   *  change cannot dirty an `IssueProjection`, so SessionLifecycle skips this
   *  entirely once every connected client reads the normalized shape (see
   *  `runSessionsBroadcast`). What still arrives here is the genuinely
   *  issue-shaped write-less churn — staleness flips and hub-mirror sets. */
  publishIssues(localIssues: IssueWire[]): void {
    this.deps.publishIssueList(this.issuesChanged(localIssues), this.safeProjectionRows())
  }
}
