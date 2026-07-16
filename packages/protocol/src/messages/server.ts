import { z } from 'zod'
import { ApprovalsChangedMessage } from './approvals'
import { AutomationRunsChangedMessage, AutomationsChangedMessage } from './automations'
import { SessionOpenUrlMessage, SessionOpenUrlResultMessage } from './browser-open'
import { ConversationsChangedMessage } from './discovery'
import { HeadlessActivityMessage } from './headless'
import { AttentionEventMessage, HostMetricsChangedMessage, MachinesChangedMessage } from './host'
import { IssuesChangedMessage, IssueUpdatedMessage } from './issues'
import { SessionAgentStateChangedMessage, SessionsChangedMessage } from './runtime-state'
import { MetadataDeltaMessage } from './sync'
import {
  AgentExitMessage,
  AttachedMessage,
  ControllerChangedMessage,
  GeometryMessage,
  OutputFrameMessage,
  PongMessage,
  WelcomeMessage,
} from './terminal'
import { TranscriptDeltaMessage } from './transcript'

// ---- Server -> browser client ----
// A single session's live title changed (an agent set its terminal title via OSC).
// Sent on its own rather than rebroadcasting the whole session list, because agents
// emit these at spinner frame-rate (~10 Hz) and the payload is tiny.
export const SessionTitleChangedMessage = z.object({
  type: z.literal('sessionTitleChanged'),
  sessionId: z.string(),
  title: z.string(),
})

export const SessionDraftChangedMessage = z.object({
  type: z.literal('sessionDraftChanged'),
  sessionId: z.string(),
  text: z.string(),
})
export type SessionDraftChangedMessage = z.infer<typeof SessionDraftChangedMessage>

export const ServerMessage = z.discriminatedUnion('type', [
  HeadlessActivityMessage,
  WelcomeMessage,
  AttachedMessage,
  OutputFrameMessage,
  ControllerChangedMessage,
  GeometryMessage,
  AgentExitMessage,
  SessionsChangedMessage,
  ConversationsChangedMessage,
  SessionTitleChangedMessage,
  SessionAgentStateChangedMessage,
  SessionDraftChangedMessage,
  HostMetricsChangedMessage,
  MachinesChangedMessage,
  PongMessage,
  AttentionEventMessage,
  TranscriptDeltaMessage,
  ApprovalsChangedMessage,
  IssuesChangedMessage,
  IssueUpdatedMessage,
  MetadataDeltaMessage,
  AutomationsChangedMessage,
  AutomationRunsChangedMessage,
  SessionOpenUrlMessage,
  SessionOpenUrlResultMessage,
])
export type ServerMessage = z.infer<typeof ServerMessage>
