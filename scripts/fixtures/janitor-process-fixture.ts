import { writeFileSync } from 'node:fs'
import { startJanitor } from '../../apps/janitor/src/janitor'
import { startWatchdog } from '../../packages/runtime/src/sd-notify'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

const handle = await startJanitor({
  serverUrl: required('PODIUM_ACCEPTANCE_SERVER_URL'),
  token: required('PODIUM_ACCEPTANCE_TOKEN'),
  dbPath: required('PODIUM_ACCEPTANCE_DB_PATH'),
  tickMs: Number(process.env.PODIUM_ACCEPTANCE_TICK_MS ?? 250),
})
const stopWatchdog = startWatchdog({
  readProgress: () => handle.service.progressVersion(),
})
const startedFile = process.env.PODIUM_ACCEPTANCE_STARTED_FILE
if (startedFile) writeFileSync(startedFile, String(process.pid))

const shutdown = (): void => {
  stopWatchdog?.()
  handle.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
await new Promise(() => {})
