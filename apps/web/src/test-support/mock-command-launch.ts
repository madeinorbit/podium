import { isDeepStrictEqual } from 'node:util'
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import { MobxPool } from '@podium/client-graph'
import { COMMAND_ENTITIES } from '@podium/client-graph/command-launch-schema'
import { CommandLaunchSource } from '@podium/client-graph/command-launch-source'
import { useEffect, useMemo } from 'react'
import { vi } from 'vitest'
import {
  readFiles,
  readGuardSessions,
  readLaunch,
  readOpen,
  readPalette,
} from '@/app/command-launch-readers'
import { useReplicaIssues, useStoreSelector } from '@/app/store'

const EMPTY_SESSIONS: Store['sessions'] = []
const EMPTY_REPOS: Store['repos'] = []
const EMPTY_MACHINES: Store['machines'] = []
const EMPTY_FILES: Store['recentFiles'] = []
const EMPTY_PINS = { issues: [], repos: [], worktrees: [], sessions: [] }
const EMPTY_SETTINGS = { repoOrder: [] }

/** Component-only fixtures feed the actual command source and projection.
 * Runtime attachment, LOADING and publication coverage uses the separate
 * command-launch-data.pool suite with a real StoreProvider. */
function useCommandFixture<T>(read: (pool: MobxPool) => T): T {
  const state = useStoreSelector((value) => value)
  const issues = useReplicaIssues()
  const fixture = useMemo(() => {
    let current: Store
    let previousRows: unknown
    const listeners = new Set<() => void>()
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    let source: CommandLaunchSource | undefined
    return {
      pool,
      update(input: Store, issueRows: typeof issues) {
        current = {
          ...input,
          sessions: input.sessions ?? EMPTY_SESSIONS,
          repos: input.repos ?? EMPTY_REPOS,
          machines: input.machines ?? EMPTY_MACHINES,
          pins: input.pins ?? EMPTY_PINS,
          recentFiles: input.recentFiles ?? EMPTY_FILES,
          sidebarSettings: input.sidebarSettings ?? EMPTY_SETTINGS,
          selectedIssueId: input.selectedIssueId ?? null,
          openIssueId: input.openIssueId ?? null,
          selectedWorktree: input.selectedWorktree ?? null,
          paneA: input.paneA ?? null,
          paletteOpen: input.paletteOpen ?? false,
        } as Store
        const rows = [
          ...issueRows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
          ...current.sessions.map((value) => ({
            kind: 'session' as const,
            id: value.sessionId,
            value,
          })),
        ]
        if (!isDeepStrictEqual(previousRows, rows)) {
          pool.apply({ type: 'replace', rows })
          previousRows = rows
        }
        if (!source) {
          const owner = {
            getSnapshot: () => current,
            subscribe(wake: () => void) {
              listeners.add(wake)
              return () => {
                listeners.delete(wake)
              }
            },
          } as unknown as ClientRuntime
          source = new CommandLaunchSource(pool, owner)
          pool.sources.register(COMMAND_ENTITIES, source)
        } else for (const wake of listeners) wake()
      },
    }
  }, [])
  fixture.update(state, issues)
  useEffect(() => () => fixture.pool.dispose(), [fixture])
  return read(fixture.pool)
}

vi.mock('@/app/command-launch-data', async (original) => ({
  ...(await original<typeof import('@/app/command-launch-data')>()),
  useCommandLaunchData: () => useCommandFixture(readLaunch),
  useCommandPaletteData: () => useCommandFixture(readPalette),
  useCommandPaletteOpen: () => useCommandFixture(readOpen),
  useCommandGuardSessions: () => useCommandFixture(readGuardSessions),
  useCommandRecentFiles: () => useCommandFixture(readFiles),
}))
