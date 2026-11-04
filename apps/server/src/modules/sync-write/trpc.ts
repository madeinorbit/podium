/**
 * `sync.submit` — the tRPC adapter onto the sync write entry point (ADR 12 D2,
 * POD-6273).
 *
 * Thin by design: the transport authenticates and supplies the principal, and the
 * entry point does everything else. The envelope's shape is the protocol's
 * `SyncSubmitInput`; the command's own input is parsed by the entry point against
 * its contract, after the coarse permission check, so this schema must never
 * validate it.
 *
 * Served from this module and spread into router.ts, like every derived family:
 * router.ts holds no hand-written `.mutation(` (`scripts/audit-router-mutations.ts`).
 */

import { SyncSubmitInput, type SyncSubmitReply } from '@podium/protocol'
import { t } from '../../trpc'
import { familyState } from '../derived-family'

export function syncWriteProcedures() {
  return {
    submit: t.procedure
      .input(SyncSubmitInput)
      .mutation(
        async ({ ctx, input }): Promise<SyncSubmitReply> =>
          await familyState(ctx).modules.syncWrite.submit(input, ctx.principal, 'trpc'),
      ),
  }
}
