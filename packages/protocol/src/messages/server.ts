import { SessionIdField } from '@podium/model'
import { z } from 'zod'
import {
  PresenceRoomClosedMessage,
  PresenceRoomDeltaMessage,
  PresenceRoomStateMessage,
} from '../planes/presence-rooms'
import { ApprovalsChangedMessage } from './approvals'
import { SessionOpenUrlMessage, SessionOpenUrlResultMessage } from './browser-open'
import {
  FeedDeltaMessage,
  FeedRescopeMessage,
  FeedResumeMessage,
  FeedResyncRequiredMessage,
} from './feed'
import { HeadlessActivityMessage } from './headless'
import {
  AttentionEventMessage,
  HostMetricsChangedMessage,
  MachinesChangedMessage,
  WorktreesChangedMessage,
} from './host'
import { SetLogLevelMessage } from './logs'
import { ServerRelocationMessage } from './server-transfer'
import { MetadataDeltaMessage } from './sync'
import {
  AgentExitMessage,
  AttachedMessage,
  ControllerChangedMessage,
  GeometryMessage,
  OutputFrameMessage,
  PongMessage,
  TerminalOutcomeMessage,
  WelcomeMessage,
} from './terminal'
import { TranscriptDeltaMessage, TurnPreviewMessage } from './transcript'

// ---- Server -> browser client ----
export const SessionDraftChangedMessage = z.object({
  type: z.literal('sessionDraftChanged'),
  sessionId: SessionIdField,
  text: z.string(),
  // Versioned-draft metadata (Draft Sync v2, POD-859). All optional + additive so
  // older clients ignore them and older servers that never set them still produce a
  // valid message. `rev` is the server's monotonic sequence for this session;
  // `origin` is who wrote (a client id, `'native'`, or `'seed'`); `editedAt` ISO-8601.
  rev: z.number().int().nonnegative().optional(),
  origin: z.string().optional(),
  editedAt: z.string().optional(),
})
export type SessionDraftChangedMessage = z.infer<typeof SessionDraftChangedMessage>

export const ServerMessage = z.discriminatedUnion('type', [
  HeadlessActivityMessage,
  WelcomeMessage,
  AttachedMessage,
  TerminalOutcomeMessage,
  OutputFrameMessage,
  ControllerChangedMessage,
  GeometryMessage,
  AgentExitMessage,
  SessionDraftChangedMessage,
  HostMetricsChangedMessage,
  MachinesChangedMessage,
  WorktreesChangedMessage,
  PongMessage,
  AttentionEventMessage,
  TranscriptDeltaMessage,
  TurnPreviewMessage,
  ApprovalsChangedMessage,
  MetadataDeltaMessage,
  FeedDeltaMessage,
  FeedRescopeMessage,
  FeedResyncRequiredMessage,
  FeedResumeMessage,
  SessionOpenUrlMessage,
  SessionOpenUrlResultMessage,
  PresenceRoomStateMessage,
  PresenceRoomDeltaMessage,
  PresenceRoomClosedMessage,
  SetLogLevelMessage,
  ServerRelocationMessage,
])
export type ServerMessage = z.infer<typeof ServerMessage>
