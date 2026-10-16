/**
 * One host sample runs a fixed number of statements, whatever the number of
 * live sessions on the machine or of issues in the database [POD-6149,
 * server-data rule 8].
 *
 * The constants grew when the world index went (POD-6155), by reads that used
 * to be answered from its memory copies and now ask the database once per
 * sample, never once per session: the shells' folder owners (one indexed
 * query), a machine row, and a target's pending-mail count; at the backstop
 * also the retired session's grant edges and its machine and mail reads.
 */
import { asIssueId, asMachineId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { attachHostDaemon } from './test-support/host-daemon'
import { issueRowFixture } from './test-support/issue-row'
import { openTestStore } from './test-support/open-test-store'
import { expectConstantStatements, quietShipping, type StatementPin } from './test-support/statement-count'

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  ids: SessionId[]
}

/** `size` live shells, quiet for 61 minutes when `quiet`, against a 60-minute backstop. */
async function fixture(size: number, quiet: boolean): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {})
  await quietShipping(reg)
  await store.settings.setSettings({
    ...(await store.settings.getSettings()),
    hibernation: {
      enabled: true,
      memoryPct: 80,
      loadPerCore: null,
      maxIdleSessions: null,
      idleMinutes: 30,
      idleShellMinutes: null,
      backstopMinutes: 60,
    },
  })
  const ids: SessionId[] = []
  for (let i = 0; i < size; i++) {
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: `/w${i}`,
      machineId: store.hostMachineId,
    })
    await reg.gateway.routeDaemonFrame(asMachineId(store.hostMachineId), {
      type: 'bind',
      sessionId,
      cmd: 'sh',
      cwd: `/w${i}`,
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    } as never)
    ids.push(sessionId)
  }
  const sessions = (
    reg.modules.sessions as unknown as {
      sessions: Map<SessionId, { lastActiveAt: string; terminal: Record<string, number> }>
    }
  ).sessions
  const stampMs = quiet ? Date.now() - 61 * 60_000 : Date.now()
  ids.forEach((id, index) => {
    const live = sessions.get(id)
    if (!live) throw new Error('live session missing from map')
    // Distinct ages so the backstop's oldest-first choice is deterministic.
    const at = stampMs - index * 1000
    live.lastActiveAt = new Date(at).toISOString()
    live.terminal.resumedAtMs_ = at
    live.terminal.inputAtMs_ = at
    live.terminal.outputAtMs_ = at
  })
  // Let the binds' unawaited reactions finish before the sample is counted
  // (POD-6189): their reads used to land in the counted window or not
  // depending on how fast setup ran, which made 8 and 49 below include setup.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { store, reg, ids }
}

const sample = () => ({
  hostname: 'test',
  sampledAt: new Date().toISOString(),
  memory: {
    totalBytes: 8_000_000_000,
    availableBytes: 4_000_000_000,
    swapTotalBytes: 0,
    swapFreeBytes: 0,
  },
  load: { one: 1.0, five: 1.0, fifteen: 1.0, cpuCount: 8 },
})

const pin = (
  name: string,
  quiet: boolean,
  check: (f: Fixture) => Promise<void>,
): StatementPin<Fixture> => ({
  name,
  setup: async (size) => await fixture(size, quiet),
  target: (f) => f.store,
  run: async (f) => await f.reg.modules.hosts.onHostMetrics(f.store.hostMachineId, sample()),
  check: async (_result, f) => await check(f),
  teardown: async (f) => {
    await f.reg.dispose()
    await f.store.close()
  },
})

// RE-PINNED AFTER C1 (POD-6183; measured per commit on the polaris VM): the
// sample reads machine rows from the `machines` table (steady +1, backstop +3),
// grants from the `grants` table (backstop +4) and pending mail counts in SQL
// (steady +1, backstop +3), where the world index held copies. None depends on
// the number of shells.
//
// RE-PINNED FOR B6 (POD-6189), measured on the polaris VM. The fixture now lets
// the binds' unawaited reactions finish before the sample is counted; before,
// their reads fell inside the window (base with that settle: steady 8 -> 6,
// backstop 49 -> 47). The backstop then reads grants once per resource through
// the grants loader, where it read one retired shell's twice: 47 -> 46. C3's
// dedup against stored rows (e1db4b96b6) adds one statement to each of the
// retirement's two commits: 48.
//
// RE-PINNED FOR POD-6194 (D1e of the issue map removal), measured on the
// polaris VM: finding a folder-only session's issue (`issueForSession`, on the
// retirement's git refresh) scanned the in-memory issue map and is now the
// indexed folder-owner query, `worktree_path IN (...)`: backstop 48 -> 49.
describe('host sample: pinned statement counts at 5 and 200 live shells', () => {
  it('a sample with nothing to retire', async () => {
    await expectConstantStatements(
      pin('host sample (steady)', false, async (f) => {
        expect((await f.store.sessions.loadSessions()).map((s) => s.id).sort()).toEqual([...f.ids].sort())
      }),
      6,
    )
  })

  it('a sample costs the same with 5 or 200 issues', async () => {
    await expectConstantStatements(
      {
        ...pin('host sample (issues)', false, async (f) => {
          expect((await f.store.sessions.loadSessions()).length).toBe(f.ids.length)
        }),
        setup: async (size) => {
          const f = await fixture(5, false)
          await f.store.repos.addRepo('/w', f.store.hostMachineId)
          for (let i = 0; i < size; i++) {
            // Worktrees outside every shell's folder. The folder-owner query's
            // own cost is pinned in folder-owner-parity.test.ts.
            await f.store.issues.upsertIssue({
              ...issueRowFixture({ id: asIssueId(`iss_sample_${i}`), repoPath: '/w', seq: i + 1 }),
              repoId: undefined, machineId: f.store.hostMachineId, parentId: null,
              worktreePath: `/elsewhere/${i}`,
            } as never)
          }
          return f
        },
      },
      6,
    )
  })

  it('a sample at the backstop reads scheduled wakeups once, not once per quiet session', async () => {
    await expectConstantStatements(
      pin('host sample (backstop)', true, async (f) => {
        // The oldest quiet shell is retired, the rest are left for later samples.
        await expect
          .poll(async () => (await f.store.sessions.loadSessions()).some((s) => s.id === f.ids.at(-1)))
          .toBe(false)
      }),
      49,
    )
  })
})
