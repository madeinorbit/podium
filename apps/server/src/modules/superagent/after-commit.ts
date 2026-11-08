/**
 * WORK OUTSIDE THE DATABASE, AFTER THE WRITE IT FOLLOWS (ADR 12 D2 step 7, ADR 2
 * D10; POD-6419).
 *
 * The superagent's commands run on the sync write entry point, inside its one
 * unit of work. A daemon frame (a headless spawn, an interrupt, a turn), a kill,
 * a PTY resume, a timer and a socket push must not happen there: a rollback would
 * leave them done for a write that never happened. {@link afterCommitOrNow} is the
 * one door for that work in this module:
 *
 *  - INSIDE A UNIT OF WORK (the entry point's), the step is registered to run
 *    once the outermost commit lands, never on a rollback, and outside the
 *    command's write provenance: what it writes is the server's own follow-up,
 *    not part of the write the receipt covers. It is not awaited; a failure is
 *    logged, and every step here leaves its own durable trace of a failure (the
 *    turn's failure rows) or is best-effort by contract (a kill, an interrupt).
 *  - WITH NO UNIT OPEN (an in-process caller: the Telegram bridge, a test), it
 *    runs now and is awaited, so the caller sees exactly what it always saw,
 *    errors included.
 */

import { createLogger, describeError } from '@podium/logger'
import { afterCommit, spanOpen } from '../../store/executor/executor'
import { outsideWriteProvenance } from '../../write-provenance'

const log = createLogger('server:superagent')

export type AfterCommitStep = () => void | Promise<void>

export async function afterCommitOrNow(step: AfterCommitStep, label: string): Promise<void> {
  if (!spanOpen()) {
    await step()
    return
  }
  afterCommit(async () => {
    try {
      await outsideWriteProvenance(step)
    } catch (error) {
      log.warn('superagent: after-commit work failed', { label, error: describeError(error) })
    }
  }, label)
}
