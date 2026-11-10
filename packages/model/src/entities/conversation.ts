/** Conversation summaries come from the stored index. File observations are
 * daemon-to-server evidence, never part of the synced record, and neither are
 * the activity stamps a growing transcript moves (see
 * {@link ConversationRecordWire}). */

import { z } from 'zod'
import { ConversationIdField } from '../ids'
import { AgentKind } from './agent'
import { ResumeRef } from './session'

// Discovery payloads on the wire — dates are ISO strings (Date is not JSON-safe).
export const ConversationGit = z.object({
  branch: z.string().optional(),
  sha: z.string().optional(),
  originUrl: z.string().optional(),
})
export type ConversationGit = z.infer<typeof ConversationGit>

export const ConversationSummaryWire = z.object({
  /** UNBRANDED BY DECISION: the NATIVE agent session id — evidence, not identity
   *  (see `podiumId` below, and the doc comment there). POD-360 recorded that no
   *  brand exists for a native id and that none should: a resume that rolls into
   *  a new file gets a new one, which is the opposite of a stable identity. */
  id: z.string(),
  /** Podium-generated stable identity (docs/spec/conversation-registry.md). `id`
   *  above is the NATIVE agent session id — evidence, not identity: a resume that
   *  rolls into a new file gets a new `id` but keeps this `podiumId`. Server-
   *  enriched; absent on daemon-originated payloads and for un-indexed rows.
   *
   *  THE branded `ConversationId` on this schema. */
  podiumId: ConversationIdField.optional(),
  agentKind: AgentKind,
  title: z.string().optional(),
  /** Curated display name (user rename via conversations.setMeta). Server-
   *  enriched from the conversations index — never daemon-originated. Display
   *  surfaces let it win over the harness `title`, matching search results. */
  name: z.string().optional(),
  /** Curated work summary (command center / work-LLM). Server-enriched. */
  summary: z.string().optional(),
  projectPath: z.string().optional(),
  /** UNBRANDED: the parent's NATIVE id, same id space as `id` above. */
  parentConversationId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  resume: ResumeRef.optional(),
  /** UNBRANDED: a provider NAME ('claude-code'), not an entity id. */
  providerId: z.string(),
})
export type ConversationSummaryWire = z.infer<typeof ConversationSummaryWire>

/** The synced `conversation` record: the summary without `updatedAt` and
 *  `messageCount`. Both move whenever the transcript grows, which made them most
 *  of the conversation log rows (POD-6768: 4,085 of 13,293 changes in a 7-hour
 *  window). The index keeps both for recency ordering and search; a client that
 *  wants a recent list asks `conversations.search`. */
export const ConversationRecordWire = ConversationSummaryWire.omit({
  updatedAt: true,
  messageCount: true,
})
export type ConversationRecordWire = z.infer<typeof ConversationRecordWire>

/** Internal discovery evidence used to locate and mirror the transcript file. */
export const ConversationDiscoveryWire = ConversationSummaryWire.extend({
  path: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
})
export type ConversationDiscoveryWire = z.infer<typeof ConversationDiscoveryWire>

export const ConversationDiagnosticWire = z.object({
  severity: z.enum(['warning', 'error']),
  providerId: z.string().optional(),
  root: z.string().optional(),
  path: z.string().optional(),
  message: z.string(),
})
export type ConversationDiagnosticWire = z.infer<typeof ConversationDiagnosticWire>
