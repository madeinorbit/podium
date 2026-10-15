/**
 * Issues point at agent profiles (POD-6107): `--profile` on create, update and
 * start; the issue's agent fields hand the pick to the profile; the session a
 * start spawns runs the profile's first runnable candidate and records it.
 */
import { asSessionId, firstAdminMemberId, type SessionMeta } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { AgentProfileService } from './modules/agent-profiles/service'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { openTestStore } from './test-support/open-test-store'
import { sessionReadPorts } from './test-support/session-facts'

async function harness() {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/r', store.hostMachineId)
  const broadcast = vi.fn()
  const agentProfiles = new AgentProfileService({
    store: store.agentProfiles,
    now: () => '2026-10-14T00:00:00.000Z',
    listMachines: async () => [],
    // Only claude-code is installed: a profile preferring codex falls through.
    requireRunnable: async ({ agentKind }) => {
      if (agentKind !== 'claude-code') throw new Error(`${agentKind} is not installed`)
    },
    roleOf: async () => 'admin',
  })
  const spawnSession = vi.fn<IssueDeps['spawnSession']>(async () => ({
    sessionId: asSessionId('s1'),
    machine: 'm',
  }))
  /** The session fleet the service sees; a test pushes what its spawns produced. */
  const sessions: SessionMeta[] = []
  const repoOp = vi.fn<IssueDeps['repoOp']>(async () => ({ ok: true, output: '' }))
  const deps: IssueDeps = {
    store,
    ...sessionReadPorts(() => sessions),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession,
    repoOp,
    resolveMachine: vi.fn(async () => store.hostMachineId),
    ...issueTestPlumbing((msg) => broadcast(msg)),
    setSessionArchived: vi.fn(),
    clearSessionOffer: vi.fn(),
    onWorktreesChanged: vi.fn(),
    now: () => '2026-10-14T00:00:00.000Z',
    agentProfiles,
  }
  return { svc: await IssueService.create(deps), spawnSession, agentProfiles, sessions, repoOp }
}

/** Single-candidate profiles, so no probing decides the pick and each is recognisable. */
async function withProfiles(agentProfiles: AgentProfileService) {
  const admin = { userId: firstAdminMemberId(), actorSessionId: null }
  const make = async (name: string, harness: 'claude-code' | 'codex', effort: string) =>
    await agentProfiles.create(admin, { name, candidates: [{ harness, model: 'auto', effort }] })
  return {
    own: await make('p-own', 'claude-code', 'low'),
    parent: await make('p-parent', 'codex', 'medium'),
    mission: await make('p-mission', 'codex', 'high'),
  }
}

/** The fields of the one session start spawned. */
const spawnedWith = (spawnSession: ReturnType<typeof vi.fn>) =>
  (spawnSession.mock.calls.at(-1) as [Record<string, unknown>] | undefined)?.[0]

const worktreeAdds = (repoOp: ReturnType<typeof vi.fn>) =>
  repoOp.mock.calls.filter(([op]) => op === 'worktreeAdd').length

/** A session record for an issue, as the fleet would show one after a spawn. */
const sessionOn = (issueId: string, cwd: string): SessionMeta =>
  ({
    sessionId: asSessionId(`s-${issueId}`),
    issueId,
    cwd,
    agentKind: 'codex',
    status: 'running',
    title: 'worker',
    createdAt: '2026-10-14T00:00:00.000Z',
    lastActiveAt: '2026-10-14T00:00:00.000Z',
  }) as unknown as SessionMeta

describe('issues with agent profiles', () => {
  it('create --profile stores the profile and leaves the agent pick to it', async () => {
    const { svc, agentProfiles } = await harness()
    const build = await agentProfiles.show('build')
    const issue = await svc.crud.create({
      repoPath: '/r',
      title: 'Built',
      startNow: false,
      agentProfile: 'build',
    })
    expect(issue).toMatchObject({
      agentProfileId: build.id,
      defaultAgent: 'auto',
      defaultModel: 'auto',
    })
    // Without a profile the harness stays `auto` too (POD-6133): the issue stores
    // picks only, and Settings apply when each session starts.
    const plain = await svc.crud.create({ repoPath: '/r', title: 'Plain', startNow: false })
    expect(plain).toMatchObject({
      defaultAgent: 'auto',
      defaultModel: 'auto',
      defaultEffort: 'auto',
    })
    expect(plain).not.toHaveProperty('agentProfileId')
  })

  it('refuses an unknown profile before creating anything', async () => {
    const { svc } = await harness()
    await expect(
      svc.crud.create({ repoPath: '/r', title: 'Nope', startNow: false, agentProfile: 'nope' }),
    ).rejects.toThrow(/no agent profile 'nope'/)
    expect(await svc.reports.list('/r')).toHaveLength(0)
  })

  it('update --profile hands the agent fields to the profile; null clears it', async () => {
    const { svc, agentProfiles } = await harness()
    const review = await agentProfiles.show('review')
    const issue = await svc.crud.create({
      repoPath: '/r',
      title: 'Picked',
      startNow: false,
      defaultAgent: 'codex',
      defaultEffort: 'low',
    })
    const updated = await svc.crud.update(issue.id, { agentProfile: 'review' })
    expect(updated).toMatchObject({
      agentProfileId: review.id,
      defaultAgent: 'auto',
      defaultModel: 'auto',
      defaultEffort: 'auto',
    })
    // A field named in the same patch still wins.
    const kept = await svc.crud.update(issue.id, { agentProfile: 'build', defaultEffort: 'max' })
    expect(kept).toMatchObject({ defaultEffort: 'max' })
    const cleared = await svc.crud.update(issue.id, { agentProfile: null })
    expect(cleared).not.toHaveProperty('agentProfileId')
  })

  it('start spawns the first runnable candidate and records the profile on the session', async () => {
    const { svc, spawnSession, agentProfiles } = await harness()
    const review = await agentProfiles.show('review')
    const issue = await svc.crud.create({ repoPath: '/r', title: 'Reviewed', startNow: false })
    const started = await svc.gitWorkflow.start(issue.id, undefined, { agentProfile: 'review' })
    // `review` prefers codex, which is not installed here.
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'claude-code',
        agentProfileId: review.id,
        issueId: issue.id,
      }),
    )
    expect(started).toMatchObject({ agentProfileId: review.id, assignee: 'agent:claude-code' })
  })
})

/**
 * POD-6119 (flight deck provisional default): starting an issue without a profile
 * of its own uses its parent's, then the mission's — and an own-issue proposal
 * falls back to the mission it was discovered from.
 */
describe('agent profile inheritance on start', () => {
  async function mission() {
    const h = await harness()
    const p = await withProfiles(h.agentProfiles)
    const root = await h.svc.crud.create({
      repoPath: '/r',
      title: 'Mission',
      startNow: false,
      agentProfile: 'p-mission',
    })
    const task = await h.svc.crud.create({
      repoPath: '/r',
      title: 'Task',
      startNow: false,
      parentId: root.id,
    })
    return { ...h, p, root, task }
  }

  it("the issue's own profile beats its parent's and the mission's", async () => {
    const { svc, spawnSession, p, task } = await mission()
    await svc.crud.update(task.id, { agentProfile: 'p-parent' })
    const proposal = await svc.crud.create({
      repoPath: '/r',
      title: 'Own',
      startNow: false,
      parentId: task.id,
      stage: 'proposed',
      agentProfile: 'p-own',
    })
    await svc.gitWorkflow.start(proposal.id)
    expect(spawnedWith(spawnSession)).toMatchObject({
      agentKind: 'claude-code',
      agentProfileId: p.own.id,
    })
  })

  it("falls back to the parent's profile", async () => {
    const { svc, spawnSession, p, task } = await mission()
    await svc.crud.update(task.id, { agentProfile: 'p-parent' })
    const proposal = await svc.crud.create({
      repoPath: '/r',
      title: 'Here',
      startNow: false,
      parentId: task.id,
      stage: 'proposed',
    })
    const started = await svc.gitWorkflow.start(proposal.id)
    expect(spawnedWith(spawnSession)).toMatchObject({
      agentKind: 'codex',
      effort: 'medium',
      agentProfileId: p.parent.id,
    })
    expect(started).toMatchObject({ stage: 'in_progress', assignee: 'agent:codex' })
    // Inherited, not adopted: the issue still names no profile of its own.
    expect(started).not.toHaveProperty('agentProfileId')
  })

  it("falls back to the mission's profile through a parent without one", async () => {
    const { svc, spawnSession, p, task } = await mission()
    const proposal = await svc.crud.create({
      repoPath: '/r',
      title: 'Here',
      startNow: false,
      parentId: task.id,
      stage: 'proposed',
    })
    await svc.gitWorkflow.start(proposal.id)
    expect(spawnedWith(spawnSession)).toMatchObject({
      agentKind: 'codex',
      effort: 'high',
      agentProfileId: p.mission.id,
    })
  })

  it('an own-issue proposal uses the mission it was discovered from, not the origin task', async () => {
    const { svc, spawnSession, p, task } = await mission()
    await svc.crud.update(task.id, { agentProfile: 'p-parent' })
    const proposal = await svc.crud.create({
      repoPath: '/r',
      title: 'Own issue',
      startNow: false,
      stage: 'proposed',
    })
    await svc.hierarchy.addDep(proposal.id, task.id, 'discovered-from')
    const started = await svc.gitWorkflow.start(proposal.id)
    expect(spawnedWith(spawnSession)).toMatchObject({ agentProfileId: p.mission.id })
    // Starting keeps the placement: still top level, still discovered from the task.
    expect(started).not.toHaveProperty('parentId')
    expect((await svc.reports.get(proposal.id))?.deps).toContainEqual(
      expect.objectContaining({ id: task.id, type: 'discovered-from' }),
    )
  })

  it('with no profile anywhere the launch is the issue fields and Settings, as before', async () => {
    const { svc, spawnSession } = await harness()
    const root = await svc.crud.create({ repoPath: '/r', title: 'Bare', startNow: false })
    const proposal = await svc.crud.create({
      repoPath: '/r',
      title: 'Bare child',
      startNow: false,
      parentId: root.id,
      stage: 'proposed',
    })
    const started = await svc.gitWorkflow.start(proposal.id)
    const spawned = spawnedWith(spawnSession)
    expect(spawned).toMatchObject({ agentKind: 'claude-code' })
    expect(spawned).not.toHaveProperty('agentProfileId')
    // The Settings harness is launch-only: the issue keeps `auto` for the next start.
    expect(started).toMatchObject({ defaultAgent: 'auto' })
  })

  it('a harness pick equal to the Settings default is still a pick (POD-6133)', async () => {
    const { svc, spawnSession, p, task } = await mission()
    const proposal = await svc.crud.create({
      repoPath: '/r',
      title: 'Picked default',
      startNow: false,
      parentId: task.id,
      stage: 'proposed',
      defaultAgent: 'claude-code',
    })
    await svc.gitWorkflow.start(proposal.id)
    // The mission's profile lists only codex, so the pick stands alone on top of it.
    expect(spawnedWith(spawnSession)).toMatchObject({
      agentKind: 'claude-code',
      agentProfileId: p.mission.id,
    })
  })

  it("the issue's own picks ride on top of an inherited profile", async () => {
    const { svc, spawnSession, p, task } = await mission()
    const proposal = await svc.crud.create({
      repoPath: '/r',
      title: 'Picked',
      startNow: false,
      parentId: task.id,
      stage: 'proposed',
      defaultAgent: 'codex',
      defaultEffort: 'low',
    })
    await svc.gitWorkflow.start(proposal.id)
    expect(spawnedWith(spawnSession)).toMatchObject({
      agentKind: 'codex',
      effort: 'low',
      agentProfileId: p.mission.id,
    })
  })

  it('a per-launch harness or --profile beats the inherited profile', async () => {
    const { svc, spawnSession, p, task } = await mission()
    const named = await svc.crud.create({
      repoPath: '/r',
      title: 'Named harness',
      startNow: false,
      parentId: task.id,
    })
    await svc.gitWorkflow.start(named.id, 'claude-code')
    // The mission's profile lists no claude-code candidate, so the override stands alone.
    expect(spawnedWith(spawnSession)).toMatchObject({
      agentKind: 'claude-code',
      agentProfileId: p.mission.id,
    })
    const profiled = await svc.crud.create({
      repoPath: '/r',
      title: 'Named profile',
      startNow: false,
      parentId: task.id,
    })
    const started = await svc.gitWorkflow.start(profiled.id, undefined, { agentProfile: 'p-own' })
    expect(spawnedWith(spawnSession)).toMatchObject({ agentProfileId: p.own.id })
    expect(started).toMatchObject({ agentProfileId: p.own.id })
  })

  it('naming the Settings harness on an `auto` issue keeps its model; another harness resets it', async () => {
    const { svc, spawnSession } = await harness()
    const issue = await svc.crud.create({
      repoPath: '/r',
      title: 'Model picked',
      startNow: false,
      defaultModel: 'opus',
    })
    expect(await svc.crud.update(issue.id, { defaultAgent: 'claude-code' })).toMatchObject({
      defaultAgent: 'claude-code',
      defaultModel: 'opus',
    })
    expect(await svc.crud.update(issue.id, { defaultAgent: 'codex' })).toMatchObject({
      defaultAgent: 'codex',
      defaultModel: 'auto',
    })
    const atStart = await svc.crud.create({
      repoPath: '/r',
      title: 'Start names default',
      startNow: false,
      defaultModel: 'opus',
    })
    const started = await svc.gitWorkflow.start(atStart.id, 'claude-code')
    expect(spawnedWith(spawnSession)).toMatchObject({ agentKind: 'claude-code' })
    expect(started).toMatchObject({ defaultAgent: 'claude-code', defaultModel: 'opus' })
  })

  it('add-session on a started issue inherits the same way', async () => {
    const { svc, spawnSession, p, task, sessions } = await mission()
    const child = await svc.crud.create({
      repoPath: '/r',
      title: 'Child',
      startNow: false,
      parentId: task.id,
    })
    const started = await svc.gitWorkflow.start(child.id)
    sessions.push(sessionOn(child.id, started.worktreePath as string))
    await svc.gitWorkflow.addSession(child.id)
    expect(spawnSession).toHaveBeenCalledTimes(2)
    expect(spawnedWith(spawnSession)).toMatchObject({ agentProfileId: p.mission.id })
  })
})

/**
 * POD-6119: Start must report what happened. A spawn that throws is a failure the
 * caller sees, a retry finishes the start rather than claiming it, and a proposal
 * whose start failed stays among the proposals.
 */
describe('start failures and retries', () => {
  it('a proposal whose spawn fails goes back to proposed; the retry spawns from the same worktree', async () => {
    const { svc, spawnSession, repoOp } = await harness()
    const proposal = await svc.crud.create({
      repoPath: '/r',
      title: 'Flaky',
      startNow: false,
      stage: 'proposed',
    })
    spawnSession.mockRejectedValueOnce(new Error('codex is not logged in'))
    await expect(svc.gitWorkflow.start(proposal.id)).rejects.toThrow(/not logged in/)
    const failed = await svc.reports.get(proposal.id)
    expect(failed).toMatchObject({ stage: 'proposed' })
    expect(failed?.worktreePath).toBeTruthy()
    expect(failed?.assignee ?? null).toBeNull()

    const retried = await svc.gitWorkflow.start(proposal.id)
    expect(spawnSession).toHaveBeenCalledTimes(2)
    expect(worktreeAdds(repoOp)).toBe(1)
    expect(retried).toMatchObject({ stage: 'in_progress', worktreePath: failed?.worktreePath })
    expect(retried).toHaveProperty('agentId', 's1')
  })

  it('a non-proposal keeps its started stage after a failed spawn, and a retry still spawns', async () => {
    const { svc, spawnSession } = await harness()
    const issue = await svc.crud.create({ repoPath: '/r', title: 'Backlog', startNow: false })
    spawnSession.mockRejectedValueOnce(new Error('machine offline'))
    await expect(svc.gitWorkflow.start(issue.id)).rejects.toThrow(/offline/)
    expect(await svc.reports.get(issue.id)).toMatchObject({ stage: 'in_progress' })
    const retried = await svc.gitWorkflow.start(issue.id)
    expect(spawnSession).toHaveBeenCalledTimes(2)
    expect(retried).toHaveProperty('agentId', 's1')
  })

  it('starting an issue that already has a session is still a no-op', async () => {
    const { svc, spawnSession, sessions } = await harness()
    const issue = await svc.crud.create({ repoPath: '/r', title: 'Once', startNow: false })
    const started = await svc.gitWorkflow.start(issue.id)
    sessions.push(sessionOn(issue.id, started.worktreePath as string))
    const again = await svc.gitWorkflow.start(issue.id)
    expect(spawnSession).toHaveBeenCalledTimes(1)
    expect(again).not.toHaveProperty('agentId')
  })

  it('two starts of the same issue at once launch one session', async () => {
    const { svc, spawnSession, repoOp } = await harness()
    const proposal = await svc.crud.create({
      repoPath: '/r',
      title: 'Double click',
      startNow: false,
      stage: 'proposed',
    })
    let release: () => void = () => {}
    spawnSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          release = () => resolve({ sessionId: asSessionId('s1'), machine: 'm' })
        }),
    )
    const first = svc.gitWorkflow.start(proposal.id)
    const second = svc.gitWorkflow.start(proposal.id)
    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledTimes(1))
    // A joiner asking for something else is refused rather than silently ignored.
    await expect(svc.gitWorkflow.start(proposal.id, 'codex')).rejects.toThrow(/already starting/)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(spawnSession).toHaveBeenCalledTimes(1)
    expect(worktreeAdds(repoOp)).toBe(1)
    expect(b).toEqual(a)
  })
})
