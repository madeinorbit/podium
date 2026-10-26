import { asSessionId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { checkedOutBranch, defaultParentBranchFor } from './modules/issues/service/parent-branch'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { openTestStore } from './test-support/open-test-store'
import { sessionReadPorts } from './test-support/session-facts'

/**
 * POD-2065: an instance-wide default parent branch (`tf.dev`, for Podium
 * development) was stamped onto issues in repositories that have no such ref,
 * and their start died on git's `fatal: invalid reference: tf.dev`.
 *
 * The fake repository answers `revParseVerify` from `refs` and `statusProbe`
 * from `head`; `answers: false` models a daemon that cannot be reached.
 */
async function harness(opts: {
  defaultParentBranch: string
  refs: string[]
  head?: string
  answers?: boolean
}) {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/r', store.hostMachineId)
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
  return { svc: await IssueService.create(deps), deps, git, ops }
}

describe('parent branch for a new issue (POD-2065)', () => {
  it('keeps the configured default in a repository that has it', async () => {
    const { svc } = await harness({ defaultParentBranch: 'tf.dev', refs: ['main', 'tf.dev'] })
    const w = await svc.crud.create({ repoPath: '/r', title: 'Podium work', startNow: false })
    expect(w.parentBranch).toBe('tf.dev')
  })

  it("falls back to the repository's own base when the default is missing there", async () => {
    const { svc } = await harness({ defaultParentBranch: 'tf.dev', refs: ['main'] })
    const w = await svc.crud.create({ repoPath: '/r', title: 'Other repo', startNow: false })
    expect(w.parentBranch).toBe('main')
  })

  it('uses master, then the checked-out branch, when there is no main', async () => {
    const master = await harness({ defaultParentBranch: 'tf.dev', refs: ['master'] })
    expect(
      (await master.svc.crud.create({ repoPath: '/r', title: 'a', startNow: false })).parentBranch,
    ).toBe('master')
    const trunk = await harness({
      defaultParentBranch: 'tf.dev',
      refs: ['trunk'],
      head: 'trunk...origin/trunk',
    })
    expect(
      (await trunk.svc.crud.create({ repoPath: '/r', title: 'b', startNow: false })).parentBranch,
    ).toBe('trunk')
  })

  it('keeps an explicit (stacked) parent without probing it', async () => {
    const { svc, ops } = await harness({ defaultParentBranch: 'tf.dev', refs: ['main'] })
    const w = await svc.crud.create({
      repoPath: '/r',
      title: 'Stacked',
      parentBranch: 'issue/7-base',
      startNow: false,
    })
    expect(w.parentBranch).toBe('issue/7-base')
    expect(ops.filter((o) => o.op === 'revParseVerify')).toEqual([])
  })

  it('keeps `main` without probing when no default is configured', async () => {
    const { svc, ops } = await harness({ defaultParentBranch: '', refs: ['master'] })
    const w = await svc.crud.create({ repoPath: '/r', title: 'Unset', startNow: false })
    expect(w.parentBranch).toBe('main')
    expect(ops).toEqual([])
  })

  it('keeps the configured default when the repository does not answer', async () => {
    const { svc } = await harness({ defaultParentBranch: 'tf.dev', refs: [], answers: false })
    const w = await svc.crud.create({ repoPath: '/r', title: 'Offline', startNow: false })
    expect(w.parentBranch).toBe('tf.dev')
  })
})

describe('starting an issue whose parent branch is missing (POD-2065)', () => {
  it("refuses with the fix instead of git's error, and leaves the parent alone", async () => {
    const h = await harness({ defaultParentBranch: 'tf.dev', refs: ['main', 'tf.dev'] })
    const w = await h.svc.crud.create({ repoPath: '/r', title: 'Existing', startNow: false })
    expect(w.parentBranch).toBe('tf.dev')
    // The branch disappears after the issue was created — the TFT-33 shape.
    h.git.refs.delete('tf.dev')

    const start = h.svc.gitWorkflow.start(w.id)
    await expect(start).rejects.toThrow(/parent branch 'tf\.dev' does not exist in \/r\./)
    await expect(h.svc.gitWorkflow.start(w.id)).rejects.toThrow(
      /--parent-branch main .*or create 'tf\.dev'/,
    )
    // git refused the add, so nothing was built and no session was spawned.
    expect(h.deps.spawnSession).not.toHaveBeenCalled()
    const after = await h.svc.reports.get(w.id)
    expect(after?.parentBranch).toBe('tf.dev')
    expect(after?.worktreePath).toBeNull()
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

describe('parent-branch helpers', () => {
  it('reads the checked-out branch from a status header', () => {
    expect(checkedOutBranch('## main...origin/main [ahead 1]\n M x')).toBe('main')
    expect(checkedOutBranch('## feature\n')).toBe('feature')
    expect(checkedOutBranch('## HEAD (no branch)\n')).toBeNull()
    expect(checkedOutBranch('## No commits yet on main\n')).toBeNull()
  })

  it('gives up on a slow repository within its budget', async () => {
    const never = () => new Promise<{ ok: boolean; output: string }>(() => {})
    await expect(defaultParentBranchFor(never, '/r', 'tf.dev', 10)).resolves.toBe('tf.dev')
  })
})
