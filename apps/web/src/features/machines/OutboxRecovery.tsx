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

import { outboxCommandFor } from '@podium/client-core/engine'
import type { OutboxDeadLetterEntry } from '@podium/client-core/outbox'
import {
  inlineConfirmationCanSatisfy,
  kindLabel,
  recoveryCopyFor,
  unsatisfiableConfirmationDetail,
} from '@podium/client-core/outbox-recovery-copy'
import { shallowEqual } from '@podium/client-core/store'
import type { ConfirmationRule } from '@podium/commands'
import { recoveryPlanFor } from '@podium/sync/outbox'
import { AlertTriangle } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** The author's own text, pulled out of their own input for display and export.
 *  A best-effort projection over an opaque payload — when nothing reads as prose
 *  we show the input as JSON rather than showing nothing, because the entire
 *  point is that the user can get their words back. */
function authoredText(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    for (const key of ['text', 'name', 'title', 'body', 'description']) {
      const value = (input as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return JSON.stringify(input, null, 2)
}

function DeadLetterRow({ parked }: { parked: OutboxDeadLetterEntry }): JSX.Element {
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
  const [draft, setDraft] = useState(() => authoredText(parked.entry.input))
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
          recover.retry(parked.entry.mutationId, { mutationId: crypto.randomUUID() })
          break
        case 'never':
          break
      }
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-sm">{copy.title}</span>
        <span className="text-muted-foreground text-xs">{kindLabel(parked.entry.kind)}</span>
      </div>
      <p className="text-muted-foreground text-xs">{copy.detail}</p>

      {/* THE USER'S OWN WORDS. Never the target's. */}
      {editing ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          className="text-xs"
          aria-label="Your text"
        />
      ) : (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
          {authoredText(parked.entry.input)}
        </pre>
      )}

      {failed && <p className="text-destructive text-xs">{failed}</p>}

      <div className="flex flex-wrap gap-2">
        {editing ? (
          <>
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
              Save and send
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {/* Present only when retrying as-is CAN succeed. `invalid` has no
                retry label because no retry of the same bytes can be accepted —
                and that absence is a property of the CODE, so it never varies
                between two situations that share one. */}
            {copy.retryLabel && (
              <Button size="sm" data-testid="outbox-retry" onClick={onRetry}>
                {copy.retryLabel}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigator.clipboard?.writeText(authoredText(parked.entry.input))}
            >
              Copy my text
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => recover.discard(parked.entry.mutationId)}
            >
              Discard
            </Button>
          </>
        )}
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
 *  revises `name` rather than replacing the whole input with a bare string. */
function replaceAuthored(input: unknown, next: string): Record<string, unknown> {
  if (input && typeof input === 'object') {
    for (const key of ['text', 'name', 'title', 'body', 'description']) {
      if (typeof (input as Record<string, unknown>)[key] === 'string') return { [key]: next }
    }
  }
  return {}
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
              aria-label={`${count} ${count === 1 ? 'change needs' : 'changes need'} your attention`}
            >
              <AlertTriangle size={14} aria-hidden="true" />
              {!compact && <span>{count} needs you</span>}
            </button>
          }
        />
        <TooltipContent className="max-w-60 flex-col items-start gap-0.5">
          <strong>
            {count} {count === 1 ? 'change' : 'changes'} the server refused
          </strong>
          <span className="text-background/70">Your text is kept — click to recover it</span>
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Changes that need you</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-xs">
            These were refused by the server, so they were not applied. Nothing you wrote has been
            thrown away.
          </p>
          <ul className="flex max-h-[60vh] flex-col gap-2 overflow-auto">
            {deadLetters.map((parked) => (
              <DeadLetterRow key={parked.entry.mutationId} parked={parked} />
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
