/**
 * THE DEAD-LETTER RECOVERY SURFACE (POD-316, ADR 3 D9 invariant 3).
 *
 * ADR 3 lists this as a mandatory product surface, not an optional toast, and
 * the reason is POD-279 finding 8: the client used to drop a refused write and
 * tell you so. Everything you had typed was gone, and the only recovery was your
 * memory of it.
 *
 * TWO RULES SHAPE THE WHOLE COMPONENT, and both are security properties rather
 * than design preferences:
 *
 * 1. IT NEVER READS THE TARGET. Not its title, not its body, not whether it
 *    still exists. An entry can be parked precisely BECAUSE the author lost
 *    visibility of the target while offline — a share was revoked, or the issue
 *    was reparented out of their subtree — and a surface that re-fetched the
 *    target to show "the issue you were editing" would hand back exactly the
 *    content the revocation removed. Everything rendered below comes from the
 *    parked entry itself: the author's own input, and a reason code. Discard and
 *    recover-my-text therefore work with no read at all, which is the only way
 *    they can work for an entity that is now invisible.
 *
 * 2. THE AFFORDANCES COME FROM THE REASON CODE, NEVER FROM THE SITUATION. The
 *    kernel merges "rights denied", "target invisible" and "target nonexistent"
 *    into one `unauthorized` code so the failure surface carries no existence
 *    oracle (ADR 3 Amendment 1 property 15). If this component withheld a button
 *    for one of those three, or wrote a more helpful sentence for it, the oracle
 *    would leak back out through the UI after the kernel carefully closed it.
 *    So the buttons are derived from `recoveryPlanFor(code)` and the words from
 *    `recoveryCopyFor(code)` — both functions of the code alone.
 */
import { asMutationId } from '@podium/model'

import { outboxCommandFor } from '@podium/client-core/engine'
import type { OutboxDeadLetterEntry } from '@podium/client-core/outbox'
import {
  describeQueuedChange,
  inlineConfirmationCanSatisfy,
  recoveryCopyFor,
  recoveryDialogCopy,
  unsatisfiableConfirmationDetail,
} from '@podium/client-core/outbox-recovery-copy'
import { shallowEqual } from '@podium/client-core/store'
import type { ConfirmationRule } from '@podium/commands'
import { recoveryPlanFor } from '@podium/sync/outbox'
import { AlertTriangle, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** The keys an author's own prose can arrive under, in the order we prefer them. */
const AUTHORED_KEYS = ['text', 'name', 'title', 'body', 'description'] as const

/**
 * WHERE THE PROSE SITS in a queued input, as a path rather than a key.
 *
 * It used to be a key, scanned at the top level only. POD-781 queued
 * `issues.update`, whose whole payload is `{ id, patch }` — the operator's new
 * title is one level down at `patch.title`. Under the old scan that entry showed
 * as raw JSON and "Save and send" wrote the input back unchanged, which is the
 * silent no-op version of the ONE recovery an `invalid` entry has.
 *
 * One level of nesting, not a deep walk: the queued inputs are flat commands or
 * a command around a single patch object, and a recursive search would start
 * offering to edit ids.
 */
/** Where the prose was found, and what it said — carried together so neither
 *  caller has to look it up a second time under a different set of casts. */
interface Authored {
  /** The key on `input` itself, or the key of the object the prose lives inside. */
  readonly outer: string
  /** The key WITHIN that object, when the prose is nested. */
  readonly inner?: string
  readonly value: string
}

/** The first prose-shaped key on one flat object, if any. */
function authoredIn(record: Record<string, unknown>): { key: string; value: string } | null {
  for (const key of AUTHORED_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return { key, value }
  }
  return null
}

function authoredAt(input: unknown): Authored | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const top = authoredIn(record)
  if (top) return { outer: top.key, value: top.value }
  for (const [outer, nested] of Object.entries(record)) {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue
    const found = authoredIn(nested as Record<string, unknown>)
    if (found) return { outer, inner: found.key, value: found.value }
  }
  return null
}

/** The author's own prose, pulled out of their own input for recovery. Opaque
 *  bookkeeping fields stay hidden; raw payload JSON made the old menu look like
 *  a debugger and exposed ids that did not help the person decide what to do. */
function authoredText(input: unknown): string | null {
  if (typeof input === 'string') return input
  return authoredAt(input)?.value ?? null
}

function DeadLetterRow({
  parked,
  lone,
}: {
  parked: OutboxDeadLetterEntry
  lone: boolean
}): JSX.Element {
  const recover = useStoreSelector((s) => s.recoverOutbox)
  const plan = recoveryPlanFor(parked.reason.code)
  const baseCopy = recoveryCopyFor(parked.reason.code)
  // THE CONSUMER for `CommandPolicy.confirmation` (POD-1224). A
  // `confirmation-required` refusal is only resolvable HERE when the contract's
  // rule is `confirm`; under `broker` the approval broker is the executor and a
  // checkbox in this dialog is not it, and under `none` the demand contradicts
  // the contract. In both of those the retry affordance is withheld and the
  // sentence says why — because offering a button that reproduces the same
  // refusal is the one thing this surface must never do.
  const rule = confirmationRuleFor(parked.entry.kind)
  const confirmable = plan.retry !== 'confirmation' || inlineConfirmationCanSatisfy(rule)
  const copy = confirmable
    ? baseCopy
    : { ...baseCopy, detail: unsatisfiableConfirmationDetail(rule), retryLabel: undefined }
  const [editing, setEditing] = useState(false)
  const authored = authoredText(parked.entry.input)
  const change = describeQueuedChange(parked.entry.kind, parked.entry.input)
  const [draft, setDraft] = useState(() => authored ?? '')
  const [failed, setFailed] = useState<string | null>(null)

  const onRetry = (): void => {
    try {
      // The satisfaction the reason demands. `retry` REFUSES a mismatch, so this
      // is not a formality — an authorization denial cannot be waved through
      // with a rebase, and the UI cannot offer a button that reproduces the same
      // refusal twice.
      switch (plan.retry) {
        case 'rights-fix':
          recover.retry(parked.entry.mutationId, { rightsFixed: true })
          break
        case 'rebase':
          // The Authority assigns the revision; sending the precondition back
          // unset asks it to apply on top of current truth.
          recover.retry(parked.entry.mutationId, { expectedRevision: 0 })
          break
        case 'confirmation':
          recover.retry(parked.entry.mutationId, { confirmed: true })
          break
        case 'new-mutation-id':
          // D11.4: the original id may still hold a receipt, so a re-issue must
          // mint a fresh one or the receipt would suppress it.
          recover.retry(parked.entry.mutationId, { mutationId: asMutationId(crypto.randomUUID()) })
          break
        case 'never':
          break
      }
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err))
    }
  }

  const canEdit = authored !== null
  const reasonText =
    !canEdit && copy.retryLabel === undefined
      ? `${copy.title}. Discard this change and try again.`
      : `${copy.title}. ${copy.detail}`

  const actions = editing ? (
    <>
      <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      <Button
        size="sm"
        onClick={() => {
          const input = parked.entry.input
          const next =
            input && typeof input === 'object'
              ? { ...(input as Record<string, unknown>), ...replaceAuthored(input, draft) }
              : draft
          recover.edit(parked.entry.mutationId, next)
        }}
      >
        Send updated
      </Button>
    </>
  ) : (
    <>
      <Button
        size="sm"
        variant={lone ? 'outline' : 'ghost'}
        className={cn(
          lone ? 'text-muted-foreground hover:text-destructive' : 'ml-auto text-muted-foreground hover:text-destructive',
        )}
        onClick={() => recover.discard(parked.entry.mutationId)}
      >
        <Trash2 size={14} aria-hidden="true" />
        Discard
      </Button>
      {/* Present only when retrying as-is CAN succeed. `invalid` has no
          retry label because no retry of the same bytes can be accepted —
          and that absence is a property of the CODE, so it never varies
          between two situations that share one. */}
      {copy.retryLabel && (
        <Button size="sm" data-testid="outbox-retry" onClick={onRetry}>
          <RotateCcw size={14} aria-hidden="true" />
          {copy.retryLabel}
        </Button>
      )}
      {canEdit && (
        <Button size="sm" variant={copy.retryLabel ? 'secondary' : 'default'} onClick={() => setEditing(true)}>
          <Pencil size={14} aria-hidden="true" />
          Edit
        </Button>
      )}
    </>
  )

  return (
    <li className={cn('flex flex-col', lone ? 'min-w-0' : 'gap-3 border-border/70 border-t px-5 py-4 first:border-t-0')}>
      <div className={cn('min-w-0', lone && 'px-5 pt-4')}>
        <h3 className="font-medium text-sm" data-testid="outbox-change-label">
          {change.label}
        </h3>
        {editing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            className="mt-3 text-sm"
            aria-label="Your text"
          />
        ) : (
          <>
            {authored !== null ? (
              <p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/70 px-3 py-2 text-sm leading-relaxed">
                {authored}
              </p>
            ) : change.summary ? (
              <p className="mt-1 text-sm leading-relaxed">{change.summary}</p>
            ) : null}
            <p className="mt-3 text-muted-foreground text-sm leading-relaxed">{reasonText}</p>
          </>
        )}
        {failed && (
          <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-destructive text-xs">{failed}</p>
        )}
      </div>

      <div
        className={cn(
          'flex flex-wrap items-center gap-2',
          lone
            ? 'mt-5 justify-end border-border/70 border-t bg-muted/50 px-5 py-3'
            : 'pt-1',
        )}
      >
        {actions}
      </div>
    </li>
  )
}

/** The contract's declared confirmation rule for a queued kind. Defaults to
 *  `broker` — the CLOSED arm — when the kind resolves to no contract: an
 *  unknown command is exactly the case where we must not assume a checkbox is
 *  enough. */
function confirmationRuleFor(kind: string): ConfirmationRule {
  // Sourced from the client's own contract table rather than by importing the
  // whole command registry into the browser bundle (`audit:browser-reach`). The
  // table's value is pinned EQUAL to the contract's by
  // `outbox-contract-table.test.ts`, so this is one statement of the policy with
  // a drift guard, not a second one.
  return outboxCommandFor(kind)?.confirmation ?? 'broker'
}

/** Put the edited prose back on the field it came from, so an edit of a rename
 *  revises `name` rather than replacing the whole input with a bare string —
 *  and an edit of an `issues.update` title revises `patch.title` rather than
 *  landing beside the patch where nothing reads it. Merged over the original
 *  input by the caller, so the nested arm rebuilds only the object it descends
 *  into and leaves that object's other keys intact. */
function replaceAuthored(input: unknown, next: string): Record<string, unknown> {
  const found = authoredAt(input)
  if (!found) return {}
  if (found.inner === undefined) return { [found.outer]: next }
  const nested = (input as Record<string, unknown>)[found.outer] as Record<string, unknown>
  return { [found.outer]: { ...nested, [found.inner]: next } }
}

/**
 * The header chip plus its dialog. Appears ONLY when something is parked: a
 * permanent "0 needing attention" is noise, and this has to read as an
 * interruption when it is real.
 */
export function OutboxRecoveryIndicator({ compact }: { compact?: boolean }): JSX.Element | null {
  const { deadLetters } = useStoreSelector(
    (s) => ({ deadLetters: s.outboxDeadLetters }),
    shallowEqual,
  )
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (deadLetters.length === 0) setOpen(false)
  }, [deadLetters.length])
  if (deadLetters.length === 0) return null

  const count = deadLetters.length
  const header = recoveryDialogCopy(count)
  const chipLabel = `${count} ${count === 1 ? 'change didn’t sync' : 'changes didn’t sync'}`
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-pressable
              onClick={() => setOpen(true)}
              data-testid="outbox-recovery-chip"
              className={cn(
                'inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-destructive',
                compact && 'min-w-[30px] justify-center px-1',
              )}
              aria-label={chipLabel}
            >
              <AlertTriangle size={14} aria-hidden="true" />
              {!compact && <span>{count} didn’t sync</span>}
            </button>
          }
        />
        <TooltipContent className="max-w-60 flex-col items-start gap-0.5">
          <strong>{chipLabel}</strong>
          <span className="text-background/70">Review or discard each one</span>
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-label={header.title}
          className="max-w-md gap-0 overflow-hidden p-0 sm:max-w-md"
        >
          <DialogHeader className="gap-1.5 px-5 pt-5 pr-12">
            <DialogTitle>{header.title}</DialogTitle>
            <DialogDescription>{header.detail}</DialogDescription>
          </DialogHeader>
          <ul className={cn('flex max-h-[60vh] flex-col overflow-auto', count > 1 && 'mt-2')}>
            {deadLetters.map((parked) => (
              <DeadLetterRow key={parked.entry.mutationId} parked={parked} lone={count === 1} />
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
