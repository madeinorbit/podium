/** Boot the real daemon runtime; managed installs hand off the supervisor credential. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadSupervisorState } from '../../packages/runtime/src/machine-supervisor'
const dir = process.env.PODIUM_STATE_DIR!
if (existsSync(join(dir, 'supervisor.json'))) {
  const state = loadSupervisorState(dir)
  process.env.PODIUM_SUPERVISOR_MACHINE_ID = state.machineId
  if (state.token) process.env.PODIUM_SUPERVISOR_MACHINE_TOKEN = state.token
}
const serverArg = process.argv.indexOf('--server')
const serverUrl = process.argv[serverArg + 1]
if (serverArg < 0 || !serverUrl) throw new Error('fixture daemon requires --server')
const { startDaemon } = await import('../../apps/daemon/src/daemon')
const daemon = await startDaemon({ serverUrl, identityDir: dir })
process.once('SIGTERM', async () => { await daemon.close(); process.exit(0) })
