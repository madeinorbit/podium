/**
 * Generation-1 daemon for the POD-4433 restart test.
 *
 * Launches one engine per server family under the real podium-host, drives
 * each to a live session (codex holds an OPEN turn), prints one READY line per
 * engine, then idles until it is SIGKILLed — the REAL daemon restart the issue
 * demands, not an in-process re-creation. Sockets close with the process, so
 * the writer lease frees exactly the way production frees it.
 *
 * Run by `server-host-survival.integration.test.ts` as
 * `<bun> --conditions=@podium/source <this file>` with GEN1_* env set.
 */
import { createGrokAcpRuntime, createOpencodeRuntime, createCodexRuntime } from '@podium/agent-runtime'
import { createDurableProcess } from '@podium/process/durable'
import { createCodexHost } from '../runtime/codex-app-server.js'
import { createGrokAcpHost } from '../runtime/grok-acp-server.js'
import { createOpencodeHost } from '../runtime/opencode-server.js'

const root = process.env.GEN1_ROOT as string
const workdir = `${root}/work`
const noResources = () => undefined
const durable = createDurableProcess('host', { host: true, abduco: false })

const ready = (engine: string, binding: unknown): void => {
  process.stdout.write(`READY ${engine} ${JSON.stringify(binding)}\n`)
}

const codexHost = createCodexHost({ resources: noResources, durable })
const codexRuntime = createCodexRuntime(codexHost)
const codexHandle = await codexRuntime.driver.create({
  harness: 'codex',
  selection: {
    auth: 'subscription',
    platform: 'linux',
    available: ['codex-app-server'],
    preference: 'codex-app-server',
  },
  workdir,
  model: {},
  instructions: { supported: false, reason: 'survival probe' },
  mcpServers: { supported: false, reason: 'survival probe' },
})
// The in-flight turn: accepted by the stub engine, held open until generation
// 2 drops the COMPLETE file. Abandoning it is what the old code did.
await codexHandle.send({ text: 'survive this' }, { origin: 'human', delivery: 'when-ready' })
ready('codex', codexHandle.binding)

const opencodeHost = createOpencodeHost({ resources: noResources, durable })
const opencodeRuntime = createOpencodeRuntime(opencodeHost)
const opencodeHandle = await opencodeRuntime.driver.create({
  harness: 'opencode',
  selection: {
    auth: 'api-key',
    platform: 'linux',
    available: ['opencode-server'],
    preference: 'opencode-server',
  },
  workdir,
  model: {},
  instructions: { supported: false, reason: 'survival probe' },
  mcpServers: { supported: false, reason: 'survival probe' },
})
ready('opencode', opencodeHandle.binding)

const grokHost = createGrokAcpHost({ resources: noResources, durable })
const grokRuntime = createGrokAcpRuntime(grokHost)
const grokHandle = await grokRuntime.driver.create({
  harness: 'grok',
  selection: {
    auth: 'subscription',
    platform: 'linux',
    available: ['grok-acp'],
    preference: 'grok-acp',
  },
  workdir,
  model: {},
  instructions: { supported: false, reason: 'survival probe' },
  mcpServers: { supported: false, reason: 'survival probe' },
})
ready('grok', grokHandle.binding)

// Idle until the test kills us. The engines belong to podium-host, not to us.
await new Promise(() => {})
