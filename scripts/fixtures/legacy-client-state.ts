/** Executed by the historical release's Bun, importing only that release's source. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [source, serverUrl, pairCode, behavior] = process.argv.slice(2)
if (!source || !serverUrl) throw new Error('historical source and server required')
const setup = await import(join(source, 'packages/runtime/src/setup.ts'))
const supervisor = await import(join(source, 'packages/runtime/src/machine-supervisor.ts'))
const enrollment = await import(join(source, 'packages/runtime/src/setup-enrollment.ts'))
const credential = await import(join(source, 'packages/runtime/src/machine-credential.ts'))
const config = await import(join(source, 'packages/runtime/src/config.ts'))
const dir = process.env.PODIUM_STATE_DIR!
if (setup.applyLocalSetupDefault() !== 'applied') throw new Error('old local welcome did not apply')
let state = supervisor.loadSupervisorState(dir)
const pending = state.setupEnrollment
if (!pending) throw new Error('old source did not prepare local enrollment')
enrollment.confirmSetupEnrollment(pending.requestId, pending.publicKey, dir)
state = supervisor.loadSupervisorState(dir)
state.assignment = supervisor.reconcileSupervisorAssignment(state, config.loadConfig(), dir)
supervisor.saveSupervisorState(dir, state)
const selected = setup.applyMode({ mode: 'client', serverUrl })
state = supervisor.loadSupervisorState(dir)
state.assignment = supervisor.reconcileSupervisorAssignment(state, selected, dir)
supervisor.saveSupervisorState(dir, state)
// A second ordinary start on the SAME coordinator, using only historical owners.
state = supervisor.loadSupervisorState(dir)
state.assignment = supervisor.reconcileSupervisorAssignment(state, config.loadConfig(), dir)
supervisor.saveSupervisorState(dir, state)
writeFileSync(join(dir, 'retained-user-data'), 'history must survive\n')
if (pairCode) {
  config.saveConfig({ ...config.loadConfig(), pairCode })
  const service = { policy: 'disabled', state: 'stopped', observedAt: new Date().toISOString() }
  const connection = supervisor.createMachineSupervisorConnection({
    state,
    stateDir: dir,
    serverUrl,
    pairCode,
    build: { appVersion: config.loadConfig().appVersion ?? 'historical-source' },
    deliveryCaps: [],
    report: () => ({ server: service, agentExecution: service }),
    onGrant: () => {},
    onPaired: () => {
      if (behavior !== 'retain-code') setup.consumePairCode(pairCode)
    },
  })
  connection.start()
  const ok = await connection.waitUntilConnected(5_000)
  connection.close()
  if (!ok) throw new Error('historical supervisor did not connect')
}
const saved = supervisor.loadSupervisorState(dir)
if (saved.registration !== undefined) throw new Error('old source unexpectedly wrote registration')
console.log(
  JSON.stringify({
    machineId: saved.machineId,
    publicKey: credential.machinePublicKeyWire(credential.readMachineCredential(dir)),
    registration: 'absent',
    keyBytes: readFileSync(join(dir, 'machine.key')).length,
  }),
)
