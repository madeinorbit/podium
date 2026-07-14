import { shallowEqual } from '@podium/client-core/store'
import { describeApprovalOp, formatLong, issueDisplayRef } from '@podium/protocol'
import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useStoreSelector } from './store'

/**
 * Approval broker popup [spec:SP-edbb] (#410): an agent asked to run a
 * management op (update / stop / channel / set-server). Shows WHO is asking
 * (machine · issue, with a one-click jump via the central navigate-to-session
 * action [spec:SP-a1c0]) and exactly WHAT would run — ops like set-server
 * render their target, because an approval dialog only protects when the user
 * can see what they're approving.
 *
 * Deliberately NON-modal: a fixed corner card with no overlay/blur, so the
 * user can inspect the requesting session (or anything else) before deciding.
 * There is no dismissal either — the card stays until an explicit approve or
 * deny; an approval must never be decided by an accidental escape/click-away.
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
    // Prefer the server-stamped nice id (#474); fall back to `#seq` for rows
    // from a server that predates the field.
    current.issueDisplayRef != null
      ? formatLong(current.issueDisplayRef, current.issueTitle ?? '')
      : current.issueSeq != null
        ? formatLong(issueDisplayRef({ seq: current.issueSeq }), current.issueTitle ?? '')
        : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      role="alertdialog"
      aria-label="Agent requests approval"
      aria-live="assertive"
      className="fixed right-4 z-50 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-4 shadow-lg"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 3rem)' }}
    >
      <div className="mb-1 text-sm font-semibold">Agent requests approval</div>
      <div className="mb-2 text-[12px] text-muted-foreground">
        {from ? `An agent (${from}) wants to:` : 'An agent wants to:'}
      </div>
      <p className="mb-2 rounded-md border bg-muted px-3 py-2 font-mono text-[13px]">
        {describeApprovalOp(current.op)}
      </p>
      {approvals.length > 1 ? (
        <p className="mb-2 text-[12px] text-muted-foreground">
          {approvals.length - 1} more request{approvals.length > 2 ? 's' : ''} waiting behind this
          one.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigateToSession(current.sessionId)}
          disabled={busy}
        >
          Go to session
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void decide(false)}>
            Deny
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void decide(true)}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  )
}
