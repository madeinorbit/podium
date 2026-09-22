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
  claudeEngineFacts,
  codexEngineFacts,
  createClaudeEngineHost,
  createClaudeSdkSessionRuntime,
  createCodexEngineHost,
  createCodexRuntime,
  createGrokAcpRuntime,
  createGrokEngineHost,
  createOpencodeEngineHost,
  createOpencodeRuntime,
  grokEngineFacts,
  opencodeFlavor,
  type ClaudeEngineJournalEntry,
  type CodexJournalEntry,
  type GrokAcpJournalEntry,
  type OpencodeJournalEntry,
} from '@podium/harness/driver/host'
import { createDurableProcess } from '@podium/process/durable'
import { manifestFor } from '@podium/harness'
import type { SessionId } from '@podium/model'
import { stageRuntimeAttachment } from '../runtime/attachment-staging.js'
import {
  composeEngineEnv,
  dialEngineSocket,
  engineSocketRoot,
} from '../runtime/host.js'
import { createSessionEngineScope } from '../session/engines.js'
import { SERVER_GRACEFUL_EXIT_MS } from '../runtime/server-teardown-budget.js'
import {
  codexAppServerVersionProbe,
  grokAcpVersionProbe,
  opencodeVersionProbeForExecutable,
} from '../runtime/version-probe.js'
import { driverSlotsOver } from '../session/driver-slots.js'
import { testSessions } from '../session/testing.js'

const root = process.env.GEN1_ROOT as string
const workdir = `${root}/work`
const noResources = () => undefined
const durable = createDurableProcess('host', { host: true, abduco: false })
// Gen1 launches through the session layer's engine hold, exactly as the
// daemon wires it.
const sessionEngines = createSessionEngineScope(durable)

const ready = (engine: string, binding: unknown): void => {
  process.stdout.write(`READY ${engine} ${JSON.stringify(binding)}\n`)
}

const codexFacts = codexEngineFacts(manifestFor('codex')!)
const grokFacts = grokEngineFacts(manifestFor('grok')!)
const claudeFacts = claudeEngineFacts(manifestFor('claude-code')!)
const flavor = opencodeFlavor(manifestFor('opencode')!)

const codexHost = createCodexEngineHost({
  facts: codexFacts,
  engines: sessionEngines,
  supervision: sessionEngines,
  journal: sessionEngines.journalFor<CodexJournalEntry>(codexFacts.journalNamespace),
  stageAttachment: stageRuntimeAttachment,
  resources: noResources,
  buildEnv: composeEngineEnv,
  gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
  checkVersion: () => codexAppServerVersionProbe(),
  socketRoot: engineSocketRoot(),
  dialSocket: dialEngineSocket,
})
const codexRuntime = createCodexRuntime(codexHost, driverSlotsOver(testSessions()))
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
  engines: sessionEngines,
  supervision: sessionEngines,
  journal: sessionEngines.journalFor<OpencodeJournalEntry>(flavor.journalNamespace),
  stageAttachment: stageRuntimeAttachment,
  resources: noResources,
  buildEnv: composeEngineEnv,
  gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
  checkVersion: ({ executable }) =>
    opencodeVersionProbeForExecutable(executable).then((v) => (v.drivable ? null : v.diagnostic)),
})
const opencodeRuntime = createOpencodeRuntime(opencodeHost, driverSlotsOver(testSessions()))
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
  engines: sessionEngines,
  supervision: sessionEngines,
  journal: sessionEngines.journalFor<GrokAcpJournalEntry>(grokFacts.journalNamespace),
  resources: noResources,
  buildEnv: composeEngineEnv,
  gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
  checkVersion: () => grokAcpVersionProbe(),
})
const grokRuntime = createGrokAcpRuntime(grokHost, driverSlotsOver(testSessions()))
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

// CLAUDE: one stream engine under the host, holding an OPEN turn until
// generation 2 drops the COMPLETE file. The launch returns once the turn is
// accepted; the journal entry (engine bound, pid known) is what READY waits
// for, so generation 2 never adopts a label with nothing behind it.
const claudeEngine = createClaudeEngineHost({
  facts: claudeFacts,
  engines: sessionEngines,
  supervision: sessionEngines,
  journal: sessionEngines.journalFor<ClaudeEngineJournalEntry>(claudeFacts.journalNamespace),
  buildEnv: composeEngineEnv,
  gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
})
const claudeRuntime = createClaudeSdkSessionRuntime({ driverSlots: driverSlotsOver(testSessions()),
  send: () => {},
  emitBind: () => {},
  sessionReady: () => {},
  traceRuntimeEvent: () => {},
  startMailContinuation: () => () => {},
  facts: claudeFacts,
  engine: claudeEngine,
  transcript: {
    readHistory: async () => ({ items: [], hasMore: false }),
    archiveTranscript: async () => {
      throw new Error('no archive in the survival probe')
    },
    readFileBytes: async () => new Uint8Array(),
  },
})
const claudeHandle = await claudeRuntime.launch({
  sessionId: 'claude-surv-1' as SessionId,
  cwd: workdir,
  initialPrompt: 'survive this',
})
const claudeReadySince = Date.now()
let claudeEntry = claudeEngine.journal.read('claude-surv-1' as SessionId)
while (!claudeEntry?.process.pid) {
  if (Date.now() - claudeReadySince > 60_000) throw new Error('claude engine never bound')
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  claudeEntry = claudeEngine.journal.read('claude-surv-1' as SessionId)
}
// The READY line carries the ENGINE identity (journal process key + pid),
// not the contract core's embedded placeholder: generation 2 adopts by
// journal and must prove the SAME child serves it.
ready('claude', { ...claudeHandle.binding, process: claudeEntry.process })

// Idle until the test kills us. The engines belong to podium-host, not to us.
await new Promise(() => {})
