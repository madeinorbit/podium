import type { UserId } from '@podium/model'
import type { LedgerWriter } from '@podium/sync'

type MachineIds = readonly string[] | (() => Promise<readonly string[]>)

export interface MachineRecordWriteScope {
  /** The display and every enabled member's access for these machines. */
  readonly machines?: MachineIds
  /** Only the display, for changes to the fleet default or update targets. */
  readonly display?: MachineIds
  /** This member's access across the fleet, including a member about to join or leave. */
  readonly member?: UserId
}

export type CompareMachineRecords = <T>(
  scope: MachineRecordWriteScope,
  write: () => Promise<T>,
  writer?: Pick<LedgerWriter, 'commit'>,
) => Promise<T>

/** The composition root connects source repositories to the Ledger here. */
export class MachineRecordWrites {
  compare: CompareMachineRecords = async (_scope, write) => await write()
}
