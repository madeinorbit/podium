/**
 * The lock writes on the plain path (ADR 12 D8, POD-6419; registrations,
 * POD-6593). A lease holds no synced row, so every lock write is a plain
 * command: the front door reads the def's own fields, then the handler runs as
 * the caller over the composed lock service. Served on tRPC and the relay alike.
 */

import type { PlainDefRegistration } from '../plain-command/registry'
import { type AnyLockCommandDef, lockRegistry } from './registry'

export const LOCK_PLAIN_REGISTRATIONS: readonly PlainDefRegistration[] =
  Object.entries<AnyLockCommandDef>(lockRegistry.defs)
    .filter(([, def]) => def.kind === 'mutation')
    .map(([proc, def]) => ({
      name: `lock.${proc}`,
      def,
      handle: async (ctx, input) =>
        await ctx.modules.lockCommands.run(ctx.caller, proc, def, input),
    }))
