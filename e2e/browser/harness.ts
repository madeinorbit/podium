import { fileURLToPath } from 'node:url'
import { type DaemonHandle, startDaemon } from '../../apps/daemon/src/daemon'
import { type ServerHandle, startServer } from '../../apps/server/src/server'

const FIXTURE = fileURLToPath(
  new URL('../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

export interface Relay {
  serverPort: number
  hub: ServerHandle['hub']
  stop(): Promise<void>
}

export async function startRelay(): Promise<Relay> {
  const server: ServerHandle = await startServer()
  const daemon: DaemonHandle = await startDaemon({
    serverUrl: `ws://localhost:${server.port}`,
    sessionId: 's1',
    cmd: process.execPath,
    args: [FIXTURE],
    cols: 80,
    rows: 24,
  })
  return {
    serverPort: server.port,
    hub: server.hub,
    async stop() {
      await daemon.close()
      await server.close()
    },
  }
}
