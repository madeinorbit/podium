import type { ReleaseProposal } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { BuildTimeoutError, buildTask } from './build-attempt'
import { createReleaseApprovalFlow } from './release-approval'

const BASE: ReleaseProposal = {
  headSha: 'aaaaaaa',
  version: '0.1.2-dev.1+aaaaaaa',
  branch: 'main',
  commits: [{ sha: 'aaaaaaa', summary: 'Release me' }],
  addedMigrations: [],
  state: 'pending',
}
const TARGET = { headSha: BASE.headSha, version: BASE.version }

describe('release approval flow', () => {
  it('keeps a timed-out publication retryable when its proposal is no longer offered', async () => {
    let current: ReleaseProposal | undefined = BASE
    const release = vi
      .fn()
      .mockImplementationOnce(async () => {
        current = undefined
        await new Promise(() => {})
      })
      .mockResolvedValue(undefined)
    const flow = createReleaseApprovalFlow({
      proposal: async () => current,
      release,
      failureLogs: String,
      buildTimeoutMs: 10,
    })
    await flow.approve('operator', TARGET)
    await vi.waitFor(() =>
      expect(flow.read()).resolves.toMatchObject({
        headSha: BASE.headSha,
        state: 'failed',
        failure: {
          message: expect.stringMatching(/overall time limit.*try building again/i),
          logs: expect.stringContaining('timed out'),
        },
      }),
    )
    await expect(flow.approve('operator', TARGET)).resolves.toMatchObject({ state: 'building' })
    await vi.waitFor(() => expect(flow.read()).resolves.toBeUndefined())
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('includes approval reads in the overall deadline and frees admission on expiry', async () => {
    const proposal = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(BASE)
    const flow = createReleaseApprovalFlow({
      proposal,
      release: async () => {},
      failureLogs: String,
      buildTimeoutMs: 10,
    })
    await expect(flow.approve('operator', TARGET)).rejects.toThrow(BuildTimeoutError)
    await expect(flow.approve('operator', TARGET)).resolves.toMatchObject({ state: 'building' })
  })

  it('shares the admission budget with the build and prevents late publication', async () => {
    vi.useFakeTimers()
    try {
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const publish = vi.fn()
      const release = vi
        .fn()
        .mockImplementationOnce(async () => {
          await buildTask(() => pending)
          publish()
        })
        .mockResolvedValue(undefined)
      const flow = createReleaseApprovalFlow({
        proposal: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40))
          return BASE
        },
        release,
        failureLogs: String,
        buildTimeoutMs: 100,
      })
      const approved = flow.approve('operator', TARGET)
      await vi.advanceTimersByTimeAsync(40)
      await expect(approved).resolves.toMatchObject({ state: 'building' })
      await vi.advanceTimersByTimeAsync(60)
      const reading = flow.read()
      await vi.advanceTimersByTimeAsync(40)
      await expect(reading).resolves.toMatchObject({
        state: 'failed',
        failure: { logs: expect.stringContaining('timed out') },
      })
      finish()
      await vi.advanceTimersByTimeAsync(0)
      expect(publish).not.toHaveBeenCalled()
      const retry = flow.approve('operator', TARGET)
      await vi.advanceTimersByTimeAsync(40)
      await expect(retry).resolves.toMatchObject({ state: 'building' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a repeated approval with the build in flight, never a second build', async () => {
    let current: ReleaseProposal | undefined = BASE
    let finish!: () => void
    const building = new Promise<void>((resolve) => {
      finish = resolve
    })
    const release = vi.fn(async (_proposal: ReleaseProposal) => {
      await building
      current = undefined
    })
    const flow = createReleaseApprovalFlow({
      proposal: async () => current,
      release,
      failureLogs: String,
      now: () => 123,
    })

    // This resolves while the build is still suspended: no long HTTP request.
    await expect(flow.approve('user:admin', TARGET)).resolves.toMatchObject({
      state: 'building',
      approval: { approvedBy: 'user:admin', approvedAt: 123 },
    })
    await expect(flow.read()).resolves.toMatchObject({ state: 'building', headSha: BASE.headSha })
    // A resent request or a second tab asks for the build that is already
    // running: it gets that build back, approval and all, not a refusal.
    await expect(flow.approve('user:other-admin', TARGET)).resolves.toMatchObject({
      state: 'building',
      approval: { approvedBy: 'user:admin', approvedAt: 123 },
    })
    expect(release).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ headSha: 'aaaaaaa' }))

    finish()
    await vi.waitFor(() => expect(flow.read()).resolves.toBeUndefined())
    expect(release).toHaveBeenCalledOnce()
  })

  it('answers copies of one approval that arrive while admission is still reading', async () => {
    let answer!: (proposal: ReleaseProposal) => void
    const reading = new Promise<ReleaseProposal>((resolve) => {
      answer = resolve
    })
    const release = vi.fn(async (_proposal: ReleaseProposal) => new Promise<void>(() => {}))
    const flow = createReleaseApprovalFlow({
      proposal: () => reading,
      release,
      failureLogs: String,
      now: () => 7,
    })

    // One press, its answer lost, and the same request arriving twice more
    // before the proposal read finished (the 2026-11-18 update, POD-7154).
    const copies = [
      flow.approve('user:admin', TARGET),
      flow.approve('user:admin', TARGET),
      flow.approve('user:admin', TARGET),
    ]
    await expect(
      flow.approve('user:admin', { headSha: 'bbbbbbb', version: '0.1.2-dev.2+bbbbbbb' }),
    ).rejects.toThrow(/already building/)
    answer(BASE)
    for (const copy of copies) {
      await expect(copy).resolves.toMatchObject({ state: 'building', headSha: BASE.headSha })
    }
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps build logs, approval identity, and the no-rollback explanation on failure', async () => {
    let fail!: (error: Error) => void
    const building = new Promise<void>((_, reject) => {
      fail = reject
    })
    const flow = createReleaseApprovalFlow({
      proposal: async () => BASE,
      release: async (_proposal) => building,
      failureLogs: (error) => (error instanceof Error ? error.message : String(error)),
      now: () => 456,
    })

    await flow.approve('user:admin', TARGET)
    expect(await flow.read()).toMatchObject({ state: 'building' })
    fail(new Error('compile exited 1'))
    await vi.waitFor(() =>
      expect(flow.read()).resolves.toMatchObject({
        state: 'failed',
        approval: { approvedBy: 'user:admin', approvedAt: 456 },
        failure: {
          message: expect.stringMatching(/nothing was granted.*nothing to roll back/i),
          logs: 'compile exited 1',
        },
      }),
    )
  })

  it('keeps the approved build visible across refreshes when HEAD advances', async () => {
    let current = BASE
    let finish!: () => void
    const building = new Promise<void>((resolve) => {
      finish = resolve
    })
    const flow = createReleaseApprovalFlow({
      proposal: async () => current,
      release: (_proposal) => building,
      failureLogs: String,
    })

    await flow.approve('user:admin', TARGET)
    await vi.waitFor(() => expect(flow.read()).resolves.toMatchObject({ state: 'building' }))
    current = { ...BASE, headSha: 'bbbbbbb', version: '0.1.2-dev.2+bbbbbbb' }
    expect(await flow.read()).toMatchObject({ headSha: BASE.headSha, state: 'building' })
    await expect(
      flow.approve('user:other-admin', { headSha: current.headSha, version: current.version }),
    ).rejects.toThrow(/already building/)
    finish()
    await vi.waitFor(() =>
      expect(flow.read()).resolves.toMatchObject({ headSha: current.headSha, state: 'pending' }),
    )
  })

  it('refuses when the displayed proposal moved instead of silently approving current HEAD', async () => {
    const moved = { ...BASE, headSha: 'bbbbbbb', version: '0.1.2-dev.2+bbbbbbb' }
    const release = vi.fn(async (_proposal: ReleaseProposal) => {})
    const flow = createReleaseApprovalFlow({
      proposal: async () => moved,
      release,
      failureLogs: String,
    })

    await expect(flow.approve('user:admin', TARGET)).rejects.toThrow(
      /proposal moved.*review and approve the new proposal/i,
    )
    expect(release).not.toHaveBeenCalled()
  })
})
