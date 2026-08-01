import type {
  AutomationRunWire,
  AutomationWire,
  ConversationSummaryWire,
  IssueDepProjection,
  IssueProjection,
  IssueWire,
  RepoProjection,
  SessionMeta,
} from '@podium/model'
import type { MetadataChangeLenient, MetadataDeltaMessageLenient } from '@podium/protocol'

/** Entity projection exchanged with the retired wire-v1 Replica adapter. */
export interface LegacyMetadataProjection {
  sessions: SessionMeta[]
  issues: IssueWire[]
  issueProjections: IssueProjection[]
  issueDeps: IssueDepProjection[]
  repos: RepoProjection[]
  conversations: ConversationSummaryWire[]
  automations: AutomationWire[]
  automationRuns: AutomationRunWire[]
}

/** Projection operations the Replica adapter may drive without exposing position state. */
export interface LegacyMetadataProjectionPort {
  apply(changes: MetadataChangeLenient[]): void
  replace(projection: LegacyMetadataProjection): void
  snapshot(): LegacyMetadataProjection
}

/**
 * Opaque compatibility sink for wire-v1 metadata envelopes.
 *
 * Socket transport owns delivery and lifecycle only. The implementation beside
 * the Replica owns every position, identity, gap and healing decision.
 */
export interface LegacyFeedSinkPort {
  bind(projection: LegacyMetadataProjectionPort): void
  connected(): void
  disconnected(): void
  dispose(): void
  frame(frame: MetadataDeltaMessageLenient, dropped: number): void
  seed(projection: LegacyMetadataProjection): void
}
