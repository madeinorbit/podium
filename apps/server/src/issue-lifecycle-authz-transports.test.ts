import type { ControlMessage, DaemonMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { runIssueCli } from '../../cli/src/issue-cli'
import { createAgentRelayHub, startAgentRelayServer } from '../../daemon/src/agent-relay'
import { OPERATOR } from './issue-authz'
import type { IssueProc, IssueTrpc } from './issue-client'
import { makeRelayIssueClient } from './issue-client'
import { IssueToolProvider } from './issue-mcp'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

type LifecycleName = 'archive' | 'depRemove' | 'reparent' | 'supersede' | 'duplicate'

interface LifecycleFixture {
  root: { id: string }
  moving: { id: string }
  newParent: { id: string }
  superseded: { id: string }
  replacement: { id: string }
  duplicate: { id: string }
  canonical: { id: string }
  depFrom: { id: string }
  depTo: { id: string }
  archived: { id: string }
}

function fixture(registry: SessionRegistry): LifecycleFixture {
  const create = (title: string, parentId?: string) =>
    registry.issues.create({
      repoPath: '/repo',
      title,
      startNow: false,
      ...(parentId ? { parentId } : {}),
    })
  const root = create('root')
  const oldParent = create('old parent', root.id)
  const newParent = create('new parent', root.id)
  const moving = create('moving', oldParent.id)
  const superseded = create('superseded', root.id)
  const replacement = create('replacement', root.id)
  const duplicate = create('duplicate', root.id)
  const canonical = create('canonical', root.id)
  const depFrom = create('dep from', root.id)
  const depTo = create('dep to', root.id)
  const archived = create('archived', root.id)
  registry.issues.addDep(depFrom.id, depTo.id, 'blocks')
  return {
    root,
    moving,
    newParent,
    superseded,
    replacement,
    duplicate,
    canonical,
    depFrom,
    depTo,
    archived,
  }
}

function lifecycleInputs(f: LifecycleFixture): Array<[LifecycleName, Record<string, unknown>]> {
  return [
    ['reparent', { id: f.moving.id, parentId: f.newParent.id }],
    ['supersede', { oldId: f.superseded.id, newId: f.replacement.id }],
    ['duplicate', { id: f.duplicate.id, canonicalId: f.canonical.id }],
    ['depRemove', { fromId: f.depFrom.id, toId: f.depTo.id, type: 'blocks' }],
    ['archive', { id: f.archived.id }],
  ]
}

function verify(registry: SessionRegistry, f: LifecycleFixture): void {
  expect(registry.issues.get(f.moving.id)?.parentId).toBe(f.newParent.id)
  expect(registry.issues.get(f.superseded.id)).toMatchObject({
    closedReason: 'superseded',
    supersededBy: f.replacement.id,
  })
  expect(registry.issues.get(f.duplicate.id)).toMatchObject({
    closedReason: 'duplicate',
    duplicateOf: f.canonical.id,
  })
  expect(registry.issues.get(f.depFrom.id)?.deps).not.toContainEqual({
    id: f.depTo.id,
    type: 'blocks',
  })
  expect(registry.issues.get(f.archived.id)?.archived).toBe(true)
}

async function runIssueClient(client: IssueTrpc, f: LifecycleFixture): Promise<void> {
  for (const [name, input] of lifecycleInputs(f)) {
    await (client.issues[name] as IssueProc).mutate(input)
  }
}

describe('lifecycle primitives across all four command transports (#413)', () => {
  it('tRPC operator executes all five registry-derived commands', async () => {
    const registry = new SessionRegistry()
    try {
      const f = fixture(registry)
      const caller = appRouter.createCaller({
        registry,
        repos: {} as never,
        superagent: {} as never,
        capability: OPERATOR,
      })
      await caller.issues.reparent({ id: f.moving.id, parentId: f.newParent.id })
      await caller.issues.supersede({ oldId: f.superseded.id, newId: f.replacement.id })
      await caller.issues.duplicate({ id: f.duplicate.id, canonicalId: f.canonical.id })
      await caller.issues.depRemove({ fromId: f.depFrom.id, toId: f.depTo.id, type: 'blocks' })
      await caller.issues.archive({ id: f.archived.id })
      verify(registry, f)
    } finally {
      registry.dispose()
    }
  })

  it('scoped in-process dispatcher executes all five inside the agent subtree', async () => {
    const registry = new SessionRegistry()
    try {
      const f = fixture(registry)
      const client = registry.issueCommands.asIssueTrpc({
        role: 'worker',
        scope: { kind: 'subtree', rootId: f.root.id },
      })
      await runIssueClient(client, f)
      verify(registry, f)
    } finally {
      registry.dispose()
    }
  })

  it('scoped MCP tools execute all five inside the agent subtree', async () => {
    const registry = new SessionRegistry()
    try {
      const f = fixture(registry)
      const provider = new IssueToolProvider()
      provider.setClient(
        registry.issueCommands.asIssueTrpc({
          role: 'worker',
          scope: { kind: 'subtree', rootId: f.root.id },
        }),
      )
      for (const [name, input] of lifecycleInputs(f)) {
        const tool = `issue_${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`
        await provider.callMcpTool(tool, input)
      }
      verify(registry, f)
    } finally {
      registry.dispose()
    }
  })

  it('scoped CLI relay executes all five inside the agent subtree', async () => {
    const registry = new SessionRegistry()
    let relayServer: Awaited<ReturnType<typeof startAgentRelayServer>> | undefined
    try {
      const f = fixture(registry)
      registry.issues.update(f.root.id, { worktreePath: '/wt/lifecycle-root' })
      const sessionId = registry.modules.sessions.createSession({
        cwd: '/wt/lifecycle-root',
        agentKind: 'shell',
      }).sessionId
      const machineId = 'lifecycle-machine'
      const hub = createAgentRelayHub((msg: DaemonMessage) =>
        registry.modules.sessions.onDaemonMessageFrom(machineId, msg),
      )
      registry.modules.sessions.attachDaemon(machineId, (msg: ControlMessage) => {
        if (msg.type === 'agentRelayResult') hub.onResult(msg)
      })
      relayServer = await startAgentRelayServer({ port: 0, relay: (req) => hub.relay(req) })
      const client = makeRelayIssueClient(relayServer.endpointFor(sessionId))

      await runIssueCli(['reparent', f.moving.id, f.newParent.id], client)
      await runIssueCli(['supersede', f.superseded.id, f.replacement.id], client)
      await runIssueCli(['duplicate', f.duplicate.id, f.canonical.id], client)
      await runIssueCli(['dep-remove', f.depFrom.id, f.depTo.id, '--type', 'blocks'], client)
      await runIssueCli(['archive', f.archived.id], client)
      verify(registry, f)
    } finally {
      await relayServer?.close()
      registry.dispose()
    }
  })
})
