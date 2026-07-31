/**
 * THE ONE CONVERSATION WRITE — `conversations.setMeta`.
 *
 * Curation written by the command center: the user's rename and the work-LLM's
 * summary for a discovered harness conversation. The `search` read on the same
 * router is deliberately not here — a `visibility` class describes what a command
 * WRITES and a read writes nothing.
 *
 * L1 DATA ONLY. The handler is `ConversationsService.setConversationMeta`,
 * unchanged by this issue; what moves here is the input vocabulary and the
 * classification, joined at the service by `modules/conversations/registry.ts`.
 *
 * CLASSIFICATION: `personal`, read off ADR 1's `conversationRegistry` row, which
 * declares exactly that. This is a declaration and not the ADR 9 D4 backstop
 * firing — the row exists, and it is `personal` because a discovered conversation
 * is one human's transcript history, indexed for that human to search.
 *
 * NOT `owned-compute`, which is the neighbouring value and the plausible mistake:
 * the conversation was DISCOVERED by walking a machine's disk, so the instinct is
 * to inherit the machine. But what this command writes is the curation — a name
 * and a summary in the server's registry — not the transcript on the host. The
 * row it touches lives on the server (`home: 'server'`), and the machine's
 * reachability decides nothing about who may rename it.
 */

import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'

/** `trpc` alone. The command center is the only surface that curates; no CLI verb
 *  and no MCP tool names it, measured rather than assumed. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/**
 * OFFLINE-ELIGIBLE, transcribed from the matrix row (`offline: 'offline-eligible'`)
 * rather than chosen, and it is the right answer for the reason the row is
 * `exp-rev`: a rename is a last-writer-wins edit on a server-held row with no
 * execution anywhere. Queuing one and applying it late does exactly what the user
 * expects — the name they typed wins when it lands.
 */
const CONVERSATION_DELIVERY: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'Rides the client Outbox as an ordinary offline-eligible write, matching the matrix row. The ' +
    'row arbitrates `exp-rev`, so a queued rename that lands after a competing one is resolved by ' +
    'the Authority on expected-revision rather than by replay order, and nothing executes anywhere ' +
    'as a side effect of the drain.',
  applyTimeReauthorization:
    'Re-authorized live at apply against the delegation resolved at that moment (ADR 9 D5 A1). A ' +
    'principal who has lost sight of the conversation between enqueue and drain is refused and told ' +
    'so; the queued edit is dropped rather than applied under the rights it was written with.',
}

/**
 * Reviewed, and the one path that had to be considered is named so the empty list
 * reads as a finding rather than a default.
 *
 * `summary` is WORK-LLM OUTPUT DERIVED FROM A TRANSCRIPT, which is the strongest
 * candidate on this surface and the reason this note is longer than the field. It
 * stays unredacted because the summary is the product — it is what the command
 * center renders in the list, so redacting it would empty the feature — and
 * because the matrix row classes the whole row `secret: 'public'`, meaning
 * anything reaching it already holds sight of the conversation it summarizes. What
 * would NOT be acceptable is this field carrying transcript content verbatim; it
 * carries a bounded 2000-character summary the service wrote, and the bound is on
 * the schema rather than trusted to the caller.
 */
const CONVERSATION_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'No credential or machine identity crosses this surface. `summary` was the candidate — it is ' +
    'work-LLM output derived from a transcript — and is deliberately NOT redacted: it is the ' +
    'rendered product of the feature, the matrix row is `secret: "public"`, and anyone who can ' +
    'reach this command already holds sight of the conversation. The schema bounds it at 2000 ' +
    'characters so it stays a summary rather than becoming a transcript channel.',
}

const CONVERSATION_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal, never from payload. The pair matters here because ' +
    'BOTH a human and the work LLM write this row — a rename is the user, a summary is the agent — ' +
    'and telling them apart afterwards is only possible if the actor was stamped rather than ' +
    'claimed. `id` is a routing address, which Amendment 1 D17 forbids doubling as the record.',
}

/**
 * Amendment 1 D20.2 in its ordinary form: the `id` is caller-supplied, so a
 * conversation this principal may not see must fail exactly as one that does not
 * exist. No machine is nameable on this surface, so readiness §3.1.4 M5's
 * carve-out does not apply and there is nothing to keep distinguishable.
 */
const CONVERSATION_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'The `id` is caller-supplied and could otherwise be iterated to learn which conversations exist, ' +
    'so an invisible row and an absent one fail identically. M5’s unauthorized-versus-unreachable ' +
    'carve-out does not apply: no machine is nameable here, so there is no pair to keep apart.',
}

/** `id` addresses an existing registry row; both fields are optional and an absent
 *  one means "leave it", kept exactly as the shipped procedure validated. */
export const conversationsSetMetaInput = z.object({
  id: z.string(),
  name: z.string().max(200).optional(),
  summary: z.string().max(2000).optional(),
})

export const conversationsSetMetaContract = {
  name: 'conversations.setMeta',
  version: 1,
  visibility: 'personal',
  input: conversationsSetMetaInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'none',
    confirmation: 'none',
    rationale:
      'An ordinary `write` on a server-held row: it edits curation fields and releases nothing, ' +
      'which is what separates it from the approval decisions graded `manage`. `resource: none` ' +
      'because the gate is the conversation row’s own owner rather than a containing entity — the ' +
      'conversation IS the target, and there is no machine gate even though the transcript was ' +
      'discovered on one (the row lives on the server; see the header). `roleFloor: member` because ' +
      'renaming your own conversation is not an administrative act. No confirmation: the edit is ' +
      'non-destructive and immediately reversible by writing the field again.',
  },
  exposure: SERVED_ON,
  delivery: CONVERSATION_DELIVERY,
  redaction: CONVERSATION_REDACTION,
  ownership: {
    creates: [],
    note: 'Edits an existing registry row; mints no entity and moves no ownership. Discovery creates the row, not this.',
  },
  attribution: CONVERSATION_ATTRIBUTION,
  errorConsistency: CONVERSATION_ERRORS,
} as const satisfies CommandContract<typeof conversationsSetMetaInput>

export const CONVERSATION_CONTRACTS = { setMeta: conversationsSetMetaContract } as const

export type ConversationContractName = keyof typeof CONVERSATION_CONTRACTS

export const CONVERSATION_CONTRACT_NAMES = Object.keys(
  CONVERSATION_CONTRACTS,
).sort() as ConversationContractName[]
