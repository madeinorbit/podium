/**
 * Test support for the outbox commands on the sync write entry point (POD-6350).
 *
 * Every family test drives the REAL composed server (`makeOracle`): the commands
 * are registered where `relay.ts` registers them, and the reply, the receipt and
 * the change rows are read back from the same Ledger the feed serves. A family
 * fixture that composed its own entry could pass while production registers
 * nothing.
 */

import { asMutationId, type MutationId } from '@podium/model'
import type { SyncSubmitInput, SyncSubmitReply } from '@podium/protocol'
import type { ChangeLogReadRow } from '@podium/sync'
import type { Oracle } from '../sessions/oracle-support'

/** The envelope a client outbox sends, for one queued command at version 1. */
export function envelope(
  command: string,
  input: unknown,
  mutationId: string,
  extra: Partial<SyncSubmitInput> = {},
): SyncSubmitInput {
  return { mutationId: asMutationId(mutationId), command, version: 1, input, ...extra }
}

/** `sync.submit` over tRPC, as the operator: the path the apps take. */
export async function submit(o: Oracle, env: SyncSubmitInput): Promise<SyncSubmitReply> {
  return await o.call.sync.submit(env)
}

export function appliedReply(reply: SyncSubmitReply) {
  if (reply.outcome !== 'applied') {
    throw new Error(`expected an applied reply, got ${JSON.stringify(reply)}`)
  }
  return reply
}

/**
 * Every change row in the log, oldest first, with its provenance. Read from the
 * store, not through a principal's feed: per-user rows (layout, read marks,
 * snoozes) are scoped to their owner, and this asks what was WRITTEN.
 */
export async function changeRows(o: Oracle): Promise<readonly ChangeLogReadRow[]> {
  return await o.store.sync.changesSince(0)
}

/** The change rows one command wrote, by its provenance. */
export async function rowsOf(o: Oracle, mutationId: MutationId | string) {
  return (await changeRows(o)).filter((row) => row.mutationId === mutationId)
}

/** The change-log head now: what an honest receipt names after the call. */
export async function head(o: Oracle): Promise<number> {
  return await o.reg.changeLedger.cursor()
}

/**
 * The three properties every family test asserts through `sync.submit`: the
 * rows the command wrote carry its provenance, the receipt is the head after
 * the call, and a replay returns the recorded result without running again.
 */
export async function expectAppliedOnPath(
  o: Oracle,
  env: SyncSubmitInput,
  opts: { writes: boolean },
): Promise<{ result: unknown; rows: readonly ChangeLogReadRow[] }> {
  const reply = appliedReply(await submit(o, env))
  if (reply.replayed) throw new Error('the first submit must apply, not replay')
  const rows = await rowsOf(o, env.mutationId)
  if (opts.writes && rows.length === 0) {
    throw new Error(`${env.command} wrote no change row carrying its mutationId`)
  }
  // The head after the call: at or past every row it wrote, and never past
  // what the log holds. (Equality with the head is not asserted: the fixture's
  // own background writes may land between the reply and this read.)
  const newest = Math.max(0, ...rows.map((row) => row.seq))
  if (reply.receipt.seq < newest || reply.receipt.seq > (await head(o))) {
    throw new Error(`receipt ${reply.receipt.seq} is not the head after ${env.command}`)
  }
  for (const row of rows) {
    if (row.causationId !== env.mutationId) {
      throw new Error(`${env.command} row ${row.entity}:${row.entityId} has no causationId`)
    }
  }
  const replay = appliedReply(await submit(o, env))
  if (!replay.replayed) throw new Error(`${env.command}: the second submit was not a replay`)
  // The ledger stores a void result as null.
  if (JSON.stringify(replay.result ?? null) !== JSON.stringify(reply.result ?? null)) {
    throw new Error(`${env.command}: the replay answered something else`)
  }
  // Rows the command's after-commit work writes (a delivery) carry no
  // provenance; a replay that ran the handler again would add rows that do.
  if ((await rowsOf(o, env.mutationId)).length !== rows.length) {
    throw new Error(`${env.command}: the replay wrote again`)
  }
  return { result: reply.result, rows }
}
