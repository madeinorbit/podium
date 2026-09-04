/**
 * THE BLOCKING-ASK CARD, AS DATA (POD-2414; spec §4).
 *
 * ---------------------------------------------------------------------------
 * WHY A VIEWMODEL AND NOT TWO CARDS
 * ---------------------------------------------------------------------------
 * §4's promise is that a blocking ask "renders in the web UI, the Tray, mobile,
 * and any attached CLI simultaneously" and that answering from any of them
 * resolves it everywhere. The resolving half is already structural — one durable
 * aggregate, one `interactions.answer` command. The RENDERING half is where two
 * shells drift: a React card and a React Native card, each deciding for itself
 * which kinds offer which buttons, is two answers to "can a human act on this",
 * and the wrong one is silent — a button that submits an answer the server
 * refuses, or a missing button that leaves a session blocked with a card that
 * only says so.
 *
 * So the decision lives here, once, as data. Each shell maps `actions` to its
 * own buttons and `note` to its own muted line, and neither shell decides
 * anything.
 *
 * ---------------------------------------------------------------------------
 * THE CARD NEVER OFFERS WHAT THE SERVER WOULD REFUSE
 * ---------------------------------------------------------------------------
 * The server is still the authority: `unsupportedAnswerReason` refuses a
 * keystroke `permission` (POD-707) and a `structured` ask with no route, and
 * `deliverableText` refuses an answer with no form the session can receive. This
 * module mirrors those refusals so the card can SAY why instead of presenting a
 * button that fails — and when the two disagree the server wins, which is the
 * safe direction: the answer is refused and the ask stays open.
 *
 * `note` is therefore never decoration. It is the sentence a person needs when
 * the honest answer is "go to the terminal", and a card without it would be a
 * card that just shrugs.
 */

import type { InteractionAnswer, PendingInteractionWire, QuestionPrompt } from '@podium/protocol'
import { hasTranscriptCard, isResumeTimeRecovery } from '@podium/protocol'

/** One button. `answer` is the typed value `interactions.answer` takes, so a
 *  shell submits it verbatim and never constructs one. */
export interface PendingInteractionAction {
  /** Stable within a card — a React key, and the id a test presses. */
  readonly id: string
  readonly label: string
  /**
   * `primary` is the action the ask exists to get (allow, approve, resume).
   * `danger` refuses or abandons. `neutral` is everything else. Shells map these
   * to their own tokens; nothing here knows a colour.
   */
  readonly tone: 'primary' | 'neutral' | 'danger'
  readonly answer: InteractionAnswer
}

export interface PendingInteractionCard {
  readonly id: string
  readonly sessionId: string
  readonly kind: PendingInteractionWire['kind']
  /** The eyebrow — what KIND of thing stopped, in three words. */
  readonly title: string
  /** The ask itself, as a person reads it. Never empty: a row with an
   *  unparseable payload still says a session is blocked, and that sentence is
   *  the whole reason the row exists. */
  readonly detail: string
  readonly actions: readonly PendingInteractionAction[]
  /** Why there is nothing to press, when there is nothing to press. */
  readonly note?: string
  /**
   * WHICH SURFACE OWNS THE RENDER.
   *
   * `transcript` means a richer card already exists in the conversation and this
   * ask should not be drawn twice: a `question` with readable options is the
   * AskUserQuestion card, which shows the option descriptions, the previews and
   * the multi-select rail that this generic card cannot. `aggregate` is
   * everything else — the kinds nothing in the transcript renders, and the
   * questions whose options could not be read.
   *
   * A shell that has no transcript card (a tray popover, a list view) may render
   * both; the flag says who is BETTER, not who is allowed.
   */
  readonly surface: 'aggregate' | 'transcript'
}

/**
 * A durable row → the card.
 *
 * Total over the kind union by construction — the switch has no default, so a
 * seventh kind is a compile error here rather than a blank card in two shells.
 */
export function pendingInteractionCard(row: PendingInteractionWire): PendingInteractionCard {
  const base = { id: row.id, sessionId: row.sessionId, kind: row.kind } as const
  switch (row.kind) {
    case 'permission': {
      const detail = row.payload.inputSummary
        ? `${row.payload.toolName}: ${row.payload.inputSummary}`
        : row.payload.toolName
      // KEYSTROKE PERMISSION IS UNSHIPPED (POD-707) — the native menu's ordinals
      // vary per ask, so a "deny" press can approve. The card says so instead of
      // offering a button whose failure mode is granting something.
      if (row.answerable !== 'structured') {
        return {
          ...base,
          title: 'Permission needed',
          detail,
          actions: [],
          note: 'Podium cannot press this menu safely — its option order changes per ask. Answer it in the terminal.',
          surface: 'aggregate',
        }
      }
      return {
        ...base,
        title: 'Permission needed',
        detail,
        actions: [
          {
            id: 'allow',
            label: 'Allow once',
            tone: 'primary',
            answer: { kind: 'permission', decision: 'allow-once' },
          },
          ...(row.payload.canAlwaysAllow
            ? ([
                {
                  id: 'allow-always',
                  label: 'Always allow',
                  tone: 'neutral',
                  answer: { kind: 'permission', decision: 'allow-always' },
                },
              ] as const)
            : []),
          {
            id: 'deny',
            label: 'Deny',
            tone: 'danger',
            answer: { kind: 'permission', decision: 'deny' },
          },
        ],
        surface: 'aggregate',
      }
    }
    case 'question': {
      const first = row.payload.questions[0]
      const readable = questionIsPressable(row.payload.questions)
      // WHO HAS THE RICHER CARD — not "is it readable" (POD-2414 review, P1/3).
      //
      // Deferring to the transcript is only correct where a transcript card
      // EXISTS, and the predicate for that is the contract's
      // ({@link hasTranscriptCard}), shared with the server's delivery route so
      // the two cannot drift. Two sources have no transcript item behind them:
      // an opencode `question.asked`, which is a structured protocol
      // interaction on a family that has no terminal to fall back to; and a
      // screen-classified dialog, which is read off the screen precisely
      // because the CLI drew it without a tool call. Deferring hid the only
      // answerable row either one has.
      const transcriptOwnsIt = readable && hasTranscriptCard(row)
      return {
        ...base,
        title: 'Question',
        detail: row.payload.questions.map((q) => q.question).join(' / ') || 'Waiting on an answer.',
        // ONE QUESTION, SINGLE-SELECT, WITH OPTIONS is the only shape a generic
        // card can answer without re-implementing the transcript card's rail,
        // previews and multi-select collection. Anything else defers rather than
        // offering half a dialog.
        actions:
          readable && first
            ? first.options.map((option, index) => ({
                id: `option-${index + 1}`,
                label: option.label,
                tone: index === 0 ? ('primary' as const) : ('neutral' as const),
                answer: {
                  kind: 'question' as const,
                  selections: [{ optionIndices: [index + 1] }],
                },
              }))
            : [],
        ...(readable ? {} : { note: UNPRESSABLE_QUESTION }),
        surface: transcriptOwnsIt ? 'transcript' : 'aggregate',
      }
    }
    case 'plan-approval':
      return {
        ...base,
        title: 'Plan awaiting approval',
        detail: row.payload.plan.trim() || 'The agent stopped for a verdict on its plan.',
        actions: [
          {
            id: 'approve',
            label: 'Approve',
            tone: 'primary',
            answer: { kind: 'plan-approval', decision: 'approve' },
          },
          {
            id: 'reject',
            label: 'Not yet',
            tone: 'danger',
            answer: { kind: 'plan-approval', decision: 'reject' },
          },
        ],
        surface: 'aggregate',
      }
    case 'login':
      return {
        ...base,
        title: 'Sign-in needed',
        detail: loginDetail(row.payload.provider, row.payload.reason, row.payload.url),
        // THE ANSWER IS A REPORT, NOT A CREDENTIAL. Nothing here collects a
        // secret; `completed` means "I refreshed it elsewhere, retry".
        actions: [
          {
            id: 'completed',
            label: 'I signed in — retry',
            tone: 'primary',
            answer: { kind: 'login', outcome: 'completed' },
          },
          {
            id: 'cancelled',
            label: 'Stop waiting',
            tone: 'danger',
            answer: { kind: 'login', outcome: 'cancelled' },
          },
        ],
        surface: 'aggregate',
      }
    case 'recovery': {
      /**
       * A RESUME-TIME PROMPT HAS NO BUTTON (POD-2414 re-verdict, P0/2).
       *
       * `cache-miss`/`trust-prompt` on the keystroke path is refused by the
       * server BEFORE it claims the row — every answer it could make is prose
       * over the durable send path, which would queue behind the very prompt
       * holding startup. Rendering "Resume the session" there offers a button
       * the server always refuses: the session is enumerable, which is half of
       * what §§3-4 promise, and answering it from here is a dead end.
       *
       * So the card SAYS that instead of pretending. The predicate is the
       * contract's, not a second copy — {@link isResumeTimeRecovery} is what
       * the server's own answerability check reads.
       */
      if (row.answerable === 'keystroke-emulated' && isResumeTimeRecovery(row.payload.reason)) {
        return {
          ...base,
          title: 'Session blocked at startup',
          detail:
            `${row.payload.prompt.trim() || 'This session is waiting on a resume decision.'} ` +
            'Podium cannot answer this one for you — open the terminal to resolve it.',
          actions: [],
          surface: 'aggregate',
        }
      }
      const actions = row.payload.offered.flatMap((choice) => {
        const label = RECOVERY_LABELS[choice]
        // `fresh-session` has no answer path — it means spawning a NEW session,
        // a different verb the answer command does not perform. Offering it
        // would be a button that reports something that did not happen.
        if (!label) return []
        return [
          {
            id: choice,
            label,
            tone: choice === 'abandon' ? ('danger' as const) : ('primary' as const),
            answer: { kind: 'recovery' as const, choice },
          },
        ]
      })
      return {
        ...base,
        title: 'Session blocked',
        detail: row.payload.prompt.trim() || 'This session is waiting on a recovery decision.',
        actions,
        ...(actions.length === 0
          ? { note: 'This session offers no recovery Podium can perform. Open the terminal.' }
          : {}),
        surface: 'aggregate',
      }
    }
    case 'elicitation':
      return {
        ...base,
        title: 'Input needed',
        detail: row.payload.serverName
          ? `${row.payload.serverName}: ${row.payload.message}`
          : row.payload.message,
        // AN ELICITATION WANTS A FORM. Declining is the one verdict that needs
        // no schema, so it is the one action offered; anything else would be a
        // guess at a structured value.
        actions: [
          {
            id: 'decline',
            label: 'Decline',
            tone: 'danger',
            answer: { kind: 'elicitation', action: 'decline' },
          },
        ],
        note: 'Filling this in needs the form the requesting tool defined — answer it where that form is rendered.',
        surface: 'aggregate',
      }
  }
}

/** The cards for one session's open asks, in the order they were asked. */
export function pendingInteractionCards(
  rows: readonly PendingInteractionWire[],
  sessionId: string,
): PendingInteractionCard[] {
  return rows
    .filter((row) => row.sessionId === sessionId && row.status === 'asked')
    .slice()
    .sort((a, b) => (a.askedAt < b.askedAt ? -1 : a.askedAt > b.askedAt ? 1 : 0))
    .map(pendingInteractionCard)
}

const UNPRESSABLE_QUESTION =
  'Podium could not read this prompt’s options, so it cannot answer it for you. Open the terminal to see it.'

/**
 * No entry means no answer path — see the `fresh-session` note above.
 *
 * `abandon` has none either (POD-2414 review, P1/2): every keystroke answer
 * reaches a session through the durable send path, so "stop waiting" was
 * delivered by WAKING the session it claimed to stop. A harness that really
 * offers it needs a route that dismisses; until one exists, a button that did
 * the opposite of its label is worse than no button.
 */
const RECOVERY_LABELS: Partial<Record<PendingRecoveryChoice, string>> = {
  'full-resume': 'Resume the session',
  'summary-resume': 'Resume from a summary',
}

type PendingRecoveryChoice = Extract<InteractionAnswer, { kind: 'recovery' }>['choice']

/**
 * Can a generic card press this question?
 *
 * The rule mirrors the server's, and both halves are load-bearing: a question
 * with no readable options is refused by `resolveAnswerText`, and a
 * preview-layout dialog has no Other row and commits on a carriage return
 * (POD-770), so a digit sent at it selects the wrong thing. Several questions
 * need the transcript card's tab rail to answer in order.
 */
function questionIsPressable(questions: readonly QuestionPrompt[]): boolean {
  if (questions.length !== 1) return false
  const only = questions[0]
  if (!only) return false
  return only.options.length > 0 && !only.previewLayout && !only.multiSelect
}

function loginDetail(provider: string, reason: string, url?: string): string {
  const why =
    reason === 'not-signed-in'
      ? 'is not signed in'
      : reason === 're-auth'
        ? 'needs to be signed in again'
        : 'credential has expired'
  return `${provider} ${why}.${url ? ` Sign in at ${url}, then say so here.` : ''}`
}
