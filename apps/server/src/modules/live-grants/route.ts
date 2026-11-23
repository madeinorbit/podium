/**
 * `POST /live/grant`: a member's client grant for what a screen shows
 * (POD-7311; POD-6954 design 4.5).
 *
 * The body names the session and machine ids on screen (up to
 * {@link MAX_GRANT_IDS} of each) and, optionally, the thumbprint of the key the
 * live connection will prove it holds. The answer is the signed grant naming
 * only the ids the member may see, with its expiry and the time to refresh it.
 *
 * A POST, not a tRPC query: a query goes out as a GET, and a thousand ids in a
 * URL is past what proxies and the server accept (the bootstrap view hit 431).
 * The request is bound to its workspace by the edge and admitted by the client
 * guard, like `/sync/*`; the workspace the grant names is that binding, never
 * one the body names.
 */

import {
  LiveGrantSigningUnavailable,
  LiveGrantTooLarge,
  MAX_GRANT_IDS,
  type SignedLiveGrant,
  signClientGrant,
} from '@podium/live-grants'
import type { UserRole, WorkspaceId } from '@podium/model'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { UserCommandPrincipal } from '../../command-principal'
import { withOperation } from '../../store/executor/operation-scope'
import type { LiveGrantKeySource } from './keys'
import { type ClientGrantSources, clientGrantScopes } from './scopes'

const GrantId = z.string().min(1).max(256)

export const LiveGrantRequestBody = z
  .object({
    sessions: z.array(GrantId).max(MAX_GRANT_IDS).default([]),
    machines: z.array(GrantId).max(MAX_GRANT_IDS).default([]),
    connectionKey: z.string().min(1).max(256).optional(),
  })
  .strict()

/** The answer's body. */
export interface LiveGrantResponseBody {
  readonly grant: string
  readonly keyId: string
  readonly expiresAt: number
  readonly refreshAt: number
}

export interface LiveGrantMember {
  readonly principal: UserCommandPrincipal
  readonly role: UserRole
}

export interface LiveGrantRouteDeps {
  /** The member the guard admitted, or undefined. */
  member(request: Request): Promise<LiveGrantMember | undefined>
  /** The workspace the edge bound the request to. */
  workspaceOf(request: Request): WorkspaceId
  /** The workspace this process's store serves; a request bound elsewhere is a wiring fault. */
  readonly storeWorkspace: WorkspaceId
  readonly sources: ClientGrantSources
  readonly keys: LiveGrantKeySource
  readonly now?: () => number
}

/** Compute and sign one client grant. */
export async function issueClientGrant(
  deps: Pick<LiveGrantRouteDeps, 'sources' | 'keys' | 'now'>,
  workspace: WorkspaceId,
  member: LiveGrantMember,
  body: z.output<typeof LiveGrantRequestBody>,
): Promise<SignedLiveGrant> {
  const scopes = await clientGrantScopes(deps.sources, member.principal, body)
  return signClientGrant(
    await deps.keys.ring(),
    {
      workspace,
      member: member.principal.user,
      role: member.role,
      ...scopes,
      ...(body.connectionKey === undefined ? {} : { connectionKey: body.connectionKey }),
    },
    { now: (deps.now ?? Date.now)() },
  )
}

export function registerLiveGrantRoutes(app: Hono, deps: LiveGrantRouteDeps): void {
  app.post('/live/grant', async (c) => {
    const member = await deps.member(c.req.raw)
    if (!member) return c.json({ error: 'not signed in' }, 401)
    const workspace = deps.workspaceOf(c.req.raw)
    if (workspace !== deps.storeWorkspace) {
      throw new Error(`request bound to ${workspace} reached the store of ${deps.storeWorkspace}`)
    }
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'body is not JSON' }, 400)
    }
    const body = LiveGrantRequestBody.safeParse(raw)
    if (!body.success) return c.json({ error: 'invalid grant request' }, 400)
    try {
      const signed = await withOperation(
        async () => await issueClientGrant(deps, workspace, member, body.data),
      )
      const answer: LiveGrantResponseBody = {
        grant: signed.token,
        keyId: signed.keyId,
        expiresAt: signed.expiresAt,
        refreshAt: signed.refreshAt,
      }
      return c.json(answer, 200, { 'cache-control': 'no-store' })
    } catch (error) {
      if (error instanceof LiveGrantSigningUnavailable) {
        return c.json({ error: 'live grants are not configured on this server' }, 503)
      }
      // Too many or too long roots, or a token past the budget: the screen asks for less.
      if (error instanceof LiveGrantTooLarge) {
        return c.json({ error: 'live grant too large', reason: error.reason }, 413)
      }
      throw error
    }
  })
}
