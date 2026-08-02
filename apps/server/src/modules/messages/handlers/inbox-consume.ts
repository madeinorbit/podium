/**
 * Handler for the `mail.inboxConsume` contract (L3).
 *
 * Three arms, unchanged from the shipped arithmetic and now evaluated against
 * the effective principal: your OWN issue box consumes; an in-scope ancestor box
 * reads unfiltered but never consumes; anything else comes back mayView-filtered.
 */

import type { ContractInput, mailInboxConsumeContract } from '@podium/commands'
import type { MessageWire } from '../gate'
import type { MailHandlerContext } from './context'

export function inboxConsumeHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailInboxConsumeContract>,
): MessageWire[] {
  const { caller, deps, access } = ctx
  const svc = deps.messages
  if (input?.issue) {
    // Peek at a named issue's box — never consumes queued status unless it
    // IS the caller's own issue. Cross-SCOPE peeks are body-filtered: the
    // substrate carries richer traffic than legacy issue mail (operator ↔
    // issue in unrelated subtrees), so outside the caller's subtree only
    // rows it could mayView (sent or received) come back.
    //
    // THE FILTERED PATH IS NOT AN EXISTENCE ORACLE (contract errorConsistency):
    // a peek beyond the delegating human's visibility resolves to
    // `unresolvable` and answers with an EMPTY list — the same answer as an
    // issue that exists and has no mail. Empty and forbidden look alike here for
    // exactly the reason they must on the send path.
    const resolved = access.resolveIssueAddress(input.issue)
    if (resolved.kind !== 'issue') return []
    const id = resolved.id
    const scope = caller.capability.scope
    const own = scope.kind === 'subtree' && scope.rootId === id
    const inScope =
      scope.kind === 'all' ||
      own ||
      (scope.kind === 'subtree' &&
        scope.rootId !== undefined &&
        deps.issues.ancestorIds(id).includes(scope.rootId))
    const consume = own ? (caller.capability.actorSessionId ?? null) : undefined
    const rows = svc.readInbox([{ kind: 'issue', id }], consume !== undefined ? { consume } : {})
    return (inScope ? rows : rows.filter((m) => access.mayView(caller.capability, m))).map((m) =>
      access.wire(m),
    )
  }
  const principals = access.callerPrincipals(caller.capability)
  if (principals.length === 0) throw new Error('no mailbox bound to this caller')
  return svc
    .readInbox(principals, { consume: caller.capability.actorSessionId ?? null })
    .map((m) => access.wire(m))
}
