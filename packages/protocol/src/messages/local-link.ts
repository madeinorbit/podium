import type { ControlMessage } from './control'
import type { DaemonMessage } from './daemon'

/**
 * In-process daemon↔server link for all-in-one mode [POD-196].
 *
 * When the daemon and server share one process, routing every PTY frame batch
 * through the loopback WebSocket costs a full encode → send → parse → schema
 * validation round trip per message — the dominant CPU tax under active
 * session load. This seam lets the composition root (scripts/cli.ts) hand the
 * daemon a direct channel instead. Remote daemons keep the WebSocket path and
 * its zod trust boundary untouched.
 *
 * Contract:
 * - Messages pass BY REFERENCE: a message is immutable once handed to
 *   `deliver` (both directions). The WS path deep-copied via JSON as a side
 *   effect; callers must not rely on that.
 * - Delivery is async (microtask): a `deliver` call never re-enters the
 *   sender's stack, mirroring the ordering the socket transport implied.
 * - `attach` performs the equivalent of a successful local handshake: the
 *   server registers the local machine's daemon socket; `close` detaches it.
 */
export interface LocalDaemonLink {
  attach(opts: { deliver: (msg: ControlMessage) => void }): {
    machineId: string
    deliver(msg: DaemonMessage): void
    close(): void
  }
}
