/**
 * THE READ-POSITION WRITE ON THE SYNC WRITE ENTRY POINT (POD-6412, ADR 12 D2).
 *
 * `readPosition.advance` is the caller's own cursor (ADR 9 D3 rule 4): the row
 * IS the user. The target check is a human behind the principal whose account
 * holds the member floor now, which is the gate the route applied before. In
 * one unit of work the store's advance and its change-log append now commit
 * together, where they were two writes.
 */

import { readPositionAdvanceContract } from '@podium/commands'
import type { UserId } from '@podium/model'
import type { z } from 'zod'
import { humanWithRoleFloor, type SyncFamily, type SyncFamilyState } from '../sync-write/family'
import type { ReadPositionService } from './service'

/** The caller's own cursors: whose, and the service that moves them. */
export interface ReadPositionWriter {
  readonly actor: UserId
  readonly positions: Pick<ReadPositionService, 'advance'>
}

type AdvanceInput = z.infer<typeof readPositionAdvanceContract.input>

export const READ_POSITION_COMMANDS = {
  advance: {
    contract: readPositionAdvanceContract,
    handler: async (svc: ReadPositionWriter, input: AdvanceInput) =>
      await svc.positions.advance(
        svc.actor,
        input.streamId,
        { lastEventId: input.lastEventId, seenAt: input.seenAt ?? null },
        new Date().toISOString(),
      ),
  },
} as const

export const READ_POSITION_SYNC_FAMILY: SyncFamily<
  ReadPositionWriter,
  typeof READ_POSITION_COMMANDS
> = {
  family: 'readPosition',
  service: (state: SyncFamilyState) => ({
    actor: state.caller.userId,
    positions: state.modules.readPosition,
  }),
  commands: READ_POSITION_COMMANDS,
  target: async (contract, _input, ctx) => await humanWithRoleFloor(contract, ctx),
}
