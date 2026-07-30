/**
 * NODE — RESERVED AND INERT. ADR 5 D4 and D5 row 4.
 *
 * The credential CLASS and the capability fields exist so a future node peer can
 * declare itself without a flag day. There is NO ACCEPTOR: the hub is deferred
 * ([spec:SP-0371]) and implementing one here would be H2 product creep (D4's
 * first rejected alternative).
 *
 * What authenticates it: nothing. This module exists to refuse, loudly and
 * without crashing, which is the exact conformance obligation of D4.4: "inject
 * reserved caps and assert the authority neither crashes nor grants rights".
 *
 * Why refuse from a MODULE rather than by leaving the role unregistered: an
 * unregistered role falls through to a generic "unknown role" answer, which reads
 * as an accident. A registered module that returns `role-not-implemented` is a
 * decision, and it is the thing a future implementer will delete.
 *
 * Note that reserved capability TOKENS (`peerRole:node`, `upstream.*`, `feed.*`)
 * are handled separately in `../negotiation.ts` — they are ignored on ANY role's
 * connection, never granted, and never routed anywhere.
 */

import type { z } from 'zod'
import type { NodeCredentialReserved } from '../envelope'
import type { AuthInput, AuthOutcome, PeerAuthStrategy } from './types'

type Credential = z.infer<typeof NodeCredentialReserved>

export const createNodeReservedStrategy = (): PeerAuthStrategy<Credential> => ({
  role: 'node',
  credentialKind: 'nodeCredential',
  name: 'node-reserved-inert',
  authenticate(_input: AuthInput<Credential>): AuthOutcome {
    return {
      ok: false,
      reason: 'role-not-implemented',
      diagnostic: 'node peer role is reserved for H2 federation (ADR 5 D4, spec SP-0371)',
    }
  },
})
