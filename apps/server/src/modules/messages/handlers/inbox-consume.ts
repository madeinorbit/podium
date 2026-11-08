/**
 * Handler for the `mail.inboxConsume` contract (L3).
 *
 * For an AGENT, three arms, unchanged from the shipped arithmetic and evaluated
 * against the effective principal: your OWN issue box consumes; an in-scope
 * ancestor box reads unfiltered but never consumes; anything else comes back
 * mayView-filtered. A PERSON reads their own rows only (`humanInbox`).
 */

import type { ContractInput, mailInboxConsumeContract } from '@podium/commands'
import type { MessageWire } from '../gate'
import { MailRefusal } from '../refusal'
import { type MailHandlerContext, mailWriter, personOf } from './context'

export async function inboxConsumeHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailInboxConsumeContract>,
): Promise<MessageWire[]> {
  const { caller, deps, access } = ctx
  const svc = deps.messages
  if (personOf(caller) !== undefined) return await humanInbox(ctx, input)
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
    const resolved = await access.resolveIssueAddress(input.issue)
    if (resolved.kind !== 'issue') return []
    const id = resolved.id
    const scope = caller.capability.scope
    const own = scope.kind === 'subtree' && scope.rootId === id
    const inScope =
      own ||
      (scope.kind === 'subtree' &&
        scope.rootId !== undefined &&
        (await deps.issues.hierarchy.ancestorIds(id)).includes(scope.rootId))
    const consume = own ? (caller.capability.actorSessionId ?? null) : undefined
    const rows = await svc.readInbox(
      mailWriter(ctx, 'mail.inboxConsume'),
      [{ kind: 'issue', id }],
      consume !== undefined ? { consume } : {},
    )
    return await Promise.all(
      (inScope ? rows : rows.filter((m) => access.mayView(caller.capability, m))).map(
        async (m) => await access.wire(m),
      ),
    )
  }
  const principals = access.callerPrincipals(caller.capability)
  if (principals.length === 0) throw new MailRefusal('invalid', 'no mailbox bound to this caller')
  return await Promise.all(
    (
      await svc.readInbox(mailWriter(ctx, 'mail.inboxConsume'), principals, {
        consume: caller.capability.actorSessionId ?? null,
      })
    ).map(async (m) => await access.wire(m)),
  )
}

/**
 * A PERSON'S INBOX (POD-6284). Every member has one, admins and members alike:
 * the operator box, narrowed to the rows that are theirs (`mayViewAs` — sent
 * on their behalf, or from or to a session they own). A peek at a task's box
 * shows the same: their own mail in it. A person never consumes queued status
 * (they are no session), so nothing they are not shown is touched.
 */
async function humanInbox(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailInboxConsumeContract>,
): Promise<MessageWire[]> {
  const { caller, deps, access } = ctx
  let box: { kind: 'issue' | 'operator'; id?: string }
  if (input?.issue) {
    // Not an existence oracle: a task beyond the person's sight reads empty.
    const resolved = await access.resolveIssueAddress(input.issue)
    if (resolved.kind !== 'issue') return []
    box = { kind: 'issue', id: resolved.id }
  } else {
    box = { kind: 'operator' }
  }
  const rows = await deps.messages.readInbox(mailWriter(ctx, 'mail.inboxConsume'), [box], {})
  return await Promise.all(
    (await access.visibleTo(caller, rows)).map(async (m) => await access.wire(m)),
  )
}
