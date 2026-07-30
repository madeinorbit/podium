import { IssueWire, SessionIdField } from '@podium/model'
import { z } from 'zod'

// The issue aggregate, its vocabularies (IssueStage/IssueType/IssueColor) and
// its read projections live in @podium/model (POD-300). What stays here is the
// FRAMES that carry them and the agent relay.

export const IssuesChangedMessage = z.object({
  type: z.literal('issuesChanged'),
  issues: z.array(IssueWire),
})
export const IssueUpdatedMessage = z.object({
  type: z.literal('issueUpdated'),
  issue: IssueWire,
})

// Agent relay: an agent's daemon forwards a router/proc op (a tRPC-style call for
// issues, messages, sessions, specs, workflows, locks, approvals, …) up to the
// server, which runs it against the shared backend and returns the result.
// Request is daemon→server; result is server→daemon.
export const AgentRelayRequestMessage = z.object({
  type: z.literal('agentRelayRequest'),
  requestId: z.string(),
  sessionId: SessionIdField,
  router: z.string(),
  proc: z.string(),
  input: z.unknown().optional(),
  outsideScope: z.boolean().optional(),
})
export const AgentRelayResultMessage = z.object({
  type: z.literal('agentRelayResult'),
  requestId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

/** How long the loopback agent-relay hub holds a request open for procs that
 *  legitimately BLOCK server-side, before giving up with `agent relay timed out`
 *  [POD-854]. The urgency-gated blocking send waits up to the server's
 *  INTERRUPT_DELIVERY_CEILING_MS (90s) for a transcript-observed confirmation; if
 *  the transport gives up first, the agent's `podium mail send` THROWS before the
 *  gate can return its honest `delivered`/`accepted`, the sender resends, and we
 *  get the duplicate delivery the milestone exists to kill. This must exceed that
 *  ceiling with margin (the normal-RPC hub timeout stays 30s). Shared here so the
 *  daemon transport and the server's budget invariant agree on one number. */
export const AGENT_RELAY_BLOCKING_TIMEOUT_MS = 120_000
