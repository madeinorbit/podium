import { shallowEqual } from '@podium/client-core/store'
import { describeApprovalOp } from '@podium/protocol'
import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useStoreSelector } from './store'

/**
 * Approval broker popup [spec:SP-edbb] (#410): an agent asked to run a
 * management op (update / stop / channel / set-server). Shows WHO is asking
 * (machine + issue + session, with a one-click jump via the central
 * navigate-to-session action [spec:SP-a1c0]) and exactly WHAT would run —
 * ops like set-server render their target, because an approval dialog only
 * protects when the user can see what they're approving.
 */
export function ApprovalDialog(): JSX.Element | null {
  const { trpc, approvals, navigateToSession } = useStoreSelector(
    (s) => ({ trpc: s.trpc, approvals: s.approvals, navigateToSession: s.navigateToSession }),
    shallowEqual,
  )
  const [busy, setBusy] = useState(false)
  const current = approvals[0]
  if (!current) return null

  const decide = async (approve: boolean) => {
    setBusy(true)
    try {
      if (approve) await trpc.approvals.approve.mutate({ id: current.id })
      else await trpc.approvals.deny.mutate({ id: current.id })
    } catch {
      // Best-effort: the broadcast will re-sync the pending list either way.
    }
    setBusy(false)
  }

  const from = [
    current.machineName ?? current.machineId,
    current.issueSeq != null ? `#${current.issueSeq} ${current.issueTitle ?? ''}`.trim() : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Dialog
      open
      onOpenChange={() => {
        // No silent dismissal: closing without deciding keeps the request
        // pending (it re-opens on the next change/attach) — an approval must be
        // an explicit approve or deny, never an accidental escape key.
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Agent requests approval</DialogTitle>
          <DialogDescription>
            {from ? `An agent (${from}) wants to:` : 'An agent wants to:'}
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-md border bg-muted px-3 py-2 font-mono text-[13px]">
          {describeApprovalOp(current.op)}
        </p>
        {approvals.length > 1 ? (
          <p className="text-[12px] text-muted-foreground">
            {approvals.length - 1} more request{approvals.length > 2 ? 's' : ''} waiting behind this
            one.
          </p>
        ) : null}
        <DialogFooter className="items-center sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigateToSession(current.sessionId)}
            disabled={busy}
          >
            Go to session
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
              Deny
            </Button>
            <Button disabled={busy} onClick={() => void decide(true)}>
              Approve
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
