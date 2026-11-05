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
let droppedAcknowledgement = false
if (behavior?.startsWith('lose-ack')) {
  // Fault injection at the transport boundary: the unmodified historical owner
  // never sees the server's committed acknowledgement.
  const Original = globalThis.WebSocket
  globalThis.WebSocket = class extends Original {
    override addEventListener(type: any, listener: any, options?: any) {
      if (type !== 'message') return super.addEventListener(type, listener, options)
      return super.addEventListener(
        'message',
        (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data))
          if (frame.type === 'peerHelloOk') {
            droppedAcknowledgement = true
            return
          }
          listener.call(this, event)
        },
        options,
      )
    }
  } as typeof WebSocket
}
if (pairCode) {
  config.saveConfig({ ...config.loadConfig(), pairCode })
  const service = { policy: 'disabled', state: 'stopped', observedAt: new Date().toISOString() }
  const connection = supervisor.createMachineSupervisorConnection({
    state,
    stateDir: dir,
    serverUrl,
    pairCode,
    build: { appVersion: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version },
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
  if (behavior?.startsWith('lose-ack')) {
    if (ok || !droppedAcknowledgement)
      throw new Error('historical ACK was not lost after server commit')
  } else if (!ok) throw new Error('historical supervisor did not connect')
}
if (behavior === 'pending-rotation') credential.prepareMachineCredentialRotation(dir)
const saved = supervisor.loadSupervisorState(dir)
if (saved.registration !== undefined) throw new Error('old source unexpectedly wrote registration')
console.log(
  JSON.stringify({
    machineId: saved.machineId,
    publicKey: credential.machinePublicKeyWire(credential.readMachineCredential(dir)),
    ...(credential.readMachineCredential(dir).pendingRotation
      ? {
          pendingPublicKey: credential.machinePublicKeyWire(
            credential.readMachineCredential(dir).pendingRotation,
          ),
        }
      : {}),
    registration: 'absent',
    acceptedReceipt: saved.enrolledPublicKey !== undefined,
    droppedAcknowledgement,
    keyBytes: readFileSync(join(dir, 'machine.key')).length,
  }),
)
