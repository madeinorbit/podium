/**
 * The three proposal actions on the flight deck (POD-6119, flight deck v6
 * provisional defaults), driven through the tRPC command layer where their
 * authorization lives:
 *
 * - Backlog = `promote`: proposed -> backlog, placement untouched, retry-safe.
 * - Dismiss = `close --reason declined`: closed as cancelled, the word kept in
 *   one comment, nothing started.
 * - Start = `start` (operator): covered with a mocked spawn in
 *   issues.agent-profiles.test.ts; here only its refusal for agents.
 *
 * All three stay operator decisions: an agent is refused on each.
 */
import type { IssueReport } from '@podium/model'
import { asSessionId, firstAdminMemberId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'
import type { Capability } from './issue-authz'
import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'

const ctx = (registry: SessionRegistry, rawCapability: Capability) => {
  const capability: Capability =
    rawCapability.scope.kind === 'subtree'
      ? {
          ...rawCapability,
          actorSessionId: rawCapability.actorSessionId ?? asSessionId('proposal-agent'),
          onBehalfOf: rawCapability.onBehalfOf ?? firstAdminMemberId(),
        }
      : {
          ...rawCapability,
          actorUser: rawCapability.actorUser ?? firstAdminMemberId(),
          onBehalfOf: rawCapability.onBehalfOf ?? firstAdminMemberId(),
        }
  return appRouter.createCaller({
    registry,
    repos: {} as never,
    superagent: {} as never,
    capability,
    principal: resolvePrincipal(capability, { parentSessionOf: () => undefined }),
  })
}

const asWire = (v: unknown): IssueReport => v as IssueReport

/** A mission with one task, and an agent working that task that files a proposal. */
async function setup() {
  const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  await reg.sessionStore.repos.addRepo('/r', reg.sessionStore.hostMachineId)
  const op = ctx(reg, OPERATOR)
  const root = await op.issues.create({ repoPath: '/r', title: 'mission', startNow: false })
  const task = await op.issues.create({
    repoPath: '/r',
    title: 'task',
    startNow: false,
    parentId: root.id,
  })
  const agent = ctx(reg, { role: 'worker', scope: { kind: 'subtree', rootId: task.id } })
  const proposal = await agent.issues.create({
    repoPath: '/r',
    title: 'found while working',
    startNow: false,
  })
  expect(proposal.stage).toBe('proposed')
  return { reg, op, agent, root, task, proposal }
}

describe('proposal Backlog keeps promote and the placement', () => {
  it('mission placement: promote moves only the stage; the parent link stays', async () => {
    const { reg, op, task, proposal } = await setup()
    try {
      await op.issues.setPlacement({ id: proposal.id, originId: task.id, placement: 'mission' })
      const promoted = asWire(await op.issues.promote({ id: proposal.id }))
      expect(promoted).toMatchObject({ stage: 'backlog', parentId: task.id })
    } finally {
      await reg.dispose()
    }
  })

  it('own placement: promote keeps it top level and discovered from the task', async () => {
    const { reg, op, task, proposal } = await setup()
    try {
      await op.issues.setPlacement({ id: proposal.id, originId: task.id, placement: 'own' })
      const promoted = asWire(await op.issues.promote({ id: proposal.id }))
      expect(promoted.stage).toBe('backlog')
      expect(promoted.parentId ?? null).toBeNull()
      expect(promoted.deps).toContainEqual({ id: task.id, type: 'discovered-from' })
    } finally {
      await reg.dispose()
    }
  })

  it('a retried promote with the same mutationId returns its receipt, not "not proposed"', async () => {
    const { reg, op, proposal } = await setup()
    try {
      const first = asWire(await op.issues.promote({ id: proposal.id, mutationId: 'm-promote-1' }))
      const again = asWire(await op.issues.promote({ id: proposal.id, mutationId: 'm-promote-1' }))
      expect(again).toEqual(first)
      // A fresh promote of a promoted issue is still the honest refusal.
      await expect(op.issues.promote({ id: proposal.id })).rejects.toThrow(/not proposed/)
    } finally {
      await reg.dispose()
    }
  })
})

describe('proposal Dismiss closes as cancelled ("declined")', () => {
  it('stores cancelled, keeps the word in one comment, and starts nothing', async () => {
    const { reg, op, proposal } = await setup()
    try {
      const closed = asWire(await op.issues.close({ id: proposal.id, reason: 'declined' }))
      expect(closed).toMatchObject({ stage: 'done', closedReason: 'cancelled' })
      expect(closed.worktreePath).toBeNull()
      // Dismissing twice adds nothing: the second close changed nothing.
      await op.issues.close({ id: proposal.id, reason: 'declined' })
      const comments = (await op.issues.comments({ id: proposal.id })) as Array<{ body: string }>
      expect(comments.map((c) => c.body)).toEqual(['Declined.'])
    } finally {
      await reg.dispose()
    }
  })

  it('other close reasons are unchanged', async () => {
    const { reg, op, proposal } = await setup()
    try {
      const closed = asWire(await op.issues.close({ id: proposal.id, reason: 'wontfix' }))
      expect(closed.closedReason).toBe('cancelled')
      expect(await op.issues.comments({ id: proposal.id })).toEqual([])
    } finally {
      await reg.dispose()
    }
  })
})

describe('proposal actions stay operator decisions', () => {
  it('an agent may not promote, dismiss or start a proposal', async () => {
    const { reg, proposal } = await setup()
    // Scoped to the proposal itself, so the scope guard cannot be what refuses.
    const agent = ctx(reg, { role: 'worker', scope: { kind: 'subtree', rootId: proposal.id } })
    try {
      await expect(agent.issues.promote({ id: proposal.id })).rejects.toThrow(/operator/i)
      await expect(agent.issues.close({ id: proposal.id, reason: 'declined' })).rejects.toThrow(
        /operator/i,
      )
      await expect(agent.issues.start({ id: proposal.id })).rejects.toThrow(/operator/i)
      const still = asWire(await ctx(reg, OPERATOR).issues.get({ id: proposal.id }))
      expect(still).toMatchObject({ stage: 'proposed', worktreePath: null })
      expect(still.closedReason ?? null).toBeNull()
    } finally {
      await reg.dispose()
    }
  })
})
