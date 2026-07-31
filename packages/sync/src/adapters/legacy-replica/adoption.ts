/**
 * MAY THIS DEVICE'S PRE-MULTI-USER REPLICA BE ADOPTED BY THE PERSON SIGNED IN NOW?
 *
 * `readLegacyReplica` answers a different question — what is decodable — and it
 * takes an `attribution` from its caller without ever asking whether that caller
 * is entitled to the store it is reading. That is the right division: the importer
 * knows the old layout, and nothing else. This module is the missing half, and the
 * hole it closes is real rather than theoretical: hand the importer the signed-in
 * principal on a device a colleague used first and user A's queued writes are
 * re-authored as user B, replayed under B's name, and re-authorized at drain
 * against B's rights (ADR 3 D8) — which is not a check that can catch it, because
 * B genuinely is allowed to do the thing B is now apparently asking for.
 *
 * WHY THE DEFAULT IS DISCARD. A store written before identity existed HAS NO OWNER.
 * Section 3.1's private-by-default decision draws an identity boundary that this
 * store predates, so adopting it in place would launder pre-multi-user data across
 * that boundary. Re-bootstrap is the most-tested path in the kernel (ADR 2 D6/D9)
 * and ADR 6 D4.5 already takes exactly this posture toward a store it cannot read;
 * discarding is therefore the cheap answer and adoption is the one that risks
 * exposure. Ambiguity resolves to discard, always.
 *
 * WHY ADOPTION IS NOT SIMPLY FORBIDDEN. There is one case where attribution is
 * CERTAIN rather than merely likely: a device on which exactly one identity has
 * ever existed. Today that is every device, because there are no user identities
 * at all — `/auth/status` is a shared-password gate (`docs/multi-user-readiness.md`
 * §3.2: "no user identity anywhere in the model") — so a pre-multi-user store on a
 * pre-multi-user client can only have been written by the one operator now signed
 * in. Refusing there would throw away real queued work of the person who authored
 * it, in the name of a boundary that does not yet exist. That is the
 * "single-account upgrade path" arm, and it closes by itself the moment identity
 * lands, because {@link LegacyIdentityEvidence} stops reporting `single-account`.
 *
 * THE VERDICT IS A UNION, NOT A BOOLEAN, and POD-376 asked for that specifically:
 * a gate that reports only "refused" cannot distinguish a working default from a
 * gate nobody ever supplied evidence to. Each arm below names WHICH fact decided
 * it, so `discarded-identity-unknown` (nobody declared anything) reads differently
 * from `discarded-multiple-identities` (the rule fired on real evidence).
 *
 * WHAT A DISCARD DOES WITH THE WORK, which is the part ADR 6 D4.3 constrains:
 * queued entries are "durable on the same footing as entity rows … losing them on
 * crash is a correctness bug, not degraded UX", so they may not simply evaporate.
 * They are dead-lettered — parked, never drainable — so the loss is SURFACED
 * through POD-316's existing recovery path rather than announced nowhere.
 *
 * BUT THE INPUT IS REDACTED ON THAT PATH, and this is the one place this module
 * deliberately breaks a stated contract. `DeadLetterRecord.input` is documented as
 * "the author's own input, verbatim: this is the recoverable intent" — which is
 * true precisely because, everywhere else, the author and the reader are the same
 * person. Here they provably are not: the discard arm fires exactly when we could
 * not establish that. Carrying the text across would show user A's unsent message
 * to user B in B's recovery UI, turning a migration into a disclosure. So the
 * discard arm parks the ENVELOPE — mutation id, command name, when it was queued —
 * and drops the payload. The user is told that work was queued on this device and
 * could not be attributed; they are not shown what it said.
 *
 * THE REASON CODE IS `unauthorized`, from the CLOSED set in `../../outbox/reasons`.
 * It is not a euphemism: its retry precondition is `rights-fix`, and signing in as
 * the identity that authored the entry is precisely the rights fix that would
 * license it. Widening `OUTBOX_REJECTION_CODES` for a one-shot migration would add
 * a code POD-316 must render forever, and the no-existence-oracle rule that closed
 * the set applies here too.
 */

import type { OutboxRecord } from '../../outbox/records'
import type { OutboxRejectionReason } from '../../outbox/reasons'
import type { LegacyReplicaImportPlan } from './import'

/**
 * What the composition root knows about who has used this device.
 *
 * Deliberately not derived here from anything ambient: this module cannot see an
 * auth endpoint, and a gate that guessed its own evidence would be a gate that
 * always agreed with itself.
 */
export type LegacyIdentityEvidence =
  /**
   * The client authenticated through the pre-identity shared-password gate, so
   * NO user identities exist in the system at all and the store can only be the
   * one operator's. `principal` is the id the adopted entries are attributed to.
   */
  | { readonly kind: 'single-account'; readonly principal: string }
  /**
   * Identity has landed. `identitiesEverSignedIn` is every principal this DEVICE
   * has held a session for — not "currently", not "on the server". Adoption needs
   * that set to be exactly `[signedInAs]`.
   */
  | {
      readonly kind: 'multi-user'
      readonly signedInAs: string
      readonly identitiesEverSignedIn: readonly string[]
    }
  /**
   * Nobody could say. The honest arm, and the reason this is a union rather than
   * an optional field: a caller that has not wired the ledger yet must be visibly
   * different from one whose ledger says "two people", and neither may adopt.
   */
  | { readonly kind: 'unknown' }

/** Which fact decided it. One code per distinguishable situation — see the header. */
export type LegacyAdoptionReason =
  /** No identities exist system-wide; the sole operator is signed in. */
  | 'adopted-single-account'
  /** Identity exists, and this device has only ever been used by the signed-in user. */
  | 'adopted-sole-identity'
  /** This device has held sessions for someone other than the signed-in user. */
  | 'discarded-multiple-identities'
  /** Identity exists, but this device's ledger does not include the signed-in
   *  user — so the store predates them, or belongs to someone else entirely. */
  | 'discarded-foreign-identity'
  /** The caller supplied no evidence. Fails toward privacy (§3.1.1 rule 1). */
  | 'discarded-identity-unknown'

export interface LegacyAdoptionDecision {
  readonly adopt: boolean
  readonly reason: LegacyAdoptionReason
  /**
   * The records to write. On `adopt` these are the plan's entries verbatim,
   * queued and drainable. On a discard they are the SAME entries parked as
   * dead letters with their `input` redacted — see the header.
   */
  readonly records: readonly OutboxRecord[]
  /** How many entries lost their payload to the discard arm. Zero on adoption.
   *  Surfaced by the caller; a migration that parked work silently would be the
   *  thing D4.3 forbids. */
  readonly redactedCount: number
}

/** The reason a parked pre-identity entry carries — see the header on why this
 *  code and not a new one. */
export const UNATTRIBUTABLE_REASON: OutboxRejectionReason = { code: 'unauthorized' }

/**
 * Decide, and produce the records to write in the migration's single transaction.
 *
 * Pure, like `readLegacyReplica`: it writes nothing, deletes nothing, and reads no
 * ambient state. The caller commits.
 *
 * `now` is injected rather than read from the clock so the parked records are
 * reproducible in a test — a `deadLetteredAt` from `Date.now()` would make every
 * assertion about them a moving target.
 */
export function decideLegacyAdoption(
  plan: LegacyReplicaImportPlan,
  evidence: LegacyIdentityEvidence,
  now: number,
): LegacyAdoptionDecision {
  const reason = classify(evidence)
  const adopt = reason === 'adopted-single-account' || reason === 'adopted-sole-identity'
  if (adopt) {
    return { adopt: true, reason, records: plan.outbox, redactedCount: 0 }
  }
  return {
    adopt: false,
    reason,
    records: plan.outbox.map((record) => park(record, now)),
    redactedCount: plan.outbox.length,
  }
}

function classify(evidence: LegacyIdentityEvidence): LegacyAdoptionReason {
  switch (evidence.kind) {
    case 'single-account':
      return 'adopted-single-account'
    case 'unknown':
      return 'discarded-identity-unknown'
    case 'multi-user': {
      const seen = new Set(evidence.identitiesEverSignedIn)
      if (seen.size > 1) return 'discarded-multiple-identities'
      // A ledger of exactly the signed-in user is the certainty the header
      // describes. Anything else — empty, or naming someone else — is not, and
      // the two are kept apart because an empty ledger means "not wired" while a
      // foreign one means "wired, and it said no".
      if (seen.size === 1 && seen.has(evidence.signedInAs)) return 'adopted-sole-identity'
      return 'discarded-foreign-identity'
    }
  }
}

/**
 * Park one entry: not drainable, payload dropped, envelope kept.
 *
 * `state` and `parkedFrom` are what make it non-drainable — the Outbox never
 * attempts a `dead-letter` record — and `input: null` is the redaction. The
 * mutation id survives so a re-issue can be told apart from the original
 * (D11.4), and `attempts: 0` is the truth: it was never sent.
 */
function park(record: OutboxRecord, now: number): OutboxRecord {
  return {
    ...record,
    input: null,
    state: 'dead-letter',
    reason: UNATTRIBUTABLE_REASON,
    parkedFrom: 'rejected',
    deadLetteredAt: now,
    attempts: 0,
  }
}
