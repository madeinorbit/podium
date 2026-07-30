/**
 * OPERATOR CHANNEL (`cli` / in-process `mcp`) — ADR 3 Amendment 1 D14.2, row 2:
 * "In-process binding or the local operator's client session; NEVER
 * client-supplied".
 *
 * NOT a peer role (ADR 5 D2), and deliberately not folded into the console
 * strategy: the CLI and the in-process MCP tools ride a different ingress with a
 * different credential, and giving them the console's key would make "the local
 * process" and "a browser with a cookie" one code path.
 *
 * What authenticates it: either
 *  1. an IN-PROCESS BINDING — the composition root that constructed the caller
 *     supplies the bound user explicitly, and `transport.inProcess` proves the
 *     call never crossed a socket; or
 *  2. the local operator's client session token, resolved through the SAME
 *     per-user {@link ClientSessionDirectory} the console uses.
 *
 * What it may then address: what that human is authorized for. It is a human
 * principal — the channel does not have an identity of its own.
 *
 * What it is refused: everything else. In particular there is NO ambient
 * operator: a CLI on the box with no session and no in-process binding gets
 * `auth-failed`, which is the single most tempting fallback in the codebase and
 * the one readiness §3.1.6 S4 names as the multi-user hole. An `inProcess` claim
 * arriving with a socket endpoint is refused too — `inProcess` is a fact the
 * gateway asserts, not something a peer can send.
 */

import type { z } from 'zod'
import type { UserId } from '../../planes/principal'
import { asDeviceId } from '../../planes/principal'
import type { OperatorChannelCredential } from '../envelope'
import type {
  AuthInput,
  AuthOutcome,
  CapabilityMinter,
  ClientSessionDirectory,
  PeerAuthStrategy,
} from './types'

type Credential = z.infer<typeof OperatorChannelCredential>

export interface OperatorChannelDeps {
  readonly clientSessions: ClientSessionDirectory
  readonly mint: Pick<CapabilityMinter, 'forUser'>
  /**
   * The in-process binding, supplied by the composition root at construction.
   * Returning `null` means "this process has no bound operator" and the channel
   * then requires a real client session. It is a FUNCTION so that revoking the
   * binding takes effect without rebuilding the strategy.
   */
  readonly boundUser?: () => UserId | null
  /** Whether the bound user's account is currently active. Fails closed. */
  readonly userIsActive?: (user: UserId) => boolean
}

export const createOperatorChannelStrategy = (
  deps: OperatorChannelDeps,
): PeerAuthStrategy<Credential> => ({
  role: 'operator-channel',
  credentialKind: 'operatorChannel',
  name: 'operator-channel',
  authenticate({ credential, transport }: AuthInput<Credential>): AuthOutcome {
    if (transport.inProcess === true) {
      const user = deps.boundUser?.() ?? null
      if (user === null)
        return {
          ok: false,
          reason: 'auth-failed',
          diagnostic: 'in-process channel has no bound user',
        }
      if (deps.userIsActive !== undefined && !deps.userIsActive(user))
        return { ok: false, reason: 'auth-failed', diagnostic: 'bound user disabled or revoked' }
      return {
        ok: true,
        principal: {
          kind: 'user',
          user,
          device: asDeviceId(transport.connectionId ?? 'in-process'),
          capability: deps.mint.forUser(user, asDeviceId(transport.connectionId ?? 'in-process')),
        },
      }
    }
    if (credential.sessionToken === undefined)
      return {
        ok: false,
        reason: 'auth-failed',
        diagnostic: 'operator channel presented neither an in-process binding nor a session token',
      }
    const session = deps.clientSessions.resolve(credential.sessionToken)
    if (session === null || !session.userActive)
      return { ok: false, reason: 'auth-failed', diagnostic: 'unknown, expired or disabled session' }
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
