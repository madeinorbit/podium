/**
 * #198 — origin is derived from the caller (deterministic, unforgeable) and
 * audience is agent-declared, and the orphan-internal warning fires when an
 * internal issue would be invisible. Exercised through the tRPC command layer
 * (issues.create), which is where the derivation lives.
 *
 * SP-6144: agent-created top-level issues are human-facing proposals, inert until
 * an operator promotes them. needsHuman remains reserved for actual questions.
 */
import { describe, expect, it } from 'vitest'
import { type Capability, OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

const ctx = (registry: SessionRegistry, capability: Capability) =>
  appRouter.createCaller({
    registry,
    repos: {} as never,
    superagent: {} as never,
    capability,
  })

const withWarning = (v: unknown): string | undefined => (v as { warning?: string }).warning

describe('issues.create provenance (#198)', () => {
  it('operator create → origin/audience human, no warning, not flagged', async () => {
    const reg = new SessionRegistry()
    try {
      const op = ctx(reg, OPERATOR)
      const created = await op.issues.create({
        repoPath: '/r',
        title: 'human work',
        startNow: false,
      })
      expect(created.origin).toBe('human')
      expect(created.audience).toBe('human')
      expect(created.needsHuman).toBe(false)
      expect(withWarning(created)).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })

  it('agent top-level create → human-facing proposed, without needsHuman', async () => {
    const reg = new SessionRegistry()
    try {
      const op = ctx(reg, OPERATOR)
      const epic = await op.issues.create({ repoPath: '/r', title: 'epic', startNow: false })
      const worker = ctx(reg, { role: 'worker', scope: { kind: 'subtree', rootId: epic.id } })
      const created = await worker.issues.create({
        repoPath: '/r',
        title: 'agent-filed top-level work',
        startNow: false,
      })
      expect(created.origin).toBe('agent')
      expect(created.audience).toBe('human')
      expect(created.stage).toBe('proposed')
      expect(created.ready).toBe(false)
      expect(created.needsHuman).toBe(false)
      expect(created.humanQuestion).toBeUndefined()
      // No orphan-invisible warning: it is board-visible.
      expect(withWarning(created)).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })

  it('agent top-level create forces audience human even if agent passes audience agent', async () => {
    const reg = new SessionRegistry()
    try {
      const op = ctx(reg, OPERATOR)
      const epic = await op.issues.create({ repoPath: '/r', title: 'epic', startNow: false })
      const worker = ctx(reg, { role: 'worker', scope: { kind: 'subtree', rootId: epic.id } })
      const created = await worker.issues.create({
        repoPath: '/r',
        title: 'cannot hide top-level as internal',
        startNow: false,
        audience: 'agent',
      })
      expect(created.origin).toBe('agent')
      expect(created.audience).toBe('human')
      expect(created.stage).toBe('proposed')
      expect(created.needsHuman).toBe(false)
      expect(withWarning(created)).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })

  it('agent top-level audience input cannot bypass proposed curation', async () => {
    const reg = new SessionRegistry()
    try {
      const op = ctx(reg, OPERATOR)
      const epic = await op.issues.create({ repoPath: '/r', title: 'epic', startNow: false })
      const worker = ctx(reg, { role: 'worker', scope: { kind: 'subtree', rootId: epic.id } })
      const created = await worker.issues.create({
        repoPath: '/r',
        title: 'a human-facing deliverable the agent cut',
        startNow: false,
        audience: 'human',
      })
      expect(created.origin).toBe('agent')
      expect(created.audience).toBe('human')
      expect(created.stage).toBe('proposed')
      expect(created.needsHuman).toBe(false)
      expect(withWarning(created)).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })

  it('agent sub-issue create → internal, not forced-visible, not attention-flagged', async () => {
    const reg = new SessionRegistry()
    try {
      const op = ctx(reg, OPERATOR)
      const epic = await op.issues.create({ repoPath: '/r', title: 'epic', startNow: false })
      const worker = ctx(reg, { role: 'worker', scope: { kind: 'subtree', rootId: epic.id } })
      const created = await worker.issues.create({
        repoPath: '/r',
        title: 'decomposition step',
        startNow: false,
        parentId: epic.id,
      })
      expect(created.origin).toBe('agent')
      expect(created.audience).toBe('agent')
      expect(created.parentId).toBe(epic.id)
      expect(created.needsHuman).toBe(false)
      // Visible nested under human-audience parent — no orphan warning.
      expect(withWarning(created)).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })

  it('nested agent sub-issue stays internal and unflagged', async () => {
    const reg = new SessionRegistry()
    try {
      const op = ctx(reg, OPERATOR)
      const epic = await op.issues.create({ repoPath: '/r', title: 'epic', startNow: false })
      const worker = ctx(reg, { role: 'worker', scope: { kind: 'subtree', rootId: epic.id } })
      const mid = await worker.issues.create({
        repoPath: '/r',
        title: 'mid',
        startNow: false,
        parentId: epic.id,
      })
      const leaf = await worker.issues.create({
        repoPath: '/r',
        title: 'leaf',
        startNow: false,
        parentId: mid.id,
      })
      expect(leaf.origin).toBe('agent')
      expect(leaf.audience).toBe('agent')
      expect(leaf.needsHuman).toBe(false)
      expect(withWarning(leaf)).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })
  it('rejects agent promotion while allowing operator promotion', async () => {
    const reg = new SessionRegistry()
    try {
      const op = ctx(reg, OPERATOR)
      const root = await op.issues.create({ repoPath: '/r', title: 'root', startNow: false })
      const worker = ctx(reg, { role: 'worker', scope: { kind: 'subtree', rootId: root.id } })
      const proposal = await worker.issues.create({
        repoPath: '/r',
        title: 'proposal',
        startNow: false,
      })
      const proposalWorker = ctx(reg, {
        role: 'worker',
        scope: { kind: 'subtree', rootId: proposal.id },
      })
      await expect(proposalWorker.issues.promote({ id: proposal.id })).rejects.toThrow(/operator/i)
      await expect(
        proposalWorker.issues.update({ id: proposal.id, patch: { stage: 'backlog' } }),
      ).rejects.toThrow(/operator/i)
      const promoted = await op.issues.promote({ id: proposal.id })
      expect(promoted.stage).toBe('backlog')
      expect(promoted.ready).toBe(true)
    } finally {
      reg.dispose()
    }
  })
})

/** SP-6144 guardrail 2 must hold on EVERY lifecycle path, not just `stage` —
 *  the reviewed bypasses (B1-B4): update side-fields, reparent, create-parentId,
 *  attach, and the proposal-subtree inertness rule. */
describe('proposed lane bypass paths are closed (B1-B4)', () => {
  const setup = async () => {
    const reg = new SessionRegistry()
    const op = ctx(reg, OPERATOR)
    const root = await op.issues.create({ repoPath: '/r', title: 'root', startNow: false })
    const worker = ctx(reg, { role: 'worker', scope: { kind: 'subtree', rootId: root.id } })
    const proposal = await worker.issues.create({
      repoPath: '/r',
      title: 'proposal',
      startNow: false,
    })
    expect(proposal.stage).toBe('proposed')
    const proposalWorker = ctx(reg, {
      role: 'worker',
      scope: { kind: 'subtree', rootId: proposal.id },
    })
    return { reg, op, root, worker, proposal, proposalWorker }
  }

  it('B1: update side-fields cannot dismiss/close/reparent a proposal', async () => {
    const { reg, proposal, proposalWorker, root, op } = await setup()
    try {
      await expect(
        proposalWorker.issues.update({ id: proposal.id, patch: { archived: true } }),
      ).rejects.toThrow(/operator/i)
      await expect(
        proposalWorker.issues.update({ id: proposal.id, patch: { closedReason: 'done' } }),
      ).rejects.toThrow(/operator/i)
      await expect(
        proposalWorker.issues.update({ id: proposal.id, patch: { parentId: root.id } }),
      ).rejects.toThrow(/operator/i)
      // Non-lifecycle fields stay editable by the agent.
      const renamed = await proposalWorker.issues.update({
        id: proposal.id,
        patch: { title: 'clarified proposal' },
      })
      expect(renamed.title).toBe('clarified proposal')
      expect(renamed.stage).toBe('proposed')
      // The operator can do all of it.
      const dismissed = await op.issues.update({ id: proposal.id, patch: { archived: true } })
      expect(dismissed.archived).toBe(true)
    } finally {
      reg.dispose()
    }
  })

  it('B2: reparent cannot move a proposal, nor nest work under one', async () => {
    const { reg, proposal, proposalWorker, worker, root } = await setup()
    try {
      await expect(
        proposalWorker.issues.reparent({ id: proposal.id, parentId: root.id }),
      ).rejects.toThrow(/operator/i)
      const sub = await worker.issues.create({
        repoPath: '/r',
        title: 'sub of root',
        startNow: false,
        parentId: root.id,
      })
      await expect(
        worker.issues.reparent({ id: sub.id, parentId: proposal.id }),
      ).rejects.toThrow(/operator/i)
    } finally {
      reg.dispose()
    }
  })

  it('B3: create validates parentId BEFORE persist — bogus/closed/archived parents reject with nothing created', async () => {
    const { reg, op, worker, root } = await setup()
    try {
      const before = (await op.issues.list({ repoPath: '/r' })).length
      await expect(
        worker.issues.create({
          repoPath: '/r',
          title: 'orphan dodge',
          startNow: false,
          parentId: 'iss_does-not-exist',
        }),
      ).rejects.toThrow(/unknown parent/i)
      const closed = await op.issues.create({ repoPath: '/r', title: 'closed', startNow: false })
      await op.issues.close({ id: closed.id })
      await expect(
        worker.issues.create({
          repoPath: '/r',
          title: 'under closed',
          startNow: false,
          parentId: closed.id,
        }),
      ).rejects.toThrow(/closed/i)
      const archived = await op.issues.create({
        repoPath: '/r',
        title: 'archived',
        startNow: false,
      })
      await op.issues.archive({ id: archived.id })
      await expect(
        worker.issues.create({
          repoPath: '/r',
          title: 'under archived',
          startNow: false,
          parentId: archived.id,
        }),
      ).rejects.toThrow(/archived/i)
      const after = (await op.issues.list({ repoPath: '/r' })).length
      // Only the two operator-created probes landed — none of the rejected creates.
      expect(after).toBe(before + 2)
    } finally {
      reg.dispose()
    }
  })

  it('M5: the proposal subtree is inert — sub-creates are neutered, start and attach reject', async () => {
    const { reg, proposal, proposalWorker } = await setup()
    try {
      const sub = await proposalWorker.issues.create({
        repoPath: '/r',
        title: 'decomposition under proposal',
        startNow: true,
        audience: 'human',
        parentId: proposal.id,
      })
      // Inert: never auto-started, never board-facing.
      expect(sub.audience).toBe('agent')
      expect(sub.sessions ?? []).toHaveLength(0)
      await expect(proposalWorker.issues.start({ id: sub.id })).rejects.toThrow(/operator/i)
      await expect(proposalWorker.issues.start({ id: proposal.id })).rejects.toThrow(/operator/i)
      await expect(
        proposalWorker.issues.attachSession({ sessionId: 'sess-x', targetId: proposal.id }),
      ).rejects.toThrow(/operator/i)
    } finally {
      reg.dispose()
    }
  })
})
