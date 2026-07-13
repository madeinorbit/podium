import { afterEach, describe, expect, it } from 'vitest'
import { OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'

// The in-process MCP reaches the tracker through the command registry's derived
// IssueTrpc client (IssueCommandDispatcher.asIssueTrpc — the typed replacement for
// the old callerAsIssueTrpc Proxy over appRouter.createCaller). This proves the
// derived client forwards both mutate and query — i.e. the superagent's issue
// tools work without the cookie-gated HTTP loopback (which would 401).
const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

function client() {
  const registry = new SessionRegistry()
  registries.push(registry)
  return registry.issueCommands.asIssueTrpc(OPERATOR)
}

describe('IssueCommandDispatcher.asIssueTrpc (in-process MCP client)', () => {
  it('forwards a mutation (.mutate) through the registry pipeline', async () => {
    const c = client()
    const created = (await c.issues.create.mutate({
      repoPath: '/r',
      title: 'via adapter',
      startNow: false,
    })) as { seq: number; title: string }
    expect(created.seq).toBe(1)
    expect(created.title).toBe('via adapter')
  })

  it('forwards a query (.query) through the registry pipeline', async () => {
    const c = client()
    await c.issues.create.mutate({ repoPath: '/r', title: 'q', startNow: false })
    const list = await c.issues.list.query({ repoPath: '/r' })
    expect(list).toHaveLength(1)
  })

  it('panelApply artifact-add pulls a snapshot — errors cleanly with no worktree/session ([spec:SP-0fc9])', async () => {
    const c = client()
    const created = (await c.issues.create.mutate({
      repoPath: '/r',
      title: 'a',
      startNow: false,
    })) as { id: string }
    await expect(
      Promise.resolve(
        c.issues.panelApply.mutate({ id: created.id, op: 'artifact-add', path: 'shot.png' }),
      ),
    ).rejects.toThrow(/no worktree or session/)
    // nothing half-registered
    const got = (await c.issues.get.query({ id: created.id })) as {
      panel?: { artifacts: unknown[] }
    }
    expect(got.panel?.artifacts ?? []).toEqual([])
  })

  it('an unknown router/proc throws the historical "no such issue procedure"', async () => {
    const c = client()
    expect(() => c.specs.list.query({})).toThrow(/no such issue procedure: specs\.list/)
  })
})
