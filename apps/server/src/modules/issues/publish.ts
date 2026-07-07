import type { IssueWire, ServerMessage } from '@podium/protocol'

export interface IssuePublisherDeps {
  /** The LOCAL issue list builder (IssueService.allWire) — may be undefined while
   *  the registry constructor hasn't assigned the service yet (broadcasts can run
   *  via loadFromStore before that). */
  allWire(): IssueWire[] | undefined
  /** Local ∪ upstream union (modules/issues/upstream). */
  withUpstreamIssues(local: IssueWire[]): IssueWire[]
  /** The write funnel's issue face: oplog append → broadcast (bus + WS). */
  publish(
    rows: { id: string; value: IssueWire }[],
    snapshot: ServerMessage,
    opts?: { partial?: boolean },
  ): void
}

/** Issue wire publishing: every issuesChanged/issueUpdated fan-out enters the
 *  write funnel here, so the oplog records before clients see anything
 *  (oplog-read-path §2.5). */
export class IssuePublisher {
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

  /** Funnel entry for a full issue list (every issuesChanged path). Takes the
   *  LOCAL list; the hub-mirrored issues are unioned in HERE, so every caller
   *  (IssueService broadcast, session rebroadcast, staleness flips) serves
   *  local ∪ upstream without knowing about the mirror (node-hub-issues §2.1). */
  publishIssues(localIssues: IssueWire[]): void {
    const issues = this.deps.withUpstreamIssues(localIssues)
    this.deps.publish(
      issues.map((i) => ({ id: i.id, value: i })),
      { type: 'issuesChanged', issues },
    )
  }

  /** Single-issue funnel entry (issue #22): one PARTIAL oplog record (an upsert
   *  for this id only — absence of the other issues must not read as deletion).
   *  Delta-cap clients get the one-change metadataDelta; legacy clients get the
   *  issueUpdated message they already merge by id. The full issuesChanged path
   *  (publishIssues) remains for bulk/membership changes. */
  publishIssueUpdate(issue: IssueWire): void {
    this.deps.publish(
      [{ id: issue.id, value: issue }],
      { type: 'issueUpdated', issue },
      {
        partial: true,
      },
    )
  }
}
