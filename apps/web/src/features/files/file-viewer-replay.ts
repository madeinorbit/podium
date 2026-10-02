/** Read-only saved file-mode replay. Operator paths and values remain in memory
 * on ludovico; only counts and comparison positions are printed. */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  createRoutedUiState,
  HTML_MODE_MAP_KEY,
  JSON_MODE_MAP_KEY,
  MD_MODE_MAP_KEY,
} from '@podium/client-core/ui-state'
import { MobxPool } from '@podium/client-graph'
import { checkFileViewerPreferences, type FileViewerPreference } from './file-viewer-check'
import { isMarkdownPath } from './file-kind'

if (hostname() !== 'ludovico') throw new Error('Operator file-mode replay is ludovico-only')
const { token, expiresAt } = JSON.parse(
  readFileSync(join(homedir(), '.podium', 'cli-session.json'), 'utf8'),
) as { token: string; expiresAt?: string }
if (expiresAt && Date.parse(expiresAt) < Date.now()) throw new Error('CLI authentication expired')
const response = await fetch('http://127.0.0.1:18787/trpc/layout.get?batch=1&input=%7B%7D', {
  headers: { cookie: `podium_session=${token}` },
  signal: AbortSignal.timeout(30000),
})
if (!response.ok) throw new Error(`Layout read failed: HTTP ${response.status}`)
const body = (await response.json()) as Array<{ result?: { data: Record<string, unknown> } }>,
  values = body[0]?.result?.data
if (!values) throw new Error('Layout response unavailable')
const readonly = () => {
    throw new Error('Replay cannot write preferences')
  },
  none = () => () => {}
const ui = createRoutedUiState({
  local: { get: () => null, set: readonly, subscribe: none },
  replicated: {
    hydrate: async () => {},
    get: (key) => values[key],
    set: readonly,
    clear: readonly,
    subscribe: none,
  },
})
const tabs: FileViewerPreference[] = []
for (const mapKey of [HTML_MODE_MAP_KEY, JSON_MODE_MAP_KEY, MD_MODE_MAP_KEY]) {
  let map: unknown
  try {
    map = JSON.parse(ui.get(mapKey) ?? '{}')
  } catch {
    map = {}
  }
  if (map && typeof map === 'object')
    for (const tabId of Object.keys(map))
      tabs.push({
        mapKey,
        tabId,
        fallback: mapKey === MD_MODE_MAP_KEY && !isMarkdownPath(tabId) ? 'source' : 'preview',
      })
}
const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
try {
  pool.attachPreferences(ui)
  checkFileViewerPreferences(pool, ui, tabs)
  await Promise.resolve()
  const result = checkFileViewerPreferences(pool, ui, tabs)
  console.log(JSON.stringify({ ...result, savedTabs: tabs.length }))
  if (result.differences || result.pending) process.exitCode = 1
} finally {
  pool.dispose()
}
