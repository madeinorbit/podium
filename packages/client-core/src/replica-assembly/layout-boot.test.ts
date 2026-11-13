// @vitest-environment happy-dom

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PodiumClientApi } from '@podium/client-core/api'
import { createClientRuntime } from '@podium/client-core/engine'
import { memoryStorage, retainReplicaEntity } from '@podium/client-core/replica'
import { openReplicaAssembly, type ReplicaDataStore } from '@podium/client-core/replica-assembly'
import { ISSUES_DISPLAY_KEY } from '@podium/client-core/ui-state'
import { readSharedIssuesDisplay } from '@podium/client-core/values'
import { asUserId, layoutRowId } from '@podium/model'
import { IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { SqliteSyncStore } from '@podium/sync/adapters/mobile-sqlite'
import { IDBFactory } from 'fake-indexeddb'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { installMobxWarnTrap } from '../../../../tests/worklist/harness/src/mobx-trap'
import { omitGone } from '../../../client-graph/src/lookup'
import type {} from '../../../client-graph/src/mobile-inbox-schema'
import { attachMobileScreens } from '../../../client-graph/src/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '../../../client-graph/src/mobile-screens-schema'
import { MobileTasksBoard } from '../../../client-graph/src/mobile-tasks'
import { createRuntimeWorklistPool } from '../../../client-graph/src/runtime-pool'
import type {} from '../../../client-graph/src/superagent'
import { LOADING } from '../../../client-graph/src/worklist/rollup'
import { sqliteEngine } from '../../../sync/src/adapters/mobile-sqlite/test-support'

const principal = JSON.stringify(['installation-a', 'alice'])
const cursor = { feedId: 'feed', epoch: 'epoch', seq: 10 }
const savedDisplay = { layout: 'board', ordering: 'updated', showAgentTasks: false }

installMobxWarnTrap({ errors: true })

function issue(id: string, seq: number, updatedAt: string) {
  return {
    id,
    seq,
    title: id,
    description: { value: '' },
    stage: 'in_progress',
    priority: 2,
    type: 'task',
    audience: 'human',
    repoPath: '/fixture',
    labels: [],
    deps: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt,
  }
}

it.each([
  'phone SQLite',
  'desktop IndexedDB',
] as const)('%s paints the persisted Tasks order before any boot fetch settles', async (platform) => {
  const directory = mkdtempSync(join(tmpdir(), 'podium-layout-boot-'))
  const factory = new IDBFactory()
  const openStore = (): Promise<ReplicaDataStore> =>
    platform === 'phone SQLite'
      ? SqliteSyncStore.open({
          openDatabase: () => sqliteEngine.open(join(directory, 'replica.db')),
          deleteDatabase: () => {},
          retainEntity: retainReplicaEntity,
          onDegraded: () => {},
        })
      : IndexedDbSyncStore.open({
          factory: factory as never,
          retainEntity: retainReplicaEntity,
          onDegraded: () => {},
        })
  let store: ReplicaDataStore | undefined
  let assembly: Awaited<ReturnType<typeof openReplicaAssembly>> | undefined
  let runtime: ReturnType<typeof createClientRuntime> | undefined
  let handle: ReturnType<typeof createRuntimeWorklistPool> | undefined
  const stops: (() => void)[] = []
  try {
    store = await openStore()
    store.viewFor(principal).cache.installSnapshot(
      [
        {
          entity: 'userLayout',
          entityId: layoutRowId(asUserId('alice'), 'issues.display'),
          value: { userId: 'alice', key: 'issues.display', value: savedDisplay },
          provenance: { seq: 10 },
        },
        ...[
          issue('older', 1, '2026-01-01T00:00:00Z'),
          issue('newer', 2, '2026-02-01T00:00:00Z'),
        ].map((value) => ({
          entity: 'issueProjection',
          entityId: value.id,
          value,
          provenance: { seq: 10 },
        })),
      ],
      cursor,
      [],
    )
    await store.settled()
    store.close()
    store = undefined

    let resolveLayout!: (value: Record<string, unknown>) => void
    const getLayout = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveLayout = resolve
        }),
    )
    const api = { layout: { get: { query: getLayout } } } as unknown as PodiumClientApi
    assembly = await openReplicaAssembly({
      api,
      principal,
      openStore,
      settings: {
        storage: memoryStorage(),
        enumerateKeys: () => [],
        basePrefix: 'test.layout-boot',
      },
      httpSync: { origin: 'https://sync.test', streamingFetch: { fetch: vi.fn() } },
    })
    runtime = createClientRuntime({
      principal: assembly.principal,
      api,
      config: { httpOrigin: 'https://sync.test', wsClientUrl: 'wss://sync.test' },
      createReplicaFn: assembly.createReplicaFn,
      createOutboxFn: assembly.createOutboxFn,
      feed: assembly.feed,
      networkEnabled: false,
      onFatalError: (message) => {
        throw new Error(message)
      },
    })
    // The constructor must seed the owner before start(), hydration or a network response.
    expect(runtime.replicatedLayout.get('issues.display')).toEqual(savedDisplay)
    expect(readSharedIssuesDisplay(runtime.ui.get(ISSUES_DISPLAY_KEY)).ordering).toBe('updated')
    handle = createRuntimeWorklistPool(runtime, {
      preferences: true,
      summaries: MOBILE_SCREEN_SUMMARIES,
    })
    await attachMobileScreens(handle.pool, runtime)
    const pool = handle.pool
    let board: MobileTasksBoard | undefined
    let display = readSharedIssuesDisplay(null)
    const frames: { ordering: string; ids: string[] }[] = []
    stops.push(
      autorun(() => {
        const row = omitGone(pool.row('preference', ISSUES_DISPLAY_KEY))
        display = readSharedIssuesDisplay(
          typeof row === 'object' && row !== null ? row.value : null,
        )
        board?.showDisplay(display)
      }),
    )
    board = runInAction(
      () =>
        new MobileTasksBoard(pool, {
          showDone: false,
          expanded: [],
          filter: {},
          ...display,
        }),
    )
    const tasks = board
    stops.push(
      autorun(() => {
        const sections = tasks.sections
        frames.push({
          ordering: tasks.ordering,
          ids:
            sections === LOADING
              ? []
              : sections.flatMap((section) => section.rows.map((row) => row.id)),
        })
      }),
    )
    expect(frames[0]).toEqual({ ordering: 'updated', ids: ['newer', 'older'] })
    expect(getLayout).not.toHaveBeenCalled()
    expect(runtime.outbox.pending()).toEqual([])
    runtime.start()
    const hydration = runtime.replicatedLayout.hydrate()
    expect(getLayout).toHaveBeenCalledOnce()
    await Promise.resolve()
    resolveLayout({ 'issues.display': { ...savedDisplay } })
    await hydration
    await Promise.resolve()
    expect(
      frames.every(
        (frame) => frame.ordering === 'updated' && frame.ids.join(',') === 'newer,older',
      ),
    ).toBe(true)
  } finally {
    for (const stop of stops.reverse()) stop()
    handle?.dispose()
    runtime?.destroy()
    await assembly?.dispose()
    store?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
