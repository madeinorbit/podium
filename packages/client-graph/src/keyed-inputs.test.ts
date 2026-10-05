import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
// @vitest-environment happy-dom

import type { GitRepositoryWire } from '@podium/model'
/**
 * POD-5433 (plan steps 7-9): the wake meter for the pool adapters that used
 * to re-read the runtime's whole published snapshot. Each adapter runs over a
 * counting view of one real scenario runtime, with its rows demanded. A batch
 * that touches none of an adapter's keys must cost it nothing: no wake, no
 * read. Measured at 1x and 4x so per-change work cannot grow with the data.
 */
import { asSessionId } from '@podium/model/browser'
import { autorun, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import {
  startScenarioEngine,
  writeHeartbeat,
  writeTitleRename,
} from '../../worklist-proto/shared/src/scenarios'
import { ChatContextSource } from './chat-context-source'
import { COMMAND_SUMMARIES } from './command-launch-schema'
import { CommandLaunchSource } from './command-launch-source'
import { allResidentSessions } from './enumerate'
import { attachHeaderSource } from './header-source'
import { createIssueBoardSource } from './issue-board-source'
import { attachIssuePageSource } from './issue-page-source'
import { MobileInboxSource } from './mobile-inbox-source'
import { createMobileSessionSource } from './mobile-session-context'
import { createMobileSettingsSource } from './mobile-settings'
import { createRuntimeWorklistPool } from './runtime-pool'
import { SessionPaneSource } from './session-pane-source'
import { SettingsSource } from './settings-source'
import { createEngineLocals } from './shared/engine-locals'
import { ShellSource } from './shell-source'
import { createSuperagentSource } from './superagent'

type Runtime = Awaited<ReturnType<typeof startScenarioEngine>>['engine']
interface Meter {
  wakes: number
  reads: number
}

/** The runtime as one adapter sees it, counting every wake and every read. */
function metered(rt: Runtime): { view: Runtime; meter: Meter } {
  const meter: Meter = { wakes: 0, reads: 0 }
  const woken =
    <A extends unknown[]>(listener: (...args: A) => void) =>
    (...args: A) => {
      meter.wakes++
      listener(...args)
    }
  const read =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      meter.reads++
      return fn(...args)
    }
  const view = Object.create(rt) as Runtime
  Object.assign(view, {
    readLocal: read(rt.readLocal),
    listIds: read(rt.listIds),
    listRow: read(rt.listRow),
    onLocals: (
      keys: Parameters<Runtime['onLocals']>[0],
      listener: Parameters<Runtime['onLocals']>[1],
    ) => rt.onLocals(keys, woken(listener)),
    onList: (name: Parameters<Runtime['onList']>[0], listener: Parameters<Runtime['onList']>[1]) =>
      rt.onList(name, woken(listener)),
  })
  return { view, meter }
}

const flush = async () => {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()
}

async function fixture(scale: 1 | 4) {
  const ctx = await startScenarioEngine(scale)
  const rt = ctx.engine
  const handle = createRuntimeWorklistPool(rt, { summaries: COMMAND_SUMMARIES })
  for (let turn = 0; turn < 32 && handle.pool.hydrate(); turn++) {
    /* baseline boot */
  }
  const pool = handle.pool
  const meters: Record<string, Meter> = {}
  const stops: (() => void)[] = []
  const add = (name: string) => {
    const { view, meter } = metered(rt)
    meters[name] = meter
    return view
  }
  const engineLocals = createEngineLocals(add('engineLocals'))
  stops.push(() => engineLocals.dispose())
  const board = createIssueBoardSource(pool, add('issueBoard'))
  stops.push(() => board.dispose())
  const pane = new SessionPaneSource(add('sessionPane'))
  stops.push(() => pane.dispose())
  const shell = new ShellSource(add('shell'))
  stops.push(() => shell.dispose())
  stops.push(attachHeaderSource(pool, add('header')))
  const command = new CommandLaunchSource(pool, add('commandLaunch'))
  stops.push(() => command.dispose())
  const settings = new SettingsSource(add('settings'))
  settings.read('settingsWindow', 'window')
  stops.push(() => settings.dispose())
  const superagent = await createSuperagentSource(add('superagent'))
  superagent.read('superagentLocal', 'local')
  stops.push(() => superagent.dispose())
  const chat = new ChatContextSource(add('chatContext'), pool)
  const session = ctx.targets.phaseSessionId
  chat.read('chatDraft', session)
  chat.read('chatWindow', 'window')
  stops.push(() => chat.dispose())
  const inbox = new MobileInboxSource(add('mobileInbox'), pool)
  inbox.read('mobileInboxState', 'state')
  stops.push(() => inbox.dispose())
  const mobileSettings = await createMobileSettingsSource(add('mobileSettings'))
  mobileSettings.read('mobileSettingsDiagnostics', 'diagnostics')
  stops.push(() => mobileSettings.dispose())
  const mobileSession = createMobileSessionSource(add('mobileSession'), pool)
  mobileSession.read('mobileSessionWindow')
  stops.push(() => mobileSession.dispose())
  await flush()
  const reset = () => {
    for (const meter of Object.values(meters)) {
      meter.wakes = 0
      meter.reads = 0
    }
  }
  return {
    ctx,
    rt,
    pool,
    meters,
    reset,
    session,
    command,
    chat,
    dispose() {
      for (const stop of stops) stop()
      handle.dispose()
    },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** Work per adapter for one scripted batch, after its microtasks settle. */
async function costOf(f: Fixture, act: () => unknown) {
  f.reset()
  await act()
  await flush()
  return Object.fromEntries(
    Object.entries(f.meters).map(([name, meter]) => [name, meter.wakes + meter.reads]),
  )
}

const zero = (cost: Record<string, number>) =>
  Object.fromEntries(Object.keys(cost).map((name) => [name, 0]))

describe('keyed adapter inputs (POD-5433)', () => {
  for (const scale of [1, 4] as const) {
    it(`a kernel batch touching no demanded key wakes no adapter (${scale}x)`, async () => {
      const f = await fixture(scale)
      try {
        const cost = await costOf(f, () => writeHeartbeat(f.ctx))
        expect(cost).toEqual(zero(cost))
      } finally {
        f.dispose()
      }
    })

    it(`an unrelated local wakes no adapter (${scale}x)`, async () => {
      const f = await fixture(scale)
      try {
        // Focus is local-only (a dock tab replicates through the outbox, which
        // moves the header's outbox count).
        const next = referenceState(f.rt).focusedPane === 'A' ? 'B' : 'A'
        const cost = await costOf(f, () =>
          runInAction(() => referenceState(f.rt).setFocusedPane(next)),
        )
        expect(cost).toEqual(zero(cost))
      } finally {
        f.dispose()
      }
    })

    it(`a draft wakes only the chat context, once (${scale}x)`, async () => {
      const f = await fixture(scale)
      try {
        const cost = await costOf(f, () =>
          referenceState(f.rt).setSessionDraft(asSessionId(f.session), 'hello'),
        )
        expect(cost).toEqual({ ...zero(cost), chatContext: cost.chatContext })
        expect(cost.chatContext).toBeGreaterThan(0)
        expect(cost.chatContext).toBeLessThanOrEqual(2)
        expect(f.chat.read('chatDraft', f.session)).toEqual({ text: 'hello' })
      } finally {
        f.dispose()
      }
    })
  }

  for (const scale of [1, 4] as const) {
    it(`a repo change re-links only the sessions under a moved path (${scale}x)`, async () => {
      const f = await fixture(scale)
      const change = vi.spyOn(
        CommandLaunchSource.prototype as unknown as { change(entity: string): void },
        'change',
      )
      const sessionLinks = () => change.mock.calls.filter(([entity]) => entity === 'session').length
      const discover = async (repos: GitRepositoryWire[]) => {
        await new Promise((resolve) => setTimeout(resolve, f.ctx.settleMs))
        change.mockClear()
        f.ctx.discovery.repos = repos
        f.ctx.hub.emit('worktreesChanged')
        await new Promise((resolve) => setTimeout(resolve, f.ctx.settleMs))
        await flush()
        return sessionLinks()
      }
      try {
        const repos = f.ctx.discovery.repos as GitRepositoryWire[]
        const resident = [...allResidentSessions(f.pool)]
        expect(resident.length).toBeGreaterThan(0)
        // A branch rename moves no path: no session is re-linked.
        const renamed = repos.map((repo, at) => (at === 0 ? { ...repo, branch: 'renamed' } : repo))
        expect(await discover(renamed)).toBe(0)
        // Dropping one worktree re-links exactly the residents under it: the
        // worktree with the most resident sessions.
        const residentsUnder = (path: string) =>
          resident.filter(([, row]) => {
            const cwd = (row as { cwd?: string }).cwd ?? ''
            return cwd === path || cwd.startsWith(`${path}/`)
          }).length
        let at = -1,
          tree = -1,
          under = 0
        for (const [i, repo] of repos.entries())
          for (const [j, worktree] of repo.worktrees.entries()) {
            const count = residentsUnder(worktree.path)
            if (count > under) [at, tree, under] = [i, j, count]
          }
        expect(under).toBeGreaterThan(0)
        const dropped = renamed.map((repo, i) =>
          i === at ? { ...repo, worktrees: repo.worktrees.filter((_, j) => j !== tree) } : repo,
        )
        expect(await discover(dropped)).toBe(under)
        expect(under).toBeLessThan(resident.length)
      } finally {
        change.mockRestore()
        f.dispose()
      }
    }, 120_000)

    it(`an issue batch wakes only the exit readers of the ids it names (${scale}x)`, async () => {
      const f = await fixture(scale)
      const stop = attachIssuePageSource(f.pool, f.rt)
      try {
        const renamed = f.ctx.targets.visibleRootId
        const other = [...f.pool.tables.issue.keys()].find((id) => id !== renamed) ?? ''
        expect(other).not.toBe('')
        let runs = 0
        const off = autorun(() => {
          f.pool.row('issueExit', other)
          runs++
        })
        const named = { runs: 0 }
        const offNamed = autorun(() => {
          f.pool.row('issueExit', renamed)
          named.runs++
        })
        runs = 0
        named.runs = 0
        await writeTitleRename(f.ctx)
        await flush()
        expect(runs).toBe(0)
        expect(named.runs).toBeGreaterThan(0)
        off()
        offNamed()
      } finally {
        stop()
        f.dispose()
      }
    }, 120_000)

    it(`chat order lists cost their addresses, not the history (${scale}x)`, async () => {
      const f = await fixture(scale)
      try {
        f.chat.read('chatSessionOrder', 'order')
        f.chat.read('chatIssueOrder', 'order')
        await flush()
        const stop = autorun(() => {
          f.chat.read('chatSessionOrder', 'order')
        })
        const order = f.chat.read('chatSessionOrder', 'order')
        const { orderLists, orderIds, addressedOrders } = f.chat.counts
        await writeHeartbeat(f.ctx)
        await flush()
        // No whole-kind pass and no id copied: the batch costs its addresses.
        expect(f.chat.read('chatSessionOrder', 'order')).toBe(order)
        expect(f.chat.counts.orderLists).toBe(orderLists)
        expect(f.chat.counts.orderIds).toBe(orderIds)
        expect(f.chat.counts.addressedOrders - addressedOrders).toBeLessThanOrEqual(4)
        stop()
        await writeHeartbeat(f.ctx)
        await flush()
        expect(f.chat.counts.orderIds).toBe(orderIds)
        // A normal computed suspends at the last observer. An untracked
        // read derives a fresh answer rather than retaining the whole list.
        const untrackedOrder = f.chat.read('chatSessionOrder', 'order')
        expect(untrackedOrder).toEqual(order)
        expect(untrackedOrder).not.toBe(order)
        expect(f.chat.counts.orderIds).toBeGreaterThan(orderIds)
      } finally {
        f.dispose()
      }
    }, 120_000)
  }

  it('a machine change reaches the header by id, and only that row moves', async () => {
    const f = await fixture(1)
    try {
      const machines = f.ctx.corpus.machines as unknown as { id: string; name: string }[]
      expect(machines.length).toBeGreaterThan(1)
      const first = machines[0]?.id ?? '',
        second = machines[1]?.id ?? ''
      // Synchronous on purpose: a new machine set also starts the runtime's
      // repo refresh, and the scenario's discovery answers with no machines.
      f.ctx.hub.emit('machines', machines)
      const kept = f.pool.header.get('machine', second)
      expect(kept).toBeDefined()
      f.ctx.hub.emit(
        'machines',
        machines.map((row, at) => (at === 0 ? { ...row, name: 'Renamed host' } : { ...row })),
      )
      expect(f.pool.header.get('machine', first)).toMatchObject({ name: 'Renamed host' })
      // A fresh but equal row keeps its identity: no reader of it wakes.
      expect(f.pool.header.get('machine', second)).toBe(kept)
    } finally {
      f.dispose()
    }
  }, 120_000)
})
