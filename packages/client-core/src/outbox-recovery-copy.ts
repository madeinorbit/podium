/**
 * THE WORDS THE RECOVERY SURFACE SAYS, in ONE place (POD-316).
 *
 * This module is small and load-bearing, and the reason is a security property
 * rather than a style guide. ADR 3 Amendment 1 property 15 requires that no
 * failure surface distinguish a hidden entity from a missing one, and the kernel
 * enforces it where the reason is minted (`normalizeRefusal` merges
 * `unauthorized` with `target-not-found` into one byte-identical code). Copy is
 * where that merge is most easily undone: a well-meaning "you no longer have
 * access to this issue" reads as helpful and re-opens, in the UI, the existence
 * oracle the kernel closed — because a principal who never had access learns
 * from that sentence that the id exists.
 *
 * So every string below is written to be true for ALL the situations its code
 * covers at once. `unauthorized` covers three — rights denied, target invisible,
 * target nonexistent — and its copy names none of them.
 *
 * THE WORDING DECISION AND ITS RATIONALE (POD-316, no human available to ask).
 * The brief asked for an "actionable explanation" and offered "you no longer
 * have access to this issue" as the example; POD-370's kernel forbids exactly
 * that distinction and pins it with a byte-identical test. Both are satisfiable
 * at once, and the resolution is the level the copy speaks at:
 *
 *   - actionable AT THE REASON-CODE level — "this needs a permissions change,
 *     not an edit" tells the user what to DO, and is equally true whether the
 *     grant was revoked, the entity was deleted, or the id never existed;
 *   - silent AT THE TARGET level — no title, no id, no existence claim.
 *
 * Whether the product may ever say "the share was revoked" as distinct from "the
 * entity was deleted" stays OPEN (ADR 3 Amendment 1 §3 O1) and is a human's call
 * to make there, not a default to settle here. The safe wording is picked; the
 * question is recorded in `docs/agents/rewrite-fanout-ledger.md`.
 */

import type { ConfirmationRule } from '@podium/commands'
import type { OutboxRejectionCode } from '@podium/sync/outbox'

/** One clause naming what happened, for a toast. */
export function reasonSummary(code: OutboxRejectionCode): string {
  switch (code) {
    case 'unauthorized':
      // Deliberately says nothing about the target. See the header.
      return 'it was refused'
    case 'conflict':
      return 'someone else changed it first'
    case 'invalid':
      return 'it was not accepted as written'
    case 'confirmation-required':
      return 'it needs confirming'
    case 'max-age':
      return 'it waited too long to send'
  }
}

/** The sentence the recovery surface shows, and what to do about it. */
export interface RecoveryCopy {
  readonly title: string
  readonly detail: string
  /** Label for the retry affordance, or `undefined` when retrying as-is cannot
   *  succeed and only an edit can (`invalid`). The affordance SET never varies
   *  within a code — see `recoveryPlanFor`, which derives it from the code
   *  alone so two situations sharing a code share their buttons byte for byte. */
  readonly retryLabel: string | undefined
}

export function recoveryCopyFor(code: OutboxRejectionCode): RecoveryCopy {
  switch (code) {
    case 'unauthorized':
      return {
        title: 'Refused',
        // True for all three situations the code covers. It tells the user the
        // ONE thing that is actionable — retrying unchanged will not help,
        // something about permissions has to change first — without asserting
        // that the target exists.
        detail:
          'The server refused this change. Retrying it unchanged will not help; ' +
          'it needs a permissions change first, or you can edit it or discard it.',
        retryLabel: 'Retry after fixing access',
      }
    case 'conflict':
      return {
        title: 'Someone else got there first',
        detail:
          'This was written against an older version. Retry to reapply it on top of the current one, ' +
          'or edit it if their change means yours should read differently.',
        retryLabel: 'Retry on the latest version',
      }
    case 'invalid':
      return {
        title: 'Not accepted as written',
        detail: 'The server would not accept this. Edit it and send it again, or discard it.',
        retryLabel: undefined,
      }
    case 'confirmation-required':
      return {
        title: 'Needs confirming',
        detail:
          'This change reaches outside what you are working on, so it needs confirming before it applies.',
        retryLabel: 'Confirm and retry',
      }
    case 'max-age':
      return {
        title: 'Waited too long',
        detail:
          'This sat unsent for longer than the server remembers, so it cannot be sent under its ' +
          'original identity. Retry to send it as a new change, or discard it.',
        retryLabel: 'Send as a new change',
      }
  }
}

/** A short human label for an outbox entry kind, for the recovery list. Falls
 *  back to the raw kind: an unknown one must still be nameable, because the user
 *  has to be able to tell their queued changes apart. */
export function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    rename: 'Rename',
    setArchived: 'Archive',
    setWorkState: 'Work state',
    snoozeSet: 'Snooze',
    snoozeClear: 'Snooze cleared',
    sessionMarkRead: 'Mark read',
    sessionMarkUnread: 'Mark unread',
    issueMarkRead: 'Issue marked read',
    issueMarkUnread: 'Issue marked unread',
    issueSetTucked: 'Issue tucked',
    resumeAndSend: 'Message',
  }
  return labels[kind] ?? kind
}

/**
 * CAN AN INLINE CONFIRMATION SATISFY THIS REFUSAL? — the consumer for
 * `CommandPolicy.confirmation` (POD-1224's declared-but-unread item, disposed
 * here rather than deleted).
 *
 * THE CALL, and why routing beat deleting. The audit's disposition was "either
 * route the outbox refusal through it or delete it; it must not stay as an
 * unenforced duplicate", on the reading that the field restates a policy already
 * keyed by `overrideScope` server-side. That reading is right about the SERVER —
 * the authority decides confirmation there and the contract field adds nothing
 * to that decision. It is wrong about the CLIENT, which is where this issue
 * lives, because the recovery surface has a question the server's refusal does
 * not answer: *can the user do anything about this from here?*
 *
 * ADR 3 D2's three rules answer it differently, and the difference is the whole
 * affordance:
 *
 *   `confirm` — yes. A durable confirmation on the envelope (D8 outcome 3) is
 *               exactly what the retry needs, and the user can supply it.
 *   `broker`  — NO. The approval broker ([spec:SP-edbb]) is the confirmation
 *               executor; a checkbox in this dialog is not that, and offering
 *               one produces a retry refused identically — the button the
 *               affordance rule exists to forbid.
 *   `none`    — NO, and it means something is wrong: the authority demanded a
 *               confirmation for a contract that declares it never needs one.
 *               That is a contract/enforcement disagreement, not a user task,
 *               and the user cannot fix it by confirming harder.
 *
 * So the field gets a consumer that changes what the user sees, which is the
 * standard the audit sets — not a read that exists to satisfy the audit.
 */
export function inlineConfirmationCanSatisfy(rule: ConfirmationRule): boolean {
  switch (rule) {
    case 'confirm':
      return true
    case 'broker':
    case 'none':
      return false
  }
}

/** What to say when the refusal is real but this surface cannot resolve it. */
export function unsatisfiableConfirmationDetail(rule: ConfirmationRule): string {
  return rule === 'broker'
    ? 'This needs an approval from someone else before it can go through. Your text is kept here until it does.'
    : 'The server asked for a confirmation this change is not set up to carry. Report it; your text is kept here.'
}
