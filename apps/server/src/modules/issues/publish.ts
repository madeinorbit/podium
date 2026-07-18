import type { IssueWire, ServerMessage, SessionMeta } from '@podium/protocol'
import type { IssuePublishSpecs } from './service/types'

/** One publishable issue state change: the wire rows the ledger reconciles
 *  (the durable change append) plus the legacy snapshot message that carries
 *  the same truth. Lived in modules/funnel while the broadcast-seam oplog
 *  consumed it; P2f (#258) moved it here — the issue publisher is its only
 *  producer and the ledger-reconcile tail its only consumer. */
export interface PublishSpec {
  rows: { id: string; value: unknown }[]
  snapshot: ServerMessage
}

export interface IssuePublisherDeps {
  /** The LOCAL issue list builder (IssueService.allWire) — may be undefined while
   *  the registry constructor hasn't assigned the service yet (broadcasts can run
   *  via loadFromStore before that). */
  allWire(sessionList?: SessionMeta[]): IssueWire[] | undefined
  /** Local ∪ upstream union (modules/issues/upstream). */
  withUpstreamIssues(local: IssueWire[]): IssueWire[]
  /** Full-list publish tail ([spec:SP-3fe2] #255): ledger reconcile of the
   *  spec's rows (the durable change append, including removes) → funnel
   *  fan-out of the snapshot. Wired in relay.ts. */
  publishIssueList(spec: PublishSpec): void
}

/** Issue wire publishing: builds the two issue {@link PublishSpec} shapes
 *  (IssueService's mutations run them through the ledger + funnel — issue
 *  #190, #255) and serves the write-less rebroadcast paths (session churn,
 *  staleness flips), so every issuesChanged/issueUpdated fan-out records to
 *  the durable change log before clients see anything (oplog-read-path §2.5). */
export class IssuePublisher implements IssuePublishSpecs {
  constructor(private readonly deps: IssuePublisherDeps) {}
  private currentLocalIssues?: IssueWire[]

  /**
   * Build the issue-list payload, degrading to an empty list if the DERIVED build
   * throws (e.g. a poison issue row whose member sessions fail to serialize).
   * An issues-layer throw must never abort an attach, a broadcast, or the daemon
   * handler that triggered it. The `?? []` also guards construction-time calls
   * (broadcasts can run before the IssueService is set).
   */
  safeIssuesList(sessionList?: SessionMeta[]): IssueWire[] {
    try {
      const issues = this.deps.allWire(sessionList) ?? []
      this.currentLocalIssues = issues
      return issues
    } catch (err) {
      console.warn('[podium] issues payload build failed — broadcasting empty issues list', err)
      return []
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
   *  write of their own (session churn re-derives member data, staleness flips). */
  publishIssues(localIssues: IssueWire[]): void {
    this.deps.publishIssueList(this.issuesChanged(localIssues))
  }
}
