import { asMachineId, asSessionId, type IssueReport } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { checkedOutBranch, defaultParentBranchFor } from './modules/issues/service/parent-branch'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { CompatibilityShippingPolicyResolver } from './modules/shipping/policy'
import { openTestStore } from './test-support/open-test-store'
import { sessionReadPorts } from './test-support/session-facts'

/**
 * POD-2065: an instance-wide default parent branch (`tf.dev`, for Podium
 * development) was stamped onto issues in repositories that have no such ref,
 * and their start died on git's `fatal: invalid reference: tf.dev`. Each
 * repository now carries its own base branch (`repoDefault`), which wins over the
 * instance default.
 *
 * The fake repository answers `revParseVerify` from `refs` and `statusProbe`
 * from `head`; `answers: false` models a daemon that cannot be reached.
 */
async function harness(opts: {
  defaultParentBranch: string
  repoDefault?: string
  refs: string[]
  head?: string
  answers?: boolean
}) {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/r', store.hostMachineId)
  if (opts.repoDefault) {
    await store.repos.setRepoDefaultParentBranch(store.hostMachineId, '/r', opts.repoDefault)
  }
  const git = { refs: new Set(opts.refs), answers: opts.answers ?? true }
  const ops: { op: string; args?: Record<string, string> }[] = []
  const broadcast = vi.fn()
  const deps: IssueDeps = {
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: opts.defaultParentBranch,
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(async () => ({ sessionId: asSessionId('s1'), machine: 'm' })),
    readRepo: async (op, cwd, args) => await deps.repoOp(op, cwd, args),
    repoOp: async (op, _cwd, args) => {
      ops.push({ op, ...(args ? { args } : {}) })
      if (!git.answers) return { ok: false, output: 'no daemon answered the git request in time' }
      if (op === 'revParseVerify') {
        const ref = args?.ref ?? ''
        return ref === 'HEAD' || git.refs.has(ref)
          ? { ok: true, output: 'deadbeef' }
          : { ok: false, output: 'fatal: Needed a single revision' }
      }
      if (op === 'statusProbe')
        return { ok: true, output: `## ${opts.head ?? 'HEAD (no branch)'}\n` }
      if (op === 'worktreeAdd') {
        return git.refs.has(args?.startPoint ?? '')
          ? { ok: true, output: '' }
          : { ok: false, output: `fatal: invalid reference: ${args?.startPoint}` }
      }
      return { ok: true, output: '' }
    },
    resolveMachine: vi.fn(async () => store.hostMachineId),
    ...issueTestPlumbing((msg) => broadcast(msg)),
    setSessionArchived: vi.fn(),
    clearSessionOffer: vi.fn(),
    onWorktreesChanged: vi.fn(),
    now: () => '2026-10-26T00:00:00.000Z',
  }
  return { svc: await IssueService.create(deps), deps, git, ops, store }
}

describe('parent branch for a new issue (POD-2065)', () => {
  it("takes the repository's base branch over the instance default, unprobed", async () => {
    const { svc, ops } = await harness({
      defaultParentBranch: 'main',
      repoDefault: 'tf.dev',
      refs: ['main', 'tf.dev'],
    })
    const w = await svc.crud.create({ repoPath: '/r', title: 'Podium work', startNow: false })
    expect(w.parentBranch).toBe('tf.dev')
    expect(ops).toEqual([])
  })

  it('stores the instance default as configured, without probing or falling back', async () => {
    const { svc, ops } = await harness({ defaultParentBranch: 'tf.dev', refs: ['main'] })
    const w = await svc.crud.create({ repoPath: '/r', title: 'Other repo', startNow: false })
    expect(w.parentBranch).toBe('tf.dev')
    expect(ops).toEqual([])
  })

  it('detects main, master, then the checked-out branch when nothing is configured', async () => {
    const main = await harness({ defaultParentBranch: '', refs: ['main', 'master'] })
    expect(
      (await main.svc.crud.create({ repoPath: '/r', title: 'a', startNow: false })).parentBranch,
    ).toBe('main')
    const master = await harness({ defaultParentBranch: '', refs: ['master'] })
    expect(
      (await master.svc.crud.create({ repoPath: '/r', title: 'b', startNow: false })).parentBranch,
    ).toBe('master')
    const trunk = await harness({
      defaultParentBranch: '',
      refs: ['trunk'],
      head: 'trunk...origin/trunk',
    })
    expect(
      (await trunk.svc.crud.create({ repoPath: '/r', title: 'c', startNow: false })).parentBranch,
    ).toBe('trunk')
  })

  it('uses main when nothing is configured and the repository does not answer', async () => {
    const { svc } = await harness({ defaultParentBranch: '', refs: [], answers: false })
    const w = await svc.crud.create({ repoPath: '/r', title: 'Offline', startNow: false })
    expect(w.parentBranch).toBe('main')
  })

  it('keeps an explicit (stacked) parent without probing it', async () => {
    const { svc, ops } = await harness({
      defaultParentBranch: '',
      repoDefault: 'tf.dev',
      refs: ['main', 'tf.dev'],
    })
    const w = await svc.crud.create({
      repoPath: '/r',
      title: 'Stacked',
      parentBranch: 'issue/7-base',
      startNow: false,
    })
    expect(w.parentBranch).toBe('issue/7-base')
    expect(ops).toEqual([])
  })

  it("changing the repository's base branch leaves existing issues where they were", async () => {
    const h = await harness({
      defaultParentBranch: '',
      repoDefault: 'main',
      refs: ['main', 'tf.dev'],
    })
    const before = await h.svc.crud.create({ repoPath: '/r', title: 'Before', startNow: false })
    await h.store.repos.setRepoDefaultParentBranch(h.store.hostMachineId, '/r', 'tf.dev')
    const after = await h.svc.crud.create({ repoPath: '/r', title: 'After', startNow: false })
    expect((await h.svc.reports.get(before.id))?.parentBranch).toBe('main')
    expect(after.parentBranch).toBe('tf.dev')
  })
})

describe('detecting the base on the right machine (POD-2065)', () => {
  it('asks the machine that reported the repository at that path', async () => {
    const store = await openTestStore(':memory:')
    const a = asMachineId('machine-a')
    const b = asMachineId('machine-b')
    // The same path on two machines, holding two different repositories.
    await store.repos.addRepo('/r', a, 'git@example.com:acme/alpha.git')
    await store.repos.addRepo('/r', b, 'git@example.com:acme/beta.git')
    const refs = new Map([
      [a, new Set(['main'])],
      [b, new Set(['master'])],
    ])
    const asked: (string | undefined)[] = []
    const readRepo: NonNullable<IssueDeps['readRepo']> = async (op, _cwd, args, machineId) => {
      asked.push(machineId)
      if (op === 'statusProbe') return { ok: true, output: '## HEAD (no branch)\n' }
      const has = machineId ? refs.get(machineId)?.has(args?.ref ?? '') : false
      return has ? { ok: true, output: 'deadbeef' } : { ok: false, output: 'fatal' }
    }
    const deps: IssueDeps = {
      store,
      ...sessionReadPorts(() => []),
      getSettings: async () => normalizeSettings({ sessionDefaults: { agent: 'claude-code' } }),
      spawnSession: vi.fn(async () => ({ sessionId: asSessionId('s1'), machine: 'm' })),
      readRepo,
      repoOp: async () => ({ ok: true, output: '' }),
      resolveMachine: vi.fn(async () => a),
      ...issueTestPlumbing(vi.fn()),
      setSessionArchived: vi.fn(),
      clearSessionOffer: vi.fn(),
      onWorktreesChanged: vi.fn(),
      now: () => '2026-10-26T00:00:00.000Z',
    }
    const svc = await IssueService.create(deps)
    const onB = await svc.crud.create({ repoPath: '/r', title: 'B', machineId: b, startNow: false })
    expect(onB.parentBranch).toBe('master')
    expect(new Set(asked)).toEqual(new Set([b]))
  })
})

describe('starting an issue whose parent branch is missing (POD-2065)', () => {
  it("refuses with both fixes instead of git's error, and leaves the parent alone", async () => {
    const h = await harness({ defaultParentBranch: 'tf.dev', refs: ['main'] })
    const w = await h.svc.crud.create({ repoPath: '/r', title: 'Existing', startNow: false })
    expect(w.parentBranch).toBe('tf.dev')

    const start = h.svc.gitWorkflow.start(w.id)
    await expect(start).rejects.toThrow(/parent branch 'tf\.dev' does not exist in \/r\./)
    const message = await h.svc.gitWorkflow.start(w.id).catch((e: Error) => e.message)
    expect(message).toContain("is the instance's default parent branch")
    expect(message).toContain(
      "set this repository's base branch (sidebar project menu → Base branch, or Settings → Repositories)",
    )
    expect(message).toMatch(/podium issue update --id \S+ --parent-branch main\./)
    // git refused the add, so nothing was built and no session was spawned.
    expect(h.deps.spawnSession).not.toHaveBeenCalled()
    const after = await h.svc.reports.get(w.id)
    expect(after?.parentBranch).toBe('tf.dev')
    expect(after?.worktreePath).toBeNull()
  })

  it("says when the missing branch is the repository's own base branch", async () => {
    const h = await harness({
      defaultParentBranch: '',
      repoDefault: 'tf.dev',
      refs: ['main', 'tf.dev'],
    })
    const w = await h.svc.crud.create({ repoPath: '/r', title: 'Existing', startNow: false })
    // The branch disappears after the issue was created — the TFT-33 shape.
    h.git.refs.delete('tf.dev')
    const message = await h.svc.gitWorkflow.start(w.id).catch((e: Error) => e.message)
    expect(message).toContain("'tf.dev' is this repository's base branch, which it no longer has.")
    expect(message).not.toContain('instance')
  })

  it('starts once the parent is pointed at a branch that exists', async () => {
    const h = await harness({ defaultParentBranch: 'tf.dev', refs: ['main', 'tf.dev'] })
    const w = await h.svc.crud.create({ repoPath: '/r', title: 'Recover', startNow: false })
    h.git.refs.delete('tf.dev')
    await expect(h.svc.gitWorkflow.start(w.id)).rejects.toThrow(/does not exist/)
    await h.svc.crud.update(w.id, { parentBranch: 'main' })
    const started = await h.svc.gitWorkflow.start(w.id)
    expect(started.worktreePath).not.toBeNull()
  })
})

describe('landing base (POD-2065)', () => {
  it("is the repository's base branch, then the instance default, then main", async () => {
    const repo = await harness({ defaultParentBranch: 'dev', repoDefault: 'tf.dev', refs: [] })
    expect(await repo.svc.reports.store.landingBase('/r')).toBe('tf.dev')
    expect(await repo.svc.reports.store.landingBase('/r/.worktrees/x')).toBe('tf.dev')
    const instance = await harness({ defaultParentBranch: 'dev', refs: [] })
    expect(await instance.svc.reports.store.landingBase('/r')).toBe('dev')
    const none = await harness({ defaultParentBranch: '', refs: [] })
    expect(await none.svc.reports.store.landingBase('/r')).toBe('main')
  })

  it('hands the shipping policy the issue, so its default can be per repository', async () => {
    const policy = new CompatibilityShippingPolicyResolver((issue) =>
      issue.repoPath === '/r' ? 'tf.dev' : 'main',
    )
    const issue = { parentBranch: '', repoPath: '/r' } as IssueReport
    expect((await policy.resolve(issue)).targetBranch).toBe('tf.dev')
    expect((await policy.resolve({ ...issue, parentBranch: 'issue/7' })).targetBranch).toBe(
      'issue/7',
    )
  })
})

describe('parent-branch helpers', () => {
  it('reads the checked-out branch from a status header', () => {
    expect(checkedOutBranch('## main...origin/main [ahead 1]\n M x')).toBe('main')
    expect(checkedOutBranch('## feature\n')).toBe('feature')
    expect(checkedOutBranch('## HEAD (no branch)\n')).toBeNull()
    expect(checkedOutBranch('## No commits yet on main\n')).toBeNull()
  })

  it('gives up on a slow repository within its budget', async () => {
    const never = () => new Promise<{ ok: boolean; output: string }>(() => {})
    await expect(defaultParentBranchFor(never, '/r', 10)).resolves.toBe('main')
  })
})
