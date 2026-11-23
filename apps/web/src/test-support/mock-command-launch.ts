import '@podium/client-graph/synced-models'
import { isDeepStrictEqual } from 'node:util'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import type { ClientRuntime } from '@podium/client-core/runtime-root'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import {
  FIXTURE_MACHINE_ID,
  repositoriesAsCheckouts,
} from '@podium/client-core/test-support/machine-records'
import { MobxPool } from '@podium/client-graph'
import { chatIssue } from '@podium/client-graph/chat-context'
import { COMMAND_ENTITIES } from '@podium/client-graph/command-launch-schema'
import { CommandLaunchSource } from '@podium/client-graph/command-launch-source'
import { createCommandPalette } from '@podium/client-graph/command-launch-views'
import { headerEntities } from '@podium/client-graph/header-entities'
import type { HeaderRecord } from '@podium/client-graph/header-schema'
import {
  createLaunchCatalogPicker,
  launchOptionViews,
} from '@podium/client-graph/launch-option-views'
import { seedFixtureMachines } from '@podium/client-graph/live-fixture'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import type { CheckoutRepository, MachineFacts } from '@podium/model/browser'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { vi } from 'vitest'
import {
  readFiles,
  readLaunchOrigin,
  readOpen,
  readPalette,
  readSession,
  readSessions,
  readTargetMachines,
} from '@/app/command-launch-readers'
import { fixtureSnapshot as readFixture } from '@/test-support/fixture-snapshot'
import { allIssueViewModels } from '../../../../tests/worklist/diagnostics/reference/issue-view-models'
import type { ReferenceState as Store } from '../../../../tests/worklist/diagnostics/reference-state'
import { poolFixtureIssues } from './pool-issue-fixture'

const EMPTY_SESSIONS: Store['sessions'] = []
const EMPTY_REPOS: CheckoutRepository[] = []
const EMPTY_MACHINES: MachineFacts[] = []
const EMPTY_FILES: Store['recentFiles'] = []
/** Test inputs in the listing shape (POD-6644), seeded as records and conditions. */
type FixtureFleet = { repos?: CheckoutRepository[]; machines?: MachineFacts[] }

/** Component-only fixtures feed the actual command source and projection.
 * Runtime attachment, LOADING and publication coverage uses the separate
 * command-launch-data.pool suite with a real StoreProvider. */
function useCommandFixture<T>(read: (pool: MobxPool) => T): T {
  const state = readFixture((value) => value) as unknown as Store
  const issues =
    state.replica && state.issueProjections
      ? allIssueViewModels(state.replica, state.issueProjections, state.issueUserStates ?? [])
      : poolFixtureIssues(state)
  const fixture = useMemo(() => {
    let current: Store & FixtureFleet
    let previousRows: unknown
    const listeners = new Set<() => void>()
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    launchOptionViews(pool)
    let source: CommandLaunchSource | undefined
    // The replica the command source reads: the fixture's repositories as
    // checkout records and its machines as machine records (POD-6644).
    let checkouts: readonly unknown[] = []
    let machineRows: readonly { id: string }[] = []
    let heldRepos: unknown
    let heldMachines: unknown
    const batches = new Set<(batch: ReplicaAddressedBatch) => void>()
    const replica = {
      rows: (kind: string) =>
        kind === 'checkouts' ? checkouts : kind === 'machines' ? machineRows : [],
      row: (kind: string, id: string) =>
        kind === 'machines' ? machineRows.find((row) => row.id === id) : undefined,
      subscribeAddressedBatch(listener: (batch: ReplicaAddressedBatch) => void) {
        batches.add(listener)
        return () => batches.delete(listener)
      },
    }
    return {
      pool,
      update(input: Store & FixtureFleet, issueRows: typeof issues) {
        current = {
          ...input,
          sessions: input.sessions ?? EMPTY_SESSIONS,
          repos: input.repos ?? EMPTY_REPOS,
          machines: input.machines ?? EMPTY_MACHINES,
          recentFiles: input.recentFiles ?? EMPTY_FILES,
          selectedIssueId: input.selectedIssueId ?? null,
          openIssueId: input.openIssueId ?? null,
          selectedWorktree: input.selectedWorktree ?? null,
          paneA: input.paneA ?? null,
          paletteOpen: input.paletteOpen ?? false,
        } as Store & FixtureFleet
        const rows = [
          ...issueRows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
          ...current.sessions.map((value) => ({
            kind: 'session' as const,
            id: value.sessionId,
            value,
          })),
        ]
        // The whole-pool install first: it would remove the machine records below.
        if (!isDeepStrictEqual(previousRows, rows)) {
          pool.apply({ type: 'replace', rows })
          previousRows = rows
        }
        const moved: { kind: 'checkouts' | 'machines'; id: string }[] = []
        if (current.repos !== heldRepos) {
          heldRepos = current.repos
          const home = current.machines?.[0]?.id ?? FIXTURE_MACHINE_ID
          checkouts = repositoriesAsCheckouts(
            current.repos ?? [],
            (repo) => repo.machineId ?? home,
          ).map((record) => record.value)
          moved.push({ kind: 'checkouts', id: 'repositories' })
        }
        if (current.machines !== heldMachines) {
          heldMachines = current.machines
          machineRows = (current.machines ?? []).map((machine) => ({
            id: machine.id,
            name: machine.name,
            loggedOutHarnesses: machine.loggedOutHarnesses ?? [],
          }))
          for (const machine of current.machines ?? [])
            moved.push({ kind: 'machines', id: machine.id })
        }
        const headers = headerEntities(pool)
        // Every checkout is on a machine (POD-6644): a repository the test gave
        // none is on the fixture machine, here as in the checkout records.
        const home = (current.machines?.[0]?.id ?? FIXTURE_MACHINE_ID) as NonNullable<
          CheckoutRepository['machineId']
        >
        const fleetRepos = (current.repos ?? []).map((repo) => ({
          ...repo,
          machineId: repo.machineId ?? home,
        }))
        const repositoryIds = fleetRepos.map((repo) => JSON.stringify([repo.machineId, repo.path]))
        const machineIds: string[] = (current.machines ?? []).map((machine) => machine.id)
        const records: HeaderRecord[] = [
          ...fleetRepos.map((value, at) => ({
            kind: 'repository' as const,
            id: repositoryIds[at]!,
            value,
          })),
          ...(seedFixtureMachines(pool, current.machines ?? []) as HeaderRecord[]),
        ]
        for (const id of headers.tables.repository.keys())
          if (!repositoryIds.includes(id))
            records.push({ kind: 'repository', id, value: undefined })
        for (const id of headers.tables.machine.keys())
          if (!machineIds.includes(id)) records.push({ kind: 'machine', id, value: undefined })
        headers.apply(records)
        headers.order('repository', repositoryIds)
        headers.order('machine', machineIds)
        if (!source) {
          const owner = withKeyedInputs({
            replica,
            getSnapshot: () => current,
            subscribe(wake: () => void) {
              listeners.add(wake)
              return () => {
                listeners.delete(wake)
              }
            },
          }) as unknown as ClientRuntime
          source = new CommandLaunchSource(pool, owner)
          pool.sources.register(COMMAND_ENTITIES, source)
        } else {
          for (const wake of listeners) wake()
          if (moved.length)
            for (const listener of [...batches]) listener({ type: 'update', rows: moved } as never)
        }
      },
    }
  }, [])
  fixture.update(state, issues)
  useEffect(() => () => fixture.pool.dispose(), [fixture])
  return read(fixture.pool)
}

vi.mock('@/app/command-launch-data', async (original) => ({
  ...(await original<typeof import('@/app/command-launch-data')>()),
  useCommandLaunchCatalog: () => {
    const pool = useCommandFixture((pool) => pool)
    const picker = useMemo(() => createLaunchCatalogPicker(pool), [pool])
    if (!picker.opened) picker.open()
    return picker.catalog()
  },
  useCommandLaunchOrigin: (path: string, machineId?: string) =>
    useCommandFixture((pool) => readLaunchOrigin(pool, path, machineId)),
  useCommandPaletteSnapshot: () => {
    const pool = useCommandFixture((pool) => pool)
    const picker = useMemo(() => {
      const view = createCommandPalette(pool)
      view.open()
      return view
    }, [pool])
    useEffect(() => () => picker.close(), [picker])
    const projection = useMemo(
      () =>
        createPoolProjection(pool, () => ({
          data: picker.palette(),
          sessions: picker.sessions,
          selectedSessions: picker.selectedSessions,
          recent: picker.recent,
          defaultAgent: picker.defaultAgent,
        })),
      [pool, picker],
    )
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
  useCommandSessionLookup: () => useCommandFixture((pool) => (id: string) => readSession(pool, id)),
  useCommandIssue: (id: string | null) =>
    useCommandFixture((pool) => (id === null ? undefined : chatIssue(pool, id))),
  useCommandPaletteData: () => useCommandFixture(readPalette),
  useCommandPaletteOpen: () => useCommandFixture(readOpen),
  useCommandRecentFiles: () => useCommandFixture(readFiles),
  useCommandSessions: () => useCommandFixture(readSessions),
  useCommandSession: (id: string | null) =>
    useCommandFixture((pool) => (id === null ? undefined : readSession(pool, id))),
  useCommandTargetMachines: (
    ...args: Parameters<typeof readTargetMachines> extends [unknown, ...infer Inputs]
      ? Inputs
      : never
  ) => useCommandFixture((pool) => readTargetMachines(pool, ...args)),
}))
