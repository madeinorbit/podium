/**
 * ANSWER RESOLUTION AND THE DEFAULT ANSWER TABLE (POD-2020, spec §4).
 *
 * ---------------------------------------------------------------------------
 * WHY RESOLUTION IS A LAYER AND NOT A CLIENT'S JOB
 * ---------------------------------------------------------------------------
 * The typed {@link InteractionAnswer} union is the contract, and it is precise:
 * a question answer names 1-based option indices, per prompt, in order. Nothing
 * that answers interactions naturally speaks that — an operator types "yes", the
 * CLI takes one string, a superagent writes a sentence. If every one of those
 * surfaces resolved text to indices itself there would be four matchers, and the
 * three that were not `matchAnswerToOptions` would be subtly wrong.
 *
 * So: surfaces send INTENT (free text, or an already-typed answer), and this
 * module resolves it against the ask's own recorded payload. The matcher itself
 * is `matchAnswerToOptions`, imported from the superagent answer-delivery module
 * rather than re-derived — the epic's instruction for this item is "wrap, don't
 * rewrite", and a second implementation of "does 'yes' mean option 1" is exactly
 * the drift that instruction is about.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT ANSWER TABLE IS NOT A POLICY ENGINE
 * ---------------------------------------------------------------------------
 * W2's scope says a per-session default answer table is enough, and names the
 * one entry that matters: recovery → full-resume, which is the spec's stated
 * policy default for every role profile ("Background executors auto-answer these
 * and never stall on startup"). One entry, applied at ask time, recorded with
 * `answeredBy: 'policy'`. There is no rule language, no allow-list, no
 * sandbox-awareness — those are the policy engine §4 describes and this item
 * explicitly defers.
 *
 * What is NOT in the table is the load-bearing part: `permission`,
 * `plan-approval` and `login` have NO default. A table that auto-allowed
 * permissions would be a security decision made by a default value, and the one
 * thing worse than a session stuck on a prompt is a session that granted
 * something because nobody configured otherwise.
 */

import type { InteractionAnswer, InteractionKind } from '@podium/protocol'
import { matchAnswerToOptions } from '../superagent/answer-delivery'
import type { InteractionAskSpec } from './synthesis'

/**
 * The per-session default answer table. Keyed by kind; a kind that is absent has
 * no default and escalates to a human.
 *
 * Only `recovery` is here, and only `full-resume`, per spec §4: "Policy default
 * for every role profile: resume the full session; summary-resume is chosen only
 * when the harness offers no full path."
 */
export const DEFAULT_ANSWERS: Partial<Record<InteractionKind, InteractionAnswer>> = {
  recovery: { kind: 'recovery', choice: 'full-resume' },
}

/**
 * The default answer for an ask, if the table has one AND the harness offers it.
 *
 * The offered-check is why this is a function and not a lookup: `full-resume` is
 * the policy, but a harness that only offers summary-resume cannot be sent it.
 * Falling back to what IS offered is right for recovery specifically — the spec
 * says summary-resume "is chosen only when the harness offers no full path", so
 * the fallback is the policy rather than a deviation from it.
 */
export function defaultAnswerFor(spec: InteractionAskSpec): InteractionAnswer | null {
  const preset = DEFAULT_ANSWERS[spec.kind]
  if (!preset) return null
  if (spec.kind === 'recovery' && preset.kind === 'recovery') {
    const offered = spec.payload.offered
    if (offered.includes(preset.choice)) return preset
    if (offered.includes('summary-resume')) return { kind: 'recovery', choice: 'summary-resume' }
    return null
  }
  return preset
}

export type AnswerResolution =
  | { ok: true; answer: InteractionAnswer }
  /** `message` is operator-facing and names what it could not resolve against —
   *  a refusal that does not show the options is a refusal nobody can act on. */
  | { ok: false; message: string }

/** Yes/no vocabularies, for the kinds whose answer is a verdict rather than a
 *  choice among listed options. Deliberately small: an unrecognised word is a
 *  refusal that lists what would work, never a guess at consent. */
const AFFIRM = new Set(['y', 'yes', 'allow', 'approve', 'ok', 'accept', 'once', 'allow-once'])
const AFFIRM_ALWAYS = new Set(['always', 'allow-always', 'yes-always', 'dont-ask', "don't-ask"])
const NEGATE = new Set(['n', 'no', 'deny', 'reject', 'refuse', 'cancel', 'decline'])

/**
 * Resolve free text against an ask, producing the typed answer.
 *
 * This is the CLI's and the superagent's entry point. A caller that already has
 * a typed answer skips it — the service accepts either.
 */
export function resolveAnswerText(spec: InteractionAskSpec, text: string): AnswerResolution {
  const t = text.trim()
  const lower = t.toLowerCase()
  switch (spec.kind) {
    case 'permission': {
      if (AFFIRM_ALWAYS.has(lower)) {
        // REFUSED, NOT DOWNGRADED. Answering `allow-once` instead would report a
        // persistent grant that was never made.
        if (!spec.payload.canAlwaysAllow) {
          return {
            ok: false,
            message:
              'this prompt did not offer an always-allow — answer `allow` for once, or set the rule in the harness',
          }
        }
        return { ok: true, answer: { kind: 'permission', decision: 'allow-always' } }
      }
      if (AFFIRM.has(lower)) return { ok: true, answer: { kind: 'permission', decision: 'allow-once' } }
      if (NEGATE.has(lower)) return { ok: true, answer: { kind: 'permission', decision: 'deny' } }
      return {
        ok: false,
        message: `could not read ${JSON.stringify(t)} as a permission decision — use allow, always, or deny`,
      }
    }
    case 'question': {
      const selections: { optionIndices: number[]; text?: string }[] = []
      for (const q of spec.payload.questions) {
        const labels = q.options.map((o) => o.label)
        if (labels.length === 0) {
          return {
            ok: false,
            message: `"${q.question}" has no readable options — answer it in the terminal`,
          }
        }
        const idx = matchAnswerToOptions(t, labels)
        if (idx.length === 0) {
          // The "Other" row is the free-text escape, and it only exists when the
          // menu drew one. Without it, unmatched text has nowhere to go.
          if (q.otherIndex !== undefined) {
            selections.push({ optionIndices: [q.otherIndex], text: t })
            continue
          }
          return {
            ok: false,
            message: `could not match ${JSON.stringify(t)} to the options: ${labels
              .map((l, i) => `${i + 1}) ${l}`)
              .join(', ')}`,
          }
        }
        selections.push({ optionIndices: q.multiSelect ? idx : idx.slice(0, 1) })
      }
      return { ok: true, answer: { kind: 'question', selections } }
    }
    case 'plan-approval': {
      if (AFFIRM.has(lower) || AFFIRM_ALWAYS.has(lower)) {
        return {
          ok: true,
          answer: {
            kind: 'plan-approval',
            decision: 'approve',
            ...(AFFIRM_ALWAYS.has(lower) && spec.payload.autoAcceptOffered
              ? { autoAcceptEdits: true }
              : {}),
          },
        }
      }
      if (NEGATE.has(lower)) return { ok: true, answer: { kind: 'plan-approval', decision: 'reject' } }
      // Anything else is treated as redirection, which is the useful reading:
      // an operator typing a paragraph at a plan is telling it what to change.
      return { ok: true, answer: { kind: 'plan-approval', decision: 'reject', feedback: t } }
    }
    case 'login': {
      if (AFFIRM.has(lower) || lower === 'done' || lower === 'completed') {
        return { ok: true, answer: { kind: 'login', outcome: 'completed' } }
      }
      if (NEGATE.has(lower)) return { ok: true, answer: { kind: 'login', outcome: 'cancelled' } }
      return {
        ok: false,
        message: `could not read ${JSON.stringify(t)} — answer \`done\` once the credential is refreshed, or \`cancel\``,
      }
    }
    case 'recovery': {
      const choice = spec.payload.offered.find((c) => c === lower || c.startsWith(lower))
      if (!choice) {
        return {
          ok: false,
          message: `could not read ${JSON.stringify(t)} — this ask offers: ${spec.payload.offered.join(', ')}`,
        }
      }
      return { ok: true, answer: { kind: 'recovery', choice } }
    }
    case 'elicitation': {
      if (NEGATE.has(lower)) return { ok: true, answer: { kind: 'elicitation', action: 'decline' } }
      // An elicitation wants a FORM, and free text is not one. Refusing beats
      // inventing a `content` object against a schema this layer holds as data.
      return {
        ok: false,
        message:
          'an elicitation needs structured content — answer it from a surface that renders the form, or `decline`',
      }
    }
  }
}

/**
 * The one-line rendering of an answer, for the CLI and the activity log.
 * Keyed the same way as everything else here, so a new kind cannot be added
 * without deciding how it reads.
 */
export function describeAnswer(answer: InteractionAnswer): string {
  switch (answer.kind) {
    case 'permission':
      return answer.decision
    case 'question':
      return answer.selections
        .map((s) => (s.text !== undefined ? `other: ${s.text}` : s.optionIndices.join('+')))
        .join(' | ')
    case 'plan-approval':
      return answer.decision === 'approve'
        ? `approve${answer.autoAcceptEdits ? ' (auto-accept edits)' : ''}`
        : `reject${answer.feedback ? `: ${answer.feedback}` : ''}`
    case 'elicitation':
      return answer.action
    case 'login':
      return answer.outcome
    case 'recovery':
      return answer.choice
  }
}

/** The one-line rendering of an ASK — what `podium interactions list` shows. */
export function describeAsk(spec: InteractionAskSpec): string {
  switch (spec.kind) {
    case 'permission':
      return `${spec.payload.toolName}${spec.payload.inputSummary ? `: ${spec.payload.inputSummary}` : ''}`
    case 'question':
      return spec.payload.questions.map((q) => q.question).join(' / ')
    case 'plan-approval':
      return spec.payload.plan.split('\n')[0] ?? 'plan awaiting approval'
    case 'elicitation':
      return spec.payload.message
    case 'login':
      return `${spec.payload.provider} (${spec.payload.reason})`
    case 'recovery':
      return spec.payload.prompt
  }
}
