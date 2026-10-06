import { attachSettingsSource } from '@podium/client-graph/settings-source'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
/** Read-only operator replay. Inputs live only in this ludovico process;
 * evidence contains counts and mismatch positions, never paths or row values. */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { dedupeSessionsByResume } from '@podium/model'
import type { GitRepositoryWire, MachineWire } from '@podium/model/browser'
import type { SessionView } from '@podium/client-core/session-values'
import { createRoutedUiState } from '@podium/client-core/ui-state'
import { MobxPool } from '@podium/client-graph'
import type { SliceSession } from '@podium/client-graph/shared/slice-types'
import { checkSettings } from '../../../tests/worklist/diagnostics/settings-check'


if (hostname() !== 'ludovico') throw new Error('Settings operator replay is ludovico-only')
const { token, expiresAt } = JSON.parse(readFileSync(join(homedir(), '.podium', 'cli-session.json'), 'utf8')) as { token: string; expiresAt?: string }
if (expiresAt && Date.parse(expiresAt) < Date.now()) throw new Error('CLI authentication expired')
const cookie = `podium_session=${token}`
async function query<T>(path: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:18787/trpc/${path}?batch=1&input=%7B%7D`, {
    headers: { cookie }, signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`Replay query HTTP ${response.status}`)
  const body = await response.json() as Array<{ result?: { data: T } }>
  if (!body[0]?.result) throw new Error('Replay query unavailable')
  return body[0].result.data
}
const [sessions, machines, roots, layout] = await Promise.all([
  query<SessionView[]>('sessions.list'), query<MachineWire[]>('machines.list'),
  query<Pick<GitRepositoryWire, 'path' | 'machineId' | 'repoId' | 'originUrl'>[]>('repos.listDetailed'),
  query<Record<string, unknown>>('layout.get'),
])
// This covers saved registered roots, not live filesystem/worktree discovery.
// The latter is exercised by the synthetic browser fixture without remote IO.
const repos: GitRepositoryWire[] = roots.map((root) => ({ ...root, kind: 'repository', worktrees: [] }))
const readonly = (): never => { throw new Error('Replay cannot write') }
const none = () => () => {}
const ui = createRoutedUiState({
  local: { get: () => null, set: readonly, subscribe: none },
  replicated: { hydrate: async () => {}, get: (key) => layout[key], set: readonly, clear: readonly, subscribe: none },
})
const state = { sessions: dedupeSessionsByResume(sessions), machines, repos, settingsTab: 'accounts' }
const owner = withKeyedInputs({ getSnapshot: () => state, subscribe: none, ui })
const sessionRows = new Map(sessions.map((row) => [row.sessionId as string, row]))
const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() }, undefined,
  { settings: true, load: (_entity, id) => sessionRows.get(id), schedule: () => () => {} })
try {
  attachSettingsSource(pool, owner)
  attachPreferenceSource(pool, ui)
  pool.apply({ type: 'replace', rows: sessions.map((row) => ({ kind: 'session' as const, id: row.sessionId,
    value: row as unknown as SliceSession })) })
  pool.row('settingsCatalog', 'catalog')
  pool.row('settingsWindow', 'window')
  pool.row('preference', 'podium.sounds.enabled')
  await Promise.resolve()
  const result = checkSettings(pool, owner as never)
  console.log(JSON.stringify({ ...result, sessions: sessions.length, machines: machines.length, registeredRoots: roots.length }))
  if (!sessions.length || result.differences || result.pending) process.exitCode = 1
} finally { pool.dispose() }
