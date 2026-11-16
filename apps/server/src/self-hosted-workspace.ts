/**
 * THE WORKSPACE OF A SELF-HOSTED INSTALL [POD-6959 design 2.4].
 *
 * A self-hosted database holds exactly one workspace, and this is its id. It is
 * the one place outside the migrations that names it: the self-hosted
 * composition (`server.ts`) opens its store with it, the identity composition
 * binds it, and the boot imports that predate workspaces write their rows into
 * it. Hosted routing (POD-6960) names its workspaces from podium-cloud's
 * registry instead, and test support picks its own.
 *
 * The migrations write the same value as SQL (`DEFAULT 'local'`, POD-7012): an
 * existing install's rows belong to this workspace from the upgrade on.
 */

import { asWorkspaceId, type WorkspaceId } from '@podium/model'

export const SELF_HOSTED_WORKSPACE_ID: WorkspaceId = asWorkspaceId('local')
