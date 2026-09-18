/** Real server boot without a supervisor enrolling another host in the fixture. */
import { addSink } from '@podium/logger'
import { asMachineId } from '@podium/model'
import type { UpdateStatusMessage, UpdateTarget } from '@podium/protocol'
import { startServer } from '../../apps/server/src/server'

const grants: Record<string, unknown>[] = []
addSink({ name: 'skew-grants', write(record) {
  if (record.msg === 'update grant issued') grants.push({ ...record })
} })
const server = await startServer({ port: Number(process.env.PODIUM_PORT), host: '127.0.0.1' })
const statuses: { machineId: string; message: UpdateStatusMessage }[] = []
const updates = server.registry.modules.updates
const onStatus = updates.onStatus.bind(updates)
updates.onStatus = async (machineId, message) => {
  await onStatus(machineId, message)
  statuses.push({ machineId, message })
}
// Test-only control stays on a separate ephemeral loopback listener. It drives
// the production service and records actual grants/reports across the old wire.
const control = process.env.PODIUM_SKEW_CONTROL_PORT ? Bun.serve({
  hostname: '127.0.0.1', port: Number(process.env.PODIUM_SKEW_CONTROL_PORT),
  async fetch(request) {
    if (request.method === 'POST') {
      const { machineId, target } = await request.json() as { machineId: string; target: UpdateTarget }
      await server.registry.modules.machines.setUpdateChannel(asMachineId(machineId), 'dev')
      updates.setTarget('dev', target)
      return Response.json(await updates.authorizeMachine(asMachineId(machineId), {
        initiator: { kind: 'operator-apply' }, eligibility: 'customer upgrade skew acceptance',
      }))
    }
    return Response.json({ grants, statuses, fleet: await updates.fleet() })
  },
}) : undefined
process.once('SIGTERM', async () => { control?.stop(true); await server.close(); process.exit(0) })
