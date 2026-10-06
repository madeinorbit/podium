/** Principal cache adoption fails closed when identity evidence is missing. */

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

export type LegacyStoreProvenance =
  | { readonly kind: 'unattributed' }
  | { readonly kind: 'principal-scoped'; readonly writtenUnder: readonly string[] }

export const UNATTRIBUTED_STORE: LegacyStoreProvenance = { kind: 'unattributed' }

/** Which fact decided it. One code per distinguishable situation — see the header. */
export type LegacyAdoptionReason =
  /** No identities exist system-wide; the sole operator is signed in. */
  | 'adopted-single-account'
  /** Identity exists, and this device has only ever been used by the signed-in user. */
  | 'adopted-sole-identity'
  /** Identity exists and others have used this device, but the store in front of
   *  the gate is empty or was written only under the signed-in user — there is
   *  nothing of anyone else's to protect (POD-4000). */
  | 'adopted-nothing-to-protect'
  /** This device has held sessions for someone other than the signed-in user. */
  | 'discarded-multiple-identities'
  /** Identity exists, but this device's ledger does not include the signed-in
   *  user — so the store predates them, or belongs to someone else entirely. */
  | 'discarded-foreign-identity'
  /** The caller supplied no evidence. Fails toward privacy (§3.1.1 rule 1). */
  | 'discarded-identity-unknown'

/** Pure privacy check; provenance is supplied by the store's construction. */
export function decideLegacyAdoption(
  evidence: LegacyIdentityEvidence,
  store: LegacyStoreProvenance = UNATTRIBUTED_STORE,
): { readonly adopt: boolean; readonly reason: LegacyAdoptionReason } {
  const writers = store.kind === 'principal-scoped' ? store.writtenUnder : undefined
  const reason = classify(evidence, writers)
  return { adopt: reason.startsWith('adopted-'), reason }
}

function classify(
  evidence: LegacyIdentityEvidence,
  writers: readonly string[] | undefined,
): LegacyAdoptionReason {
  switch (evidence.kind) {
    case 'single-account':
      return 'adopted-single-account'
    case 'unknown':
      // No evidence at all, so a provenance claim has nothing to stand beside;
      // the header's rule holds and this arm stays closed (POD-4000 narrows the
      // multi-user arm only).
      return 'discarded-identity-unknown'
    case 'multi-user': {
      // Nothing to protect: the store is empty or was written only by the person
      // signed in. The ledger may name others — that is about the device, and it
      // does not put their rows in this store.
      if (writers?.every((who) => who === evidence.signedInAs)) {
        return 'adopted-nothing-to-protect'
      }
      // A store demonstrably written by someone else is itself evidence that
      // person used this device, whatever the ledger remembered.
      const seen = new Set([...evidence.identitiesEverSignedIn, ...(writers ?? [])])
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

