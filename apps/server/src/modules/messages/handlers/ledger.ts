/**
 * Handler for the `mail.ledger` contract (L3) — the per-issue / per-session
 * delivery ledger (#237) [spec:SP-34d7 web]. A pure read; it never consumes
 * queued status.
 *
 * RECLASSIFIED IN THIS PASS (acceptance criterion 8). It was operator-only, and
 * the comment on it said exactly why: it exposes other principals' traffic. That
 * was a sound gate while `operator` meant one person; it is not a policy once
 * `operator` is a role held by everyone who can log in.
 *
 * The classification now: OWN TRAFFIC for every person, admins included
 * (POD-6284 removed the admin's cross-user arm). ADR 3 Amendment 1 D15's split
 * still holds — the role floor says a member may attempt the command, the row
 * gate says which rows come back.
 */

import type { ContractInput, mailLedgerContract } from '@podium/commands'
import type { MessageWire } from '../gate'
import type { MailHandlerContext } from './context'

export async function ledgerHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailLedgerContract>,
): Promise<MessageWire[]> {
  const { caller, deps, access } = ctx
  // An `issueId` filter is a caller-supplied target, so it must not become an
  // existence oracle: a query scoped to an issue beyond the human ceiling
  // returns an EMPTY page, identical to an issue with no traffic.
  if (input.issueId !== undefined) {
    const resolved = await access.resolveIssueAddress(input.issueId)
    if (resolved.kind !== 'issue') return []
  }
  const rows = await deps.messages.ledger(input)
  // A member sees the delivery ledger for traffic they sent or received — the
  // "why did my wake not fire" question the view exists to answer, answerable
  // entirely from their own rows. Same `mayViewAs` predicate the show/status
  // surfaces use, so there is one definition of "my traffic", not two.
  // There is no cross-user arm (POD-6284): an admin's ledger is their own
  // traffic too.
  const visible = await access.visibleTo(caller, rows)
  return await Promise.all(visible.map(async (m) => await access.wire(m)))
}
