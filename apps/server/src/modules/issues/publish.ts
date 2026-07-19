import type { IssueProjection } from '@podium/model'
import type { IssueWire, ServerMessage } from '@podium/protocol'
import type { IssuePublishSpecs } from './service/types'

/** One publishable issue state change: the wire rows the ledger reconciles
 *  (the durable change append) plus the legacy snapshot message that carries
 *  the same truth. Lived in modules/funnel while the broadcast-seam oplog
 *  consumed it; P2f (#258) moved it here — the issue publisher is its only
 *  producer and the ledger-reconcile tail its only consumer.
 *
 *  Deliberately UNCHANGED by POD-796, and carries no projection rows. The spec
 *  is built by {@link IssuePublisher.issuesChanged}, which IssueService also
 *  consumes as its `publishSpecs` factory — and IssueService reconciles the
 *  normalized kind from its OWN `allProjections()` in the same tail. Putting the
 *  projections in here too would build them twice per publish and give the two
 *  call sites two chances to disagree. */
export interface PublishSpec {
  rows: { id: string; value: unknown }[]
  snapshot: ServerMessage
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
   *  LOCAL only, and deliberately NOT unioned with the hub mirror the way
   *  {@link withUpstreamIssues} unions the legacy list. Mirrored issues arrive
   *  from the hub as `IssueWire` with no local durable row, so there is no
   *  `Issue` aggregate to project — and projecting the mirror's WIRE would mean
   *  a second `IssueWire → IssueProjection` mapper, which is the drift ADR 4
   *  D3.4 forbids. Normalizing the mirror is the hub's job (it emits the
   *  projection itself) and is a follow-up; see the POD-796 report. */
  allProjections(): { id: string; value: IssueProjection }[] | undefined
  /** Local ∪ upstream union (modules/issues/upstream). */
  withUpstreamIssues(local: IssueWire[]): IssueWire[]
  /** Full-list publish tail ([spec:SP-3fe2] #255): ledger reconcile of the
   *  spec's rows (the durable change append, including removes) → funnel
   *  fan-out of the snapshot. Wired in relay.ts.
   *
   *  `projectionRows` is the POD-796 normalized truth for the same pass, or
   *  Undefined leaves the kind alone only for an unprojectable row or while the
   *  service is not constructed. Passed alongside the spec rather than inside it — see
   *  {@link PublishSpec}. */
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

  /** Spec for a full issue list (every issuesChanged path). Takes the LOCAL
   *  list; the hub-mirrored issues are unioned in HERE, so every caller
   *  (IssueService mutations, session rebroadcast, staleness flips) serves
   *  local ∪ upstream without knowing about the mirror (node-hub-issues §2.1). */
  issuesChanged(localIssues: IssueWire[]): PublishSpec {
    const issues = this.deps.withUpstreamIssues(localIssues)
    this.currentLocalIssues = localIssues
    return {
      rows: issues.map((i) => ({ id: i.id, value: i })),
      snapshot: { type: 'issuesChanged', issues },
    }
  }

  /** Spec for a single-issue delta (issue #22): the ledger commit already
   *  appended the change at the write seam; delta-cap clients get it via the
   *  ordered onAppended pipe, legacy clients get the issueUpdated message
   *  they already merge by id. */
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
    return {
      rows: [{ id: issue.id, value: issue }],
      snapshot: { type: 'issueUpdated', issue },
    }
  }

  /** Reconcile-and-fan-out of a full issue list — for pipelines with no issue
   *  write of their own (session churn re-derives member data, staleness flips).
   *
   *  Under POD-796 the session-churn caller is gone on the new path: a session
   *  change cannot dirty an `IssueProjection`, so SessionsService skips this
   *  entirely once every connected client reads the normalized shape (see
   *  `runSessionsBroadcast`). What still arrives here is the genuinely
   *  issue-shaped write-less churn — staleness flips and hub-mirror sets. */
  publishIssues(localIssues: IssueWire[]): void {
    this.deps.publishIssueList(this.issuesChanged(localIssues), this.safeProjectionRows())
  }
}
