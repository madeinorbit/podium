import {
  chatSourcePorts,
  replicaSourcePorts,
  superagentSourcePorts,
} from '@podium/client-graph/source-ports'
import { referenceState } from '../../../tests/worklist/diagnostics/reference-state'
import { headerEntities } from './header-entities'
import { omitGone } from './lookup'

// @vitest-environment happy-dom

import type { GitRepositoryWire } from '@podium/model'
/** Addressed adapter updates over a real scenario runtime. Drafts, issue exits,
 * repository re-links, chat order work and machine-row identity are checked
 * at their current owners at 1x and 4x corpus sizes. */
import { asSessionId } from '@podium/model/browser'
import { autorun } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startScenarioEngine,
  upsert,
  writeHeartbeat,
  writeTitleRename,
} from '../../../tests/worklist/shared/src/scenarios'
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
import { ShellSource } from './shell-source'
import { createSuperagentSource } from './superagent'

type Runtime = Awaited<ReturnType<typeof startScenarioEngine>>['engine']
const cleanups: (() => void)[] = []
beforeEach(async () => {
  // Each test owns a large corpus. Collect after the previous async test
  // unwinds, keeping retired snapshots below the shared host memory budget.
  await new Promise((resolve) => setTimeout(resolve, 0))
  ;(globalThis as typeof globalThis & { Bun: { gc(force: boolean): unknown } }).Bun.gc(true)
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const flush = async () => {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()
}

async function fixture(scale: 1 | 4) {
  const ctx = await startScenarioEngine(scale)
  const rt = ctx.engine
  // The scenario owns the runtime and side cache, including their window
  // listeners and polling timers. Release every owner, even if setup fails.
  const stops: (() => void)[] = [() => ctx.dispose()]
  const dispose = () => {
    for (const stop of stops.splice(0).reverse()) stop()
  }
  cleanups.push(dispose)
  const handle = createRuntimeWorklistPool(rt, { summaries: COMMAND_SUMMARIES })
  stops.push(() => handle.dispose())
  for (let turn = 0; turn < 32 && handle.pool.hydrate(); turn++) {
    /* baseline boot */
  }
  const pool = handle.pool
  const board = createIssueBoardSource(pool, rt)
  stops.push(() => board.dispose())
  const pane = new SessionPaneSource(rt)
  stops.push(() => pane.dispose())
  const shell = new ShellSource(rt)
  stops.push(() => shell.dispose())
  stops.push(attachHeaderSource(pool, rt))
  const command = new CommandLaunchSource(pool, rt)
  stops.push(() => command.dispose())
  const settings = new SettingsSource({ ui: rt.ui, ...replicaSourcePorts(rt) })
  settings.read('settingsWindow', 'window')
  stops.push(() => settings.dispose())
  const superagent = await createSuperagentSource(superagentSourcePorts(rt))
  superagent.read('superagentLocal', 'local')
  stops.push(() => superagent.dispose())
  const chat = new ChatContextSource(chatSourcePorts(rt), pool)
  const session = ctx.targets.phaseSessionId
  chat.read('chatDraft', session)
  chat.read('chatWindow', 'window')
  stops.push(() => chat.dispose())
  const inbox = new MobileInboxSource(replicaSourcePorts(rt), pool)
  inbox.read('mobileInboxState', 'state')
  stops.push(() => inbox.dispose())
  const mobileSettings = await createMobileSettingsSource(replicaSourcePorts(rt))
  mobileSettings.read('mobileSettingsDiagnostics', 'diagnostics')
  stops.push(() => mobileSettings.dispose())
  const mobileSession = createMobileSessionSource(rt, pool)
  mobileSession.read('mobileSessionWindow')
  stops.push(() => mobileSession.dispose())
  await flush()
  return {
    ctx,
    rt,
    pool,
    session,
    command,
    chat,
    dispose,
  }
}

describe('keyed adapter inputs (POD-5433)', () => {
  for (const scale of [1, 4] as const) {
    it(`a draft updates its addressed chat row (${scale}x)`, async () => {
      const f = await fixture(scale)
      try {
        const seen: unknown[] = []
        const stop = autorun(() => {
          seen.push(f.chat.read('chatDraft', f.session))
        })
        const batches = f.chat.counts.batches
        try {
          referenceState(f.rt).setSessionDraft(asSessionId(f.session), 'hello')
          await flush()
          expect(f.chat.counts.batches - batches).toBe(1)
          expect(seen).toHaveLength(2)
          expect(seen[1]).toEqual({ text: 'hello' })
        } finally {
          stop()
        }
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
        f.ctx.setRepos(repos)
        await new Promise((resolve) => setTimeout(resolve, f.ctx.settleMs))
        await flush()
        return sessionLinks()
      }
      try {
        const repos = f.ctx.repos() as GitRepositoryWire[]
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
        // One path is one checkout record (POD-6644): a worktree the corpus
        // also lists as a standalone root leaves only when both entries go.
        const gone = repos[at]!.worktrees[tree]!.path
        const dropped = renamed.flatMap((repo, i) =>
          repo.path === gone
            ? []
            : [
                i === at
                  ? { ...repo, worktrees: repo.worktrees.filter((_, j) => j !== tree) }
                  : repo,
              ],
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
      const stop = attachIssuePageSource(f.pool, replicaSourcePorts(f.rt))
      try {
        const renamed = f.ctx.targets.visibleRootId
        const other = [...f.pool.tables.issue.keys()].find((id) => id !== renamed) ?? ''
        expect(other).not.toBe('')
        let runs = 0
        const off = autorun(() => {
          omitGone(f.pool.row('issueExit', other))
          runs++
        })
        cleanups.push(off)
        const named = { runs: 0 }
        const offNamed = autorun(() => {
          omitGone(f.pool.row('issueExit', renamed))
          named.runs++
        })
        cleanups.push(offNamed)
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
        cleanups.push(stop)
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
      const kept = headerEntities(f.pool).get('machine', second)
      expect(kept).toBeDefined()
      // A rename is a change of the machine's record (POD-6644).
      const record = f.ctx.cache.read('machine', first)!.value as Record<string, unknown>
      upsert(f.ctx, 'machine', first, { ...record, name: 'Renamed host' })
      await new Promise((resolve) => setTimeout(resolve, f.ctx.settleMs))
      await flush()
      expect(headerEntities(f.pool).get('machine', first)).toMatchObject({ name: 'Renamed host' })
      // The other machine's row keeps its identity: no reader of it wakes.
      expect(headerEntities(f.pool).get('machine', second)).toBe(kept)
    } finally {
      f.dispose()
    }
  }, 120_000)
})
