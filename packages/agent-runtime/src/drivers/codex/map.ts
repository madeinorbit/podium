/**
 * codex app-server PROTOCOL → THE CONTRACT'S VOCABULARY (POD-1761 W6; plan §3).
 *
 * ---------------------------------------------------------------------------
 * PURE FUNCTIONS, DELIBERATELY — the same split W5 made
 * ---------------------------------------------------------------------------
 *
 * Everything here is a total function from one Codex payload to one contract
 * value. The STATE a mapping needs — which turn is open, what the cursor's
 * high-water mark is, which asks are outstanding — is held by the session handle
 * and passed in. That is what lets `./map.test.ts` assert the mapping against
 * recorded frames without standing up a driver.
 *
 * ---------------------------------------------------------------------------
 * WHY THE `packages/transcript` CODEX MAPPER IS **NOT** REUSED
 * ---------------------------------------------------------------------------
 *
 * W5's map.ts reuses `packages/transcript`'s opencode mapper and argues,
 * correctly, that a second mapper would be two sources of truth. The same move
 * is not available here, and the reason is a fact about Codex rather than a
 * preference: `codexRecordToItems` parses ROLLOUT JSONL records — the envelope
 * `{timestamp, type:'response_item'|'event_msg', payload}` that Codex writes to
 * disk. The app-server speaks a DIFFERENT, higher-level vocabulary on the wire:
 * `ThreadItem`, with arms `userMessage` / `agentMessage` / `commandExecution` /
 * `fileChange` / `mcpToolCall` / `reasoning` and twelve more. They describe the
 * same conversation at different altitudes; neither is derivable from the other
 * by renaming.
 *
 * There IS a wire notification carrying the rollout shape —
 * `rawResponseItem/completed` — and reusing the existing mapper through it was
 * the first design. It was dropped because that notification never arrived in
 * any live run (0.147.0, several turns, both sandbox modes), so building the
 * transcript on it would be building on a channel this driver has never
 * observed. The house rule is explicit that a driver must not fabricate state it
 * has not seen, and "the items only appear if an undocumented capability is
 * negotiated" is exactly the kind of assumption that ships as an empty chat.
 *
 * So: a second mapper, over the vocabulary this driver actually receives, whose
 * divergence from the rollout mapper is the two vocabularies rather than two
 * opinions. The rollout path is untouched and still serves the terminal driver.
 */

import type { AgentStateEvent } from '@podium/harness'
import type { TranscriptItem } from '@podium/model'
import type { InteractionAnswer, PendingInteraction, Refusal } from '../../index.js'
import {
  type CodexApprovalDecision,
  type CodexCommandApprovalParams,
  type CodexFileChangeApprovalParams,
  type CodexPermissionsApprovalParams,
  type CodexThreadItem,
  type CodexThreadStatus,
  type CodexTurnStatus,
  offersDecision,
  WAITING_ON_APPROVAL_FLAG,
} from './protocol.js'

// ---------------------------------------------------------------------------
// Transcript items
// ---------------------------------------------------------------------------

/** How long a tool-input preview may be before it stops being a preview. */
const PREVIEW_MAX = 300

const truncate = (text: string, max = PREVIEW_MAX): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

/**
 * One `ThreadItem` → the transcript items it produces.
 *
 * ARMS THIS DRIVER HAS SEEN LIVE map to real items; arms it has not map to
 * NOTHING rather than to a generic placeholder. An unmapped arm costs an absent
 * item; a guessed one puts a line in the user's chat that misdescribes what the
 * agent did, and there is no way for a reader to tell the two apart afterwards.
 *
 * `reasoning` is skipped deliberately and for the same reason the rollout mapper
 * skips it: it is the model's internal content, not chat, and Codex's summaries
 * arrive empty unless a summary mode is configured.
 */
export function threadItemToItems(
  item: CodexThreadItem,
  at: string | undefined,
): readonly TranscriptItem[] {
  const ts = at ? { ts: at } : {}
  switch (item.type) {
    case 'userMessage': {
      const text = userMessageText(item)
      return text ? [{ id: item.id, role: 'user', ...ts, text }] : []
    }
    case 'agentMessage': {
      const text = str(item.text)
      if (!text) return []
      return [
        {
          id: item.id,
          role: 'assistant',
          ...ts,
          text,
          /**
           * `phase: 'final_answer'` IS CODEX'S OWN MARKER for the message that
           * ended the turn, as opposed to the `commentary` it narrates with
           * between tool calls. That is exactly what `answer` means on a
           * TranscriptItem, so it is copied rather than inferred — the contract
           * note on `answer` says a buried answer carries no marker, and this is
           * the rare provider that marks it.
           */
          ...(item.phase === 'final_answer' ? { answer: true } : {}),
        },
      ]
    }
    case 'commandExecution': {
      const command = str(item.command) ?? ''
      const cwd = str(item.cwd)
      const output = str(item.aggregatedOutput)
      const done = item.status === 'completed' || item.status === 'failed'
      return [
        {
          id: item.id,
          role: 'tool',
          ...ts,
          text: '',
          toolName: 'Bash',
          ...(command ? { toolInput: truncate(command) } : {}),
          ...(cwd ? { toolPaths: [cwd] } : {}),
          toolUseId: item.id,
          // The RESULT rides the same item, because Codex updates one item in
          // place rather than emitting a separate output record. Only a
          // finished command has one; an in-progress item carries the call
          // alone, which is what `item/started` means.
          ...(done && output ? { toolResult: truncate(output, 2000) } : {}),
        },
      ]
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes
        .map((change) => (isRecord(change) ? str(change.path) : undefined))
        .filter((path): path is string => path !== undefined)
      return [
        {
          id: item.id,
          role: 'tool',
          ...ts,
          text: '',
          toolName: 'Edit',
          ...(paths.length > 0 ? { toolInput: truncate(paths.join(', ')), toolPaths: paths } : {}),
          toolUseId: item.id,
        },
      ]
    }
    case 'mcpToolCall': {
      const server = str(item.server)
      const tool = str(item.tool)
      return [
        {
          id: item.id,
          role: 'tool',
          ...ts,
          text: '',
          // The FULLY QUALIFIED name, because an MCP tool called `search` from
          // two servers is two different tools and a bare name hides which ran.
          toolName: server && tool ? `${server}/${tool}` : (tool ?? 'mcp'),
          ...(item.arguments !== undefined && item.arguments !== null
            ? { toolInput: truncate(safeJson(item.arguments)) }
            : {}),
          toolUseId: item.id,
        },
      ]
    }
    case 'webSearch': {
      const query = str(item.query)
      return [
        {
          id: item.id,
          role: 'tool',
          ...ts,
          text: '',
          toolName: 'WebSearch',
          ...(query ? { toolInput: truncate(query) } : {}),
          toolUseId: item.id,
        },
      ]
    }
    default:
      // reasoning, plan, sleep, imageView, subAgentActivity, contextCompaction,
      // enteredReviewMode … — no observed rendering, so no invented one.
      return []
  }
}

function userMessageText(item: CodexThreadItem): string {
  const content = item.content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isRecord(part) && part.type === 'text' ? (str(part.text) ?? '') : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * `thread/status/changed` → the normalized state vocabulary.
 *
 * `waitingOnApproval` IS THE ONE FLAG THAT CHANGES THE MEANING of `active`, and
 * folding it into plain activity is the mistake this function exists to prevent:
 * a thread parked on an approval is `{type:'active', activeFlags:
 * ['waitingOnApproval']}` — it is NOT computing, the user is the thing it is
 * waiting for, and a badge that reads "working" tells them to wait for an agent
 * that is waiting for them. Observed live, recorded in
 * `__fixtures__/approval-command.json`'s neighbourhood.
 *
 * `idle` maps to NOTHING here, deliberately. Codex signals end-of-turn twice —
 * `thread/status/changed {idle}` and then `turn/completed` — and only the second
 * carries the verdict. Folding the first into a turn completion would close a
 * turn epoch before its verdict was known, and fences are absorbing, so it would
 * never reopen. Same shape of bug as W5's `session.status: idle` note.
 */
export function statusToStateEvent(
  status: CodexThreadStatus,
  at: string,
): AgentStateEvent | null {
  if (status.type !== 'active') return null
  if (status.activeFlags.includes(WAITING_ON_APPROVAL_FLAG)) {
    return { kind: 'needs_user', need: 'permission', at }
  }
  return { kind: 'activity', at }
}

/** Codex's own turn verdict → the shared vocabulary. The caller supplies nothing:
 *  unlike opencode, Codex REPORTS whether the turn was interrupted, so the
 *  driver never has to infer it from an outstanding request. */
export function turnStatusToVerdict(
  status: CodexTurnStatus,
  hasOpenAsk: boolean,
): 'done' | 'question' | 'approval' | 'interrupted' {
  if (status === 'interrupted') return 'interrupted'
  // A turn that ended with an ask still open ended BECAUSE of the ask.
  if (hasOpenAsk) return 'approval'
  return 'done'
}

export function idleToStateEvent(
  verdict: 'done' | 'question' | 'approval' | 'interrupted',
  at: string,
): AgentStateEvent {
  return { kind: 'turn_completed', verdict: { kind: verdict }, at }
}

/** A failed turn's error → the contract's failure vocabulary. Unknown shapes are
 *  `provider-error`/`retryable`: a failure we cannot classify is still a failure,
 *  and guessing `fatal` would end a session a retry might save. */
export function describeTurnError(error: unknown): {
  reason: 'rate-limit' | 'auth-expired' | 'context-overflow' | 'provider-error' | 'timeout' | 'interrupted'
  disposition: 'retryable' | 'needs-human' | 'fatal'
  text?: string
} {
  const message = isRecord(error) ? (str(error.message) ?? '') : ''
  const lower = message.toLowerCase()
  const text = message ? truncate(message, 500) : undefined
  if (lower.includes('rate limit') || lower.includes('429')) {
    return { reason: 'rate-limit', disposition: 'retryable', ...(text ? { text } : {}) }
  }
  if (lower.includes('unauthor') || lower.includes('auth') || lower.includes('401')) {
    return { reason: 'auth-expired', disposition: 'needs-human', ...(text ? { text } : {}) }
  }
  if (lower.includes('context') && lower.includes('window')) {
    return { reason: 'context-overflow', disposition: 'needs-human', ...(text ? { text } : {}) }
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return { reason: 'timeout', disposition: 'retryable', ...(text ? { text } : {}) }
  }
  return { reason: 'provider-error', disposition: 'retryable', ...(text ? { text } : {}) }
}

// ---------------------------------------------------------------------------
// Interactions — the approval inversion
// ---------------------------------------------------------------------------

/**
 * THE ASK ID IS THE JSON-RPC REQUEST ID, stringified.
 *
 * `INTERACTION_HEAD.id` says the id is minted "by the driver that observed the
 * ask, in that driver's namespace", and this driver's namespace IS the
 * connection's request-id space: replying means answering that exact JSON-RPC
 * id, and `serverRequest/resolved` reports closure by that same id. Minting a
 * second id would mean carrying a private map whose only purpose is to be looked
 * up on every answer and whose only failure mode is stranding a blocked session.
 *
 * IDS START AT ZERO on this server, so `String(0)` — `'0'` — is a real ask id.
 * Any code that treats an interaction id as truthy breaks on the first approval
 * of every session; stringifying here is what keeps that hazard inside this one
 * function.
 */
export const askIdOf = (requestId: number | string): string => String(requestId)

/**
 * `item/commandExecution/requestApproval` → the contract's `permission` ask.
 *
 * `canAlwaysAllow` IS READ FROM `availableDecisions`, NEVER ASSUMED. The live
 * ask offered `['accept', {acceptWithExecpolicyAmendment:…}, 'cancel']` — no
 * `acceptForSession` and no `decline`. Claiming an always-allow the server will
 * refuse would put a button in front of a user whose answer bounces, and the
 * protocol's own `PermissionAnswer` note names reporting an ungranted persistent
 * grant as the thing not to do.
 */
export function commandApprovalAsk(input: {
  requestId: number | string
  sessionId: string
  params: CodexCommandApprovalParams
  askedAt: string
}): PendingInteraction {
  const { params } = input
  const summary = str(params.command) ?? str(params.reason)
  return {
    id: askIdOf(input.requestId),
    sessionId: input.sessionId as PendingInteraction['sessionId'],
    kind: 'permission',
    payload: {
      v: 1,
      toolName: 'Bash',
      ...(summary ? { inputSummary: truncate(summary) } : {}),
      canAlwaysAllow: offersDecision(params.availableDecisions, 'acceptForSession'),
    },
    askedAt: input.askedAt,
    source: 'protocol',
    answerable: 'structured',
  }
}

/** `item/fileChange/requestApproval` → a `permission` ask over a patch. */
export function fileChangeApprovalAsk(input: {
  requestId: number | string
  sessionId: string
  params: CodexFileChangeApprovalParams
  askedAt: string
}): PendingInteraction {
  const { params } = input
  const summary = str(params.reason) ?? str(params.grantRoot)
  return {
    id: askIdOf(input.requestId),
    sessionId: input.sessionId as PendingInteraction['sessionId'],
    kind: 'permission',
    payload: {
      v: 1,
      toolName: 'Edit',
      ...(summary ? { inputSummary: truncate(summary) } : {}),
      canAlwaysAllow: offersDecision(params.availableDecisions, 'acceptForSession'),
    },
    askedAt: input.askedAt,
    source: 'protocol',
    answerable: 'structured',
  }
}

/**
 * `item/permissions/requestApproval` → a `permission` ask over a profile.
 *
 * NO ALWAYS-ALLOW IS OFFERED, and that is not a simplification: this request's
 * reply is a `GrantedPermissionProfile` + a `PermissionGrantScope`, not a
 * decision enum, so the driver answers it with the narrowest grant it can
 * express. Modelling the permission-profile vocabulary is out of this item's
 * scope, so the ask reports what it can do — allow once, or refuse — rather than
 * offering a persistent grant it would then have to invent a profile for.
 */
export function permissionsApprovalAsk(input: {
  requestId: number | string
  sessionId: string
  params: CodexPermissionsApprovalParams
  askedAt: string
}): PendingInteraction {
  const summary = str(input.params.reason) ?? str(input.params.cwd)
  return {
    id: askIdOf(input.requestId),
    sessionId: input.sessionId as PendingInteraction['sessionId'],
    kind: 'permission',
    payload: {
      v: 1,
      toolName: 'Permissions',
      ...(summary ? { inputSummary: truncate(summary) } : {}),
      canAlwaysAllow: false,
    },
    askedAt: input.askedAt,
    source: 'protocol',
    answerable: 'structured',
  }
}

/** `mcpServer/elicitation/request` → the contract's `elicitation` ask. Codex is
 *  the first harness in the fleet with a channel for one. */
export function elicitationAsk(input: {
  requestId: number | string
  sessionId: string
  params: unknown
  askedAt: string
}): PendingInteraction {
  const params = isRecord(input.params) ? input.params : {}
  const message = str(params.message) ?? 'The MCP server is asking for input.'
  return {
    id: askIdOf(input.requestId),
    sessionId: input.sessionId as PendingInteraction['sessionId'],
    kind: 'elicitation',
    payload: {
      v: 1,
      message: truncate(message, 2000),
      /** MCP's `requestedSchema` verbatim — it is a schema, not a value, and the
       *  surface that draws the form is the one that reads it. An ask that
       *  arrives without one becomes an empty schema rather than a dropped ask:
       *  the message alone is still answerable. */
      requestedSchema: isRecord(params.requestedSchema) ? params.requestedSchema : {},
      ...(str(params.serverName) ? { serverName: str(params.serverName) as string } : {}),
    },
    askedAt: input.askedAt,
    source: 'protocol',
    answerable: 'structured',
  }
}

// ---------------------------------------------------------------------------
// Answers: the contract's vocabulary → the JSON-RPC response payload
// ---------------------------------------------------------------------------

/**
 * What answering ONE interaction turns into.
 *
 * A discriminated union rather than a pre-bound call, so the mapping stays pure
 * and the handle owns the client — the same shape as W5's `OpencodeAnswerAction`.
 * `result` is the exact JSON-RPC `result` member to send back.
 */
export type CodexAnswerAction =
  | { call: 'respond'; result: unknown }
  | { call: 'refuse'; refusal: Refusal }

/**
 * Map a typed answer onto the response that delivers it.
 *
 * WHAT REFUSES, AND WHY EACH REFUSAL BEATS THE DEGRADATION IT REPLACES:
 *
 *  - `allow-always` against an ask whose `canAlwaysAllow` is false. Silently
 *    sending `accept` instead would report a persistent grant that was never
 *    made — the protocol's own `PermissionAnswer` comment names this case.
 *  - An answer whose `kind` does not match the ask's. The discriminants exist so
 *    a mismatch is caught before it reaches a provider, not after.
 *
 * A refusal leaves the ask OPEN and the JSON-RPC request UNANSWERED, which is
 * the honest state: the session stays visibly blocked rather than reporting an
 * answer that never reached the agent. That is safe precisely because Codex
 * imposes no deadline of its own on a server→client request.
 */
export function answerAction(
  ask: PendingInteraction,
  answer: InteractionAnswer,
  /**
   * The ask's own `availableDecisions`, verbatim — NOT a pre-reduced boolean.
   *
   * It was `canAlwaysAllow: boolean`, and that shape is what let the deny arm
   * ignore the offer the always-allow arm respected (POD-2024 review): the
   * boolean answered one question, so the other arm had nothing to consult and
   * sent `decline` at an ask whose recorded live list was
   * `['accept', {acceptWithExecpolicyAmendment: …}, 'cancel']`. Passing the list
   * means every arm asks the same source, which is the only way the two can
   * agree.
   */
  availableDecisions: readonly unknown[] | undefined,
): CodexAnswerAction {
  if (ask.kind === 'permission') {
    if (answer.kind !== 'permission') return mismatch(ask.kind, answer.kind)
    /**
     * EVERY DECISION IS CHECKED AGAINST THE OFFER, and the reason this matters
     * more here than almost anywhere else is the direction of the message: our
     * answer is a JSON-RPC RESPONSE to a request the server is blocked on, so
     * the server has NO CHANNEL to reject it. A decision it does not accept is
     * not an error we can see — it is a turn that quietly does the wrong thing,
     * or does nothing, while Podium reports the answer delivered.
     *
     * `decline` is not universally on offer: the recorded live ask listed
     * `accept`, an execpolicy amendment and `cancel`, with neither
     * `acceptForSession` NOR `decline`. So a deny falls back to `cancel` — which
     * is also a refusal to run the command, and IS offered — and refuses
     * outright only when neither is available, leaving the ask open rather than
     * sending something the server never said it would take.
     */
    const wanted: readonly CodexApprovalDecision[] =
      answer.decision === 'allow-always'
        ? ['acceptForSession']
        : answer.decision === 'deny'
          ? ['decline', 'cancel']
          : ['accept']
    const decision = wanted.find((candidate) => offersDecision(availableDecisions, candidate))
    if (!decision) {
      return {
        call: 'refuse',
        refusal: {
          reason: 'unsupported',
          detail:
            answer.decision === 'allow-always'
              ? 'this ask did not offer an always-allow; answering once instead would report a grant that was never made'
              : `this ask offered none of [${wanted.join(', ')}], and answering with a decision it did not offer would be unanswerable — the server is blocked on a response it cannot reject`,
        },
      }
    }
    return { call: 'respond', result: { decision } }
  }

  if (ask.kind === 'elicitation') {
    if (answer.kind !== 'elicitation') return mismatch(ask.kind, answer.kind)
    // MCP's elicitation result shape: an action plus the content when accepted.
    return answer.action === 'accept'
      ? { call: 'respond', result: { action: 'accept', content: answer.content ?? {} } }
      : { call: 'respond', result: { action: answer.action === 'cancel' ? 'cancel' : 'decline' } }
  }

  return {
    call: 'refuse',
    refusal: {
      reason: 'unsupported',
      detail: `codex app-server has no answer channel for a '${ask.kind}' ask`,
    },
  }
}

const mismatch = (askKind: string, answerKind: string): CodexAnswerAction => ({
  call: 'refuse',
  refusal: {
    reason: 'unsupported',
    detail: `answer of kind '${answerKind}' cannot answer a '${askKind}' ask`,
  },
})
