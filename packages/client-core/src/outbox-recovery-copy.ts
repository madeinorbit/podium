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
 * `describeQueuedChange` is allowed to name WHAT THE AUTHOR SENT — their own
 * title, stage, labels — because that is the parked input, not a read of the
 * target. It must never echo identifiers (`id`, `sessionId`, `parentId`,
 * `machineId`, `originId`, `assignee`) or claim that the target exists.
 *
 * Whether the product may ever say "the share was revoked" as distinct from "the
 * entity was deleted" stays OPEN (ADR 3 Amendment 1 §3 O1) and is a human's call
 * to make there, not a default to settle here. The safe wording is picked; the
 * question is recorded in `docs/agents/rewrite-fanout-ledger.md`.
 */

import type { ConfirmationRule } from '@podium/commands'
import type { IssueStage } from '@podium/model'
import type { OutboxRejectionCode } from '@podium/sync/outbox'
import { ISSUE_STAGE_LABELS } from './viewmodels/issue-reference'

/** One clause naming what happened, for a toast. */
export function reasonSummary(code: OutboxRejectionCode): string {
  switch (code) {
    case 'unauthorized':
      // Deliberately says nothing about the target. See the header.
      return 'it was refused'
    case 'conflict':
      return 'someone else saved first'
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
        title: 'Needs access first',
        // True for all three situations the code covers. It tells the user the
        // ONE thing that is actionable — retrying unchanged will not help,
        // something about permissions has to change first — without asserting
        // that the target exists.
        detail: 'Retry only after access has changed.',
        retryLabel: 'Retry after fixing access',
      }
    case 'conflict':
      return {
        title: 'Someone else saved first',
        detail: 'Retry to apply your change on top of the latest version.',
        retryLabel: 'Retry on latest',
      }
    case 'invalid':
      return {
        title: 'Not accepted as written',
        detail: 'Edit the text and send it again, or discard this change.',
        retryLabel: undefined,
      }
    case 'confirmation-required':
      return {
        title: 'Needs confirmation',
        detail: 'Confirm this change, then send it again.',
        retryLabel: 'Confirm and retry',
      }
    case 'max-age':
      return {
        title: 'Took too long to send',
        detail: 'Send it again as a new change.',
        retryLabel: 'Send again',
      }
  }
}

export function recoveryDialogCopy(count: number): { title: string; detail: string } {
  if (count === 1) {
    return {
      title: 'Couldn’t save this change',
      detail: 'It didn’t reach the server.',
    }
  }
  return {
    title: `Couldn’t save ${count} changes`,
    detail: 'They didn’t reach the server. Decide what to do with each one.',
  }
}

/** A short human label for an outbox entry kind, for the recovery list. Falls
 *  back to the raw kind: an unknown one must still be nameable, because the user
 *  has to be able to tell their queued changes apart. */
export function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    rename: 'Session rename',
    setArchived: 'Session archive',
    setWorkState: 'Session work state',
    snoozeSet: 'Session snooze',
    snoozeClear: 'Clear session snooze',
    sessionMarkRead: 'Session read status',
    sessionMarkUnread: 'Session unread status',
    issueMarkRead: 'Issue read status',
    issueMarkUnread: 'Issue unread status',
    issueSetTucked: 'Issue visibility',
    // POD-781. `issueUpdate` is one kind carrying any of two dozen fields, so it
    // gets the honest generic label rather than a guess at which one the user
    // changed — `describeQueuedChange` specializes it from the patch keys.
    issueUpdate: 'Issue change',
    issueArchive: 'Issue archived',
    issueDelete: 'Issue deleted',
    // Named per COMMAND, unlike `issueUpdate` above: each of these carries one
    // act, so the label can say which one without guessing.
    issueClose: 'Issue closed',
    issueDefer: 'Issue snoozed',
    issueUndefer: 'Issue unsnoozed',
    issueSetLabels: 'Issue labels',
    issueSetPlacement: 'Issue moved',
    issueRestore: 'Issue restored',
    resumeAndSend: 'Message to agent',
  }
  return labels[kind] ?? kind
}

/** What the author tried to send, named from THEIR input only. Never a target
 *  read: no fetched title, no existence claim, no identifier echoed. */
export interface QueuedChangeView {
  readonly label: string
  /** A short, ID-free description when the author's prose is not already on
   *  screen. Null when the label plus the prose preview is enough. */
  readonly summary: string | null
}

const PATCH_FIELD_NOUNS: Record<string, string> = {
  title: 'title',
  description: 'description',
  brief: 'brief',
  stage: 'stage',
  parentBranch: 'branch',
  defaultAgent: 'agent',
  defaultModel: 'model',
  defaultEffort: 'effort',
  machineId: 'assigned machine',
  archived: 'archive state',
  priority: 'priority',
  type: 'type',
  assignee: 'assignee',
  parentId: 'parent',
  design: 'design',
  acceptance: 'acceptance',
  notes: 'notes',
  dueAt: 'due date',
  deferUntil: 'snooze',
  closedReason: 'close reason',
  pinned: 'pin',
  sortKey: 'order',
  color: 'color',
  estimateMin: 'estimate',
}

export function describeQueuedChange(kind: string, input: unknown): QueuedChangeView {
  switch (kind) {
    case 'issueUpdate':
      return describeIssueUpdate(input)
    case 'issueSetTucked':
      return {
        label: kindLabel(kind),
        summary: record(input)?.tucked === true ? 'Hidden from the list' : 'Shown in the list',
      }
    case 'issueSetLabels': {
      const labels = record(input)?.labels
      return {
        label: kindLabel(kind),
        summary: Array.isArray(labels) ? formatLabels(labels) : null,
      }
    }
    case 'issueSetPlacement': {
      const placement = record(input)?.placement
      return {
        label: kindLabel(kind),
        summary:
          placement === 'own'
            ? 'Moved to your board'
            : placement === 'mission'
              ? 'Moved to the mission'
              : null,
      }
    }
    case 'issueClose': {
      const reason = record(input)?.reason
      return {
        label: kindLabel(kind),
        summary: typeof reason === 'string' && reason.length > 0 ? reason : null,
      }
    }
    case 'issueDefer': {
      const until = record(input)?.until
      return {
        label: kindLabel(kind),
        summary: until == null ? 'Snooze cleared' : formatWhen(until),
      }
    }
    case 'snoozeSet': {
      const until = record(input)?.until
      return {
        label: kindLabel(kind),
        summary: until == null ? 'Snooze cleared' : formatWhen(until),
      }
    }
    default:
      return { label: kindLabel(kind), summary: null }
  }
}

/** Toast line: names the change from the author's input, never the target. */
export function deadLetterNotice(kind: string, input: unknown, code: OutboxRejectionCode): string {
  return `${describeQueuedChange(kind, input).label} didn’t sync — ${reasonSummary(code)}`
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
    ? 'An approval is required before this can be sent.'
    : 'This change cannot carry the confirmation the server requested.'
}

function describeIssueUpdate(input: unknown): QueuedChangeView {
  const patch = record(record(input)?.patch)
  if (!patch) return { label: kindLabel('issueUpdate'), summary: null }
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined)
  if (keys.length === 0) return { label: kindLabel('issueUpdate'), summary: null }
  if (keys.length === 1) {
    const key = keys[0]!
    return describeSinglePatchField(key, patch[key])
  }
  const nouns = keys.map((key) => PATCH_FIELD_NOUNS[key]).filter((noun): noun is string => Boolean(noun))
  return {
    label: 'Issue update',
    summary: nouns.length > 0 ? capitalize(listEnglish(nouns)) : null,
  }
}

function describeSinglePatchField(key: string, value: unknown): QueuedChangeView {
  switch (key) {
    case 'title':
      return { label: 'Issue title', summary: null }
    case 'description':
      return { label: 'Issue description', summary: null }
    case 'brief':
      return { label: 'Issue brief', summary: null }
    case 'notes':
      return { label: 'Issue notes', summary: null }
    case 'design':
      return { label: 'Issue design', summary: null }
    case 'acceptance':
      return { label: 'Issue acceptance', summary: null }
    case 'closedReason':
      return { label: 'Issue close reason', summary: null }
    case 'stage':
      return { label: 'Issue stage', summary: stageSummary(value) }
    case 'priority':
      return {
        label: 'Issue priority',
        summary: typeof value === 'number' && Number.isInteger(value) ? `Set to P${value}` : null,
      }
    case 'type':
      return {
        label: 'Issue type',
        summary: typeof value === 'string' && value.length > 0 ? `Set to ${value}` : null,
      }
    case 'parentBranch':
      return {
        label: 'Issue branch',
        summary: typeof value === 'string' && value.length > 0 ? value : null,
      }
    case 'defaultAgent':
      return {
        label: 'Default agent',
        summary: typeof value === 'string' && value.length > 0 ? value : null,
      }
    case 'defaultModel':
      return {
        label: 'Default model',
        summary: typeof value === 'string' && value.length > 0 ? value : null,
      }
    case 'defaultEffort':
      return {
        label: 'Default effort',
        summary: typeof value === 'string' && value.length > 0 ? value : null,
      }
    case 'archived':
      return { label: value === true ? 'Issue archived' : 'Issue unarchived', summary: null }
    case 'pinned':
      return { label: value === true ? 'Issue pinned' : 'Issue unpinned', summary: null }
    case 'color':
      return {
        label: 'Issue color',
        summary: value == null ? 'Color cleared' : typeof value === 'string' ? `Set to ${value}` : null,
      }
    case 'dueAt':
      return { label: 'Issue due date', summary: formatWhen(value) }
    case 'deferUntil':
      return { label: 'Issue snooze', summary: formatWhen(value) }
    case 'estimateMin':
      return {
        label: 'Issue estimate',
        summary: typeof value === 'number' ? `${value} min` : null,
      }
    case 'machineId':
      return { label: 'Assigned machine', summary: 'Changed the assigned machine' }
    case 'parentId':
      return { label: 'Issue moved', summary: 'Moved under another issue' }
    case 'assignee':
      return { label: 'Issue assignee', summary: 'Changed the assignee' }
    case 'sortKey':
      return { label: 'Issue order', summary: 'Reordered' }
    default:
      return { label: kindLabel('issueUpdate'), summary: null }
  }
}

function stageSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = ISSUE_STAGE_LABELS[value as IssueStage]
  return label ? `Moved to ${label}` : null
}

function formatLabels(labels: unknown[]): string {
  const names = labels.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return names.length > 0 ? names.join(', ') : 'Cleared labels'
}

function formatWhen(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || value.length === 0) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function listEnglish(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]!
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function capitalize(value: string): string {
  if (value.length === 0) return value
  return value[0]!.toUpperCase() + value.slice(1)
}
