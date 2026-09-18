import { writeDaemonHealth } from '../../packages/runtime/src/daemon-health'
import { decodeParentMessage, encodeLifecycle } from '../../packages/runtime/src/lifecycle-channel'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { startParentWithUpdateConfirmation } from '../../apps/cli/src/parent-boot-confirmation'
import { MachineUpdateExecutor } from '../../packages/runtime/src/machine-update'
import { startMachineUpdateControl } from '../../packages/runtime/src/machine-update-control'
import { ParentProcess, PARENT_SUCCESSOR_ENV, PARENT_HANDOVER_DEADLINE_ENV, type SpawnChildFn } from '../../packages/runtime/src/parent-process'

const runtimeDir = process.argv[2]!
class UnreadyChild extends EventEmitter {
  pid = process.pid
  exitCode: number | null = null
  connected = true
  send(frame: object) {
    if (process.argv[3] === 'blocked' && decodeParentMessage(frame)?.type === 'identity') {
      writeDaemonHealth({ state: 'blocked', processId: this.pid, appVersion: '2.0.0',
        blockedReason: 'protocol-mismatch: peer wire version too new' }, runtimeDir)
      this.emit('message', encodeLifecycle({ type: 'ready', role: 'daemon', pid: this.pid, version: '2.0.0' }))
    }
    return true
  }
  kill() {
    this.exitCode = 0
    this.emit('exit', 0, null)
    return true
  }
}
let now = 0
let control: Awaited<ReturnType<typeof startMachineUpdateControl>> | undefined
const updates = new MachineUpdateExecutor({
  runtimeDir,
  adapter: {
    runningVersion: () => '2.0.0',
    prepare: async () => ({ digest: 'unused' }),
    activate: async () => {},
    discard: async () => {},
    restart: async () => 'handover-pending',
  },
  report: () => {},
})
const parent = new ParentProcess({
  stateDir: runtimeDir,
  installDir: join(runtimeDir, 'install'),
  installBinary: '/unused/podium',
  port: 19099,
  children: ['daemon'],
  env: {
    PODIUM_APP_VERSION: '2.0.0',
    [PARENT_SUCCESSOR_ENV]: '1',
    [PARENT_HANDOVER_DEADLINE_ENV]: process.env[PARENT_HANDOVER_DEADLINE_ENV] ?? '120000',
  },
  spawn: (() => new UnreadyChild()) as unknown as SpawnChildFn,
  now: () => now,
  sleep: async (ms) => { now += ms },
  notify: () => {},
  exit: () => {},
})
try {
  await startParentWithUpdateConfirmation(parent, updates, async () => {
    control = await startMachineUpdateControl(runtimeDir, updates, undefined, parent.bootHealthSignal)
  })
  if (parent.isBootHealthy()) throw new Error('fixture unexpectedly passed health gate')
  await parent.stop()
  if (!parent.bootHealthSignal.aborted) throw new Error('fixture did not abort gate')
} finally {
  parent.removeSignalHandlers()
  await parent.stop()
  await control?.close()
}
