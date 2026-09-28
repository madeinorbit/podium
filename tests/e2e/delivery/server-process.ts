/**
 * THE SERVER, AS ITS OWN OPERATING-SYSTEM PROCESS (POD-4779).
 *
 * The daemon already has one of these (`../daemon-process.ts`); this is the
 * same idea for the other side of the link. A server restart the server
 * PARTICIPATES in (`close()`) flushes, closes sockets politely and settles what
 * it can; a SIGKILL does none of that, and the delivery chain has to be correct
 * under the second. So the delivery-outage lane runs the server here, in its own
 * pid, and kills it for real.
 *
 * Everything a restart must reproduce exactly — port, state dir, the host's
 * machine credential — is in one JSON file named on argv, so the process that
 * comes back is the same server, not a lookalike that would fail for an
 * unrelated reason.
 *
 *   bun --conditions=@podium/source tests/e2e/delivery/server-process.ts <config.json>
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { addSink, createConsoleSink } from '@podium/logger'
import { asMachineId } from '@podium/model'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { startServer } from '../../../apps/server/src/server'

export interface ServerProcessConfig {
  port: number
  /** The legacy bearer the daemon presents; enrolled idempotently at every boot. */
  machineToken: string
  /** Written with this process's pid once the server is listening. */
  readyFile: string
}

const configPath = process.argv[2]
if (!configPath) throw new Error('usage: server-process.ts <config.json>')
const config = JSON.parse(readFileSync(configPath, 'utf8')) as ServerProcessConfig

// Nothing else installs a sink; across a process boundary the log is the only
// narration the parent gets (see `../daemon-process.ts`).
addSink(createConsoleSink())

const server = await startServer({ port: config.port, host: '127.0.0.1' })
// The transport fixture's enrollment (`enrolled-server.ts`), inlined because
// the token must be the SAME one across restarts, not a fresh uuid.
await server.registry.modules.machines.ensureHostMachine(
  'delivery-outage-host',
  config.machineToken,
)
// Enrolled as a server only; the agents run here too.
await server.registry.modules.machines.changeAssignment(
  asMachineId(readOrCreateLocalMachineId()),
  { server: true, agentExecution: true },
  'delivery-outage-lane',
)
// Atomically: the parent polls for the marker's EXISTENCE and then reads it,
// and a marker seen between create and write reads as an empty pid.
writeFileSync(`${config.readyFile}.tmp`, String(process.pid), { mode: 0o600 })
renameSync(`${config.readyFile}.tmp`, config.readyFile)

const stop = (): void => {
  void server.close().then(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await new Promise(() => {})
