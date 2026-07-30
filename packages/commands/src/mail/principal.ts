/**
 * THE mail principal policy — the answer to "who is `operator`?" once `operator`
 * stops being one person.
 *
 * Today `senderFromCapability` maps capability scope `all` to sender kind
 * `operator`, and that kind carries real privileges in the substrate: the body is
 * delivered UNWRAPPED and byte-faithful, the sender skips the wake cooldown, its
 * spawns are free of the daily budget, and the rendered labels read "the
 * operator". That was sound while exactly one human held scope `all`. With
 * several people it is a role held by everyone who can log in, and readiness
 * §3.2 requires every role-level attribution to name a person.
 *
 * This module is the recorded policy, as pure functions, at L1 — so the delivery
 * service, the brakes and the label renderer all consult ONE answer rather than
 * three `fromKind === 'operator'` comparisons that can drift apart. It decides
 * nothing about transport and touches no service.
 *
 * WHAT IT DOES NOT DO: it never derives a principal from payload. Every function
 * here takes an ALREADY-STAMPED sender (ADR 3 D7); there is no input through
 * which a client could name itself.
 */

import type { UserId } from '@podium/model'

/**
 * A sender principal as the mail substrate stamps it, with the multi-user half
 * added. This is the L3 `MessageSender` union widened by `user` — the human at
 * the root of the delegation chain (readiness §3.1.3 A1: exactly one human per
 * chain), resolved live at every apply, never a capability snapshot.
 *
 * `user: null` is the single-user present, and it is also the permanent answer
 * for the principal that never gets a human: a `system` job (ADR 3 Amendment 1 D21.2 — "has no `onBehalfOf` and
 * must not be assigned one") and a legacy row written before user accounts.
 */
export interface MailSenderPrincipal {
  readonly kind: 'operator' | 'superagent' | 'system' | 'agent'
  readonly user: UserId | null
  readonly issueId?: string
  readonly sessionId?: string
  readonly name?: string
}

/**
 * Is this a HUMAN typing, as opposed to something acting for one?
 *
 * DECISION (recorded for the acceptance criterion "which principal earns the
 * unwrapped byte-faithful body"): the unwrapped body belongs to **any
 * authenticated human principal**, not to an admin grade.
 *
 * Why not admin-only: "unwrapped = a person typed this" is an invariant the
 * receiver's prime rules trust — it is the reason a question is the one carve-out
 * (a question needs its envelope to constrain the answer). Being a person is not
 * a privilege level. Gating byte-fidelity on admin grade would mean a member's
 * words arrive rewritten while an admin's arrive verbatim, which is a fidelity
 * difference dressed up as a permission, and it would make the receiver's
 * "unwrapped means a human" reading FALSE for members rather than merely narrow.
 *
 * Why not "anyone with scope all": that is the thing being replaced. Scope `all`
 * is a capability breadth; `operator` must become an identity.
 */
export const isHumanPrincipal = (sender: MailSenderPrincipal): boolean => sender.kind === 'operator'

/**
 * Byte-faithful, envelope-free delivery (readiness §3.2). Questions are excepted
 * because the envelope is what constrains the receiver to answer-then-resume.
 */
export const deliversUnwrapped = (sender: MailSenderPrincipal, kind: string): boolean =>
  isHumanPrincipal(sender) && kind !== 'question'

/**
 * Wake-cooldown and spawn-budget exemption.
 *
 * DECISION: the exemptions attach to **any human principal**, not only at admin
 * grade. The brakes exist to stop an unattended loop — an agent re-waking a peer
 * every second, or a spawn loop fork-bombing the host with full PTY sessions. A
 * person at a keyboard is not that failure mode, and a member who has to wait out
 * a ten-minute cooldown before messaging their own agent twice would experience
 * the brake as a bug. Admin grade governs what you may reach (§3.2), not how fast
 * you may type.
 *
 * A superagent is NOT exempt: it is "you, automated" (readiness §3.1.6 S1) and is
 * exactly the unattended loop the brakes were written for.
 */
export const exemptFromBrakes = (sender: MailSenderPrincipal): boolean => isHumanPrincipal(sender)

/**
 * The brake bucket key.
 *
 * TODAY'S DEFECT, stated plainly: `senderKey` collapses every operator to the
 * string `operator` and every superagent to the string `superagent`. Under
 * readiness §3.1.6 S1 the superagent is PER USER, so one shared bucket lets one
 * person's superagent throttle another's — a cross-user denial of service with no
 * error message, because a throttled wake looks exactly like a quiet one.
 *
 * Re-keying by user fixes it. When no user is resolvable the key degenerates to
 * today's bare kind, which is behaviour-preserving in the single-user present and
 * is why this can land before the user table does.
 *
 * `agent` and `system` were already per-principal (session/issue id, job name)
 * and are unchanged — the collapse was specific to the two role-shaped kinds.
 */
export function senderBrakeKey(sender: MailSenderPrincipal): string {
  switch (sender.kind) {
    case 'agent':
      return `agent:${sender.sessionId ?? sender.issueId ?? '?'}`
    case 'system':
      return `system:${sender.name ?? '?'}`
    case 'operator':
    case 'superagent':
      return sender.user === null ? sender.kind : `${sender.kind}:${sender.user}`
  }
}

/**
 * Which human's inbox an operator-ADDRESSED row belongs in.
 *
 * `toKind: 'operator'` rows queue for UI or superagent pickup, and `replyTarget`
 * falls back to kind `operator` for superagent, operator and system senders. Per
 * readiness §3.1.6 S3 attention routing is per-user by construction, so such a row
 * must resolve to a SPECIFIC human's inbox rather than one shared one.
 *
 * The rule, per sender kind:
 *  - a human's own thread comes back to that human;
 *  - a superagent is "you, automated", so its reply reaches ITS human (S1/S3);
 *  - a `system` job has no human (D21.2) and must not be given one — its
 *    operator-addressed rows stay in the shared instance box, which is correct
 *    rather than a fallback: nobody is accountable for a steward's notice, and
 *    assigning one would make the product lie (D21's rejected alternative).
 *
 * Returns `null` for "the shared box", which is also what every kind returns
 * before the user table lands — today's behaviour, preserved.
 */
export const operatorAddressee = (sender: MailSenderPrincipal): UserId | null => {
  if (sender.kind === 'system') return null
  return sender.user
}

/**
 * How the envelope names the sender. `'the operator'` was a role reading as an
 * identity; §3.2 requires a person. `displayName` is resolved by the caller from
 * the user aggregate (POD-1075) — this function decides WHICH name is used, not
 * where it is stored.
 */
export function senderLabel(
  sender: MailSenderPrincipal,
  displayName: (user: UserId) => string | null,
): string {
  if (sender.kind === 'operator') {
    const name = sender.user === null ? null : displayName(sender.user)
    return name ?? 'the operator'
  }
  if (sender.kind === 'superagent') {
    const name = sender.user === null ? null : displayName(sender.user)
    return name === null ? 'the superagent' : `${name}'s superagent`
  }
  if (sender.kind === 'system') return sender.name ?? 'system'
  return sender.sessionId ? `session:${sender.sessionId}` : 'an agent'
}
