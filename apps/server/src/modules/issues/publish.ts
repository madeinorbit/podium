import type { IssueWire } from '@podium/protocol'
import type { PublishSpec } from '../funnel'
import type { IssuePublishSpecs } from './service/types'

export interface IssuePublisherDeps {
  /** The LOCAL issue list builder (IssueService.allWire) — may be undefined while
   *  the registry constructor hasn't assigned the service yet (broadcasts can run
   *  via loadFromStore before that). */
  allWire(): IssueWire[] | undefined
  /** Local ∪ upstream union (modules/issues/upstream). */
  withUpstreamIssues(local: IssueWire[]): IssueWire[]
  /** The write funnel's publish tail: oplog append → broadcast (bus + WS). */
  publishSpec(spec: PublishSpec): void
}

/** Issue wire publishing: builds the two issue {@link PublishSpec} shapes
 *  (IssueService's mutations run them through the funnel — issue #190) and
 *  serves the write-less rebroadcast paths (session churn, staleness flips),
 *  so every issuesChanged/issueUpdated fan-out enters the write funnel and the
 *  oplog records before clients see anything (oplog-read-path §2.5). */
export class IssuePublisher implements IssuePublishSpecs {
  constructor(private readonly deps: IssuePublisherDeps) {}

  /**
   * Build the issue-list payload, degrading to an empty list if the DERIVED build
   * throws (e.g. a poison issue row whose member sessions fail to serialize).
   * An issues-layer throw must never abort an attach, a broadcast, or the daemon
   * handler that triggered it. The `?? []` also guards construction-time calls
   * (broadcasts can run before the IssueService is set).
   */
  safeIssuesList(): IssueWire[] {
    try {
      return this.deps.allWire() ?? []
    } catch (err) {
      console.warn('[podium] issues payload build failed — broadcasting empty issues list', err)
      return []
    }
  }

  /** Spec for a full issue list (every issuesChanged path). Takes the LOCAL
   *  list; the hub-mirrored issues are unioned in HERE, so every caller
   *  (IssueService mutations, session rebroadcast, staleness flips) serves
   *  local ∪ upstream without knowing about the mirror (node-hub-issues §2.1). */
  issuesChanged(localIssues: IssueWire[]): PublishSpec {
    const issues = this.deps.withUpstreamIssues(localIssues)
    return {
      entity: 'issue',
      rows: issues.map((i) => ({ id: i.id, value: i })),
      snapshot: { type: 'issuesChanged', issues },
    }
  }

  /** Spec for a single-issue delta (issue #22): one PARTIAL oplog record (an
   *  upsert for this id only — absence of the other issues must not read as
   *  deletion). Delta-cap clients get the one-change metadataDelta; legacy
   *  clients get the issueUpdated message they already merge by id. */
  issueUpdated(issue: IssueWire): PublishSpec {
    return {
      entity: 'issue',
      rows: [{ id: issue.id, value: issue }],
      snapshot: { type: 'issueUpdated', issue },
      partial: true,
    }
  }

  /** Funnel-tail fan-out of a full issue list — for pipelines with no issue
   *  write of their own (session churn re-derives member data, staleness flips). */
  publishIssues(localIssues: IssueWire[]): void {
    this.deps.publishSpec(this.issuesChanged(localIssues))
  }
}
