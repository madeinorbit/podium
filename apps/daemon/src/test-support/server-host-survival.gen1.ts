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
import {
  codexEngineFacts,
  createCodexEngineHost,
  createCodexRuntime,
  createGrokAcpRuntime,
  createGrokEngineHost,
  createOpencodeEngineHost,
  createOpencodeRuntime,
  grokEngineFacts,
  opencodeFlavor,
  type CodexJournalEntry,
  type GrokAcpJournalEntry,
  type OpencodeJournalEntry,
} from '@podium/harness/driver/host'
import { createDurableProcess } from '@podium/process/durable'
import { stageRuntimeAttachment } from '../runtime/attachment-staging.js'
import {
  composeEngineEnv,
  createEngineJournal,
  dialEngineSocket,
  engineSocketRoot,
  supervisionFor,
} from '../runtime/host.js'
import { SERVER_GRACEFUL_EXIT_MS } from '../runtime/server-teardown-budget.js'
import {
  codexAppServerVersionProbe,
  grokAcpVersionProbe,
  opencodeVersionProbeForExecutable,
} from '../runtime/version-probe.js'

const root = process.env.GEN1_ROOT as string
const workdir = `${root}/work`
const noResources = () => undefined
const durable = createDurableProcess('host', { host: true, abduco: false })

const ready = (engine: string, binding: unknown): void => {
  process.stdout.write(`READY ${engine} ${JSON.stringify(binding)}\n`)
}

const codexFacts = codexEngineFacts()
const grokFacts = grokEngineFacts()
const flavor = opencodeFlavor()

const codexHost = createCodexEngineHost({
  facts: codexFacts,
  supervision: supervisionFor(durable),
  journal: createEngineJournal<CodexJournalEntry>({ namespace: codexFacts.journalNamespace }),
  stageAttachment: stageRuntimeAttachment,
  resources: noResources,
  buildEnv: composeEngineEnv,
  gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
  checkVersion: () => codexAppServerVersionProbe(),
  socketRoot: engineSocketRoot(),
  dialSocket: dialEngineSocket,
})
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

const opencodeHost = createOpencodeEngineHost({
  flavor,
  supervision: supervisionFor(durable),
  journal: createEngineJournal<OpencodeJournalEntry>({ namespace: flavor.journalNamespace }),
  stageAttachment: stageRuntimeAttachment,
  resources: noResources,
  buildEnv: composeEngineEnv,
  gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
  checkVersion: ({ executable }) =>
    opencodeVersionProbeForExecutable(executable).then((v) => (v.drivable ? null : v.diagnostic)),
})
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

const grokHost = createGrokEngineHost({
  facts: grokFacts,
  supervision: supervisionFor(durable),
  journal: createEngineJournal<GrokAcpJournalEntry>({ namespace: grokFacts.journalNamespace }),
  resources: noResources,
  buildEnv: composeEngineEnv,
  gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
  checkVersion: () => grokAcpVersionProbe(),
})
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
