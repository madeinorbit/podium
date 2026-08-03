import { asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from './api'
import { createDraftAgent } from './spawn-agent'

function api() {
  const create = vi.fn(async (_input: unknown) => ({}))
  const resumeAndSend = vi.fn(async () => ({}))
  return {
    trpc: {
      sessions: { create: { mutate: create }, resumeAndSend: { mutate: resumeAndSend } },
    } as unknown as PodiumClientApi,
    create,
  }
}

const base = {
  sessionId: asSessionId('session-1'),
  issueId: asIssueId('issue-1'),
  agentKind: 'codex' as const,
}

describe('spawn machine-USE placement', () => {
  it.each([
    'unauthorized',
    'unreachable',
  ] as const)('fails closed with the distinct %s reason before targeting the server', async (placement) => {
    const { trpc, create } = api()
    const result = createDraftAgent({
      ...base,
      trpc,
      target: { path: '/worktree', repoPath: '/repo', machineId: 'machine-1', placement },
    })

    await expect(result).rejects.toMatchObject({ reason: placement })
    expect(create).not.toHaveBeenCalled()
  })

  it('sends only target and command fields, never client-authored attribution', async () => {
    const { trpc, create } = api()
    await createDraftAgent({
      ...base,
      trpc,
      target: {
        path: '/worktree',
        repoPath: '/repo',
        machineId: 'machine-1',
        placement: 'allowed',
      },
    })

    expect(create).toHaveBeenCalledWith({
      sessionId: 'session-1',
      agentKind: 'codex',
      cwd: '/worktree',
      draftIssue: { repoPath: '/repo', issueId: 'issue-1' },
      machineId: 'machine-1',
    })
    // Per-field: `not.toEqual(expect.arrayContaining([...]))` only fails when
    // ALL of the listed fields are present at once, so a single leaked field
    // passed silently (POD-1533).
    const createdKeys = Object.keys(create.mock.calls[0]?.[0] ?? {})
    for (const field of ['actor', 'owner', 'ownerId', 'origin']) {
      expect(createdKeys, `spawn payload asserts attribution field '${field}'`).not.toContain(field)
    }
  })
})
