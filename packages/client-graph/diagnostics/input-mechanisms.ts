/** One-field invalidation measurements, collected before POD-5420's fixes. */
import { withKeyedInputs, type ClientRuntime, type Store } from '@podium/client-core/engine'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { autorun, runInAction } from 'mobx'
import { COMMAND_ENTITIES } from '../src/command-launch-schema'
import { CommandLaunchSource } from '../src/command-launch-source'
import { createMobileSessionSource } from '../src/mobile-session-context'
import { PreferenceSource } from '../src/preference-source'
import { createPoolProjection } from '../src/runtime-pool'
import { LOADING } from '../src/worklist/rollup'
import { shellFixture } from './shell-fixture'

const flush = async () => { for (let turn = 0; turn < 6; turn++) await Promise.resolve() }

export async function inputMechanisms(scale: 1 | 4) {
  const f = shellFixture(40 * scale)
  let state = { ...f.state(), pins: [], openIssueId: null, recentFiles: [], sidebarSettings: {}, pendingSpawnPrompts: new Map(), outboxSize: 0 } as unknown as Store
  const listeners = new Set<() => void>(), cursors = new Set<() => void>()
  let cursor: number | null = null
  const runtime = withKeyedInputs({
    getSnapshot: () => state,
    subscribe: (wake: () => void) => { listeners.add(wake); return () => { listeners.delete(wake) } },
    replica: { getCursor: () => cursor, subscribeCursor: (wake: () => void) => { cursors.add(wake); return () => { cursors.delete(wake) } } },
  }) as unknown as ClientRuntime
  const change = (patch: Partial<Store>) => { state = { ...state, ...patch }; for (const wake of listeners) wake() }
  const command = new CommandLaunchSource(f.pool, runtime)
  f.pool.sources.register(COMMAND_ENTITIES, command)
  const mobile = createMobileSessionSource(runtime, f.pool)
  const runs: Record<string, number> = {}
  const stops: (() => void)[] = []
  const watch = (name: string, read: () => unknown) => {
    runs[name] = 0
    stops.push(autorun(() => { runs[name]++; read() }))
  }
  watch('shell.chrome', () => {
    const row = f.pool.row('shellWindow', 'window')
    return row && row !== LOADING ? row.paletteOpen : row
  })
  watch('shell.dock', () => {
    const row = f.pool.row('shellWindow', 'window')
    return row && row !== LOADING ? row.paneA : row
  })
  watch('header.shipping', () => {
    const row = f.pool.row('window', 'window')
    return row && row !== LOADING ? row.paneA : row
  })
  watch('header.outbox', () => {
    const row = f.pool.row('window', 'window')
    return row && row !== LOADING ? row.outboxSize : row
  })
  watch('command.pane', () => {
    const row = f.pool.row('commandWindow', 'window')
    return row && row !== LOADING ? row.paneA : row
  })
  watch('command.pins', () => {
    const row = f.pool.row('commandWindow', 'window')
    return row && row !== LOADING ? row.pins : row
  })
  watch('mobile.prompt', () => {
    const row = mobile.read('mobileSessionWindow')
    return row && row !== LOADING && 'pendingSpawnPrompts' in row ? row.pendingSpawnPrompts : row
  })
  watch('mobile.cursor', () => {
    const row = mobile.read('mobileSessionWindow')
    return row && row !== LOADING && 'cursor' in row ? row.cursor : row
  })
  const lane = { path: '/synthetic/project', repoId: 'shell-repo', repoPath: '/synthetic/project', prefix: 'SYN', branch: 'main' }
  f.pool.apply({ type: 'update', rows: [{ kind: 'worktree', id: lane.path, value: lane as never }] })
  watch('repo.prefix', () => (f.pool.row('repo', 'shell-repo') as { prefix?: string } | undefined)?.prefix)
  await flush()
  const capture = async (write: () => void) => {
    for (const key of Object.keys(runs)) runs[key] = 0
    write(); await flush()
    return { ...runs }
  }
  const shell = await capture(() => f.change({ paletteOpen: !f.state().paletteOpen }))
  runInAction(() => f.pool.header.apply([{ kind: 'window', id: 'window', value: { view: state.view, paneA: state.paneA, fileTabs: state.fileTabs, outboxSize: 0 } }]))
  const header = await capture(() => f.pool.header.apply([{ kind: 'window', id: 'window', value: { view: state.view, paneA: state.paneA, fileTabs: state.fileTabs, outboxSize: 1 } }]))
  const commands = await capture(() => change({ pins: ['one'] as never }))
  const sessions = await capture(() => { cursor = 1; for (const wake of cursors) wake() })
  const repo = await capture(() => f.pool.apply({ type: 'update', rows: [{ kind: 'worktree', id: lane.path, value: { ...lane, branch: 'topic' } as never }] }))

  let projectionReads = 0, comparisons = 0
  const view = createPoolProjection(f.pool, pool => { projectionReads++; return [...pool.selection] }, { equals: (a, b) => { comparisons++; return JSON.stringify(a) === JSON.stringify(b) } })
  view.getSnapshot()
  const stopProjection = view.subscribe(() => {})
  projectionReads = comparisons = 0
  for (let click = 0; click < 4; click++) f.pool.applyLocals({ selectedIssueId: `selected-${click}`, coarseNow: 0 }, new Set(['selectedIssueId']))

  const keys = Array.from({ length: 20 * scale }, (_, index) => `podium:sidebar:project-fold:project-${index}`)
  let preferenceReads = 0
  const values = new Map<string, string>(), uiListeners = new Set<(keys?: ReadonlySet<string>) => void>()
  const ui: RoutedUiState = {
    get: key => { preferenceReads++; return values.get(key) ?? null },
    set: (key, value) => { if (value === null) values.delete(key); else values.set(key, value); for (const wake of uiListeners) wake(new Set([key])) },
    subscribe: wake => { uiListeners.add(wake); return () => { uiListeners.delete(wake) } },
  }
  const preferences = new PreferenceSource(ui)
  for (const key of keys) preferences.read(key)
  await flush(); preferenceReads = 0
  ui.set(keys[0]!, '1'); await flush()
  const result = { scale, shell, header, commands, sessions, repo, hiddenProjection: { reads: projectionReads, comparisons }, preferenceReads }
  preferences.dispose(); stopProjection(); mobile.dispose()
  for (const stop of stops) stop()
  f.pool.dispose()
  return result
}

if (import.meta.main) {
  for (const scale of [1, 4] as const) console.info(JSON.stringify(await inputMechanisms(scale)))
}
