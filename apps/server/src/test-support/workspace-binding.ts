/**
 * Test support for the workspace edge (workspace-edge.ts): a workspace id a
 * test may name, and a route under test bound to one workspace the way the
 * edge binds it in a server. Test support is one of the three places a
 * `WorkspaceId` is minted (POD-6959 design 2.4).
 */
import { asWorkspaceId, type WorkspaceId } from '@podium/model'
import type { Hono } from 'hono'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { boundWorkspaceOf, recordWorkspaceBinding } from '../workspace-edge'

export function testWorkspaceId(name: string): WorkspaceId {
  return asWorkspaceId(name)
}

/** The edge's binding of every request of `app` to `workspace`, as a server records it. */
export function bindRequestsTo(
  app: Hono,
  workspace: WorkspaceId = SELF_HOSTED_WORKSPACE_ID,
  slug: string | null = null,
): void {
  app.use('*', async (c, next) => {
    recordWorkspaceBinding(c.req.raw, {
      id: workspace,
      slug,
      memberOfRequest: Object.assign(
        async () => {
          throw new Error('this test binds a workspace and resolves no member')
        },
        {
          factsOf: () => ({ scheme: 'https' as const, sameMachine: false, clientAddress: null }),
        },
      ),
    })
    await next()
  })
}

/** `SyncRouteDeps.workspaceOf` for a route bound by {@link bindRequestsTo}. */
export const boundWorkspaceForTests = boundWorkspaceOf
