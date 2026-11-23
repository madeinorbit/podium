/**
 * THE CLOUD SURFACE (POD-314): the five writes from `CLOUD_CONTRACTS`,
 * `capabilities` and `runtime` from the query table.
 *
 * ON THE PLAIN PATH (ADR 12 D8, POD-6417). A cloud write changes nothing in
 * this server's database: the runtime lives on the cloud control plane, and the
 * provider is the network. So each runs through the plain entry (front door,
 * then the handler, online only, never recorded), not `sync.submit`. The one
 * synced write among them, `moveSession`'s local hibernate, is sent through
 * `sync.submit` as the caller once the runtime exists (`records.session`,
 * `desired: hibernated`).
 *
 * Stop and wake as edits of a desired state (ADR 12 D5 E1) need a cloud runtime
 * RECORD, which does not exist yet; until it does they are plain commands.
 *
 * The service is constructed PER REQUEST because its provider comes from the
 * context: `ctx.cloud` is absent on deployments with no cloud runtime, and
 * `CloudService` substitutes the disabled provider once at construction so no
 * method has to remember it.
 */

import type { SessionId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import { asSyncCommand } from '../../plain-command-scope'
import type { FamilyState } from '../derived-family'
import { definePlainFamily } from '../plain-command/declare'
import { lifecycleEditsFor } from '../sessions/command-ctx'
import { CLOUD_COMMANDS_TRPC } from './registry'
import { CloudService } from './service'

/** Park the local session as the caller, through `sync.submit` (see the header). */
const hibernateAs =
  (state: FamilyState, principal: CommandPrincipal | undefined) =>
  async (sessionId: SessionId): Promise<{ ok: boolean; reason?: string }> => {
    if (principal === undefined) throw new Error('a cloud read does not park sessions')
    const outcome = await asSyncCommand(
      async () =>
        await lifecycleEditsFor(state.modules, principal, false).desire(
          sessionId,
          'hibernated',
          false,
        ),
    )
    return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason ?? 'unknown reason' }
  }

/** THE PROCEDURES, spread into `router.ts`'s `cloud` router. */
export const CLOUD_PLAIN_FAMILY = definePlainFamily({
  family: 'cloud',
  service: (state, principal?: CommandPrincipal) =>
    new CloudService({
      provider: state.cloud,
      sessions: state.modules.sessions,
      repos: state.repos,
      store: state.store,
      hibernateLocal: hibernateAs(state, principal),
    }),
  commands: CLOUD_COMMANDS_TRPC,
})
