/**
 * CONSOLE — session cookie. ADR 5 D5 row 1.
 *
 * What authenticates it: the `podium_session` cookie on the HTTP upgrade,
 * resolved through {@link ClientSessionDirectory} to a PER-USER client session.
 * The origin / CSWSH guard (`isAllowedWsOrigin` in `apps/server/src/wsServer.ts`)
 * runs before this, at the upgrade; it is a transport guard, not an identity, and
 * passing it authenticates nobody.
 *
 * What it may then address: whatever its `(user, device, capability)` principal
 * is authorized for, re-resolved at every apply (ADR 3 D8). This module decides
 * none of it.
 *
 * What it is refused: everything, unless a cookie present ON THE TRANSPORT
 * resolves to a live session of an ACTIVE user. No cookie, unknown cookie,
 * expired cookie, disabled account — all `auth-failed`, indistinguishably, with
 * no fallback to an ambient operator (readiness §3.1.6 S4).
 *
 * A `client_session` is a DEVICE, not a person: the principal carries both
 * halves, and a user may hold many devices (ADR 3 Amendment 1 D14.1).
 *
 * PRODUCTION BINDING IS BLOCKED ON POD-1075. `client_sessions` has no user
 * column today and `@podium/runtime`'s auth-store holds ONE password for the
 * whole instance. Writing this strategy against that shape — resolving every
 * cookie to a single ambient operator — is precisely the multi-user hole this
 * issue removes, so it is not written that way and there is no production
 * implementation of the port yet. The strategy is complete against the port's
 * per-user shape and unit-tested against a fake.
 */

import type { z } from 'zod'
import { SESSION_COOKIE } from '../../session-cookie'
import type { PeerCredential, SessionCookieCredential } from '../envelope'
import type {
  AuthInput,
  AuthOutcome,
  CapabilityMinter,
  ClientSessionDirectory,
  PeerAuthStrategy,
} from './types'

type Credential = z.infer<typeof SessionCookieCredential>

export interface ConsoleCookieDeps {
  readonly clientSessions: ClientSessionDirectory
  readonly mint: Pick<CapabilityMinter, 'forUser'>
  /** Overridable only for tests; production is {@link SESSION_COOKIE}. */
  readonly cookieName?: string
}

export const createConsoleCookieStrategy = (
  deps: ConsoleCookieDeps,
): PeerAuthStrategy<Credential> => ({
  role: 'console',
  credentialKind: 'sessionCookie',
  name: 'console-cookie',
  authenticate({ transport }: AuthInput<Credential>): AuthOutcome {
    // The credential carries no material by design: the cookie is read off the
    // TRANSPORT, so a hello cannot present one. Nothing below reads the frame.
    const token = transport.cookies?.[deps.cookieName ?? SESSION_COOKIE]
    if (token === undefined || token === '')
      return { ok: false, reason: 'auth-failed', diagnostic: 'no session cookie on the transport' }
    const session = deps.clientSessions.resolve(token)
    if (session === null)
      return { ok: false, reason: 'auth-failed', diagnostic: 'unknown or expired client session' }
    if (!session.userActive)
      return { ok: false, reason: 'auth-failed', diagnostic: 'account disabled or revoked' }
    return {
      ok: true,
      principal: {
        kind: 'user',
        user: session.user,
        device: session.device,
        capability: deps.mint.forUser(session.user, session.device),
      },
    }
  },
})
