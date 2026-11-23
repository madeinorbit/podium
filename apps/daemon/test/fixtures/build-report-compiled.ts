import { asMachineId } from '@podium/model'
import { startDaemon } from '../../src/daemon.js'

const [serverUrl, machineToken, settingsDir, machineId] = process.argv.slice(2)
if (!serverUrl || !machineToken || !settingsDir || !machineId) {
  throw new Error(
    'usage: build-report-compiled <server-url> <machine-token> <settings-dir> <machine-id>',
  )
}

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
try {
  daemon = await startDaemon({
    serverUrl,
    machineToken,
    machineId: asMachineId(machineId),
    hooks: { port: 0, settingsDir },
    agentRelay: { port: 0 },
    backend: 'none',
    discovery: { background: false, cachePath: ':memory:' },
    metrics: { background: false },
  })
  console.log('DAEMON_READY')
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
} finally {
  await daemon?.close().catch(() => {})
}
