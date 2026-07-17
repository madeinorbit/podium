/**
 * #198 — origin is derived from the caller (deterministic, unforgeable) and
 * audience is agent-declared, and the orphan-internal warning fires when an
 * internal issue would be invisible. Exercised through the tRPC command layer
 * (issues.create), which is where the derivation lives.
 *
 * M6 / decision q6 (docs/agent-comms-target.html §11): agent-created top-level
 * issues force audience:'human' + needsHuman (board-visible, flagged for
 * attention). No approval gate — create always succeeds immediately.
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

  it('agent top-level create → board-visible (audience human) + needsHuman attention flag', async () => {
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
      // Create succeeds immediately — no approval gate (M6 q6).
      expect(created.origin).toBe('agent')
      // Forced onto the human board so it is not internal/agent-only.
      expect(created.audience).toBe('human')
      // Flagged for attention so the human notices.
      expect(created.needsHuman).toBe(true)
      expect(created.humanQuestion).toMatch(/top-level/i)
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
      expect(created.needsHuman).toBe(true)
      expect(withWarning(created)).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })

  it('agent can still pass audience human on top-level — origin agent, attention-flagged', async () => {
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
      expect(created.needsHuman).toBe(true)
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
})
