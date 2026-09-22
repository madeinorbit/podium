/**
 * Generation-1 daemon for the POD-4614 restart test.
 *
 * Starts ONE one-shot fixture turn under the real podium-host, through the
 * session layer's engine hold, waits until the harness child is running,
 * prints `READY`, then idles until it is SIGKILLed — the real daemon restart,
 * not an in-process re-creation. Its sockets close with it, so the writer
 * lease frees exactly the way production frees it.
 *
 * Run by `headless-turn-restart.integration.test.ts` as
 * `<bun> --conditions=@podium/source <this file>` with GEN1_* env set.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createDurableProcess } from '@podium/process/durable'
import { createSessionEngineScope } from '../session/engines.js'
import {
  fixtureSnapshot,
  registerFixtureHarness,
  restartTurn,
  runRestartTurn,
} from './headless-turn-restart.shared.js'
import { SessionRegistry } from '../session/registry.js'

const env = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`gen1 needs ${key}`)
  return value
}

registerFixtureHarness()
const snapshot = fixtureSnapshot(env('GEN1_FIXTURE'))
const files = {
  incarnations: env('GEN1_INCARNATIONS'),
  homeReceipt: env('GEN1_HOME_RECEIPT'),
  release: env('GEN1_RELEASE'),
  done: env('GEN1_DONE'),
}
const turn = restartTurn({
  sessionId: env('GEN1_SESSION'),
  turnId: env('GEN1_TURN'),
  cwd: env('GEN1_CWD'),
  agentHome: env('GEN1_AGENT_HOME'),
  files,
  snapshot,
})
const engines = createSessionEngineScope(createDurableProcess('host', { host: true, abduco: false }), { sessions: new SessionRegistry() })
const handle = runRestartTurn(engines, turn, snapshot)
handle.done.then(
  (outcome) => process.stdout.write(`GEN1-SETTLED ${JSON.stringify(outcome)}\n`),
  (error: unknown) => process.stdout.write(`GEN1-FAILED ${String(error)}\n`),
)

const started = (): boolean =>
  existsSync(files.incarnations) && readFileSync(files.incarnations, 'utf8').trim().length > 0
const poll = setInterval(() => {
  if (!started()) return
  clearInterval(poll)
  process.stdout.write('READY\n')
}, 25)
// Idle until the test SIGKILLs this generation.
setInterval(() => {}, 60_000)
