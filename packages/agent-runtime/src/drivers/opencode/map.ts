/**
 * opencode PROTOCOL → THE CONTRACT'S VOCABULARY (POD-1761 W5; plan §2 `map.ts`).
 *
 * ---------------------------------------------------------------------------
 * PURE FUNCTIONS, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * Everything here is a total function from one opencode payload to one contract
 * value. The STATE a mapping needs — which message an orphaned part belongs to,
 * which turn epoch is open, what the cursor's high-water mark is — is held by
 * the session handle and passed IN. That split is what lets the fixture tests
 * assert the mapping against recorded frames without standing up a driver, and
 * it is why a mapping bug is findable by reading one function.
 *
 * ---------------------------------------------------------------------------
 * THE ITEM MAPPER IS NOT REWRITTEN, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * `packages/transcript`'s `opencodePartToItems`/`stampOpencodeItems` already
 * turn an opencode message+part pair into `TranscriptItem`s, because the SQLite
 * transcript source has needed exactly that since long before this epic. The SSE
 * payloads are the SAME two objects the SQLite rows hold, just delivered live
 * instead of read back — so this driver assembles a row and calls the existing
 * mapper. A second opencode→item mapper would be two sources of truth for how an
 * opencode tool call renders, and they would diverge on the first tool opencode
 * added.
 */

import type { AgentStateEvent } from '@podium/harness'
import type { TranscriptItem } from '@podium/model'
import {
  encodeCursor,
  type OpencodeMessagePartRow,
  opencodeFileId,
  stampOpencodeItems,
} from '@podium/transcript'
import type { InteractionAnswer, PendingInteraction, QuestionPrompt, Refusal } from '../../index.js'
import { streamItemIdOf } from '../../stream-identity.js'
import type {
  OpencodeMessageInfo,
  OpencodePart,
  OpencodePermissionReply,
  OpencodeQuestionInfo,
  OpencodeSessionStatus,
} from './protocol.js'

// ---------------------------------------------------------------------------
// Transcript items
// ---------------------------------------------------------------------------

/**
 * One live part → the stamped items it produces.
 *
 * `messageInfo` is the message the part belongs to, which the SSE stream
 * delivers SEPARATELY (a `message.updated` always precedes its parts). The
 * caller tracks it; a part whose message we have never seen maps to nothing
 * rather than to an item with a guessed role.
 */
export function partToItems(
  sessionId: string,
  messageInfo: OpencodeMessageInfo,
  part: OpencodePart,
): readonly TranscriptItem[] {
  const timeUpdated = part.time?.end ?? part.time?.start ?? messageInfo.time?.created ?? 0
  const row: OpencodeMessagePartRow = {
    messageId: messageInfo.id,
    partId: part.id,
    sessionId,
    timeCreated: messageInfo.time?.created ?? timeUpdated,
    timeUpdated,
    messageData: JSON.stringify(messageInfo),
    partData: JSON.stringify(part),
  }
  return stampOpencodeItems([row], sessionId)
}

/**
 * The identity a `delta` fragment and its eventual `complete` item share.
 *
 * NOT THE ITEM'S `id`, AND NOT ITS `cursor` EITHER — and the second half of that
 * is what this function got wrong until POD-2293 measured it.
 *
 * `opencodePartToItems` derives `id` from the part id AND ITS TEXT, so the id of
 * a growing assistant message changes on every update; that much was always
 * documented here. The stamped `cursor` was then offered as the stable
 * alternative, and it is not one: `stampOpencodeItems` puts the row's
 * `timeUpdated` in the cursor's `offset`, and `timeUpdated` is
 * `part.time.end ?? part.time.start`. A streaming text part is announced with
 * `time:{start}` and closed with `time:{start,end}` — recorded in
 * `__fixtures__/events-turn.json`, where `prt_…833` arrives at `1786682763315`
 * and closes at `1786682766449`. So the FINAL complete item, the authoritative
 * one, carried a different cursor from every fragment that built it, and a
 * consumer reconciling on the cursor accumulated exactly the orphan this comment
 * warned about.
 *
 * What is stable for the part's whole life is the rest of the cursor —
 * `(fileId, partId, sub)` — which is what `streamItemIdOf` returns. Both halves
 * of the join now call the contract's own function: this one for a complete
 * item, {@link deltaItemIdForPart} for a fragment that has no item yet.
 */
export function deltaItemIdOf(items: readonly TranscriptItem[]): string | undefined {
  const first = items[0]
  return first ? streamItemIdOf(first) : undefined
}

/**
 * The same identity, for a fragment whose complete item does not exist yet.
 *
 * A `message.part.delta` names only the part, and the first token arrives before
 * opencode has published any text to stamp — so the driver derives the identity
 * from the coordinates the cursor is built out of. `sub: 0` because the delta
 * arm is text-only (`field !== 'text'` is dropped upstream) and a text part maps
 * to exactly one item; a tool part's two items are never a fragment stream.
 */
export function deltaItemIdForPart(sessionId: string, partId: string): string {
  return encodeCursor({ fileId: opencodeFileId(sessionId), offset: 0, uuid: partId, sub: 0 })
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * opencode's session status → the normalized state vocabulary.
 *
 * `retry` IS NOT IDLE, and it is the one that would be got wrong. opencode
 * reports `{type:'retry'}` while it is re-attempting a provider call after a
 * transport failure: the session is working, the user is waiting, and a driver
 * that folded it into idle would flip the badge to "done" mid-turn and let the
 * steward send into an open turn.
 */
export function statusToStateEvent(
  status: OpencodeSessionStatus,
  at: string,
): AgentStateEvent | null {
  switch (status.type) {
    case 'busy':
      return { kind: 'activity', at }
    case 'retry':
      // Still computing, and the reducer's coarse `activity` is the honest
      // report: there is no "retrying" phase in the shared vocabulary, and
      // inventing one here would put a state on the badge no other harness can
      // produce.
      return { kind: 'activity', at }
    case 'idle':
      // NOT `turn_completed`. `session.status: idle` fires between opencode's
      // internal steps as well as at the end of a turn; the authoritative
      // end-of-turn signal is the separate `session.idle` event, which fires
      // exactly once. Folding both into a turn completion would close a turn
      // epoch that is still open — and fences are absorbing, so it would never
      // reopen.
      return null
  }
}

/** The one authoritative end-of-turn signal. `verdict` is left to the caller,
 *  which knows whether an interrupt is outstanding and whether an ask is open. */
export function idleToStateEvent(
  verdict: 'done' | 'question' | 'approval' | 'interrupted',
  at: string,
): AgentStateEvent {
  return { kind: 'turn_completed', verdict: { kind: verdict }, at }
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

/** How long an input summary may be before it stops being a summary. The ask
 *  carries "the ONE field that says what it would do" (protocol runtime.ts), and
 *  a bash command longer than this is not read, it is scrolled. */
const SUMMARY_MAX = 300

/**
 * `permission.asked` → the contract's `permission` ask.
 *
 * THE ID IS opencode's OWN `per_…`, deliberately. `INTERACTION_HEAD.id` says the
 * id is "minted by the driver that observed the ask, in that driver's namespace"
 * — and this driver's namespace IS opencode's request-id space, because that is
 * the handle it must reply against. Minting a second id would mean carrying a
 * private map from ours to theirs whose only purpose is to be looked up on every
 * answer, and whose only failure mode is losing an entry and stranding a
 * blocked session.
 *
 * `source: 'protocol'` and `answerable: 'structured'` are the whole reason this
 * driver needs no terminal exemption: the ask has a real request id and is
 * answered over REST, so asked→answered is exactly-once and nothing is
 * classified off a screen.
 */
export function permissionAsk(input: {
  id: string
  sessionId: string
  permission: string
  patterns: readonly string[]
  metadata: Record<string, unknown>
  always: readonly string[]
  askedAt: string
}): PendingInteraction {
  return {
    id: input.id,
    sessionId: input.sessionId as PendingInteraction['sessionId'],
    kind: 'permission',
    payload: {
      v: 1,
      toolName: input.permission,
      ...(summarizePermission(input.metadata, input.patterns)
        ? { inputSummary: summarizePermission(input.metadata, input.patterns) }
        : {}),
      // NON-EMPTY `always` IS THE OFFER. opencode puts the rule patterns it
      // would persist in there (`["echo *"]`), so the presence of the offer and
      // its content arrive together.
      canAlwaysAllow: input.always.length > 0,
      ...(input.always.length > 0 ? { suggestions: [...input.always] } : {}),
    },
    askedAt: input.askedAt,
    source: 'protocol',
    answerable: 'structured',
  }
}

/**
 * The bounded summary. `metadata.command` is what a bash ask carries and is the
 * most legible; `patterns` is the general fallback opencode fills for every
 * permission class. Neither is the raw tool input, which is unbounded by nature
 * and stays in the transcript (protocol runtime.ts's normalization rule).
 */
function summarizePermission(
  metadata: Record<string, unknown>,
  patterns: readonly string[],
): string | undefined {
  const command = metadata.command
  if (typeof command === 'string' && command.trim()) return truncate(command.trim())
  const path = metadata.filePath ?? metadata.path
  if (typeof path === 'string' && path.trim()) return truncate(path.trim())
  const joined = patterns.filter((p) => p.trim()).join(' ')
  return joined ? truncate(joined) : undefined
}

const truncate = (text: string): string =>
  text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`

/**
 * `question.asked` → the contract's `question` ask.
 *
 * TWO FIELDS ARE COMPUTED RATHER THAN COPIED, and both matter to whoever answers:
 *
 *  - `otherIndex` is 1-BASED and only present when opencode says the menu takes
 *    free text (`custom`). Its value is options.length + 1, matching the
 *    contract's "synthetic Other row" convention exactly.
 *  - `previewLayout` is always FALSE, and honestly so: opencode's option shape is
 *    `{label, description}` with no `preview` field, so the side-by-side dialog
 *    POD-770 documents cannot occur. Reporting it true would tell a surface it
 *    must refuse free text on a menu that accepts it.
 */
export function questionAsk(input: {
  id: string
  sessionId: string
  questions: readonly OpencodeQuestionInfo[]
  askedAt: string
}): PendingInteraction {
  return {
    id: input.id,
    sessionId: input.sessionId as PendingInteraction['sessionId'],
    kind: 'question',
    payload: {
      v: 1,
      questions: input.questions.map(
        (question): QuestionPrompt => ({
          question: question.question,
          ...(question.header ? { header: question.header } : {}),
          multiSelect: question.multiple === true,
          ...(question.custom === true ? { otherIndex: question.options.length + 1 } : {}),
          previewLayout: false,
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
        }),
      ),
    },
    askedAt: input.askedAt,
    source: 'protocol',
    answerable: 'structured',
  }
}

// ---------------------------------------------------------------------------
// Answers: the contract's vocabulary → opencode's REST calls
// ---------------------------------------------------------------------------

/** What answering ONE interaction turns into. A discriminated union rather than
 *  a pre-bound call so the mapping stays pure and the handle owns the client. */
export type OpencodeAnswerAction =
  | { call: 'permission'; reply: OpencodePermissionReply; message?: string }
  | { call: 'question'; answers: readonly (readonly string[])[] }
  | { call: 'question-reject' }
  | { call: 'refuse'; refusal: Refusal }

/**
 * Map a typed answer onto the REST call that delivers it.
 *
 * WHAT REFUSES, AND WHY EACH REFUSAL BEATS THE DEGRADATION IT REPLACES:
 *
 *  - `allow-always` against an ask whose `canAlwaysAllow` is false. Silently
 *    sending `once` instead would report a persistent grant that was never made
 *    — the protocol's own `PermissionAnswer` comment names this exact case.
 *  - A selection naming the Other row with no `text`. opencode's answer channel
 *    is a list of LABELS; there is no label for "the user typed something" and
 *    sending the literal string "Other" would answer a question nobody asked.
 *  - An answer whose `kind` does not match the ask's. The discriminants exist so
 *    a mismatch is caught before it reaches a provider, not after.
 */
export function answerAction(
  ask: PendingInteraction,
  answer: InteractionAnswer,
): OpencodeAnswerAction {
  if (ask.kind === 'permission') {
    if (answer.kind !== 'permission') return mismatch(ask.kind, answer.kind)
    if (answer.decision === 'allow-always' && !ask.payload.canAlwaysAllow) {
      return {
        call: 'refuse',
        refusal: {
          reason: 'unsupported',
          detail:
            'this ask did not offer an always-allow; answering once instead would report a grant that was never made',
        },
      }
    }
    const reply: OpencodePermissionReply =
      answer.decision === 'allow-always' ? 'always' : answer.decision === 'deny' ? 'reject' : 'once'
    return {
      call: 'permission',
      reply,
      ...(answer.feedback ? { message: answer.feedback } : {}),
    }
  }

  if (ask.kind === 'question') {
    if (answer.kind !== 'question') return mismatch(ask.kind, answer.kind)
    const prompts = ask.payload.questions
    // AN EMPTY ANSWER IS A REJECTION, not an empty selection. opencode has a
    // dedicated reject route and no way to express "none of these" as labels;
    // mapping the empty case onto `answers: [[]]` would leave the tool call
    // waiting on a reply it cannot interpret.
    if (
      answer.selections.length === 0 ||
      answer.selections.every((s) => s.optionIndices.length === 0 && !s.text)
    ) {
      return { call: 'question-reject' }
    }
    const answers: string[][] = []
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i]
      const selection = answer.selections[i]
      if (!prompt || !selection) {
        return {
          call: 'refuse',
          refusal: {
            reason: 'unsupported',
            detail: `answer covers ${answer.selections.length} of ${prompts.length} prompts; opencode answers a menu in one act`,
          },
        }
      }
      const labels: string[] = []
      for (const index of selection.optionIndices) {
        const option = prompt.options[index - 1]
        if (option) {
          labels.push(option.label)
          continue
        }
        // Past the last option: the synthetic Other row, which opencode can
        // only receive as free text.
        if (prompt.otherIndex === index && selection.text?.trim()) {
          labels.push(selection.text.trim())
          continue
        }
        return {
          call: 'refuse',
          refusal: {
            reason: 'unsupported',
            detail:
              prompt.otherIndex === index
                ? 'the Other row was selected without free text; opencode answers by label'
                : `option ${index} is past the ${prompt.options.length} this ask offered`,
          },
        }
      }
      answers.push(labels)
    }
    return { call: 'question', answers }
  }

  // plan-approval / elicitation / login / recovery: opencode has no channel that
  // carries them, so this driver never ASKS them and cannot be asked to answer
  // one. Refusing names the gap; a driver that accepted the answer and did
  // nothing would report a session unblocked that is still waiting.
  return {
    call: 'refuse',
    refusal: {
      reason: 'unsupported',
      detail: `opencode has no answer channel for a '${ask.kind}' ask`,
    },
  }
}

const mismatch = (askKind: string, answerKind: string): OpencodeAnswerAction => ({
  call: 'refuse',
  refusal: {
    reason: 'unsupported',
    detail: `answer of kind '${answerKind}' cannot answer a '${askKind}' ask`,
  },
})
