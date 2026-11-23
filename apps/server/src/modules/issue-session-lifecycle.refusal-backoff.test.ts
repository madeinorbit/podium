import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../relay'
import { captureLogs } from '../test-support/capture-logs'
import { attachHostDaemon } from '../test-support/host-daemon'

/**
 * THE SWEEP SITS OUT A REFUSED ISSUE (POD-7036, the POD-7027 audit's finding 8).
 *
 * A closed issue whose worktree holds unsaved changes refuses its stop, and the
 * sweep used to ask it again every 15 minutes, forever: each ask re-read the
 * issue, restored its sessions and asked the daemon for a `git status`, and
 * logged two lines. These pin, at the lifecycle's own seam, that the same
 * refusal is asked again only after a back-off and logged once, and that a
 * real change still gets through: a different refusal, and a stop that goes
 * through.
 */

const registries: SessionRegistry[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const r of registries.splice(0)) await r.dispose()
})

type StopIssueResult = { ok: boolean; reason?: string; stopped: string[]; worktreeFreed: boolean }

async function fixture() {
  const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(reg)
  await attachHostDaemon(reg, () => {}, { repos: ['/r'] })
  const writer = reg.modules.issues.reports.store.serverWriter
  const issue = await reg.modules.issues.crud.create(writer, {
    repoPath: '/r',
    title: 'Dirty',
    startNow: false,
  })
  await reg.modules.issues.crud.close(writer, issue.id, 'done')
  const lifecycle = reg.modules.issueSessionLifecycle as unknown as {
    closedIssueStops: Map<string, Promise<void>>
    sweepClosedIssues(reason: 'periodic'): Promise<void>
  }
  // Let the close's own cleanup finish before the sweep is measured.
  await new Promise((resolve) => setTimeout(resolve, 0))
  while (lifecycle.closedIssueStops.size > 0)
    await Promise.allSettled([...lifecycle.closedIssueStops.values()])
  // The issue is a candidate on every pass, as a closed issue with a worktree is.
  vi.spyOn(reg.modules.issues.reports, 'closedWithWork').mockResolvedValue([issue.id])
  let answer: StopIssueResult = {
    ok: false,
    reason: 'refusing stop: unsaved changes in the working tree:\n M a.ts',
    stopped: [],
    worktreeFreed: false,
  }
  const stopIssue = vi
    .spyOn(reg.modules.sessions, 'stopIssue')
    .mockImplementation(async () => answer)
  return {
    issueId: issue.id,
    stopIssue,
    answer: (next: StopIssueResult) => {
      answer = next
    },
    /** One periodic pass; whether it asked the issue to stop. */
    pass: async () => {
      const before = stopIssue.mock.calls.length
      await lifecycle.sweepClosedIssues('periodic')
      return stopIssue.mock.calls.length > before
    },
  }
}

describe('closed-issue sweep refusal back-off (POD-7036)', () => {
  it('asks a refused issue again only after a back-off', async () => {
    const f = await fixture()
    const asked: boolean[] = []
    for (let i = 0; i < 8; i += 1) asked.push(await f.pass())
    // Asked, sits out 1, asked, sits out 3, asked.
    expect(asked).toEqual([true, false, true, false, false, false, true, false])
  })

  it('a different refusal and a stop that goes through each get through', async () => {
    const f = await fixture()
    expect(await f.pass()).toBe(true)
    expect(await f.pass()).toBe(false)
    expect(await f.pass()).toBe(true)
    // Something changed in the worktree: the next ask (after the current wait)
    // sees the new refusal and starts the wait over at one pass.
    f.answer({
      ok: false,
      reason: 'refusing stop: unsaved changes in the working tree:\n M a.ts\n M b.ts',
      stopped: [],
      worktreeFreed: false,
    })
    const until = async () => {
      for (let i = 0; i < 8; i += 1) if (await f.pass()) return i
      return -1
    }
    expect(await until()).toBe(3)
    expect(await f.pass()).toBe(false)
    // Now the stop goes through: the refusal is forgotten and the issue is
    // asked on every pass it is still a candidate.
    f.answer({ ok: true, stopped: [], worktreeFreed: true })
    expect(await f.pass()).toBe(true)
    expect(await f.pass()).toBe(true)
    expect(await f.pass()).toBe(true)
  })

  it('logs a repeated refusal once', async () => {
    const f = await fixture()
    const logs = captureLogs()
    try {
      for (let i = 0; i < 8; i += 1) await f.pass()
      expect(f.stopIssue.mock.calls.length).toBe(3)
      const refused = logs.records.filter((r) => r.msg === 'closed issue cleanup refused')
      expect(refused.map((r) => r.issueId)).toEqual([f.issueId])
    } finally {
      logs.restore()
    }
  })
})
