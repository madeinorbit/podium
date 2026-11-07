/**
 * THE SUPERAGENT'S WRITES ON THE SYNC WRITE ENTRY POINT (POD-6419, plan Task 16).
 *
 * The eight thread commands, from their joined table (`registry.ts`), on the sync
 * family builder. The entry point runs every common step; this file supplies the
 * target check and the refusals.
 *
 * TARGET: THE THREAD'S OWNER. A thread is personal state (ADR 9 D8 S2: my threads
 * never surface in yours), so the record each command writes is a row of its
 * owner's, and only that owner (or an agent acting for them) may write it,
 * whatever the capability's breadth: the check refuses anyone else's thread
 * itself, and `authorize` then decides the caller's own row. The thread is named as the caller names it: `global` is the caller's
 * own global thread, created by their command when it is missing; a concierge
 * intake writes the caller's own repo thread; `startBtw` writes the btw thread of
 * a session (its owner's, or the caller's when it is new). A thread id that
 * resolves to nothing refuses exactly like someone else's thread: the refusal is
 * not an existence oracle (ADR 3 Amendment 1 D20.2). Below that, the contract's
 * role floor, read live.
 *
 * NOTHING OUTSIDE THE DATABASE RUNS IN THE WRITE. The service's daemon frames,
 * transcript reads, turn dispatch, kills, PTY spawns, timers and pushes go
 * through `afterCommitOrNow` (`after-commit.ts`): after this unit commits, never
 * on a rollback. So a turn is ACCEPTED here (its queued row, the thread's agent
 * and headless session) and RUN after the commit by the thread's queue pump; its
 * failure is the durable failure rows and the turn-end the client already reads
 * for a queued turn.
 *
 * THE WRITER. The scope carries the command's own writer (`state.writer`), and
 * the service commits the headless session a command creates or names through
 * it (POD-6606). The turn that runs after the commit is the turn runner's own
 * write (`superagent.turns`).
 *
 * THE SERVICE. The superagent is built after the registry (`server.ts`), so the
 * family reads it per call from the modules' late-bound slot
 * (`RegistryModules.superagent`, set by `SuperagentService.create`).
 */

import { asThreadId, type UserId } from '@podium/model'
import { onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import {
  humanWithRoleFloor,
  type SyncFamily,
  type SyncFamilyTargetContext,
  trpcErrorRefusal,
} from '../sync-write/family'
import { isNoTarget } from '../sync-write/registry'
import { SuperagentRefusal } from './refusal'
import { SUPERAGENT_COMMANDS, type SuperagentScope } from './registry'
import type { SuperagentService } from './service'

function superagentOf(modules: Pick<RegistryModules, 'superagent'>): SuperagentService {
  const service = modules.superagent
  if (service === undefined) throw new Error('superagent: the service is not composed yet')
  return service
}

const stringField = (input: unknown, key: string): string | undefined => {
  const value = (input as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' ? value : undefined
}

/** Whose thread the parsed input addresses, as the caller names it. */
async function threadOwner(
  service: SuperagentService,
  command: string,
  input: unknown,
  caller: UserId,
): Promise<UserId | undefined> {
  switch (command) {
    // A repo's intake thread is the caller's own by construction.
    case 'superagent.concierge':
      return caller
    case 'superagent.startBtw': {
      const sessionId = stringField(input, 'sessionId')
      return sessionId === undefined
        ? undefined
        : await service.ownerOfBtwThread(caller, sessionId as never)
    }
    default: {
      const threadId = stringField(input, 'threadId')
      return threadId === undefined
        ? undefined
        : await service.ownerOfThread(caller, asThreadId(threadId))
    }
  }
}

export const SUPERAGENT_SYNC_FAMILY: SyncFamily<SuperagentScope, typeof SUPERAGENT_COMMANDS> = {
  family: 'superagent',
  // The command's own writer rides the scope: a headless session a command
  // creates is that command's write (ADR 12 D9, POD-6606).
  service: (state) => ({
    service: superagentOf(state.modules),
    owner: state.caller.userId,
    writer: state.writer,
  }),
  commands: SUPERAGENT_COMMANDS,
  target: async (contract, input, ctx: SyncFamilyTargetContext) => {
    const floor = await humanWithRoleFloor(contract, ctx)
    if (floor === undefined || !isNoTarget(floor)) return undefined
    const caller = onBehalfOfUser(ctx.principal)
    if (caller === null) return undefined
    const owner = await threadOwner(superagentOf(ctx.modules), contract.name, input, caller)
    // Personal, whatever the capability's breadth: an operator's `all` scope
    // reaches every shared record, never another person's threads.
    return owner === caller ? { kind: 'per-user-row', userId: owner } : undefined
  },
  refusalOf: (error) =>
    error instanceof SuperagentRefusal
      ? { kind: error.kind, message: error.message }
      : trpcErrorRefusal(error),
}
