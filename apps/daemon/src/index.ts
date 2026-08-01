/**
 * @podium/daemon — per-machine agent host. Spawns an agent via @podium/harness
 * and relays it to @podium/server over a WebSocket.
 */

export type { DaemonHandle, DaemonOptions } from './daemon'
export { startDaemon } from './daemon'
