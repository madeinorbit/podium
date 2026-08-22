/**
 * SYNTHESIS — turning what Podium already observes into typed asks (POD-2020,
 * spec §4 "Where they come from", terminal row).
 *
 * ---------------------------------------------------------------------------
 * THE INPUT IS `AgentRuntimeState`, NOT THE HOOK CHANNEL
 * ---------------------------------------------------------------------------
 * The spec names two terminal sources: the Claude hook channel
 * (`PermissionRequest`, Stop-with-question verdicts) and the screen classifier.
 * Both of them ALREADY converge, on the daemon, into one normalized value —
 * `AgentRuntimeState`, whose `stateSource` field says which of them won. So this
 * module reads the convergence rather than the two tributaries:
 *
 *  - it cannot drift from what the rest of Podium believes about the session,
 *    because it is reading the same value the badge and the inbox read;
 *  - it needs no second hook subscription, no second classifier invocation, and
 *    no change to the observation path — which is what makes "existing UI
 *    behavior unchanged; the aggregate observes" true by construction;
 *  - `stateSource` maps 1:1 onto the spec's `source` vocabulary, so provenance
 *    is carried rather than guessed.
 *
 * What this costs, stated plainly: the aggregate sees the WINNER of the
 * daemon's source arbitration, not every observation. If a hook and the
 * classifier disagree, the aggregate hears the hook — which is the right answer
 * and also the only one the rest of the app acts on.
 *
 * ---------------------------------------------------------------------------
 * EVERY FUNCTION HERE IS PURE
 * ---------------------------------------------------------------------------
 * A transition in, an ask (or nothing) out. The durable write, the dedupe and
 * the delivery all live in `service.ts`; this file is the vocabulary
 * translation, and it is where the corpus of "this state means this ask" cases
 * is testable without a database.
 */

import { createHash } from 'node:crypto'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type {
  InteractionAnswerability,
  InteractionAskSpec,
  InteractionSource,
  QuestionPrompt,
} from '@podium/protocol'
import { materializeFailure } from './materialize'

/** Re-exported, not redefined: the distributive kind/payload pair lives in
 *  `@podium/protocol` beside the union it derives from, because all three
 *  producers need it and three copies of a conditional type is three chances to
 *  get the distribution wrong. */
export type { InteractionAskSpec } from '@podium/protocol'

/** What an ask reads as when the observation path knows a session is waiting and
 *  could not read WHAT it is waiting on. Deliberately a sentence about the
 *  session rather than an invented question: nothing here knows what is on
 *  screen, and a card that guessed would be answered against a guess. */
const UNREADABLE_PROMPT =
  'This session is waiting on a prompt Podium could not read. Open the terminal to see it.'

export interface SynthesizedAsk {
  readonly spec: InteractionAskSpec
  readonly source: InteractionSource
  readonly answerable: InteractionAnswerability
  /** Stable across re-observations of the same ask — see
   *  {@link interactionFingerprint}. */
  readonly fingerprint: string
}

/**
 * `stateSource` → the spec's provenance vocabulary.
 *
 * `poll` maps to `screen-classifier` rather than getting an arm of its own: a
 * polled observation is a read of the SCREEN, and what the consumer obligation
 * turns on is whether identity is reliable — which for anything scraped it is
 * not. An absent source is treated the same way, because "we don't know how we
 * learned this" must never be more trusted than "we scraped it".
 */
export function sourceFor(state: AgentRuntimeState): InteractionSource {
  return state.stateSource === 'hook' ? 'hook' : 'screen-classifier'
}

/**
 * Terminal-family asks are ALWAYS keystroke-emulated, whatever their source.
 *
 * A `hook`-sourced permission prompt is high-confidence about WHAT is being
 * asked and says nothing at all about how it can be answered: the answer still
 * has to reach a native menu as digits. Conflating the two would let a surface
 * believe it could reply structurally to a menu it can only type at.
 */
const TERMINAL_ANSWERABILITY: InteractionAnswerability = 'keystroke-emulated'

/**
 * IS THIS SOURCE'S ASK IDENTITY RELIABLE?
 *
 * `screen-classifier` is the only one that is not, and everything about dedupe
 * turns on it. A scraped menu has no id: the same frame re-rendered is a fresh
 * observation of one question, so those MUST collapse. Every other source fires
 * once per real ask — a Claude `PermissionRequest` hook, an SDK `canUseTool`
 * call, a protocol event — so two of them are two questions even when the text
 * is identical, and collapsing those is the opposite failure: a session running
 * `Bash: ls` twice would show one ask, answer it once, and stay blocked on the
 * second with nothing enumerable to show for it.
 */
export function hasReliableIdentity(source: InteractionSource): boolean {
  return source !== 'screen-classifier'
}

/**
 * The dedupe key: session + kind + the DECISION-BEARING payload fields, plus —
 * for identity-bearing sources only — an OCCURRENCE discriminator.
 *
 * Not a digest of the whole payload. Two observations of one permission prompt
 * can differ in incidental text (a truncated summary re-rendered at a different
 * width) while being the same ask, and a whole-payload hash would mint a
 * duplicate for exactly the case this exists to collapse. What goes in is what a
 * person would use to decide the two asks are the same question.
 *
 * `occurrence` is what stops that same reasoning from merging two GENUINELY
 * distinct asks. It is supplied only when {@link hasReliableIdentity}, and it is
 * the one place a timestamp legitimately enters the hash — the plan's pitfall
 * ("timestamps in the hash ⇒ duplicates") is about the classifier path, where
 * duplicates are the thing being suppressed. Here duplicates are the thing being
 * PRESERVED, so the discriminator is the point.
 */
export function interactionFingerprint(
  sessionId: SessionId,
  spec: InteractionAskSpec,
  occurrence?: string,
): string {
  const salient = ((): unknown => {
    switch (spec.kind) {
      case 'permission':
        return [spec.payload.toolName, spec.payload.inputSummary ?? '']
      case 'question':
        return spec.payload.questions.map((q) => [
          q.question,
          q.options.map((o) => o.label).join('\u0000'),
        ])
      case 'plan-approval':
        return spec.payload.plan
      case 'elicitation':
        return [spec.payload.serverName ?? '', spec.payload.message]
      case 'login':
        return [spec.payload.provider, spec.payload.reason]
      case 'recovery':
        return [spec.payload.reason, spec.payload.prompt]
    }
  })()
  return createHash('sha256')
    .update(
      `${sessionId}\u0000${spec.kind}\u0000${JSON.stringify(salient)}\u0000${occurrence ?? ''}`,
    )
    .digest('hex')
    .slice(0, 32)
}

/**
 * The one entry point: what ask, if any, does this state represent?
 *
 * Returns null for every state that is not a blocking ask — which is most of
 * them, and deliberately includes `idle` with an `open_todos` or `question`
 * verdict. An agent that STOPPED with a question in its last message is not
 * blocked on a menu; it is done, and the existing nudge/inbox machinery already
 * owns that case. Minting interactions for it would flood the aggregate with
 * rows nothing can answer structurally, and dilute the property §4 is for: an
 * open PendingInteraction means a session is stuck.
 */
export function synthesizeAsk(
  sessionId: SessionId,
  state: AgentRuntimeState,
  options: { readonly questionOptions?: QuestionPromptInput[] } = {},
): SynthesizedAsk | null {
  const spec = specFor(state, options.questionOptions)
  if (!spec) return null
  const source = sourceFor(state)
  // THE OCCURRENCE DISCRIMINATOR, for a source whose asks are real events.
  // `since` is the instant of the phase change that reported this ask, so two
  // sequential `Bash: ls` prompts — two `needs_user` transitions — hash apart
  // and stay two enumerable asks. A classifier observation gets none, so its
  // re-renders collapse.
  const occurrence = hasReliableIdentity(source) ? state.since : undefined
  return {
    spec,
    source,
    answerable: TERMINAL_ANSWERABILITY,
    fingerprint: interactionFingerprint(sessionId, spec, occurrence),
  }
}

/** The raw AskUserQuestion shape as it appears in the transcript's
 *  `toolInputJson` — every field optional, because it is provider JSON. */
export interface QuestionPromptInput {
  question?: string
  header?: string
  multiSelect?: boolean
  options?: Array<{ label?: string; description?: string; preview?: string }>
}

/**
 * The raw `questions[]` out of an AskUserQuestion's `toolInputJson`.
 *
 * A LOCAL PARSE RATHER THAN `parseAskQuestions`, and the reason is layering, not
 * preference: that function lives in
 * `packages/client-core/src/viewmodels/ask-question.ts`, and `apps/server` does
 * not declare `@podium/client-core` — the `declared-deps` boundary rule refuses
 * an undeclared import, and adding a client package to the server's dependencies
 * for one parser inverts the direction the boundary exists to protect.
 *
 * What is shared is the SHAPE and the RULES, which is what the plan asked for:
 * `QuestionPrompt` mirrors `AskQuestion` field for field (including `header`),
 * `previewLayout` is `isPreviewLayout`'s predicate verbatim, and `otherIndex`
 * follows the native rule below. The drop-malformed behaviour is the same too —
 * an entry without an options array is not a question.
 */

function specFor(
  state: AgentRuntimeState,
  questionOptions: QuestionPromptInput[] | undefined,
): InteractionAskSpec | null {
  if (state.phase === 'needs_user') {
    // AN UNREADABLE PROMPT IS STILL A BLOCKED SESSION (POD-2414).
    //
    // `needs_user` with no classified `need` is what an older daemon reports,
    // and what the observation path reports when it can see the session is
    // waiting and cannot say what for. Returning null here — which is what this
    // did — meant the ONE phase that literally means "a person has to do
    // something" produced nothing to do it from, and `onStateChanged` then
    // superseded whatever row was open. A question with no options is the
    // honest rendering: the aggregate says the session is blocked, the delivery
    // gate refuses to type digits at a menu it never read, and the card reads
    // "go look" rather than not existing.
    if (state.need === undefined) {
      return {
        kind: 'question',
        payload: { v: 1, questions: normalizeQuestions(undefined, UNREADABLE_PROMPT) },
      }
    }
    if (state.need?.kind === 'permission') {
      return {
        kind: 'permission',
        payload: {
          v: 1,
          // A permission ask with no tool name still happens — Claude's
          // `permission_prompt` Notification carries a rendered message and no
          // tool call. Naming it honestly beats dropping a real blocking ask.
          toolName: state.need.ask?.toolName ?? state.need.summary ?? 'unknown tool',
          ...(state.need.ask?.detail ? { inputSummary: state.need.ask.detail } : {}),
          canAlwaysAllow: state.need.ask?.canAlwaysAllow ?? false,
        },
      }
    }
    if (state.need?.kind === 'question') {
      return {
        kind: 'question',
        payload: { v: 1, questions: normalizeQuestions(questionOptions, state.need.summary) },
      }
    }
    return null
  }
  // Plan mode: the agent stopped for a verdict on a plan it wrote. This is the
  // one `idle` verdict that IS a blocking ask — the session will not proceed
  // until somebody approves or redirects.
  if (state.phase === 'idle' && state.idle?.kind === 'approval') {
    return {
      kind: 'plan-approval',
      payload: {
        v: 1,
        plan: state.idle.summary ?? '',
        // The plan menu's auto-accept row exists on Claude, but nothing in the
        // observed state proves it was drawn. Claiming it was would invite an
        // answer the digit path cannot deliver.
        autoAcceptOffered: false,
      },
    }
  }
  // THE ROUTING RULE (contract `FailureDisposition`), through the ONE gate:
  // a needs-human failure materializes as an interaction, so a session blocked
  // on credentials, on billing, on a usage cap or on an overflowed context is
  // an enumerable blocked session rather than one that silently stopped.
  //
  // The classification is `materialize.ts`'s and is not restated here — the
  // causal `TurnFailed` path reaches the same table, and a second copy of
  // "which failures need a human" is how one family's blocked sessions become
  // invisible again.
  if (state.phase === 'errored' && state.error) {
    return materializeFailure({
      evidence: 'agent-state',
      errorClass: state.error.class,
      retryable: state.error.retryable,
      ...(state.error.detail ? { detail: state.error.detail } : {}),
    })
  }
  return null
}

/**
 * The transcript's `questions[]` → typed prompts.
 *
 * `previewLayout` is computed HERE, once, from the rule the delivery path
 * already encodes (POD-770: a single-select question with any per-option
 * preview draws the side-by-side dialog, where a digit only moves the cursor).
 * Computing it at synthesis rather than at answer time is what lets a surface
 * that never touches the PTY still know the ask's shape.
 */
export function normalizeQuestions(
  raw: QuestionPromptInput[] | undefined,
  fallbackSummary: string | undefined,
): QuestionPrompt[] {
  const source = raw && raw.length > 0 ? raw : []
  const questions = source.map((q) => {
    const options = (q.options ?? []).map((o) => ({
      label: o.label ?? '',
      ...(o.description ? { description: o.description } : {}),
      ...(o.preview ? { preview: o.preview } : {}),
    }))
    const multiSelect = q.multiSelect === true
    // `isPreviewLayout`'s predicate, verbatim: the CLI's own rule, read out of
    // the bundle and confirmed on screen (POD-770).
    const previewLayout = !multiSelect && options.some((o) => (o.preview ?? '') !== '')
    return {
      question: q.question ?? fallbackSummary ?? '',
      ...(q.header ? { header: q.header } : {}),
      multiSelect,
      // THE NATIVE RULE: the synthetic Other row sits one past the last listed
      // option, 1-based — so `options.length + 1`. It exists only where the menu
      // draws it: never under `previewLayout` (that dialog has no Other row at
      // all — its free-text escape is a "Notes" field reached with `n`), and
      // never on an option-less prompt we could not read.
      ...(!previewLayout && options.length > 0 ? { otherIndex: options.length + 1 } : {}),
      previewLayout,
      options,
    }
  })
  // A live menu we could not read the options for is STILL an open ask: the
  // session is blocked either way, and a row with no options renders as "go
  // look" rather than vanishing. The delivery gate refuses to type digits at it,
  // which is the fail-closed behaviour that matters.
  if (questions.length > 0) return questions
  return [
    { question: fallbackSummary ?? '', multiSelect: false, previewLayout: false, options: [] },
  ]
}
