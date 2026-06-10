import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DaemonHandle, startDaemon } from '../../../apps/daemon/src/daemon'
import { type ServerHandle, startServer } from '../../../apps/server/src/server'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

export interface Relay {
  serverPort: number
  registry: ServerHandle['registry']
  createSession(label: string): Promise<string>
  stop(): Promise<void>
}

export async function startRelay(): Promise<Relay> {
  const server: ServerHandle = await startServer()
  const daemon: DaemonHandle = await startDaemon({
    serverUrl: `ws://localhost:${server.port}`,
    // Spawn the deterministic fixture; label it by its cwd so each session renders distinct content.
    launch: (_kind, opts) => ({
      cmd: process.execPath,
      args: [FIXTURE, '--label', opts.cwd],
      cwd: opts.cwd,
    }),
  })
  return {
    serverPort: server.port,
    registry: server.registry,
    async createSession(label) {
      const dir = await mkdtemp(join(tmpdir(), `pod-${label}-`))
      return server.registry.createSession({ agentKind: 'claude-code', cwd: dir, title: label })
        .sessionId
    },
    async stop() {
      await daemon.close()
      await server.close()
    },
  }
}
