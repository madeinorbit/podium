/**
 * THE SERVER FAMILY'S LOST QUEUES, AS THE DAEMON REPORTS THEM (POD-2297).
 *
 * The counterpart of the two lines in `terminal-driver.ts` that answer
 * `onDrainAbandoned`, and deliberately the same two things in the same order:
 *
 *   1. LOG IT, always. One line naming the session, the reason and the turns is
 *      the least this can cost, and it is the difference between a bug someone
 *      can find and a session that quietly answers nothing.
 *   2. FORWARD IT as `runtimeQueueDrainAbandoned`, whose `send` puts it in the
 *      daemon's fsynced outbox before returning — the driver drops its in-memory
 *      copy the moment this callback returns, so anything less durable would
 *      just move the loss one layer down (POD-2202).
 *
 * ONE HELPER FOR ALL RUNTIME ADAPTERS. codex, opencode, grok and Claude keep their
 * protocols apart and their daemon translation identical on purpose; a queue
 * abandonment is a fact about the CONTRACT, not about any of their protocols,
 * so there is nothing here for a family to differ on but its name in the log.
 *
 * WHY IT IS WIRED IN THE DRIVER ADAPTER AND NOT IN THE `*RuntimeHost`: a lost
 * queue becomes a durable SERVER-side receipt correction, and the frame stream
 * is what reaches the server. The hosts own processes and disks and have no
 * `send`.
 */

import { randomUUID } from 'node:crypto'
import type { OnQueueAbandoned } from '@podium/agent-runtime'
import { createLogger } from '@podium/logger'
import type { DaemonMessage } from '@podium/protocol/daemon'

const log = createLogger('daemon:queue-abandonment')

/**
 * Build the `onQueueAbandoned` port for one server-family driver.
 *
 * TURNS WITH NO CALLER-SUPPLIED ID ARE LOGGED BUT NOT FRAMED. `TurnInput.id` is
 * optional by the contract — a driver-local queue can hold a turn nobody durable
 * is waiting on — and the frame's `turnIds` is `min(1)` because a report naming
 * nothing corrects nothing. Sending a synthetic id would be worse than sending
 * no frame: the server would look it up, find no row, and record a correction it
 * did not make. So the log line carries the full count and the frame carries the
 * turns a receipt actually exists for; when those two numbers differ, the log
 * says so rather than leaving the gap to be inferred.
 */
export function reportQueueAbandonment(
  family: 'codex' | 'opencode' | 'grok' | 'claude-sdk',
  send: (msg: DaemonMessage) => void,
): OnQueueAbandoned {
  return ({ sessionId, turns, reason }) => {
    const turnIds = turns.flatMap((turn) => (turn.input.id ? [turn.input.id] : []))
    /**
     * THE LOG COMES FIRST, AND THAT ORDER IS LOAD-BEARING (POD-2297 review, R2).
     *
     * The drivers swallow a throw from this port so that a failed report cannot
     * leak the agent's child, and the ONLY thing that makes swallowing honest is
     * that the abandonment has already been said out loud by the time anything
     * can fail. `send` below fsyncs a durable outbox — ENOSPC, EDQUOT, EIO and a
     * reportId collision all throw from it.
     *
     * SO DO NOT MOVE THIS BELOW `send`, and do not fold a value `send` produces
     * (a reportId, a queue depth) into it. Doing so turns a persist failure back
     * into the exact silent loss this issue closes. Pinned by
     * `codex-driver.test.ts` — 'still logs when the durable send throws'.
     */
    log.warn('queued turns were never delivered', {
      family,
      sessionId,
      reason,
      turns: turns.length,
      turnIds,
      ...(turnIds.length === turns.length ? {} : { unattributed: turns.length - turnIds.length }),
    })
    if (turnIds.length === 0) return
    send({
      type: 'runtimeQueueDrainAbandoned',
      reportId: randomUUID(),
      sessionId,
      turnIds,
      reason,
    })
  }
}
