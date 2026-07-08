/**
 * #198 — origin is derived from the caller (deterministic, unforgeable) and
 * audience is agent-declared, and the orphan-internal warning fires when an
 * internal issue would be invisible. Exercised through the tRPC command layer
 * (issues.create), which is where the derivation lives.
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
  it('operator create → origin/audience human, no warning', async () => {
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
      expect(withWarning(created)).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })

  it('constrained agent create → origin agent, audience agent by default, with orphan warning', async () => {
    const reg = new SessionRegistry()
    try {
      const op = ctx(reg, OPERATOR)
      const epic = await op.issues.create({ repoPath: '/r', title: 'epic', startNow: false })
      const worker = ctx(reg, { role: 'worker', scope: { kind: 'subtree', rootId: epic.id } })
      const created = await worker.issues.create({
        repoPath: '/r',
        title: 'internal, no parent',
        startNow: false,
      })
      expect(created.origin).toBe('agent')
      expect(created.audience).toBe('agent')
      // No human-audience ancestor → invisible → warned.
      expect(withWarning(created)).toMatch(/invisible/i)
    } finally {
      reg.dispose()
    }
  })

  it('agent can opt onto the board with audience human — origin still agent, no warning', async () => {
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
      expect(withWarning(created)).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })

  it('internal child under a human-audience parent is visible — no warning', async () => {
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
      expect(created.audience).toBe('agent')
      expect(created.parentId).toBe(epic.id)
      expect(withWarning(created)).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })
})
