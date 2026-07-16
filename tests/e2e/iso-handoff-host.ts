/**
 * Isolated two-machine handoff E2E host (issue #498). Runs a REAL server +
 * local daemon from branch source on an isolated port/state dir, binds
 * 0.0.0.0 so a second machine's daemon (vmi) can join over the tailnet, and
 * exposes a tiny loopback control API so the scenario can be driven step by
 * step from the shell.
 *
 * Run from the worktree root:
 *   node --conditions=@podium/source --import tsx tests/e2e/iso-handoff-host.ts
 *
 * Control API (127.0.0.1:ISO_CONTROL_PORT, default 18790):
 *   GET  /state              → { machines, sessions }
 *   POST /spawn   {cwd,title?}          → createSession (claude-code, local)
 *   POST /send    {sessionId,text}      → sendText
 *   POST /handoff {sessionId,machineId} → sessions.handoffSession (awaited)
 *   POST /scan                          → RepoRegistry.scanReposAll()
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentLaunchCommand,
  ConversationDiscoveryCache,
  type LaunchOptions,
  type LaunchSpec,
} from '@podium/agent-bridge'
import type { AgentKind } from '@podium/protocol'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { runIndexRefreshJob, runMemoryBreakdownJob } from '../../apps/daemon/src/discovery-jobs'
import type { WorkerJob } from '../../apps/daemon/src/discovery-worker'
import { DiscoveryWorkerClient, type WorkerLike } from '../../apps/daemon/src/worker-client'
import { LOCAL_MACHINE_ID } from '../../apps/server/src/local-machine'
import { sha256 } from '../../apps/server/src/modules/machines/service'
import { RepoRegistry } from '../../apps/server/src/repo-registry'
import { startServer } from '../../apps/server/src/server'
import type { SessionStore } from '../../apps/server/src/store'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

function inlineWorkerClient(): DiscoveryWorkerClient {
  return new DiscoveryWorkerClient({
    spawn: (): WorkerLike => {
      const handlers: Array<(m: unknown) => void> = []
      let cache: ConversationDiscoveryCache | undefined
      const indexCache = (cachePath?: string): ConversationDiscoveryCache => {
        if (!cache) cache = new ConversationDiscoveryCache(cachePath)
        return cache
      }
      return {
        postMessage(m: unknown) {
          const job = m as WorkerJob
          void (async () => {
            try {
              const value =
                job.kind === 'memoryBreakdown'
                  ? runMemoryBreakdownJob(job.input)
                  : await runIndexRefreshJob(job.input, indexCache(job.input.cachePath))
              for (const h of handlers) h({ id: job.id, ok: true, value })
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err)
              for (const h of handlers) h({ id: job.id, ok: false, error })
            }
          })()
        },
        on(ev, cb) {
          if (ev === 'message') handlers.push(cb)
        },
        terminate() {
          cache = undefined
        },
      }
    },
  })
}

// Scrub the ambient agent-session env: this harness is typically launched from
// INSIDE a Claude Code session, and a spawned claude that inherits
// CLAUDE_CODE_SESSION_ID/CLAUDE_CODE_CHILD_SESSION runs as a CHILD session of
// that conversation — its transcript never lands in a normal project bucket,
// which breaks handoff export (and any transcript-based feature under test).
for (const key of Object.keys(process.env)) {
  if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_') || key === 'PODIUM_AGENT_RELAY')
    delete process.env[key]
}

const PORT = Number(process.env.ISO_PORT ?? 18788)
const CONTROL_PORT = Number(process.env.ISO_CONTROL_PORT ?? 18790)
const SOURCE_REPO = process.env.ISO_SOURCE_REPO ?? '/home/mgw/src/other/podium'
const VMI_ID = process.env.ISO_VMI_ID ?? 'vmi-e2e'
const VMI_REPO = process.env.ISO_VMI_REPO ?? '/home/till/src/podium'
const VMI_TOKEN = process.env.ISO_VMI_TOKEN ?? 'iso-handoff-498-vmi-token'

reapHarnessSessions(PORT)
const { stateDir } = applyHarnessEnv(PORT)
process.env.PODIUM_HOST = '0.0.0.0'
process.env.PODIUM_NO_SCOPE = '1'

writeFileSync(join(stateDir, 'repos.json'), JSON.stringify([SOURCE_REPO]))
writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ mode: 'all-in-one' }))

const launch = (kind: AgentKind, opts: LaunchOptions): LaunchSpec => agentLaunchCommand(kind, opts)

const server = await startServer({ port: PORT })
const store = (server.registry as unknown as { store: SessionStore }).store
store.machines.upsertMachine({
  id: VMI_ID,
  name: 'vmi-iso',
  hostname: 'vmi3407763',
  tokenHash: sha256(VMI_TOKEN),
})
store.repos.addRepo(VMI_REPO, VMI_ID)
const repoRegistry = new RepoRegistry(server.registry, store)

const daemon = await startDaemon({
  serverUrl: `ws://127.0.0.1:${server.port}`,
  bootstrapToken: server.bootstrapToken,
  machineId: LOCAL_MACHINE_ID,
  launch,
  hooks: { port: 0 },
  agentRelay: { port: 0 },
  workerClient: inlineWorkerClient(),
})

const mods = server.registry.modules

async function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

const control = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let result: unknown
      if (req.method === 'GET' && url.pathname === '/state') {
        result = {
          machines: mods.machines.listMachines(),
          sessions: mods.sessions.listSessions(),
          repos: store.repos.listRepos(),
        }
      } else if (req.method === 'POST' && url.pathname === '/spawn') {
        const body = await readBody(req)
        result = mods.sessions.createSession({
          agentKind: 'claude-code',
          machineId: LOCAL_MACHINE_ID,
          ...(body as { cwd: string; title?: string }),
        })
      } else if (req.method === 'POST' && url.pathname === '/send') {
        const body = await readBody(req)
        result = mods.sessions.sendText(body as { sessionId: string; text: string })
      } else if (req.method === 'POST' && url.pathname === '/handoff') {
        const body = await readBody(req)
        result = await mods.sessions.handoffSession(
          body as { sessionId: string; machineId: string },
        )
      } else if (req.method === 'POST' && url.pathname === '/scan') {
        result = await repoRegistry.scanReposAll()
      } else {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })()
})
control.listen(CONTROL_PORT, '127.0.0.1')

console.log(
  `[iso-host] server ws://0.0.0.0:${server.port} control http://127.0.0.1:${CONTROL_PORT} state=${stateDir}`,
)
console.log(`[iso-host] vmi joins with: machineId=${VMI_ID} token=${VMI_TOKEN}`)

const shutdown = async (): Promise<void> => {
  await daemon.close({ reapSessions: true })
  await server.close()
  control.close()
}
process.on('SIGINT', () => void shutdown().then(() => process.exit(0)))
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)))
await new Promise(() => {})
