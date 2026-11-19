/**
 * POD-7169 — the phone opens a mission while its first download is still
 * saving. On the operator's iPhone the deck of a small issue never loaded: the
 * server answered its tree in a quarter of a second, but the device installed
 * the answer only once the first download's durable save had landed (ten
 * seconds and more), and meanwhile the screen held "Mission not found." under
 * its loading placeholder.
 *
 * Over the real kernel Replica, loader, facade, row source, pool and mission
 * screen, composed as the app composes them (assembly.ts), with the save held:
 * the opening is loading until its tree is installed, then shows the mission.
 * It never answers "not found" on the way. (When the tree installs, before or
 * after the save lands, is the replica's: POD-7168.)
 */
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import {
  CollectionServer,
  issue,
  session,
  WORLD_NOW,
} from '../../sync/src/conformance/collection-server'
import { inMemoryInstantiation } from '../../sync/src/conformance/in-memory'
import { policyBudgets, TEST_BUDGETS } from '../../sync/src/conformance/test-budgets'
import { CollectionLoader, type LoaderSchedule } from '../../sync/src/replica/loader'
import { Replica } from '../../sync/src/replica/replica'
import type { CachePolicy, ReplicaEvent } from '../../sync/src/replica/types'
import type { SyncUnitOfWork } from '../../sync/src/span'
import { createWorklistPool } from './create'
import { MissionScreen, missionOpeningResolved, missionRootId } from './mission-screen'
import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import { fixedLocals } from './shared/locals-source'
import { createRowSource } from './shared/row-source'
import { LOADING } from './worklist/rollup'

const ISSUE = 'issueProjection'
const POLICY: CachePolicy = {
  clientType: 'browser',
  steps: [
    { step: 'always', collections: ['session.live'] },
    { step: 'view', collections: [] },
    { step: 'sidebar', collections: ['issueProjection.sidebar'] },
    { step: 'stubs', collections: ['issueProjection.stubs'] },
  ],
  recentDays: 30,
  ...policyBudgets(TEST_BUDGETS),
}

const ticks = async (count = 8): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function manualSchedule(): { schedule: LoaderSchedule; due: () => void } {
  let run: (() => void) | null = null
  return {
    schedule: (fn) => {
      run = fn
      return () => {
        run = null
      }
    },
    due: () => {
      const fn = run
      run = null
      fn?.()
    },
  }
}

const value = (id: string, fields: Record<string, unknown> = {}) =>
  issue(id, { repoPath: '/synthetic', createdAt: '2025-01-01T00:00:00Z', ...fields })

describe('the phone opens a mission while the first download is saving (POD-7169)', () => {
  it('is loading while its tree is on its way and shows the mission once installed, never "not found"', async () => {
    const server = new CollectionServer()
    server.policy = POLICY
    // A small mission: the root on the sidebar, two tasks, a session on one.
    server.put(ISSUE, 'R', value('R', { stage: 'in_progress', title: 'Amp comparison' }))
    server.put(ISSUE, 'T1', value('T1', { parentId: 'R', stage: 'in_progress' }))
    server.put(
      ISSUE,
      'T2',
      value('T2', { parentId: 'R', stage: 'done', closedReason: 'completed' }),
    )
    server.put(
      'session',
      'S1',
      session('S1', { issueId: 'T1', status: 'ended', cwd: '/synthetic' }),
    )

    const storage = await inMemoryInstantiation.open()
    const { cache } = storage.viewFor('u-ada')
    // The save: every durable commit waits for it, as IndexedDB's write queue
    // makes the first download's finishing commit wait on a phone.
    let landed = false
    let land!: () => void
    const saved = new Promise<void>((resolve) => {
      land = () => {
        landed = true
        resolve()
      }
    })
    const unitOfWork: SyncUnitOfWork = {
      transact: async (body) => {
        await saved
        return await storage.unitOfWork.transact(body)
      },
    }
    const timer = manualSchedule()
    let loader: CollectionLoader | undefined
    let replica: Replica | undefined
    const facade = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
      exits: (entity, id) => replica?.exitKind(entity, id),
      collections: () => replica,
      loader: () => loader,
    })
    const events: ReplicaEvent[] = []
    replica = new Replica({
      store: cache,
      authority: server,
      unitOfWork,
      now: () => WORLD_NOW,
      view: () => loader?.takeView() ?? [],
      request: (specs) => loader?.request(specs),
      onEvent: (event) => {
        events.push(event)
        facade.onKernelEvent(event)
        loader?.onEvent(event)
      },
      batchEvents: (emit) => {
        const batch = loader?.batch?.bind(loader)
        if (batch === undefined) facade.batch(emit)
        else batch(() => facade.batch(emit))
      },
    })
    loader = new CollectionLoader({ replica, schedule: timer.schedule })
    const rows = createRowSource({ principal: { userId: 'u-ada' } }, facade, {
      pending: { byRow: () => new Map() },
    })
    const locals = fixedLocals({ selectedIssueId: null, coarseNow: WORLD_NOW })
    const handle = createWorklistPool(rows.source, locals.source, { schedule: () => () => {} })
    const kernel = replica
    // One round of the app's event loop. Nothing here awaits the kernel's
    // queue: on the base it is held by the save, which is the defect.
    const round = async () => {
      await ticks()
      timer.due()
      void loader?.flush()
      await ticks()
      rows.flush()
      handle.pool.hydrate()
    }
    let screen: MissionScreen | null = null
    const answers: string[] = []
    let stop = () => {}
    try {
      kernel.connect()
      for (let i = 0; i < 40 && !events.some((event) => event.type === 'load-installed'); i += 1)
        await round()
      await round()
      // The views opened on the load in memory; the save has not landed.
      expect(events.map((event) => event.type)).toContain('load-installed')
      expect(kernel.posture).toBe('bootstrapping')
      attachMissionTestPreferences(handle.pool)

      // The phone's opening (useMissionOpening): the root, its screen, and
      // whether the opening has its answer.
      const rootId = missionRootId(handle.pool, 'R', true)
      expect(rootId).toBe('R')
      screen = new MissionScreen(handle.pool, 'R', { sessionName: (s) => s.name ?? '' })
      const opened = screen
      stop = autorun(() => {
        const resolved = missionOpeningResolved(opened, rootId, false)
        const root = opened.ready ? opened.reader.issue('R') : undefined
        answers.push(!resolved ? 'loading' : root && root !== LOADING ? 'mission' : 'not found')
      })
      // While the save holds the tree's install, and after: loading, then the
      // mission, never "not found".
      for (let i = 0; i < 6 && answers.at(-1) !== 'mission'; i += 1) await round()
      expect(answers.at(0)).toBe('loading')
      expect(answers, answers.join(' → ')).not.toContain('not found')

      land()
      for (let i = 0; i < 12 && answers.at(-1) !== 'mission'; i += 1) await round()
      await kernel.settled()
      await round()
      expect(kernel.posture).toBe('live')
      expect(answers.at(-1), answers.join(' → ')).toBe('mission')
      expect(answers, answers.join(' → ')).not.toContain('not found')
      expect(opened.rows.map((row) => row.id)).toEqual(expect.arrayContaining(['R']))
    } finally {
      if (!landed) land()
      stop()
      screen?.close()
      kernel.disconnect()
      rows.dispose()
      locals.dispose()
      handle.dispose()
    }
  })
})
