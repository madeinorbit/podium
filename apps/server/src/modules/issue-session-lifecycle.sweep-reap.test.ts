import type { IssueId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../relay'
import { attachHostDaemon } from '../test-support/host-daemon'

/**
 * THE KILL FLOOD (POD-3845).
 *
 * The closed-issue sweep asked `stopIssue` for `reapParked: true` on every pass,
 * and `reapParked` is the ONLY way `stopSession` reaches `gracefulStopThenKill`
 * for a row that is already parked (session-teardown.ts). So every 15 minutes
 * the sweep re-killed every parked session on every closed issue — measured on
 * this box as 19,039 kill frames in three hours, bunched into ~11 sweep runs of
 * several hundred frames a minute, 99.9% of them delivered to a CONNECTED
 * daemon that had nothing left to kill. Each burst wedged the daemon for tens
 * of seconds.
 *
 * Two behaviours are pinned here, and they are a pair: the sweep must not
 * re-reap, and the CLOSE must still reap — that is the case `reapParked` was
 * introduced for, and a fix that took it away from the close too would pass
 * the first test alone.
 *
 * The third pins the candidate filter: the sweep no longer pays an
 * `issues.get` (plus `issueAccess.getMeta` and `view.listForIssue` inside
 * `stopIssue`) for a closed issue with nothing left to do.
 */

const registries: SessionRegistry[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const r of registries.splice(0)) await r.dispose()
})

interface Fixture {
  reg: SessionRegistry
  daemon: ControlMessage[]
  /** Kill frames seen so far, by session. */
  killed: () => string[]
  clearDaemon: () => void
  /** Run one periodic pass, as the 15-minute interval does.
   *
   *  Called directly rather than driven off the interval: the registry arms the
   *  sweep as it builds, long before this fixture's issues exist, so a fake
   *  timer installed here would have no armed interval of its own to advance.
   *  The timer wiring itself is pinned by the single-flight test next door. */
  periodicSweep: () => Promise<void>
}

async function makeFixture(): Promise<Fixture> {
  const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  await attachHostDaemon(reg, (m) => daemon.push(m), { repos: ['/r'] })
  const rpc = (
    reg.modules.sessions as unknown as {
      rpc: {
        repoOp: (
          op: string,
          cwd: string,
          args?: Record<string, string>,
          machineId?: string,
        ) => Promise<{ ok: boolean; output: string }>
        runtimeLifecycle: (
          input: { sessionId: string; verb: 'stop' | 'hibernate' | 'kill' },
          machineId: string,
        ) => Promise<{ sessionId: string; result: { ok: true } | { reason: string } }>
      }
    }
  ).rpc
  rpc.repoOp = async () => ({ ok: true, output: '' })
  // Legacy-daemon answer: lifecycle(stop) refuses immediately so the stop path
  // escalates to the kill frame without waiting out the 10s RPC timeout. The
  // kill frame is what this file counts.
  rpc.runtimeLifecycle = async (input) => ({
    sessionId: input.sessionId,
    result: { reason: 'not_running' },
  })
  return {
    reg,
    daemon,
    killed: () =>
      daemon.filter((m) => m.type === 'kill').map((m) => (m as { sessionId: string }).sessionId),
    clearDaemon: () => {
      daemon.length = 0
    },
    periodicSweep: async () =>
      await (
        reg.modules.issueSessionLifecycle as unknown as {
          sweepClosedIssues(reason: 'startup' | 'periodic'): Promise<void>
        }
      ).sweepClosedIssues('periodic'),
  }
}

/** A session parked exactly as an earlier stop parks one. */
async function parkedSession(reg: SessionRegistry, issueId: IssueId): Promise<string> {
  const { sessionId } = await reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd: '/r',
    issueId,
  })
  const r = await reg.modules.issueSessionLifecycle.stopSession({ sessionId })
  expect(r.ok).toBe(true)
  const meta = (await reg.modules.sessions.listSessions(undefined, 'rpc')).find(
    (s) => s.sessionId === sessionId,
  )
  expect(meta?.status === 'hibernated' || meta?.status === 'exited').toBe(true)
  return sessionId
}

describe('closed-issue sweep does not re-reap parked sessions (POD-3845)', () => {
  it('a periodic pass sends no kill for an already-parked session', async () => {
    const f = await makeFixture()
    const issue = await f.reg.modules.issues.create({
      repoPath: '/r',
      title: 'Swept issue',
      startNow: false,
    })
    await f.reg.modules.issues.close(issue.id, 'done')
    const parked = await parkedSession(f.reg, issue.id)
    // A second, still-running member keeps the issue a sweep CANDIDATE, so the
    // parked session's quiet is the fix and not the filter skipping the issue.
    const running = (
      await f.reg.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/r',
        issueId: issue.id,
      })
    ).sessionId
    f.clearDaemon()

    await f.periodicSweep()

    // The sweep reached this issue and stopped the live member...
    expect(f.killed()).toContain(running)
    // ...and left the already-dead one alone.
    expect(f.killed()).not.toContain(parked)
  })

  it('closing an issue still reaps a session parked before the close', async () => {
    const f = await makeFixture()
    const issue = await f.reg.modules.issues.create({
      repoPath: '/r',
      title: 'Closed issue',
      startNow: false,
    })
    const parked = await parkedSession(f.reg, issue.id)
    f.clearDaemon()

    await f.reg.modules.issues.close(issue.id, 'done')
    // The close cleanup is deliberately fire-and-forget (afterCommit).
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(f.killed()).toContain(parked)
  })

  it('the candidate filter skips a closed issue with no worktree and only parked sessions', async () => {
    const f = await makeFixture()
    const settled = await f.reg.modules.issues.create({
      repoPath: '/r',
      title: 'Nothing left to do',
      startNow: false,
    })
    await f.reg.modules.issues.close(settled.id, 'done')
    await parkedSession(f.reg, settled.id)

    const busy = await f.reg.modules.issues.create({
      repoPath: '/r',
      title: 'Still has a member',
      startNow: false,
    })
    await f.reg.modules.issues.close(busy.id, 'done')
    await f.reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
      issueId: busy.id,
    })

    const get = vi.spyOn(f.reg.modules.issues, 'get')
    await f.periodicSweep()

    const asked = get.mock.calls.map((c) => c[0])
    // Armed: the pass really ran and really looked at the issue with work left.
    expect(asked).toContain(busy.id)
    expect(asked).not.toContain(settled.id)
  })
})
