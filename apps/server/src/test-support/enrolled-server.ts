/** Explicit legacy-bearer fixture for transport tests; production boot never enrolls machines. */
import { randomUUID } from 'node:crypto'
import { startServer as startUnenrolledServer } from '../server'

export async function startServer(opts: Parameters<typeof startUnenrolledServer>[0] = {}) {
  const server = await startUnenrolledServer(opts)
  const machineToken = randomUUID()
  await server.registry.modules.machines.ensureHostMachine('transport-test-host', machineToken)
  return Object.assign(server, { machineToken })
}
