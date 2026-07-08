import { afterEach, describe, expect, it } from 'vitest'
import { OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { callerAsIssueTrpc } from './server'

// The in-process MCP reaches the tracker through callerAsIssueTrpc: a createCaller caller
// adapted to the IssueTrpc HTTP-client shape (.<router>.<proc>.mutate/query) the shared
// command registry calls. This proves the adapter forwards both mutate and query — i.e. the
// superagent's issue tools work without the cookie-gated HTTP loopback (which would 401).
const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

function adapter() {
  const registry = new SessionRegistry()
  registries.push(registry)
  const caller = appRouter.createCaller({
    registry,
    repos: {} as never,
    superagent: {} as never,
    capability: OPERATOR,
  })
  return callerAsIssueTrpc(caller)
}

describe('callerAsIssueTrpc (in-process MCP adapter)', () => {
  it('forwards a mutation (.mutate) to the caller', async () => {
    const client = adapter()
    const created = (await client.issues.create.mutate({
      repoPath: '/r',
      title: 'via adapter',
      startNow: false,
    })) as { seq: number; title: string }
    expect(created.seq).toBe(1)
    expect(created.title).toBe('via adapter')
  })

  it('forwards a query (.query) to the caller', async () => {
    const client = adapter()
    await client.issues.create.mutate({ repoPath: '/r', title: 'q', startNow: false })
    const list = await client.issues.list.query({ repoPath: '/r' })
    expect(list).toHaveLength(1)
  })
})
