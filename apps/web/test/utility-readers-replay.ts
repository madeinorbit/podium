/** Supplied operator RPC responses stay on ludovico. This entry point never
 * accesses credentials or a live backend; output contains counts/positions only. */
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import type { UtilityReplay } from './utility-readers.browser'
import { runUtilityReadersProof } from './utility-readers-proof'
if (hostname() !== 'ludovico') throw new Error('Operator utility replay is ludovico-only')
const input = process.argv.find(value => value.startsWith('--responses='))?.slice('--responses='.length)
if (!input) throw new Error('Replay requires --responses=<ludovico-local RPC response file>')
const replay = JSON.parse(readFileSync(input, 'utf8')) as UtilityReplay
if (!replay.issueId || !replay.sessionId || !['usage', 'quota', 'tasks', 'cost', 'ledger', 'events', 'transcript', 'history'].every(key => Object.hasOwn(replay.answers ?? {}, key))) {
  throw new Error('Replay requires the issue/session scope and all eight RPC responses')
}
await runUtilityReadersProof({ countsOnly: true, replay })
