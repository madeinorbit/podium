/** Isolated Alice/Bob server for the capability screen browser acceptance. */
import { rmSync } from 'node:fs'
import { startTwoMemberInstance } from '../../apps/server/src/test-support/two-member-instance'
import { applyHarnessEnv } from './harness-env'

const dirs = applyHarnessEnv(0)
delete process.env.PODIUM_PASSWORD
// A sign-in fixture must not poll an external release feed or open update offers.
process.env.PODIUM_UPDATE_FEED_POLLING = 'off'
const instance = await startTwoMemberInstance({ runtimeWorkers: true })
// The unit fixture registers repository roots but their checkout projection arrives later.
// Seed those known roots before the browser's first sync, so it sees an established workspace.
for (const machineId of Object.values(instance.machines)) {
  await instance.handle.registry.modules.checkouts.registrationsChanged(machineId)
}
console.log(`PEOPLE_FIXTURE ${JSON.stringify({ origin: instance.origin })}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  await instance.close()
  rmSync(dirs.base, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', () => void close())
process.on('SIGINT', () => void close())
