import { startDaemon } from '../../src/daemon.js'

const [serverUrl, bootstrapToken, settingsDir] = process.argv.slice(2)
if (!serverUrl || !bootstrapToken || !settingsDir) {
  throw new Error('usage: build-report-compiled <server-url> <bootstrap-token> <settings-dir>')
}

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
try {
  daemon = await startDaemon({
    serverUrl,
    bootstrapToken,
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
