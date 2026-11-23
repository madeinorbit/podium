/**
 * PREPARING A CONVERSATION FOR ANOTHER CREDENTIAL (credential management §9,
 * "Switching a session to another credential"; epic plan Task 11).
 *
 * A harness keeps its conversation in a file under its configuration
 * directory, and each Podium home is such a directory (§10). Before a session
 * resumes on a credential that lives in another home, the server asks the
 * daemon to put the conversation there: `conversationPrepareRequest`. The
 * daemon finds the newest copy of the conversation in any home of the harness,
 * places it at the same relative path in the target home and leaves the
 * source as it was. For a harness whose hidden reasoning is tied to the
 * account that produced it (Codex), a conversation that continues on another
 * account is written without those records (POD-6893 §3).
 *
 * `account` names the account the session is about to run on; `fromAccount`
 * the one it ran on, when the server knows it (a switch). Both are a
 * credential id or `none` (the harness's own login). Neither is a secret.
 *
 * Sent only to a daemon that offered `CAP_CONVERSATION_PREPARE`.
 */

import { AgentKind, ResumeRef, SessionIdField } from '@podium/model'
import { z } from 'zod'

export const CAP_CONVERSATION_PREPARE = 'conversation.prepare.v1'

/** A credential id, or `none` for the harness's own login. */
const ConversationAccount = z.string().min(1).max(128)

export const ConversationPrepareRequestMessage = z.object({
  type: z.literal('conversationPrepareRequest'),
  requestId: z.string(),
  sessionId: SessionIdField,
  agentKind: AgentKind,
  cwd: z.string(),
  resume: ResumeRef,
  /** The home the session resumes in (`default`: the harness's own directory). */
  toHomeId: z.string().min(1),
  account: ConversationAccount,
  fromAccount: ConversationAccount.optional(),
  /** Codex: the model provider the target runs on, recorded in the copy. */
  modelProvider: z.string().min(1).max(64).optional(),
})
export type ConversationPrepareRequestMessage = z.infer<typeof ConversationPrepareRequestMessage>

/**
 * `in-place`: the newest copy was already in the target home and nothing was
 * written. `copied`: placed from another home. `rewritten`: rewritten in the
 * target home without the old account's reasoning (the original kept aside).
 */
export const ConversationPlacement = z.enum(['in-place', 'copied', 'rewritten'])
export type ConversationPlacement = z.infer<typeof ConversationPlacement>

export const ConversationPrepareResultMessage = z.object({
  type: z.literal('conversationPrepareResult'),
  requestId: z.string(),
  ok: z.boolean(),
  placed: ConversationPlacement.optional(),
  droppedReasoning: z.boolean().optional(),
  error: z.string().optional(),
})
export type ConversationPrepareResultMessage = z.infer<typeof ConversationPrepareResultMessage>
