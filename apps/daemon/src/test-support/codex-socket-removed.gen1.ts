/**
 * Generation-1 daemon for the POD-4611 socket-removed relaunch test.
 *
 * Launches ONE codex engine (a stub `codex app-server`) through the session
 * layer's engine hold under the real podium-host, prints its handed address
 * and pid on a READY line, then idles until it is SIGKILLed — a real daemon
 * death, so the writer lease frees the way production frees it.
 *
 * Run by `codex-socket-removed.integration.test.ts` as
 * `<bun> --conditions=@podium/source <this file>` with GEN1_* env set.
 */

import { manifestFor } from '@podium/harness'
import {
  type CodexJournalEntry,
  codexEngineFacts,
  createCodexEngineHost,
} from '@podium/harness/driver/host'
import type { SessionId } from '@podium/model'
import { createDurableProcess } from '@podium/process/durable'
import { stageRuntimeAttachment } from '../runtime/attachment-staging.js'
import { dialEngineSocket, engineEnvBuilder, engineSocketRoot } from '../runtime/host.js'
import { SERVER_GRACEFUL_EXIT_MS } from '../runtime/server-teardown-budget.js'
import { createSessionEngineScope } from '../session/engines.js'
import { SessionRegistry } from '../session/registry.js'

const sessionId = process.env.GEN1_SESSION as SessionId
const workdir = process.env.GEN1_WORKDIR as string
const facts = codexEngineFacts(manifestFor('codex')!)
const sessionEngines = createSessionEngineScope(createDurableProcess(), {
  sessions: new SessionRegistry(),
  socketRoot: engineSocketRoot,
})
const host = createCodexEngineHost({
  facts,
  engines: sessionEngines.ownerFor<CodexJournalEntry>(facts.journalNamespace),
  supervision: sessionEngines,
  stageAttachment: stageRuntimeAttachment,
  resources: () => undefined,
  buildEnv: engineEnvBuilder(() => ({})),
  gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
  checkVersion: async () => ({ drivable: true as const }),
  dialSocket: sessionEngines.dialerFor(dialEngineSocket),
})
const endpoint = await host.launch({ sessionId, workdir })
process.stdout.write(
  `READY ${JSON.stringify({ address: endpoint.clientAddress, pid: endpoint.process.pid, key: endpoint.process.key })}\n`,
)
setInterval(() => {}, 60_000)
