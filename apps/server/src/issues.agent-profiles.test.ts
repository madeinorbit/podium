/**
 * Issues point at agent profiles (POD-6107): `--profile` on create, update and
 * start; the issue's agent fields hand the pick to the profile; the session a
 * start spawns runs the profile's first runnable candidate and records it.
 */
import { asSessionId } from '@podium/model'
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
  const spawnSession = vi.fn(async () => ({ sessionId: asSessionId('s1'), machine: 'm' }))
  const deps: IssueDeps = {
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession,
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    resolveMachine: vi.fn(async () => store.hostMachineId),
    ...issueTestPlumbing((msg) => broadcast(msg)),
    setSessionArchived: vi.fn(),
    clearSessionOffer: vi.fn(),
    onWorktreesChanged: vi.fn(),
    now: () => '2026-10-14T00:00:00.000Z',
    agentProfiles,
  }
  return { svc: await IssueService.create(deps), spawnSession, agentProfiles }
}

describe('issues with agent profiles', () => {
  it('create --profile stores the profile and leaves the agent pick to it', async () => {
    const { svc, agentProfiles } = await harness()
    const build = await agentProfiles.show('build')
    const issue = await svc.crud.create({ repoPath: '/r', title: 'Built', startNow: false, agentProfile: 'build' })
    expect(issue).toMatchObject({ agentProfileId: build.id, defaultAgent: 'auto', defaultModel: 'auto' })
    // Without a profile the Settings default is frozen in, as before.
    const plain = await svc.crud.create({ repoPath: '/r', title: 'Plain', startNow: false })
    expect(plain).toMatchObject({ defaultAgent: 'claude-code' })
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
      expect.objectContaining({ agentKind: 'claude-code', agentProfileId: review.id, issueId: issue.id }),
    )
    expect(started).toMatchObject({ agentProfileId: review.id, assignee: 'agent:claude-code' })
  })
})
