import type { LedgerWriter } from '@podium/sync'

/**
 * Run a machine, grant or member write as one change-log commit (POD-6920):
 * the database captures the rows it changed, and the commit appends the
 * machine and access records they reach. A write inside another such write
 * joins it, so a compound transition (custody, enrollment) publishes its
 * final records once.
 */
export type CompareMachineRecords = <T>(
  write: () => Promise<T>,
  writer?: Pick<LedgerWriter, 'commit'>,
) => Promise<T>

/** The composition root connects source repositories to the Ledger here. */
export class MachineRecordWrites {
  compare: CompareMachineRecords = async (write) => await write()
}
