import { omitGone } from '@podium/client-graph/lookup'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
/** Read-only operator layout replay. Raw keys and values never leave this
 * ludovico process, enter a file, or appear in its output. Device-local values
 * belong to each browser's storage and are covered by synthetic browser proof. */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createRoutedUiState, UI_STATE_KEYS } from '@podium/client-core/ui-state'
import { layoutKeyFromLegacy } from '@podium/model'
import { MobxPool } from '@podium/client-graph'
import { checkPreferences } from '../../../tests/worklist/diagnostics/preference-check'
if (hostname() !== 'ludovico') throw new Error('Operator preference replay is ludovico-only')
const { token, expiresAt } = JSON.parse(readFileSync(join(homedir(), '.podium', 'cli-session.json'), 'utf8')) as { token: string; expiresAt?: string }
if (expiresAt && Date.parse(expiresAt) < Date.now()) throw new Error('CLI authentication expired')
const response = await fetch('http://127.0.0.1:18787/trpc/layout.get?batch=1&input=%7B%7D', {
  headers: { cookie: `podium_session=${token}` }, signal: AbortSignal.timeout(30000),
})
if (!response.ok) throw new Error(`Layout read failed: HTTP ${response.status}`)
const body = await response.json() as Array<{ result?: { data: Record<string, unknown> } }>
const values = body[0]?.result?.data
if (!values) throw new Error('Layout response unavailable')
const readonly = () => { throw new Error('Replay cannot write preferences') }
const none = () => () => {}
const ui = createRoutedUiState({
  local: { get: () => null, set: readonly, subscribe: none },
  replicated: { hydrate: async () => {}, get: (key) => values[key], set: readonly, clear: readonly, subscribe: none },
})
const known = [...Object.values(UI_STATE_KEYS), 'podium:sidebar:collapsed', 'podium:superagent:mode']
const keys = Object.keys(values).map((canonical) => known.find((key) => layoutKeyFromLegacy(key) === canonical)
  ?? (canonical.startsWith('sidebar.section.') ? `podium:sidebar:${canonical.slice('sidebar.section.'.length)}` : null))
const unsupported = keys.filter((key) => key === null).length
if (unsupported) throw new Error(`Replay needs declarations for ${unsupported} stored key positions`)
const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
try {
  attachPreferenceSource(pool, ui)
  for (const key of keys) omitGone(pool.row('preference', key!))
  await Promise.resolve()
  const result = checkPreferences(pool, ui)
  console.log(JSON.stringify({ ...result, storedKeys: keys.length }))
  if (!keys.length || result.differences || result.pending) process.exitCode = 1
} finally { pool.dispose() }
