/**
 * THE SERVER FAMILY'S HALF OF "ACCEPTED INPUT NEVER VANISHES" (POD-2297).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM THE TERMINAL PORT
 * ---------------------------------------------------------------------------
 *
 * The terminal family already reports its lost queues:
 * `TerminalInjectionPorts.onDrainAbandoned` → `runtimeQueueDrainAbandoned` →
 * the daemon's fsynced outbox → a `dead_letter` row carrying
 * `deliveryDeferredReason` (POD-2132, POD-2202). Read that port's comment first;
 * every rule it states — the report is the point of no return, the transport is
 * at-least-once, consumers dedupe by turn id — governs this one unchanged.
 *
 * The server families (codex, opencode, grok) had NO equivalent. Each keeps a
 * driver-local FIFO for turns it cannot start yet — a `steer` downgraded to a
 * queue, a nudge parked behind a human's take-over lease, anything that arrived
 * while a turn was open — and every one of them answered `queued`. Then
 * `drainQueue()` swallowed a failed `deliver()` in a bare `catch { return }`,
 * and `stop()`/`kill()`/`hibernate()`/`forget()`/`dispose()` dropped whatever
 * was still parked. The caller's receipt said `queued`, the ledger agreed, and
 * the turn was gone with no row, no event and no log line.
 *
 * That window stopped being theoretical when POD-2291 made the server's durable
 * inbox TRANSFER CUSTODY on a `queued` receipt: from that commit on, "the driver
 * has it" is the last thing the server records, so a driver that loses it loses
 * it for everybody.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT SHARE THE TERMINAL PORT OUTRIGHT
 * ---------------------------------------------------------------------------
 *
 * Because the two queues hold different things. Terminal's `QueuedTurn` is TEXT
 * about to be typed, with an id its enqueuer always supplies; a server driver's
 * is the contract's own `{ input, options }` pair, whose `TurnInput.id` is
 * OPTIONAL by the contract. So the shapes differ, and collapsing them would mean
 * inventing an id for turns that never had one. What IS shared — and shared
 * deliberately, as one enum in one place — is the REASON vocabulary, which comes
 * from the wire (`@podium/protocol`) rather than from either driver family.
 */

import type { SessionId } from '@podium/model'
import type { QueueDrainAbandonedReason } from '@podium/protocol'
import type { SendOptions, TurnInput } from './turns.js'

/** One turn a server-family queue accepted and will not deliver. The driver's
 *  own queue entry, handed over verbatim: the host decides what of it to
 *  forward, and `input.id` is what a receipt is corrected by. */
export interface AbandonedQueuedTurn {
  readonly input: TurnInput
  readonly options: SendOptions
}

/**
 * A server-family driver reporting turns it accepted and will never deliver.
 *
 * OPTIONAL ON EVERY HOST, exactly as the terminal port is: a host with no
 * receipt to correct (the conformance harness, a test double) may omit it. The
 * DAEMON's adapters do not treat it as optional — like `terminal-driver.ts` they
 * log every abandonment unconditionally and then forward, because a machine that
 * can only correct SOME receipts must still leave a trace of the rest.
 *
 * TURNS WITH NO `input.id` ARE STILL REPORTED. A driver-local queue can hold a
 * turn nobody durable is waiting on, and the honest thing is to hand it over and
 * let the host find nothing to correct — not to filter it out here and make the
 * report claim a smaller loss than happened.
 */
export type OnQueueAbandoned = (input: {
  sessionId: SessionId
  turns: readonly AbandonedQueuedTurn[]
  reason: QueueDrainAbandonedReason
}) => void
