import { here } from '@podium/client-graph/lookup'
import type { EffectModel } from '@podium/client-graph/models'
import { observer } from '@podium/client-graph/react'
import { ApprovalOp, describeApprovalOp, formatLong } from '@podium/protocol'
import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useShellActions, useShellApprovals } from './shell-data'
import { useWorklistPool } from './store-worklist-pool'

/**
 * Approval broker popup [spec:SP-edbb] (#410): an agent asked to run a
 * management op (update / stop / channel / set-server). Shows WHO is asking
 * (machine · issue, with a one-click jump via the central navigate-to-session
 * action [spec:SP-a1c0]) and exactly WHAT would run — ops like set-server
 * render their target, because an approval dialog only protects when the user
 * can see what they're approving.
 *
 * The request is an `approval` effect record (POD-6674): it shows on every
 * device of the person it is routed to, after a restart and offline from the
 * saved copy, and a decision is an edit of that record, queued like any other.
 * An operation this app version cannot read is shown as such and cannot be
 * approved from here.
 *
 * Deliberately NON-modal: a fixed corner card with no overlay/blur, so the
 * user can inspect the requesting session (or anything else) before deciding.
 * There is no dismissal either — the card stays until an explicit approve or
 * deny; an approval must never be decided by an accidental escape/click-away.
 */
export const ApprovalDialog = observer(function ApprovalDialog(): JSX.Element | null {
  const approvals = useShellApprovals()
  const current = approvals[0]
  if (!current) return null
  return <ApprovalCard key={current.id} approval={current} waiting={approvals.length - 1} />
})

const ApprovalCard = observer(function ApprovalCard({
  approval,
  waiting,
}: {
  approval: EffectModel
  waiting: number
}): JSX.Element | null {
  const { navigateToSession, decideApproval } = useShellActions()
  const [pendingAction, setPendingAction] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = approval.approvalRequest
  if (!request) return null
  const op = ApprovalOp.safeParse(request.op)
  const busy = pendingAction !== null

  const decide = async (decision: 'approve' | 'deny') => {
    if (busy) return
    setPendingAction(decision)
    setError(null)
    try {
      // Against the revision shown: if another device decided first, the
      // server refuses this one rather than deciding a request twice.
      await decideApproval(approval.id, decision, approval.revision)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record the decision. Try again.')
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <div
      role="alertdialog"
      aria-label="Agent requests approval"
      aria-live="assertive"
      className="fixed right-4 z-50 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-4 shadow-lg"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 3rem)' }}
    >
      <div className="mb-1 text-sm font-semibold">Agent requests approval</div>
      <RequestedFrom machineId={request.machineId} issueId={request.issueId} />
      <p className="mb-2 rounded-md border bg-muted px-3 py-2 font-mono text-[13px]">
        {op.success
          ? describeApprovalOp(op.data)
          : 'an operation this version of Podium cannot show — update the app to decide it'}
      </p>
      {waiting > 0 ? (
        <p className="mb-2 text-[12px] text-muted-foreground">
          {waiting} more request{waiting > 1 ? 's' : ''} waiting behind this one.
        </p>
      ) : null}
      {error && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigateToSession(request.sessionId)}
          disabled={busy}
        >
          Go to session
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            pending={pendingAction === 'deny'}
            pendingLabel="Denying…"
            onClick={() => void decide('deny')}
          >
            Deny
          </Button>
          <Button
            size="sm"
            disabled={busy || !op.success}
            pending={pendingAction === 'approve'}
            pendingLabel="Approving…"
            onClick={() => void decide('approve')}
          >
            Approve
          </Button>
        </div>
      </div>
    </div>
  )
})

/** "An agent (machine · issue) wants to:", from the machine and issue models. */
const RequestedFrom = observer(function RequestedFrom({
  machineId,
  issueId,
}: {
  machineId: string
  issueId: string | null
}): JSX.Element {
  const pool = useWorklistPool()
  const machine = pool ? here(pool.model('machine', machineId)) : undefined
  const issue = pool && issueId ? here(pool.model('issue', issueId)) : undefined
  const from = [
    machine?.name ?? machineId,
    issue ? formatLong(issue.displayRef, issue.title ?? '') : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="mb-2 text-[12px] text-muted-foreground">
      {from ? `An agent (${from}) wants to:` : 'An agent wants to:'}
    </div>
  )
})
